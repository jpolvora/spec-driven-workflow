---
id: null
slug: 00040-sdw-branching-strategy
title: "SDW Branching Strategy — Configurable Presets, Branch Lanes, and Post-Merge Sync"
source: local
status: draft
specDate: 2026-10-21
---
# Specification — SDW Branching Strategy

## Description

SDW assumes a single branch model today. `sdw-orch` creates `feature/{slug}` from the checked-out branch, `sdw-ship-pr` resolves the pull request base from `origin/HEAD` or an undocumented `config.baseBranch`, and nothing synchronizes the repository after a pull request merges. Repositories differ: some deliver straight to `main` (trunk-based, GitHub flow), some use `develop` as a staging lane and `master` as production, some merge feature branches into `develop` (Git Flow) and cut releases later, and some promote `main` through environment lanes (GitLab flow).

This specification makes the branch model a first-class configuration: a `branching.strategy` preset resolves the start lane, the pull request target, the pre-start update, and the post-merge synchronization, and any explicit key overrides the preset for repositories that need a different topology.

### Design Intent

Model every supported model as a relationship between two lanes plus a synchronization rule, not as hardcoded branch names:

- **work lane**: where feature branches start and where the repository returns after delivery.
- **integration lane**: where the pull request merges.

Presets name common relationships (`trunk`, `github`, `develop`, `gitflow`, `gitlab`); explicit keys name actual branches. That makes the sequence identical for every model: update the work lane, create the feature branch from it, deliver to the integration lane, then fast-forward the work lane to the merged integration lane. Git Flow releases, GitLab promotions, and maintenance branches use the same primitives with lane overrides, so no model needs a separate execution path.

## Acceptance Criteria

- AC1: The system shall define a `branching` configuration object in `.sdw/config.json` with keys `strategy`, `featurePrefix`, `workBranch`, `integrationBranch`, `updateWorkBranch`, `syncWorkBranchAfterMerge`, and `pushSyncedWorkBranch`.
- AC2: The system shall resolve defaults from the `branching.strategy` presets `trunk`, `github`, `develop`, `gitflow`, and `gitlab`, defaulting to `trunk`.
- AC3: Where an explicit `branching` key is present, the system shall resolve that key over the preset default.
- AC4: The system shall document every `branching` key and preset in `.sdw/config.schema.json` and `skills/sdw-config/references/config_spec.md`.
- AC5: The system shall validate every `branching` key in `sdw_config.cjs` and report an error naming the invalid key, its expected type, or the unknown strategy value.
- AC6: Where the resolved `workBranch` is a non-empty string, the system shall create the feature branch from that work branch instead of the checked-out branch. When local edits prevent checking out the work branch, the system shall create the branch from the checked-out branch with a warning, because a dirty working tree never blocks activation.
- AC7: While `updateWorkBranch` is `true`, the system shall fetch the work branch from `origin` and fast-forward it before creating the feature branch.
- AC8: If updating the work branch fails for a reason other than a dirty working tree, then the system shall exit `1` before creating the feature branch and leave the working tree unchanged. A dirty working tree skips the update, warns, and continues from the work branch as it stands, because a dirty tree never blocks activation.
- AC9: The system shall name the feature branch `{branching.featurePrefix}{specSlug}`.
- AC10: Where `workBranch` is absent, the system shall create the feature branch from the checked-out branch, preserving the trunk behavior.
- AC11: The system shall resolve the `sdw-ship-pr` pull request base branch and the `sdw-code-review` review base from `branching.integrationBranch`.
- AC12: When the pull request reaches `MERGED` and `branching.syncWorkBranchAfterMerge` is `true`, the system shall switch to the work branch, fast-forward it to the integration branch, and push it when `branching.pushSyncedWorkBranch` is `true`.
- AC13: If the post-merge fast-forward is not possible or the working tree is dirty, then the system shall leave every local branch untouched and record `branchingSync.status` as `blocked` with the reason in run state without failing the completed delivery.
- AC14: The system shall record the resolved strategy, its source, the effective branch values, and the synchronization outcome in run state.
- AC15: When `--dry-run` is passed, the system shall print the resolved branch plan (strategy, start branch, update step, feature branch, pull request target, post-merge actions) without mutating repository state.

