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
| `3` | Grilling pause (`awaiting_grilling`) | Record item + `runId`, manifest `paused`, exit `3` |
| other | Failure | Halt (default) or record and advance (`--continue-on-error`) |

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
      "runId": "run-1792580000000-00036-example",
      "deliveryCommit": "0dc5ce6...",
      "branch": "develop",
      "durationMs": 119400,
      "error": null
    }
  ]
}
```

Statuses: `pending`, `in_progress`, `awaiting_implementation`, `awaiting_judgment`, `awaiting_grilling`, `completed`, `failed`.
Manifest statuses: `in_progress`, `paused`, `halted`, `completed`, `completed_with_errors`.

## 3. Resume Rules

- Resume starts at the first item that is not `completed`.
- If the item records a `runId` whose state is `paused` or `in_progress`, delegate `sdw-orch resume` with that exact id (never a new run).
- If the recorded state is already `completed`, reconcile the item (copy delivery commit and branch) and advance without re-executing.
- If the state file is missing, delegate a fresh `run` with a new run id.
- The manifest policy (`continueOnError`, `syncIndex`) is preserved unless the resuming invocation overrides it.

## 4. Failure Policy

- Default: the item is marked `failed`, the manifest becomes `halted`, remaining items stay `pending`, and the exit code is the delegated failure code.
- `--continue-on-error`: the failure is recorded and the queue advances; the final manifest becomes `completed_with_errors` and the command exits `1`.

## 5. Summary

After completion, halt, or pause, `sdw-batch` prints one table: index, slug, status, duration, delivery commit. `--json` prints the manifest instead. Per-spec artifacts and state remain in the single run's directory.

## 6. Boundaries

- No parallel execution: one delegated run at a time.
- No direct calls to individual `sdw-orch` steps; the CLI is the only interface.
- No worker dispatch: the host agent spawns subagents for dispatched tasks.
- No duplicated review, scoring, or commit logic.
