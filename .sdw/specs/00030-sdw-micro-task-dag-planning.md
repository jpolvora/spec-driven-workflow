---
id: null
slug: 00030-sdw-micro-task-dag-planning
title: "SDW Micro-Task DAG Planning and Sequential Dispatch Preview"
source: local
status: awaiting-approval
specDate: 2026-10-20
priority: high
value: "Replaces the two-task DAG cap so large specifications stop shipping as two giant tasks"
effort: L
---

# Specification — SDW Micro-Task DAG Planning and Sequential Dispatch Preview

## Description

Today `dag_planner.cjs` emits at most two tasks for a complex specification — one "core logic" task and one "workflows, verification & PR integration" task — and one task for a simple specification. The dispatch loop in Step 4 is already strictly sequential: `task next` yields one ready task, the host runs one worker, `task finish` accepts it, and the cycle repeats until the queue is exhausted and `resume` runs the gates. That loop is correct, but the queue is too coarse to observe it. A single worker can own a dozen acceptance criteria and a wide file surface, so the run looks like one large turn with two pauses instead of a pipeline of small, reviewable deliveries.

This specification introduces an **opt-in micro-task planning mode** plus a read-only **DAG preview**:

1. `taskGranularity: "micro"` decomposes a specification into several small, linearly dependent tasks (target: at most four acceptance criteria and three target files per task).
2. `maxTasksPerSpec` caps the queue (default 8) and merges trailing tasks instead of dropping criteria.
3. `dag preview --spec <path>` renders the plan — task ids, titles, AC ids, target files, dependencies — without creating state, artifacts, branches, or dispatches.
4. The existing sequential dispatch contract is unchanged: one active task, `task next` until exhausted, then `resume` for gates, scoring, delivery, review, and PR.

The result is a visible DAG of small tasks that drives the orchestrator through several sequential worker rounds. The feature is **registered in the backlog**: it is implementable with the current architecture, but the extra planner heuristics, configuration surface, and dispatch rounds are not justified while SDW optimizes for the shortest deterministic path. It is tracked here so the design is ready if specifications grow.

### Design Intent

Small tasks buy three things: a smaller worker context per dispatch, evidence that maps to a narrow criterion set, and cheaper recovery when one worker fails. They cost more orchestrator turns and more user checkpoints. Making the mode opt-in keeps the current two-task default untouched, while `dag preview` makes the plan observable before any state is written, which is the missing piece for judging whether micro-granularity is worth it on a real specification. Grouping is deterministic — acceptance criteria are consumed in declaration order in chunks of four, target files are sliced in blueprint order — so the same specification always yields the same DAG and tests can assert the exact task list.

## Acceptance Criteria

- AC1: The system shall add `taskGranularity` to `.sdw/config.json` with the values `standard` and `micro`.
- AC2: The system shall default `taskGranularity` to `standard` when the key is absent.
- AC3: When `taskGranularity` is `micro`, the system shall decompose the specification into tasks of at most four acceptance criteria each.
- AC4: When `taskGranularity` is `micro`, the system shall assign at most three target files to each task.
- AC5: When `taskGranularity` is `micro`, the system shall order tasks linearly so each task depends only on the immediately preceding task.
- AC6: The system shall assign every acceptance criterion to exactly one micro task.
- AC7: If a specification has four or fewer acceptance criteria, then the system shall emit a single task regardless of granularity.
- AC8: The system shall add `maxTasksPerSpec` to `.sdw/config.json` with a default of eight.
- AC9: If micro decomposition would exceed `maxTasksPerSpec`, then the system shall merge trailing tasks until the task count is within the cap.
- AC10: If merging would leave a task with more than six acceptance criteria, then the system shall reject the plan with a non-zero exit code.
- AC11: The system shall record `dagPlan.mode`, `dagPlan.taskCount`, and each task's `acIds` in run state.
- AC12: The system shall provide a `dag preview --spec <path>` subcommand.
- AC13: When `dag preview` executes, the system shall print the plan without creating run state, artifacts, branches, or dispatches.
- AC14: When `dag preview --json` executes, the system shall emit the task list with id, title, acceptance criteria, target files, and dependencies.
- AC15: If the specification cannot be resolved, then the system shall exit `dag preview` with a non-zero code and a message naming the path.
- AC16: If the specification is registered in the backlog, then the system shall render its plan read-only during `dag preview` without changing its registry row.
- AC17: When a micro plan is executed, the system shall keep the one-task-at-a-time dispatch invariant.
- AC18: When a micro task is dispatched, the system shall limit its prompt to the task's acceptance criteria and target files.
- AC19: When `task finish` accepts a micro task, the system shall reject evidence whose acceptance criteria are outside the task's assigned set.
- AC20: While micro tasks remain incomplete, the system shall report the remaining queue depth in `status`.
- AC21: The system shall document granularity, the task cap, preview output, and dispatch behavior in the skill documentation and orchestrator protocol.
- AC22: The system shall cover grouping, cap merging, criteria coverage, preview purity, and sequential dispatch with tests.