## Notes

- Preset expansion. Explicit keys always win; `auto` means `origin/HEAD` when unresolved.

  | `strategy` | `workBranch` | `integrationBranch` | `updateWorkBranch` | `syncWorkBranchAfterMerge` |
  |---|---|---|---|---|
  | `trunk` (default) | `null` (current branch) | auto | `false` | `false` |
  | `github` | same as `integrationBranch` | auto | `true` | `true` |
  | `develop` | `develop` | auto (usually `master`) | `true` | `true` |
  | `gitflow` | `develop` | `develop` | `true` | `true` (same-lane fast-forward) |
  | `gitlab` | same as `integrationBranch` | auto | `true` | `true` (promotion lanes manual) |

- Other defaults: `featurePrefix` = `feature/`, `pushSyncedWorkBranch` = `false`, `useFeatureBranches` remains the master switch.
- Any lane name works through overrides. A release run sets `integrationBranch` to `release/1.4`; a maintenance run sets `workBranch` to `maintenance/2.x`; a GitLab promotion reuses the post-merge sequence with `workBranch` = `main` and `integrationBranch` = `staging`.
- Update sequence: `git switch <workBranch>`, `git fetch origin`, `git merge --ff-only origin/<workBranch>`; a dirty working tree skips the update with a warning instead of exiting.
- Feature creation: `git switch -c <featurePrefix><slug> <workBranch>`; when the checkout is refused by local edits, fall back to `git switch -c <featurePrefix><slug>` from the checked-out branch with a warning.
- Post-merge sequence: `git switch <workBranch>`; when the work lane equals the integration lane, `git fetch origin` then `git merge --ff-only origin/<integrationBranch>`; otherwise `git fetch origin +refs/heads/<integrationBranch>:refs/remotes/origin/<integrationBranch>` then `git merge --ff-only origin/<integrationBranch>` (the fetch writes only the remote-tracking ref, so a blocked fast-forward leaves every local branch untouched and a narrowed fetch refspec cannot leave the tracking ref stale); then optional `git push origin <workBranch>`.
- The undocumented top-level `baseBranch` key is replaced by `branching.integrationBranch`; no compatibility shim is added.
- The post-merge synchronization runs inside `sdw-ship-pr` when the convergence loop observes `MERGED`. When the merge is observed by a later run instead, AC7's pre-start update repairs the work branch.
- A diverged work branch is never reset or rebased automatically; it is reported as `blocked` with the remediation command.
- Run state fields: `branching` with the resolved strategy, source, and lane names; `branchingSync` with `{ status, reason, integrationBranch, workBranch, at }`.

### Acceptance Criteria Amendments

Three criteria were amended during delivery, with the maintainer's direction to follow the documented gitflow contract:

- **AC10** originally kept the trunk fallback when `workBranch` equaled `integrationBranch`. That made a gitflow run started on another branch create the feature branch from that branch instead of `develop`, which contradicts the gitflow preset contract in `config_spec.md` §2.4. AC10 now limits the trunk fallback to the case where no work lane is configured; a configured lane is always the start point.
- **AC15** originally forbade any git command during `--dry-run`. Resolving an `auto` lane requires a read-only `origin/HEAD` lookup, otherwise the plan reports trunk behavior for the `github` and `gitlab` presets. AC15 now requires no repository mutation, and the read-only lookup is allowed.
- **AC6 and AC8** originally required the work lane start point and a hard exit on any update failure. That conflicts with the product guarantee that a dirty working tree never blocks branch activation. The precedence is now explicit: a dirty tree skips the update and continues from the work lane as it stands, and when local edits prevent the work-lane checkout the feature branch starts from the checked-out branch with a warning. Tightening either behavior again requires relaxing that guarantee first.

