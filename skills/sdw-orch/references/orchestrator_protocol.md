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
  "score": 9,
  "scoreIteration": 1,
  "reviewIteration": 1,
  "dagTasks": [],
  "steps": {
    "1": { "name": "derivation", "status": "completed", "output": {} },
    "2": { "name": "grilling", "status": "completed", "output": {} },
    "3": { "name": "dag_generation", "status": "completed", "output": {} },
    "4": {
      "name": "implementation",
      "status": "completed",
      "output": {},
      "dispatch": { "activeTaskId": null, "sequence": 2, "dispatchedAt": null, "abandonments": [] },
      "tasks": {
        "task-1": { "status": "completed", "filesChanged": ["src/a.ts"], "acIds": ["AC1"], "summary": "..." }
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

## 2. 8-Step State Machine

1. **Derivation:** Identifies whether the spec is already agent-ready (EARS ACs, DoR, YAML frontmatter). Skips derivation if ready; otherwise reformulates human stories.
2. **Grilling:** Walks the decision tree covering input bounds, failure scenarios, and concurrency. Auto-resolves known gaps or prompts user via `ask_question` with recommended defaults.
3. **DAG Generation:** Analyzes complexity (file count, touchpoints) and decomposes requirements into 1 or more atomic tasks.
4. **Implementation Dispatch:** Sequentially dispatches one DAG task at a time to a single worker, with a complete brief (criteria, scope fence, prohibitions, evidence contract) instead of the orchestrator's transcript.
5. **Conformance Scoring:** An LLM judge fences the criteria plus the generated diff, emits a 0-10 score with per-criterion verdicts. If the score is below threshold (default 8/10), feedback triggers the re-implementation loop.
6. **Delivery Commit:** Creates an atomic, structured git commit for verified code.
7. **Delegated Code Review via sdw-code-review:** Dispatches subagent or CLI runner for `sdw-code-review`; inspects the generated JSON report (`passed`, `errorCount`, `warningCount`, `suggestionCount`, `findings`) to advance to Step 8, iterate surgical fixes (up to 3 attempts with security gate and scoped fix commits), or pause on residual blocking findings. `sdw-code-review` is the sole review authority.
8. **PR Preparation, Delivery & Code Review Convergence:** Assembles pull request metadata, marks the spec completed, pushes the active branch to remote origin (when `--push` or `pushDelivery` enabled), opens or reuses the pull request via the SCM provider contract, and executes the post-delivery review convergence loop (monitoring CI checks and automated code reviews to fix comments until green).

## 3. Multi-Specification Batch Queue Lifecycle (`.sdw/state/batch-{batchId}.json`)

When multiple specifications are provided to `sdw-orch run <spec1> <spec2> ...`, queue state is managed through a batch manifest:

```json
{
  "batchId": "batch-1792386000000",
  "createdAt": "2026-10-19T00:55:00.000Z",
  "updatedAt": "2026-10-19T00:58:00.000Z",
  "status": "in_progress",
  "policy": {
    "continueOnError": false,
    "syncIndex": true
  },
  "total": 2,
  "currentIndex": 0,
  "queue": [
    {
      "index": 0,
      "spec": ".sdw/specs/001-feature-a.md",
      "slug": "001-feature-a",
      "status": "completed",
      "runId": "run-1792386010000-001-feature-a",
      "branch": null,
      "deliveryCommit": "a1b2c3d",
      "durationMs": 4200,
      "error": null
    },
    {
      "index": 1,
      "spec": ".sdw/specs/002-feature-b.md",
      "slug": "002-feature-b",
      "status": "pending",
      "runId": null,
      "branch": null,
      "deliveryCommit": null,
      "durationMs": null,
      "error": null
    }
  ]
}
```

### Batch Operational Guarantees:
- **Pre-Flight Disk Validation:** Rejects execution before creating manifests if any queued specification file is missing on disk.
- **Side-Effect-Free Dry-Run:** `--dry-run` validates all specifications and emits the execution plan without creating files or writing state.
- **Sequential Context Isolation:** Each specification runs in an independent child run context with its own distinct `runId` and `.state.json` file.
- **Deterministic Resumption:** `resume-batch [batchId]` skips completed items and resumes strictly from the first pending or failed item.
- **Index Synchronization:** Automatically executes `sdw-spec sync` upon each item completion unless `--no-sync` is specified.

## 4. Unattended Multi-Specification Execution Protocol

When multiple specifications are queued (`sdw-orch run spec1 spec2 ...` or `resume-batch`):
- **Unattended Execution Contract:** The orchestrator and executing agent operate strictly in non-interactive, unattended mode. No pauses or conversational confirmation queries are permitted between queue items.
- **Autonomous Decision Resolution:** Grilling/Refinement decision gaps in Step 2 automatically select recommended defaults (`autoResolveGaps: true`, `abortOnGaps: false`), eliminating pauses.
- **Per-Specification Isolation:** Each specification runs in its own child context with isolated run state (`run-*.state.json`), maintaining clean subagent context fencing.
- **Autonomous Delivery & Synchronization:** Upon successful implementation and verification (conformance score ≥ threshold, tests passing, review clean), the orchestrator stages the delivery commit, updates `index.specs.md` to `completed`, syncs via `sdw-spec sync`, and immediately initiates the next queued specification.
- **Halting vs Continuation:** Default policy halts execution on specification failure, saving batch state for `resume-batch`. When `--continue-on-error` is active, errors are logged in the manifest and the queue advances uninterrupted to the next item.
- **Terminal Consolidated Summary:** The orchestrator emits the batch manifest summary report only once all queued items have completed or halted.

## 5. Branch & Worktree Strategy Protocol

Configurable feature branch activation and per-task isolated git worktrees:

### Feature Branch Lifecycle (`useFeatureBranches: true`)
- **Activation:** No working-tree cleanliness gate. Execution proceeds independently of git state; dirty trees never block, refuse, or halt a run.
- **Naming:** Derives branch name `feature/{specSlug}`.
- **Switch/Reuse:** If `feature/{specSlug}` already exists, switches to it and marks `branchReused: true`. Otherwise, creates and switches to `feature/{specSlug}` from the resolved base branch.
- **Metadata:** Records `branch`, `baseBranch`, and `branchReused` in state. Step 8 PR payload includes `head: branch` and `base: baseBranch`.

### Per-Task Worktree Lifecycle (`useWorktrees: true`)
- **Preconditions:** Verifies git availability, repository initialization, and writability of `.sdw/worktrees/`.
- **Trivial Skip Rule:** If DAG tasks count === 1 and complexity is `low` or `simple`, skips worktree creation (`reason: "single low-complexity task"`).
- **Creation:** For each DAG task, creates an exclusive worktree:
  `git worktree add .sdw/worktrees/{runId}/{taskId} -b task/{runId}/{taskId} HEAD`
- **Execution & Integration:** Subagent implements in the worktree. Changes are committed inside the worktree (`task({specSlug}): {taskId}`) and integrated into the primary working tree via `git cherry-pick <commitSha>`.
- **Conflict Handling:** Cherry-pick conflicts halt execution with exit code 1; the conflicted worktree is preserved for operator inspection.
- **Clean Removal:** Once integrated, removes worktree via `git worktree remove` and deletes task branch via `git branch -d`.
- **Overrides:** `--no-worktrees` and `--no-feature-branch` flags override configuration for the current run.

## 6. Step Artifacts Persistence Protocol

Intermediate outputs of human-auditable steps (2, 3, 5) are persisted as human-readable Markdown files:

### Directory Layout & Filename Convention
- **Directory:** `{stateDir}/{slug}/{runId}/` (e.g. `.sdw/state/014-sdw-orch-step-artifacts-persistence/run-1792400000000-014-sdw-orch-step-artifacts-pe/`)
- **Naming:** `{slug}-step-{N}.md` (e.g. `014-sdw-orch-step-artifacts-persistence-step-2.md`, `...-step-3.md`, `...-step-5.md`)
- **State Linkage:** Run state records `state.artifactsDir` and `state.steps[N].artifact` with forward slashes relative to project root.

### Scope & In-Scope Steps
- **Step 2 (Refinement):** `{slug}-step-2.md` contains metadata header, `## Decision Gaps & Resolutions` table, `## Decision Tree Walk` summary, and `## Refined Spec Snapshot`.
- **Step 3 (DAG Generation):** `{slug}-step-3.md` contains metadata header, `## Complexity Analysis`, `## Task Decomposition` table, and `## Task Context Prompts` blocks.
- **Step 5 (Conformance Scoring):** `{slug}-step-5.md` contains metadata header, `## Implementation Summary`, `## Conformance Score` evaluation, `## Verified Acceptance Criteria`, `## Failing Acceptance Criteria`, and `## Feedback`.
- **Step 7 (Delegated Code Review):** `{slug}-step-7.md` is the `sdw-code-review` Markdown fix-plan report (header, findings table, detailed findings, fix plan) written via `--report`.
- **Excluded Steps:** Steps 1, 4, 6, and 8 do not emit step artifacts.

### Resumption & Overwrite Policy
- **Resumed Runs:** Reuses the existing `artifactsDir` from run state.
- **Step Re-execution:** Rewrites the existing step artifact deterministically within the same run.
- **Failure Policy:** Persistence is best-effort. Failures log a warning, record an error prefixed `Artifact persistence warning:` in `state.errors`, and continue workflow execution without changing run status.

## 7. Sequential Subagent Dispatch & Evidence Gate (Spec 028, supersedes Spec 015 handoff)

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

### Dispatch Commands
- **Dispatch:** `node skills/sdw-orch/scripts/sdw_orch.cjs task next --run-id <runId> [--json]`
  - Rejects a second dispatch while one is in flight, naming the active task.
  - Rejects dispatch when every pending task is blocked, naming the missing dependency.
  - Reports exhaustion (and prints the `resume` command) once every task is `completed`.
- **Envelope:** `runId`, `specSlug`, `taskId`, `title`, `status`, `sequence`, `promptFile`, `promptBytes`, `evidenceFile`, `specPath`, `workingDir`, `acIds`, `dependencies`, `subagentBrief`, `finishCommand`.
- **Abandon:** `node skills/sdw-orch/scripts/sdw_orch.cjs task abandon --run-id <runId> --task <taskId> --reason "<why>"`
  - Returns the task to `pending`, appends to `steps["4"].dispatch.abandonments`, clears the active dispatch.

### Task Finish Subcommand
- **Command:** `node skills/sdw-orch/scripts/sdw_orch.cjs task finish --run-id <runId> --task <taskId> --evidence <evidencePath>`
- **Dispatch Gate:** Only the dispatched task may be finished; anything else is rejected with code 1 naming the active task.
- **Validation Rules:**
  - `taskId`: Must match target DAG task.
  - `status`: Required; `success`, `partial`, `failed`, or `blocked`. Only `success` is accepted.
  - `acIds`: Non-empty subset of specification ACs.
  - `filesChanged`: Non-empty array of project-relative paths (no absolute paths, no `..` traversal, no `.git/`), files must exist on disk or be git-tracked deletions.
  - `tests`: Optional or empty array `[]` for non-testable tasks (e.g. docs, configs).
  - `summary`: Non-empty string.
- **Change Corroboration:** In the primary tree, at least one `filesChanged` path must be modified *after* the dispatch timestamp, so edits inherited from an earlier task never corroborate. Non-git workspaces fall back to existence. Empty worktrees in worktree mode are rejected with code 1.
- **DAG Dependency Gate:** Rejects completion if upstream DAG dependencies are not yet completed.

### Dispatch Prompt Contract
Sections in order: `## Task Context`, `## Description`, `## Assigned Acceptance Criteria`, `## Remaining Acceptance Criteria (do not regress)`, `## Target Files`, `## Scope Fence`, `## Dependency Context`, `## Prior Partial Progress`, `## Prohibited Actions`, `## Evidence Schema`, `## Report Contract`, `## Finish Command`. Dependency context and prior progress are omitted when empty.

Prohibitions carried by every prompt: no `git commit`/`push`/`branch`/`checkout`/`worktree`/`tag`; no subagent spawning; no edits outside the scope fence; no edits to run state, prompt files, or the specification; no unexecuted test claims; no `status: "success"` while a criterion is unmet.

### Sequential Worktree Integration
- Task worktrees are created in `command` mode only; subagent mode records `worktreeSkipReason` and uses the primary tree.
- In worktree mode, task worktrees branch sequentially from latest primary tree `HEAD`.
- Task changes are committed inside the worktree (`task({specSlug}): {taskId}`).
- The commit is cherry-picked into the primary tree.
- On success, the worktree and branch are removed (`git worktree remove` and `git branch -D`).
- On conflict, execution halts with code 1 and preserves the worktree for inspection.

### Build & Test Verification Gates
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
- Delivery commit is refused if Step 4 is not `completed`, any DAG task is unaccepted, or any verification gate is not `passed`.
- **Scoped commits only:** never run `git add -A`. Stage exactly the tracked spec files: accepted evidence `filesChanged` plus `index.specs.md`. Unrelated worktree changes are left uncommitted.
- Fixer, pre-PR, and review-fix commits stage only their own delta (`diffSinceSnapshot`) or fixer-touched files, never the whole tree.

### Batch Queue Pause
- When a batch item halts with code 4 (`awaiting_implementation`), the batch queue pauses, marks the item `awaiting_implementation`, saves manifest with status `paused`, and exits with code 4.

## 8. PR Delivery & Review Convergence Delegation (Step 8)

Step 8 delegates all final PR verification gates, remote publishing, SCM submission, and post-PR review convergence to the dedicated `sdw-ship-pr` skill.

### Delegation Contract
- **Invocation:** Dispatches `sdw-ship-pr` via CLI or programmatic runner:
  `node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --run-id <runId> --spec <slug> --root <targetRoot> [options]`
- **Responsibilities Delegated to `sdw-ship-pr`:**
  - Evaluation of pre-PR instructions and lifecycle commands (`prePrCommand`, `prePrInstructions`).
  - Pre-PR build and test verification gates (`requiredBuild`, `runAllTests`).
  - Remote branch pushing (`pushDelivery` or `--push`).
  - Pull request creation and idempotent reuse across SCM providers (`github`, `ado`, `none`).
  - Post-PR review convergence loop, remote CI polling, cooperative defect class fixing, and thread resolution.
- **Orchestrator Lifecycle Finalization:**
  - Consumes structured JSON report from `sdw-ship-pr`.
  - Records delivery outcome (`pullRequest`, `shipStatus`, `pushedBranch`, `reviewConvergence`) into `.sdw/state/{runId}.state.json`.
  - Transitions specification status to `completed` in `.sdw/specs/index.specs.md`.

## 9. Delegated Code Review via sdw-code-review (Step 7)

Step 7 delegates all working-tree review execution to the standalone `sdw-code-review` skill. The orchestrator holds no duplicated review instructions.

### Delegation Contract
- **Invocation:** `node skills/sdw-code-review/scripts/sdw_code_review.cjs run --target <root> [--base <ref>] --report <artifactsDir>/<slug>-step-7.md [--fix] [--json]`
  (or inline in the host agent with the same CLI contract).
- **Base Resolution:** Explicit `--base` (run `baseCommit`) when available; otherwise `sdw-code-review` auto-detects via config `baseBranch`, tracking remotes, local branches, merge-base, or initial commit.
- **Report Consumption:** Parses JSON (`passed`, `errorCount`/`criticalCount`, `warningCount`, `suggestionCount`, `blockingCount`, `findings` with `id`, `severity`, `path`, `rule`, `fix`, `status`).
- **Fix Iteration:** While blocking findings remain and fixable findings exist (up to 3 iterations): run with `--fix`, gate via `sdw-security-checks`, commit only fixer-touched files (`fix(<slug>): apply automated review fixes (iteration N)`), re-verify without `--fix`.
- **Outcome:** `passed` advances to Step 8; residual blocking records `review_failed` and halts; artifact path recorded in `state.steps[7].artifact`.