## Notes

- **Status: deferred.** This specification is registered in the backlog (`.sdw/specs/index.specs.md`) and is not scheduled for implementation. Do not execute it without an explicit implementation order.
- Why backlog: the current two-task planner is deliberately simple and fast; micro-granularity multiplies dispatch rounds, adds two configuration keys and grouping heuristics, and requires prompt/evidence plumbing for per-task AC fences. The design is sound but the cost/benefit does not clear the project's simplicity bar today. Revisit when (a) specifications routinely exceed ~15 acceptance criteria, or (b) worker context or evidence precision becomes the bottleneck.
- Implementation surfaces:
  - `skills/sdw-orch/scripts/dag_planner.cjs`: `micro` grouping (AC chunks of 4, file slices of 3), linear dependencies, cap merging, `dagPlan.mode`/`taskCount`.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: `dag preview` subcommand, granularity config plumbing, per-task AC fence in dispatch, evidence AC restriction, `status` queue depth.
  - `skills/sdw-orch/scripts/implementation_runner.cjs`: prompt rendering honors the task's assigned AC subset.
  - `skills/sdw-config/scripts/sdw_config.cjs`, `.sdw/config.schema.json`: `taskGranularity` enum, `maxTasksPerSpec` bounds (2–16, default 8).
  - `skills/sdw-orch/SKILL.md`, `references/orchestrator_protocol.md`, `skills/sdw-config/references/config_spec.md`, `README.md`, `FEATURES.md`: preview output, granularity, and the deferred registration.
  - `tests/sdw_dag_micro.test.cjs`: grouping, cap merge, coverage, preview purity, AC-fenced evidence, dispatch order.
- Example plan for a 14-AC specification in `micro` mode (deterministic):
  ```json
  {
    "mode": "micro",
    "taskCount": 4,
    "tasks": [
      { "id": "task-1", "acIds": ["AC1", "AC2", "AC3", "AC4"], "dependencies": [], "targetFiles": ["a.cjs", "b.cjs", "c.cjs"] },
      { "id": "task-2", "acIds": ["AC5", "AC6", "AC7", "AC8"], "dependencies": ["task-1"], "targetFiles": ["d.cjs", "e.cjs"] },
      { "id": "task-3", "acIds": ["AC9", "AC10", "AC11", "AC12"], "dependencies": ["task-2"], "targetFiles": ["f.cjs"] },
      { "id": "task-4", "acIds": ["AC13", "AC14"], "dependencies": ["task-3"], "targetFiles": [] }
    ]
  }
  ```
