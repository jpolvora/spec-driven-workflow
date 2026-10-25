---
id: null
localSpecId: "00073"
slug: 00073-batch-skip-must-keep-retro-follow-up
title: "A batch skip must keep the retro follow-up and the delivery outcome"
source: local
status: draft
specDate: 2026-10-25
priority: medium
value: "Stops a resumed queue from dropping the retrospective candidates it just paid to produce and from reporting a delivery as if it never happened"
effort: S
---

# Specification — A batch skip must keep the retro follow-up and the delivery outcome

## Description

An item classified `already_implemented` on a later queue pass still owns its retrospective candidates and its delivery outcome.

In batch `batch-1792826020541` all five items ended `already_implemented`, although every one was implemented and delivered by that batch's own runs: the runs were created between `07:13:43Z` and `13:58:28Z`, after the batch started at `07:13:40Z`, and their task commits postdate the batch start. No item carries `retroFollowUp`, despite `retro.followUp: queue` in [`.sdw/config.json`](../../.sdw/config.json). The skip branch runs the pre-flight and the merge and then advances, without calling `applyRetroFollowUp` ([`batch_queue.cjs:1723`](../../skills/sdw-batch/scripts/batch_queue.cjs)). The item status is also overwritten by the registry classification, so the manifest cannot distinguish a spec delivered here from one completed before the batch.

### Design Intent

The registry answers "does this specification still need implementation". It must not erase what the item delivered or silence its retrospective. One outcome field, separate from the skip classification, and one call to the existing follow-up stage keep the manifest auditable and the candidate queue complete.

## Acceptance Criteria

- AC1: When an item is classified `already_implemented` during a queue pass, the system shall run the retro follow-up stage for that item before advancing.
- AC2: When the item's run state carries a retro report, the system shall record `retroFollowUp` on the item with its status and candidate counts.
- AC3: If the item has no run state or no retro report, then the system shall record `retroFollowUp.status: unavailable` without halting the queue.
- AC4: Where the follow-up policy is `queue`, the system shall append each critical or high candidate specification at most once across repeated passes.
- AC5: The system shall record an item outcome separate from the skip classification so a delivery made during this batch is distinguishable from an earlier completion.
- AC6: The system shall cover the skip-path follow-up, the unavailable report, the duplicate prevention, and the outcome field with tests.

## Notes

- Evidence: `batch-1792826020541`, five items labeled `already_implemented`, five runs created inside the batch window, zero `retroFollowUp` records.
- Implementation surfaces: [`batch_queue.cjs`](../../skills/sdw-batch/scripts/batch_queue.cjs) (`executeQueue` skip branch, `applyRetroFollowUp`, `applyRunState`, `printSummary`), [`batch_protocol.md`](../../skills/sdw-batch/references/batch_protocol.md) sections 2, 3 and 7, [`tests/sdw_batch_retro.test.cjs`](../../tests/sdw_batch_retro.test.cjs) and [`tests/sdw_batch.test.cjs`](../../tests/sdw_batch.test.cjs).
- The current skip branch is [`batch_queue.cjs:1723-1737`](../../skills/sdw-batch/scripts/batch_queue.cjs); the completed path calls `applyRetroFollowUp` at line 1847.
- Reuse the existing `retroFollowUp` shape and its `processed` candidate ids for idempotency; do not invent a second record.
- The outcome field name is an assumption: `outcome` with `delivered`, `skipped`, or `failed`. The protocol must document it in section 2 before implementation.
- A skip still never re-delegates a completed specification, per spec 00053.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Re-running the retrospective | `state.retro` is authoritative; the batch consumes it |
| Re-implementing a completed specification | The skip rule stays |
| Changing candidate severity routing | `sdw-retro` owns severity and candidates |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Follow-up on a skip | Run it | The run exists and its report is delivery evidence | y |
| Missing report | `unavailable`, no halt | Matches the existing follow-up status vocabulary | y |
| Duplicate prevention key | Candidate id from the report | `retroFollowUp.processed` already stores candidate ids | y |
| Outcome field | `outcome` with `delivered`, `skipped`, `failed` | One field separates delivery from registry classification | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Skip branch | `executeQueue` skip path and the completed path compared | Read both branches in `batch_queue.cjs` |
| Follow-up writer | `applyRetroFollowUp` statuses and idempotency understood | Read the function and `tests/sdw_batch_retro.test.cjs` |
| Status printer | `printSummary` and `formatStatus` fields identified | Read both renderers |
| Manifest contract | Skip, outcome, and follow-up fields agreed | Read `batch_protocol.md` section 2 |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `retroFollowUp.status`, `retroFollowUp.queued`, and `retroFollowUp.failures` on every skipped item.
- The new `outcome` field on every item.
- One summary line naming each queued specification and each creation failure.

### Negative & Failing Test Scenarios

- Missing retro report: the item records `unavailable` and the queue still advances.
- Repeated resume: the same candidate is queued once and the second pass records no duplicate.
- Candidate creation failure: the failure is recorded, the item stays completed, and the queue does not halt.
- A delivered item loses its outcome: the test asserts the outcome field survives a resume.
