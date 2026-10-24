---
id: null
localSpecId: "00071"
slug: 00071-superseded-runs-must-be-terminal
title: "A superseded run must be recorded as terminal"
source: local
status: implemented
specDate: 2026-10-24
priority: medium
value: "Stops a superseded run from being reported as a leftover open run by the retrospective and from tripping queue stale-run checks"
effort: S
---

# Specification — A superseded run must be recorded as terminal

## Description

A superseded run must be recorded as terminal so retrospectives and the queue never report it as a leftover open run.

When a run is replaced with `--new-run`, the batch records `supersededRunId` on the item, but the old run state keeps its previous status. The first 00064 attempt (`run-1792766617148`) is still `paused` at step 3 after being superseded, and the retrospective for the replacement run reports `leftover_run: 1` for a run that will never continue. Retro left-over detection treats every non-`completed`/`failed` sibling as a leftover, so a superseded run looks like an abandoned thread forever.

### Design Intent

Run identity needs a terminal state for replacement, distinct from success and failure. `superseded` says "this run was deliberately replaced", which keeps the retrospective honest, keeps the queue's stale-run rule precise, and leaves the old state readable for audit without pretending it can resume.

## Acceptance Criteria

- AC1: When a run is superseded, the system shall record `status: superseded` on that run state together with `supersededBy` (the replacing run id) and `supersededAt`.
- AC2: The system shall treat `superseded` as a terminal status everywhere a run status is classified (retro leftover detection, monitor classification, resume refusal, and the batch stale-run check).
- AC3: If a superseded run is loaded by `resume`, then the system shall refuse with a message naming the replacing run instead of starting work.
- AC4: The retrospective shall never report a superseded run as `leftover_run`, and shall name it as superseded when it summarizes sibling runs.
- AC5: The system shall cover supersession recording, retro exclusion, monitor classification, and resume refusal with tests.

## Notes

- Implementation surfaces: `skills/sdw-batch/scripts/batch_queue.cjs` (where `supersededRunId` is recorded), `skills/sdw-orch/scripts/state_manager.cjs` and `skills/sdw-orch/scripts/sdw_orch.cjs` (status validation and resume refusal), `skills/sdw-orch/scripts/monitor.cjs` (terminal classification), `skills/sdw-retro/scripts/retro.cjs` (leftover detection), and `tests/sdw_batch.test.cjs` or a new `tests/sdw_run_supersession.test.cjs`.
- `superseded` is not a failure: the replacing run owns the delivery, and the old run must not appear in failure counts.
- Do not delete the superseded state file; it is audit evidence for what was replaced and why.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic cleanup of superseded run files | They are audit evidence and cheap to keep |
| Changing the rerun policy | Scope is strictly bounded to the superseded status |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Status name | `superseded` | Matches the batch field `supersededRunId` | y |
| Replacing-run reference | `supersededBy` run id plus timestamp | Enables the resume message and retro summary | y |
| Old state retention | Keep the file | Auditable and small | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Supersession path | Where `--new-run` marks the superseded id inspected | Read `batch_queue.cjs` |
| Leftover detection | `collectLeftoverRuns` understood | Read `retro.cjs` |
| Regression baseline | Batch and retro suites pass | `node --test tests/sdw_batch.test.cjs tests/sdw_retro.test.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- The superseded state file carries `status: superseded`, `supersededBy`, and `supersededAt`.
- The replacement run's retrospective reports `leftover_run: []`.
- Monitor classifies the superseded run as terminal, not active or stalled.

### Negative & Failing Test Scenarios

- Resuming a superseded run exits non-zero and names the replacing run.
- A superseded run is never counted as a failure by the batch summary.
- Retro reports a sibling superseded run as superseded rather than leftover.
