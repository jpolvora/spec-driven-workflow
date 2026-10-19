---
id: null
slug: 022-sdw-harness-diagnostics
title: "SDW Harness Diagnostics, Workflow Simulation, and Context Budget Audit"
source: local
specDate: 2026-10-19
---

# Specification — SDW Harness Diagnostics, Workflow Simulation, and Context Budget Audit

## Description

SDW has no self-diagnostic surface. There is no command that validates workspace configuration, skill directories, and referenced paths together; no simulation that proves the 8-step pipeline still has valid transitions; no audit that enforces the Tier-1 line budget or detects broken links and duplicate normative blocks; and no record of the prompt actually dispatched to a step. As the skill set grows, these omissions let configuration drift, stale references, and prompt bloat reach consumers silently.

This specification adds a read-only diagnostic suite: `doctor`, `version`, `check-workflows`, `check-harness`, and dispatch prompt manifests with configurable context budgets. The commands are deterministic, dependency-free, and return machine-readable JSON alongside human output.

### Design Intent

Make the harness prove itself before a consumer depends on it. Diagnostics are read-only and fail closed on errors, so they can run in CI and pre-ship gates. Workflow simulation validates the state machine without executing an implementation. Context budgets make prompt growth visible and enforceable, while a persisted prompt manifest preserves exactly what a step was given. All checks use the Node standard library and remain harness-agnostic.

## Acceptance Criteria

- AC1: The system shall provide a `doctor` command that validates workspace configuration, skill directories, and referenced paths.
- AC2: The system shall provide `doctor --json` output with a non-zero exit code on errors.
- AC3: The system shall provide a `version` command that reports the package version and install scope.
- AC4: The system shall provide a `check-workflows` command that simulates the 8-step pipeline and batch queue.
- AC5: When `check-workflows` detects a missing step, invalid transition, or missing handoff, the system shall report a failure.
- AC6: The system shall provide a `check-harness` command that validates Tier-1 line budgets, broken links, and duplicate normative blocks.
- AC7: The system shall enforce a Tier-1 `SKILL.md` budget of at most 120 lines.
- AC8: The system shall support a global dispatch context budget and per-step overrides with a documented floor.
- AC9: When a step is dispatched, the system shall write a prompt file and a manifest containing the prompt hash and effective budget.
- AC10: The system shall verify the prompt manifest before advancing the step.
- AC11: If a required skill reference is missing, then the system shall fail `doctor` with the missing path.
- AC12: If a skill exceeds its budget, then the system shall report the offending skill and line count.
- AC13: The system shall document diagnostic commands, budgets, and manifest fields.
- AC14: The system shall add tests for doctor, FSM simulation, harness audit, context budgets, and prompt manifests.
- AC15: If a prompt manifest hash does not match the prompt file, then the system shall block the step transition.

## Notes

- Implementation surfaces:
  - `skills/sdw-router/scripts/sdw_router.cjs`: extend `doctor` or delegate to the new diagnostics module.
  - `skills/sdw-orch/scripts/harness_check.cjs` (new): link, budget, duplicate-block, and reference validation.
  - `skills/sdw-orch/scripts/workflow_sim.cjs` (new): deterministic 8-step and batch FSM simulation.
  - `skills/sdw-orch/scripts/prompt_audit.cjs` (new): prompt rendering, hash manifest, and verification.
  - `skills/sdw-orch/scripts/version.cjs` (new) or `skills/sdw-config/scripts/sdw_config.cjs`: package version and install-scope reporting.
  - `skills/sdw-orch/references/diagnostics.md` (new): command surface, budgets, and manifest schema.
- Command surface:
  ```bash
  node skills/sdw-orch/scripts/sdw_orch.cjs doctor [--json]
  node skills/sdw-orch/scripts/sdw_orch.cjs version [--json]
  node skills/sdw-orch/scripts/sdw_orch.cjs check-workflows [--json]
  node skills/sdw-orch/scripts/sdw_orch.cjs check-harness [--json]
  ```
