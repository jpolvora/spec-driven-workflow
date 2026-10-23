# sdw-orch Orchestrator Protocol & Architecture Reference

This reference details the internal lifecycle and contracts of the `sdw-orch` orchestrator.

## 1. Run State Lifecycle (`.sdw/state/{runId}.state.json`)

Each execution session is completely isolated within a dedicated JSON state file.

```json
{
  "orchestrator": "sdw-orch",
  "runId": "run-1729300000-feature",
  "specSlug": "feature",
  "specPath": ".sdw/specs/feature.spec.md",
  "projectRoot": "L:/source/project",
  "status": "in_progress",
  "currentStep": 1,
  "totalSteps": 8,
  "createdAt": "2026-10-18T23:00:00.000Z",
  "updatedAt": "2026-10-18T23:05:00.000Z",
  "baseCommit": "38a7c1...",
  "deliveryCommit": null,
  "branch": "feature/00040-example",
  "baseBranch": "master",
  "branchReused": false,
  "branching": {
    "strategy": "gitflow",
    "source": "config",
    "featurePrefix": "feature/",
    "featureBranch": "feature/00040-example",
    "workBranch": "develop",
    "integrationBranch": "develop",
    "updateWorkBranch": true,
    "syncWorkBranchAfterMerge": true,
    "pushSyncedWorkBranch": false
  },
  "branchingSync": null,
  "score": 9,
  "scoreIteration": 1,
  "reviewIteration": 1,
  "revision": 17,
  "stepCheckpoints": {},
  "turnPause": null,
  "dagTasks": [],
  "steps": {
    "1": { "name": "derivation", "status": "completed", "output": {} },
    "2": { "name": "grilling", "status": "completed", "output": {} },
    "3": { "name": "dag_generation", "status": "completed", "output": {} },
    "4": {
      "name": "implementation",
      "status": "completed",
      "output": {},
      "dispatch": { "activeTaskId": null, "sequence": 2, "dispatchedAt": null, "baseline": { "dirty": [], "hashes": {} }, "abandonments": [] },
      "tasks": {
        "task-1": { "status": "completed", "filesChanged": ["src/a.ts"], "acIds": ["AC1"], "summary": "...", "commitSha": "9f2c41...", "checkpointTag": "sdw-checkpoint-run-1729300000-feature-task-1" }
      },
      "gates": { "build": { "status": "passed", "exitCode": 0 }, "test": { "status": "passed", "exitCode": 0 } }
    },
    "5": { "name": "scoring", "status": "completed", "output": {} },
    "6": { "name": "delivery_commit", "status": "completed", "output": {} },
    "7": { "name": "code_review", "status": "completed", "output": {} },
    "8": { "name": "pr_preparation", "status": "completed", "output": {} }
  },
  "errors": []
}
```

### Revision, Checkpoints & Turn Pause (Spec 00019)

- `revision`: monotonic integer. A new run starts at `0`, and every persisted mutation advances it by exactly one. A checkpoint records the revision its transition produced.
- `stepCheckpoints`: object keyed by step number. Each entry is `{ step, revision, status, progress?, recordedAt }`. `checkpoint --step N` snapshots the step's current status and the caller's progress JSON; finishing a step (`completed` or `skipped`) deletes its entry.
- `turnPause`: `{ step, reason, nextAction, recordedAt }` or `null`. A turn pause is a handoff marker, not a failure: it never completes or fails the step. `resume` prints the recorded next action and continues from the paused step, and finishing that step clears the pause.
- Resume validation: a state file that does not parse, or whose `revision` is missing or not a non-negative integer, is refused with exit code `1`, the file path, and a `Remediation:` line. Resume never re-executes a resolved step and never mutates an unchanged open run.
- Telemetry: every checkpoint and turn pause appends to `state.reportContributions` with kind `checkpoint` or `turn_paused`, carrying the step, revision, timestamp, and payload. No external log file is written.

### Run Lock, Atomic Writes & Interrupted-Write Recovery (Spec 00019)

- **Lock:** every read-modify-write of `{stateFile}` takes the sibling `{stateFile}.lock`, created exclusively and holding `{ pid, host, acquiredAt }`. The lock is reentrant inside one process and is always released, so a thrown mutation never leaves it held.
- **Contention:** a live lock fails the mutation with exit code `1` and an actionable message naming the owner pid, host, acquisition time, and lock file.
- **Stale reclaim:** `lockStaleMs` (`.sdw/config.json`, default `300000`) bounds the lock age. A stale lock is reclaimed only when it was acquired on this host and the owner process is proven absent; a foreign-host lock, or one whose owner is alive, is never reclaimed and the message says to delete it manually once no process is using the run.
- **Atomic write:** state is staged in `{stateFile}.tmp-{pid}`, flushed best-effort, renamed over `{stateFile}`, and the directory is fsynced where supported. A crash can leave a temp file, never a partially written state file.
- **Recovery:** a load ignores every sibling `{stateFile}.tmp-*` and reads the last valid state; a stale temp file is a warning, not a failure. The next successful write deletes stale temp files, so operators never remove one by hand.

### Advisory Model Hints (Spec 00056)

Step 1 resolves every advisory hint once, before any step acts, and records the snapshot in `state.models`. Hints are opaque strings interpreted by the host harness: no helper invokes a model, calls a provider API, stores credentials, or validates reachability.

| Field | Resolution order (first non-empty wins) |
|---|---|
| `orchestratorHint` | `models.orchestrator`, then `models.default` |
| `workerHint` | `models.worker`, then `models.default` |
| `reviewerHint` | `models.reviewer`, then `models.default` |
| `fixerHint` | `models.fixer`, then `models.default` |
| `judgeHint` | `models.judge`, then `scoring.judgeModel`/`judgeProvider`/`judgeEffort`/`judgeApiEndpoint`, then `models.default` |
| `shipHint` | `models.ship`, then `models.fixer`, then `models.default` |
| `retroHint` | `models.retro`, then `models.default` |

Each field is a `{ model, provider, effort, apiEndpoint }` record of nullable strings, or `null` for the current agent model instance. An absent `models` section resolves every field to `null`.

`models.detection` is the start-of-run capability toggle: `{ enabled, command, timeoutMs }` with defaults `false`, `null`, `30000`. A disabled toggle (the default) skips detection entirely, performs no probe, writes no capabilities cache, and records `state.models.detection.status: "skipped"`; hints then come from static resolution only, and the run stays free of per-step model concern.

When detection is enabled, Step 1 binds once before task dispatch and every later step reuses the bound entry (`task next`, `resume`, Step 7, and Step 8 never probe again):

