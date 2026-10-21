---
id: null
slug: 00020-sdw-orch-branch-strategy
title: "SDW Orchestrator Configurable Branch and Ship-Ref Strategy"
source: local
status: awaiting-approval
specDate: 2026-10-19
---

# Specification — SDW Orchestrator Configurable Branch and Ship-Ref Strategy

## Description

Spec 010 introduced a single feature-branch behavior: when `useFeatureBranches` is true, `sdw-orch` creates or reuses `feature/{specSlug}`. That covers one workflow shape, but it cannot keep the current branch, branch from a caller-selected base, or ask the operator at run time. Step 8 also assumes the delivery branch is the branch to push, without resolving feature, shared-head, or push-only shipping shapes. Consumers with protected branches, shared heads, or stacked work cannot use the pipeline safely.

This specification generalizes branch selection into a `branchStrategy` enum (`stay`, `from-current`, `from-base`, `prompt`) and adds deterministic ship-ref resolution before Step 8. It records the chosen strategy, base branch, base commit, and reuse state, and it never deletes the working branch.

### Design Intent

Keep branch policy explicit and reversible. `stay` is the safe default for callers that already prepared a branch; `from-current` and `from-base` cover the two common branch creation points; `prompt` delegates the choice to the operator when a run starts interactively. Ship-ref resolution separates "where the work lives" from "what gets pushed or reviewed", so shared-head and push-only deliveries do not require a second branch model.

## Acceptance Criteria

- AC1: The system shall support `stay`, `from-current`, `from-base`, and `prompt` branch strategies via `branchStrategy` in `.sdw/config.json`.
- AC2: The system shall default `branchStrategy` to `stay` when the key is absent.
- AC3: When `branchStrategy` is `stay`, the system shall keep the current branch unchanged.
- AC4: When `branchStrategy` is `from-current`, the system shall create the working branch from the current HEAD.
- AC5: When `branchStrategy` is `from-base`, the system shall create the working branch from the resolved base branch.
- AC6: When `branchStrategy` is `prompt`, the system shall ask the operator to choose a strategy before branch creation.
- AC7: If the repository is in detached HEAD state, then the system shall reject the `stay` strategy.
- AC8: If the working tree is dirty, then the system shall refuse to create or switch a branch.
- AC9: When the target branch already exists, the system shall reuse it and record `branchReused`.
- AC10: The system shall record the branch name, base branch, base commit, and strategy in run state.
- AC11: The system shall resolve ship refs as `feature`, `shared-head`, or `push-only` before Step 8.
- AC12: The system shall not delete the working branch during ship or merge.
- AC13: The system shall expose a `--branch-strategy` CLI override for one run.
- AC14: The system shall document branch strategies, detached-HEAD behavior, and ship-ref resolution.
- AC15: If branch creation fails, then the system shall halt the run before Step 1 execution.
- AC16: The system shall add tests for each strategy, detached HEAD, dirty tree, branch reuse, state recording, and ship-ref resolution.

## Notes

- Implementation surfaces:
  - `skills/sdw-orch/scripts/branch_strategy.cjs` (new): strategy resolution, base branch detection, branch creation/reuse, and ship-ref resolution.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: replace the `useFeatureBranches` block with strategy resolution; persist chosen strategy and refs; pass ship refs to Step 8.
  - `skills/sdw-orch/scripts/state_manager.cjs`: branch, base branch, base commit, strategy, reuse, and ship-ref fields.
  - `skills/sdw-orch/references/orchestrator_protocol.md`: document strategies and ship-ref shapes.
  - `.sdw/config.json` / `config.schema.json`: `branchStrategy`, `workingBranch`, `baseBranch`.
- Strategy behavior:
  - `stay`: current branch is the working branch. Reject detached HEAD because there is no branch to push or resume against.
  - `from-current`: create `workingBranch` or `feature/{slug}` at the current HEAD.
  - `from-base`: resolve `baseBranch`, then create the working branch from `origin/{baseBranch}` when available, otherwise from the local base branch.
  - `prompt`: present the three concrete strategies with a recommended default (`from-base` when the current branch is the base; otherwise `stay`).
- Ship-ref resolution:
  - `feature`: working branch is a feature branch; push and open a PR from it.
  - `shared-head`: working branch already contains other deliveries; push without claiming the whole branch as this spec's feature branch.
  - `push-only`: push the current ref without creating a PR.
- Dirty tree rule: branch creation or switching requires `git status --porcelain` to be empty. `stay` does not require a clean tree because no switch occurs.
- Branch reuse: if the target branch exists, switch to it and record `branchReused: true`; never reset it to the base.
- Failure policy: branch creation, switch, or base resolution failures halt before Step 1 with the git stderr and the attempted ref recorded in state.
- Tests: add `tests/sdw_branch_strategy.test.cjs`. Cover all four strategies, detached HEAD rejection, dirty tree refusal, existing branch reuse, base resolution fallback, CLI override, state fields, and feature/shared-head/push-only ship refs.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic merge conflict resolution | Conflicts remain an operator decision |
| Remote branch protection policy management | Provider configuration owns protection rules |
| Worktree-per-task lifecycle | Already covered by spec 010 and spec 015 |
| Stacked-branch rebase automation | Deferred until branch strategies are stable |
| Multi-repository branch coordination | Single-repository scope |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default strategy | `stay` | Safest for callers that already prepared a branch | y |
| Feature branch naming | `feature/{slug}` when no `workingBranch` is set | Preserves spec 010 behavior | y |
| Base branch resolution | `origin/{baseBranch}` then local base | Matches common remote-first workflows | y |
| Detached HEAD | Reject `stay` | No durable branch to push or resume | y |
| Dirty tree | Refuse branch switch | Prevents carrying unrelated changes across branches | y |
| Branch deletion | Never delete the working branch | Preserves delivery context and avoids destructive surprises | y |
| Ship-ref shapes | `feature`, `shared-head`, `push-only` | Covers the known delivery patterns without a general ref algebra | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Branch baseline | Spec 010 feature branch behavior inspected | Read `sdw_orch.cjs` and spec 010 |
| Git baseline | Worktree and branch operations available | Run `git --version` in a fixture |
| Workspace configuration | `.sdw/config.json` valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | This specification registered as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | This specification passes canonical authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00020-sdw-orch-branch-strategy.md` |
| Test baseline | Existing `node:test` suite passes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output for strategy selection, e.g. `[Branch] strategy=from-base base=main working=feature/020-...`.
- Run state contains `branchStrategy`, `branch`, `baseBranch`, `baseCommit`, `branchReused`, and `shipRefs`.
- `git branch --show-current` matches the recorded working branch after activation.
- Ship-ref output names `feature`, `shared-head`, or `push-only` before Step 8.
- A dirty tree or detached HEAD produces an actionable error before Step 1.

### Negative & Failing Test Scenarios

- Detached HEAD with `stay`: the run halts with a remediation message.
- Dirty tree with `from-base`: branch creation is refused.
- Missing base: `from-base` with an unknown base branch halts before Step 1.
- Existing branch: reuse switches and records `branchReused: true` without resetting.
- Prompt cancellation: the operator can cancel and the run halts without creating a branch.
- Push-only ship ref: Step 8 pushes without creating a PR.
- Shared head: the PR body does not claim unrelated commits as this spec's delivery.
- Branch deletion attempt: a fake git executor detects a delete call and fails the test.
