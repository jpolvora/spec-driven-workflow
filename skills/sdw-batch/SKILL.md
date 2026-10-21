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

- `run <specPath...>`: Creates the queue manifest and delegates specifications one by one to `sdw-orch`.
- `resume [batchId]`: Continues a paused queue from its first non-completed item, reusing that item's run.
- `status [batchId]`: Prints queue progress and per-item status.

## Behavior

- One delegated run at a time: `sdw-orch run <spec>` and wait for its exit code.
- Exit `0` completes the item and advances; exit `4` or `5` pauses the queue with the item's `runId` recorded.
- `resume` continues the paused run through `sdw-orch resume --run-id`; a run that already completed is reconciled without re-execution.
- A failed item halts the queue unless `--continue-on-error` is supplied.
- No step logic is duplicated: implementation, scoring, delivery commit, review, PR, and convergence stay in `sdw-orch`.

## Steps

1. **Validate the queue**
   Resolve every specification path and reject the batch before creating anything when a file is missing.
   - Run: `node skills/sdw-batch/scripts/sdw_batch.cjs run <specPath...> --dry-run`
   - Done when: every path resolves or the command reports the missing one.

2. **Initialize the manifest**
   Create `.sdw/state/batch-{batchId}.json` with queue entries and policy.
   - Done when: the manifest exists with one entry per specification and status `in_progress`.

3. **Delegate one specification**
   Invoke `sdw-orch` for the current item and wait. A pause code (`4` dispatch, `5` judgment) stops the loop and records the run id; the host agent drives the paused single run.
   - Done when: the item is `completed`, `failed`, or `awaiting_*` in the manifest.

4. **Advance or stop**
   Advance to the next item after completion, or halt/pause per policy and exit with the delegated code.
   - Done when: the queue is `completed`, `paused`, or `halted`, and the summary is printed.

## Reference

- Delegation contract, manifest schema, pause protocol, and failure policy: [`references/batch_protocol.md`](references/batch_protocol.md)
- Deterministic queue: [`scripts/sdw_batch.cjs`](scripts/sdw_batch.cjs)
