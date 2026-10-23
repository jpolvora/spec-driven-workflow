---
id: null
localSpecId: "00066"
slug: 00066-batch-pre-flight-must-wait-for-required-
title: "Batch pre-flight must wait for required checks before merging"
source: local
status: implemented
specDate: 2026-10-23
priority: medium
value: "Lets batch pre-flight merge governed pull requests without halting the queue for a manual merge"
effort: S
---

# Specification — Batch pre-flight must wait for required checks before merging

## Description

Batch pre-flight must wait for required checks instead of failing an immediate merge.

Batch pre-flight merges each earlier delivery pull request through an immediate merge. On a protected integration branch that requires status checks, the merge is refused while checks are pending, the item records merge failed, and the queue halts until the operator merges by hand.

- When batch pre-flight merges an earlier delivery pull request, the system shall create the merge request only after the required checks report success, or enable provider auto-merge when the provider supports it.
- If the provider refuses an immediate merge because checks are pending, then the system shall record waiting, poll the checks to a terminal state, and retry the merge once.
- If the checks fail or the branch is not mergeable, then the queue shall halt naming the pull request and the failing checks.
- The system shall record the merge attempt, the observed state, and the retry outcome on the item merge record.
- The system shall cover pending, passing, and failing check paths with tests.

### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for Batch pre-flight must wait for required checks before merging.

## Acceptance Criteria

- AC1: When batch pre-flight merges an earlier delivery pull request, the system shall create the merge request only after the required checks report success, or enable provider auto-merge when the provider supports it.
- AC2: If the provider refuses an immediate merge because checks are pending, then the system shall record waiting, poll the checks to a terminal state, and retry the merge once.
- AC3: If the checks fail or the branch is not mergeable, then the queue shall halt naming the pull request and the failing checks.
- AC4: The system shall record the merge attempt, the observed state, and the retry outcome on the item merge record.
- AC5: The system shall cover pending, passing, and failing check paths with tests.

## Notes

- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00066-batch-pre-flight-must-wait-for-required- |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Workspace directory standards | Follow canonical .sdw workspace guidelines | Consistent developer ergonomics across projects | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | Run validate_spec.cjs in authoring mode |
| Directory layout | Target workspace directories exist and are writable | File system check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Deterministic command execution logs and structured console progress reports.
- Non-zero exit codes returned upon validation or verification failures.

### Negative & Failing Test Scenarios

- Input rejection test case: the system must reject invalid inputs or malformed options with descriptive error messages.
