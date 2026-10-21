---
id: null
slug: 00028-sdw-orch-sequential-subagent-implementation
title: "SDW Orchestrator Sequential Subagent Implementation Dispatch"
source: local
status: implemented
specDate: 2026-10-19
---

# Specification — SDW Orchestrator Sequential Subagent Implementation Dispatch

## Description

Step 4 of the `sdw-orch` pipeline is the step that turns a Step 3 DAG plan into working product code. Its original design intent was to hand each DAG task to its own well-instructed worker agent, one task at a time, and to accept the task only when that worker returned verifiable evidence. The current implementation (spec 015, `implementation.mode: handoff`) does not deliver that. It renders one prompt file per DAG task in a single pass, sets `awaiting_implementation`, exits with code 4, and leaves everything else to prose in the run log. Nothing in the CLI enforces that work happens through isolated workers, one at a time, or in dependency order. A run can therefore be completed by a single agent editing files inline, by two workers racing in the same tree, or by submitting evidence for unrelated edits, and Step 5 will still score the result as conformant.

Concrete defects of the current Step 4:

1. **Sequentiality is unenforced.** Every task prompt is written upfront and `task finish` accepts any task whose DAG dependencies are `completed`, so ordering and one-at-a-time execution exist only in documentation. Two workers can be told to implement `task-1` and `task-2` simultaneously.
2. **Prompts are not self-sufficient instructions.** There is no file scope fence, no prohibition on `git push` / `git branch` / worktree operations, no prohibition on recursive subagent spawning, no visibility of the remaining (unassigned) criteria, no context from already-accepted tasks, and `contextPrompt` restates criteria already listed above it.
3. **The evidence template invites fabrication.** The template embedded in every prompt pre-fills a `"status": "passed"` test entry and a `filesChanged` list derived from `targetFiles`, so a worker that wrote no code and ran no test is presented with a passing, complete-looking evidence file to copy.
4. **Evidence cannot express failure.** A worker that implemented half of its criteria, or hit a decision it cannot make, has no way to say so in band; the only outcomes are a fabricated success or silence.
5. **There is no staleness check.** Because the primary-agent mode runs in the shared working tree, a task can be accepted on uncommitted edits produced by an earlier task that touched the same file.
6. **There is no release path.** Nothing records which task a worker currently owns, and nothing can return a task to the queue, so a worker that dies leaves the run unable to progress without hand-editing run state.
7. **Resume is order-blind.** `resume` prints one generic `task finish` command for all tasks, never re-emits a lost task brief, and cannot tell the operator which task is in flight.
8. **Naming and documentation drift.** `handoff` describes a mechanism the step does not implement, while the orchestrator protocol and skill description claim a "subagent context fencing and dispatch" capability that has no code behind it.

This specification replaces the primary-agent execution path with an explicit sequential dispatch protocol:

1. **`implementation.mode: subagent` (default).** `handoff` is removed, not aliased. The CLI becomes the sequencer: `task next` yields exactly one dispatch envelope and marks that task `dispatched`; `task finish` accepts only the dispatched task; `task abandon` releases it back to the queue. Two concurrent or out-of-order workers are rejected deterministically.
2. **Well-instructed envelope.** Each dispatch renders a fresh prompt containing the verbatim assigned criteria, the ids of the remaining criteria, target files, a scope fence, dependency context from accepted tasks, explicit prohibitions, an honest evidence schema, a report contract, and the finish command. A `subagentBrief` tells the host agent to spawn exactly one worker for that envelope.
3. **Honest evidence and corroboration.** Evidence carries a required `status` field; `task finish` accepts only `success`, and only when at least one `filesChanged` path differs from the baseline captured at dispatch, so a task cannot ride on a previous task's uncommitted edits.
4. **Explicit recovery.** `task abandon --reason` returns an owned task to `pending` and records why, and a re-dispatch prompt carries the partial progress already in the tree, so a lost worker costs one command instead of state surgery.
5. **Harness-agnostic dispatch.** The CLI never spawns subagents. It emits the envelope and the brief; the host agent performs the spawning using whatever the harness offers. Harnesses without subagent support execute the same envelope in a fresh context and keep the one-at-a-time contract.

`implementation.mode: command`, the verification gates, and exit codes are unchanged by this specification. The evidence schema gains one required field (`status`).

### Design Lineage

