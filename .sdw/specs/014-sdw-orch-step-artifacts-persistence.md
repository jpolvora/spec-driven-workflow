---
id: null
slug: 014-sdw-orch-step-artifacts-persistence
title: "SDW Orchestrator Step Artifacts Persistence"
source: local
specDate: 2026-10-19
---

# Specification — SDW Orchestrator Step Artifacts Persistence

## Description

The Spec-Driven Workflow orchestrator (`sdw-orch`) executes an 8-step pipeline: derivation, grilling/refinement, DAG generation, implementation dispatch, conformance scoring, delivery commit, code review, and PR preparation. Today, the meaningful intermediate outputs of steps 2, 3, and 5 are effectively transient: the refinement result (the effective spec content after decision-gap resolution) exists only in memory during the run, while the DAG plan and the conformance score report are persisted only as JSON fragments inside `.sdw/state/{runId}.state.json`, which is machine-oriented and hard to inspect. After a run, operators cannot determine or check what the grilling/refinement derived from the spec, which tasks the DAG produced, or how a conformance score was justified.

This specification introduces per-step artifact persistence for the three human-auditable steps:

1. **Step 2 (grilling/refinement) — refinement result artifact:** a Markdown file documenting the decision gaps detected, the resolution applied per gap, the decision tree walk summary, and the refined spec content snapshot derived from the input spec.
2. **Step 3 (DAG generation) — DAG artifact:** a Markdown file documenting the complexity analysis, the full task decomposition (dependencies, covered acceptance criteria, target files), and the per-task context prompts generated for implementation dispatch.
3. **Step 5 (conformance scoring) — preliminary implementation report artifact:** a Markdown file summarizing what was done (prepared tasks, touched files) and explaining the score (verified and failing acceptance criteria, coverage, threshold, feedback).

Artifact persistence rules:

- **Directory layout:** each workflow run persists its own artifacts in its own directory, `{stateDir}/{slug}/{runId}/`, where `{stateDir}` is the resolved SDW state directory, `{slug}` is the specification slug, and `{runId}` is the orchestrator run identifier.
- **Filename convention:** `{slug}-step-{N}.md`, derived from the specification slug including its 3-digit numeric prefix (e.g. `014-sdw-orch-step-artifacts-persistence-step-2.md`).
- **State linkage:** when an artifact file is written, the run state file is updated to record the run artifact directory and the artifact path for the corresponding step, so artifacts remain discoverable from state.
- **Scope:** only steps 2, 3, and 5 emit artifacts. Step 1 is excluded because its input and output already exist as the specification file; steps 4, 6, 7, and 8 remain unchanged in this iteration.

### Design Intent

Make execution auditable without altering pipeline control flow or step semantics. Artifacts are evidence written as a deterministic side effect of steps 2, 3, and 5, rendered from the exact data those steps already compute (no inference, no re-computation, no additional model calls). The run state remains the machine source of truth for orchestration, while artifacts are the human view; each artifact is referenced from state so the two views cannot silently drift. Per-run directories preserve evidence across repeated executions of the same specification, and the `.sdw/state/` location keeps artifacts local and ephemeral, consistent with the existing convention that run state is never committed to product git.

## Acceptance Criteria

