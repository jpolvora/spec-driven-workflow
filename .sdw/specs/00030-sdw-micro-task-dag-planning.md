---
id: "47"
slug: 00030-sdw-micro-task-dag-planning
title: "SDW Complexity-Gated DAG Planning with Split Advisory and Parallelizable Flag"
source: local
status: implemented
specDate: 2026-10-23
priority: high
value: "Replaces the coarse two-task cap with a classifier that emits 1, 2, or 3-5 tasks and refuses oversized specs with a split proposal"
effort: L
---

# Specification — SDW Complexity-Gated DAG Planning with Split Advisory and Parallelizable Flag

## Description

Today `dag_planner.cjs` uses a binary heuristic (`acs.length > 5` or three touchpoints) to emit one task for simple specs and a fixed two-task split for everything else. The Step 4 loop is strictly sequential per spec 00028: `task next` yields one ready task, the host runs one worker, `task finish` accepts it, and the cycle repeats until `resume` runs the gates. The loop is correct but the queue is too coarse: a single worker can own a dozen acceptance criteria, and there is no signal for when a spec is too large or when tasks could run in parallel later.

This specification replaces the deferred opt-in `micro` mode with an automatic complexity-gated planner that analyzes the refined specification from Step 2:

1. `low` complexity produces a single task dispatched through the standard subagent path.
2. `standard` complexity keeps the current two-task foundation-plus-integration split.
3. `complex` complexity decomposes into small tasks with at most four acceptance criteria and three target files each, capped at five tasks.
4. A specification needing more than five tasks is refused with a non-zero exit plus a split proposal naming two or more focused follow-up specifications.
5. Every plan computes file disjointness and records `execMode` with wave levels with parallelizable flags in a `ws-spec-to-pr`-style dependent DAG artifact. Execution stays sequential (flag-only): the flags are observable for preview and state, and dispatch keeps the one-task-at-a-time invariant from spec 00028.

The result is a deterministic plan that stays small for small specs, preserves the current two-task behavior for mid-size specs, fans out only for genuinely complex specs, and fails closed with actionable refactoring guidance instead of silently merging coarse tasks.

### Design Intent

Small tasks buy a smaller worker context per dispatch, evidence mapped to a narrow criterion set, and cheaper recovery through `task abandon`. They cost orchestrator turns. Gating task count on classified complexity keeps the fast path fast while making the fan-out path explicit and bounded. Capping at five bounds dispatch rounds; refusing beyond five enforces the one-feature-per-spec rule instead of recreating coarse tasks through merging. Recording parallelizability without executing in parallel keeps spec 00028 intact while leaving the dependency data a future parallel executor can consume. Grouping stays deterministic: acceptance criteria in declaration order, target files in blueprint order, so the same spec always yields the same DAG.

## Acceptance Criteria

- AC1: The system shall classify every refined specification as low, standard, or complex complexity.
- AC2: When the classifier runs, the system shall consume declared acceptance criteria plus Step 2 blueprint target files.
- AC3: If the acceptance count is four or fewer, then the system shall assign low complexity.
- AC4: If the acceptance count is between five and ten, then the system shall assign standard complexity.
- AC5: If the acceptance count exceeds ten, then the system shall assign complex complexity.
- AC6: If touchpoints reach three while acceptance count reaches seven, then the system shall assign complex complexity.
- AC7: When complexity is low, the system shall emit exactly one task for subagent dispatch.
- AC8: When complexity is standard, the system shall emit exactly two tasks using the foundation-plus-integration split.
- AC9: When complexity is complex, the system shall emit between three and five tasks.
- AC10: When complexity is complex, the system shall order acceptance criteria by declaration order with at most four per task.
- AC11: When complexity is complex, the system shall slice target files by blueprint order with at most three per task.
- AC12: The system shall assign every acceptance criterion to exactly one task.
- AC13: If decomposition needs more than five tasks, then the system shall refuse the plan with a non-zero exit.
- AC14: When the cap refuses a plan, the system shall emit a split proposal naming two focused specifications.
- AC15: When decomposition completes, the system shall compute file disjointness across task pairs.
- AC16: The system shall record execMode with wave levels with parallelizable flags in the DAG plan.
- AC17: While parallelizable tasks exist, the system shall keep one-task-at-a-time dispatch.
- AC18: The system shall record complexity with task count with dependencies with execMode in run state.
- AC19: The system shall provide a dag preview subcommand printing the plan without side effects.
- AC20: When dag preview executes with json flag, the system shall emit task identifiers with dependencies with file lists.
- AC21: When a task is dispatched, the system shall limit its prompt to assigned acceptance criteria.
- AC22: When task finish receives out-of-scope acceptance evidence, the system shall reject the submission.
- AC23: While tasks remain incomplete, the system shall report remaining queue depth in status.
- AC24: The system shall document classifier thresholds with cap behavior in skill docs.
- AC25: The system shall cover classifier with grouping with cap using tests.

