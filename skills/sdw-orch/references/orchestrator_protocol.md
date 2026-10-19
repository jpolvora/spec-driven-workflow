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
    "4": { "name": "implementation", "status": "completed", "output": {} },
    "5": { "name": "scoring", "status": "completed", "output": {} },
    "6": { "name": "delivery_commit", "status": "completed", "output": {} },
    "7": { "name": "code_review", "status": "completed", "output": {} },
    "8": { "name": "pr_preparation", "status": "completed", "output": {} }
  },
  "handoffs": {},
  "errors": []
}
```

## 2. 8-Step State Machine

1. **Derivation:** Identifies whether the spec is already agent-ready (EARS ACs, DoR, YAML frontmatter). Skips derivation if ready; otherwise reformulates human stories.
2. **Grilling:** Walks the decision tree covering input bounds, failure scenarios, and concurrency. Auto-resolves known gaps or prompts user via `ask_question` with recommended defaults.
3. **DAG Generation:** Analyzes complexity (file count, touchpoints) and decomposes requirements into 1 or more atomic tasks.
4. **Implementation Dispatch:** Builds isolated prompts for subagents, preventing context pollution.
5. **Conformance Scoring:** Compares diffs against AC requirements. If score < threshold (default 8/10), attaches feedback and triggers re-implementation loop.
6. **Delivery Commit:** Creates an atomic, structured git commit for verified code.
7. **Automated Code Review:** Compares current branch changes to `baseCommit`, verifying rule invariants and clean syntax in an iterative loop.
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
- **Activation:** Before Step 1 executes, checks that the working tree is clean (`git status --porcelain`). If dirty, halts execution.
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
- **Excluded Steps:** Steps 1, 4, 6, 7, and 8 do not emit step artifacts.

### Resumption & Overwrite Policy
- **Resumed Runs:** Reuses the existing `artifactsDir` from run state.
- **Step Re-execution:** Rewrites the existing step artifact deterministically within the same run.
- **Failure Policy:** Persistence is best-effort. Failures log a warning, record an error prefixed `Artifact persistence warning:` in `state.errors`, and continue workflow execution without changing run status.

## 7. Implementation Execution Contract & Evidence Gate (Spec 015)

Step 4 replaces dummy placeholder behavior with a deterministic implementation execution contract.

### Modes of Execution
- **Handoff Mode (`mode: "handoff"`, Default):**
  - Writes prompt files (`task-{taskId}.prompt.md`) containing task parameters, covered ACs, working directory, and rule constraints.
  - Sets task status to `pending`, Step 4 to `awaiting_implementation`, and run status to `paused`.
  - Exits with code `4` (normal pause, not an error).
  - External workers or agents implement code and report completion via `task finish`.
- **Command Mode (`mode: "command"`):**
  - Executes configured subprocess `implementation.command` sequentially in topological DAG order.
  - Substitutes tokens: `{taskId}`, `{promptFile}`, `{evidenceFile}`, `{workingDir}`, `{targetRoot}`, `{cwd}`, `{slug}`.
  - Sanitizes environment using allowlist (`PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `TEMP`, `TMP`, etc.) and injects `SDW_*` variables.
  - Corroborates task changes and evidence on zero exit status.

### Task Finish Subcommand
- **Command:** `node skills/sdw-orch/scripts/sdw_orch.cjs task finish --run-id <runId> --task <taskId> --evidence <evidencePath>`
- **Validation Rules:**
  - `taskId`: Must match target DAG task.
  - `acIds`: Non-empty subset of specification ACs.
  - `filesChanged`: Non-empty array of project-relative paths (no absolute paths, no `..` traversal, no `.git/`), files must exist on disk.
  - `tests`: Optional or empty array `[]` for non-testable tasks (e.g. docs, configs).
  - `summary`: Non-empty string.
- **Change Corroboration:** Changes verified in worktree (or primary tree if non-worktree mode). Empty worktrees or unmodified primary trees are rejected with code 1.
- **DAG Dependency Gate:** Rejects completion if upstream DAG dependencies are not yet completed.

