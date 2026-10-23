---
id: null
localSpecId: "00065"
slug: 00065-judge-verdict-contract-must-define-parti
title: "Judge verdict contract must define partial verdict handling"
source: local
status: implemented
specDate: 2026-10-23
priority: medium
value: "Aligns the judge prompt with the verdict validator so a judge answer is never rewritten by hand"
effort: S
---

# Specification — Judge verdict contract must define partial verdict handling

## Description

Judge verdict contract must state explicitly whether partial verdicts are allowed.

The judge prompt asks for per-criterion verdicts, but the submission validator accepts only verified or failed. A judge that answered partial had its verdict rejected, and the operator had to rewrite the value by hand, which changes the judge's judgment after the fact.

- The judge prompt output contract shall enumerate the exact accepted verdict values.
- The score submit command shall accept exactly the values the prompt defines.
- If the contract allows partial, then submission shall accept it and the score computation shall treat it as not verified while preserving it in the report.
- If the contract forbids partial, then the prompt shall tell the judge to use failed, and submission shall reject partial naming the allowed values.
- The system shall cover both the accepted and rejected paths with tests.

### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for Judge verdict contract must define partial verdict handling.

## Acceptance Criteria

- AC1: The judge prompt output contract shall enumerate the exact accepted verdict values.
- AC2: The score submit command shall accept exactly the values the prompt defines.
- AC3: If the contract allows partial, then the system shall then submission shall accept it and the score computation shall treat it as not verified while preserving it in the report.
- AC4: If the contract forbids partial, then the prompt shall tell the judge to use failed, and submission shall reject partial naming the allowed values.
- AC5: The system shall cover both the accepted and rejected paths with tests.

## Notes

- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00065-judge-verdict-contract-must-define-parti |

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
