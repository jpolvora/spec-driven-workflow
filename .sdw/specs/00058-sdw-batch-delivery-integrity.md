---
id: null
slug: 00058-sdw-batch-delivery-integrity
title: "SDW Batch Delivery Integrity — Merge, Pre-Flight, Base Freshness, and Registry Truth"
source: local
status: implemented
specDate: 2026-10-22
priority: high
value: "Makes the queue merge every delivered item, prove the base before delegating, survive a stale paused run, and keep the registry honest about what shipped"
effort: L
---
# Specification — SDW Batch Delivery Integrity

## Description

Spec 00053 gave `sdw-batch` an auto-merge stage and a pre-flight base proof. In batch `batch-1792676130708` neither stage ran, and the queue delivered five specifications only because the host performed every merge by hand:

- Items 00053 and 00052 were recorded `already_implemented` and skipped. The skip path returns before `applyMerge` (`batch_queue.cjs:926` against `:985`) and before `runPreflight` (`:926` against `:934`), so no merge was attempted and no base was refreshed. Pull request #40 for 00052 stayed open while the queue advanced.
- `missingDeliveries` filters `prior.status === 'completed'` (`:670`), so a skipped item that did ship is invisible to the base proof. Item 00054 was delegated from `cf85f65`, a base that does not contain the 00052 delivery, and the pre-flight reported nothing missing.
- The pre-flight refreshes `refs/remotes/origin/develop` (`:647`) while the feature branch is cut from `refs/heads/develop` (`sdw_orch.cjs:1255`). A refreshed remote-tracking ref therefore proves nothing about the commit the next branch actually starts from. When the work tree is dirty, the lane fast-forward is skipped with a warning (`sdw_orch.cjs:1230`) and the stale local lane seeds the branch.
- `applyMerge` requires `shipStatus === 'delivered'` (`:564`). Run `run-1792692324898` for 00055 ended at `review_pending` with pull request 43 already open, so the merge stage read it as `no-pr` and skipped it.
- `PAUSE_STATUS` maps only exit codes 4 and 5 (`:13`). An unconverged pull request fails the delivery stage with exit 1, which the queue records as `failed` and, with `continueOnError: false`, halts the queue. Run `run-1792681460114` for 00054 failed twice this way while its threads were being converged.
- `sdw-batch` has no `--new-run` passthrough, so a paused run left from a previous day blocks delegation. `run-1792587734077` for 00038 was paused with `baseCommit 6b2a568`, predating every delivery merged since; the item was recorded `failed` and the queue halted. Seven such paused runs are on disk.
- Step 6 marks the specification `completed` in the registry (`sdw_orch.cjs:2094`) before the delivery commit is created (`:2110`) and long before the delivery stage ships. A run that fails after Step 6 leaves a registry row that claims a delivery that never happened, which is the row the skip path trusts.
- Seven specifications disagree between the registry and their own header: 00038 declares `ready-to-implement` and 00050 to 00055 declare `draft`, while the registry records all seven as `completed`.

This specification makes the queue's advance conditional on delivery evidence rather than on a registry row. An item is skipped for implementation only; the merge and the pre-flight still run for it, the base proof counts every earlier delivery whatever the item status, the branch is cut from a commit the pre-flight proved, an unconverged delivery pauses the queue instead of failing it, a stale paused run is named and overridable, and the registry row flips only after the delivery ships.

### Design Intent

One rule replaces the current mix: the queue advances on evidence, never on a status string. The registry decides only whether a specification still needs implementation; whether its delivery reached the base is a git question, and whether its pull request is open is a provider question. Each stage therefore answers its own question, and no stage trusts another's summary. A pause is a pause: anything the host must do between two steps is a pause with its own exit code, never a failure that halts an unattended queue.

## Acceptance Criteria

