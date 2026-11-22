---
id: null
slug: 00075-fresh-context-subagent-judge
title: "Fresh-Context Subagent Judge for Qualitative Conformance and Code Quality Evaluation"
source: local
status: draft
specDate: 2026-11-21
priority: high
---
# Specification — Fresh-Context Subagent Judge for Qualitative Conformance and Code Quality Evaluation

## Description

In Step 5 of the Spec-Driven Workflow orchestrator (`sdw-run`), conformance scoring evaluates whether the implemented codebase satisfies specification acceptance criteria. When an external CLI command (`scoring.judgeCommand`) is not configured, the orchestrator currently transitions to an `awaiting_judgment` pause state, leaving the evaluation to the host agent (the orchestrator itself). This creates self-grading bias and context pollution, as the host agent has already accumulated turn history, implementation decisions, and potential confirmation bias from prior steps. Furthermore, simple heuristic regex or line-matching checks fail to evaluate holistic code quality, architectural elegance, and idiomatic adherence.

This specification introduces a dedicated fresh-context subagent judge for Step 5. When `scoring.judgeCommand` is absent and `scoring.judgeMode` is set to `"subagent"` (the default), the orchestrator generates a fenced evaluation bundle and emits a structured subagent dispatch envelope for a newly spawned judge agent. The judge subagent executes in a completely clean conversation turn without inheriting the implementer's turn transcript. To ensure that the fresh-context worker has full access to repository standards, the prompt and envelope explicitly cite the self-owned skills harness, including `sdw-rules` (`skills/sdw-rules/SKILL.md` or `.agents/skills/sdw-rules/SKILL.md`) and its simplicity and anti-pattern references.

The judge subagent conducts an in-depth qualitative evaluation, analyzing:
1. Strict Acceptance Criteria verification against actual diff and touched files.
2. Code quality, correctness, and implementation soundness.
3. Best practices, idioms, and design consistency.
4. Performance and unnecessary computational overhead.
5. Redundancy, duplicated logic, and repeated function calls.
6. Simplicity and anti-overengineering (enforcing YAGNI; flagging excessive abstractions or single-use patterns per `sdw-rules`).
7. File organization and modular structure.

The judge writes a structured verdict JSON with per-criterion verification verdicts, an overall conformance score (0-10), and qualitative assessment findings. The orchestrator ingests the verdict via `sdw-run score submit` and advances the workflow.

### Design Intent

Eliminate moral hazard and self-grading bias while introducing comprehensive qualitative code analysis. An agent that just wrote or orchestrated code cannot objectively judge its own work. Delegating evaluation to a fresh-context subagent ensures true impartial assessment. By explicitly referencing the `sdw-rules` harness in subtask envelopes and prompts, the system guarantees that all dispatched workers have immediate access to project standards, ensuring that code delivered through SDW is not only functional according to acceptance criteria, but also clean, efficient, maintainable, and aligned with `sdw-rules` simplicity principles.

## Acceptance Criteria

- AC1: The system shall provide a configurable setting `scoring.judgeMode` in `.sdw/config.json` supporting values `"subagent"`, `"command"`, and `"host"`, defaulting to `"subagent"`.
- AC2: While `scoring.judgeMode` is `"subagent"` and no external `scoring.judgeCommand` is specified, the system shall emit a structured subagent dispatch envelope for a fresh-context judge agent in Step 5 (Conformance Scoring).
- AC3: The system shall configure the judge subagent to execute in an isolated conversation context without inheriting the implementer conversation transcript or prior tool execution turns.
- AC4: Where `scoring.judgeModel` or `scoring.judgeEffort` are configured, the system shall apply those values to the judge dispatch envelope; otherwise, the judge subagent shall inherit the orchestrator agent model and effort configuration.
- AC5: The system shall generate a comprehensive judge prompt bundle that includes the specification requirements, full diff against base commit, touched file paths, and explicit qualitative evaluation instructions referencing the `sdw-rules` harness.
- AC6: The system shall instruct the judge subagent to load and apply `sdw-rules` and its anti-patterns reference to evaluate code quality, implementation soundness, best practices adherence, performance efficiency, redundancy or duplicity, and structural simplicity (YAGNI).
- AC7: The system shall provide the resolved active skills directory path for `sdw-rules` in the judge dispatch envelope and prompt to ensure harness availability to the worker.
- AC8: The system shall instruct the judge subagent to verify each acceptance criterion independently with concrete file and diff citations.
- AC9: The system shall require the judge subagent to return a structured verdict JSON containing per-criterion verification verdicts, overall conformance score, and qualitative findings.
- AC10: When the judge subagent writes the verdict JSON and submits it via `score submit`, the system shall validate verdict syntax and schema completeness.
- AC11: When the submitted verdict contains all required acceptance criteria verdicts and achieves the minimum conformance score, the system shall advance Step 5 to `completed`.
- AC12: While `scoring.judgeMode` is `"command"`, the system shall execute the configured `scoring.judgeCommand` subprocess in place of subagent dispatch.
- AC13: While `scoring.judgeMode` is `"host"`, the system shall preserve the legacy behavior of pausing Step 5 for the host orchestrator agent to submit the verdict.
- AC14: If the judge subagent fails to produce a valid verdict JSON within the configured timeout, then the system shall record the failure and fail closed with a score of 0.
- AC15: The system shall register `scoring.judgeMode` in `.sdw/config.schema.json` and validate its enum values in `sdw-config`.
- AC16: The system shall update `skills/sdw-run/references/orchestrator_protocol.md` and `skills/sdw-run/SKILL.md` to document the fresh-context subagent judge protocol and harness reference requirements.
- AC17: The system shall add automated unit tests verifying judge envelope generation, harness skill referencing, subagent prompt synthesis, verdict schema validation, and mode selection fallback.

