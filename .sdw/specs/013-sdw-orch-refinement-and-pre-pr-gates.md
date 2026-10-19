---
id: null
slug: 013-sdw-orch-refinement-and-pre-pr-gates
title: "SDW Orchestrator Refinement Step & Pre-PR Verification Gates"
source: local
specDate: 2026-10-19
---

# Specification — SDW Orchestrator Refinement Step & Pre-PR Verification Gates

## Description

The Spec-Driven Workflow (SDW) orchestrator (`sdw-orch`) coordinates end-to-end feature delivery through an 8-step pipeline. In the current implementation, Step 2 is titled "Grilling" and focuses strictly on adversarial decision-gap interrogation, while Step 3 ("DAG Generation") is forced to infer target files and task decomposition using heuristic regex patterns over the spec text. Furthermore, Step 8 ("PR Preparation & Remote Push") assumes that passing conformance scoring (Step 5) and code review (Step 7) is sufficient to create and push a Pull Request, lacking configurable build verification, comprehensive test execution, and project-specific pre-PR requirements.

This specification introduces three major enhancements to `sdw-orch` and `.sdw/config.json`:

1. **Evolution of Step 2 into "Refinement" (Grilling + Technical Planning):**
   - Step 2 is canonically renamed from `grilling` to `refinement`.
   - It formally merges adversarial gap analysis (walking decision trees for bounds, errors, concurrency, state persistence) with constructive technical planning (mapping affected files, defining architectural interfaces, and outlining test strategies).
   - Step 2 outputs a structured technical blueprint (`step[2].output = { gapsResolved: [...], blueprint: { targetFiles: [...], architecturalApproach: "...", testPlan: "..." } }`) that is directly ingested by Step 3 (`dag_planner.cjs`), eliminating heuristic guessing in DAG task construction.

2. **Configurable Pre-PR Quality Gates in Step 8 (Build Verification & Full Test Pass):**
   - Step 8 introduces opt-in verification passes before allowing delivery commit push and PR creation:
     - `requiredBuild` (boolean, default: `false`): when enabled, executes a project build command (default: `npm run build` or `buildCommand`).
     - `runAllTests` (boolean, default: `false`): when enabled, executes the full test suite (default: `npm test` or `testCommand`).
   - If both flags are `false`, these verification steps are bypassed cleanly.
   - If enabled and a build or test fails, the orchestrator triggers an automated surgical fix loop (up to a bounded iteration limit, default 3).
   - Any fix commit created during this loop must pass security secret leak checks before being committed.
   - If failures cannot be resolved within the iteration limit, the workflow halts with a non-zero exit code and persists the failure state to `.sdw/state/{runId}.state.json`, prohibiting remote push or PR assembly.

3. **Project-Specific Pre-PR Instructions & Lifecycle Hook:**
   - Supports optional project-specific pre-PR instructions and automation defined in `AGENTS.md`, workspace rules, or configured via `prePrInstructions` and `prePrCommand`.
   - Enables teams to enforce bespoke pre-submission tasks (such as semantic version bumps in `package.json`, updating changelogs, or synchronizing documentation).
   - The orchestrator validates that pre-PR requirements are satisfied before marking the specification ready for PR creation, committing any generated changes safely under secret leak inspection.

### Design Intent

Preserves high developer velocity while providing ironclad delivery guarantees. By consolidating grilling and technical planning into a unified Refinement phase, the orchestrator produces high-fidelity task inputs for subagent dispatch without adding step-count overhead. By providing configurable build, test, and pre-PR gates in Step 8, projects can enforce repository-level quality bars deterministically without hardcoding agent behavior or requiring proprietary CI services.

## Acceptance Criteria

