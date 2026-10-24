---
id: null
localSpecId: "00068"
slug: 00068-review-findings-must-be-adjudicated
title: "Review findings must be adjudicated before a run completes"
source: local
status: draft
specDate: 2026-10-24
priority: high
value: "Stops 12 Step 7 suggestions from every batch staying open forever, so a completed run means every finding was fixed or explicitly waived"
effort: S
---

# Specification — Review findings must be adjudicated before a run completes

## Description

Every Step 7 review finding must be adjudicated, either fixed with a commit or waived with a recorded rationale, before the run may complete.

Step 7 records reviewer findings in the run state. Findings that are suggestions do not block the review gate, so the run ships with them still marked `open`. Across batch `batch-1792765277156` the eight reviewed runs recorded 12 findings, all with `status: open`, and the retrospectives keep reporting them as open (for example run `00018` reports `CR-001`, `CR-002`, `CR-003` open). There is no command and no state field that lets the orchestrator say "fixed in commit X" or "accepted, because Y", so the record never resolves and the same class of finding recurs unnoticed.

### Design Intent

Make the review ledger complete rather than merely non-blocking. A finding is a fact with a lifecycle: raised, then either fixed or waived. Recording the disposition keeps the review trail honest, lets the report and the retrospective count only genuinely open findings, and gives a maintainer an explicit, auditable waiver instead of silence.

## Acceptance Criteria

- AC1: The system shall record every Step 7 finding with an explicit disposition of `fixed` or `waived` in run state.
- AC2: When a finding is disposed `fixed`, the system shall record the fixing commit sha and the timestamp.
- AC3: When a finding is disposed `waived`, the system shall require a non-empty rationale and record it with the timestamp.
- AC4: If any Step 7 finding has no disposition when the run reaches Step 8, then the ship gate shall block the ship and name every disposition-missing finding id and path.
- AC5: The system shall provide `review dispose --run-id <id> --finding <id> --fixed <sha>` and `review dispose --run-id <id> --finding <id> --waived <reason>`, refusing an unknown finding id, a missing sha, or an empty rationale.
- AC6: The delivery report and the retrospective shall render each finding with its disposition, and count only undisposed findings as open; a disposition survives a resume.
- AC7: The system shall cover fixed, waived, blocked-open, unknown-id, and resume-persistence paths with tests.

## Notes

- Implementation surfaces: `skills/sdw-orch/scripts/sdw_orch.cjs` (Step 7 recording, Step 8 gate, the `review dispose` command), `skills/sdw-orch/scripts/review_runner.cjs` (finding shape), `skills/sdw-orch/scripts/delivery_report.cjs` (report block), `skills/sdw-retro/scripts/retro.cjs` (open-finding signal), and `tests/sdw_orch_scoring.test.cjs` or a new `tests/sdw_review_findings.test.cjs`.
- Finding identity is the reviewer-assigned id (`CR-001`); do not mint a second identity.
- A finding that a later review round re-reports keeps its disposition only when the path and message are unchanged; a changed finding is raised again.
- Blocking findings already fail the review gate; this specification adds the disposition requirement for every finding, blocking or suggestion.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic fixing of review findings | The fixer/worker path already owns remediation |
| Changing the review prompt or model | Scope is strictly bounded to finding adjudication |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Disposition owners | The orchestrating agent records dispositions | It drives the review loop and knows the fix commit | y |
| Waiver durability | Stored on run state, rendered in the report | Matches the existing finding record | y |
| Undisposed findings | Block Step 8 | A silent open finding is the defect being removed | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Finding shape | Step 7 output `findings[]` inspected on a real run state | Read `.sdw/state/run-*.state.json` |
| Ship gate baseline | Existing Step 8 audit and review gates understood | Read `sdw_orch.cjs` Step 8 |
| Regression baseline | Orchestrator and retro suites pass | `node --test tests/sdw_orch.test.cjs tests/sdw_retro.test.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `[Review] CR-001 fixed in <sha>` and `[Review] CR-002 waived: <reason>` on disposition.
- Run state carries `steps[7].output.findings[].disposition` with `at` and either `commit` or `reason`.
- The delivery report lists every finding with its disposition; the retro open count drops to the genuinely undisposed number.

### Negative & Failing Test Scenarios

- A finding with no disposition blocks Step 8 and the message names it.
- `review dispose` with an unknown id exits non-zero and writes nothing.
- `--waived ""` is refused.
