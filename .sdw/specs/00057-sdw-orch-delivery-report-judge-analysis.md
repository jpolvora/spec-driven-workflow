---
id: null
slug: 00057-sdw-orch-delivery-report-judge-analysis
title: "SDW Delivery Report — Judge Analysis Section"
source: local
status: draft
specDate: 2026-10-22
priority: medium
value: "Routes the Step 5 judge's interpretation into the delivery report instead of discarding it after scoring"
effort: M
---

# Specification — SDW Delivery Report Judge Analysis

## Description

Spec 00054 writes a deterministic delivery report from run state: metadata, tasks, commits, changed files, verification gates, code review, breaking changes, quality counters, spec observations, notes, and outcome. Every section is derived from git, state files, and gate results, so the report states what changed but never what it means: it cannot say whether the delivery honoured the specification's design intent, which criteria rest on thin evidence, which risks remain for a reviewer, or what should happen next.

The Step 5 judge already produces that interpretation. It reads the acceptance criteria plus the generated diff in a context-fresh session, rules on every criterion with cited evidence, and then its reasoning is discarded once the score is applied. Only the derived score survives in run state.

This specification routes the judge's interpretation into the report. The verdict gains optional analysis fields, `score submit` persists them, and the report renders two new sections from run state. The writer stays deterministic and offline: it renders what the run already recorded and never calls a language model itself.

### Design Intent

Keep the deterministic core and add interpretation beside it, never inside it. The score stays derived from per-criterion verdicts alone, so prose can never move the number. When no judgment exists the report still writes and the new sections degrade to `Not available`, preserving the spec 00054 guarantee that reporting is best-effort and never blocks delivery.

## Acceptance Criteria

- AC1: The judge verdict schema shall accept optional `summary`, `risks`, and `followUps` fields alongside `score` and `verdicts`.
- AC2: When a submitted verdict carries those optional fields, the system shall persist them in run state under `judgment`.
- AC3: The judge prompt shall require a one-paragraph `summary`, a `risks` list whose entries carry `severity` and `evidence`, and a `followUps` list of candidate next steps, and shall state that the analysis never changes the derived score.
- AC4: The delivery report shall render a `## Conformance Judgment` section carrying the score, the required minimum, the verified and failed counts, and one row per criterion with its verdict and evidence.
- AC5: The delivery report shall render a `## Judge Analysis` section carrying the summary, the risks, and the follow-ups, attributed to the Step 5 judge and marked advisory.
- AC6: Where run state carries no judgment, the system shall render both sections with `Not available` and shall still write the report.
- AC7: The report writer shall not invoke a language model, rendering only values already present in run state.
- AC8: If an optional judgment field is malformed, then the system shall ignore that field, record a warning in run state, and still write the report.
- AC9: When `--dry-run` is supplied and run state carries a judgment, the system shall print the judgment summary without writing a report.
- AC10: The `sdw-orch` skill definition and the orchestrator protocol reference shall document the enriched verdict schema and both report sections within the Tier-1 line budget.
- AC11: The test suite shall cover a judgment that is present, absent, and malformed, plus the dry-run print.

## Notes

- Verdict shape after this change:
  ```json
  {
    "score": 9,
    "verdicts": [{ "id": "AC1", "verdict": "verified", "evidence": "path:line" }],
    "summary": "One paragraph on what the delivery did and how well it honours the specification.",
    "risks": [{ "severity": "medium", "evidence": "path:line", "note": "what a reviewer should scrutinize" }],
    "followUps": ["candidate next step"]
  }
  ```
