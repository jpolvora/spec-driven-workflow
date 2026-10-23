---
id: null
slug: 00045-sdw-retro-auto-run
title: "Automatic Retrospective After Delivery and Operational-Slip Detection"
source: local
status: implemented
specDate: 2026-10-21
---
# Specification — Automatic Retrospective After Delivery and Operational-Slip Detection

## Description

### Problem

`sdw-retro` works but `sdw-orch` never runs it: the orchestrator prints an advisory command after a run completes, so a bad delivery or a bad command sequence is only reviewed if the operator remembers.

The spec 00042 run shows what that costs. While the run was paused at Step 4, the operator invoked `sdw-orch run` again instead of `resume`. The orchestrator silently created a second run state (`run-1792612060368`), re-dispatched `task-1` against a specification that already had an accepted task, and left the duplicate state behind. Nothing in the run output, the state, or the retrospective flagged it. Only the duplicated artifact directory revealed the slip.

Three gaps follow:

1. `run` has no guard against starting a second run while another run for the same specification is still open.
2. The retrospective inspects one selected run, so a leftover sibling run can never surface as a signal.
3. The retrospective refuses host transcripts outright, so the command that caused the duplicate is invisible: it lives in the session transcript, not in run state.

### Proposal

1. Auto-run: when a run reaches `completed` and `retro.enabled` is `true`, the orchestrator executes `sdw-retro` for that run, records the outcome in `state.retro`, and prints the report location. Failure is recorded and never turns a completed delivery into a failed one.
2. Start guard: `run` refuses to create a new run when the same specification already has a run that is not `completed` or `failed`. The refusal names the existing run id and points to `resume --run-id <runId>`; `--new-run` overrides for an intentional restart.
3. Leftover-run signal: the retrospective compares the selected run against the other run states for the same specification and reports every sibling that never reached a terminal status.
4. Transcript input: the retrospective accepts transcript files, configured through `retro.transcripts` or passed with `--transcript`, and scans them line by line for orchestrator command signatures. The report cites file and line only; transcript bodies are never copied into the report.

### Scope

- `skills/sdw-orch/scripts/sdw_orch.cjs`: completion hook that runs the retrospective and records `state.retro`; the start guard in the `run` path.
- `skills/sdw-retro/scripts/retro.cjs`: optional transcript inputs, sibling run comparison, and the `leftover_run`, `repeated_run_invocation`, and `transcript_unreadable` signals.
- `skills/sdw-retro/SKILL.md`, `skills/sdw-retro/references/retro_protocol.md`, `skills/sdw-retro/references/candidate_contract.md` when the input contract changes.
- `skills/sdw-config/references/config_spec.md`, `.sdw/config.json`, `.sdw/config.schema.json`: `retro.enabled` and `retro.transcripts`.
- Tests: `tests/sdw_orch_retro.test.cjs` for the hook and the guard, `tests/sdw_retro.test.cjs` for the signals.

## Acceptance Criteria

- AC1: When a run reaches `completed` and `retro.enabled` is `true`, the orchestrator shall execute `sdw-retro` for that run and record `state.retro` with the exit status, the report paths, and any error message.
- AC2: If the automatic retrospective exits non-zero, then the orchestrator shall record the failure in `state.retro` and shall keep the run status `completed` and the process exit code `0`.
- AC3: When `retro.enabled` is `false`, the orchestrator shall print the advisory retro command and shall not execute it.
- AC4: When `run` targets a specification that already has a run whose status is neither `completed` nor `failed`, the orchestrator shall refuse to create a new run, name the existing run id, direct the operator to `resume --run-id`, and exit non-zero without writing state.
- AC5: When the same specification has a sibling run that never reached a terminal status, the retrospective report shall include a `leftover_run` signal naming that run id, its status, and its age.
- AC6: When `retro.transcripts` or `--transcript` names a transcript file, the retrospective shall read it, list it under report inputs, and include its line count.
- AC7: When a transcript contains two `sdw-orch run` invocations for the same specification with no `resume` invocation between them, the report shall include a `repeated_run_invocation` signal citing the file and line numbers, without copying the transcript line bodies.
- AC8: When a configured transcript path does not exist, the report shall include a `transcript_unreadable` signal and shall still exit `0`.
- AC9: The system shall document `retro.enabled`, `retro.transcripts`, the automatic execution, the start guard, and the three signals in the `sdw-retro` skill, its protocol reference, and the config specification, without duplicating the rules in `AGENTS.md`.

## Verification

- [ ] Completed run with `retro.enabled: true` writes `.retro.md` and `.retro.json` without an operator command.
- [ ] Failing retro leaves the run `completed` and exits `0`.
- [ ] `retro.enabled: false` prints the advisory command only.
- [ ] Second `run` against a paused run exits non-zero, prints the existing run id and `resume --run-id`, and creates no state file.
- [ ] `--new-run` still starts a second run when explicitly requested.
- [ ] Completed run with a leftover paused sibling reports `leftover_run`.
- [ ] Transcript with two `run` invocations reports `repeated_run_invocation` with file and lines, and no transcript body appears in the report.
- [ ] Missing transcript path reports `transcript_unreadable` with exit `0`.
- [ ] `npm test` passes; `node skills/sdw-rules/scripts/sdw_rules.cjs doctor` passes.

## Notes

- The retrospective reads run state files, the artifacts those states declare, and explicitly configured transcripts. It still never reads git, environment, or network state.
- Sibling run states are run state files, so the leftover check stays inside the existing input contract.
- Transcript scanning is line-based and format-agnostic: plain text and JSONL both match the same command signature. Harness-specific discovery stays out of the product; the operator names the files.
- The start guard belongs to `run` only. `resume`, `sandbox`, `status`, and `task` keep their current behavior.
- Node.js CommonJS, standard library only; no absolute OS paths in committed files.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic deletion of leftover run states | Destructive; the signal names them and the operator decides |
| Automatic fix application from retro candidates | A retro proposes; only an explicit specification or operator edit applies a change |
| Harness transcript auto-discovery | Not portable; the operator names the files through config or CLI |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default for `retro.enabled` | `true` in this repository, documented as opt-out | The retrospective reads local files only and its failure is non-fatal | y |
| Default for `retro.transcripts` | `[]` | Keeps transcript scanning opt-in per machine | y |
| Guard scope | Any run state for the same specification that is not `completed` or `failed` | Exactly the duplicate-state case observed | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `validate_spec.cjs --mode=authoring` |
| Existing contract | `sdw-retro` analyzer, `tests/sdw_retro.test.cjs`, and run state schema exist | Inspect `skills/sdw-retro/` and `skills/sdw-orch/scripts/state_manager.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `state.retro` records status, report paths, and error.
- Start guard prints the existing run id and the exact resume command.
- Report inputs list every transcript path with its line count.

### Negative & Failing Test Scenarios

- Retro executable missing or crashing: run stays `completed`, exit `0`, error recorded.
- Two runs for the same specification, both terminal: no `leftover_run` signal.
- A run started with `--new-run` while another is open: allowed, then reported by the retrospective.
- Transcript containing a single `run` invocation: no `repeated_run_invocation` signal.
