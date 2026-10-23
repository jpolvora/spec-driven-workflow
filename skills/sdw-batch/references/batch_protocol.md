# sdw-batch Protocol Reference

`sdw-batch` is a queue around `sdw-orch`. It owns ordering, pause bookkeeping, and reporting; it owns no implementation step.

## 1. Delegation Contract

For each queue item, `sdw-batch` runs one of:

```bash
node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> --run-id <runId> --unattended --root <projectRoot>
node skills/sdw-orch/scripts/sdw_orch.cjs resume --run-id <runId> --root <projectRoot>
```

The child process inherits stdio and is awaited. Its exit code is the queue decision:

| Exit | Meaning | Batch action |
|---|---|---|
| `0` | Single-spec pipeline completed | Mark item completed, record delivery commit, sync index, next item |
| `4` | Dispatch pause (`awaiting_implementation`) | Record item + `runId`, manifest `paused`, exit `4` |
| `5` | Judge pause (`awaiting_judgment`) | Record item + `runId`, manifest `paused`, exit `5` |
| `6` | Delivery convergence pause (`awaiting_convergence`) | Record item + `runId`, manifest `paused`, exit `6` |
| other | Failure | Halt (default) or record and advance (`--continue-on-error`) |

Exit `3` (`--abort-on-gaps` grilling cancellation) is not a batch pause: the queue delegates unattended and never requests that flag, so a `3` is handled as a failure.

Exit `6` is the convergence pause: the delivery stage could not converge because checks are failing or review threads are open. The item is recorded `awaiting_convergence` with its `runId`, the manifest is `paused`, and `sdw-batch resume` re-delegates that exact run at its delivery stage so the host converges the pull request without a new run.

The delegated invocation carries `--new-run` when the operator passes it, so the orchestrator starts a fresh run instead of reusing an open one.

The host agent owns the paused single run: `task next`, `task finish`, `score submit`, then `sdw-batch resume`.

### Model hints across items (Spec 00056)

`sdw-batch` defines no model keys and carries no capability cache across items. Every item inherits the same consumer-local `.sdw/config.json`, and each delegated `sdw-orch` run resolves its advisory hints once at Step 1 and records the snapshot in that item's own `state.models`. A hint resolved for one item is never reused by the next, and the batch manifest records no hint fields.

## 2. Manifest

Path: `.sdw/state/batch-{batchId}.json` (gitignored run state).

```json
{
  "batchId": "batch-1792580000000",
  "createdAt": "2026-10-21T12:00:00.000Z",
  "updatedAt": "2026-10-21T12:10:00.000Z",
  "status": "paused",
  "policy": { "continueOnError": false, "syncIndex": true },
  "total": 3,
  "currentIndex": 0,
  "queue": [
    {
      "index": 0,
      "spec": ".sdw/specs/00036-example.md",
      "slug": "00036-example",
      "status": "completed",
      "skipReason": null,
      "runId": "run-1792580000000-00036-example",
      "deliveryCommit": "0dc5ce6...",
      "branch": "develop",
      "durationMs": 119400,
      "error": null,
      "retroFollowUp": {
        "status": "queued",
        "candidates": 2,
        "bySeverity": { "high": 1, "low": 1 },
        "reportPath": ".sdw/state/00036-example/run-1792580000000-00036-example/run-1792580000000-00036-example.retro.json",
        "queued": [
          { "candidateId": "RETRO-001", "spec": ".sdw/specs/00047-example-fix.md", "slug": "00047-example-fix" }
        ],
        "failures": []
      }
    },
    {
      "index": 1,
      "spec": ".sdw/specs/00047-example-fix.md",
      "slug": "00047-example-fix",
      "status": "pending",
      "followUpDepth": 1,
      "origin": { "candidateId": "RETRO-001", "runId": "run-1792580000000-00036-example" }
    }
  ]
}
```

