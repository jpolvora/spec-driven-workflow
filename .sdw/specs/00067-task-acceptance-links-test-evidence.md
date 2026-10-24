---
id: null
localSpecId: "00067"
slug: 00067-task-acceptance-links-test-evidence
title: "Task acceptance must link test evidence to the acceptance criteria ledger"
source: local
status: draft
specDate: 2026-10-24
priority: high
value: "Unblocks the negative-scenario score cap that silently capped 7 of 10 delivered specs at 8/10, and gives explain/report real test evidence"
effort: S
---

# Specification — Task acceptance must link test evidence to the acceptance criteria ledger

## Description

Task acceptance must link the recorded test evidence to the acceptance criteria ledger, and the negative-scenario score cap must only fire when no passing test evidence exists for that criterion.

The ledger records every piece of evidence by type, but task acceptance links only `file` and `commit` entries. Across batch `batch-1792765277156` the ten runs produced 135 `file`, 19 `commit`, and 19 `review` entries and exactly zero `test` entries, although every worker recorded executed test commands in its evidence file. Because `deriveScore` caps the score at 8 when a criterion declares a negative scenario and carries no passing `test` evidence, seven of the ten delivered specs scored 8/10 for that reason alone, and `report explain` renders `testsObserved: unknown` for runs whose tests demonstrably ran.

### Design Intent

Make the ledger reflect what the run actually observed. Task evidence already carries the executed test commands and their results; linking them as typed `test` evidence turns a silent quality signal into an auditable one, and keeps the negative-scenario cap meaningful instead of universal.

## Acceptance Criteria

- AC1: When `task finish` accepts a task, the system shall link each named test entry from the accepted evidence file to every acceptance criterion the task claims, as `test` evidence carrying the test name and its status.
- AC2: If a test entry has no name or a status outside `passed`, `failed`, and `skipped`, then the system shall skip that entry, report a warning, and leave the task acceptance unchanged.
- AC3: The system shall deduplicate linked test evidence by test name, with the status as the compared identity field, so replaying the same acceptance adds no duplicate entry and a re-linked result that reports another status replaces the stored entry instead of appending a second one.
- AC4: When the ledger derives the score, the system shall apply the negative-scenario cap only to a criterion that declares a negative scenario and has no `test` evidence with status `passed`.
- AC5: The system shall cover the linking, the skip warning, the dedupe, and the cap lift with tests.

## Notes

- Implementation surfaces: `skills/sdw-orch/scripts/sdw_orch.cjs` (`linkAcceptedTaskEvidence`), `skills/sdw-orch/scripts/ac_ledger.cjs` (`buildEvidenceEntry`, `deriveScore`, evidence identity), and `tests/sdw_ac_ledger.test.cjs`.
- Evidence shape: the accepted evidence file already carries `tests: [{ name, status, command? }]`; reuse it instead of adding a new field.
- A test-typed entry that is skipped or failed is audit evidence, never proof; only a `passed` test lifts the cap for its criterion.
- Keep the ledger schema and the `unknown` rule unchanged; a criterion with no test evidence still reports the cap and its reason.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Backfilling test evidence for already delivered runs | The cap was correct for those runs; a retrofitted ledger would fabricate evidence |
| Scoring beyond the current 0-10 formula | Scope is strictly bounded to linking existing test evidence |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Test identity | Test name, with the status compared on replay (the 00017 update-in-place rule) | Matches the existing evidence de-duplication rule: `test` evidence is keyed by name, and a re-linked result with another status replaces the stored entry | y |
| Conflict handling | Malformed entries are skipped, never invented | A missing name is not evidence | y |
| Cap source | Any criterion whose text declares a negative scenario | Same rule as today, now satisfied by real test evidence | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Ledger baseline | `ac_ledger.cjs` evidence builder and `deriveScore` understood | Read the module and its tests |
| Task evidence shape | A real accepted evidence file inspected | Read `.sdw/state/*/task-*.evidence.json` |
| Regression baseline | Existing ledger and scoring suites pass | `node --test tests/sdw_ac_ledger.test.cjs tests/sdw_orch_scoring.test.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `[Ledger] task-N linked K test evidence record(s) to AC1, AC2` on acceptance.
- The ledger file carries `test` entries with name and status.
- The Step 5 report names the cap only for criteria that still lack a passing test.

### Negative & Failing Test Scenarios

- A test entry with `status: "flaky"` is skipped with a warning and no ledger change.
- A duplicate acceptance adds no second test entry.
- A criterion without any passing test keeps the cap at 8.