- AC1: When the registry records a specification as `completed` or `archived`, the system shall record the queue item as `already_implemented`, skip its implementation, and still run the merge stage for that item.
- AC2: When the registry records a specification as `completed` or `archived`, the system shall still run the pre-flight before delegating the next item.
- AC3: The system shall adopt the delivery evidence of that specification's most recent completed run (run id, delivery commit, branch, and pull request) onto the queue item before the merge stage runs.
- AC4: If no completed run and no pull request resolve for an `already_implemented` item, then the system shall record the merge as skipped with reason `no-delivery-evidence` and shall name the item in the summary.
- AC5: The pre-flight shall treat every earlier queue item that carries delivery evidence as a delivery to prove, whatever that item's status.
- AC6: When the refreshed base omits an earlier delivery, the system shall merge that delivery's open pull request before delegating, and shall halt naming the delivery commit and the base branch when no merge can land it.
- AC7: The pre-flight shall fast-forward the local work lane to the refreshed remote lane commit, and shall halt naming the lane and both commits when the local lane cannot reach it.
- AC8: When the work lane cannot be fast-forwarded over a dirty work tree, the system shall start the feature branch from the refreshed remote lane commit and shall record the start point it used.
- AC9: The merge stage shall resolve the pull request from the delegated run's step 8 output, then from the run state, then from the SCM provider by head branch, in that order.
- AC10: When the delegated run ended with ship status `review_pending` and the provider reports that pull request merged, the system shall record the merge as `merged` rather than skipped.
- AC11: When the delivery stage cannot converge because checks are failing or review threads are open, the system shall pause with exit code `6`, set the item to `awaiting_convergence`, and set the manifest to `paused`.
- AC12: The system shall continue an `awaiting_convergence` item from the delivery stage on resume, so the host converges the pull request and the queue advances without a new run.
- AC13: The system shall accept `--new-run` on `sdw-batch run` and `sdw-batch resume` and shall pass it to the delegated run.
- AC14: The system shall classify an open run as stale when its base commit is not an ancestor of the refreshed work lane, and shall name that classification and both commits in the summary.
- AC15: When a stale open run blocks delegation and `--new-run` is absent, the system shall halt naming the run id, its base commit, and the `--new-run` remedy, instead of recording the item as `failed`.
- AC16: When `--new-run` is present, the system shall start a fresh run, record the superseded run id on the item, and never resume the stale run.
- AC17: The system shall mark a specification `completed` in the registry only after the delivery stage reports the delivery, or when `--skip-pr` is in effect.
- AC18: If a run fails before the delivery stage, then the system shall leave the specification's registry row unchanged, or restore it to `pending` when an earlier step changed it.
- AC19: When the system marks a specification `completed`, the system shall set that specification's header status to `implemented` in the same transition.
- AC20: The system shall report every specification whose registry status and header status disagree, naming the file, the registry value, and the header value.
- AC21: The delivery of this specification shall repair every specification that disagrees at delivery time, which is 00038, 00050, 00051, 00052, 00053, 00054, and 00055.
- AC22: The batch protocol, the orchestrator protocol, and the `sdw-batch` and `sdw-orch` skill definitions shall document the convergence pause code, the delivery-evidence rule, and the stale-run rule within the Tier-1 line budgets.
- AC23: The test suite shall cover the skip path with and without delivery evidence, the missing-delivery halt, the local lane fast-forward, the dirty-tree start point, the provider-resolved pull request, the convergence pause and its resume, the stale-run halt and its override, and the registry transition ordering.

## Notes