- **Cache:** consumer-local, gitignored `.sdw/host-capabilities.json`, one key per session model (`{hostId}::{sessionModel}`, supplied by the host or `SDW_MODELS_SESSION_KEY`), each value `{ capabilities, supportedModels, probedAt, source }`. A hit records `detection.status` and `detection.source` of `hit` with `transport: cache` and reuses the entry; a miss records `probe` and runs exactly one probe, upserting only the current key while preserving every other key. Missing or unreadable cache behaves as a miss.
- **Probe:** `models.detection.command` runs with `{capabilitiesFile}`, `{targetRoot}`, `{slug}`, `{runId}` and writes the capabilities contract `{ harness, models: [{ model, provider, effort, available }] }` to `.sdw/state/{runId}/model-capabilities.probe.json`. With a null command the host consults its harness and writes the same file shape before dispatch.
- **Invalidation:** re-probe only on `--refresh-models`, a different session key, or a new run; `--no-model-detect` skips detection for one invocation.
- **Failure:** a missing, unreadable, malformed, or timed-out capabilities file fails open. `state.models.detection.status` and `source` become `failed-open`, `transport` names `command` or `host`, the warning lands in `state.errors`, and the run proceeds on static hints.
- **Adaptation:** when the statically resolved hint names a model flagged unavailable in `supportedModels` or the capabilities list, the orchestrator walks the role fallback chain (`ship` through `fixer`, `judge` through `scoring.judge*`, every role through `models.default`) to the first available entry, then null. `state.models.adaptations` records `{ role, requested, resolved, reason }`, `state.models.static` keeps the pre-adaptation view, and the requested id travels as `configuredModel` on the resolved hint and the Step 4 dispatch envelope.
- **Snapshot:** `state.models` records `detection` (enabled, status, source, transport, key, command, probedAt), `static`, `capabilities`, `supportedModels`, `resolved`, `adaptations`, and the flat `orchestratorHint`, `workerHint`, `reviewerHint`, `fixerHint`, `judgeHint`, `shipHint`, and `retroHint` the steps consume.

## 2. 8-Step State Machine

1. **Derivation:** Identifies whether the spec is already agent-ready (EARS ACs, DoR, YAML frontmatter). Skips derivation if ready; otherwise reformulates human stories.
2. **Grilling:** Walks the decision tree covering input bounds, failure scenarios, and concurrency. Auto-resolves known gaps or prompts user via `ask_question` with recommended defaults. Records advisory spec observations over sibling specifications in `steps[2].output.specObservations`; they never block or alter the run.
3. **DAG Generation:** Classifies the refined specification as `low`, `standard`, or `complex` from its declared acceptance criteria plus the Step 2 blueprint target files, then decomposes it into one task, the foundation-plus-integration pair, or three to five slices of at most four criteria and three target files. Four or fewer criteria are `low`, five to ten are `standard`, more than ten are `complex`, and three detected touchpoints with seven or more criteria escalate to `complex`. A decomposition needing more than five tasks is refused (exit `1`, `split-required tasks-needed=N cap=5`) with a two-specification split proposal instead of coarse merging. Every plan records `execMode: sequential`, wave `levels`, per-task `parallelizable` flags, and pairwise file disjointness; the flags are observable only.
4. **Implementation Dispatch:** Sequentially dispatches one DAG task at a time to a single worker, with a complete brief (criteria, scope fence, prohibitions, evidence contract) instead of the orchestrator's transcript. Every accepted task is checkpointed immediately: one scoped commit of its `filesChanged` plus the tag `sdw-checkpoint-{runId}-{taskId}`.
5. **Conformance Scoring:** An LLM judge fences the criteria plus the generated diff, emits a 0-10 score with per-criterion verdicts. If the score is below threshold (default 8/10), feedback triggers the re-implementation loop.
6. **Delivery Commit:** Creates an atomic, structured git commit for verified code. It remains the delivery commit after the per-task checkpoints and aggregates whatever they did not already commit.
7. **Fresh-Subagent Code Review via sdw-code-review:** MUST spawn one context-fresh reviewer subagent session for `sdw-code-review`; MUST NOT produce a Step 7 verdict by running the review CLI in the orchestrator session. The brief carries only target root, base reference, report path, and scope fence, never the implementation transcript. The fresh session inspects the generated JSON report (`passed`, `errorCount`, `warningCount`, `suggestionCount`, `findings`) to advance to Step 8, iterate surgical fixes (up to 3 attempts with security gate and scoped fix commits), or pause on residual blocking findings. `sdw-code-review` is the sole review authority.
8. **PR Preparation, Delivery & Code Review Convergence:** Assembles pull request metadata, pushes the active branch to remote origin (when `--push` or `pushDelivery` enabled), opens or reuses the pull request via the SCM provider contract, and executes the post-delivery review convergence loop (monitoring CI checks and automated code reviews to fix comments until green). Only after the delivery stage reports the delivery, or when `--skip-pr` is in effect, does it mark the specification `completed` in the registry and set its header status to `implemented` in the same transition; a run that fails earlier leaves both unchanged. An unconverged delivery pauses with exit code `6` instead of failing.

## 3. Batch Execution Lives in sdw-batch

`sdw-orch` executes exactly one specification per run. Specification queues are owned by [`sdw-batch`](../../sdw-batch/SKILL.md), which creates `.sdw/state/batch-{batchId}.json`, invokes `sdw-orch run <spec>` for each item, waits for the exit code, and advances. The queue advances on delivery evidence, never on a status string: the registry decides only whether a specification still needs implementation, the base proof is a git question, and the merge is a provider question. Manifest schema, pause/resume continuity, the delivery-evidence rule, the stale-run rule, and failure policy: [`sdw-batch/references/batch_protocol.md`](../../sdw-batch/references/batch_protocol.md).

## 4. Branch & Worktree Strategy Protocol

Configurable feature branch activation and per-task isolated git worktrees:

### Feature Branch Lifecycle (`useFeatureBranches: true`)
- **Activation:** No working-tree cleanliness gate. Execution proceeds independently of git state; dirty trees never block, refuse, or halt a run.
- **Naming:** `branching.featurePrefix` + `specSlug` (default `feature/<specSlug>`).
- **Start Lane:** From `branching.workBranch` when it is a non-empty branch distinct from `branching.integrationBranch`; a null work lane, or one equal to the integration lane, starts from the checked-out branch (trunk behavior). With `branching.updateWorkBranch`, the work lane is fetched and fast-forwarded first.
- **Start Point:** When the checked-out work lane cannot be fast-forwarded over a dirty work tree, the branch starts from the refreshed remote lane commit (`refs/remotes/origin/<workBranch>`) instead of the stale local lane, and the start point used is recorded. A local lane that cannot reach the refreshed commit never seeds the branch.
- **Switch/Reuse:** If the feature branch already exists, switches to it and marks `branchReused: true`. Otherwise, creates and switches to it from the start lane. Resuming on the feature branch reuses it in place without checkout, fetch, or fast-forward.
- **Metadata:** Records `branch`, `baseBranch`, `branchReused`, and `branching` (strategy, source, prefix, feature branch, lanes, flags) in state. The Step 8 PR payload includes `head: branch` and `base` resolved by `sdw-ship-pr` from `branching.integrationBranch` (falling back to the detected base branch).
- **Configuration:** Presets (`trunk`, `github`, `develop`, `gitflow`, `gitlab`) and explicit overrides are documented in [`sdw-config/references/config_spec.md`](../../sdw-config/references/config_spec.md).

### Per-Task Worktree Lifecycle (`useWorktrees: true`)
- **Preconditions:** Verifies git availability, repository initialization, and writability of `.sdw/worktrees/`.
- **Trivial Skip Rule:** If DAG tasks count === 1 and complexity is `low` or `simple`, skips worktree creation (`reason: "single low-complexity task"`).
- **Creation:** For each DAG task, creates an exclusive worktree:
  `git worktree add .sdw/worktrees/{runId}/{taskId} -b task/{runId}/{taskId} HEAD`