Statuses: `pending`, `already_implemented`, `in_progress`, `awaiting_implementation`, `awaiting_judgment`, `awaiting_convergence`, `completed`, `failed`.
Manifest statuses: `in_progress`, `paused`, `halted`, `completed`, `completed_with_errors`.
Item fields: `retroFollowUp` records the follow-up outcome of a completed item; `followUpDepth: 1` and `origin` mark a queued follow-up item. `merge` records the pull request merge outcome of a completed item (§ 4); `preflight` records the base refresh and the start point that preceded its delegation (§ 4); `staleRun` records the stale classification (§ 5); `supersededRunId` records the stale run a `--new-run` replaced.

### Already-implemented skip

Before an item is delegated, `sdw-batch` reads the specification registry (`{specsDir}/index.specs.md`) and skips every spec recorded as `completed` or `archived`, recording the queue item as `already_implemented` with a `skipReason`. The check runs when the manifest is created and again per item before delegation, so a spec completed since the batch started (or during a resume) is never implemented twice. A registry that cannot be read warns and never blocks the queue.

A skip skips the implementation only. The item's merge stage and the pre-flight before the next delegation still run, so a delivered specification is never left with an open pull request or a base that omits its delivery.

### Delivery-evidence rule

The queue advances on evidence, never on a status string. The registry decides only whether a specification still needs implementation; whether its delivery reached the base is a git question, and whether its pull request is open is a provider question. Delivery evidence is read from recorded values in this order, and nothing is inferred from a title:

1. The queue item's own `runId` state (`deliveryCommit`, `branch`, step 8 `pullRequest`).
2. The most recent run state for the specification whose status is `completed` and which carries a `deliveryCommit`.
3. The SCM provider's pull request for the recorded head branch.

An item with no evidence records `merge.status: skipped` with reason `no-delivery-evidence`; the queue advances and the summary names every such item. An item with evidence runs the merge even when its implementation was skipped.

A batch never refines a delivered specification. Refinement is an explicit single-spec call: `sdw-orch run <specPath> --second-pass` (alias `--refine`).

## 3. Retro Follow-Up

After an item completes, `sdw-batch` reads that item's run state and consumes `state.retro`. It never re-derives candidates; the retrospective owns them.

| `retro.followUp` | Action |
|---|---|
| `queue` (default) | For every `critical` or `high` candidate, create one draft specification through `sdw-spec new <text> --title <title> --root <root> --json`, then append `{ index, spec, slug, status: "pending", followUpDepth: 1, origin: { candidateId, runId } }` after the last queue item and update `total`. |
| `record` | Write `.sdw/state/batch-{batchId}.followups.md` listing every candidate (severity, title, evidence, proposedChange) and create no specification. |
| `none` | Read no retro report; record `retroFollowUp: { status: "skipped" }`. |

`retroFollowUp` shape: `{ status, candidates, bySeverity, reportPath, queued, failures }`. `candidates` is the candidate count, `bySeverity` counts the severities present in the report, `queued` lists the created specifications, and `failures` records creation errors. A `skipped` record carries only `status`, because the report is never opened.

| Status | Meaning |
|---|---|
| `queued` / `recorded` | The report was consumed; `queued` appended specs (possibly none), `recorded` wrote the report file. |
| `unavailable` | No run state, no `state.retro`, or no report file. |
| `failed` | The retrospective itself failed; its report is not trusted. |
| `invalid` | The report is not JSON or has no `candidates` array. |
| `skipped` | `retro.followUp` is `none`; the report is never read. |
| `depth-exceeded` | The item is itself a follow-up (`followUpDepth >= 1`) under `queue`; its report is read and summarized, but no specification is queued. |

A follow-up item is still fully summarized: `candidates` and `bySeverity` stay visible, `queued` and `failures` stay empty, and no queue entry is appended. Under `record` a follow-up item records normally (`recorded`) and its candidates enter the follow-up report; only the `queue` policy has something to suppress.

A failed specification creation is recorded as `{ candidateId, error }` in `failures`; the remaining candidates are still processed, the item stays `completed`, and the queue status does not change. Queued specifications and failures appear in the summary. The stage never prompts and never halts the queue; only the delegated run outcome halts or pauses it.

## 4. Auto-Merge and Pre-Flight

### Auto-merge policy

