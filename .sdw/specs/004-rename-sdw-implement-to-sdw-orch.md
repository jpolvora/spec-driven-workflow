---
id: null
slug: 004-rename-sdw-implement-to-sdw-orch
title: "Rename sdw-implement to sdw-orch (sdw-orchestrator)"
source: local
specDate: 2026-10-19
---

# Specification — Rename sdw-implement to sdw-orch (sdw-orchestrator)

## Description

The `sdw-implement` orchestrator skill coordinates the end-to-end execution lifecycle of specifications. While "implement" originally reflected task execution, the skill's actual scope is full-pipeline orchestration: specification derivation, grilling decision trees, DAG generation, subagent context fencing, quality conformance scoring, automated code review loops, and pull request preparation.

Renaming the skill to `sdw-orch` (short for `sdw-orchestrator`) aligns the skill's nomenclature with its architectural role. This refactoring includes directory renaming, entrypoint script renaming (`sdw_orch.cjs`), frontmatter alias support (`sdw-orch`, `sdw-orchestrator`, `orch`), and updated test suites. Per AGENTS.md rule 6 (breaking changes encouraged), the old path is removed outright: no wrapper, shim, or dual-support branch is introduced.

### Design Intent

Architectural alignment refactoring for the Spec-Driven Workflow (SDW) initiative. The term "orchestrator" clearly distinguishes top-level workflow coordination from low-level implementation subagents dispatched to write code, avoiding conceptual confusion for agents and human operators.

## Acceptance Criteria

- AC1: The system shall migrate the orchestrator skill directory from `skills/sdw-implement` to `skills/sdw-orch`.
- AC2: When the skill is loaded by an agent, the system shall output `"sdw-orch loaded."` as its canonical announcement header.
- AC3: The system shall support invocation names `sdw-orch`, `sdw-orchestrator`, and `orch` in the skill YAML frontmatter.
- AC4: When executing the CLI entrypoint, the system shall provide the primary and only launcher at `skills/sdw-orch/scripts/sdw_orch.cjs`.
- AC5: The system shall update internal module requires across `state_manager.cjs`, `score_evaluator.cjs`, and helper scripts to reference `sdw-orch`.
- AC6: When test suites execute, the system shall verify orchestrator functionality via `tests/sdw_orch.test.cjs`.
- AC7: The system shall update repository documentation, schema references, and cross-skill specifications to reflect `sdw-orch` as the canonical orchestrator name.
- AC8: If legacy automation still invokes the removed `skills/sdw-implement/` path, then the system shall fail loudly with a standard module-not-found error instead of providing a wrapper.

## Original Issue Context

The user requested renaming `sdw-implement`:

> create another spec to rename sdw-implement skill to sdw-orch (sdw-orchestrator) I think it will make more sense

## Notes

- Renamed directory path: `skills/sdw-orch/`.
- Primary CLI entrypoint: `node skills/sdw-orch/scripts/sdw_orch.cjs [run|resume|status]`.
- Hard break: no `skills/sdw-implement/` directory, wrapper, alias, or deprecation notice remains after migration.
- All submodules (`state_manager.cjs`, `score_evaluator.cjs`) remain in `skills/sdw-orch/scripts/`.
- Configuration keys in `.sdw/config.json` remain decoupled from skill names (`scoreMin`, `specsDir`, `stateDir`, `scmCodeReviewEnabled`, `autoResolveGaps`).
- All automation scripts must be implemented in Node.js 22 CommonJS (`.cjs`) using standard library modules only (`fs`, `path`, `process`, `child_process`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Modifying the 8-step orchestrator state machine logic | This specification is strictly a structural nomenclature and path migration |
| Changing state file format or location (`.sdw/state/{runId}.state.json`) | State isolation schema remains unchanged |
| Introducing breaking changes to subagent context fencing | Subagent dispatch mechanism remains identical |
| Legacy `sdw-implement` wrapper, alias, or deprecation shim | Breaking changes are encouraged in the current phase (AGENTS.md rule 6); the old path is removed, not wrapped |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Canonical skill folder name | `sdw-orch` | Short, expressive, and ergonomic for CLI and path navigation | y |
| Full formal name alias | `sdw-orchestrator` | Included in `invocation_names` for explicit agent invocation | y |
| Migration strategy | Hard break with no wrapper or alias | AGENTS.md rule 6 encourages breaking changes to keep the project concise | y |
| Test suite rename | `tests/sdw_orch.test.cjs` | Keeps test file naming aligned with the skill name | y |
| Absent lifecycle dimensions | N/A because execution is local CLI/agent tool invocation | Local agent execution model | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Source skill directory | `skills/sdw-implement/` exists with passing tests | Run `npm test` |
| Git repository state | Workspace is a valid Git repository with clean tree | Run `git status` check |
| Spec format validator script | Validator script available in host environment | Verify `validate_spec.cjs` runs cleanly |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Skill load output verifies: `sdw-orch loaded.`.
- CLI invocations of `sdw_orch.cjs` display `[sdw-orch]` log prefixes.
- Test runner output confirms passing tests under `tests/sdw_orch.test.cjs`.

### Negative & Failing Test Scenarios

- Removed path invocation: invoking `node skills/sdw-implement/scripts/sdw_implement.cjs` after migration must fail loudly with a module-not-found error.
- Obsolete state file rejection: resuming a run state file created before the rename is unsupported and must fail with a clear error instead of silently migrating.
- Direct path verification: attempting to run tests against deleted or non-existent old paths must fail cleanly in CI.