- Dispatch demonstration (the point of the feature): `run <spec>` → `task-1` dispatched (exit 4) → host runs one worker → `task finish` → `task-2` dispatched → … → `task-4` accepted → `resume` runs build/test gates, scoring, delivery, review, and PR. The number of worker rounds equals `taskCount`.
- `dag preview` must be pure: it reads the specification and configuration, resolves the file blueprint via the refinement heuristics, and prints the plan. It must not touch `{stateDir}`, `sandboxDir`, git branches, or the specification index.
- Deferral is registry data plus prose in this spec: the index row records the file, and no lifecycle status or execution gate is added. `sdw-orch run` starts only on an explicit implementation order (AGENTS.md rule 8); `sdw-spec archive` still requires `completed`.
- `maxTasksPerSpec` merging: when `ceil(AC_count / 4) > cap`, trailing chunks are merged pairwise until the count fits; a merged chunk above six ACs is an error rather than a silent loss of granularity.
- No new MCP, network, or runtime dependency. Node.js 22 CommonJS and the standard library only.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Parallel dispatch of multiple micro tasks | The one-task-at-a-time invariant is the contract this feature must expose, not replace |
| Dynamic re-planning after a failed worker | Recovery already exists through `task abandon`; replanning is a separate design |
| Per-task model or provider routing | Vendor coupling and configuration breadth outside this feature |
| Changing scoring, delivery, review, or PR behavior | Steps 5–8 keep their current contracts |
| Automatic promotion from backlog to pending | Promotion stays an explicit operator decision |
| A backlog CLI (`sdw-spec backlog ...`) | The registry is a file; commands are deferred with the rest of the feature |
| UI or dashboard rendering of the preview | The CLI text/JSON output is sufficient for the experiment |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Granularity mode | Opt-in `micro`; `standard` unchanged | Keeps current speed as the default and makes the experiment reversible | y |
| Chunk size | Four acceptance criteria per task | Fits a small worker context while keeping AC evidence precise | y |
| File slice size | Three target files per task | Bounds the scope fence without starving tasks that touch many files | y |
| Dependency shape | Linear chain | Deterministic, trivially acyclic, and matches sequential dispatch | y |
| Task cap | Eight tasks per specification | Bounds dispatch rounds; most specs stay below it | y |
| Merge ceiling | Six ACs per merged task | Prevents the cap from recreating a coarse two-task plan silently | y |
| Preview purity | No state, artifacts, branches, or dispatches | The preview exists to decide whether to run | y |
| Deferred execution | Blocked by process, not tooling: only an explicit user order starts a run | The spec is registered for reference; implementation authorization is separate (AGENTS.md rule 8) | y |
| Deferral persistence | The registry row and this spec stay unchanged by `sync` | Re-validation must not schedule or promote deferred work | y |
| Runtime dependencies | Node.js 22 standard library only | Repository policy forbids runtime npm dependencies in packaged skills | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is valid and resolves | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Registered in the backlog (`.sdw/specs/index.specs.md`) as row `030` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` and inspect the row |
| Authoring standard | Specification passes canonical SDW authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00030-sdw-micro-task-dag-planning.md` |
| Planner baseline | Current `dag_planner.cjs` task generation and complexity analysis inspected | Read `skills/sdw-orch/scripts/dag_planner.cjs` |
| Dispatch baseline | Current `task next` / `task finish` loop and AC coverage rules inspected | Read `skills/sdw-orch/scripts/sdw_orch.cjs` |
| Prompt baseline | Current task prompt AC list and scope fence inspected | Read `skills/sdw-orch/scripts/implementation_runner.cjs` |
| Configuration baseline | `taskGranularity` and `maxTasksPerSpec` are absent from the current schema | Read `.sdw/config.schema.json` |
| Test baseline | Existing `node:test` suite passes before changes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `dag preview` output, e.g. `[dag preview] mode=micro tasks=4 acs=14` followed by one line per task: `task-2 | AC5,AC6,AC7,AC8 | deps=task-1 | files=d.cjs,e.cjs`.
- `dag preview --json` returns `{ mode, taskCount, tasks: [{ id, title, acIds, targetFiles, dependencies }] }` and exits 0.
- Run state records `steps[3].output.dagPlan.mode`, `taskCount`, and per-task `acIds`; each dispatch envelope lists only its task's AC ids.
- Sequential dispatch signal: one `[Step 4: Dispatch] task-N dispatched` line per round, each followed by `awaiting_implementation` and exit code 4, until the queue is empty and `resume` prints the gate run.
- `status` reports `Queue: N remaining` while micro tasks are incomplete.
- Cap merging signal: a 30-AC specification at cap 8 prints `tasks=8 (merged)` with every AC appearing exactly once.

### Negative & Failing Test Scenarios

- Cap overflow: a specification that would need nine tasks at a six-AC merge ceiling exits non-zero naming the offending merged chunk; no plan is written.
- Unknown specification: `dag preview --spec missing.md` exits non-zero and names the path.
- Preview purity: after `dag preview`, no `.sdw/state` file, artifact, branch, or sandbox directory exists; a test asserting any of them fails.
- Coverage gap: a task list that omits one AC, or lists one twice, fails the coverage test.
- Dependency cycle: a plan whose task-1 depends on task-2 fails validation before dispatch.
- Evidence fence: `task finish` for `task-2` with an AC id assigned to `task-3` is rejected and the task stays dispatched.
- Standard mode regression: with no configuration, a complex fourteen-AC specification still produces the current two-task plan.
- Registry purity: `dag preview` must not change the specification's index row, status, or validation health.
- Registry sync: `sdw-spec sync` keeps row 030 registered and does not schedule it or change its status.
