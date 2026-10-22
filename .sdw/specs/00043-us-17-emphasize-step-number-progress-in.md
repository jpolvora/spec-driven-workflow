---
id: "17"
slug: 00043-us-17-emphasize-step-number-progress-in
title: "Emphasize step number progress in sdw-orch agent output"
source: github
status: draft
specDate: 2026-10-21
priority: medium
value: "Step-number progress output during orchestrated runs"
effort: S
---

# Specification — Emphasize step number progress in sdw-orch agent output

## Description

# Emphasize step number progress in sdw-orch agent output

## Problem
During `sdw-orch` runs, step progress is hard to track. Logs use a `[Step N: Name]` prefix on some lines (see `skills/sdw-orch/scripts/sdw_orch.cjs` Steps 1 to 8, plus Step 4 dispatch and gate lines), but long DAG executions bury the current position. Subagent task prompts and parent status lines rarely restate the global step, so an operator watching live output cannot tell Step 4 task 2 of 5 apart from Step 5 scoring or Step 6 commit.

## Proposal
Add a short, consistent progress header emitted at each visible transition:
- Run start and resume: `Step {current}/8` plus run id and spec slug.
- Step boundaries 1 to 8: one line on entry and one on completion, same format every time.
- Step 4 per task: `Step 4: task {done}/{total} ({taskId}) dispatched plus accepted`, using existing `dispatch.sequence` and `steps[4].tasks` counts.
- Verification gates, scoring, delivery commit, review, and ship PR keep their current detail lines underneath the header, so this is additive only.

## Scope
- `skills/sdw-orch/scripts/sdw_orch.cjs` log lines for Steps 1 to 8, dispatch (`dispatchNextTask`, `printDispatchEnvelope`), `task finish`, gates, scoring, delivery commit.
- `skills/sdw-orch/references/orchestrator_protocol.md` Step 4 and Step 6 sections document the header format.
- No behavior change: same exit codes, same state file, same scoped commits. Header is plain text for humans and grep.

## Verification
- [ ] Fresh run shows entry plus completion header for each reached step.
- [ ] Multi task DAG shows `task done/total` on every dispatch and accept.
- [ ] Existing tests pass: `npm test`.
- [ ] Docs updated: `orchestrator_protocol.md` only, no duplicate in `AGENTS.md`.


### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for Emphasize step number progress in sdw-orch agent output.

### Prior Work Sweep

Reviewed existing workspace implementations and tracker references prior to specification formulation.

## Acceptance Criteria

- AC1: The system shall fresh run shows entry plus completion header for each reached step.
- AC2: The system shall multi task DAG shows `task done/total` on every dispatch and accept.
- AC3: The system shall existing tests pass: `npm test`.
- AC4: The system shall docs updated: `orchestrator_protocol.md` only, no duplicate in `AGENTS.md`.

## Notes

- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00043-us-17-emphasize-step-number-progress-in |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Workspace directory standards | Follow canonical .sdw workspace guidelines | Consistent developer ergonomics across projects | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | Run validate_spec.cjs in authoring mode |
| Directory layout | Target workspace directories exist and are writable | File system check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Deterministic command execution logs and structured console progress reports.
- Non-zero exit codes returned upon validation or verification failures.

### Negative & Failing Test Scenarios

- Input rejection test case: the system must reject invalid inputs or malformed options with descriptive error messages.
