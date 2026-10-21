---
id: null
slug: 00029-sdw-orch-sandboxed-execution
title: "SDW Orchestrator Sandboxed Execution and Plan-Only Dry Run"
source: local
status: implemented
specDate: 2026-10-19
---

# Specification — SDW Orchestrator Sandboxed Execution and Plan-Only Dry Run

## Description

`sdw-orch` advertises `--dry-run` as "validate specs and display the execution plan without executing", but the flag has no pipeline-level effect. It is parsed, forwarded to `sdw-ship-pr` in Step 8, and otherwise ignored: `run <spec> --dry-run` executes Steps 1–4, writes run state and step artifacts, generates the DAG, and dispatches `task-1` with exit code 4. The help text promises a guarantee the code does not honor, and the same flag means something different in batch mode, where spec 005 AC9 and its test enforce a side-effect-free plan. An operator who wants to observe a full delivery without touching the real checkout has no safe way to do it: the only isolation today is per-task worktrees in `command` mode, which cover Step 4 alone.

This specification separates the two intents that the single flag conflates:

1. **`--dry-run` becomes plan-only on `run`,** matching the existing batch contract: validate the specification, print the execution plan, create no state, no artifacts, no branch, no clone, and exit 0. The help text and documentation are corrected to describe exactly that.
2. **`--sandbox` executes the whole pipeline against an isolated local clone.** A shallow single-branch `git clone --no-local --depth 1 --single-branch` of the current `HEAD` into `{sandboxDir}/{runId}/repo` (`sandboxDir` defaults to `.sdw/sandbox`), a dedicated `sdw-sandbox/{runId}` branch, `origin` removed so no push can reach the source repository, Step 8 invoked without push and with `sdw-ship-pr --dry-run`, and run state and artifacts confined to the clone. The source checkout is never modified: not by commits, not by state files, not by specification index updates.
3. **A collected report and an explicit cleanup proposal.** Metadata in `{sandboxDir}/{runId}/sandbox.json`, a generated `{sandboxDir}/{runId}/report.md` with step, task, gate, score, commit, and diff facts, and `sandbox list`, `sandbox report`, and `sandbox clean` subcommands. Nothing is deleted automatically; after every invocation the CLI prints the cleanup command.

The isolation is a filesystem and git-history boundary, not a security sandbox: a worker can still run arbitrary commands, and a determined process can write outside the clone. The design removes the remote, forces delivery off, and prints absolute sandbox paths so that accidental pollution of the source tree is prevented by construction rather than by trust.

### Design Intent

The value of a sandboxed run is that the operator can watch a real delivery — real code, real tests, real commits, real report — and still keep the working checkout untouched and the remote unchanged. A worktree would share the source object database and leave a branch behind; a local clone gives complete git separation, a single directory to delete, and no cleanup of worktree registrations. Because the clone is cheap (`--local` hardlinks immutable objects), the isolation cost is one checkout per run. The clone is deliberately cut from the committed `HEAD`: uncommitted edits are excluded and the run records that fact instead of silently importing them, so the sandbox is reproducible from a commit. Everything that could mutate the outside world — push, pull request, SCM review polling — is disabled in sandbox mode, and the run state records the sandbox so a later reader can tell an isolated run from a real one.

## Acceptance Criteria

