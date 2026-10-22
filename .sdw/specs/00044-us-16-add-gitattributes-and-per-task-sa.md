---
id: "16"
slug: 00044-us-16-add-gitattributes-and-per-task-sa
title: "Add .gitattributes and per-task save in sdw-orch DAG"
source: github
status: implemented
specDate: 2026-10-21
---
# Specification — Add .gitattributes and per-task save in sdw-orch DAG

## Description

 Add .gitattributes and per-task save in sdw-orch DAG

## Context
Repo has no `.gitattributes`. `sdw-orch` persists DAG progress only in `.sdw/state/{runId}.state.json` plus uncommitted working tree edits until Step 6. A crash or reset between tasks loses corroborated work.

## Part 1: Add `.gitattributes`

Findings (2026-10-21, Windows host):
- `Test-Path .gitattributes` is False, `git check-attr` returns `unspecified` for all sampled paths.
- Effective `core.autocrlf=true` from system gitconfig, no repo local override, `core.eol` unset.
- Index is uniformly `i/lf` (LF). Working tree over 176 tracked files: `w/crlf` 90, `w/lf` 65, `w/mixed` 20, `w/none` 1.
- Same directory inconsistency: `skills/sdw-orch/scripts/*.cjs` mixes pure CRLF (9 files including `sdw_orch.cjs`) and pure LF (2 files: `sandbox.cjs`, `spec_derivation.cjs`).
- 20 `w/mixed` files, mostly `.sdw/specs/*.md` plus 3 test files (`sdw_orch_implementation`, `sdw_refinement_gates`, `sdw_step_artifacts`).
- Current dirty tree shows no line ending only churn (`git diff --stat` equals `git diff --ignore-cr-at-eol --stat`), so this is latent risk, not active noise. Linux and macOS checkouts will perpetuate inconsistency without enforcement.

Proposal (minimal):
- Add `.gitattributes` at repo root.
- Baseline content:
  - `* text=auto`
  - `*.cjs text eol=lf`
  - `*.mjs text eol=lf`
  - `*.json text eol=lf`
  - `*.sh text eol=lf`
- Keep `.gitignore` as is (it does not ignore `.gitattributes`).
- After adding, run one normalization pass and verify `git ls-files --eol` shows no `w/mixed`.

## Part 2: sdw-orch per-task save between DAG tasks

Current behavior (all in `skills/sdw-orch/scripts/`):
- `sdw_orch.cjs:2684` `cmdTaskFinish` validates fail closed (taskId, evidence file, DAG membership, dispatch gate at 2736, deps at 2749, spec AC set, evidence validator, status success only, `checkTaskChanges` against dispatch baseline) then persists via `state_manager.cjs:163` `saveRunState`.
- Primary tree path at `sdw_orch.cjs:2846` records `commitSha = getBaseCommit()` (current HEAD via `git rev-parse HEAD` at 189), no `git add` or `commit`.
- Between tasks, persistence is only JSON state plus uncommitted edits. Subagent mode forces `useWorktrees=false` at `sdw_orch.cjs:1284`, and worker prompts forbid committing (`implementation_runner.cjs:157`).
- Step 6 delivery commit at `sdw_orch.cjs:1767` runs only after all tasks completed plus gates passed plus score threshold plus secret scan, staging via `collectDeliveryFiles` at 378 and `stageAndCommitOnly` at 346.
- Per task worktree commit plus snapshot exists only in command mode with `useWorktrees`: `implementation_runner.cjs:260` `createTaskWorktree`, `405` `integrateTaskWorktree` (`git add -A`, `git commit "task(slug): taskId"`, cherry pick, cleanup). Callers are the command loop at `sdw_orch.cjs:1440` and the worktree `task finish` path at 2823.

Risk: long DAGs accumulate uncommitted work across many `task finish` calls. Interruption loses everything since HEAD. Resume can revalidate state JSON but cannot recover file content.

