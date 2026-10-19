---
id: null
slug: 021-sdw-monitor-telemetry
title: "SDW Live Run Monitor and Append-Only Telemetry"
source: local
specDate: 2026-10-19
---

# Specification — SDW Live Run Monitor and Append-Only Telemetry

## Description

`sdw-orch` writes a JSON state file per run but emits no durable event stream and provides no way to observe an active run. Operators must inspect state files manually to answer basic questions: which run is active, which step it is on, how long it has been there, and whether it is stalled. The pipeline also cannot distinguish a slow step from a hung one, and multi-run workspaces have no consolidated view.

This specification adds an append-only `telemetry.jsonl` per run and a read-only `monitor` command. Each step transition, dispatch, gate, checkpoint, and pause emits a structured event. The monitor lists active runs, follows a run until it reaches a terminal status, and classifies stalls using state and telemetry clocks. It never mutates run state.

### Design Intent

Observability should not require a daemon or a database. A JSONL event stream beside the run state is portable, append-only, and trivially inspectable. The monitor is a projection over state and telemetry, so it cannot drift from the source of truth. Time-bounded classifications (`stalled`, `run-without-state`) turn silent hangs into actionable signals without inventing a second state machine.

## Acceptance Criteria

- AC1: The system shall emit one append-only telemetry event per step transition.
- AC2: The system shall store telemetry as JSONL under the run artifact directory.
- AC3: The system shall include run id, step number, step name, status, timestamp, and duration in each step event.
- AC4: The system shall provide a `monitor` command that lists active runs with status, current step, and age.
- AC5: When `monitor --watch` executes, the system shall refresh until the scoped run reaches a terminal status.
- AC6: The system shall classify a run as `stalled` when state and telemetry do not advance within a configurable window.
- AC7: The system shall report `run-without-state` when a plan directory contains artifacts but no state file.
- AC8: The system shall support `--json` output for monitor snapshots.
- AC9: The system shall make monitor operations read-only.
- AC10: The system shall preserve telemetry across resume without duplicating prior events.
- AC11: The system shall document telemetry schema, monitor classifications, and stall thresholds.
- AC12: If the telemetry file cannot be appended, then the system shall record a warning without failing the step.
- AC13: The system shall provide a `telemetry report` command that aggregates runs by step and status.
- AC14: The system shall record dispatch and gate events in telemetry.
- AC15: The system shall add tests for event emission, watch termination, stall detection, run-without-state, JSON output, and append failures.

## Notes

- Implementation surfaces:
  - `skills/sdw-orch/scripts/telemetry.cjs` (new): append-only JSONL writer, event constructors, and failure policy.
  - `skills/sdw-orch/scripts/monitor.cjs` (new): run discovery, snapshot projection, watch loop, stall classification, and JSON output.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: emit events on step transition, dispatch, gate, checkpoint, and pause.
  - `skills/sdw-orch/references/telemetry.md` (new): event schema, classifications, and thresholds.
- Telemetry event schema:
  ```json
  {
    "ts": "2026-10-19T12:00:00.000Z",
    "runId": "run-1792400000000-015-sdw-orch-implementation-execution",
    "specSlug": "015-sdw-orch-implementation-execution",
    "event": "step",
    "step": 4,
    "stepName": "implementation",
    "status": "completed",
    "durationMs": 42000
  }
  ```
  Event names: `run_started`, `step`, `dispatch`, `gate`, `checkpoint`, `turn_paused`, `run_completed`, `run_failed`.
- Monitor snapshot fields: run id, slug, status, current step, step status, last event timestamp, age, classification (`active`, `stalled`, `run-without-state`, `terminal`), and evidence paths.
- Stall rule: a run is `stalled` when the newest of state mtime and telemetry timestamp is older than `monitor.stallWindowSeconds` (default 900) and the run is not terminal. A turn pause downgrades the classification to `paused` rather than `stalled`.
- Watch rule: refresh every `monitor.intervalSeconds` (default 60) until the scoped run reaches `completed`, `failed`, or `cancelled`; print a final snapshot and exit 0. A watch interrupted by the operator exits non-zero without changing state.
- `run-without-state`: a plan or artifact directory containing step files but no `*.state.json` is reported as a warning while its newest artifact is inside the stall window and as info when older.
- Failure policy: telemetry append failures are warnings; they do not fail a step or change run status. Monitor read failures exit non-zero with the path and error.
- Tests: add `tests/sdw_monitor_telemetry.test.cjs`. Cover event emission per transition, append-only ordering, resume without duplication, monitor snapshots, watch termination, stall threshold, turn-pause downgrade, run-without-state, JSON output, append failure, and report aggregation.

## Out of Scope

| Feature | Reason |
|---------|--------|
| A web dashboard or UI | The monitor is a CLI projection; a UI can consume `--json` later |
| Remote or multi-machine telemetry aggregation | Single-host run scope |
| Automatic remediation of stalled runs | The monitor is read-only |
| Log shipping to external observability platforms | Consumer-owned integration |
| Session transcript correlation | Deferred until monitor basics are stable |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Telemetry format | JSONL | Append-only, streaming-friendly, and dependency-free | y |
| Telemetry location | Run artifact directory beside state | Keeps evidence and events together | y |
| Default stall window | 900 seconds | Longer than normal steps, short enough to surface hangs | y |
| Default watch interval | 60 seconds | Low overhead and responsive enough for operators | y |
| Monitor mutation | None | Observation must never change the run | y |
| Append failure | Warn and continue | Observability must not block delivery | y |
| Turn pause classification | `paused`, not `stalled` | An explicit handoff is not a hang | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| State baseline | Per-run state layout and step statuses inspected | Read `state_manager.cjs` |
| Checkpoint baseline | Spec 019 checkpoint and pause fields available | Run the spec 019 tests |
| Artifact layout | Run artifact directory available | Inspect `.sdw/state/{slug}/{runId}/` |
| Workspace configuration | `.sdw/config.json` valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | This specification registered as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | This specification passes canonical authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/021-sdw-monitor-telemetry.md` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `telemetry.jsonl` exists under the run artifact directory and grows by one line per event.
- Each line parses as JSON and contains `ts`, `runId`, `event`, and either `step` or `status`.
- `monitor` output shows active runs with current step and age.
- `monitor --watch` exits only after a terminal status.
- `monitor --json` returns the same fields as the table output.
- `telemetry report` aggregates counts by step and status.

### Negative & Failing Test Scenarios

- Append failure: a read-only telemetry file emits a warning and the step still completes.
- Resume duplication: resuming a run does not rewrite prior events.
- Stall detection: an unchanged state and telemetry clock older than the window classifies `stalled`.
- Turn pause: an explicit pause classifies `paused` and does not trigger a stall warning.
- Run without state: artifacts without a state file classify `run-without-state`.
- Watch interruption: an operator interrupt exits non-zero and leaves state unchanged.
- Malformed telemetry line: the monitor skips the bad line and reports a warning.
- Read-only guarantee: a fake state writer that detects mutation fails the monitor test.