The `workflow-skills` framework (`ws-spec-to-pr`: `STEP-DISPATCH.md`, `WORKER-TURN-RULES.md`, `scripts/build_dispatch_context.cjs`, `scripts/worker_liveness_check.cjs`) was reviewed for inspiration only. Three ideas were cheap enough to adopt: an explicit evidence `status` so a failing worker fails in band instead of silently withholding completion; a re-dispatch prompt that carries prior partial progress; and corroborating evidence against the dispatch moment rather than against the tree as a whole. That framework's heavier machinery — byte-budgeted prompt manifests, SHA-256 prompt audit chains with revisions, append-only telemetry streams, liveness markers with configurable windows, model provenance, and pre-dispatch artifact gates — was deliberately not adopted: SDW DAG plans are small, run state is already the single source of truth, and each of those mechanisms would add a second store, extra commands, and new configuration for a problem this step does not have.

### Design Intent

The value of Step 4 is not that prompts exist; it is that implementation work is dispatched, isolated, ordered, and corroborated. Making the CLI the sequencer moves the invariant from prose into deterministic state transitions that a test can assert: one active dispatch, monotonic dependency order, and evidence that cannot be satisfied by someone else's edits. Keeping the worker a host-agent responsibility preserves harness and vendor agnosticism — the envelope is plain markdown plus JSON, so the same contract works with a subagent tool, a fresh chat, or a terminal hand-off. The change is deliberately breaking under the repository policy: `handoff` is rejected with remediation rather than shimmed, because a silently retained alias would preserve exactly the ambiguity this step is supposed to remove.

## Acceptance Criteria

- AC1: The system shall replace the `implementation.mode` enum value `handoff` with `subagent`.
- AC2: The system shall default `implementation.mode` to `subagent` when the configuration key is absent.
- AC3: If `implementation.mode` is `handoff`, then the system shall fail configuration validation with a remediation message naming `subagent`.
- AC4: The system shall provide a `task next` subcommand accepting `--run-id` and `--json`.
- AC5: When `task next` executes, the system shall mark exactly one ready DAG task `dispatched` and record its sequence number and dispatch timestamp.
- AC6: If another DAG task is already `dispatched`, then the system shall reject `task next` with a non-zero exit code naming the active task.
- AC7: If no DAG task is dispatchable while tasks remain, then the system shall reject `task next` with a non-zero exit code naming the blocking dependency.
- AC8: When every DAG task is `completed`, the system shall report dispatch exhaustion by printing the `resume` command.
- AC9: If the task named by `task finish` is not the dispatched task, then the system shall reject the completion with a non-zero exit code naming the active task.
- AC10: When `task finish` accepts the dispatched task, the system shall record it `completed` and clear the active dispatch.
- AC11: The system shall provide a `task abandon` subcommand accepting `--run-id`, `--task`, and `--reason`.
- AC12: When `task abandon` executes against the dispatched task, the system shall return it to `pending` and record the abandonment reason.
- AC13: If `task abandon` executes with no dispatched task, then the system shall reject it with a non-zero exit code.
- AC14: When a task is dispatched, the system shall render `task-{taskId}.prompt.md` under `{stateDir}/{slug}/{runId}/` before marking the task `dispatched`.
- AC15: When a task is dispatched, the system shall emit an envelope containing the task id, prompt path, evidence path, specification path, assigned criteria, dependencies, and finish command.
- AC16: The system shall include in every dispatch envelope a subagent brief instructing the host agent to spawn exactly one worker for that envelope.
- AC17: The system shall include in every task prompt the verbatim text of its assigned acceptance criteria and the ids of every unassigned criterion.
- AC18: The system shall include in every task prompt a scope fence naming both the permitted and the forbidden modification targets.
- AC19: The system shall include in every task prompt an explicit prohibition on `git commit`, `git push`, `git branch`, and worktree operations.
- AC20: The system shall include in every task prompt an explicit prohibition on spawning further subagents.
- AC21: When a dispatched task depends on accepted tasks, the system shall include those tasks' summaries and changed files in its prompt.
- AC22: The system shall omit pre-filled test results from the evidence template embedded in each task prompt.
- AC23: The system shall include in every task prompt a report contract covering status, files changed, referenced criteria, executed tests, and blockers.
- AC24: When a task is re-dispatched after abandonment, the system shall include the partial progress already present in the working tree in the new prompt.
- AC25: The system shall require a `status` field in every task evidence file with the value `success`, `partial`, `failed`, or `blocked`.
- AC26: If the evidence `status` is not `success`, then the system shall reject the completion with a non-zero exit code quoting the reported status.
- AC27: If no file in `filesChanged` differs from the dispatch baseline, then the system shall reject the completion with a non-zero exit code.
- AC28: While the workspace is not a git repository, the system shall corroborate changes by file existence only.
- AC29: When Step 4 starts in `subagent` mode, the system shall dispatch the first ready task and exit with code 4.
- AC30: While Step 4 status is `awaiting_implementation`, the system shall keep the run status `paused`.
- AC31: When `resume` runs with an active dispatched task, the system shall re-emit that task's dispatch envelope.
- AC32: When `resume` runs with incomplete tasks and no active dispatch, the system shall refuse verification gates and print the `task next` command.
- AC33: When `task finish` accepts a task, the system shall print the `task next` command while tasks remain and the `resume` command when none remain.
- AC34: The system shall run build and test verification gates only when every DAG task is `completed`.
- AC35: While `implementation.mode` is `subagent`, the system shall record a worktree skip reason and create no task worktrees.
- AC36: The system shall not spawn subagents or call harness, vendor, or agent runtime APIs.
- AC37: The system shall report the active dispatched task and every task status in the `status` command output.
- AC38: While `implementation.mode` is `command`, the system shall retain per-task subprocess execution without dispatch state.
- AC39: The system shall document the dispatch loop, envelope schema, prompt contract, and task statuses in the skill documentation and protocol reference.
- AC40: The system shall remove `handoff` mode references from skill documentation, configuration, and tests.

