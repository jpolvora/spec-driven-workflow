---
id: null
localSpecId: "00072"
slug: 00072-batch-merge-must-gate-and-report
title: "Batch merge must gate on required checks and report unmerged deliveries"
source: local
status: draft
specDate: 2026-10-25
priority: high
value: "Stops the queue from recording a refused merge as final and then exiting zero while the delivery is not on the base"
effort: M
---

# Specification — Batch merge must gate on required checks and report unmerged deliveries

## Description

A batch must never record a merge it did not perform, and a batch with a failed merge must not exit successfully.

In batch `batch-1792826020541` two of five deliveries were refused by the provider with `the base branch policy prohibits the merge`: item 2 at `11:15:58Z`, 49 seconds after the last push, and item 5 at `14:39:35Z`, 9 seconds after the last push. The same batch merged `#70` at 88 seconds and `#72` at 96 seconds after their last push, and its one retry (`#73`, 100 seconds after the last push) passed. The refusals were recorded as `merge.status: failed`, the queue advanced, and the manifest still ended `status: completed` with exit code 0. Both pull requests reached `develop` only later, by hand, at `11:46:08Z` and `14:50:28Z`.

Two write paths disagree about when a merge may be requested. `applyMerge` calls the provider merge with no check observation at all ([`batch_queue.cjs:842`](../../skills/sdw-batch/scripts/batch_queue.cjs)). The gated path treats an empty required-check rollup as unreportable and therefore mergeable: `providerChecksStatus` returns `null` for zero entries ([`batch_queue.cjs:1078`](../../skills/sdw-batch/scripts/batch_queue.cjs)) and `gatedMerge` skips the gate on `null` ([`batch_queue.cjs:1195`](../../skills/sdw-batch/scripts/batch_queue.cjs)). A pull request created seconds earlier has no rollup yet, so the gate passes and the provider refuses. The manifest then hides the failure because `anyFailed` counts run outcomes only ([`batch_queue.cjs:1884`](../../skills/sdw-batch/scripts/batch_queue.cjs)).

### Design Intent

A merge record must describe what the provider did with the delivery, and the queue's exit status must describe whether the queue's work reached the base. A settle window that treats an unreported rollup as pending, a terminal re-observation after any refusal, and a status that counts a failed merge remove the false success without changing the merge policy itself.

## Acceptance Criteria

- AC1: When the merge stage starts for an item with delivery evidence, the system shall observe the required check state before issuing any merge call.
- AC2: If the required checks are pending or not yet reported, then the system shall poll them to a terminal state within a bounded window before the merge call.
- AC3: The system shall treat an empty or unreadable required-check report as pending, never as passing.
- AC4: If the provider refuses a merge, then the system shall re-observe the delivery state before recording the outcome.
- AC5: If the delivery pull request is merged after a refusal, then the system shall record `merge.status: merged`.
- AC6: When a refused merge leaves the delivery unmerged after the bounded window, the system shall record `merge.status: failed` with the refusal reason and the observed check state.
- AC7: When any item records `merge.status: failed`, the system shall set the manifest status to `completed_with_errors`.
- AC8: When the manifest status is `completed_with_errors`, the system shall exit non-zero.
- AC9: When the batch summary prints, the system shall name each failed or waiting item with its pull request number and reason.
- AC10: The system shall cover the not-yet-reported rollup, the pending wait, the refusal-then-merged reconciliation, the refusal-then-failed path, and the `completed_with_errors` exit code with tests.

## Notes

- Evidence: `batch-1792826020541` items 2 and 5, merge attempts at `11:15:58Z` and `14:39:35Z`; first-try merges at +88s and +96s; retry at +100s.
- Implementation surfaces: [`batch_queue.cjs`](../../skills/sdw-batch/scripts/batch_queue.cjs) (`applyMerge`, `gatedMerge`, `providerChecksStatus`, `checksStatus`, `printSummary`, `executeQueue`), [`batch_protocol.md`](../../skills/sdw-batch/references/batch_protocol.md) sections 4 and 7, and [`tests/sdw_batch.test.cjs`](../../tests/sdw_batch.test.cjs).
- The observed settle window is at least 120 seconds: every merge attempted below 60 seconds was refused, every merge attempted above 88 seconds passed. The window stays bounded and injectable (`_checksStatus`, `_mergePr`, `_sleep`) so tests never sleep.
- `gh pr merge --auto` may replace the wait, but a queued merge is `waiting`, not `merged`, until the provider reports the pull request merged. A queued merge that never lands records `waiting` with the observed check state.
- The follow-up merge gate from spec 00070 and the resume rule from spec 00053 stay unchanged.
- `completed_with_errors` already exists in the protocol vocabulary but no merge failure sets it today.
- The refusal reason must reach the operator verbatim; it names the provider rule that blocked the merge.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Fixing the delivery so its checks pass | The queue reports; remediation belongs to the run and the fixer |
| Changing the ruleset or its required checks | Repository policy stays authoritative |
| Re-merging an item whose manifest already records a merged attempt | The resume rule from spec 00053 stays |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Empty rollup meaning | Pending, never passing | Both refusals happened before the required checks registered | y |
| Settle window | 120 seconds, injectable for tests | Successful merges at +88s and +96s; all refusals below +60s | y |
| Merge failure severity | `completed_with_errors` plus non-zero exit | A batch that did not land a delivery is not a success | y |
| Auto-merge availability | Optional provider capability, polling is the fallback | Older `gh` and ADO may not queue a merge | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Merge paths | `applyMerge`, `gatedMerge`, and `providerChecksStatus` understood | Read the three functions and their callers |
| Status contract | Manifest statuses and exit-code mapping confirmed | Read `batch_protocol.md` sections 2 and 7 |
| Provider capability | `gh pr merge --auto` availability checked on the pinned CLI | Run `gh pr merge --help` |
| Test seams | Injected `_mergePr`, `_checksStatus`, and `_sleep` seams identified | Read `tests/sdw_batch.test.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `merge.checks.state`, `merge.attempts`, and `merge.reason` on every item merge record.
- Manifest status and process exit code for the batch.
- One summary line per failed or waiting merge naming the pull request and the reason.

### Negative & Failing Test Scenarios

- Checks never reported within the window: the merge call never runs and the record ends `failed` with the observed pending state.
- Provider refuses while the checks pass: the record ends `failed`, never `merged`.
- Provider refuses but the pull request is merged: the record ends `merged` with `observed: merged`.
- A failed merge keeps exit code 0: the test asserts `completed_with_errors` and a non-zero exit.