- **Execution & Integration:** Subagent implements in the worktree. Changes are committed inside the worktree (`task({specSlug}): {taskId}`) and integrated into the primary working tree via `git cherry-pick <commitSha>`. The integration commit is tagged `sdw-checkpoint-{runId}-{taskId}`; no second checkpoint commit is created.
- **Conflict Handling:** Cherry-pick conflicts halt execution with exit code 1; the conflicted worktree is preserved for operator inspection.
- **Clean Removal:** Once integrated, removes worktree via `git worktree remove` and deletes task branch via `git branch -d`.
- **Overrides:** `--no-worktrees` and `--no-feature-branch` flags override configuration for the current run.

## 5. Step Artifacts Persistence Protocol

Intermediate outputs of human-auditable steps (2, 3, 5) are persisted as human-readable Markdown files:

### Directory Layout & Filename Convention
- **Directory:** `{stateDir}/{slug}/{runId}/` (e.g. `.sdw/state/00014-sdw-orch-step-artifacts-persistence/run-1792400000000-00014-sdw-orch-step-artifacts-pe/`)
- **Naming:** `{slug}-step-{N}.md` (e.g. `00014-sdw-orch-step-artifacts-persistence-step-2.md`, `...-step-3.md`, `...-step-5.md`)
- **State Linkage:** Run state records `state.artifactsDir` and `state.steps[N].artifact` with forward slashes relative to project root.

### Scope & In-Scope Steps
- **Step 2 (Refinement):** `{slug}-step-2.md` contains metadata header, `## Decision Gaps & Resolutions` table, `## Decision Tree Walk` summary, `## Spec Observations` table, and `## Refined Spec Snapshot`.
- **Step 3 (DAG Generation):** `{slug}-step-3.md` contains metadata header, `## Complexity Analysis`, `## Task Decomposition` table, and `## Task Context Prompts` blocks.
- **Step 5 (Conformance Scoring):** `{slug}-step-5.md` contains metadata header, `## Implementation Summary`, `## Conformance Score` evaluation, `## Verified Acceptance Criteria`, `## Failing Acceptance Criteria`, and `## Feedback`.
- **Step 7 (Delegated Code Review):** `{slug}-step-7.md` is the `sdw-code-review` Markdown fix-plan report (header, findings table, detailed findings, fix plan) written via `--report`.
- **Excluded Steps:** Steps 1, 4, 6, and 8 do not emit step artifacts.

### Resumption & Overwrite Policy
- **Resumed Runs:** Reuses the existing `artifactsDir` from run state.
- **Step Re-execution:** Rewrites the existing step artifact deterministically within the same run.
- **Failure Policy:** Persistence is best-effort. Failures log a warning, record an error prefixed `Artifact persistence warning:` in `state.errors`, and continue workflow execution without changing run status.

## 6. Sequential Subagent Dispatch & Evidence Gate (Spec 028, supersedes Spec 015 handoff)

Step 4 turns each DAG task into a dispatched worker. Exactly one task is in flight at a time; the CLI is the sequencer and never spawns agents itself.

### Modes of Execution
- **Subagent Mode (`implementation.mode: "subagent"`, Default):**
  - `task next` renders `task-{taskId}.prompt.md`, records the dispatch, and returns one envelope.
  - Step 4 sets the run to `paused`, Step 4 to `awaiting_implementation`, and exits with code `4` (normal pause, not an error).
  - The host agent spawns exactly one worker for the envelope, waits for it, and submits `task finish`.
  - `task abandon --reason` releases a lost worker's task back to `pending`.
