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
| other | Failure | Halt (default) or record and advance (`--continue-on-error`) |

Exit `3` (`--abort-on-gaps` grilling cancellation) is not a batch pause: the queue delegates unattended and never requests that flag, so a `3` is handled as a failure.

The host agent owns the paused single run: `task next`, `task finish`, `score submit`, then `sdw-batch resume`.

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
      "error": null
    }
  ]
}
```

Statuses: `pending`, `already_implemented`, `in_progress`, `awaiting_implementation`, `awaiting_judgment`, `completed`, `failed`.
Manifest statuses: `in_progress`, `paused`, `halted`, `completed`, `completed_with_errors`.

### Already-implemented skip

Before an item is delegated, `sdw-batch` reads the specification registry (`{specsDir}/index.specs.md`) and skips every spec recorded as `completed` or `archived`, recording the queue item as `already_implemented` with a `skipReason`. The check runs when the manifest is created and again per item before delegation, so a spec completed since the batch started (or during a resume) is never implemented twice. A registry that cannot be read warns and never blocks the queue.

A batch never refines a delivered specification. Refinement is an explicit single-spec call: `sdw-orch run <specPath> --second-pass` (alias `--refine`).

## 3. Resume Rules

- Resume skips items that are `completed` or `already_implemented`; neither is delegated again.
- Resume starts at the first item that is not `completed`.
- If the item records a `runId` whose state is `paused` or `in_progress`, delegate `sdw-orch resume` with that exact id (never a new run).
- If the recorded state is already `completed`, reconcile the item (copy delivery commit and branch) and advance without re-executing.
- If the state file is missing, delegate a fresh `run` with a new run id.
- The manifest policy (`continueOnError`, `syncIndex`) is preserved unless the resuming invocation overrides it.

## 4. Failure Policy

- Default: the item is marked `failed`, the manifest becomes `halted`, remaining items stay `pending`, and the command exits `1`.
- `--continue-on-error`: the failure is recorded and the queue advances; the final manifest becomes `completed_with_errors` and the command exits `1`.
- Batch exit codes are `0` (completed), `1` (failure or finished with errors), `4`/`5` (propagated pauses). A delegated failure code is recorded in `error`, never re-emitted, so no caller can mistake a failure for a pause.
- Resuming a batch whose manifest is `completed_with_errors` returns `1` and leaves the manifest unchanged; it never re-labels the batch as `completed`.

## 5. Summary

After completion, halt, or pause, `sdw-batch` prints one table: index, slug, status, duration, delivery commit. `--json` prints the manifest instead. Per-spec artifacts and state remain in the single run's directory.

## 6. Boundaries

- No parallel execution: one delegated run at a time.
- No direct calls to individual `sdw-orch` steps; the CLI is the only interface.
- No worker dispatch: the host agent spawns subagents for dispatched tasks.
- No duplicated review, scoring, or commit logic.