`batch.autoMerge` in `.sdw/config.json` decides whether the queue merges each delivered pull request. An absent key resolves to `true`; only an explicit `false` opts out. `--no-merge` on `sdw-batch run` or `sdw-batch resume` disables the merge for that invocation only and never rewrites the configuration.

After an item completes and its follow-up stage finishes, the queue reads the delegated run's step 8 output (`pullRequest`, `shipStatus`). When the ship status is `delivered` and the pull request id is numeric, it issues one provider merge call through the configured `scmProvider`, reusing the `sdw-ship-pr --merge` contract: `gh pr merge <n> --merge` for GitHub, `az repos pr update --id <n> --status completed` for Azure DevOps. The queue never deletes the head branch and never invents provider flags.

Every completed item records `merge`:

| Field | Meaning |
|---|---|
| `requested` | The policy asked for a merge (`batch.autoMerge` true and `--no-merge` absent). |
| `attempted` | A provider merge call was issued. |
| `ok` | `true` when the provider accepted the merge, `false` when it failed, `null` when no call was made. |
| `status` | `merged`, `skipped`, or `failed`. |
| `reason` | The skip reason (`--no-merge`, `batch.autoMerge is false`, `no-pr`, `invalid-pr-number`, `no scm provider`) or the provider error. |
| `prNumber` | The targeted pull request id, when one existed. |
| `at` | ISO timestamp of the outcome. |

A merge failure is an operator concern (permissions, pending approvals, branch rules): the failure is recorded, the item stays `completed`, and the queue advances.

Two call sites read a recorded attempt, and they differ by design:

| Path | Rule |
|---|---|
| Per-item merge (`applyMerge`) | Any recorded attempt is final: a resumed queue never re-issues a merge whose attempt is already on the manifest, whether it succeeded or failed. |
| Pre-flight merge (`preflightMergeOpen`) | Only a record with status `merged` is final. While the earlier pull request is still open, the refreshed base cannot contain its delivery, so the pre-flight re-issues the merge, including a retry of a recorded `failed` attempt, which merged nothing. A record that already merged halts instead, naming the missing delivery commit. |

### Pre-flight

Before an item is delegated, the queue refreshes the base lane without checking anything out: `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>`, where `<base>` is `branching.workBranch`, then `branching.integrationBranch`, then the remote default branch. The resolved commit is recorded on the item:

```json
"preflight": {
  "requested": true,
  "status": "refreshed",
  "remote": "origin",
  "baseBranch": "develop",
  "baseCommit": "0dc5ce6...",
  "startPoint": "0dc5ce6...",
  "startPointSource": "fast-forwarded",
  "reason": null,
  "at": "2026-10-21T12:05:00.000Z"
}
```

`status` is `refreshed`, `halted`, `failed`, `no-remote`, `no-base-branch`, or `unavailable` (no git repository). Without a repository, a remote, or a resolvable base lane there is nothing shared to prove, so `no-remote`, `no-base-branch`, and `unavailable` record the condition and the queue proceeds. A failed fetch halts instead, because the queue cannot prove the base it would delegate onto.

The pre-flight also moves the local work lane onto the refreshed remote commit: `status: current` when it already matches, `fast-forwarded` when it moved, and `deferred` when a dirty work tree blocks the update. A lane that cannot reach the refreshed commit halts naming the lane and both commits. `startPoint` is the commit the next feature branch actually starts from, and `startPointSource` names why: over a dirty tree it is the refreshed remote ref (`origin/<lane>`), so a stale local lane never seeds the branch. Both values are recorded on the item and printed in the summary.

With a refreshed base, every earlier item that carries a delivery commit is a delivery to prove, whatever that item's status (`already_implemented`, `completed`, or any other): its commit must be reachable from the base (`git merge-base --is-ancestor`). A missing delivery is handled before delegating:

| Missing delivery | Action |
|---|---|
| Its pull request is still open and auto-merge is enabled | Merge the pull request now (same provider contract), refresh the base once more, and verify again. |
| Its pull request is still open and auto-merge is disabled (`batch.autoMerge: false` or `--no-merge`) | Halt with a descriptive error naming the pull request, the commit, and the branch. |
| No open pull request can deliver it (already merged, or never shipped) | Halt naming the missing commit and the branch. |