- AC1: When `run` executes with `--dry-run`, the system shall validate the target specification and print the execution plan without executing any step.
- AC2: When `run` executes with `--dry-run`, the system shall create no run state file, no step artifact, no branch, no worktree, and no clone.
- AC3: When `run` executes with `--dry-run`, the system shall exit with code 0.
- AC4: If `--dry-run` and `--sandbox` are both provided, then the system shall reject the invocation with a non-zero exit code naming both flags.
- AC5: If the project root is not a git repository, then the system shall reject `--sandbox` with a non-zero exit code.
- AC6: When `run` executes with `--sandbox`, the system shall create a local clone of the committed `HEAD` at `{sandboxDir}/{runId}/repo`.
- AC7: When the sandbox clone is created, the system shall create the branch `sdw-sandbox/{runId}` from the cloned `HEAD`.
- AC8: When the sandbox clone is created, the system shall remove its `origin` remote.
- AC9: When `--sandbox` executes on a dirty source working tree, the system shall warn that uncommitted changes are excluded and record `baselineDirty: true` in the sandbox metadata.
- AC10: If the resolved project root already contains a sandbox marker, then the system shall reject nested `--sandbox` execution with a non-zero exit code.
- AC11: When a sandbox run executes, the system shall run every step against the sandbox clone root.
- AC12: While a sandbox run is active, the system shall force remote delivery off and shall not push any branch.
- AC13: While a sandbox run is active, the system shall resolve the SCM provider as `none` and shall not create, poll, or update a pull request.
- AC14: When Step 8 executes in a sandbox run, the system shall invoke `sdw-ship-pr` with `--dry-run` and without `--push`.
- AC15: Where the source root contains a `node_modules` directory, the system shall link it into the sandbox clone so verification commands can run.
- AC16: When a task is dispatched in a sandbox run, the system shall print absolute prompt paths, absolute evidence paths, and a working directory equal to the sandbox root.
- AC17: When a sandbox run prints a finish or resume command, the system shall include `--root <sandboxRoot>` in that command.
- AC18: When a sandbox is created, the system shall write `{sandboxDir}/{runId}/sandbox.json` in the source root containing the run id, sandbox path, branch, base commit, creation time, and baseline dirty flag.
- AC19: When a sandbox run reaches a terminal or paused state, the system shall write `{sandboxDir}/{runId}/report.md` in the source root.
- AC20: The sandbox report shall include per-step status, per-task status, verification gates, conformance score, recorded errors, commits since the base commit, and changed-file statistics.
- AC21: The system shall provide a `sandbox list` subcommand that prints every known sandbox with its run id, status, branch, and age.
- AC22: The system shall provide a `sandbox report --run-id` subcommand that regenerates and prints the report for a known sandbox.
- AC23: The system shall provide a `sandbox clean --run-id` subcommand that deletes the sandbox clone and preserves its metadata and report.
- AC24: If `sandbox clean` or `sandbox report` names an unknown run id, then the system shall exit non-zero with a message naming the unknown id.
- AC25: The system shall not delete a sandbox automatically; after every sandbox invocation it shall print the cleanup command.
- AC26: The system shall record sandbox mode in run state as `sandbox: { enabled, sourceRoot, path, branch }`.
- AC27: If sandbox creation fails, then the system shall exit non-zero without creating run state in the source root.
- AC28: The system shall update `.gitignore` to exclude `.sdw/sandbox/`.
- AC29: The system shall document plan-only dry-run, sandbox lifecycle, report contents, and cleanup in the skill documentation and orchestrator protocol.
- AC30: The system shall cover plan-only execution, clone creation, remote removal, report generation, cleanup, conflicting flags, dirty baseline, nested rejection, and absolute dispatch paths with tests.
- AC31: If `--sandbox` is provided with a batch execution, then the system shall reject the invocation with a non-zero exit code.
- AC32: If `--sandbox` and `--push` are both provided, then the system shall reject the invocation with a non-zero exit code naming both flags.
- AC33: Where the target specification file is absent from the sandbox clone, the system shall copy the resolved specification into the clone and record `specCopied: true` in the sandbox metadata.
- AC34: When the source `HEAD` is attached to a branch, the system shall clone only that branch with depth one and single-branch refs.
- AC35: If a shallow single-branch clone does not reproduce the source `HEAD` commit, then the system shall fall back to a full local clone checked out at that commit and record `clone.fallback: true`.
- AC36: When `sandboxDir` is configured in `.sdw/config.json`, the system shall create sandbox clones beneath the resolved directory.
- AC37: The system shall default `sandboxDir` to `{projectRoot}/.sdw/sandbox` when the key is absent.
- AC38: The system shall resolve `{projectRoot}`, `{skillsRoot}`, and `{temp}` tokens in `sandboxDir`.
- AC39: If `sandboxDir` resolves inside the project root and differs from the default location, then the system shall reject the configuration with an actionable error.
- AC40: If the resolved sandbox target directory already exists, then the system shall halt sandbox creation with an actionable message naming the target and the `sandbox clean --run-id` command.
- AC41: If a sandbox target exists without metadata, then the system shall remove the orphaned directory during `sandbox clean`.
- AC42: If the specification validator is unavailable or throws during `--dry-run`, then the system shall fail closed with a non-zero exit code and the validator error.
- AC43: When the source repository has a local `user.name` and `user.email`, the system shall configure the sandbox clone with the same identity.
- AC44: When any subcommand loads configuration from a sandbox clone, the system shall apply sandbox isolation and absolute dispatch paths.