Proposal:
- Add opt out or default on per completed task save in primary tree, consistent with existing scoped commit helper (`stageAndCommitOnly`, `isScopedExcluded` at 288).
- Suggested semantics: after each accepted `task finish`, commit only that task `filesChanged` (same scope rules as Step 6, never `.sdw/state`, worktrees, sandbox, `.git`), message `task(slug): taskId`, record `commitSha` in `steps[4].tasks[taskId]` (field already exists).
- Keep worker no commit rule; the orchestrator owns the save, same as Step 6 authorization.
- Step 6 stays as the delivery commit (or becomes fast forward / empty if per task commits already cover the set). Update `orchestrator_protocol.md` Step 4 and Step 6 plus `implementation_runner` docs accordingly.
- Alternative accepted: per task stash snapshot or patch artifact under `.sdw/state/` if intermediate commits are rejected for this phase.

## Verification
- [ ] `.gitattributes` present, `git check-attr` returns pinned values, `git ls-files --eol` has zero `w/mixed`.
- [ ] `npm test` passes after normalization (no content changes beyond EOL).
- [ ] Multi task DAG run shows one commit per accepted task plus final delivery state, and kill plus resume between tasks recovers file content.
- [ ] Docs updated: `orchestrator_protocol.md`, no duplicate spec of behavior in `AGENTS.md`

## Update: simplest checkpoint from spec 19 ideas

Borrow only the durable progress note from `00019-sdw-orch-checkpoint-resume` (status `awaiting-approval`), skip the heavier machinery (revision guard, run lock, pause-turn commands, atomic schema versioning).

Simplest viable path:
- After each accepted `task finish`, do one normal scoped commit with the existing helper (`stageAndCommitOnly`, same `isScopedExcluded` rules as Step 6). Message `task(slug): taskId`.
- Add one lightweight git tag as the checkpoint marker: `sdw-checkpoint-{runId}-{taskId}` pointing at that commit. Tag is the resume and rollback pointer, no extra state schema needed.
- Record that `commitSha` plus tag in `steps[4].tasks[taskId]` (field already exists). Step 6 stays the delivery commit and can fast forward or aggregate.
- No new commands, no lock file, no revision protocol in this cut. If a later cut needs spec 19 AC7 to AC10 (revision plus lock), add it separately.

Why this over alternatives:
- Normal commit reuses proven Step 6 path, survives crash and reset, visible in `git log`.
- Tag makes the checkpoint greppable without parsing JSON state.
- Stash or patch artifact under `.sdw/state/` was rejected for this cut because `.sdw/state/` is gitignored state, not durable history.

Verification for this cut:
- Multi task run shows one commit plus one tag per accepted task.
- Kill plus resume between tasks recovers file content via tag.
- `git tag --list sdw-checkpoint-*` matches completed tasks in state JSON.


### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for Add .gitattributes and per-task save in sdw-orch DAG.

### Prior Work Sweep

Reviewed existing workspace implementations and tracker references prior to specification formulation.

## Acceptance Criteria

- AC1: The system shall `.gitattributes` present, `git check-attr` returns pinned values, `git ls-files --eol` has zero `w/mixed`.
- AC2: The system shall `npm test` passes after normalization (no content changes beyond EOL).
- AC3: The system shall multi task DAG run shows one commit per accepted task plus final delivery state, and kill plus resume between tasks recovers file content.
- AC4: The system shall docs updated: `orchestrator_protocol.md`, no duplicate spec of behavior in `AGENTS.md`

## Notes

- Target files (project-relative): new repo-root `.gitattributes`, `skills/sdw-orch/scripts/sdw_orch.cjs`, `skills/sdw-orch/SKILL.md`, `skills/sdw-orch/references/orchestrator_protocol.md`, `tests/sdw_orch_dispatch.test.cjs`. The root `.gitattributes` has no directory segment, so it is named here as prose while the extractor skips it; it is still a new file required by AC1.
- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00044-us-16-add-gitattributes-and-per-task-sa |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Workspace directory standards | Follow canonical .sdw workspace guidelines | Consistent developer ergonomics across projects | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | Run validate_spec.cjs in authoring mode |
| Directory layout | Target workspace directories exist and are writable | File system check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Deterministic command execution logs and structured console progress reports.
- Non-zero exit codes returned upon validation or verification failures.

### Negative & Failing Test Scenarios

- Input rejection test case: the system must reject invalid inputs or malformed options with descriptive error messages.
