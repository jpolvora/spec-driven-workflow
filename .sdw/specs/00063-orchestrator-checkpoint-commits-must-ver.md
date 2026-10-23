---
id: null
localSpecId: "00063"
slug: 00063-orchestrator-checkpoint-commits-must-ver
title: "Orchestrator checkpoint commits must verify the run branch"
source: local
status: implemented
specDate: 2026-10-23
priority: high
value: "Stops accepted task work landing on the integration branch when another session owns the checkout"
effort: S
---

# Specification — Orchestrator checkpoint commits must verify the run branch

## Description

Orchestrator checkpoint commits must verify the run branch before committing.

Today task finish creates the per-task checkpoint commit on whatever branch is checked out. When a second session switches the shared checkout, accepted task work lands on the integration branch instead of the run feature branch, the feature branch stays empty, and Step 5 judges a zero-byte diff.

- When task finish accepts a task, the system shall assert that the checked-out branch equals the run feature branch recorded in run state before creating the checkpoint commit.
- If the checked-out branch differs from the run branch, then the system shall refuse the commit, leave the task dispatched, and exit non-zero naming both branches and the resume remedy.
- The system shall record the observed branch, the expected branch, and the refusal reason in steps[4].tasks[taskId].
- The system shall cover the guard with tests for a matching branch, a mismatched branch, and a detached HEAD.

### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for Orchestrator checkpoint commits must verify the run branch.

## Acceptance Criteria

- AC1: When task finish accepts a task, the system shall assert that the checked-out branch equals the run feature branch recorded in run state before creating the checkpoint commit.
- AC2: If the checked-out branch differs from the run branch, then the system shall refuse the commit, leave the task dispatched, and exit non-zero naming both branches and the resume remedy.
- AC3: The system shall record the observed branch, the expected branch, and the refusal reason in steps[4].tasks[taskId].
- AC4: The system shall cover the guard with tests for a matching branch, a mismatched branch, and a detached HEAD.

## Notes

- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00063-orchestrator-checkpoint-commits-must-ver |

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