- Doctor checks: `config.json` presence and schema validity; `specsDir` and `stateDir` resolution; skill directory existence; `SKILL.md` readability; referenced reference files; unresolved `{projectRoot}` tokens; stale skill ids in routing tables.
- Workflow simulation: step order 1–8, allowed statuses per step, required handoff fields between steps, Step 4 execution contract, Step 5 ledger requirement, Step 6 guard, Step 7 review output, Step 8 delivery intent. Batch simulation covers queue ordering, child state isolation, and resume from the first non-completed item.
- Harness audit: Tier-1 `SKILL.md` ≤120 lines; every `SKILL.md` link resolves; no duplicated normative block across skills (normalized paragraph hashing); frontmatter has `name`, `description`, `version`, `invocation_names`.
- Context budgets: `contextBudgetBytes` default 32768; `stepContextBudgets` maps step number to bytes with an 18000 floor; step override wins over global. A manifest records effective bytes, source (`global` or `step`), prompt sha256, included references, and timestamp.
- Prompt audit path: `{stateDir}/{slug}/{runId}/step-{N}.prompt.md` and `step-{N}.prompt.json`. The manifest is written before dispatch; the pre-advance gate recomputes the hash and compares it.
- Failure policy: `doctor` and `check-harness` exit non-zero on errors and zero on warnings; `check-workflows` exits non-zero on any invalid transition; `version` never mutates state.
- Tests: add `tests/sdw_harness_diagnostics.test.cjs`. Cover missing config, unresolved token, missing skill reference, broken link, over-budget skill, duplicate block, valid and invalid FSM transitions, batch resume, global and per-step budgets, manifest hash match and mismatch.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Auto-fixing diagnostic findings | Read-only diagnostics preserve operator control |
| Installing or updating skills | Spec 006 owns distribution |
| Live runtime monitoring | Tracked by spec 021 |
| Semantic prompt-quality scoring | Budget and hash checks are deterministic; quality remains a review concern |
| Cross-repository harness audits | Single-repository scope |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Diagnostic posture | Read-only | Safe for CI and pre-ship gates | y |
| Tier-1 budget | 120 lines | Existing repository authoring standard | y |
| Context budget default | 32768 bytes | Matches workflow-skills convention and keeps dispatch bounded | y |
| Per-step floor | 18000 bytes | Prevents an unusably small override | y |
| Prompt manifest location | Run artifact directory beside the prompt | Keeps evidence and dispatch input together | y |
| Duplicate detection | Normalized paragraph hashing | Deterministic and dependency-free | y |
| Missing reference severity | Error | A broken reference makes the skill unreliable | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Skill baseline | All `sdw-*` skills present with valid frontmatter | Run `check-harness` after implementation |
| Router baseline | Router discovery and doctor surfaces inspected | Read `sdw_router.cjs` |
| State baseline | Run state and step statuses inspected | Read `state_manager.cjs` |
| Workspace configuration | `.sdw/config.json` valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | This specification registered as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | This specification passes canonical authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/022-sdw-harness-diagnostics.md` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `doctor --json` returns a list of checks with `status`, `path`, and `message`.
- `version --json` returns `packageVersion`, `installScope`, and the resolved skills root.
- `check-workflows` reports each simulated step with `pass` or `fail` and a reason.
- `check-harness` reports line counts, broken links, duplicate blocks, and frontmatter findings.
- Prompt manifests exist beside each dispatched prompt and contain a matching sha256.
- A manifest mismatch blocks the step with the expected and actual hashes.

### Negative & Failing Test Scenarios

- Missing config: `doctor` exits non-zero and names `.sdw/config.json`.
- Unresolved token: a path containing `{projectRoot}` after resolution fails.
- Missing reference: a `SKILL.md` link to a deleted file fails with the target path.
- Over-budget skill: a 121-line `SKILL.md` is reported as an error.
- Duplicate block: the same normative paragraph in two skills is reported.
- Invalid transition: a simulated step 5 before step 4 fails.
- Manifest mismatch: editing a prompt after manifest creation blocks advancement.
- Missing manifest: a step without a manifest fails the pre-advance gate.
- Batch resume: a queue with a completed first item resumes at the second item.