- AC1: The system shall designate Step 2 of the orchestrator workflow as "Refinement", merging adversarial grilling with constructive technical planning.
- AC2: When Step 2 executes, the system shall record a structured refinement output in run state containing resolved decision gaps and a technical blueprint with target files, architectural approach, and verification strategy.
- AC3: When Step 3 generates DAG tasks, the system shall ingest the technical blueprint from Step 2 to determine target files and task decomposition.
- AC4: The system shall support `requiredBuild` (boolean, default `false`) and `runAllTests` (boolean, default `false`) properties in `.sdw/config.json`.
- AC5: Where `requiredBuild` is set to `true`, the system shall execute the configured build command as a mandatory prerequisite in Step 8 before creating the PR or pushing to remote.
- AC6: Where `runAllTests` is set to `true`, the system shall execute the configured test command as a mandatory prerequisite in Step 8 before creating the PR or pushing to remote.
- AC7: While `requiredBuild` and `runAllTests` are both set to `false`, the system shall skip build and test verification in Step 8.
- AC8: If a build or test execution fails during Step 8 verification, then the system shall attempt automated surgical fixes up to a configured iteration limit.
- AC9: When an automated fix is applied during Step 8 verification, the system shall perform a secret leak check before creating the fix commit.
- AC10: If build or test verification failures persist after the maximum fix attempts, then the system shall halt execution, record the failure in the run state, and prohibit PR creation and remote push.
- AC11: Where project-specific pre-PR instructions or commands are configured, the system shall execute and verify the pre-PR requirements before marking the run ready for PR submission.
- AC12: When pre-PR instructions modify project files, the system shall stage the changes, verify secret leak safety, and include them in the delivery commit.
- AC13: The system shall register `requiredBuild`, `runAllTests`, `buildCommand`, `testCommand`, `prePrInstructions`, and `prePrCommand` in `.sdw/config.schema.json` and validate them in `sdw-config`.
- AC14: While executing Step 8 without remote push flags, the system shall evaluate the pre-PR gates and report readiness status without pushing to remote.

## Original Issue Context

The specification originated from the user requirement:

> create a spec to make these improvements into the workflow sdw-orch: rename step 2 to refinement as grilling+planning enforced and producing an output better ingestable for the step 3 dag. in the same spec, make step 8 optionally executing if configured in config.json an additional build verification and test execution pass as pre-requisites as condition to allow advancing to create and push the PR. Add and update config.json and schema file : requiredBuild: false for default, runAllTests: false by default. If tests fail or build fail when enabled, try to fix what is broken and commit again (checking security secreat leaks like always on every commit requires). If build and test are false, this steps can be skipped. Also add a optional customization of a pre-pr instructions specifics for the project if exists. The agent should determine/infer from context/AGENTS.md/rules/project specific intructions the necessary checks before ready for PR. For example, bump version of product, update some file, etc. In my example, I will let it explicit in AGENTS.md: before submiting a PR, ensure pre-checks pass - increment version in package.json, etc let this for the user decide.

## Notes

- Configuration Schema Additions (`.sdw/config.json`):
  ```json
  {
    "requiredBuild": false,
    "buildCommand": "npm run build",
    "runAllTests": false,
    "testCommand": "npm test",
    "prePrCommand": "",
    "prePrInstructions": ""
  }
  ```
  - `skills/sdw-config/scripts/sdw_config.cjs`: update `DEFAULT_CONFIG`, `DEFAULT_SCHEMA`, and validation rules for the new properties.
  - `.sdw/config.schema.json`: define property types, defaults, and descriptions.
  - `skills/sdw-config/references/config_spec.md`: document new settings in reference tables.

- Step 2 Refinement Blueprint Schema:
  ```json
  {
    "name": "refinement",
    "status": "completed",
    "output": {
      "hasGaps": false,
      "gaps": [],
      "blueprint": {
        "targetFiles": [
          "skills/sdw-orch/scripts/sdw_orch.cjs",
          "skills/sdw-orch/scripts/dag_planner.cjs"
        ],
        "architecturalApproach": "Consolidate grilling and technical planning in Step 2; inject blueprint into Step 3 DAG generation.",
        "testPlan": "Execute unit test suite validating Refinement schema and Step 8 pre-PR build/test verification."
      }
    }
  }
  ```

