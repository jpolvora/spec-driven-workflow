---
id: null
slug: 010-sdw-orch-branch-worktree-strategy
title: "SDW Orchestrator Branch & Worktree Strategy — Configurable Feature Branches and Per-Task Worktrees"
source: local
specDate: 2026-10-19
---

# Specification — SDW Orchestrator Branch & Worktree Strategy — Configurable Feature Branches and Per-Task Worktrees

## Description

Today the orchestrator (`sdw-implement`, renamed to `sdw-orch` by spec 004) always operates directly on whatever branch the user has checked out, inside the primary working tree. Run state captures `baseCommit` only (`state_manager.cjs`), DAG tasks are dispatched as context-fenced prompts against the primary tree, conformance scoring and code review read diffs from the primary tree, and step 8 assembles a PR payload without any head/base branch information.

This specification adds two optional, runtime-resolved configuration properties to `.sdw/config.json`:

1. `useFeatureBranches` (boolean, default `false`): when enabled, the orchestrator reads the value at run start and, before step 1 executes, creates (or idempotently switches to) a feature branch derived from the specification slug, so all workflow commits land on an isolated branch instead of the user's current branch.
2. `useWorktrees` (boolean, default `false`): when enabled, the orchestrator reads the value at run start and decides at runtime, per dispatched task, whether the subagent receives an exclusive git worktree under `.sdw/worktrees/{runId}/`, instead of mutating the primary working tree.

Enabling worktrees requires a deterministic lifecycle: create the worktree from the current HEAD on a per-task branch, let the subagent implement there, commit inside the worktree, integrate the commit back into the primary worktree by cherry-pick, then remove the worktree with `git worktree remove` only after the tree is clean and integrated. Integration must complete before step 5 scoring and step 6 delivery commit, because both read diffs from the primary working tree.

The skill must also grow the safe-command discipline this feature demands: clean-tree preconditions, no `--force` anywhere, destination confinement to `.sdw/worktrees/`, `git worktree prune` guidance for stale registrations, and fail-closed behavior — any git failure halts the run and is recorded in state rather than silently falling back to inline implementation.

Empirically verified in this environment (git 2.53.0.windows.2): `git worktree add <projectRoot>/.sdw/worktrees/<task>` succeeds inside the repository, the primary worktree reports the nested directory as untracked (`?? .sdw/` in `git status --porcelain`), therefore `.sdw/worktrees/` must be added to `.gitignore` so the repository stays clean.

### Design Intent

Keep the default behavior bit-for-bit identical to today: both keys default to `false`, so existing consumers see no change. When enabled, prefer deterministic, reversible git operations (new branches from HEAD, per-task worktree branches, cherry-pick integration, safe removal) over clever state-preserving tricks, and fail closed on any ambiguity — a half-applied worktree strategy must never leave the repository in a state the user cannot explain. Runtime override flags (`--no-worktrees`, `--no-feature-branch`) exist because worktree support depends on machine-level facts (filesystem location, drives, permissions) that configuration cannot know in advance.

## Acceptance Criteria

- AC1: The system shall support the optional `useWorktrees` boolean property in `.sdw/config.json` that defaults to `false`.
- AC2: The system shall support the optional `useFeatureBranches` boolean property in `.sdw/config.json` that defaults to `false`.
- AC3: If `useWorktrees` or `useFeatureBranches` hold non-boolean values, then the system shall fail configuration validation with a non-zero exit code.
- AC4: The system shall register both properties in `.sdw/config.schema.json` and in the configuration reference documentation.
- AC5: While `useFeatureBranches` is `false`, the system shall execute the workflow on the currently checked out branch without creating any branch.
- AC6: When a run starts while `useFeatureBranches` is `true`, the system shall create or switch to a feature branch derived from the specification slug before step 1 executes.
- AC7: If the working tree is not clean when feature branch activation runs, then the system shall halt with a non-zero exit code and record the refusal in the run state.
- AC8: When the target feature branch already exists, the system shall switch to it and record that the branch was reused.
- AC9: The system shall record `branch`, `baseBranch`, and `baseCommit` in the run state file.
- AC10: The system shall include the active branch as head and the resolved base branch as base in the step 8 pull request payload.
- AC11: While `useWorktrees` is `false`, the system shall dispatch subagents against the primary working tree without creating git worktrees.
- AC12: When `useWorktrees` is `true` and the plan contains multiple tasks, the system shall create one exclusive git worktree per dispatched task under `.sdw/worktrees/{runId}/`.
- AC13: When the plan contains a single low-complexity task, the system shall skip worktree creation and record the skip reason in the run state.
- AC14: The system shall record each worktree path, task branch, and resulting commit sha in the run state.
- AC15: When a worktree task completes, the system shall commit its changes and integrate the commit into the primary working tree by cherry-pick.
- AC16: If worktree integration produces conflicts, then the system shall halt with a non-zero exit code and preserve the conflicted worktree for inspection.
- AC17: The system shall remove task worktrees with `git worktree remove` only after confirming the worktree is clean and its commit is integrated.
- AC18: The system shall add `.sdw/worktrees/` to the repository `.gitignore` and document the directory in `.sdw/directory-structure.md`.
- AC19: If a git worktree command fails, then the system shall halt and record the error instead of silently falling back to inline implementation.
- AC20: When worktree creation is pending, the system shall verify git availability, repository initialization, and destination writability before proceeding.
- AC21: Where `--no-worktrees` or `--no-feature-branch` is passed at runtime, the system shall override the corresponding configuration value for that run and record the override.
- AC22: When the `status` subcommand executes, the system shall display the active branch and registered worktrees for the run.
- AC23: The system shall document the branch and worktree behavior in `skills/sdw-orch/SKILL.md` and the orchestrator protocol reference.

