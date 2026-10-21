---
id: "18"
slug: 00042-us-18-reduce-repeated-full-test-suite-r
title: "Reduce repeated full test suite runs during task implementation"
source: github
status: draft
specDate: 2026-10-21
---

# Specification — Reduce repeated full test suite runs during task implementation

## Description

# Reduce repeated full test suite runs during task implementation

## Problem
Subagents waste time running the full suite (`npm test`) after every small edit. A single fix triggers another full run, then the next fix triggers another, even when the change touches one file with a dedicated test. This slows DAG tasks with no quality gain, since Step 4 gates and Step 8 already run the full suite once at the end.

Root signals:
- Task prompts require honest `tests` evidence (`skills/sdw-orch/scripts/implementation_runner.cjs` evidence schema) but give no tiered guidance, so workers default to the safest full run.
- `sdw-rules` demands empirical verification per action, which workers read as full suite per edit.
- Orchestrator runs full verification once all tasks are accepted (`orchestrator_protocol.md` Step 4 gates, Step 8 pre-PR gates via `runAllTests` plus `testCommand`), so per-edit full runs duplicate that final gate.

## Proposal
Add explicit tiered test instructions to the worker prompt and protocol:
- During iteration: run only the focused test for touched files (single test file, single case, `node --check` for syntax). Repeat only that focused check per fix.
- Full suite only when required: shared helper changed, multiple tasks touched the same area, gate fix outside task scope, final pass before writing evidence, or Step 4 and Step 8 gates demand it.
- Final task pass: one full suite run at end of implementation to confirm nothing regressed, recorded in evidence `tests`.
- Keep `Do not record a test you did not execute` unchanged.

## Scope
- `skills/sdw-orch/scripts/implementation_runner.cjs` task prompt template (test guidance section).
- `skills/sdw-orch/references/orchestrator_protocol.md` Step 4 verification section documents focused first, full last.
- No change to gate semantics: Step 4 verification gates and Step 8 `runAllTests` plus `testCommand` still run the full suite once.
- No new config key required; reuse existing `verification.testCommand`, `runAllTests`, `testCommand`.

## Verification
- [ ] Single file fix shows focused test per iteration plus at most one full run in evidence.
- [ ] Multi file or shared helper change still triggers full suite with reason noted.
- [ ] `npm test` passes.
- [ ] Docs updated: `orchestrator_protocol.md` only, no duplicate in `AGENTS.md`.


### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for Reduce repeated full test suite runs during task implementation.

### Prior Work Sweep

Reviewed existing workspace implementations and tracker references prior to specification formulation.

## Acceptance Criteria

- AC1: The system shall single file fix shows focused test per iteration plus at most one full run in evidence.
- AC2: The system shall multi file or shared helper change still triggers full suite with reason noted.
- AC3: The system shall `npm test` passes.
- AC4: The system shall docs updated: `orchestrator_protocol.md` only, no duplicate in `AGENTS.md`.

## Notes

- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00042-us-18-reduce-repeated-full-test-suite-r |

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
