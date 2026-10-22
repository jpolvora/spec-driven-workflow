---
id: null
slug: 00053-batch-auto-merge-sdw-batch-merges-each-d
title: "batch auto-merge: sdw-batch merges each delivered pull request before advancing to the next specification"
source: local
status: draft
specDate: 2026-10-22
---

# Specification — batch auto-merge: sdw-batch merges each delivered pull request before advancing to the next specification

## Description

`sdw-batch` delegates each specification to `sdw-orch` and advances as soon as the item reports completion. Step 8 already converges the pull request, but it never merges it, so a queue leaves one open pull request per spec and every later item branches from an `develop` that does not contain the previous delivery. Sequential deliveries then work against a stale base, and the operator has to merge each pull request by hand before the next one is trustworthy. This specification makes the merge part of the queue contract: after an item ships, the batch merges that pull request through the configured SCM provider, then advances. It also adds the missing pre-flight: before delegating an item, the batch refreshes the base and proves the previous delivery is reachable from it, so an item can never start on a base that omits the work it follows.

### Design Intent

A queue is unattended by definition. If the batch cannot trust the base branch to contain the previous item, the next item is built on a guess. Merging between items is the smallest rule that removes that guess, and it reuses the merge contract `sdw-ship-pr --merge` already implements: one provider merge call, never branch deletion, and a merge failure recorded rather than thrown.

## Acceptance Criteria

- AC1: The system shall read `batch.autoMerge` from `.sdw/config.json` and resolve it to `true` when the key is absent.
- AC2: When an item completes with a delivered pull request and `batch.autoMerge` resolves to `true`, the system shall merge that pull request through the configured SCM provider before advancing to the next item.
- AC3: When `batch.autoMerge` resolves to `false` or `--no-merge` is supplied, the system shall skip the merge and record `merge.status` as `skipped` with the policy reason.
- AC4: If the merge request fails, then the system shall record the failure on the item and advance to the next item without changing the item's completed status.
- AC5: The system shall record per item `merge` with `requested`, `attempted`, `ok`, `status`, `prNumber`, and `at` in the batch manifest.
- AC6: When `sdw-batch resume` continues a queue, the system shall not merge an item whose manifest already records an attempted merge.
- AC7: The system shall print each item's merge outcome in the batch summary.
- AC8: The system shall accept `--no-merge` on both `sdw-batch run` and `sdw-batch resume`.
- AC9: The system shall document the auto-merge policy in `references/batch_protocol.md` and `SKILL.md`.
- AC10: The system shall add tests for merge with auto-merge enabled, the policy skip, a failed merge that continues the queue, no second merge on resume, and the summary output.
- AC11: When a queue is about to delegate an item, the system shall run a pre-flight that refreshes the base branch from the configured remote and records the resolved base commit on that item.
- AC12: When the pre-flight finds an earlier item whose pull request is still open, the system shall merge it before delegating the next item when `batch.autoMerge` is true, and shall halt the queue with a descriptive error when auto-merge is disabled.
- AC13: If the refreshed base does not contain the previous item's delivery commit, then the system shall halt the queue before delegating and name both the missing commit and the branch.

## Notes

- Item merge state is read from the delegated run: `.sdw/state/{runId}.state.json` `steps[8].output.pullRequest` provides `number` and `url`, and `shipStatus` must be `delivered`. An item without a pull request (provider `none`, `--dry-run`, or `shipStatus` other than `delivered`) records `skipped: no-pr`.
- The merge call reuses the SCM provider contract already used by `sdw-ship-pr --merge` (`gh pr merge <n> --merge`, `az repos pr update --id <n> --status completed`). The batch never invents provider flags and never deletes the head branch.
- Manifest additions are additive to the existing per-item record: `merge: { requested, attempted, ok, status, reason, prNumber, at }`. `status` is `merged`, `skipped`, or `failed`.
- The merge runs after the item's retro follow-up stage and before the queue advances, so a queued follow-up item still starts from an up-to-date base when the merge succeeded.
- A merge failure is an operator concern (permissions, pending approvals, branch rules), matching the `sdw-ship-pr` contract: record and continue. It never marks the item failed.
- The default is `true` because a batch is an unattended flow; a consumer that wants manual merges sets `batch.autoMerge: false` once.
- All new logic is Node.js 22 CommonJS standard library only, with no new runtime dependency.

## Out of Scope

| Feature | Feature reason |
|---------|----------------|
| Auto-merge for a single `sdw-orch` run | Stays explicit through `sdw-ship-pr --merge`; only the queue needs it to sequence items. |
| Branch deletion after merge | The product contract keeps delivered branches; cleanup is operator policy. |
| Release tagging, version bumps, or changelog generation after merge | Delivery bookkeeping, not queue sequencing. |
| Waiting for the merge to become visible on the remote base before the next item | The next item's branch activation already fetches and fast-forwards the work lane; adding a second wait is unneeded machinery. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default policy | `batch.autoMerge: true` | A queue is expected to land each item before starting the next; consumers that want manual merges opt out once. | y |
| Merge method | Provider default (merge commit) | Matches `sdw-ship-pr --merge`, so both paths behave identically. | y |
| Failed merge handling | Record and continue | Keeps the queue moving; the pull request is still open and reviewable. | y |
| Items without a pull request | `skipped: no-pr` | Nothing to merge when the provider is `none` or the ship was local. | y |
| Resume behavior | Never re-merge an attempted item | Re-running a queue must not double-merge or re-fire a failed merge silently. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00053-batch-auto-merge-sdw-batch-merges-each-d.md` |
| Manifest anchor | Per-item record and `saveManifest` locatable | Read `skills/sdw-batch/scripts/batch_queue.cjs` |
| Merge anchor | The provider merge contract used by ship-pr exists | Read `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` merge path and `references/ship_protocol.md` § 5 |
| Test anchor | A batch test suite exists to extend | `tests/sdw_batch.test.cjs` present |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Manifest field `queue[i].merge` with `requested`, `attempted`, `ok`, `status`, `prNumber`, `at`.
- Console lines `[sdw-batch] Merged <pr> for <slug>` or `[sdw-batch] Merge skipped/failed ...`, plus one summary column per item.
- Exit codes unchanged: the batch's exit code still reflects the delegated `sdw-orch` result, never the merge.

### Negative & Failing Test Scenarios

- Merge command exits non-zero: item stays `completed`, `merge.status` is `failed`, queue advances.
- `batch.autoMerge: false`: no merge call is made and `merge.status` is `skipped` with the policy reason.
- `--no-merge` overrides `batch.autoMerge: true` for the run.
- Resume after a successful merge: no second merge call is issued for that item.
- Item with `shipStatus` other than `delivered`: `merge.status` is `skipped` with `no-pr`.