- **Command Mode (`implementation.mode: "command"`):**
  - Executes configured subprocess `implementation.command` sequentially in topological DAG order.
  - Substitutes tokens: `{taskId}`, `{promptFile}`, `{evidenceFile}`, `{workingDir}`, `{targetRoot}`, `{cwd}`, `{slug}`.
  - Sanitizes environment using allowlist (`PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `TEMP`, `TMP`, etc.) and injects `SDW_*` variables.
  - Corroborates task changes and evidence on zero exit status; creates no dispatch state.

### Step Progress Headers (Step 4)

Every visible transition prints one short, consistent header line, additive only over the existing detail lines:

- Run start: `[Step {current}/8] Run "<runId>" started (<specSlug>).`
- Run resume: `[Step {current}/8] Run "<runId>" resumed (<specSlug>).`
- Step entry: `[Step N/8] Entering Step N: <Name>.`
- Step completion: `[Step N/8] Completed Step N: <Name>.`
- Task dispatch: `[Step 4/8] Task {sequence}/{total} ({taskId}) dispatched.` on stdout, and on stderr when `--json` (so the JSON envelope on stdout stays parseable).
- Task accept: `[Step 4/8] Task {done}/{total} ({taskId}) accepted.` where `done` counts completed Step 4 tasks and `total` counts DAG tasks.

Headers are plain text for humans and grep. They change no exit code, no state file, and no scoped commit. Verification gates, scoring, delivery commit, review, and ship PR keep their current detail lines underneath the header.

### Dispatch Commands
- **Dispatch:** `node skills/sdw-orch/scripts/sdw_orch.cjs task next --run-id <runId> [--json]`
  - Rejects a second dispatch while one is in flight, naming the active task.
  - Rejects dispatch when every pending task is blocked, naming the missing dependency.
  - Reports exhaustion (and prints the `resume` command) once every task is `completed`.
- **Envelope:** `runId`, `specSlug`, `taskId`, `title`, `status`, `sequence`, `promptFile`, `promptBytes`, `evidenceFile`, `specPath`, `workingDir`, `acIds`, `dependencies`, `subagentBrief`, `finishCommand`.
- **Abandon:** `node skills/sdw-orch/scripts/sdw_orch.cjs task abandon --run-id <runId> --task <taskId> --reason "<why>"`
  - Returns the task to `pending`, appends to `steps["4"].dispatch.abandonments`, clears the active dispatch.
- **Queue depth:** `status` prints `Queue: {remaining} remaining` while any DAG task is incomplete.

### DAG Plan Contract & `dag preview`
- **Plan fields (Step 3 output):** `complexity` (`level`, `acCount`, detected `touchpoints`), `taskCount`, `execMode: "sequential"`, `levels` (one task-id list per wave), `fileDisjointness` (one `{ pair, disjoint, sharedFiles }` entry per task pair), and `tasks` (`id`, `coveredAcs`, `dependencies`, `level`, `parallelizable`, `targetFiles`). Run state keeps this object in `steps[3].output`, so complexity, task count, dependencies, and the execution mode are recorded together.
- **Wave levels and flags:** `level` is the longest dependency chain that precedes the task. A task is `parallelizable` only when it shares its wave with another task whose file slice is disjoint from its own; the flag never changes dispatch, which keeps exactly one task in flight (spec 00028 invariant).
- **Cap and split proposal:** a decomposition needing more than the effective cap is refused with `split-required tasks-needed=N cap=<effective>`. The effective cap is the `maxTasksPerSpec` configuration value (`.sdw/config.json`, integer 2-8, default 5; out-of-range values clamp to 2 and 8, and an absent key means five), so the default refusal remains `split-required tasks-needed=N cap=5`. The refusal carries `splitProposal` with two entries `{ slug: "<orig>-a" | "<orig>-b", acIds, targetFiles }`, partitioning criteria in declaration order and files in blueprint order. Step 3 is recorded `failed` with the refusal and no tasks, and no Step 3 artifact is written.
- **Preview:** `node skills/sdw-orch/scripts/sdw_orch.cjs dag preview [--json] [--spec <path>]`
  - Resolves the specification plus configuration, builds the blueprint through refinement heuristics, and prints the plan the classifier would emit. A missing specification exits `1` naming the path.
  - `--json` emits `{ complexity, execMode, taskCount, levels, tasks: [{ id, acIds, targetFiles, dependencies, level, parallelizable }] }`; a refused plan also emits `refused`, `tasksNeeded`, `cap`, and `splitProposal`, and exits `1`.
  - Pure: no run state, step artifact, branch, sandbox, registry row, or report is written or refreshed.

### Task Finish Subcommand
- **Command:** `node skills/sdw-orch/scripts/sdw_orch.cjs task finish --run-id <runId> --task <taskId> --evidence <evidencePath>`
- **Dispatch Gate:** Only the dispatched task may be finished; anything else is rejected with code 1 naming the active task.
- **Validation Rules:**
  - `taskId`: Must match target DAG task.
  - `status`: Required; `success`, `partial`, `failed`, or `blocked`. Only `success` is accepted.
  - `acIds`: Non-empty, and a subset of the criteria assigned to this task (`coveredAcs`). A criterion owned by another task is out of scope: the submission is rejected with code 1 and the task stays dispatched.
  - `filesChanged`: Non-empty array of project-relative paths (no absolute paths, no `..` traversal, no `.git/`), files must exist on disk or be git-tracked deletions.
  - `tests`: Optional or empty array `[]` for non-testable tasks (e.g. docs, configs).
  - `summary`: Non-empty string.
- **Change Corroboration:** Dispatch records a baseline of the already-dirty paths with a SHA-256 of each. In the primary tree, at least one `filesChanged` path must be dirty now and either clean at dispatch or with different content, so edits inherited from an earlier task never corroborate. Non-git workspaces fall back to existence. Empty worktrees in worktree mode are rejected with code 1.
- **DAG Dependency Gate:** Rejects completion if upstream DAG dependencies are not yet completed.

### Per-Task Checkpoint Save
- After acceptance, the orchestrator immediately saves the task in the primary tree instead of waiting for Step 6: one scoped commit of the corroborated `filesChanged`, message `task({specSlug}): {taskId}`.
- Scope is the Step 6 set: the same `isScopedExcluded` rules apply, so `.sdw/state/`, `.sdw/worktrees/`, `.sdw/sandbox/`, `.git/`, absolute paths, and `..` traversal are never committed. Unrelated dirty files stay uncommitted.
- The commit is tagged `sdw-checkpoint-{runId}-{taskId}` (`git tag -f`). The tag is the crash and reset recovery pointer: `git show <tag>:<path>` recovers accepted file content, and `git tag --list "sdw-checkpoint-*"` matches completed tasks in state.
- `steps[4].tasks[taskId]` records `commitSha` and `checkpointTag`. A task that accepted no file change (second-pass no-change) records `HEAD` and gets no tag.
- Worktree mode tags the cherry-picked integration commit (`HEAD` after integration) rather than creating a second commit, so the tag points into the accepted primary-branch history instead of the pre-integration worktree SHA; that worktree SHA stays recorded under `state.worktrees`.
- **Second pass excluded:** `--second-pass` runs keep a single `refine({slug}): second pass refinement` Step 6 commit, so `deliveryCommitCreated` still describes the refinement save.
- **Opt out:** `--no-task-checkpoint` skips the checkpoint commit and tag; the Step 6 delivery commit then remains the only save and `commitSha` records `HEAD` at acceptance.
- **Fail closed on the commit, warn on the tag:** a git failure creating the checkpoint commit rejects the task (`task finish` exits `1` with the git error) and leaves it dispatched for retry, because the work is still uncommitted and a retry can corroborate it. Once the commit exists (or, in worktree mode, the cherry-pick landed), committed work can never be re-corroborated, so a tag that cannot be written only warns: the task is accepted with its commit SHA recorded and `checkpointTag: null`.
- **Security gate first:** the same pre-commit secret scan as Step 6 runs before worktree integration and before the checkpoint commit when `securityChecksEnabled` is on (and `--skip-security` is absent), scanning the task worktree when worktrees are in use and the primary tree otherwise. A finding rejects the task with the scanner's exit code, creates no commit, cherry-pick, or tag, records `steps[4].securityGate`, and leaves the task dispatched so the worker can remove the secret.
- Worker prompts still forbid git mutation: the orchestrator owns this save, as it owns Step 6.

### Dispatch Prompt Contract
Sections in order: `## Task Context`, `## Description`, `## Assigned Acceptance Criteria`, `## Remaining Acceptance Criteria (do not regress)`, `## Target Files`, `## Scope Fence`, `## Dependency Context`, `## Prior Partial Progress`, `## Implementation Rules (sdw-rules)`, `## Test Discipline`, `## Prohibited Actions`, `## Evidence Schema`, `## Report Contract`, `## Finish Command`. Dependency context and prior progress are omitted when empty.

Every prompt opens its rules section by requiring the worker to load the shared `sdw-rules` skill (installed under `.agents/skills/sdw-rules/` or `skills/sdw-rules/`); the bullets that follow are a summary, never a replacement.

Prohibitions carried by every prompt: no `git commit`/`push`/`branch`/`checkout`/`worktree`/`tag`; no subagent spawning; no edits outside the scope fence; no edits to run state, prompt files, or the specification; no unexecuted test claims; no `status: "success"` while a criterion is unmet.

### Sequential Worktree Integration
- Task worktrees are created in `command` mode only; subagent mode records `worktreeSkipReason` and uses the primary tree.
- In worktree mode, task worktrees branch sequentially from latest primary tree `HEAD`.
- Task changes are committed inside the worktree (`task({specSlug}): {taskId}`).
- The commit is cherry-picked into the primary tree.
- On success, the worktree and branch are removed (`git worktree remove` and `git branch -D`).
- On conflict, execution halts with code 1 and preserves the worktree for inspection.

### Build & Test Verification Gates
- **Focused first, full last:** while iterating, a worker runs only the focused check for the files it touched (the covering test file, a single case, or `node --check` for syntax); it escalates to the full suite only for shared helpers, multi-task areas, or gate fixes outside task scope, recording the run and reason in evidence `tests`, and it runs the full suite once before reporting. The orchestrator runs the full suite once at the gates below.
- Once all DAG tasks complete, verification gates execute:
  - `verification.buildCommand` (or `requiredBuild` with `buildCommand`).
  - `verification.testCommand` (or `runAllTests` with `testCommand`).
- Supports automated surgical fix loop (up to 3 attempts) with pre-commit secret leak scan.
- Gate failures halt execution and record failed gate status in `state.steps[4].gates`.

### LLM-Judge Conformance Scoring (Step 5, Spec 027)
- The static evidence-count formula is gone. Scoring is delegated to an LLM judge invoked with a fenced context: the acceptance criteria plus the generated diff, never transcripts.
- **Judge resolution:** `scoring.judgeCommand` when configured (env `SDW_JUDGE_COMMAND` as fallback); otherwise the current agent model instance judges and submits.
- **Agent path:** Step 5 writes `step-5-judge.prompt.md`, sets `awaiting_judgment`, and exits with code `5`. The host judge writes `step-5-judge.verdict.json` and runs:
  `node skills/sdw-orch/scripts/sdw_orch.cjs score submit --run-id <runId> --verdict <path>`
- **Verdict contract:** integer `score` 0–10 plus a `verdicts` array covering every criterion exactly once with `verified`/`failed` and non-empty `evidence`. The score is derived from the per-criterion verdicts (`round(verified / total * 10)`); a divergent reported score is recorded as `judge.scoreMismatch`.
- **Criticity:** `scoring.judgeCriticity` = `permissive` | `strict` | `perfectionist` (default `strict`), quoted in the judge prompt with its rubric.
- **Fail closed:** 0 criteria scores 0/10 without invoking the judge; an unavailable judge command, a missing verdict file, or a malformed verdict scores 0/10 with an actionable error and exit code 2.
- Diff context is capped at 120000 bytes with an explicit truncation marker.


### Delivery Commit Guard (Step 6)
- Step 6 prints `[Step 6/8] Entering Step 6: Delivery Commit.` on entry and `[Step 6/8] Completed Step 6: Delivery Commit.` on completion, with the guard detail lines underneath, same header contract as Step 4.
- Delivery commit is refused if Step 4 is not `completed`, any DAG task is unaccepted, or any verification gate is not `passed`.
- **Registry untouched:** Step 6 never writes `index.specs.md` or the specification header. The registry transition belongs to Step 8, so a run that fails at Step 6 or 7 leaves the row unchanged (or `pending` where Step 1 normalized it).
- **Scoped commits only:** never run `git add -A`. Stage exactly the tracked spec files: accepted evidence `filesChanged` plus `index.specs.md`. Unrelated worktree changes are left uncommitted.
- Per-task checkpoint commits already cover accepted `filesChanged`, so Step 6 commits only what remains and records the current `HEAD` when nothing is left; the delivery state stays authoritative.
- Fixer, pre-PR, and review-fix commits stage only their own delta (`diffSinceSnapshot`) or fixer-touched files, never the whole tree.

### Delivery Pause & Registry Transition (Step 8)
- **Convergence pause:** failing checks or open review threads are a pause, not a failure. `sdw-ship-pr` reports `blocking: true`, Step 8 is recorded `blocked_convergence`, the run status is `paused`, and the command exits `6` with the pull request recorded. The host converges the pull request and resumes; the same run re-enters the delivery stage.
- **Transition order:** Step 6 creates the delivery commit without touching the registry; Step 8 marks the specification `completed` only after the delivery stage reports the delivery, or when `--skip-pr` is in effect. The header status is set to `implemented` in the same transition.
- **Failure before delivery:** the run leaves the registry row unchanged (or `pending` where Step 1 normalized it) and the header unchanged.
- **Stale-run rule for batch:** a delegated run echoes its `baseCommit`; a queue resuming an open run whose base commit is not an ancestor of the refreshed work lane must supersede it with `--new-run` instead of resuming it.

## 7. PR Delivery & Review Convergence Delegation (Step 8)

Step 8 delegates all final PR verification gates, remote publishing, SCM submission, and post-PR review convergence to the dedicated `sdw-ship-pr` skill.

### Delegation Contract
- **Invocation:** Dispatches `sdw-ship-pr` via CLI or programmatic runner:
  `node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --run-id <runId> --spec <slug> --root <targetRoot> [options]`
- **Responsibilities Delegated to `sdw-ship-pr`:**
  - Evaluation of pre-PR instructions and lifecycle commands (`prePrCommand`, `prePrInstructions`).
  - Pre-PR build and test verification gates (`requiredBuild`, `runAllTests`).
  - Remote branch pushing (`pushDelivery` or `--push`).
  - Pull request creation and idempotent reuse across SCM providers (`github`, `ado`, `none`). The PR base is `branching.integrationBranch`; an explicit `--base` and the legacy fallbacks keep lower priority.
  - Post-PR review convergence loop, remote CI polling, cooperative defect class fixing, and thread resolution.
  - Opt-in merge after convergence (`--merge` / `--allow-merge`): one SCM merge command, fire and forget. The outcome is recorded in `steps[8].output.merge` and never changes the delivery result, because permissions, approvals, and branch rules are operator concerns.
  - Post-merge synchronization when the pull request reaches `MERGED` and `branching.syncWorkBranchAfterMerge` is `true`: switch to the work lane, fast-forward it to the integration lane, then push it when `branching.pushSyncedWorkBranch` is `true`. A dirty tree or a non-fast-forward leaves every local branch untouched and records `branchingSync.status: "blocked"` with the reason; the delivery still succeeds.
- **Orchestrator Lifecycle Finalization:**
  - Consumes structured JSON report from `sdw-ship-pr`.
  - Records delivery outcome (`pullRequest`, `shipStatus`, `pushedBranch`, `reviewConvergence`, `branchingSync`) into `.sdw/state/{runId}.state.json`.
  - Transitions specification status to `completed` in `.sdw/specs/index.specs.md` after the delivery stage reports the delivery (or `--skip-pr`), and sets the specification header status to `implemented` in the same transition.

### Ship Model Hint (Spec 00056 AC7)

Step 8 applies the ship hint to the delivery and review-convergence dialogue: `models.ship`, falling back to `models.fixer`, then `models.default`, then the current session model. The resolved hint is printed as `[Step 8: PR Preparation] Ship model hint: ...` and recorded in `state.models.shipHint` and `steps[8].output.shipHint`, so the host routes the convergence session without changing the `sdw-ship-pr` CLI contract. A `null` hint means the session model and prints nothing; the hint stays advisory and never gates delivery.

## 8. Delegated Code Review via sdw-code-review (Step 7)

Step 7 delegates all working-tree review execution to the standalone `sdw-code-review` skill. The orchestrator holds no duplicated review instructions.

### Fresh-Context Isolation Contract
- **Rationale:** The orchestrator session normally authored the implementation under review. Reviewing that diff inside the originating reasoning context carries confirmation bias plus transcript contamination, and both depress defect detection; a newly spawned session sees only the delivered diff.
- **MUST:** spawn one context-fresh reviewer subagent session for every Step 7 verdict.
- **MUST NOT:** produce a Step 7 verdict by running the review CLI in the orchestrator session; same-session output is not a verdict.
- **Reviewer brief contents (allowlist):** target root, base reference, report path, scope fence.
- **Forbidden transcript contents (denylist):** implementation transcript, prior worker reasoning, DAG prompts, judge verdicts.
- **CLI placement:** `sdw_code_review.cjs run` executes inside the fresh reviewer session for a Step 7 verdict; standalone `doctor` plus `--dry-run` stay valid outside this rule.
- **Fixer separation:** remediation runs in a fresh `sdw-fixer` subagent session distinct from the reviewer session, never the same session. The reviewer that produced the findings MUST NOT approve fixer output; a fixer delivery is re-reviewed in a new context-fresh reviewer session.

### Delegation Contract
- **Invocation:** `node skills/sdw-code-review/scripts/sdw_code_review.cjs run --target <root> [--base <ref>] --report <artifactsDir>/<slug>-step-7.md [--fix] [--json]`
  (executed inside the fresh reviewer subagent session only; the orchestrator session never runs it for a verdict).
- **Base Resolution:** Explicit `--base` (run `baseCommit`) when available; otherwise `sdw-code-review` resolves `branching.integrationBranch` first, then auto-detects via config `baseBranch`, tracking remotes, local branches, merge-base, or initial commit.
- **Report Consumption:** Parses JSON (`passed`, `errorCount`/`criticalCount`, `warningCount`, `suggestionCount`, `blockingCount`, `findings` with `id`, `severity`, `path`, `rule`, `fix`, `status`).
- **Fix Iteration:** While blocking findings remain and fixable findings exist (up to 3 iterations): run with `--fix`, gate via `sdw-security-checks`, commit only fixer-touched files (`fix(<slug>): apply automated review fixes (iteration N)`), re-verify without `--fix`.
- **Outcome:** `passed` advances to Step 8; residual blocking records `review_failed` and halts; artifact path recorded in `state.steps[7].artifact`.

## 9. Second Pass / Refinement Mode (`--second-pass`, alias `--refine`)

Re-executes an already delivered specification in refinement mode instead of implementing it again.

- **Eligibility:** the registry must record the slug as `completed`/`archived`, or a completed run must carry a `deliveryCommit`. Otherwise the run refuses with exit `1` and writes no state.
- **Mode persistence:** `state.refineMode = true`, so `resume` continues as a second pass; `state.deliveryCommitCreated` records whether the pass produced a commit.
- **Steps 2-3:** decision-gap grilling and complexity DAG generation are replaced by one `task-refine` task whose `coveredAcs` are the specification's criteria, treated as the gap checklist and as must-keep-holding constraints.
- **Step 4:** the dispatch prompt gains a `## Second Pass (Refinement) Mode` section: audit each criterion against the delivered code and tests, implement what is missing, partial, or drifted (including stale docs, config, schema, and tests), then simplify inside the same specification scope. Empty change is allowed only when every criterion already holds and no drift remains; the summary must list gaps, drift, and opportunities considered. `task finish` accepts `filesChanged: []` in this mode.
- **Gap closure:** a second pass is not simplification-only. A delivered feature that does not fully satisfy its specification is repaired here, without adding behavior the specification does not require.
- **No change:** Steps 5-8 are marked `skipped`, the report is written, `status: completed`, exit `0`, and `options._runResult.refineOutcome = "no-change"`.
- **Changed:** Step 5 scoring and Step 7 review run normally against `state.baseCommit` (the prior delivery commit when discoverable, so the judge sees the delivered implementation, not only the delta). Step 6 commits as `refine({slug}): second pass refinement`, never rewrites `index.specs.md`, and Step 8 runs only when `state.deliveryCommitCreated === true`.
- **Report:** `{slug}-refine.md` in the run artifacts directory, always written, with outcome, base commit, files changed, score, summary, and criteria. Path stored in `state.refineReport`.
- **Boundary:** `sdw-batch` never refines; it skips delivered specs and requires a manual single-spec call for a second pass.

## 10. Dry Run & Sandbox Isolation (Spec 029)

`--dry-run` and `--sandbox` answer two different questions and are mutually exclusive.

### Plan-Only Dry Run (`--dry-run`)
- `run <specPath> --dry-run` validates the specification in authoring mode and prints the plan: spec path and slug, target root, scoring/delivery/branch settings, the resolved branch plan, the eight step names, one line per spec observation, and `No steps executed (--dry-run).`
- The branch plan prints `Strategy: <preset>`, `Start lane: <branch> (update: yes|no)`, `Feature branch: <prefix><slug>`, `Pull request target: <integration branch>`, and `After merge: <actions>`, all resolved from configuration without executing git commands.
- The model block prints one `Models detection: enabled=<yes|no> status=<status> source=<source> transport=<transport> key=<key> command=<command|none>` line plus one `Model hint <role>: <hint|session model>` line for `orchestrator`, `worker`, `reviewer`, `fixer`, `judge`, `ship`, and `retro` (spec 00056 AC13). Each hint line shows the role fallback chain result, so an absent role entry prints the `models.default` value and a completely unconfigured role prints `session model` (AC14). A cached hit that would adapt an unavailable hint prints `(requested <model>)`.
- The model block is read-only: `--dry-run` reads `.sdw/host-capabilities.json` without probing, writing the cache, or creating run state. `status`/`source` print `skipped` when detection is disabled or `--no-model-detect` is passed, `hit` when a valid cache entry exists for the session key, and `probe` when Step 1 would probe; the extra line `probe not executed (--dry-run)` then states that the hints stay static.
- It creates no run state, no artifacts, no branches, no worktrees, and no clones. Exit code `0` when the spec validates, `1` when it does not.

### Sandbox Execution (`--sandbox`)
- **Layout:** `{sandboxDir}/{runId}/repo` (clone), `sandbox.json` (metadata), `report.md` (report). `sandboxDir` comes from `.sdw/config.json` (default `{projectRoot}/.sdw/sandbox`, tokens `{projectRoot}`, `{skillsRoot}`, `{temp}`); a custom value must resolve outside the project root and is validated by `sdw-config check`. The clone contains `.sdw/sandbox/.sandbox-marker.json` pointing back to the source root.
- **Creation:** `git clone --no-local --depth 1 --single-branch --branch <sourceBranch> <sourceRoot> <clone>` from committed `HEAD`, `git switch -c sdw-sandbox/{runId}`, `git remote remove origin`, then an optional `node_modules` junction and a copy of the target specification when it is not committed (`specCopied: true`). `--no-local` is required because git ignores `--depth` for local clones; a shallow single-branch clone is enough because the sandbox only walks forward from `HEAD`. Detached `HEAD` clones without `--branch`, and a mismatch falls back to a full local clone checked out at the exact commit (`clone.fallback: true`).
- **Execution:** every step runs with the clone as project root. Run state and artifacts live in the clone, so the source `.sdw/state` is untouched and `status`/`resume` on the source never see sandbox runs.
- **Delivery isolation:** `pushDelivery` and `scmProvider` are forced off in memory, Step 8 invokes `sdw-ship-pr --dry-run` without `--push`, and the removed `origin` blocks accidental pushes. Real verification comes from the Step 4 gates; `sdw-ship-pr` simulates its own pre-PR command/build/test gates under `--dry-run`.
- **Dirty source:** the clone is cut from the commit, so uncommitted work is excluded; the CLI warns and records `baselineDirty: true`.
- **Paths:** dispatch envelopes and task prompts print absolute sandbox paths, the working directory is the clone root, and `task finish` / `resume` commands carry `--root <clonePath>`.
- **Lifecycle:** `sandbox list`, `sandbox report --run-id`, `sandbox clean --run-id`. The report is refreshed after `run`, `resume`, and `task finish`; cleanup is always proposed, never automatic, and keeps `sandbox.json` plus `report.md`. Creation halts when the resolved target directory already exists, naming the `sandbox clean --run-id` command; `sandbox clean` also removes an orphaned target left by an interrupted creation (no metadata).
- **Limits:** a clone is a filesystem and git boundary, not a security sandbox. Worker commands still run with the host credentials and network.

## 11. Delivery Report & Spec Observations (Spec 00054)

### Delivery Report

After Step 7 resolves and before Step 8 delegates to `sdw-ship-pr`, the run writes `.sdw/reports/{specFileNameWithoutExtension}-report.md` (`.sdw/specs/00054-example.md` -> `.sdw/reports/00054-example-report.md`, with the directory created when it is absent) and records its project-relative path in `state.deliveryReport`. A report is a delivery artifact, not a specification, so it never lives in the specification directory; the in-progress copy stays under the run artifact directory (spec 00060). The run commits the report with a scoped commit (`docs({specSlug}): record delivery report`) that stages only that file, whenever it is written; the commit never rewrites the Step 6 delivery commit. `--skip-pr` and second-pass runs commit it too, so `HEAD` is the report commit after any run that wrote one, while the Step 6 delivery or `refine({slug})` commit stays intact beneath it.

Template order:

1. `# Delivery Report — {specTitle}`
2. `## Metadata`: specification file and slug, run id, run status, branch, base branch, base commit, delivery commit, ship status, score / `scoreMin`, implementation start (first dispatch), implementation end (last acceptance), total wall-clock duration, and one row per step with its duration.
3. `## Tasks`: `id | title | status | covered ACs | checkpoint commit | started | completed | duration`.
4. `## Commits`: `git log --format='%h %s' <baseCommit>..HEAD`, plus the delivery commit when it is outside that range.
5. `## Files Changed`: change type from `git diff --name-status <baseCommit>..HEAD`, grouped by the task whose `filesChanged` names the path; a file owned by several tasks lists under each.
6. `## Verification`: Step 4 gate status, exit code, and duration, plus the Step 8 delivery status.
7. `## Code Review`: Step 7 status, result, findings by severity, blocking count, and report path.
8. `## Conformance Judgment`: the Step 5 score, the required minimum, the verified and failed counts, and one row per criterion with its verdict and evidence.
9. `## Judge Analysis`: the Step 5 judge `summary`, `risks`, and `followUps`, attributed to the judge and marked advisory.
10. `## Learnings`: every `learning` contribution with its kind, slug, severity, recording step, applying step with its evidence, and path patterns.
11. `## Retrospective`: the retrospective status, signals, candidates with their routes, applied fixes, and queued specifications.
12. `## Breaking Changes`: deterministic candidates from `.sdw/config.json` and `.sdw/config.schema.json` key diffs, added or removed CLI flags in `skills/*/scripts/*.cjs`, configuration schema property changes, and renamed or deleted files under `skills/`; each cites its diff path, and an empty set renders `None detected`.
13. `## Quality`: conformance score, judge verdict counts, review findings by severity, executed test totals from task evidence, and gate statuses.
14. `## Spec Observations`: the Step 2 observations.
15. `## Notes`: `state.errors`, skipped steps, abandoned and re-dispatched tasks, security-gate bypasses, and recorded environment facts.
16. `## Outcome`: run status, delivery commit, ship status, and duration.
17. `## Step Contributions`: one subsection per step in pipeline order (`1`-`9`), each listing its contributions, with `Not available` for a step that contributed nothing.

The report reads recorded evidence only; it never re-runs a gate or a review. A write or commit failure appends a warning to `state.errors` and the run continues without failing delivery. A resumed run rewrites the same companion path from current run state; it never appends a second report.

### Spec Observations

Step 2 records advisory `specObservations` in `steps[2].output` and in the `{slug}-step-2.md` artifact (`## Spec Observations`). Each entry carries `kind`, `otherSpec`, `evidence`, and `severity`. The rules are file-content heuristics that stay explainable from the evidence they cite:

- `overlap`: another specification with registry status `completed` or `implemented` names a target file also named by this specification. `evidence` names both specifications and the shared file.
- `superseded`: another specification names this specification's slug, id, or numeric prefix on a line that contains `supersedes`, `superseded by`, `replaces`, `replaced by`, `abandoned in favor of`, or `will not implement`. `evidence` names the other specification and the matched reference.
- `conflict`: this specification and another declare the same key (a key present in `.sdw/config.json`) with different values, for example `scoreMin: 9` versus `scoreMin: 7`. `evidence` names both specifications, the key, and both values.

Target files are the backticked project-relative paths that contain a `/` and a file extension, the same extraction [`spec_grilling.cjs`](../scripts/spec_grilling.cjs) supplies to the Step 2 blueprint. `severity` is `high` only when the other specification is already delivered and shares target files; otherwise `medium`. Observations never fail validation, rewrite a specification, or block or alter a run. `--dry-run` prints each observation and writes no report or Step 2 artifact.

## 12. Step Contributions, Learnings & Retro Closure (Spec 00057)

### Contribution Contract

The report is incremental: each step appends one entry to `state.reportContributions` as the step happens, and both report paths are re-rendered from the whole list at that boundary (`refreshInProgressReport`). An entry is `{ step, stepName, at, kind, title, body, evidence: [] }`; it is appended, never rewritten, and ordered by `step` ascending, then `at`, then insertion order. Step `9` is `retrospective`, the post-delivery contribution.

Kinds and owning steps: `derivation` (1), `refinement` (2), `plan` (3), `task` (4, one per accepted task), `verdict` and `judgment` (5), `learning` (any step that records memory), `delivery` (6), `review` (7, one per iteration), `gates` and `ship` (8), `convergence` (8, one per delivery attempt), `checkpoint` and `turn_paused` (any step, spec 00019 telemetry), `retro` (9), and `warning` (any step).

- A malformed entry is skipped by the renderer, recorded once as a warning in `state.errors`, and the remaining contributions still render.
- A section whose contributions are absent renders `Not available`; reporting never blocks delivery.
- The writer is atomic (sibling temp file, then rename), deterministic, and offline: it renders recorded values only and never calls a language model.
- `--dry-run` prints the contribution summary and the planned kinds per step, and writes no report, state, or artifact.
- `report re-render --run-id <runId>` refreshes both paths from run state. It never commits, pushes, or amends: when the branch was already pushed, the refreshed companion stays uncommitted and the pushed commit is untouched.

### Judge Verdict & Analysis

`score submit` accepts a verdict file with `score`, `verdicts[]`, and the optional advisory fields:

```json
{
  "score": 9,
  "verdicts": [{ "id": "AC1", "verdict": "verified", "evidence": "path:line" }],
  "summary": "One paragraph on what the delivery did and how well it honours the specification.",
  "risks": [{ "severity": "medium", "evidence": "path:line", "note": "what a reviewer should scrutinize" }],
  "followUps": ["candidate next step"]
}
```

The score derives from the per-criterion verdicts alone. The analysis is persisted as the `verdict` and `judgment` contributions; the report renders it under `## Judge Analysis`, attributed to the Step 5 judge and marked advisory, and it never feeds the score, a gate, the review, or a halt decision.

### Learning Contract

Every `sdw-memory record` a run performs names the run:

```bash
node skills/sdw-memory/scripts/sdw_memory.cjs record --kind trap --title "..." --avoid "..." --action "..." \
  --paths skills/sdw-orch/scripts/sdw_orch.cjs --run <runId> --step <n>
```

The record appends one `learning` contribution (`{ step, stepName, at, kind: 'learning', title, body, evidence }`) whose body carries `{ kind, slug, title, severity, layer, pathPatterns, backend, appliedBy }`, and writes the same entry to the run-scoped index `.sdw/state/{slug}/{runId}/learnings.json`. The index is append-only and is the queryable source while the run is in progress, including when no memory backend is reachable (the body's `backend` is then `unavailable`).

- Digest rule: before a step acts, the orchestrator selects the run-scoped learnings whose `pathPatterns` match the files the step will touch, orders them by severity then recording step, caps the list, and passes it with the dispatch prompt (`## Run Learnings (apply before acting)`) and the dispatch envelope. A step with no matching learning proceeds unchanged.
- Application evidence: the step that applies a learning records the applying step and one evidence locator with `sdw-memory apply --run <runId> --slug <slug> --step <n> --evidence <locator>`. The `## Learnings` section distinguishes a recorded learning from one that changed the run.
- `sdw-memory query "<text>" --run <runId>` answers from the run-scoped index merged with the enabled backends, so a step sees the in-run entries before the durable vault.

### Retrospective Contribution

When `sdw-retro` completes, the run appends the `retro` contribution with the signals, the candidates, the applied fixes, and the queued specifications, and re-renders both report paths. The retrospective applies every fix its routes allow: it records the memory entries its candidates call for, consolidates duplicate entries, and queues a follow-up specification for each candidate that needs a code change. A candidate that needs a change under `skills/` or `tests/` is routed to a specification and named; the file is never edited. The applied fixes and each routed candidate are recorded on the retro report under `fixes` and `routedCandidates`.

### Retro Model Hint (Spec 00056 AC8)

When `retro.enabled` runs the analysis after delivery, the retrospective applies the retro hint: `models.retro`, falling back to `models.default`, then the current session model. The resolved hint is printed as `[sdw-retro] Retro model hint: ...` and recorded in `state.models.retroHint`; a `null` hint means the session model and prints nothing. The hint routes the analysis session only: it never changes the retro outcome, the recorded candidates, or the completed delivery, and a retro failure still leaves the run `completed`.

### Reference

- Pre-PR gate contract, convergence, and the merge policy: [`../../sdw-ship-pr/references/ship_protocol.md`](../../sdw-ship-pr/references/ship_protocol.md)
- Memory entry kinds, backends, and the run-scoped index: [`../../sdw-memory/references/memory_protocol.md`](../../sdw-memory/references/memory_protocol.md)
- Candidate shape, routes, and the specification boundary: [`../../sdw-retro/references/candidate_contract.md`](../../sdw-retro/references/candidate_contract.md)

## 13. Acceptance Criteria Ledger (Spec 00017)

Every run owns one ledger at `{artifactsDir}/ac-ledger.json` (`.sdw/state/{slug}/{runId}/ac-ledger.json`). It is the single source of truth for AC status and evidence: Step 4 links task evidence into it, Step 5 derives its score from it, and nothing else may author a score.

### Schema

```json
{
  "runId": "run-1792400000000-feature",
  "specSlug": "feature",
  "generatedAt": "2026-10-19T12:00:00.000Z",
  "criteria": [
    {
      "id": "AC1",
      "text": "The system shall support handoff and command modes.",
      "status": "verified",
      "evidence": [
        { "type": "file", "path": "skills/sdw-orch/scripts/implementation_runner.cjs", "taskId": "task-1" },
        { "type": "commit", "sha": "a1b2c3d", "taskId": "task-1" }
      ]
    }
  ]
}
```

- One record per declared criterion, in specification order. `status` is `unverified` (no evidence), `verified` (at least one evidence entry proves it), or `failed` (a Step 5 judge verdict rejected it; its evidence is kept but never counted).
- Evidence types: `file` (`path`), `test` (`name`, `status`), `commit` (`sha`), `review`/`sabotage` (`id`, optional `status`). Any other type is refused with the allowed enum.
- Entries are append-only and de-duplicated by type plus stable identity (`path`, test `name`, `sha`, review or sabotage `id`). Re-linking the same fact is a no-op: the ledger and its anchor stay unchanged, so replaying a link or a Step 4 acceptance never duplicates evidence.
- File paths are stored project-relative with forward slashes; a path outside the project root is refused.

### Commands

```bash
node skills/sdw-orch/scripts/sdw_orch.cjs ledger link --run-id <id> --ac AC1 AC2 --type test --name "ledger contract" --status passed
node skills/sdw-orch/scripts/sdw_orch.cjs ledger link --run-id <id> --ac AC3 --type file --path skills/sdw-orch/scripts/ac_ledger.cjs
node skills/sdw-orch/scripts/sdw_orch.cjs ledger report [--run-id <id>] [--format md|json]
node skills/sdw-orch/scripts/sdw_orch.cjs ledger audit --run-id <id> [--format md|json]
```

- `ledger link` appends one typed payload to one or more declared AC ids. An unknown AC id or invalid payload leaves the ledger byte-for-byte unchanged and exits `1`.
- `ledger report` renders every record with its status and evidence as Markdown or JSON.
- `ledger audit` lists the criteria that carry no evidence and exits `1` while any remain, so an unproven AC is visible without reading the JSON.
- Step 4 acceptance links each accepted `filesChanged` path and its checkpoint commit SHA with the task id; Step 5 records one `review` entry per criterion (`step5-<judge>`) and updates it on re-judge.

### Hash Anchor

- After every accepted update, run state stores `acLedgerPath` and `acLedgerSha256` (SHA-256 over canonical JSON: object keys sorted at every depth, array order preserved).
- Verification compares the recorded digest with the ledger file before Step 5 scoring and at `score submit`. A mismatch fails Step 5 closed (score `0`, exit `2`, `reimplementation_needed`) and blocks Step 6. It never repairs the ledger or rewrites the anchor. A run with no ledger, or no recorded anchor, is not a mismatch.
- Ledger initialization failure at run start fails the run before Step 1 completes: exit `1`, a message naming the artifact directory and ledger path, and a `Remediation:` line. Resume reads an existing ledger, never re-seeds its criteria, and appends new evidence.

### Score Derivation

- `evidencedCount` counts records with at least one evidence entry; `verifiedCount` counts those whose status is `verified`. A `failed` judge verdict is excluded even when earlier file, test, or commit evidence exists.
- `score = round(verifiedCount / totalAcs * 10)`, clamped to 0-10. A specification with zero criteria scores `0` and fails closed.
- Negative-scenario cap: when any criterion declares a negative scenario (its text, or a test evidence name, names a failing, invalid, rejected, unknown, missing, mismatch, or error case) and has no observed passing `test` evidence, the score is capped at 8. Step 5 reports the cap, the uncapped score, and the reasons.