## Notes

- Authoring standard: Node.js 22 CommonJS helpers, standard library only, zero runtime npm dependencies; 3-Tier skill layout respected; breaking changes applied without compatibility shims.
- Implementation surfaces:
  - `skills/sdw-orch/scripts/sandbox.cjs` (new): clone creation, marker and metadata read/write, node_modules link, report rendering, list/report/clean operations.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: `--dry-run` plan branch in `cmdRun`; `--sandbox` pre-flight and re-rooting; forced no-push/no-SCM in sandbox mode; absolute dispatch paths; post-command report refresh; `sandbox list|report|clean` subcommands; usage block.
  - `skills/sdw-orch/scripts/implementation_runner.cjs`: render an absolute working directory and absolute evidence path when the run is sandboxed.
  - `skills/sdw-orch/scripts/state_manager.cjs`: unchanged schema; sandbox metadata is a top-level `sandbox` object written by the orchestrator.
  - `skills/sdw-orch/SKILL.md`, `skills/sdw-orch/references/orchestrator_protocol.md`, `.sdw/directory-structure.md`, `README.md`, `FEATURES.md`: plan-only and sandbox documentation.
  - `skills/sdw-config/scripts/sdw_config.cjs`, `skills/sdw-config/references/config_spec.md`, `.sdw/config.schema.json`, `.sdw/config.json`: `sandboxDir` key with default `{projectRoot}/.sdw/sandbox`.
  - `.gitignore`: `.sdw/sandbox/` entry for the default location.
  - `tests/sdw_sandbox.test.cjs` (new): clone, remote removal, report, clean, conflicts, dirty baseline, nested rejection, absolute paths, custom `sandboxDir`.
- Sandbox layout (under the resolved `sandboxDir`):
  - `{sandboxDir}/{runId}/sandbox.json` — metadata.
  - `{sandboxDir}/{runId}/report.md` — generated report.
  - `{sandboxDir}/{runId}/repo/` — the clone (deleted by `sandbox clean`).
  - `{sandboxDir}/.sandbox-marker.json` inside the clone — `{ sourceRoot, sandboxDir, runId, branch, createdAt }`, used to detect nested sandboxes and to refresh the report from any subcommand.