## Notes

- This revision supersedes the deferred opt-in `taskGranularity: micro` design. There is no `micro` flag: the classifier selects 1, 2, or 3-5 tasks automatically. `maxTasksPerSpec` is retained with a default of five and bounds two to eight. Trailing-merge behavior is removed; exceeding the cap refuses with a split proposal.
- Implementation surfaces:
  - `skills/sdw-orch/scripts/dag_planner.cjs`: three-tier `analyzeComplexity` (AC count plus touchpoints plus blueprint file surface), 1-task, 2-task, and 3-5-task grouping (AC chunks of four in declaration order, file slices of three in blueprint order), cap refusal plus split proposal, file-disjointness analysis, `execMode` with `levels` with per-task `parallelizable` flags.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: `dag preview [--json] [--spec]` subcommand, classifier plumbing, per-task AC fence in dispatch, evidence AC restriction, `status` queue depth, cap-refusal exit path.
  - `skills/sdw-orch/scripts/implementation_runner.cjs`: prompt rendering honors the task assigned AC subset plus file slice.
  - `skills/sdw-config/scripts/sdw_config.cjs`, `.sdw/config.schema.json`: retire `taskGranularity`, keep `maxTasksPerSpec` with default five.
  - `skills/sdw-orch/SKILL.md`, `references/orchestrator_protocol.md`, `skills/sdw-config/references/config_spec.md`, `README.md`, `FEATURES.md`: classifier thresholds, cap plus split proposal, preview output, flag-only parallel semantics.
  - `tests/sdw_dag_micro.test.cjs` (rename to classifier scope or extend): classifier tiers, grouping, cap refusal, coverage, preview purity, AC-fenced evidence, sequential dispatch with parallel flags present.
- DAG artifact follows the `ws-spec-to-pr` dependent strategy in adapted form: an exec plan plus `dag` node list with `id`, `acIds`, `targetFiles`, `dependencies`, `level`, `parallelizable`, plus top-level `execMode: sequential` and `levels: [[task-ids]]`. `execMode` stays `sequential` in this revision; `parallel` is reserved for a future executor and never dispatched here.
- Example plan for an 11-AC complex specification (deterministic):
  ```json
  {
    "complexity": "complex",
    "execMode": "sequential",
    "taskCount": 3,
    "levels": [["task-1"], ["task-2"], ["task-3"]],
    "tasks": [
      { "id": "task-1", "acIds": ["AC1", "AC2", "AC3", "AC4"], "dependencies": [], "level": 0, "parallelizable": false, "targetFiles": ["a.cjs", "b.cjs", "c.cjs"] },
      { "id": "task-2", "acIds": ["AC5", "AC6", "AC7", "AC8"], "dependencies": ["task-1"], "level": 1, "parallelizable": false, "targetFiles": ["d.cjs", "e.cjs"] },
      { "id": "task-3", "acIds": ["AC9", "AC10", "AC11"], "dependencies": ["task-2"], "level": 2, "parallelizable": false, "targetFiles": ["f.cjs"] }
    ]
  }
  ```