- Step 8 Pre-PR Execution Lifecycle & Delegation:
  - Per specification `024-sdw-ship-pr`, Step 8 of `sdw-orch` delegates pre-PR verification gates and delivery submission directly to `sdw-ship-pr`.
  1. Evaluate `prePrCommand` / project-specific instructions from `AGENTS.md` (e.g. version bump). If files are touched, scan for secret leaks and stage changes.
  2. If `requiredBuild: true`, execute `buildCommand`. On error, trigger fix loop (max 3 iterations).
  3. If `runAllTests: true`, execute `testCommand`. On error, trigger fix loop (max 3 iterations).
  4. Ensure every fix commit undergoes secret leak scanning.
  5. If all gates pass, assemble PR metadata and execute push to remote origin.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic CI/CD pipeline authoring | External CI configuration is managed by platform integrations (e.g. GitHub Actions spec 011), not local orchestrator |
| Mandatory build enforcement on non-build projects | Interpreted or script-only repositories must not be forced to define a build command; default remains `false` |
| Interactive terminal debugging during build failures | The fix loop is autonomous and non-interactive; persistent failures halt for operator intervention |
| Enforcing a rigid global version bumping schema | Versioning conventions (SemVer, CalVer, custom) remain entirely project-controlled via `AGENTS.md` or `prePrCommand` |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Step 2 naming | `refinement` | Represents both the process (grilling + planning) and the quality milestone | y |
| Default build command | `npm run build` | Standard Node.js convention; overridable via `buildCommand` | y |
| Default test command | `npm test` | Standard Node.js convention; overridable via `testCommand` | y |
| Build & test default state | `false` | Zero disruption for lightweight projects; opt-in for enterprise or compiled repositories | y |
| Maximum fix iterations | 3 | Prevents infinite retry loops on fundamentally broken builds or tests | y |
| Pre-PR instruction source | `prePrInstructions`, `prePrCommand`, and `AGENTS.md` context | Maximizes agent adaptability while preserving deterministic command anchors | y |
| Secret leak verification | Mandatory on all fix commits | Adheres to repository security invariant that no secret leaks may enter VCS | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature is tracked in `.sdw/specs/index.specs.md` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification adheres to canonical SDW standard and EARS syntax | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/013-sdw-orch-refinement-and-pre-pr-gates.md` |
| Orchestrator baseline | `sdw-orch` provides existing 8-step state machine | Inspect `skills/sdw-orch/scripts/sdw_orch.cjs` |
| DAG planner baseline | `dag_planner.cjs` accepts options for target files | Inspect `skills/sdw-orch/scripts/dag_planner.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Step 2 console output displaying: `[Step 2: Refinement] Refinement complete. Blueprint generated for N target files.`.
- Run state `.sdw/state/{runId}.state.json` recording `steps["2"].name = "refinement"` and containing `blueprint` object with `targetFiles`.
- Step 3 console output displaying ingestion of blueprint target files into DAG tasks.
- Step 8 console output displaying: `[Step 8: Pre-PR Verification] Running build check: <buildCommand>` and `[Step 8: Pre-PR Verification] Running test suite: <testCommand>`.
- Skip notices when verification is disabled: `[Step 8: Pre-PR Verification] Build and test verification skipped (requiredBuild: false, runAllTests: false).`.
- Telemetry recording pre-PR instruction execution and version bump commits in the git log.

### Negative & Failing Test Scenarios

- Invalid configuration types: setting `requiredBuild: "yes"` (string instead of boolean) causes `sdw_config.cjs check` to fail validation with exit code 1.
- Failing build with retry exhaustion: when `requiredBuild: true` and the build script continuously exits code 1, the orchestrator attempts 3 fix iterations, persists unrecoverable error state, and halts without pushing to remote.
- Failing test suite blocking PR: when `runAllTests: true` and tests fail, the orchestrator refuses to publish delivery commits or create PR until tests pass.
- Secret leak detected in fix commit: if an automated fix inadvertently introduces an API key or token, the security leak check rejects the commit and aborts before VCS write.
- Missing blueprint in Step 2: if Step 2 output lacks a blueprint object, Step 3 falls back gracefully to heuristic complexity analysis while logging an observable warning.