- Observed evidence for this specification: batch `batch-1792676130708` (5 items, `skipped: 5`, every merge performed by the host), item 00054 delegated from `cf85f65` without the 00052 delivery, run `run-1792692324898` with `shipStatus: review_pending` and `pullRequest.number: 43`, run `run-1792681460114` failing twice with `Pull request did not converge`, paused runs `run-1792581339257`, `run-1792584617420`, `run-1792587734077`, `run-1792590824737`, `run-1792594057194`, `run-1792612060368`, `run-1792623789042`, and the seven registry rows that disagree with their specification headers.
- Exit codes after this change: `0` delivered, `1` failure, `2` judge fail-closed, `3` grilling abort, `4` dispatch pause, `5` judgment pause, `6` delivery convergence pause. The batch treats `4`, `5`, and `6` as pauses and every other non-zero code as a failure.
- Manifest additions: `item.merge` keeps its current shape and gains the `no-delivery-evidence` skip reason; `item.preflight` gains the resolved `baseCommit` and the `startPoint` actually used for the branch; `item.supersededRunId` records the stale run a `--new-run` replaced; `item.status` gains `awaiting_convergence`.
- Delivery-evidence resolution order for a skipped item: the queue item's own `runId`, then the most recent run state for the specification whose status is `completed` and which carries a `deliveryCommit`, then the provider's pull request for the feature branch. Every source is a recorded value; the queue never guesses a branch name from a title.
- Stale-run rule: an open run is stale when `git merge-base --is-ancestor <run.baseCommit> <refreshed lane commit>` fails. A run whose base commit is an ancestor is not stale and is resumed as today.
- Registry transition order after this change: Step 6 creates the delivery commit without touching the registry; Step 8 marks the specification `completed` and sets the header to `implemented` only after the delivery stage reports a delivered pull request or after `--skip-pr`; a run that fails before that leaves both unchanged. This satisfies spec 00002 AC24, which places the transition after delivery completes, and it removes the false `completed` row that the skip path currently trusts.
- Consequence of that order, to handle at delivery time: the delivery stage has already pushed the branch when the transition runs, so the registry row and the header become worktree changes that no commit on the branch contains yet. The delivery must commit those two paths on the branch before the pull request is merged, otherwise the flip reaches the integration lane only through a later sync. A run started from a lane that still carries those uncommitted changes must not leak them into the next specification's branch.
- Header repair: `sdw-spec sync` reconciles the header status from the registry when the registry is authoritative, and reports every disagreement it cannot resolve.
- Target surfaces:
  - `skills/sdw-batch/scripts/batch_queue.cjs`: the skip path runs the merge and pre-flight stages, `missingDeliveries` keys on delivery evidence, the pre-flight fast-forwards the local lane and records the start point, the provider-based pull request resolution, the convergence pause, and the stale-run classification.
  - `skills/sdw-batch/scripts/sdw_batch.cjs`: `--new-run` on `run` and `resume`, and the summary lines for `no-delivery-evidence`, stale runs, and the start point.
  - `skills/sdw-batch/references/batch_protocol.md`: the pause table, the delivery-evidence rule, and the stale-run rule.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: exit code `6` for an unconverged delivery, the registry transition moved after the delivery stage, the header update in the same transition, and the branch start point taken from the refreshed lane when the local lane is stale.
  - `skills/sdw-orch/references/orchestrator_protocol.md`: exit code `6`, the transition order, and the branch start point rule.
  - `skills/sdw-orch/SKILL.md` and `skills/sdw-batch/SKILL.md`: the new pause code and the evidence rule inside the Tier-1 line budgets.
  - `skills/sdw-spec/scripts/spec_index.cjs`: `updateSpecStatus` writes the specification header status in the same transition as the registry row.
  - `skills/sdw-spec/scripts/spec_sync.cjs` and `skills/sdw-spec/scripts/sdw_spec.cjs`: the registry and header drift report, naming the file and both values, plus the header repair path.
  - `.sdw/specs/00038-sdw-spec-drift-repair.md`, `00050-sdw-ship-pr-native-pre-pr-enforcement-ga.md`, `00051-issue-linkage-imported-scm-issues-close-.md`, `00052-sdw-fresh-subagent-code-review.md`, `00053-batch-auto-merge-sdw-batch-merges-each-d.md`, `00054-sdw-orch-delivery-report-companion-file-.md`, and `00055-sdw-spec-list-by-priority.md`: the seven headers repaired to `implemented`.
  - `tests/sdw_batch.test.cjs` and `tests/sdw_batch_retro.test.cjs`: the skip-path merge and pre-flight, the base proof over skipped items, the convergence pause, and the stale-run halt and override.
  - `tests/sdw_orch.test.cjs` and `tests/sdw_scoped_commit.test.cjs`: the registry transition order, the header update, and the start point selection.
  - `tests/sdw_spec_header_drift.test.cjs`: the drift report and the header repair.
- All helper scripts remain Node.js CommonJS (.cjs) using standard library modules only. No new runtime dependencies.

## Out of Scope