## Notes

- Authoring standard: Node.js 22 CommonJS helpers, standard library only, zero runtime npm dependencies; 3-Tier skill layout respected; breaking changes applied without compatibility shims.
- Supersedes the `handoff` mode of spec 015. The verification gates, exit codes, worktree integration for `command` mode, and security rules of spec 015 remain in force. Two deltas apply: evidence gains a required `status` field (AC25), and primary-tree corroboration is anchored to a hash baseline captured at dispatch (AC27).
- No new configuration keys. `implementation` keeps `mode`, `command`, `timeoutMs`, and `envAllowlist`; only the `mode` enum changes.
- Implementation surfaces:
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: replace the `handoff` branch of Step 4 with the dispatch sequencer; add `task next` and `task abandon`; rewire `task finish`, `resume`, `status`, the `--mode` option, and the usage block.
  - `skills/sdw-orch/scripts/implementation_runner.cjs`: rewrite `renderTaskPrompt` for the prompt contract; add envelope construction, subagent brief rendering, partial-progress collection, and timestamp-anchored change corroboration in `checkTaskChanges`.
  - `skills/sdw-orch/scripts/evidence_validator.cjs`: require and validate the evidence `status` enum.
  - `skills/sdw-orch/scripts/state_manager.cjs`: dispatch record helpers (set and clear active dispatch, record abandonment) and the `steps['4'].dispatch` default; drop the unused top-level `handoffs` field left over from the `workflow-skills` lineage.
  - `skills/sdw-orch/scripts/batch_runner.cjs`: unchanged behavior; batch manifests keep recording `awaiting_implementation` on exit code 4 and never carry dispatch state.
  - `skills/sdw-config/scripts/sdw_config.cjs` and `skills/sdw-config/references/config.schema.json`: `implementation.mode` enum `subagent | command`, default `subagent`, `handoff` rejected.
  - `.sdw/config.json`: `implementation.mode` set to `subagent`.
  - `skills/sdw-orch/SKILL.md`, `skills/sdw-orch/references/orchestrator_protocol.md`, `skills/sdw-config/references/config_spec.md`, `.sdw/directory-structure.md`: dispatch loop, envelope schema, prompt contract, task statuses, artifact paths.
  - `README.md`, `FEATURES.md`, `AGENTS.md`: keep the Step 4 description in sync with the new mode name and protocol.
  - `tests/sdw_orch_implementation.test.cjs`: replace handoff cases with dispatch, abandon, corroboration, evidence-status, and prompt-contract cases. `tests/sdw_config.test.cjs`: enum and default validation. `tests/sdw_orch.test.cjs`: state fixture alignment.