- Example split refusal for a 24-AC specification at cap five: exit non-zero, print `split-required tasks-needed=6 cap=5`, and emit `splitProposal: [{ slug: <orig>-a, acIds: [AC1-AC12] }, { slug: <orig>-b, acIds: [AC13-AC24] }]` with file partitions. `dag preview` shows the same proposal without side effects.
- Dispatch demonstration: `run <spec>` classifies, writes the DAG plan, then `task-1` dispatched (exit 4), host runs one worker, `task finish`, `task-2` dispatched, and so on until the queue is empty and `resume` runs build and test gates, scoring, delivery, review, and PR. Worker rounds equal `taskCount`.
- `dag preview` stays pure: it reads the specification plus configuration, resolves the file blueprint via refinement heuristics, and prints the plan. It never touches `{stateDir}`, `sandboxDir`, git branches, or the specification index.
- No new MCP, network, or runtime dependency. Node.js 22 CommonJS and the standard library only.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Parallel dispatch of multiple tasks | Flag-only revision: disjointness is recorded but spec 00028 sequential dispatch stays authoritative |
| Dynamic re-planning after a failed worker | Recovery stays with `task abandon`; replanning is a separate design |
| Per-task model or provider routing | Vendor coupling and configuration breadth outside this feature |
| Changing scoring, delivery, review, or PR behavior | Steps 5-8 keep their current contracts |
| Automatic promotion from backlog to pending | Promotion stays an explicit operator decision |
| A backlog CLI (`sdw-spec backlog ...`) | The registry is a file; commands are deferred with the rest of the tooling |
| UI or dashboard rendering of the preview | The CLI text and JSON output is sufficient for the experiment |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Classifier inputs | AC count plus touchpoints plus blueprint files | Refined spec plus Step 2 blueprint is the evidence the planner already reads | y |
| Low threshold | Four or fewer ACs | Preserves the current single-task fast path | y |
| Standard band | Five to ten ACs | Preserves the current two-task split for mid-size specs | y |
| Complex threshold | More than ten ACs, or three touchpoints with seven ACs | AC volume drives fan-out; touchpoints escalate dense specs | y |
| Chunk size | Four ACs per complex task | Fits a small worker context while keeping evidence precise | y |
| File slice size | Three target files per complex task | Bounds the scope fence without starving file-heavy tasks | y |
| Task cap | Five tasks per specification | Bounds dispatch rounds; larger specs split by feature | y |
| Cap overflow | Refuse plus split proposal | Fail-closed refactoring guidance instead of silent coarse merging | y |
| Parallel semantics | Flag-only record, sequential execution | Keeps spec 00028 invariant while exposing ws-spec-to-pr-style dependencies | y |
| Preview purity | No state, artifacts, branches, or dispatches | The preview exists to decide whether to run | y |
| Runtime dependencies | Node.js 22 standard library only | Repository policy forbids runtime npm dependencies in packaged skills | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is valid and resolves | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Registered as row `030` with pending status | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` and inspect the row |
| Authoring standard | Specification passes canonical SDW authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00030-sdw-micro-task-dag-planning.md` |
| Planner baseline | Current `dag_planner.cjs` task generation and complexity analysis inspected | Read `skills/sdw-orch/scripts/dag_planner.cjs` |
| Dispatch baseline | Current `task next` and `task finish` loop and AC coverage rules inspected | Read `skills/sdw-orch/scripts/sdw_orch.cjs` |
| Prompt baseline | Current task prompt AC list and scope fence inspected | Read `skills/sdw-orch/scripts/implementation_runner.cjs` |
| Configuration baseline | `maxTasksPerSpec` default and bounds inspected in the schema | Read `.sdw/config.schema.json` |
| Test baseline | Existing `node:test` suite passes before changes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Classifier output, e.g. `[Step 3: DAG] complexity=complex acs=11 tasks=3 execMode=sequential` followed by one line per task: `task-2 | AC5,AC6,AC7,AC8 | deps=task-1 | level=1 | files=d.cjs,e.cjs`.
- `dag preview --json` returns `{ complexity, execMode, taskCount, levels, tasks: [{ id, acIds, targetFiles, dependencies, level, parallelizable }] }` and exits 0.
- Run state records `steps[3].output.dagPlan` with complexity, execMode, taskCount, levels, and per-task acIds plus dependencies.
- Sequential dispatch signal: one `[Step 4: Dispatch] task-N dispatched` line per round, each followed by `awaiting_implementation` and exit code 4, until the queue is empty and `resume` prints the gate run.
- `status` reports `Queue: N remaining` while tasks are incomplete.
- Cap refusal signal: a 24-AC specification at cap five prints `split-required tasks-needed=6 cap=5` with two proposed spec slugs.

### Negative & Failing Test Scenarios

- Cap overflow: a specification needing six tasks at cap five exits non-zero, names the cap, and emits a two-spec split proposal; no plan is written.
- Unknown specification: `dag preview --spec missing.md` exits non-zero and names the path.
- Preview purity: after `dag preview`, no `.sdw/state` file, artifact, branch, or sandbox directory exists; a test asserting any of them fails.
- Coverage gap: a task list omitting one AC, or listing one twice, fails the coverage test.
- Dependency cycle: a plan whose task-1 depends on task-2 fails validation before dispatch.
- Evidence fence: `task finish` for `task-2` with an AC id assigned to `task-3` is rejected and the task stays dispatched.
- Standard mode regression: a seven-AC specification still produces the current two-task foundation-plus-integration plan.
- Registry purity: `dag preview` never changes the specification index row, status, or validation health.
- Parallel flag misuse: dispatching two tasks concurrently fails the sequential-invariant test even when both tasks are marked parallelizable.