## Original Issue Context

The specification originated from the user request to extend the orchestrator with configurable branch and worktree handling:

> create another spec for enhancing orchestrator behavior on handling feature branches/base branch/base commit/worktrees: add a new option to config.json (update schema file) useWorktrees: false by default, if enabled, the orchestrator will read the value and check in runtime and decide if will implement each task with the dispatched subagent if will create the exclusive worktree - update the skill to handle properly the necessary and safe commands and checks. Add one more option in config useFeatureBranches: false by default, which if enabled, which checkout a new branch for the specific spec will start to work deriving the name from the spec slug / inferred.

## Notes

- Configuration Integration:
  - `skills/sdw-config/scripts/sdw_config.cjs`: add `useWorktrees: false` and `useFeatureBranches: false` to `DEFAULT_CONFIG`, both property definitions to `DEFAULT_SCHEMA`, and boolean validation branches.
  - `.sdw/config.schema.json`: add both properties with `"type": "boolean"` and `"default": false`.
  - `skills/sdw-config/references/config_spec.md`: add property table rows and the updated default configuration baseline.
  - `.sdw/config.json` template: both keys omitted or explicit `false`; enabling is a consumer opt-in.
- Runtime Resolution (`skills/sdw-orch/scripts/sdw_orch.cjs`):
  - `loadProjectConfig` fallback object gains `useWorktrees: false` and `useFeatureBranches: false`.
  - `parseArgs` gains `--no-worktrees` and `--no-feature-branch` one-shot overrides; applied values and their source (config or flag) are recorded in state.
- Branch Resolution Rules:
  - Name derivation: `feature/{specSlug}` (slug already carries the `NNN-` prefix, e.g. `feature/010-sdw-orch-branch-worktree-strategy`).
  - Base branch resolution order: `git symbolic-ref --short refs/remotes/origin/HEAD` (stripping the `origin/` prefix), then the current branch from `git rev-parse --abbrev-ref HEAD`.
  - Preconditions before branch creation: repository initialized, `git status --porcelain` empty, target name not colliding with an unrelated branch.
  - Commands: `git switch -c feature/{specSlug}` for creation, `git switch feature/{specSlug}` for reuse; no `--force` under any circumstance.
- Worktree Lifecycle (per DAG task, when enabled and applicable):
  1. Preconditions: git available, destination root `.sdw/worktrees/{runId}/` writable, path not already registered (`git worktree list --porcelain`), task id unique within the run.
  2. Create: `git worktree add .sdw/worktrees/{runId}/{taskId} -b task/{runId}/{taskId} <current head>`.
  3. Dispatch: the context-fenced task prompt carries the worktree absolute path and the instruction to implement exclusively there.
  4. Commit: `git -C <worktreePath> add -A` followed by `git -C <worktreePath> commit -m "task({specSlug}): {taskId}"` (only when the worktree reports changes).
  5. Integrate: `git cherry-pick <taskCommitSha>` in the primary worktree to preserve linear history matching the existing single-commit delivery style.
  6. Remove: `git worktree remove <path>` after the worktree is clean; then `git branch -d task/{runId}/{taskId}` (safe delete, refuses unmerged).
  7. Failure handling: conflicts halt the run with the worktree preserved and its path printed; stale registrations are cleaned with the documented `git worktree prune` guidance.
  - Skip rule: when the DAG plan has exactly one task and complexity level is `low`, worktree creation is skipped and recorded with `reason: "single low-complexity task"`.
- State Schema Additions (`state_manager.cjs`):
  - `branch`: active branch name (`null` when feature branches are disabled and no explicit record is needed).
  - `baseBranch`: resolved base branch name.
  - `branchReused`: boolean.
  - `worktrees`: array of `{ taskId, path, branch, baseCommit, status, commitSha }`.
  - `runtimeOverrides`: `{ useWorktrees, useFeatureBranches, source }` when an override flag was used.
