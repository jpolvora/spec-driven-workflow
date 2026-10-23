---
id: null
slug: 00019-sdw-orch-checkpoint-resume
title: "SDW Orchestrator Checkpoint, Turn Pause, and Crash-Safe Resume"
source: local
status: awaiting-approval
specDate: 2026-10-19
priority: high
value: "Run lock, revision guard, and crash-safe resume for long batch runs"
effort: M
---

# Specification — SDW Orchestrator Checkpoint, Turn Pause, and Crash-Safe Resume

## Description

`sdw-orch` persists one JSON state file per run and resumes from the first step that is not `completed`. The state write is a direct file write, there is no revision guard, no run lock, and no record of progress inside a long-running step. When a host ends a turn mid-step, when two processes act on the same run, or when a process dies during a write, the orchestrator can lose progress, overwrite newer state, or resume a partially written file. The pipeline also cannot distinguish "the agent is still working" from "the agent stopped".

This specification adds checkpoint records, turn-boundary pauses, atomic revisions, a run lock, and deterministic recovery. A step can persist mid-step progress and a next action, resume honors that action, and every mutation is revision-checked and atomic.

### Design Intent

Make the state machine survivable across host turn boundaries and process crashes without adding a database or daemon. A checkpoint is a durable, step-scoped progress note; a turn pause is an explicit handoff marker; a revision plus lock prevents lost updates; atomic rename prevents partial files. The design preserves the existing state file as the machine source of truth and keeps all new fields backward-incompatible only in the sense that older partial states are rejected with remediation.

## Acceptance Criteria

- AC1: The system shall write a checkpoint record on every step transition containing step number, state revision, status, and timestamp.
- AC2: The system shall provide a `checkpoint` command that stores arbitrary progress JSON for a step.
- AC3: The system shall provide a `pause-turn` command that stores a turn pause reason and next action.
- AC4: When `resume` executes and a turn pause exists, the system shall use `nextAction` instead of treating an unchanged revision as a stall.
- AC5: When a step finishes, the system shall clear the checkpoint and turn-pause records for that step.
- AC6: The system shall write run state atomically through a temporary file and rename.
- AC7: The system shall increment a monotonic revision on every state mutation.
- AC8: If a state file is partial or has an unsupported revision, then the system shall refuse to resume.
- AC9: The system shall acquire an exclusive run lock before mutating run state.
- AC10: If another process holds the run lock, then the system shall fail with an actionable message.
- AC11: The system shall make resume idempotent for steps already completed.
- AC12: The system shall recover the last valid state when an interrupted write leaves a temporary file.
- AC13: The system shall record checkpoint and pause-turn telemetry events.
- AC14: The system shall document the state schema, revision rules, lock behavior, and recovery procedure.
- AC15: If a checkpoint references a step that does not exist, then the system shall reject the checkpoint.
- AC16: When a turn pause is recorded, the system shall preserve the pause across process restarts.
- AC17: The system shall add tests for concurrent writers, interrupted writes, revision mismatches, pause resume, and idempotent steps.

## Notes

- Implementation surfaces:
  - `skills/sdw-orch/scripts/state_manager.cjs`: atomic writes, revision, lock acquisition, temporary-file recovery, checkpoint and turn-pause helpers.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: `checkpoint` and `pause-turn` subcommands; resume uses `turnPause.nextAction`; finish clears markers.
  - `skills/sdw-orch/scripts/run_lock.cjs` (new): portable exclusive lock using an atomic `mkdir` or `open` with exclusive flag; stale-lock detection with owner pid and timestamp.
  - `skills/sdw-orch/references/orchestrator_protocol.md`: document state schema, revision, locking, recovery, and pause semantics.
- State additions (example):
  ```json
  {
    "revision": 17,
    "stateSchemaVersion": 2,
    "turnPause": {
      "step": 4,
      "reason": "host turn ended",
      "nextAction": "resume task-2 implementation",
      "recordedAt": "2026-10-19T12:00:00.000Z"
    },
    "stepCheckpoints": {
      "4": {
        "step": 4,
        "revision": 16,
        "status": "in_progress",
        "progress": { "completedTasks": ["task-1"] },
        "recordedAt": "2026-10-19T11:55:00.000Z"
      }
    }
  }
  ```
