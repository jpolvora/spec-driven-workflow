---
name: sdw-batch
description: Queue multiple specifications and delegate each one to sdw-orch as an independent single-specification run.
version: 0.1.0
invocation_names:
  - sdw-batch
  - sdw-batch run
  - sdw-batch resume
  - sdw-batch status
  - batch
---
# sdw-batch

> When this skill is loaded, output "sdw-batch loaded."

Coordinates a queue of specifications. Each item runs through the complete `sdw-orch` pipeline exactly as if it were the only specification; the batch only loops, waits, and records outcomes.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) before running. `sdw-batch` never implements, reviews, or commits code itself.

## Subcommands

- `run <specPath...> [--no-merge]`: Creates the queue manifest and delegates specifications one by one to `sdw-orch`.
- `resume [batchId] [--no-merge]`: Continues a paused queue from its first non-completed item, reusing that item's run.
- `status [batchId]`: Prints queue progress and per-item status.

## Behavior

- One delegated run at a time: `sdw-orch run <spec>` and wait for its exit code.
- Specs recorded as `completed` or `archived` in `index.specs.md` are skipped (`already_implemented`) before delegation, including on resume. `sdw-batch` never refines; a delivered spec is refined only by an explicit `sdw-orch run <spec> --second-pass`.
- Exit `0` completes the item and advances; exit `4` or `5` pauses the queue with the item's `runId` recorded.
- `resume` continues the paused run through `sdw-orch resume --run-id`; a run that already completed is reconciled without re-execution.
- A failed item halts the queue unless `--continue-on-error` is supplied.
- After an item completes, the follow-up stage reads its `state.retro` report under `retro.followUp` (default `queue`): `critical`/`high` candidates become draft specs appended after the remaining items, `record` writes one follow-up report, and `none` reads no report. Follow-up items carry `followUpDepth: 1`: their own candidates are summarized but never queued. The stage never prompts, and a creation failure is recorded without halting the queue.
- After the follow-up stage, the item's delivered pull request is merged through `scmProvider`. `batch.autoMerge` defaults to `true`; `--no-merge` or `batch.autoMerge: false` records `merge.status: skipped` with the reason. A failed merge records `failed` and never changes the item's `completed` status, and a resume never re-issues an attempted merge. An item without a delivered pull request records `skipped: no-pr`.
- Before an item is delegated, a pre-flight refreshes the base lane from `origin` and records `preflight.baseCommit` on the item. An earlier delivery commit missing from the refreshed base is merged first when auto-merge is enabled; otherwise the queue halts naming the commit and the branch.
- No step logic is duplicated: implementation, scoring, delivery commit, review, PR, and convergence stay in `sdw-orch`.

## Steps

1. **Validate the queue**
   Resolve every specification path and reject the batch before creating anything when a file is missing.
   - Run: `node skills/sdw-batch/scripts/sdw_batch.cjs run <specPath...> --dry-run`
   - Done when: every path resolves or the command reports the missing one.

2. **Initialize the manifest**
   Create `.sdw/state/batch-{batchId}.json` with queue entries and policy.
   - Done when: the manifest exists with one entry per specification and status `in_progress`.

3. **Pre-flight the base**
   Refresh `origin/{workBranch}` (falling back to `branching.integrationBranch`, then the remote default) before delegating, record `preflight` on the item, and prove that every earlier delivery commit is reachable from the refreshed base. An earlier delivery missing from the base is merged through its still-open pull request when auto-merge is enabled; a disabled policy, or a base that still misses the commit, halts the queue before delegation.
   - Done when: the item records `preflight.status: refreshed` with a `baseCommit`, or the queue is `halted`.

4. **Delegate one specification**
   Invoke `sdw-orch` for the current item and wait. A pause code (`4` dispatch, `5` judgment) stops the loop and records the run id; the host agent drives the paused single run.
   - Done when: the item is `completed`, `failed`, or `awaiting_*` in the manifest.

5. **Apply the retro follow-up**
   Read the completed item's `state.retro` report and apply `retro.followUp` (`queue`, `record`, or `none`). Record `retroFollowUp` on the item; queue draft specs only for `critical`/`high` candidates, and only from an item whose `followUpDepth` is below `1`. A follow-up item still records its candidate summary as `depth-exceeded`; `none` reads no report.
   - Done when: the item records its follow-up status (`queued`, `recorded`, `skipped`, `unavailable`, `failed`, `invalid`, or `depth-exceeded`) without prompting, and a creation failure stays in the summary instead of halting the queue.

6. **Merge the delivered pull request**
   When `batch.autoMerge` is true and `--no-merge` is absent, merge the item's delivered pull request through `scmProvider` and record `merge` on the item. A provider failure is recorded, never thrown: the item stays `completed` and the queue advances.
   - Done when: the item records `merge.status` (`merged`, `skipped`, or `failed`).

7. **Advance or stop**
   Advance to the next item after completion, or halt/pause per policy and exit with the delegated code.
   - Done when: the queue is `completed`, `paused`, or `halted`, and the summary is printed.

## Reference

- Delegation contract, manifest schema (including `merge` and `preflight`), auto-merge policy, pre-flight rules, follow-up policy, pause protocol, and failure policy: [`references/batch_protocol.md`](references/batch_protocol.md)
- Retro candidate contract consumed by the follow-up stage: [`sdw-retro`](../sdw-retro/SKILL.md)
- Deterministic queue: [`scripts/sdw_batch.cjs`](scripts/sdw_batch.cjs)
