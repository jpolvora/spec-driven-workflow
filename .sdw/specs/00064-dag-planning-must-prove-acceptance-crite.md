---
id: null
localSpecId: "00064"
slug: 00064-dag-planning-must-prove-acceptance-crite
title: "DAG planning must prove acceptance-criterion file coverage"
source: local
status: implemented
specDate: 2026-10-23
priority: high
value: "Stops DAG slices that cannot satisfy their assigned criteria, six wasted dispatch rounds in one batch"
effort: S
---

# Specification — DAG planning must prove acceptance-criterion file coverage

## Description

DAG planning must prove every assigned acceptance criterion has a supporting file in its slice.

Step 3 assigns acceptance criteria to tasks and a target-file slice per task, but it never checks that the two agree. Six dispatch rounds in one batch stopped because an assigned criterion needed a file outside the slice, forcing the host to widen the fence by hand mid-run.

- When the planner assigns acceptance criteria to a task, the system shall require at least one target file in that task slice for every assigned criterion, or record an explicit no-file reason for the criterion.
- If an assigned criterion has no supporting file and no recorded reason, then the planner shall fail the plan with a non-zero exit naming the criterion and the task.
- The system shall emit a coverage report mapping each criterion to its task and files in the Step 3 output and in dag preview --json.
- The system shall cover the check with tests for full coverage, a missing criterion, and a recorded no-file reason.

### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for DAG planning must prove acceptance-criterion file coverage.

## Acceptance Criteria

- AC1: When the planner assigns acceptance criteria to a task, the system shall require at least one target file in that task slice for every assigned criterion, or record an explicit no-file reason for the criterion.
- AC2: If an assigned criterion has no supporting file and no recorded reason, then the planner shall fail the plan with a non-zero exit naming the criterion and the task.
- AC3: The system shall emit a coverage report mapping each criterion to its task and files in the Step 3 output and in dag preview --json.
- AC4: The system shall cover the check with tests for full coverage, a missing criterion, and a recorded no-file reason.

## Notes

- Target files: `skills/sdw-orch/scripts/dag_planner.cjs` (plan generation, coverage validation, Step 3 output), `skills/sdw-orch/scripts/sdw_orch.cjs` (`dag preview --json` and the non-zero exit), `tests/dag_planner_coverage.test.cjs` (new coverage cases).
- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00064-dag-planning-must-prove-acceptance-crite |

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