- AC1: The system shall persist run artifacts in the directory `{stateDir}/{slug}/{runId}/`, where `{stateDir}` is the resolved SDW state directory, `{slug}` is the specification slug, and `{runId}` is the orchestrator run identifier.
- AC2: When Step 2 (grilling/refinement) completes, the system shall write a refinement result artifact named `{slug}-step-2.md` containing the detected decision gaps, the resolution applied per gap, the decision tree walk summary, and the refined spec content snapshot.
- AC3: When Step 3 (DAG generation) completes, the system shall write a DAG artifact named `{slug}-step-3.md` containing the complexity analysis, the task decomposition with dependencies, covered acceptance criteria, target files, and per-task context prompts.
- AC4: When Step 5 (conformance scoring) completes, the system shall write a preliminary implementation report artifact named `{slug}-step-5.md` containing the implementation summary and the conformance score explanation.
- AC5: The system shall derive each artifact filename as `{slug}-step-{N}.md` from the specification slug recorded in the run state including its 3-digit numeric prefix.
- AC6: When a step artifact file is written, the system shall update the run state file to record the run artifact directory and the artifact path of the corresponding step.
- AC7: The system shall record artifact paths in run state relative to the project root using forward slashes.
- AC8: While resuming an existing run, the system shall reuse the same artifact directory that the run state records.
- AC9: If a step within scope is re-executed within the same run, then the system shall overwrite its existing artifact file with the updated content.
- AC10: If artifact persistence fails, then the system shall record the failure in the run state error list and continue workflow execution without changing run status.
- AC11: While a step is skipped or not executed, the system shall not create or modify an artifact file for that step.
- AC12: The system shall restrict step artifact persistence to Step 2, Step 3, and Step 5 of the 8-step pipeline.
- AC13: Where a step artifact is written, the system shall include a metadata header with the run identifier, specification slug, step number and name, status, and generation timestamp.
- AC14: The system shall document the artifact directory layout, filename convention, state fields, and failure policy in the `sdw-orch` skill documentation and the orchestrator protocol reference.

## Notes

- Implementation surfaces:
  - `skills/sdw-orch/scripts/artifact_writer.cjs` (new helper): deterministic Node.js CommonJS renderer that composes and writes the three step artifacts and returns their project-relative paths. Node standard library only.
  - `skills/sdw-orch/scripts/state_manager.cjs`: artifact path resolution for `{stateDir}/{slug}/{runId}/` and run state schema support for the `artifactsDir` and per-step `artifact` fields.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: invoke artifact persistence immediately after Step 2, Step 3, and Step 5 complete, before finalizing their state updates.
  - `skills/sdw-orch/SKILL.md` and `skills/sdw-orch/references/orchestrator_protocol.md`: document the artifact layout, naming convention, state fields, and failure policy.
  - `.sdw/directory-structure.md`: reflect the per-run artifact directories under the state folder.
- Run state schema additions (example):
  ```json
  {
    "specSlug": "014-sdw-orch-step-artifacts-persistence",
    "artifactsDir": ".sdw/state/014-sdw-orch-step-artifacts-persistence/run-1792400000000-014-sdw-orch-step-artifacts-pe",
    "steps": {
      "2": {
        "status": "completed",
        "artifact": ".sdw/state/014-sdw-orch-step-artifacts-persistence/run-1792400000000-014-sdw-orch-step-artifacts-pe/014-sdw-orch-step-artifacts-persistence-step-2.md"
      }
    }
  }
  ```
- Artifact content templates (canonical sections):
  - Step 2 (`{slug}-step-2.md`): metadata header; `## Decision Gaps & Resolutions` table (dimension | question | resolution | source); `## Decision Tree Walk` summary (dimensions checked, covered, gaps resolved); `## Refined Spec Snapshot` containing the full effective spec content after decisions were applied.
  - Step 3 (`{slug}-step-3.md`): metadata header; `## Complexity Analysis` (level, acceptance criteria count, touchpoints); `## Task Decomposition` table (task id | title | dependencies | covered ACs | target files); `## Task Context Prompts` with one fenced subsection per task containing the dispatch prompt.
  - Step 5 (`{slug}-step-5.md`): metadata header; `## Implementation Summary` (prepared tasks, target and touched files); `## Conformance Score` (score, threshold, pass or fail, verified and failing counts); `## Verified Acceptance Criteria` table; `## Failing Acceptance Criteria` table with missing keywords; `## Feedback` with the evaluator feedback text.