### Sequential Worktree Integration
- In worktree mode, task worktrees branch sequentially from latest primary tree `HEAD`.
- Task changes are committed inside the worktree (`task({specSlug}): {taskId}`).
- The commit is cherry-picked into the primary tree.
- On success, the worktree and branch are removed (`git worktree remove` and `git branch -d`).
- On conflict, execution halts with code 1 and preserves the worktree for inspection.

### Build & Test Verification Gates
- Once all DAG tasks complete, verification gates execute:
  - `verification.buildCommand` (or `requiredBuild` with `buildCommand`).
  - `verification.testCommand` (or `runAllTests` with `testCommand`).
- Supports automated surgical fix loop (up to 3 attempts) with pre-commit secret leak scan.
- Gate failures halt execution and record failed gate status in `state.steps[4].gates`.

### Evidence-Based Conformance Scoring (Step 5)
- Score calculation: `score = Math.round((verifiedAcs / totalAcs) * 10)`.
- An AC is verified **only** when at least one accepted task evidence record references it and confirms real existing changed files.
- Diff keyword matching is eliminated.
- Specifications with 0 ACs score 0/10 and fail closed.

### Delivery Commit Guard (Step 6)
- Delivery commit is refused if Step 4 is not `completed`, any DAG task is unaccepted, or any verification gate is not `passed`.

### Batch Queue Pause
- When a batch item halts with code 4 (`awaiting_implementation`), the batch queue pauses, marks the item `awaiting_implementation`, saves manifest with status `paused`, and exits with code 4.

## 8. PR Delivery & Code Review Convergence Protocol (Step 8)

Step 8 executes final preparation, delivery, and optional post-PR code review convergence, respecting options configured in `.sdw/config.json`.

### Configuration Evaluation
The step resolves the following keys from `.sdw/config.json`:
- `scmProvider` (`"none" | "ado" | "github"`): Determines active provider. When `"none"`, remote PR creation and review polling are skipped.
- `pushDelivery` (boolean, default: `false`): When `true` (or `--push` flag), pushes the active delivery branch to `origin`.
- `scmCodeReviewEnabled` (boolean, default: `false`): Controls whether the orchestrator enters the remote review polling and fix convergence loop.
- `prePrCommand` (string): Optional shell command executed before PR preparation.
- `prePrInstructions` (string): Optional project checklist evaluated prior to PR submission.

### Lifecycle & Verification Flow
1. **Pre-PR Lifecycle Hooks:** If `prePrInstructions` is present, it is logged/evaluated. If `prePrCommand` is configured, it executes in project root. Any generated modifications are validated via `sdw-security-checks` and committed.
2. **Pre-PR Quality Verification:** If `requiredBuild` or `runAllTests` are enabled, build and test commands run with up to 3 surgical fix attempts.
3. **Index Completion & PR Assembly:** The specification is marked `completed` in `index.specs.md`. The pull request payload is generated.
4. **Remote Push & PR Creation:** If `pushDelivery` is enabled, the branch is pushed to remote origin. If `scmProvider` is active (`github` or `ado`), the provider's `createPullRequest` intent opens or reuses an existing open pull request.
5. **Post-PR Review Convergence Loop:** When `scmCodeReviewEnabled: true` (or `--poll-pr` CLI flag), the agent enters the review convergence loop:
   - Awaits completion of remote CI workflows and automated/agentic code review runs (`gh pr checks` / `check-pr-status`).
   - Queries review comments and active threads from the remote provider (`gh pr view --comments` / `gh api` / `list-threads`).
   - Critically evaluates review feedback against specification ACs, architecture, and simplicity guidelines (`sdw-rules`).
   - If actionable comments, defects, or test gaps are identified, applies surgical fixes, verifies with the test suite (`npm test`), commits the review fixes, pushes to the remote branch, and iterates until review threads are resolved and checks pass green.
   - If a review comment is technically invalid, inconsistent with the specification, or counter-productive, provides explicit technical refutation with evidence.
   - When `scmCodeReviewEnabled: false`, remote review polling is skipped and the run completes immediately following PR assembly/creation.


