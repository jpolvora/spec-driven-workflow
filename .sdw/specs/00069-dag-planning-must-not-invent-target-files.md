---
id: null
localSpecId: "00069"
slug: 00069-dag-planning-must-not-invent-target-files
title: "DAG planning must not invent target files"
source: local
status: draft
specDate: 2026-10-24
priority: high
value: "Removes the invented skills/<slug>/scripts/<slug>.cjs fence that forced host intervention in four batch specs and recurred as a recorded trap"
effort: S
---

# Specification — DAG planning must not invent target files

## Description

DAG planning must never invent a target file that does not exist in the repository, and must refuse a synthesized slice before dispatching work.

`generateRefinementBlueprint` falls back to `skills/${slug}/scripts/${slug}.cjs` when a specification names no path and its slug is not one of the known buckets. That path is a fabrication: it does not exist, no task can satisfy it, and the worker either creates a nonsense file or stops for a fence change. In batch `batch-1792765277156` the planner produced that path for 00033 (task-1), 00065 (task-1), and 00066 (task-1), and 00064 in an earlier attempt, so every one of those runs needed a manual fence correction from the host. The defect is already recorded twice in memory (`dag-planner-invents-slug-shaped-target-file`, `derived-dag-target-files-fall-back-to-slug-template`) and keeps recurring.

### Design Intent

A plan is a promise that the named files can carry the work. A synthesized path cannot be verified, cannot be reviewed, and cannot be trusted, so the planner must draw from the repository's real files, from paths the specification names explicitly, or refuse with an actionable message. Refusal is cheaper than a wasted dispatch round.

## Acceptance Criteria

- AC1: When the blueprint resolves no target file, the system shall not synthesize a path from the specification slug.
- AC2: If a fallback target file does not exist in the repository, then the system shall refuse the plan naming the missing path and the fallback rule that produced it.
- AC3: The system shall accept an explicitly declared new file in the specification (a backticked path under a `New files` note) and carry it into the plan as a target file without requiring it to exist yet.
- AC4: If a specification names no path and declares no new file, then the system shall refuse the plan naming the specification and the declaration the author must add.
- AC5: The system shall report the resolved target files, any declared new file, and the refusal reason in `dag preview --json` output without writing run state.
- AC6: The system shall cover a specification with real backticked paths, one with an explicit new-file declaration, and one with neither, with tests.

## Notes

- Implementation surfaces: `skills/sdw-orch/scripts/spec_grilling.cjs` (`extractTargetFiles`, `generateRefinementBlueprint`), `skills/sdw-orch/scripts/dag_planner.cjs` (plan construction and refusal shape), `skills/sdw-orch/scripts/sdw_orch.cjs` (`dag preview --json` and the Step 3 refusal path), and `tests/sdw_dag_micro.test.cjs` or a new `tests/sdw_dag_target_files.test.cjs`.
- Keep the known real-file buckets (`orch`, `config`, `router`, `spec`) only when every path they return exists; a bucket with a missing path refuses instead of planning.
- A declared new file is a promise, not a check: the criterion coverage rule from spec 00064 still decides whether the slice proves its criteria.
- Refusal must be a plan-level failure with a non-zero exit, consistent with the existing `split-required` and `criteria-uncovered` refusals.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Reworking the complexity classifier | Scope is strictly bounded to target-file resolution |
| Creating missing files during planning | Planning never writes the repository |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| New-file declaration syntax | A `New files` note with backticked paths | Matches the existing path extraction (backticks) | y |
| Refusal over guessing | Refuse when nothing real resolves | A fabricated fence always costs a dispatch round | y |
| Bucket fallbacks | Keep only when every path exists | Real files stay convenient and safe | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Fallback code | `generateRefinementBlueprint` and `inferFallbackTargetFiles` understood | Read both modules |
| Refusal shape | Existing `criteria-uncovered` refusal inspected | Read the Step 3 refusal path and `dag preview --json` |
| Regression baseline | DAG and orchestration suites pass | `node --test tests/sdw_dag_micro.test.cjs tests/sdw_orch.test.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `dag preview --json` lists only real or declared-new target files.
- A refusal prints the missing path, the rule, and the remediation (`name the file in backticks`).
- Step 3 records the refusal reason on the run state and exits non-zero.

### Negative & Failing Test Scenarios

- A pathless specification whose slug is not a known bucket is refused, not planned around `skills/<slug>/scripts/<slug>.cjs`.
- A bucket fallback naming a file that no longer exists is refused.
- A declared new file plans, and spec 00064 coverage still governs its criteria.