- Execution order within each in-scope step: create the run artifact directory, write the artifact file, then update run state with the artifact path as part of the step completion update.
- Failure policy: artifact persistence is best-effort. On failure, append an entry prefixed `Artifact persistence warning:` to the run state error list, print a console warning, and continue the workflow without changing run status.
- Overwrite policy: artifact files are content-stable per (slug, runId, step); a re-executed step in the same run rewrites the same file deterministically.
- The artifact directory is derived from the resolved state directory (`stateDir` in `.sdw/config.json`, default `.sdw/state`), preserving configurability.
- Artifacts remain untracked by git via the existing `.sdw/state/*` ignore rule; they are local execution evidence, matching the ephemeral run state convention.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Artifact persistence for steps 1, 4, 6, 7, and 8 | Scope is explicitly limited to the three human-auditable steps (2, 3, 5) requested; Step 1 input already exists as the spec file |
| Committing artifacts to product git | `.sdw/state/*` is git-ignored ephemeral execution evidence; artifacts follow the same local-only convention |
| Artifact retention policy or cleanup automation | Existing run state files have no TTL; retention follows current conventions |
| Real-time artifact streaming or UI viewer for runs | Out of scope for this iteration; artifacts are inspectable as plain Markdown files |
| Changes to step semantics, scoring algorithm, or DAG heuristics | Artifacts are a read-only projection of existing step outputs |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Artifact directory layout | `{stateDir}/{slug}/{runId}/` | User-confirmed: per-run isolation prevents cross-run overwrites and preserves evidence across repeated executions | y |
| Artifact step coverage | Steps 2, 3, and 5 only | User-confirmed: the three steps whose outputs were previously opaque | y |
| Filename convention | `{slug}-step-{N}.md` | User-specified derivation from the spec slug including the NNN prefix | y |
| Artifact format | Human-readable Markdown generated deterministically | Matches SDW documentation conventions and supports diff review | y |
| State linkage fields | Run-level `artifactsDir` plus per-step `artifact` | Minimal schema addition that makes artifacts discoverable from state | y |
| Overwrite policy | Re-executed step in the same run overwrites its artifact | Same run is one evidence unit; deterministic rewrite avoids duplicates | y |
| Persistence failure policy | Warn, append to run state errors, continue run | Evidence failure must not block delivery while remaining observable | y |
| Git tracking | Not tracked; `.sdw/state/*` ignore rule applies | Preserves ephemeral local-evidence convention | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` initialized and valid with resolved `stateDir` | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature registered in `.sdw/specs/index.specs.md` as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification passes canonical SDW authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/014-sdw-orch-step-artifacts-persistence.md` |
| Orchestrator baseline | 8-step pipeline exists with Steps 2, 3, and 5 producing computable outputs | Inspect `skills/sdw-orch/scripts/sdw_orch.cjs` |
| State manager baseline | Run state lifecycle managed by `state_manager.cjs` with per-step output storage | Inspect `skills/sdw-orch/scripts/state_manager.cjs` |
| Runtime baseline | Node.js 22 standard library available; no runtime npm dependencies required | Execute artifact helper via `node` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output for each artifact write, e.g. `[Step 2: Grilling] Artifact written to .sdw/state/{slug}/{runId}/{slug}-step-2.md`.
- Run state file contains `artifactsDir` and `steps["2" | "3" | "5"].artifact` values after the respective steps complete.
- The three artifact Markdown files exist on disk under `.sdw/state/{slug}/{runId}/` once the run reaches Step 5.
- The step-2 artifact enables post-run inspection of the refined spec content without re-executing the workflow.

### Negative & Failing Test Scenarios

- Artifact write failure on a read-only artifact directory: the run logs a warning, appends an `Artifact persistence warning:` entry to the run state errors list, and continues without changing run status.
- Absence on unexecuted steps: a run resumed from Step 6 does not create new artifacts for the already-completed Steps 2, 3, and 5.
- Re-execution within the same run (score loop): Step 5 rewrites the existing `{slug}-step-5.md` file deterministically instead of creating duplicates.
- Skipped step scenario: a run where a step is marked `skipped` produces no artifact file for that step.