All amendments are recorded here so the contract change is visible rather than implied by the code.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic release and hotfix branch management (cut, version bump, back-merge) | Git Flow releases are a separate lifecycle; this spec only makes the delivery lane configurable |
| Automatic promotion between GitLab environment lanes | Promotions are release events with their own approvals; the spec documents the reusable sequence |
| Deleting the feature branch after merge | Cleanup policy is independent of the branching model and adds destructive behavior |
| Rebase or reset of a diverged work lane | The workflow fast-forwards; rewriting history is destructive and must stay manual |
| Fork-based pull requests from a second remote | SDW assumes a single `origin`; a fork model is a future extension |
| Branch protection rules and required checks | SCM-side governance, not SDW configuration |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default model | `trunk` | Repositories without a staging lane need no new configuration | y |
| Preset naming | `trunk`, `github`, `develop`, `gitflow`, `gitlab` | Names match the vocabulary maintainers already use | y |
| Work lane and integration lane | `develop` and `master` for the develop model | Matches the maintainer's model: features start from develop, pull requests target master | y |
| Pre-start update | Enabled by presets that name a work lane | Guarantees features start from the updated lane | y |
| Post-merge synchronization | Enabled when the preset names a work lane | Closes the loop without manual branch surgery | y |
| Push of the synchronized lane | Disabled | Avoids surprising remote writes; opt-in per repository | y |
| Diverged lane | Blocked, never rewritten | History rewriting is destructive and must stay a manual decision | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification validation | Frontmatter, hierarchy, and EARS criteria pass | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00040-sdw-branching-strategy.md` |
| Configuration contract | All keys and presets have defaults, schema entries, and documentation | Run `node skills/sdw-config/scripts/sdw_config.cjs check`; inspect `.sdw/config.schema.json` and `skills/sdw-config/references/config_spec.md` |
| Preset resolution | Preset defaults plus overrides resolve deterministically | New unit cases in `tests/sdw_config.test.cjs` |
| Branch creation behavior | Feature branches start from the work lane, not from HEAD | Extend `tests/sdw_branch_worktree.test.cjs` with preset cases |
| Post-merge synchronization | Fast-forward, same-lane, push, and blocked paths are covered | New `tests/sdw_branch_sync.test.cjs` |
| Dry-run branch plan | Plan prints the resolved lanes and actions with no git side effects | Case in `tests/sdw_orch.test.cjs` |
| Documentation synchronization | README, FEATURES, GLOSSARY, and the orchestrator protocol describe the block and presets | Inspect the four files |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Branch creation prints `[Branch Activation] <strategy>: created <feature> from <workBranch> at <sha>`.
- Post-merge synchronization prints `[Branch Sync] <strategy>: fast-forwarded <workBranch> to <integrationBranch> at <sha>`.
- `--dry-run` prints `Strategy: <name>`, `Start lane: <branch> (update: yes|no)`, `Feature branch: <prefix><slug>`, `Pull request target: <branch>`, and `After merge: <actions>`.
- Run state records `branching` (strategy, source, lanes) and `branchingSync` (status, reason, branches, timestamp).
- The pull request base reported by `sdw-ship-pr` equals `branching.integrationBranch`.

### Negative & Failing Test Scenarios

- Unknown `branching.strategy`: `sdw_config check` exits non-zero naming the value and the allowed presets.
- Work lane behind `origin` and the fetch fails: `sdw-orch` exits `1` before creating the feature branch.
- Work lane diverged from the integration lane after merge: `branchingSync.status` is `blocked` and no local branch moves.
- Dirty working tree during post-merge synchronization: blocked, no checkout performed.
- `useFeatureBranches: false`: no feature branch is created and no synchronization runs.