## Notes

- Configuration schema updates:
  - Add to `scoring` in `.sdw/config.schema.json`:
    - `"judgeMode": { "type": "string", "enum": ["subagent", "command", "host"], "default": "subagent", "description": "Execution mode for Step 5 conformance scoring judge." }`.
- Implementation surfaces:
  - `skills/sdw-run/scripts/score_evaluator.cjs`: extend prompt builder with qualitative review dimensions; resolve `skillsRoot` and inject explicit citations to `sdw-rules` and `anti_patterns.md`; update verdict schema and validation to support qualitative assessments.
  - `skills/sdw-run/scripts/sdw_run.cjs`: add judge envelope creation (`type: 'judge'`) when `judgeMode === 'subagent'`, pausing with exit code 5 and resume capability; include harness path in envelope output.
  - `skills/sdw-config/scripts/sdw_config.cjs`: validate `scoring.judgeMode` enum and supply default.
  - `skills/sdw-run/references/orchestrator_protocol.md`: document Step 5 judge envelope contract, harness availability requirements, and subagent lifecycle.

## Out of Scope

| Feature | Reason |
|---|---|
| Multi-model jury consensus voting | Keep execution lean and single-subagent; avoid token multiplication |
| Interactive judge chat sessions | Judge is an automated evaluation envelope producing structured verdict output |
| Auto-remediation by the judge | Judge only evaluates and reports; fixes are handled by Step 4 or Step 7 |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Default judge mode | `"subagent"` | Provides objective independent evaluation without self-grading bias | y |
| Fallback model | Orchestrator model | Ensures equivalent reasoning capability without requiring extra model keys | y |
| Timeout ceiling | 600000ms (10 min) | Allows deep review of large diffs while preventing infinite hangs | y |
| Harness availability | Explicit path citation | Ensures fresh-context subagent can locate and read sdw-rules immediately | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Specification syntax | Valid EARS format and section hierarchy | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring` |
| Zero runtime dependencies | Node.js 22 built-ins only | Code inspection |
| Backward compatibility | `judgeMode: "command"` and `"host"` remain fully supported | Automated unit tests |
| Harness visibility | Judge prompt explicitly links to `sdw-rules` | Automated unit tests |

## Validation & Observation Notes

### Telemetry & Observable Signals
- Step 5 output indicates: `[Step 5: Conformance Scoring] Dispatched fresh-context judge subagent [mode: subagent, criticity: strict]`.
- Envelope output contains `envelope.type = "judge"`, `promptFile`, `verdictFile`, `submitCommand`, and `skillsRoot`.
- State file records `steps["5"].judge.mode = "subagent"`.

### Negative & Failing Test Scenarios
- If the judge verdict omits an assigned acceptance criterion, `score submit` rejects the verdict with exit code 1.
- If `scoring.judgeMode` is set to an invalid value (e.g. `"magic"`), `sdw-config` rejects the configuration with an actionable error.
- If the judge prompt fails to reference `sdw-rules`, harness validation fails.