- Ordering Constraint: worktree integration completes within step 4; steps 5 (scoring), 6 (delivery commit), and 7 (review) continue to read the primary working tree, so no scoring or review logic changes are required.
- Status Reporting (`cmdStatus`): print `Branch:`, `Base Branch:`, and a `Worktrees:` section listing task id, path, and status; JSON mode includes the same fields through the state file.
- Directory Structure: `.sdw/worktrees/` joins the documented `.sdw/` layout as an ephemeral, ignored directory; run-scoped subdirectories (`{runId}/`) are removed by the workflow after successful integration.
- No Compatibility Shim (AGENTS.md rule 6): after spec 004 the logic lives only in `skills/sdw-orch/scripts/sdw_orch.cjs`; the removed `sdw-implement` path forwards nothing.
- Batch Interaction (spec 005): each queued item activates its own feature branch; `--dry-run` must not create branches, worktrees, or commits; the active branch is recorded per queue entry in the batch manifest.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Parallel subagent execution across worktrees | Sequential dispatch from the grilling concurrency decision path remains authoritative; isolation is the deliverable, not throughput |
| Configurable worktree location key | `.sdw/worktrees/` is verified sufficient and ignored; a location key can be added when a consumer demonstrates the need |
| Remote push and pull request creation automation | Step 8 assembles metadata only; remote operations remain outside orchestrator scope |
| Automatic garbage collection of stale worktrees from crashed runs | Silent deletion risks data loss; documented `git worktree prune` guidance is the recovery path |
| Worktree support for non-git SCM providers | The strategy is git-specific by design |
| Submodule and sparse-checkout interaction handling | Uncommon in SDW consumer repositories; treated as unsupported combinations |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Feature default state | Both keys `false` | Preserves current behavior for existing consumers; enabling is explicit opt-in | y |
| Feature branch naming | `feature/{specSlug}` | Derivable directly from the spec slug as requested; stable across resumes | y |
| Branch creation strategy | `git switch -c` from current HEAD | Simple, reversible, and avoids rebasing or history rewriting | y |
| Existing branch handling | Switch and record reuse | Makes run resumes and retries idempotent instead of failing | y |
| Worktree location | `.sdw/worktrees/{runId}/{taskId}` | Verified nested worktrees work; `.gitignore` keeps the primary tree clean | y |
| Integration strategy | Cherry-pick into the primary tree | Preserves the linear single-commit history style already used by the orchestrator | y |
| Failure policy | Halt and record, never silent fallback | A half-applied strategy is harder to recover than a stopped run | y |
| Single-task runs | Skip worktree when complexity is low | Avoids git machinery when isolation adds no value | y |
| Base branch resolution | `origin/HEAD`, then current branch | Works with or without a configured remote | y |
| Override flags | `--no-worktrees`, `--no-feature-branch` | Machine-level constraints cannot be predicted by configuration alone | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` validates after both schema keys are added | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature is tracked in `.sdw/specs/index.specs.md` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification adheres to canonical SDW standard and EARS syntax | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate .sdw/specs/010-sdw-orch-branch-worktree-strategy.md --mode=authoring` |
| Git capability | Git version supports `switch` and `worktree` subcommands | Run `git --version` and `git worktree list` |
| Ignored directory | `.sdw/worktrees/` is present in `.gitignore` before enabling the feature | Run `git check-ignore -v .sdw/worktrees/probe` |
| Clean repository state | Git working tree has no uncommitted corruption before implementation | Run `git status` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Branch activation log, e.g. `[Branch] Created feature/010-sdw-orch-branch-worktree-strategy from master (base commit 3a7d55f)`.
- Per-task worktree logs, e.g. `[Step 4: Worktree] Created .sdw/worktrees/run-.../task-1 on task/run-.../task-1`.
- Integration logs, e.g. `[Step 4: Worktree] Integrated task-1 commit <sha> into feature/... via cherry-pick`.
- Skip log for trivial runs: `[Step 4: Worktree] Skipped: single low-complexity task`.
- Run state file contains `branch`, `baseBranch`, and the `worktrees` array after step 4.
- `git worktree list` output enumerates active task worktrees during the run.
- `status --json` shows the same branch and worktree fields.

### Negative & Failing Test Scenarios

- Dirty tree refusal: with uncommitted modifications and `useFeatureBranches: true`, branch activation must halt with a non-zero exit code and no branch switch.
- Worktree conflict: two tasks editing the same region must halt the run at cherry-pick with the conflicted worktree preserved and the primary tree left recoverable (`git cherry-pick --abort` guidance).
- Missing git: when git is unavailable or the directory is not a repository, the precondition check must fail the run before any worktree command executes.
- Forced-removal guard: when a worktree is dirty, `git worktree remove` must fail and the workflow must record the error instead of forcing removal.
- Invalid configuration: when `useWorktrees` is set to the string `"yes"`, `sdw_config.cjs check` must exit with code 1.
- Nested path unignored: if `.sdw/worktrees/` is missing from `.gitignore`, the run must warn that the primary tree is no longer clean before proceeding.
