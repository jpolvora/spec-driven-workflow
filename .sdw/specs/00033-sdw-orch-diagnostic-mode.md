---
id: null
slug: 00033-sdw-orch-diagnostic-mode
title: "SDW Orchestrator Diagnostic Run Mode — Upstream Issue Detection and Follow-up Spec Suggestion"
source: local
status: draft
specDate: 2026-10-21
---

# Specification — SDW Orchestrator Diagnostic Run Mode — Upstream Issue Detection and Follow-up Spec Suggestion

## Description

Orchestrator runs currently surface only terminal delivery outcomes. Tool failures, script non-zero exits, retry loops, fallback usage, score mismatches, gate repairs, plus LLM workarounds remain buried in console output. Upstream defects therefore recur across runs without a durable improvement backlog.

This specification introduces a diagnostic run mode for `sdw-orch`. When enabled through `--diagnostic`, the mode wraps the entire 8-step execution with a lightweight event recorder, collects unintended behavior across steps, generates a run report at completion, plus suggests a follow-up issue spec draft for later analysis, planning, plus implementation.

### Design Intent

Make every run self-observing without altering delivery semantics. Diagnostics stay append-only, zero-dependency, token-bounded, separate from delivery commits, so upstream fixes accumulate through explicit follow-up specs rather than silent scope expansion.

## Acceptance Criteria

- AC1: The system shall provide diagnostic flag `--diagnostic` for `sdw-orch` run invocations.
- AC2: The system shall implement diagnostic recorder with zero external runtime dependencies using Node.js 22 standard library only.
- AC3: When diagnostic mode wraps execution, the system shall record step transitions with timestamps.
- AC4: When tool execution fails, the system shall capture exit code with stderr snippet in diagnostics log.
- AC5: When script exits non-zero, the system shall preserve failing command with output excerpt.
- AC6: While diagnostic mode is active, the system shall persist append-only JSONL events to run diagnostics file.
- AC7: While retry loops execute, the system shall count attempts with fallback usage.
- AC8: When run completes, the system shall emit markdown run report with issue summary.
- AC9: Where follow-up work is detected, the system shall propose issue spec draft with title plus rationale.
- AC10: If diagnostics collection fails, then the system shall continue run without failing delivery.
- AC11: The system shall cap diagnostic overhead below stated budget in run report.
- AC12: The system shall register diagnostic intents in `sdw-router` routing table.

## Notes

- CLI contract:
  ```bash
  node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> --diagnostic
  node skills/sdw-orch/scripts/sdw_orch.cjs resume --run-id <runId> --diagnostic
  ```
- Flag is orthogonal to `--dry-run` plus `--sandbox`; diagnostics record planning output in dry-run, clone-local events in sandbox.
- Event schema (`diagnostics.jsonl` per run): `{ ts, step, kind, command, exitCode, snippet, attempt, note }`. Kinds: `step_transition`, `tool_failure`, `script_failure`, `retry`, `fallback`, `workaround`, `score_mismatch`, `gate_repair`, `state_repair`.
- Recorder hooks: step entry/exit, `runVerificationGates` non-zero results, `stageAndCommitOnly` failures, judge `scoreMismatch`, Step 6 gate-fix capture, resume state repairs.
- Report path: `{artifactsDir}/{slug}-diagnostics.md` plus `{runDir}/diagnostics.jsonl`. Report sections: run summary, issue table (severity, step, evidence), workaround list, suggested follow-up spec title plus rationale.
- Follow-up suggestion: draft spec file under `.sdw/specs/` is proposed, never auto-created; creation requires explicit `sdw-spec new` order.
- Overhead budget: recorder writes bounded snippets (max 500 chars per event, max 200 events); report states event count plus bytes.
- Router: `diagnostic run`, `diagnose run`, `run diagnostics` route to `sdw-orch`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Auto-fixing detected upstream issues | Fixes require explicit follow-up spec plus implementation order |
| Central telemetry upload | Diagnostics stay local to run state for portability |
| Full OpenTelemetry tracing | Bounded JSONL plus markdown report satisfy audit needs |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Flag name | `--diagnostic` | Matches existing `--dry-run` plus `--sandbox` flag style | y |
| Storage | Per-run JSONL plus markdown in artifacts dir | Isolates diagnostics from delivery commits | y |
| Follow-up creation | Suggest only, never auto-create spec | Preserves explicit authorization for new scope | y |
| Overhead bound | 200 events, 500 chars per snippet | Keeps context plus disk impact predictable | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized plus valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00033-sdw-orch-diagnostic-mode.md` |
| Orchestrator baseline | Orchestrator CLI parses `--diagnostic` without regression | Run `node skills/sdw-orch/scripts/sdw_orch.cjs --help` |
| Node runtime compatibility | Environment provides Node.js 22 or higher | Run `node -v` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output confirming diagnostic mode: `[sdw-orch diagnostics] enabled, writing to <path>`.
- JSONL event count plus byte size reported at run completion.
- Markdown diagnostics report listing detected issues with step plus evidence.
- Follow-up spec suggestion block with proposed title plus rationale when issues exist.

### Negative & Failing Test Scenarios

- Diagnostics recorder failure during run preserves delivery outcome with explicit `diagnostics degraded` warning.
- Empty issue set produces clean report with `no upstream issues detected` status.
- Oversized stderr output truncates to snippet bound without crashing recorder.