- Commands:
  ```bash
  node skills/sdw-orch/scripts/sdw_orch.cjs checkpoint --run-id <id> --step 4 --progress-file .sdw/progress.json
  node skills/sdw-orch/scripts/sdw_orch.cjs checkpoint --run-id <id> --step 4 --progress '{"completedTasks":["task-1"]}'
  node skills/sdw-orch/scripts/sdw_orch.cjs pause-turn --run-id <id> --step 4 --reason "host turn ended" --next-action "resume task-2 implementation"
  node skills/sdw-orch/scripts/sdw_orch.cjs resume --run-id <id>
  ```
- Atomic write protocol: write `{stateFile}.tmp-{pid}`, flush, rename over the state file, then fsync the directory where supported. Recovery ignores a temp file older than the last valid state and deletes stale temp files on next successful write.
- Lock protocol: lock file is `{stateFile}.lock` containing pid, host, and acquiredAt. A live lock blocks mutation with exit code 1 and a message naming the owner. A lock older than `lockStaleMs` (default 300000) may be reclaimed only after the owner process is proven absent, otherwise the operator must remove it manually.
- Revision protocol: every accepted mutation increments `revision` by one; a caller that supplies an expected revision and finds a different value fails closed. Resume never re-executes a completed step; it validates the step output first.
- Turn pause semantics: a pause is not a failure. `resume` prints the recorded next action and continues from it; `finish` clears the pause and checkpoint. A pause does not change the step's status to completed.
- Failure policy: lock contention, revision mismatch, unsupported schema version, or unrecoverable partial state exits non-zero with a remediation message. A stale temp file is a warning, not a failure.
- Tests: add `tests/sdw_state_checkpoint.test.cjs`. Cover atomic rename, simulated interrupted write, revision increments, stale revision rejection, concurrent writer lock, stale lock recovery, checkpoint validation, pause persistence, next-action resume, and idempotent completed steps.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-machine distributed locking | Single-host runs are the supported scope |
| A database or daemon for state | The JSON state file remains the source of truth |
| Automatic recovery of lost in-memory work | Checkpoints persist only what the caller explicitly records |
| Run state encryption or signing | Access control follows the repository and filesystem |
| Changing step semantics or gate order | This specification hardens persistence and resume only |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| State encoding | JSON with a schema version | Existing convention and easy inspection | y |
| Write strategy | Temp file plus atomic rename | Standard library portability and crash safety | y |
| Revision model | Monotonic integer per mutation | Simple lost-update detection | y |
| Lock scope | One lock per run state file | Matches the isolation unit | y |
| Stale lock threshold | 300000 ms | Long enough for normal steps, short enough for recovery | y |
| Turn pause behavior | Pause does not complete the step | Preserves the real execution state | y |
| Backward compatibility | Older states without a schema version are rejected | Repository policy forbids compatibility shims | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| State baseline | `state_manager.cjs` inspected and current schema understood | Read the module and existing tests |
| Git baseline | Worktree and process tooling available for concurrency fixtures | Run `git --version` and a two-process fixture |
| Workspace configuration | `.sdw/config.json` valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | This specification registered as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | This specification passes canonical authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00019-sdw-orch-checkpoint-resume.md` |
| Test baseline | Existing `node:test` suite passes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output for checkpoint writes, e.g. `[Checkpoint] step 4 revision 16 saved`.
- Run state contains `revision`, `stateSchemaVersion`, `stepCheckpoints`, and `turnPause`.
- A completed step clears its checkpoint and turn-pause entries.
- Resume prints the recorded next action when a turn pause exists.
- Lock acquisition and release are visible in debug output and error messages.
- Telemetry emits `checkpoint` and `turn_paused` events.

### Negative & Failing Test Scenarios

- Concurrent writer: a second process cannot mutate the same run and exits with the lock owner message.
- Stale lock: an expired lock is reclaimed only when the owner is proven absent.
- Interrupted write: a partial temp file does not replace the last valid state.
- Revision mismatch: a caller supplying an outdated revision is rejected.
- Unsupported schema: a state file without `stateSchemaVersion` refuses to resume.
- Unknown step checkpoint: a checkpoint for step 99 is rejected.
- Pause persistence: a pause survives a process restart and resume uses `nextAction`.
- Idempotent resume: resuming a completed step does not re-execute it or increment the revision.
