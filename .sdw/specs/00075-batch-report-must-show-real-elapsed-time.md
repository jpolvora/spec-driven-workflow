---
id: null
localSpecId: "00075"
slug: 00075-batch-report-must-show-real-elapsed-time
title: "Batch reporting must show real elapsed time and merge outcomes"
source: local
status: draft
specDate: 2026-10-25
priority: low
value: "Makes the queue's own report answer how long it took, where it waited, and whether each delivery landed"
effort: S
---

# Specification — Batch reporting must show real elapsed time and merge outcomes

## Description

Per-item elapsed time, implementation start, delivery commit, and merge outcome must be recorded when they happen and printed from the record.

In batch `batch-1792826020541` the manifest reports 1.6 to 3.8 seconds per item (`durationMs`), while the items actually took 41 to 181 minutes: the first run started at `07:13:43Z` and finished at `10:14:33Z`. The value accumulates only the delegated CLI call ([`batch_queue.cjs:1834`](../../skills/sdw-batch/scripts/batch_queue.cjs)), so a pause, a host-driven dispatch, or a resume adds almost nothing. Step 4 also carries `startedAt: null` in all five run states, so the largest wait is invisible even on the run. Finally, `sdw_batch status` prints only status and run id ([`batch_queue.cjs:1955`](../../skills/sdw-batch/scripts/batch_queue.cjs)), omitting the duration, delivery commit, and merge outcome that protocol section 7 promises.

### Design Intent

A queue report is an audit artifact. It must answer how long the batch took, where it waited, and whether the delivery landed, from timestamps recorded when the events happened, not from the clock of whichever command printed last.

## Acceptance Criteria

- AC1: When an item is first delegated, the system shall record the item's `startedAt` timestamp.
- AC2: When an item reaches a terminal state, the system shall record the item's `completedAt` timestamp and its elapsed milliseconds.
- AC3: When the implementation step starts, the system shall record its `startedAt` so its duration is measurable.
- AC4: When the batch summary prints, the system shall show each item's elapsed time, delivery commit, and merge outcome.
- AC5: When the `status` subcommand prints, the system shall show the same elapsed time, delivery commit, and merge outcome for every item.
- AC6: If an item is skipped without a delegation, then the system shall print `-` for its elapsed time.
- AC7: The system shall derive elapsed time from recorded manifest timestamps instead of the process clock at print time.
- AC8: The system shall cover resumed-item elapsed recording, status rendering, and the no-delegation case with tests.

## Notes

- Evidence: `batch-1792826020541` `updatedAt` minus `createdAt` is 7h 26m; per-item `durationMs` is 1641 to 3787 ms; run states span 41 to 181 minutes; every run records `steps.4.startedAt: null`.
- Implementation surfaces: [`batch_queue.cjs`](../../skills/sdw-batch/scripts/batch_queue.cjs) (`executeQueue` timing at line 1834, `printSummary` at line 1573, `formatStatus` at line 1955), [`batch_protocol.md`](../../skills/sdw-batch/references/batch_protocol.md) sections 2 and 7, and [`tests/sdw_batch.test.cjs`](../../tests/sdw_batch.test.cjs).
- Replace `durationMs` with `startedAt`, `completedAt`, and `elapsedMs`. The manifest is gitignored run state, and this repository replaces rather than shims, so no migration layer is added.
- Step 4 must set `startedAt` when the step is first entered, including the dispatch pause path, not only `completedAt` on acceptance.
- Elapsed is printed from the manifest timestamps, so a status call days later still reports the real elapsed time.
- The summary table already has a merge column; the status renderer must reuse the same outcome label.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Per-task wall-clock telemetry | Task durations already appear in the delivery report |
| Changing the run-state schema | Step timing stays on run state |
| Backfilling old manifests | Only batches created after this change are guaranteed accurate |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Clock source | Manifest ISO timestamps | Resume-safe and independent of the printing process | y |
| Duration field | Replace `durationMs` with `elapsedMs` | Breaking changes are allowed; the manifest is run state | y |
| Skipped item duration | `-` | No delegation means no elapsed time to report | y |
| Merge reason in status | Printed in full, not truncated | The operator needs the refusal reason | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Timing writes | Every place that writes `durationMs` located | Read `executeQueue` in `batch_queue.cjs` |
| Renderers | `printSummary` and `formatStatus` field lists compared | Read both functions |
| Run-state step timing | Step 4 write path and its pause/resume variants understood | Read the Step 4 updates in `sdw_orch.cjs` |
| Manifest contract | New fields agreed and documented | Read `batch_protocol.md` section 2 |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `startedAt`, `completedAt`, and `elapsedMs` on every item.
- `steps[4].startedAt` on every run that entered implementation.
- One status row per item with duration, delivery commit, and merge outcome.

### Negative & Failing Test Scenarios

- Skipped item: the duration prints `-` and no fabricated elapsed value appears.
- Resumed item: the elapsed time spans every invocation, not only the last one.
- Status printed after the fact: the value comes from the manifest timestamp, not `Date.now()`.
- A missing merge record: the status prints `-` instead of an empty cell.
