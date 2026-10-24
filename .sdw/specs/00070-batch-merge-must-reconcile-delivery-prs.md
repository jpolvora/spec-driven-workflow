---
id: null
localSpecId: "00070"
slug: 00070-batch-merge-must-reconcile-delivery-prs
title: "Batch merge must reconcile delivery and follow-up pull requests"
source: local
status: implemented
specDate: 2026-10-24
priority: medium
value: "Ends false `merge: failed` rows for already merged deliveries and merges post-merge report PRs instead of leaving them for the operator"
effort: M
---

# Specification — Batch merge must reconcile delivery and follow-up pull requests

## Description

Batch merge must resolve the delivery pull request recorded by the run, treat an already merged delivery as merged, and merge a post-merge follow-up pull request under the same check gate.

`batch-1792765277156` recorded `merge: failed` for four of its ten items (00017, 00066, 00021, 00023) while those deliveries were in fact merged. The batch merge stage resolves "the pull request for this head branch" by listing PRs and taking the newest, so after a mid-run merge it picked the follow-up PR that the post-merge registry and report commits created (`#59`, `#63`, `#65`, `#67`), then recorded the refusal of that unapproved PR as the item's merge outcome. The real delivery PRs (`#58`, `#62`, `#64`, `#66`) were already merged. The follow-up PRs stayed open until merged by hand.

### Design Intent

A merge record must describe the delivery, not whichever PR happens to share the branch name. Runs already record their delivery commit and pull request; using that record, treating an existing merge as final, and merging follow-up PRs under the same gate makes the queue self-healing instead of reporting a failure the operator must reconcile.

## Acceptance Criteria

- AC1: When the merge stage runs for an item, the system shall resolve the pull request from the pull request number recorded in run state, falling back to the head-branch lookup only when no number is recorded.
- AC2: If the resolved delivery pull request is already merged, then the system shall record `merge.status: merged` without issuing another merge.
- AC3: When a follow-up pull request exists for the same head branch after the delivery merged, the system shall merge it under the same required-check gate and record it separately on the item (for example `followUpPrNumber` and its own status).
- AC4: The system shall never record `merge.status: failed` when the delivery pull request is merged.
- AC5: The system shall cover an already merged delivery, a follow-up merge, a follow-up with pending checks, and an item without a recorded PR, with tests.

## Notes

- Implementation surfaces: `skills/sdw-batch/scripts/batch_queue.cjs` (`resolveMerge`, `applyMerge`, `mergeEarlierDelivery`, the merge record), `skills/sdw-orch/scripts/sdw_orch.cjs` (the recorded PR number on run state), and `tests/sdw_batch.test.cjs`.
- Keep the spec 00066 check gate for any merge actually issued; a follow-up merge waits, retries once, and halts on failing checks exactly like a delivery merge.
- The follow-up record is additive: an item merged before this change keeps its existing `merge` object.
- A run that recorded no pull request number keeps the current head-branch behavior, but an already merged PR is still recorded `merged`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatically creating follow-up pull requests | sdw-ship-pr already owns PR creation |
| Closing stale follow-up branches | Branch cleanup stays a repository policy |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| PR number source | `state.prNumber` recorded by Step 8 | It is the delivery identity | y |
| Follow-up detection | Same head branch, different PR number | The branch is the shared key | y |
| Failure semantics | Only a genuine unmerged delivery may fail | A merged delivery is final | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Batch merge code | `applyMerge` and `mergeEarlierDelivery` understood | Read `batch_queue.cjs` |
| Run state PR field | The recorded pull request number inspected | Read a completed run state |
| Regression baseline | Batch suites pass | `node --test tests/sdw_batch.test.cjs tests/sdw_batch_retro.test.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `[sdw-batch] Merged 58 for 00017-sdw-ac-ledger-traceability` and no failure row for an already merged delivery.
- The item merge record carries `status: merged`, `prNumber`, and a separate `followUp` block when one merged.
- A follow-up blocked on checks records `waiting` then `failed` and halts naming the checks.

### Negative & Failing Test Scenarios

- A merged delivery whose follow-up PR is refused still records `merged` for the delivery.
- A follow-up with failing required checks halts and names the checks.
- An item without any recorded PR records `skipped: no-pr`, never a fabricated number.
