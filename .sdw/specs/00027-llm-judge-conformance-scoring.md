---
id: null
slug: 00027-llm-judge-conformance-scoring
title: "LLM-Judge Conformance Scoring"
source: local
status: implemented
specDate: 2026-10-19
---

# Specification — LLM-Judge Conformance Scoring

## Description

Replace the static evidence-count conformance score formula in sdw-orch Step 5 (score_evaluator.cjs: round(verifiedAcs/totalAcs*10)) with an LLM-judge assessment. The judge runs in its own fenced context containing only the spec acceptance criteria and the generated code diff, never cumulative transcripts. Judge model selection is fully configurable and optional: model name, provider, effort, and API endpoint, all defaulting to the current agent model instance. Include a configurable criticity level from permissive to strict to perfectionist. The judge emits a deterministic 0-10 score plus per-AC verdicts with evidence references. Keep fail-closed behavior (0 ACs scores 0) and the existing scoreMin threshold gate.

### Design Intent

Static evidence counting measures traceability, not correctness: it cannot tell whether the generated code actually satisfies an acceptance criterion. An LLM judge comparing the spec against the generated diff assesses semantic conformance directly. Judge bias is contained by fencing its context to criteria plus diff (never cumulative transcripts), by requiring per-AC verdicts with evidence references that humans and downstream steps can audit, and by making criticity configurable so consumers choose their strictness.

## Acceptance Criteria

- AC1: The system shall remove the static evidence-count formula `round(verifiedAcs/totalAcs*10)` from Step 5 conformance scoring.
- AC2: The system shall assess conformance by delegating scoring to an LLM judge invoked with a fenced context.
- AC3: Where the judge is invoked, the system shall include only the specification acceptance criteria and the generated code diff in the judge context and exclude cumulative transcripts.
- AC4: The system shall accept optional judge configuration for model name, provider, effort, and API endpoint.
- AC5: When any judge configuration value is absent, the system shall default to the current agent model instance.
- AC6: The system shall provide a configurable criticity level with permissive, strict, and perfectionist settings.
- AC7: The system shall require the judge to emit an integer score from 0 to 10 plus per-AC verdicts with evidence references.
- AC8: If the specification contains zero acceptance criteria, then the system shall score 0/10 and fail closed without invoking the judge.
- AC9: While the scoreMin threshold gate is configured, the system shall enforce it against the judge score and trigger the re-implementation loop when the score is below threshold.
- AC10: If the judge is unavailable or returns a malformed verdict, then the system shall fail closed with score 0/10 and actionable error details.

## Notes

- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00027-llm-judge-conformance-scoring |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Workspace directory standards | Follow canonical .sdw workspace guidelines | Consistent developer ergonomics across projects | y |
| Default criticity level | Balanced (between permissive and strict) | Safe middle ground until consumer tunes strictness | n |
| Judge config keys | `judgeModel`, `judgeProvider`, `judgeEffort`, `judgeApiEndpoint`, `judgeCriticity` under Step 5 / verification config | Mirrors existing `scoreMin` configuration pattern | n |
| Evidence pipeline | Task evidence records continue to be collected and are passed as judge context attachments | Preserves traceability while scoring moves to the judge | n |

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