- Dispatch envelope (`task next --json`):
  ```json
  {
    "runId": "run-1792400000000-00028-sdw-orch-sequential-subagent-implementation",
    "specSlug": "00028-sdw-orch-sequential-subagent-implementation",
    "taskId": "task-2",
    "title": "Workflows, Verification & PR Integration",
    "status": "dispatched",
    "sequence": 2,
    "promptFile": ".sdw/state/00028-sdw-orch-sequential-subagent-implementation/run-1792400000000-00028-sdw-orch-sequential-subagent-implementation/task-task-2.prompt.md",
    "evidenceFile": ".sdw/state/00028-sdw-orch-sequential-subagent-implementation/run-1792400000000-00028-sdw-orch-sequential-subagent-implementation/task-task-2.evidence.json",
    "specPath": ".sdw/specs/00028-sdw-orch-sequential-subagent-implementation.md",
    "workingDir": ".",
    "acIds": ["AC20", "AC21"],
    "dependencies": ["task-1"],
    "subagentBrief": "Spawn one subagent. Give it: read <promptFile> and execute it exactly as written, then report back.",
    "finishCommand": "node skills/sdw-orch/scripts/sdw_orch.cjs task finish --run-id <runId> --task task-2 --evidence <evidenceFile>"
  }
  ```
- Run state additions:
  ```json
  {
    "steps": {
      "4": {
        "status": "awaiting_implementation",
        "dispatch": {
          "activeTaskId": "task-2",
          "sequence": 2,
          "dispatchedAt": "2026-10-19T12:00:00.000Z",
          "abandonments": [
            { "taskId": "task-2", "reason": "worker context lost", "at": "2026-10-19T12:04:00.000Z" }
          ]
        },
        "tasks": {
          "task-1": { "status": "completed", "summary": "...", "filesChanged": ["src/auth/token.ts"], "acIds": ["AC1"] },
          "task-2": { "status": "dispatched", "promptPath": "...", "evidencePath": "..." }
        },
        "gates": {}
      }
    }
  }
  ```
- Task statuses: `pending`, `dispatched`, `completed`. Failures are recorded in `state.errors`; abandonment returns the task to `pending` with an `abandonments` entry, so there is no `abandoned` status.
- Dispatch loop: `run` (Step 4 in `subagent` mode) dispatches the first ready task and exits 4 → host agent spawns one worker for the envelope → worker implements and writes evidence with `status: "success"` → host agent runs `task finish` → CLI accepts, clears the dispatch, and prints the next `task next` command → repeat → `resume` runs the gates once every task is `completed`. When a worker reports `partial`, `failed`, or `blocked`, or never returns, the host agent records the outcome with `task abandon --reason` and dispatches the task again.
- `task next` readiness: a task is ready when its status is `pending` and every id in its `dependencies` is `completed`. Dispatchable order follows DAG declaration order, so sequential execution matches the topological plan.
- Prompt file sections, in order: `## Task Context`, `## Description`, `## Assigned Acceptance Criteria`, `## Remaining Acceptance Criteria (do not regress)`, `## Target Files`, `## Scope Fence`, `## Dependency Context`, `## Prior Partial Progress`, `## Prohibited Actions`, `## Evidence Schema`, `## Report Contract`, `## Finish Command`. `## Dependency Context` and `## Prior Partial Progress` are omitted when empty. Dependency summaries are one line per accepted task, so prompt size grows with the DAG, not with the run.
- Prohibited actions wording includes: no `git commit`, `git push`, `git branch`, `git checkout`, `git worktree`, or `git tag`; no subagent spawning or delegation; no edits outside the scope fence; no edits to the run state, prompt files, or the specification; no test entries for commands that were not executed; no `status: "success"` while any assigned criterion is unmet.
- Evidence schema: `taskId`, required `status` (`success`, `partial`, `failed`, `blocked`), non-empty `acIds` subset of the specification, non-empty `filesChanged` of project-relative existing paths, optional `tests` entries with `name` and `status`, non-empty `summary`, and optional `blockers` string array. Only `success` is accepted. The prompt shows a template with `"status": "success"`, empty `filesChanged` and `acIds`, `tests: []`, and an empty `summary` to be filled — never a passing example. A `partial`, `failed`, or `blocked` report is a valid worker outcome that the host agent turns into `task abandon`, not a malformed file.
- Change corroboration: dispatch captures a baseline of the paths already dirty, with a SHA-256 of each. At `task finish`, a `filesChanged` path corroborates the task only when it is dirty now and either it was clean at dispatch or its content differs from the baseline hash. Content comparison is used instead of modification times because filesystem timestamp granularity is unreliable across hosts. When the workspace is not a git repository, corroboration is existence-only.
- Partial progress: an abandoned dispatch leaves its working-tree edits in place. The re-dispatch prompt lists the paths currently modified relative to `HEAD` and instructs the worker to inspect them first and preserve existing progress instead of rebuilding or reverting it. Their content matches the new dispatch baseline, so inherited edits never satisfy the corroboration check on their own.
- Exit codes are unchanged: `0` success, `1` operational failure, `2` conformance score below threshold, `3` user gate or cancellation, `4` awaiting implementation (dispatch pause). `task next`, `task finish`, and `task abandon` use `0` and `1` only.
- Harness without subagent support: the host agent executes the same envelope inline in a fresh context. The CLI contract does not change, and the one-task-at-a-time invariant is preserved by the single active dispatch.
- Deliberately out of scope for this iteration, per the reference study: prompt byte budgets and manifests, prompt SHA-256 audit chains with revisions, append-only telemetry streams, liveness markers and windowed verdicts, provenance flags, and pre-dispatch artifact gates. Each is recoverable later without changing the dispatch contract, and none is required for correctness at SDW's DAG sizes.
- Tests:
  - Dispatch: first envelope on `run`, `--json` shape, prompt rendered before the task is marked `dispatched`, second dispatch refused naming the active task, dependency-gated readiness, exhaustion path printing `resume`, non-zero exit when nothing is dispatchable.
  - Finish and abandon: non-active task rejected, active task accepted with dispatch cleared, `task next` hint printed, abandonment returning a task to `pending` with a recorded reason, abandonment rejected with no active dispatch.
  - Evidence: missing `status` rejected, `partial`, `failed`, and `blocked` rejected quoting the status.
  - Corroboration: a task whose `filesChanged` only matches edits older than its dispatch is rejected; a file modified after dispatch is accepted; a clean unmodified file is rejected; non-git workspaces fall back to existence checks.
  - Prompt contract: verbatim assigned criteria, remaining criteria ids, scope fence, prohibitions for commit/push/branch/worktree and subagent spawning, dependency summary inclusion, absence of `"status": "passed"` in the template, report contract present, partial-progress section on re-dispatch.
  - Mode: `handoff` rejected by config validation, absent key defaults to `subagent`, schema enum updated.
  - Resume: active dispatch re-emits the envelope; incomplete tasks without an active dispatch refuse gates and print `task next`.
  - Regression: `command` mode still spawns one subprocess per task with token substitution and the environment allowlist, and creates no dispatch state.
  - Keep the suite dependency-free with `node:test` and `node:assert/strict`; use temporary directories and local git fixtures.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Parallel DAG task execution and multiple concurrent subagents | Explicitly deferred; this version is strictly sequential, one worker at a time |
