---
id: null
slug: 00037-sdw-run-retrospective-candidates
title: "SDW Run Retrospective Candidates"
source: local
status: implemented
specDate: 2026-10-21
---
# Specification — SDW Run Retrospective Candidates

## Description

Human-invoked review after a completed `sdw-orch` delivery. This specification adds `sdw-retro`, which scans the completed run state and its step artifacts, separates deterministic friction signals from judgment-based candidates, and proposes ranked, evidence-bound improvements. It changes no code, installs no hooks, writes no memory records, and never reads host transcripts or agent chat logs.

### Design Intent

Learn from difficult deliveries without creating automatic process debt. Deterministic facts come from run artifacts; improvement judgments remain explicit and operator-approved. Candidates belong where they can be enforced: navigation aids, deterministic checks, reviewer standards, memory routing, or removal of ineffective instructions. Smooth runs may produce a report with no candidates.

## Acceptance Criteria

- AC1: The system shall provide an `sdw-retro` skill whose `SKILL.md` references `sdw-rules`.
- AC2: The system shall provide `retro run [--run-id <id>] [--root <path>] [--json]` for reading a completed run state file and its step artifacts.
- AC3: The system shall exclude host transcripts and agent chat logs from retro inputs.
- AC4: When the run identifier is omitted, the system shall select the most recent completed run under `.sdw/state`.
- AC5: The system shall write `<runId>.retro.md` and `<runId>.retro.json` under the run artifact directory.
- AC6: If an expected artifact is missing, then the system shall record the absence in the report and shall not synthesize its content.
- AC7: The system shall define a candidate record with `id`, `title`, `severity`, `category`, `evidence`, and `proposedChange`.
- AC8: The system shall restrict severity to `critical`, `high`, `medium`, or `low`, and category to `memory`, `harness-directive`, `reviewer-standard`, `automated-check`, `navigation-pointer`, or `no-op-deletion`.
- AC9: The system shall require `evidence.artifact`, an exact state path or artifact line range in `evidence.ref`, and `proposedChange.target` in every candidate.
- AC10: The system shall provide `scripts/validate_candidates.cjs` exiting `0` only when every candidate is complete and ordered from `critical` to `low`.
- AC11: If a candidate lacks a required field, cites an unresolvable artifact, or names a direct `skills/` edit, then the system shall reject it with a stable reason code and the specification route.
- AC12: Where the candidate category is `memory`, the system shall propose an `sdw-memory` record draft instead of a repository modification.
- AC13: The system shall leave the working tree unchanged during every retro run.
- AC14: The system shall require explicit operator invocation for every retro run.
- AC15: When an `sdw-orch` run finishes successfully, the system shall record the exact retro command in the run state and completion summary.

## Notes

- CLI contract:
  ```bash
  node skills/sdw-retro/scripts/retro.cjs run [--run-id <runId>] [--root <path>] [--json]
  node skills/sdw-retro/scripts/validate_candidates.cjs --input <file> [--root <path>] [--json]
  ```
- `retro run` emits two sections:
  - `signals`: timestamps, retries, abandoned dispatches, score iterations, gate repairs, review findings, unresolved threads, and missing artifacts.
  - `candidates`: operator- or agent-supplied judgments conforming to AC7 through AC11.
- Exact locator examples:
  - `.sdw/state/<runId>.state.json#steps.4.dispatch.abandonments[0]`
  - `.sdw/state/<slug>/<runId>/<slug>-step-7.md#L120-L138`
- A report with signals but no candidates is valid for a smooth delivery.
- Direct `skills/` changes are never proposed as edits; the candidate names the follow-up specification route.
- Memory candidates identify the intended `sdw-memory` record without recording it; no binary host-memory API is imported.
- The successful-delivery summary names:
  ```bash
  node skills/sdw-retro/scripts/retro.cjs run --run-id <runId> --root <projectRoot>
  ```
  The command is advisory; the operator decides whether the delivery warrants review.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Host transcript or session-log parsing | The product remains harness-agnostic by reading only run state and artifacts. |
| Automatic retro execution | Every run stays advisory and requires an explicit operator decision. |
| Automatic candidate application | Approved changes require a specification, memory record, or operator edit. |
| Lint-rule or test implementation | A candidate may propose a check, but this specification does not write it. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Invocation point | After a successful delivery worth learning from | Difficult runs carry the useful signal; smooth runs do not need review. | y |
| Evidence boundary | Run state and artifacts only | Host transcripts differ by harness and may contain untrusted content. | y |
| Smooth-run result | Valid empty-candidate report | Absence of friction is useful information, not a tool failure. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00037-sdw-run-retrospective-candidates.md` |
| Deterministic tests | One test file covers run selection, missing artifacts, candidate acceptance, rejection reasons, ordering, working-tree preservation, and success-summary output | Run `npm test` |
| Skill layout | Tier-1 skill, references, and deterministic scripts follow the 3-tier standard | Inspect `skills/sdw-retro/` and run `node --check` on scripts |
| Orchestrator integration | Successful completion records the exact follow-up retro command | Inspect a completed run state and completion output |

## Validation & Observation Notes

### Telemetry & Observable Signals

- The selected run identifier and artifact directory are printed before analysis.
- Missing artifacts appear as explicit report absences.
- Validator output names accepted candidates, rejected candidates, and stable reason codes.
- A successful delivery summary contains the exact retro invocation.

### Negative & Failing Test Scenarios

- A candidate without `evidence.ref` is rejected with `missing-evidence-ref`.
- A candidate citing a nonexistent artifact is rejected with `unresolvable-artifact`.
- A candidate proposing a direct `skills/` edit is rejected with `skills-requires-spec`.
- A retro run leaves checksums of fixture project files unchanged.