A halt prints `[sdw-batch] Pre-flight halted the queue before delegating "<slug>": ...`, sets the manifest to `halted`, leaves the item `pending`, prints the summary, and exits `1`. The operator merges the pull request or fixes the base, then resumes.

## 5. Resume Rules

- Resume skips items that are `completed` or `already_implemented`; neither is delegated again.
- Resume starts at the first item that is not `completed`.
- If the item records a `runId` whose state is `paused` or `in_progress`, delegate `sdw-orch resume` with that exact id (never a new run).
- If the recorded state is already `completed`, reconcile the item (copy delivery commit and branch) and advance without re-executing.
- If the state file is missing, delegate a fresh `run` with a new run id.
- Every resumed item is pre-flighted again before delegation (§ 4), so a base that advanced while the queue was paused is re-read rather than trusted.
- A resume never re-issues a merge already recorded on an item through the per-item path. The pre-flight re-issues one only for an earlier pull request that is still open while its delivery is missing from the refreshed base, and never for a record whose status is `merged`.
- The manifest policy (`continueOnError`, `syncIndex`) is preserved unless the resuming invocation overrides it.

### Stale-run rule

An open run (`paused` or `in_progress`) found for the item is resumed only while it is still valid. It is **stale** when its recorded base commit is not an ancestor of the refreshed work lane commit: `git merge-base --is-ancestor <run.baseCommit> <preflight.baseCommit>` fails. The predicate is the same one the base proof already uses.

The classification is recorded on the item as `staleRun` and named in the summary with both commits:

```json
"staleRun": {
  "classification": "stale",
  "runId": "run-1792587734077-00038-sdw-spec-drift-repair",
  "baseCommit": "6b2a568...",
  "laneCommit": "f00d1a2...",
  "superseded": true
}
```

| Situation | Action |
|---|---|
| Stale open run, `--new-run` absent | Halt the queue naming the run id, its base commit, the refreshed lane commit, and the `--new-run` remedy. The item is never marked `failed`: it was never delegated. |
| Stale open run, `--new-run` present | Record `supersededRunId`, start a fresh run, and never resume the stale one. |
| Open run whose base commit is an ancestor | Not stale: resume it as today. |

The operator decides, because a pause can be intentional. `--new-run` on `run` or `resume` is forwarded to the delegated invocation; the queue also accepts it on `resume` so a stale run left by a previous day never blocks an unattended queue.

## 6. Failure Policy

- Default: the item is marked `failed`, the manifest becomes `halted`, remaining items stay `pending`, and the command exits `1`.
- A pre-flight halt also exits `1` and sets the manifest to `halted`, but the item is never marked `failed`: it was never delegated.
- `--continue-on-error`: the failure is recorded and the queue advances; the final manifest becomes `completed_with_errors` and the command exits `1`.
- Batch exit codes are `0` (completed), `1` (failure or finished with errors), `4`/`5`/`6` (propagated pauses). A delegated failure code is recorded in `error`, never re-emitted, so no caller can mistake a failure for a pause.
- Resuming a batch whose manifest is `completed_with_errors` returns `1` and leaves the manifest unchanged; it never re-labels the batch as `completed`.

## 7. Summary

After completion, halt, or pause, `sdw-batch` prints one table: index, slug, status, duration, delivery commit, and merge outcome (`merged #<n>`, `failed`, `skipped: <reason>`, or `-`). Below the table it names every merge skipped for `no-delivery-evidence`, the `preflight.baseCommit` and `startPoint` each item used, and every stale open run with its classification and both commits (and whether `--new-run` superseded it). A follow-up section lists the queued specifications and every creation failure with its candidate id. `--json` prints the manifest instead. Per-spec artifacts and state remain in the single run's directory.

## 8. Boundaries

- No parallel execution: one delegated run at a time.
- No direct calls to individual `sdw-orch` steps; the CLI is the only interface.
- No worker dispatch: the host agent spawns subagents for dispatched tasks.
- No duplicated review, scoring, or commit logic.
- No direct specification authoring: follow-up drafts go through `sdw-spec`, and no follow-up is created from a follow-up item.