| Per-task worktree isolation in subagent mode | `command` mode keeps worktrees; subagent mode uses the primary tree with a dispatch-baseline check instead |
| Harness-hosted subagent APIs, vendor SDKs, or plugin hooks | Would violate agent and harness agnosticism |
| Prompt budgets, audit chains, telemetry streams, and liveness verdicts | Studied in `workflow-skills` and rejected as heavier than this step needs |
| Automatic retry or re-spawn policy for failed workers | Recovery is explicit through `task abandon --reason`; retry policy is a separate concern |
| Acceptance-criteria ledger with evidence SHA links | Tracked by spec 017 |
| LLM-judge conformance scoring changes | Tracked by spec 027 |
| Crash-safe checkpoint and turn pause | Tracked by spec 019 |
| Refinement quality and step artifact persistence | Tracked by specs 013 and 014 |
| Monitor and telemetry rendering of dispatch state | Tracked by spec 021 |
| Batch queue redesign | Only the existing exit-code-4 pause record is retained |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Execution mode name | `subagent` replaces `handoff` | The mode now names the intended mechanism, and retaining an alias would preserve the ambiguity being removed | y |
| Default mode | `subagent` | Matches the original design intent and stays usable in every harness without vendor coupling | y |
| Dispatch granularity | One dispatched task at a time | Sequential execution was requested; it also bounds blast radius and worker context | y |
| Sequentiality enforcement | CLI rejects a second dispatch and out-of-order completion | Prose-only sequencing demonstrably failed to keep the pipeline honest | y |
| Working directory in subagent mode | Primary tree with a dispatch-baseline check | Avoids worktree lifecycle in the default path while still detecting stale evidence | y |
| Subagent spawning authority | Host agent spawns; the CLI never does | Keeps the contract harness-agnostic and testable with plain Node | y |
| Reference framework scope | Inspiration only, no feature parity | SDW prioritizes simplicity and speed over capability breadth | y |
| Harness without subagent support | Host executes the envelope inline in a fresh context | Keeps the workflow usable everywhere while preserving one-task-at-a-time semantics | n |
| Dispatch state location | `steps['4'].dispatch` in run state | Step-scoped, resumable, and does not pollute shared configuration | n |
| `awaiting_implementation` status name | Retained | Batch manifests and the exit-code mapping already depend on it; renaming adds churn without behavior change | n |
| Evidence `status` field | Required, only `success` accepted | Makes partial or blocked work an explicit signal instead of a silently withheld completion | n |
| Corroboration signal | SHA-256 baseline of the paths already dirty at dispatch | Content comparison is deterministic; modification times proved unreliable under coarse filesystem clocks in CI | n |
| Abandoned task handling | Return to `pending` with a recorded reason | Allows re-dispatch after a lost worker without corrupting run state | n |
| Runtime dependencies | Node.js 22 standard library only | Repository policy forbids runtime npm dependencies in packaged skills | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is valid and `implementation.mode` resolves | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature registered in `.sdw/specs/index.specs.md` as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification passes canonical SDW authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00028-sdw-orch-sequential-subagent-implementation.md` |
| Step 4 baseline | Current `handoff` branch, `task finish`, and `resume` paths inspected | Read `skills/sdw-orch/scripts/sdw_orch.cjs` |
| Prompt renderer baseline | Current prompt sections and evidence template inspected | Read `skills/sdw-orch/scripts/implementation_runner.cjs` |
| Evidence baseline | Current evidence schema and validator inspected | Read `skills/sdw-orch/scripts/evidence_validator.cjs` |
| State baseline | Run state schema and step helpers inspected | Read `skills/sdw-orch/scripts/state_manager.cjs` |
| Git baseline | `git rev-parse` and `git status --porcelain` available in the target environment | Execute both in a scratch repository fixture |
| Runtime baseline | Node.js 22 standard library available with no runtime npm dependencies | Execute the helpers with `node` |
| Test baseline | Existing `node:test` suite passes before changes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Dispatch output, e.g. `[Step 4: Dispatch] task-2 dispatched (sequence 2, 2 ACs, 1 dependency)`, `Prompt: .sdw/state/{slug}/{runId}/task-task-2.prompt.md`, and the finish command.
- Acceptance output, e.g. `[Step 4: Dispatch] task-2 accepted (status success, 2 ACs, 3 files). Active dispatch cleared.` followed by the `task next` command, or by the `resume` command when it was the final task.
- Abandonment output, e.g. `[Step 4: Dispatch] task-2 returned to pending (reason: worker context lost).`
- Run state contains `steps['4'].dispatch.activeTaskId`, `sequence`, `dispatchedAt`, and `abandonments`.
- Task records carry `status`, `promptPath`, `evidencePath`, `filesChanged`, `acIds`, and `summary` for accepted tasks.
- `task next --json` returns the envelope exactly once per dispatch and never returns a second envelope while one is active.
- `sdw-orch status` reports the active dispatched task, per-task statuses, and the remaining queue depth.
- Exit code 4 marks a dispatch pause and leaves the run status `paused`; gates and Step 5 run only after every task is `completed`.

### Negative & Failing Test Scenarios

- Double dispatch: a second `task next` while `task-2` is dispatched fails with exit code 1 and names `task-2` as the active task.
- Out-of-order completion: `task finish --task task-1` while `task-2` is dispatched fails with exit code 1 and names the active task, even when `task-1` has no dependencies.
- Blocked queue: `task next` on a run whose only pending task depends on a dispatched task fails with exit code 1 and names the blocking dependency.
- Nothing dispatched: `task abandon` with no active dispatch fails with exit code 1.
- Stale evidence: evidence listing only a file whose content is unchanged from the dispatch baseline is rejected and the task stays `dispatched`.
- Unmodified evidence: evidence listing a clean file that the worker never touched is rejected.
- Non-success evidence: `status: "partial"` is rejected with the reported status quoted, and the task stays `dispatched`.
- Missing evidence status: an evidence file without `status` is rejected by validation.
- Fabricated tests: a prompt template containing a pre-filled passing test entry fails the prompt-contract test.
- Sequential prohibition: a prompt missing the git or subagent prohibitions fails the prompt-contract test.
- Removed mode: `implementation.mode: handoff` fails configuration validation with a message naming `subagent`.
- Lost worker: after `task abandon`, `task next` re-dispatches the same task with an incremented sequence, the earlier reason preserved, and the partial-progress section present.
- Gate ordering: `resume` with incomplete tasks runs no build or test command and prints the `task next` command.