| Feature | Reason |
|---------|--------|
| The delivery report companion and its relocation to `.sdw/reports/` | Owned by the report relocation specification; this one changes no report path |
| The delivery report's incremental contributions, learnings, and retro closure | Owned by spec 00057 |
| The observation heuristic and the `--collisions` ranking noise | Owned by the observation precision specification |
| Skipping the full test suite for a specification-only diff | Owned by the pre-PR gate specification |
| Changing the merge method, the provider contract, or the branch deletion policy | Spec 00053 fixed those; this specification changes only when the merge runs and what proves it |
| Worktree mode and sandbox execution | Unrelated to the queue's advance rule |
| A queue-level retry policy for provider merge failures | A merge failure stays an operator concern, as spec 00053 decided |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| The registry decides implementation, never delivery | Delivery evidence decides the merge and the base proof | A status string cannot prove a commit reached the base | y |
| Skip means skip the implementation only | Merge and pre-flight still run for `already_implemented` items | This is the defect that left PR #40 open and seeded a stale base | y |
| An unconverged delivery is a pause | Exit code `6`, item `awaiting_convergence` | The host owns convergence, exactly as it owns dispatch and judgment | y |
| Stale means the base commit is not an ancestor | `git merge-base --is-ancestor` against the refreshed lane | The same predicate the base proof already uses | y |
| A stale run is overridable, never auto-discarded | `--new-run` starts a fresh run and records the superseded id | A pause can be intentional; the operator decides | y |
| The registry transition follows the delivery stage | Step 8, after a delivered pull request or `--skip-pr` | Matches spec 00002 AC24 and removes the false `completed` row | y |
| The header follows the registry | Set to `implemented` in the same transition | One transition, two surfaces, no drift | y |
| Existing drift is repaired by this delivery | 00038 and 00050 to 00055 | Seven rows already disagree and no automated pass can prove the delivery for them | y |
| `--new-run` in the batch matches the single-run flag | Same name, same meaning | The flag already exists on `sdw-orch run`; the batch only forwards it | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|--------------|---------------------|
| EARS syntax | All 23 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00058-sdw-batch-delivery-integrity.md` |
| Scope enclosure | The skip path, the base proof, the pause, the stale run, and the registry transition | Inspect `## Description` plus `## Out of Scope` |
| Target inventory | Batch queue and CLI, orchestrator, both protocols, both skill definitions, and tests | Inspect `## Notes` target list |
| Dependency | Spec 00053 is delivered, so the auto-merge stage, the pre-flight, and the manifest records exist | Check the registry row for 00053 |
| Baseline suite | Existing test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- A batch whose items are already `completed` in the registry still records a `merge` outcome for each of them, and the summary shows `Merge: <pr>` rather than `-`.
- The pre-flight records the refreshed `baseCommit` and the `startPoint` used for the next branch.
- Every delegated branch's base commit contains every earlier item's delivery commit.
- A delivery that cannot converge returns exit `6`, the manifest shows `paused`, and the item shows `awaiting_convergence`.
- A stale paused run halts with a message naming the run id, its base commit, and `--new-run`; the same command with `--new-run` starts a fresh run and records `supersededRunId`.
- A specification's registry row and header agree after delivery, and `sdw-spec sync` reports zero disagreements.
- The summary names every merge skipped for `no-delivery-evidence`.

### Negative & Failing Test Scenarios

- Skipped item with no resolvable delivery evidence: the merge is skipped with `no-delivery-evidence`, the queue advances, and the next item's base proof reports the absence rather than passing silently.
- Missing delivery with no open pull request: the pre-flight halts naming the commit and the branch, and no item is delegated.
- Local lane behind the refreshed remote lane: the pre-flight fast-forwards it; when the fast-forward is impossible, it halts naming both commits.
- Dirty work tree over the lane update: the branch starts from the refreshed remote commit, and the recorded start point names the remote ref.
- Provider reports the pull request merged while the run says `review_pending`: the merge is recorded `merged`, not skipped.
- Stale run without `--new-run`: the item is not marked `failed`, the manifest is `halted`, and the remedy is named.
- Failure before the delivery stage: the registry row is unchanged or restored to `pending`, and the header is unchanged.
- Header repair: a specification whose header disagrees is repaired by `sdw-spec sync` and the disagreement is reported.
- Idempotence: a resumed queue that already merged an item issues no second merge, as spec 00053 decided.
- Budget: `skills/sdw-orch/SKILL.md` and `skills/sdw-batch/SKILL.md` stay within their Tier-1 line budgets.
