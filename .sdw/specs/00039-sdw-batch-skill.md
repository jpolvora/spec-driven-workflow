---
id: null
slug: 00039-sdw-batch-skill
title: "SDW Batch Skill — Multi-Spec Queue Delegating to Single sdw-orch Runs"
source: local
status: implemented
specDate: 2026-10-21
---
# Specification — SDW Batch Skill — Multi-Spec Queue Delegating to Single sdw-orch Runs

## Description

Move multi-specification coordination out of `sdw-orch`. `sdw-orch` keeps one job: execute one specification through the eight-step pipeline (implementation, scoring, delivery commit, code review, PR, convergence). A new `sdw-batch` skill owns the queue: it iterates the specification list, delegates each one to `sdw-orch` as an independent single run, waits for that run to finish, records the outcome, and only then dispatches the next specification.

### Design Intent

One orchestrator, one responsibility. Batch execution is a loop over single-spec runs, not a second state machine. Pauses stay pauses: when `sdw-orch` exits at a dispatch or judgment gate, `sdw-batch` records the paused run and returns the same code; `resume` continues that exact run. No step logic is duplicated, so fixing the single-spec pipeline automatically fixes batch execution.

## Acceptance Criteria

- AC1: The system shall provide an `sdw-batch` skill whose `SKILL.md` references `sdw-rules`.
- AC2: The system shall provide `scripts/sdw_batch.cjs` with `run <specPath...>`, `resume [batchId]`, and `status [batchId]` subcommands, accepting `--root`, `--json`, `--batch-id`, `--continue-on-error`, and `--no-sync`.
- AC3: The system shall create `.sdw/state/batch-{batchId}.json` before executing the first specification, with queue entries `index`, `spec`, `slug`, `status`, `runId`, `deliveryCommit`, `durationMs`, and `error`.
- AC4: If any queued specification file is missing, then the system shall reject the batch before creating a manifest or executing anything.
- AC5: The system shall delegate each queue item to `sdw-orch` as one independent single-specification run with its own run state.
- AC6: When a delegated run exits `0`, the system shall mark the item `completed`, record its delivery commit and branch, and advance to the next item without prompting.
- AC7: When a delegated run exits `4` or `5`, the system shall record the item as `awaiting_implementation` or `awaiting_judgment` with its `runId`, set the manifest `paused`, and exit with the same code.
- AC8: When `resume` runs for a paused item, the system shall continue that exact run through `sdw-orch resume --run-id`, never starting a new run.
- AC9: When the recorded run state has already reached `completed`, the system shall reconcile the item without re-executing the specification.
- AC10: If a delegated run fails and `--continue-on-error` is omitted, then the system shall halt the queue and persist the failure in the manifest; with the flag it shall log the failure and advance.
- AC11: The system shall print a per-item summary report (slug, status, duration, delivery commit) after completion, halt, or pause.
- AC12: The system shall invoke `sdw-spec sync` after each completed item unless `--no-sync` is supplied.
- AC13: The system shall remove multi-spec execution from `sdw-orch`: `run` shall reject more than one specification path with an error naming `sdw-batch`, and `resume-batch`, batch manifests, and the batch queue module shall be removed.
- AC14: The system shall not duplicate `sdw-orch` step logic; `sdw-batch` only invokes it and records outcomes.
- AC15: The system shall cover pre-flight rejection, per-item delegation, pause/resume continuity, completed-run reconciliation, continue-on-error, and summary output with tests.
- AC16: The system shall register `sdw-batch` in `sdw-doctor` and route multi-spec requests to it from `sdw-router`.

## Notes

- CLI contract:
  ```bash
  node skills/sdw-batch/scripts/sdw_batch.cjs run <specPath...> [--batch-id <id>] [--root <path>] [--continue-on-error] [--no-sync] [--json]
  node skills/sdw-batch/scripts/sdw_batch.cjs resume [batchId] [--root <path>] [--json]
  node skills/sdw-batch/scripts/sdw_batch.cjs status [batchId] [--root <path>] [--json]
  ```
- Delegation contract: `sdw-batch` spawns `node skills/sdw-orch/scripts/sdw_orch.cjs run <spec> --unattended` (or `resume --run-id <runId>`) and waits for its exit code.
- Pause protocol: the delegated run's exit code is the batch item's status. The host agent drives the paused single run (dispatch, evidence, verdict) and then calls `sdw-batch resume`; the batch never dispatches workers itself.
- Manifest:
  ```json
  {
    "batchId": "batch-1792580000000",
    "status": "paused",
    "policy": { "continueOnError": false, "syncIndex": true },
    "total": 2,
    "currentIndex": 0,
    "queue": [
      { "index": 0, "spec": ".sdw/specs/a.md", "slug": "a", "status": "completed", "runId": "run-1-a", "deliveryCommit": "abc123", "durationMs": 1000, "error": null }
    ]
  }
  ```
- `sdw-orch` single-run contract: `run <specPath>` executes steps 1-8; `resume --run-id <id>` continues the same run; `task next|finish|abandon` and `score submit` drive pauses.
- Breaking change: `sdw-orch run <spec1> <spec2>` is removed; consumers use `sdw-batch run <spec1> <spec2>`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Batch-specific step behavior | Each item is a normal single-spec run; the queue only loops and records outcomes. |
| Parallel execution | Sequential delegation preserves one run at a time and one commit per spec. |
| A second manifest state machine in sdw-orch | The queue belongs to sdw-batch. |
| Automatic worker dispatch | sdw-batch reports the pause; the host agent owns subagent dispatch. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Queue location | `.sdw/state/batch-{batchId}.json` | Keeps run state together and gitignored. | y |
| Delegation transport | Child process invoking the sdw-orch CLI | Preserves the single-run contract with no shared in-process state. | y |
| Pause ownership | Batch returns the pause code; host resumes | Matches the existing dispatch and judgment gates. | y |
| Failure policy | Halt by default, opt-in continue | Prevents silent queue progression after an error. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00039-sdw-batch-skill.md` |
| Deterministic tests | One test file covers delegation, pauses, reconciliation, failure policy, and summary | Run `npm test` |
| Skill layout | Tier-1 skill, reference, and deterministic CLI follow the 3-tier standard | Inspect `skills/sdw-batch/` and run `node --check` |
| sdw-orch simplification | Multi-spec paths, resume-batch, and the batch queue module are gone | Run `node skills/sdw-orch/scripts/sdw_orch.cjs --help` and a multi-spec `run` |
| Registration | `sdw-doctor` and `sdw-router` name `sdw-batch` | Run the doctor audit and inspect the routing table |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `run` prints the batch id, queue order, and each delegation boundary.
- Pauses print the item status, the run id to continue, and the `sdw-batch resume` command.
- Summary tables report per-item status, duration, and delivery commit.
- `--json` prints the manifest document.

### Negative & Failing Test Scenarios

- A missing specification rejects the batch before a manifest exists.
- A delegated run exiting `4` pauses the queue and records the run id.
- `resume` for a completed run state reconciles the item without a second delegation.
- A failure without `--continue-on-error` halts the queue with remaining items pending.
- `sdw-orch run a.md b.md` exits `1` and names `sdw-batch`.