- Run-state shape: `state.judgment = { summary, risks, followUps, submittedAt }`, written by `score submit` beside `state.score` and `state.scoreIteration`. Absent fields are stored as empty values, never as `null`.
- Report sections render in this order: `## Metadata`, `## Tasks`, `## Commits`, `## Files Changed`, `## Verification`, `## Code Review`, `## Conformance Judgment`, `## Judge Analysis`, `## Breaking Changes`, `## Quality`, `## Spec Observations`, `## Notes`, `## Outcome`. Both new sections are inserted after `## Code Review`, keeping the deterministic sections contiguous.
- Degradation rules: no judgment, an unreadable verdict, or a malformed field renders `Not available` for the affected part and appends one warning line to `state.errors` through the existing warning path; the report write never fails because of a judgment problem.
- Advisory fence: the analysis is attributed to the Step 5 judge in the section body, marked advisory, and never feeds the score, the gates, the review, or any halt decision.
- Target surfaces:
  - `skills/sdw-orch/scripts/score_evaluator.cjs`: verdict validation accepts and normalizes the optional fields, and `buildJudgePrompt` requires them while stating that they never change the score.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: `score submit` persists `state.judgment`; `--dry-run` prints the summary.
  - `skills/sdw-orch/scripts/delivery_report.cjs`: renders `## Conformance Judgment` and `## Judge Analysis` from run state, with the degradation rules.
  - `skills/sdw-orch/references/orchestrator_protocol.md`: verdict schema plus the two report sections.
  - `skills/sdw-orch/SKILL.md`: Step 5 and Step 7 wording inside the 120-line Tier-1 budget.
  - `tests/sdw_orch_scoring.test.cjs`: verdict validation and persistence, including malformed fields.
  - `tests/sdw_orch.test.cjs`: report rendering for present, absent, and malformed judgment, plus the dry-run print.
- All helper scripts remain Node.js CommonJS (.cjs) using standard library modules only. No new runtime dependencies.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Reviewer (Step 7) analysis in the report | The reviewer already owns the `## Code Review` section through its report; enriching it is a separate concern |
| An LLM call inside the report writer | The writer stays deterministic and offline; interpretation is produced by the judge, which already reads the criteria and the diff |
| Score changes driven by the analysis prose | The score stays derived from per-criterion verdicts, so the number remains reproducible |
| Reworking the deterministic sections added by spec 00054 | Their contract is delivered; this specification only adds two sections and the verdict fields |
| Retrospective or changelog consumption of the analysis | Those surfaces own their own inputs and are not extended here |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| The judge writes the analysis | Optional verdict fields | The judge already holds the fenced criteria and diff, so no second context is needed | y |
| Analysis is advisory | Never feeds score, gates, review, or halts | Keeps the conformance number reproducible and the run deterministic | y |
| Missing analysis is normal | Sections render `Not available` and the report still writes | A configured `judgeCommand`, an unavailable judge, or an older run must not block reporting | y |
| Section placement | After `## Code Review` | Keeps deterministic sections contiguous and the interpretation grouped with review evidence | y |
| Malformed fields | Warn and continue | Matches the spec 00054 rule that reporting never blocks delivery | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|--------------|---------------------|
| EARS syntax | All 11 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00057-sdw-orch-delivery-report-judge-analysis.md` |
| Scope enclosure | Two report sections plus the verdict fields that feed them | Inspect `## Description` plus `## Out of Scope` |
| Target inventory | Scoring, CLI, report writer, protocol, skill definition, and tests | Inspect `## Notes` target list |
| Dependency | Spec 00054 is delivered, so the report writer and its sections exist | Check the registry row for 00054 |
| Baseline suite | Existing test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `state.judgment` exists after a `score submit` whose verdict carried analysis fields.
- The report carries both new sections, with one row per criterion in `## Conformance Judgment`.
- The rendered score equals `round(verified / total * 10)` and matches `state.score`.
- A run without a judgment renders `Not available` twice and still writes the report file.
- `--dry-run` prints the summary and writes no report.

### Negative & Failing Test Scenarios

- Malformed `risks`: a string instead of a list is ignored with a warning, and the report still writes.
- Missing judgment: both sections render `Not available`; no error is recorded beyond an informational warning.
- Score drift: a summary claiming a different score never changes `state.score`.
- Writer purity: the report writer module must not import a network client, a shell LLM runner, or read the judge prompt file.
- Budget: `skills/sdw-orch/SKILL.md` stays within 120 lines after the Step 5 and Step 7 additions.