- `sandboxDir` resolution: `.sdw/config.json` → `sandboxDir` (default `{projectRoot}/.sdw/sandbox`), with `{projectRoot}`, `{skillsRoot}`, and `{temp}` (OS temporary directory) tokens expanded by `sdw-config`; relative values resolve against the project root. A custom value must resolve outside the project root — only the default may live inside it — and `sdw-config check` reports the rule as `sandbox_dir_location`. `sandbox list|report|clean` resolve the same key, so a custom root is honored everywhere. Metadata records the absolute `sandboxDir` so a report refresh from inside a clone needs no configuration lookup.
- Clone sequence: `git clone --no-local --depth 1 --single-branch --branch <sourceBranch> <sourceRoot> <clonePath>`, `git -C <clonePath> switch -c sdw-sandbox/{runId}`, `git -C <clonePath> remote remove origin`, then the marker and the metadata. `--no-local` is required because git ignores `--depth` for `--local` clones. A shallow single-branch clone is sufficient because the sandbox only walks forward from `HEAD`; the report's `baseCommit..HEAD` range stays valid. When `HEAD` is detached, the same command omits `--branch` and clones the exact commit. If the cloned `HEAD` does not match the source `HEAD`, the system removes the clone and falls back to `git clone --local` plus `git checkout --detach <sha>`, recording `clone.fallback: true`.
- Metadata also records `clone: { sourceBranch, sourceSha, depth, singleBranch, fallback }` so the report and later readers can see whether the optimized path was used.
- Target collision policy: sandbox paths stay deterministic (`{sandboxDir}/{runId}/repo`). Auto-generated run ids carry a millisecond timestamp, and reusing an explicit `--run-id` halts creation with the exact cleanup command. Random subdirectories are deliberately not used: they would make `sandbox list`, `sandbox report`, `sandbox clean`, and the report's path references non-deterministic for no benefit. `sandbox clean` also removes an orphaned target directory left by an interrupted creation (metadata missing).
- Sandbox isolation gate: `loadProjectConfig` applies isolation whenever the target root carries a sandbox marker, so `task next`, `task finish`, `resume`, and every later `run` entry inherit no-push/no-SCM and absolute dispatch paths. `cmdRun` no longer carries a second, partial copy of that logic.
- Sandbox run state lives inside the clone at `.sdw/state/`, so `status`, `resume`, and `findLatestRunState` on the source root never observe it. Every printed follow-up command therefore carries `--root <clonePath>`.
- Report refresh: after `run`, `resume`, and `task finish`, when the active root contains the sandbox marker, the system reads the run state and the git facts from the clone and rewrites the report in the source root. The report is best-effort: a report failure is a warning, never a run failure.
- Remote isolation: Step 8 is invoked with `--dry-run` and without `--push`; `config.pushDelivery` is forced `false` and `config.scmProvider` is forced `none` in memory for the sandbox run; the removed `origin` prevents an accidental push from inside the clone. Because `sdw-ship-pr` simulates its own pre-PR command, build, and test gates under `--dry-run`, real verification in a sandbox comes from the orchestrator's Step 4 gates; Step 8 stays remote-free by design.
- Dirty baseline: the clone is cut from committed `HEAD`; uncommitted tracked and untracked changes are absent. The operator sees `[sandbox] Warning: working tree is dirty; uncommitted changes are not part of the sandbox baseline.` and `baselineDirty: true` in metadata. Carrying uncommitted changes into a sandbox is out of scope for this iteration.
- Plan output (dry run): resolved specification path and slug, target root, branch strategy facts (`useFeatureBranches`, `useWorktrees`), delivery facts (`pushDelivery`, `scmProvider`), the eight step names, and `No steps executed (--dry-run).` Exit code 0.
- Plan-only dry run fails closed: a missing or throwing validator returns exit code 1 with the validator error, never a passing plan.
- Sandbox commits work on hosts without a global git identity: `createSandbox` copies the source repository's local `user.name` and `user.email` into the clone, because git does not clone repository-local config.
- Exit codes are otherwise unchanged: `0` success, `1` operational failure, `2` conformance score below threshold, `3` user gate, `4` awaiting implementation.
- The report includes the plain-git inspection commands for the kept clone, e.g. `git -C {sandboxDir}/{runId}/repo log --oneline` and `git -C {sandboxDir}/{runId}/repo diff --stat <baseCommit>..HEAD`, plus the source-side fetch form `git fetch {sandboxDir}/{runId}/repo sdw-sandbox/{runId}:refs/heads/sdw-sandbox/{runId}` so a kept branch can be imported before deletion.
- Tests use `node:test`, `node:assert/strict`, and temporary git fixtures. Clone tests assert `.git` is a directory (not a worktree link file), `origin` is absent, the branch name is recorded, and the report exists after a simulated paused run.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Container, VM, namespace, or syscall-level isolation | Non-portable and incompatible with the zero-dependency, harness-agnostic rules; external research only |
| Carrying uncommitted changes into the sandbox | The sandbox is defined from a commit; carrying dirty state is a separate, riskier feature |
| Auto-pushing or auto-bundling the sandbox branch | The operator decides whether to import the branch before cleanup |
| Parallel sandbox runs sharing one clone | One clone per run id keeps isolation and cleanup trivial |
| Automatic sandbox deletion after success or failure | Deletion must be an explicit operator decision |
| Sandboxing `sdw-ship-pr`, `sdw-code-review`, or other skills in isolation | This specification sandboxes the orchestrator run; standalone skill invocations keep their current behavior |
| Network or credential isolation for worker commands | Out of scope for a filesystem/git boundary; documented as a limitation |
| New `.sdw/config.json` keys | Sandbox mode is CLI-driven; no persistent configuration is required |
| Fixing the batch dry-run contract | Spec 005 AC9 already defines and tests plan-only batch behavior; it is reused as the semantic reference |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Flag split | `--dry-run` = plan only; `--sandbox` = isolated execution | Keeps spec 005 AC9 and batch tests intact and gives each intent a truthful name | y |
| Isolation mechanism | Local git clone | Confirmed by the maintainer: full git separation and one-directory cleanup | y |
| Sandbox baseline | Committed `HEAD` | Reproducible from a commit; uncommitted work is excluded and recorded | y |
| Baseline dirty handling | Warn and proceed, record `baselineDirty` | Blocking dirty trees would make the mode unusable on active workspaces | n |
| Clone location | `{sandboxDir}/{runId}/repo`, `sandboxDir` defaults to `{projectRoot}/.sdw/sandbox` | Configurable per workspace while the default is gitignored, colocated with run metadata, and easy to inspect and delete | y |
| Branch name | `sdw-sandbox/{runId}` | Deterministic, unique per run, and easy to fetch into the source | y |
| Remote handling | Remove `origin` from the clone | Prevents any push from reaching the source repository | y |
| SCM handling | Force `none` and `sdw-ship-pr --dry-run` | Step 4 verification gates execute for real; `sdw-ship-pr` simulates its own pre-PR gates under `--dry-run`, and no pull request or thread is mutated | y |
| node_modules handling | Junction/symlink from source when present | Verification commands must run without a network install | y |
| Report location | `{sandboxDir}/{runId}/report.md` | Survives clone deletion and keeps the audit trail next to the sandbox metadata | y |
| Sandbox directory configuration | `sandboxDir` in `.sdw/config.json` with `{projectRoot}`, `{skillsRoot}`, and `{temp}` tokens; a custom value must resolve outside the project root | Reuses the existing configuration surface, keeps in-project writes at the default, and lets operators place temporary clones on another disk via `{temp}` | y |
| Sandbox target collision | Deterministic `{sandboxDir}/{runId}`; halt when it exists, never auto-rename | Random subdirectories would break `list`/`report`/`clean` determinism; an explicit `--run-id` reuse should fail loudly instead of silently creating a second tree | y |
| Cleanup | Explicit `sandbox clean`, never automatic | The operator asked for a proposal, not a deletion policy | y |
| Runtime dependencies | Node.js 22 standard library only | Repository policy forbids runtime npm dependencies in packaged skills | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is valid and `sandboxDir` resolves | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature registered in `.sdw/specs/index.specs.md` as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification passes canonical SDW authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00029-sdw-orch-sandboxed-execution.md` |
| Dry-run baseline | Current `--dry-run` handling and Step 8 forwarding inspected | Read `skills/sdw-orch/scripts/sdw_orch.cjs` |
| Batch contract baseline | Spec 005 AC9 and its test inspected | Read `.sdw/specs/00005-sdw-orch-multi-spec-batch.md` and `tests/sdw_orch.test.cjs` |
| Dispatch baseline | Envelope rendering and relative-path behavior inspected | Read `skills/sdw-orch/scripts/sdw_orch.cjs` and `implementation_runner.cjs` |
| Git baseline | `git clone --local`, `git switch -c`, and `git remote remove` available | Execute all three in a scratch repository fixture |
| Runtime baseline | Node.js 22 standard library available with no runtime npm dependencies | Execute the helpers with `node` |
| Test baseline | Existing `node:test` suite passes before changes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Plan output, e.g. `[sdw-orch dry-run] Specification: .sdw/specs/029-...md`, `Steps: 1 derivation ... 8 pr_preparation`, and `No steps executed (--dry-run).`
- Sandbox creation output, e.g. `[sandbox] Clone created at {sandboxDir}/{runId}/repo (branch sdw-sandbox/{runId}, origin removed).`
- Dirty baseline warning, e.g. `[sandbox] Warning: working tree is dirty; uncommitted changes are not part of the sandbox baseline.`
- Sandbox metadata at `{sandboxDir}/{runId}/sandbox.json` with `runId`, `sandboxDir`, `root`, `branch`, `baseCommit`, `createdAt`, and `baselineDirty`.
- Run state inside the clone at `.sdw/state/run-*.state.json` carrying `sandbox: { enabled: true, sourceRoot, dir, path, branch }`.
- Report at `{sandboxDir}/{runId}/report.md` with per-step status, task table, gates, score, errors, `git log --oneline`, and `git diff --stat`.
- `sandbox list --json` returns `runId`, `status`, `branch`, `createdAt`, and `ageMs` for every known sandbox.
- `sdw-config check` reports `sandbox_dir_location` with the resolved directory and whether it is the default in-project location or outside the project root.
- Every sandbox invocation ends with the cleanup proposal naming `node skills/sdw-orch/scripts/sdw_orch.cjs sandbox clean --run-id <runId>`.
- Exit code 4 in a sandbox run leaves the sandbox alive and the report marked `paused`, so the operator can dispatch the next task.

### Negative & Failing Test Scenarios

- Plan-only purity: `run <spec> --dry-run` must leave `.sdw/state` free of new state files and artifacts; a test asserting a created state file fails.
- Conflicting flags: `run <spec> --dry-run --sandbox` exits non-zero and names both flags.
- Non-git workspace: `--sandbox` in a directory without a repository exits non-zero without creating the `sandboxDir` tree.
- Custom sandbox dir: `sandboxDir: "{temp}/sdw-sandboxes"` creates the clone under the OS temp directory, and `sandbox list`, `sandbox report`, and `sandbox clean` resolve the same key.
- In-project custom dir: `sandboxDir: "{projectRoot}/build/sandboxes"` fails `sdw-config check` with `sandbox_dir_location`, and `--sandbox` refuses to start with the same actionable error.
- Nested sandbox: a second `--sandbox` executed from a clone root exits non-zero and names the existing sandbox.
- Remote isolation: a sandbox clone must have no `origin` remote; a push attempt inside the clone fails instead of reaching the source repository.
- Delivery isolation: a sandbox run must not push and must not create a pull request, even when `pushDelivery` is `true` and `scmProvider` is `github` in configuration.
- Report on failure: a sandbox run that fails at a gate still leaves a report containing the failing step and the recorded error.
- Unknown sandbox: `sandbox clean --run-id missing` exits non-zero and names the unknown run id.
- Source purity: after a sandbox run, `git status --porcelain` in the source root shows no new tracked changes attributable to the run, and `.sdw/state` contains no new run state file.
- Absolute dispatch paths: a dispatch envelope in a sandbox run must not print a bare relative prompt path; a prompt instructing a worker to use `.` as the working directory fails the test.
