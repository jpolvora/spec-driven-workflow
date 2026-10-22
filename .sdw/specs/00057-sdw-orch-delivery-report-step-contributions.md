---
id: null
slug: 00057-sdw-orch-delivery-report-step-contributions
title: "SDW Delivery Report — Incremental Step Contributions, Learnings, and Retro Closure"
source: local
status: ready-to-implement
specDate: 2026-10-22
priority: medium
value: "Turns the delivery report into a living record fed by every step, carries each recorded learning into the steps that follow, and closes the run with a retrospective that fixes what it can"
effort: L
---
# Specification — SDW Delivery Report Step Contributions

## Description

Spec 00054 writes a deterministic delivery report from run state at one moment: after Step 7 resolves, immediately before Step 8 delegates delivery. Every section is derived from git, state files, and gate results as they stand at that instant. The report therefore describes the end state and loses the history: how many review iterations it took to converge, which findings were fixed and by which commit, which pre-PR gate failed first, which threads stayed open across ship attempts, what the judge concluded and why, which tasks were retried or abandoned, and which traps the run discovered about its own codebase. A reader cannot reconstruct the delivery from the report, and a run that stops before Step 7 writes no report at all.

This specification makes the report incremental. Each pipeline step appends a structured contribution to run state as the step happens, and the report is re-rendered from those contributions at every step boundary. The report becomes a living record of the run: Step 4 contributes task outcomes, Step 5 contributes the score, the per-criterion verdicts, and the judge's interpretation, Step 6 contributes the delivery commit and the security gate, Step 7 contributes one entry per review iteration with its findings and fixes, and Step 8 contributes the pre-PR gates, the push, the pull request, and one convergence entry per iteration. Warnings and errors join the same list when they occur.

The report also carries what the run learned. Every memory entry the run records through `sdw-memory` becomes a `learning` contribution, and the same entry is written to a run-scoped index so the steps that follow can query it and apply it while the run is still in progress. A learning is not a note for later: Step 4 dispatch, Step 7 review fixes, and Step 8 gate decisions read the learnings recorded so far, and the report names which step applied which learning.

The retrospective closes the run. When `sdw-retro` completes, its signals, its candidates, and the fixes it applied become the final contribution, and the report is re-rendered so the committed record carries them. The retrospective stops reporting and starts fixing inside its routes: it records the memory entries its candidates call for, consolidates duplicates, and queues a follow-up specification for every candidate that needs a code change. It never edits `skills/` directly; a code change still needs a specification.

The judge analysis is one contribution kind among these: the Step 5 verdict gains optional `summary`, `risks`, and `followUps` fields, `score submit` persists them, and the report renders them in a dedicated section. The writer stays deterministic and offline: it renders what the run already recorded and never calls a language model itself.

### Design Intent

Keep the deterministic core and let the steps feed it. Contributions are data, never prose: a step records what it did, and the writer owns the layout. The score stays derived from per-criterion verdicts alone, so no contribution can move the number. Learnings travel through run state first and the memory backend second, so a step in the same run never depends on a reachable vault to apply what the previous step learned. Rendering is idempotent and ordered, so the same run state always produces the same report and a resumed run rewrites the same file instead of appending a second one. When a contribution is absent the affected section degrades to `Not available`, preserving the spec 00054 guarantee that reporting is best-effort and never blocks delivery.

## Acceptance Criteria

- AC1: The run state shall carry an append-only `reportContributions` list whose entries name the step number, the step name, the timestamp, the contribution kind, a title, a body, and the evidence paths.
- AC2: When a step completes, the system shall append that step's contribution to run state before the next step begins.
- AC3: When Step 4 completes, the system shall contribute one entry per task carrying the task id, its acceptance outcome, the files it touched, and any retry or abandonment.
- AC4: When Step 5 completes, the system shall contribute the score, the required minimum, one verdict per acceptance criterion with its evidence, and the judge analysis.
- AC5: When Step 6 completes, the system shall contribute the delivery commit, the staged files, and the security gate outcome.
- AC6: When Step 7 completes, the system shall contribute one entry per review iteration carrying the findings by severity and the fixes applied, including an iteration that applied no fix.
- AC7: When Step 8 completes, the system shall contribute the pre-PR gate results, the push, the pull request, and one convergence entry per iteration carrying the failing checks, the open threads, the resolved threads, and the fix commit.
- AC8: The report writer shall render the contributions in step order and shall render `Not available` for a section whose contributions are absent.
- AC9: The system shall re-render the report at every step boundary and after every convergence iteration, so a run that stops mid-pipeline leaves a report describing the steps that already ran.
- AC10: The report writer shall write the report atomically, so an interrupted write never leaves a truncated report.
- AC11: The system shall write the in-progress report under the run artifact directory and shall commit the delivery companion from the complete contribution set.
- AC12: If a contribution is malformed, then the system shall skip that entry, record a warning in run state, and still render the remaining contributions.
- AC13: The report writer shall not invoke a language model, rendering only values already present in run state, in git, or in a gate result.
- AC14: When `--dry-run` is supplied, the system shall print the contribution summary and shall write no report.
- AC15: The judge verdict schema shall accept optional `summary`, `risks`, and `followUps` fields alongside `score` and `verdicts`, and `score submit` shall persist them as the Step 5 contribution.
- AC16: The report shall render a `## Conformance Judgment` section carrying the score, the required minimum, the verified and failed counts, and one row per criterion with its verdict and evidence.
- AC17: The report shall render a `## Judge Analysis` section carrying the summary, the risks, and the follow-ups, attributed to the Step 5 judge and marked advisory.
- AC18: The `sdw-orch` skill definition and the orchestrator protocol reference shall document the contribution contract and the report sections within the Tier-1 line budget.
- AC19: The test suite shall cover contributions that are present, absent, and malformed, contributions appended across several steps, the atomic write, and the dry-run print.
- AC20: When a step records a memory entry through `sdw-memory`, the system shall append a `learning` contribution naming the kind, the slug, the title, the severity, the layer, the path patterns, the recording backend, and the recording step.
- AC21: The system shall write every learning to a run-scoped index in the run artifact directory, so the learnings stay queryable while the run is in progress even when no memory backend is reachable.
- AC22: The system shall make the run-scoped learnings available to a later step before that step acts, by passing the matching entries into the step prompt or dispatch and by answering `sdw-memory query --run <runId>` from the run-scoped index merged with the enabled backends.
- AC23: The report shall render a `## Learnings` section listing every learning contribution with its kind, slug, severity, recording step, and the step that applied it.
- AC24: When a later step applies a recorded learning, the system shall record the applying step and the evidence on that learning, so the report names which learnings changed the run.
- AC25: When the retrospective completes, the system shall append a `retro` contribution carrying its signals, its candidates, and the fixes it applied.
- AC26: The retrospective shall apply every fix its routes allow: it shall record the memory entries its candidates call for, consolidate duplicate entries, and queue a follow-up specification for each candidate that needs a code change, reporting each applied fix and each routed candidate.
- AC27: If a candidate needs a change under `skills/`, then the retrospective shall route it to a specification and name the queued specification instead of editing the file.
- AC28: The system shall re-render the report when the retrospective completes, and shall expose a re-render that refreshes the companion from run state without amending a pushed commit.
- AC29: The test suite shall cover learnings that are recorded, queried by a later step, applied, and absent, plus the retrospective contribution, the routed candidate, and the re-render.

## Notes

- Run-state shape: `state.reportContributions = [{ step, stepName, at, kind, title, body, evidence: [] }]`, appended by the owning step and never rewritten. Ordering is by `step` ascending, then `at`, then insertion order; the writer never sorts by wall clock alone.
- Contribution kinds and their owning step:

  | Kind | Step | Body carries |
  |------|------|--------------|
  | `plan` | 3 | Task ids, dependency order, dispatch mode |
  | `task` | 4 | Task id, acceptance outcome, files touched, retries, abandonment |
  | `verdict` | 5 | Score, minimum, per-criterion verdicts with evidence |
  | `judgment` | 5 | Summary, risks with severity and evidence, follow-ups |
  | `learning` | any | Kind, slug, title, severity, layer, path patterns, backend, applying step |
  | `delivery` | 6 | Delivery commit, staged files, security gate outcome |
  | `review` | 7 | Iteration number, findings by severity, fixes applied, no-op iterations |
  | `gates` | 8 | Pre-PR gate names, pass or fail, durations |
  | `ship` | 8 | Push, pull request number and url, ship status |
  | `convergence` | 8 | Iteration number, failing checks, open threads, resolved threads, fix commit |
  | `retro` | post-8 | Signals, candidates with severity, applied fixes, queued specifications |
  | `warning` | any | The recorded warning text and its step |

- Learning shape: `{ step, stepName, at, kind: 'trap'|'gap'|'pattern'|'error', slug, title, severity, layer, pathPatterns, backend, appliedBy: null|{ step, evidence } }`. The same object is the `learning` contribution, so the report and the run-scoped index never diverge.
- Run-scoped index: `.sdw/state/{slug}/{runId}/learnings.json`, append-only, written on every `sdw-memory record` the run performs. It is the queryable source during the run; the memory backend stays the durable source across runs.
- Digest rule: before a step acts, the system selects the run-scoped learnings whose `pathPatterns` match the files that step will touch, ordered by severity then recording step, capped at a fixed bound, and passes them with the step prompt or dispatch. A step with no matching learning proceeds unchanged.
- Application evidence: the step that applies a learning records the applying step and one evidence locator on the learning, so the `## Learnings` section distinguishes a learning that was recorded from one that changed the run.
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
- Report sections render in this order: `## Metadata`, `## Tasks`, `## Commits`, `## Files Changed`, `## Verification`, `## Code Review`, `## Conformance Judgment`, `## Judge Analysis`, `## Learnings`, `## Retrospective`, `## Breaking Changes`, `## Quality`, `## Spec Observations`, `## Notes`, `## Outcome`. The new sections are inserted after `## Judge Analysis`, keeping the deterministic sections contiguous.
- Retrospective routes, and the boundary this specification keeps:

  | Candidate needs | Route | Applied by the retro |
  |-----------------|-------|----------------------|
  | A memory entry | `sdw-memory record` | Yes, immediately, with the slug and backend reported |
  | A duplicate entry merged | `sdw-memory consolidate` | Yes, with removed and kept counts reported |
  | A change under `skills/` or `tests/` | A follow-up specification | No, routed and named; never a direct edit |
  | An operator decision | Operator edit | No, reported as open |

- Path contract: the in-progress report is written to the run artifact directory (`.sdw/state/{slug}/{runId}/report.md`, uncommitted). The committed companion is written from the complete contribution set at delivery, at the spec 00054 path beside the specification. Relocating that companion to `.sdw/reports/` is owned by the report relocation specification; this one keeps the delivered path and introduces no new file class into the specification directory.
- Atomic write: render to a sibling temporary file, then rename over the destination, so an interrupted or failed write leaves the previous report intact.
- Degradation rules: a missing contribution renders `Not available` for that section; a malformed entry is skipped with one warning line through the existing warning path; an unreachable memory backend records the learning in the run-scoped index and reports the backend as unavailable; the report write never fails because of a contribution or a learning problem.
- Advisory fence: the judge analysis is attributed to the Step 5 judge in the section body, marked advisory, and never feeds the score, the gates, the review, or any halt decision.
- Target surfaces:
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: append the step contributions and re-render at every step boundary and convergence iteration; capture every `sdw-memory record` as a learning; build the per-step digest; record the applying step; append the retro contribution; expose the companion re-render; `score submit` persists the analysis; `--dry-run` prints the contribution summary.
  - `skills/sdw-orch/scripts/delivery_report.cjs`: render every section from `reportContributions`, with ordering, degradation, and the atomic write.
  - `skills/sdw-orch/scripts/score_evaluator.cjs`: verdict validation accepts and normalizes the optional analysis fields, and `buildJudgePrompt` requires them while stating that they never change the score.
  - `skills/sdw-memory/scripts/sdw_memory.cjs`: `record` reports the entry it persisted, and `query` accepts `--run <runId>` to merge the run-scoped index with the enabled backends.
  - `skills/sdw-retro/scripts/retro.cjs`: record the applied fixes and the routed candidates on its report, and hand them to `sdw-orch` as the retro contribution.
  - `skills/sdw-orch/references/orchestrator_protocol.md`: the contribution contract, the learning contract, the verdict schema, and the report sections.
  - `skills/sdw-memory/references/memory_protocol.md` and `skills/sdw-retro/references/candidate_contract.md`: the run-scoped index, the digest rule, and the retro routes.
  - `skills/sdw-orch/SKILL.md`, `skills/sdw-memory/SKILL.md`, and `skills/sdw-retro/SKILL.md`: the new steps inside the Tier-1 line budgets.
  - `tests/sdw_orch_scoring.test.cjs`: verdict validation and persistence, including malformed fields.
  - `tests/sdw_orch.test.cjs`: contribution appending across steps, report rendering for present, absent, and malformed contributions, the atomic write, and the dry-run print.
  - `tests/sdw_memory.test.cjs` and `tests/sdw_retro.test.cjs`: the run-scoped query, the digest selection, the applied fix, and the routed candidate.
- All helper scripts remain Node.js CommonJS (.cjs) using standard library modules only. No new runtime dependencies.

## Out of Scope

| Feature | Reason |
|---------|--------|
| An LLM call inside the report writer | The writer stays deterministic and offline; interpretation comes from the judge, which already reads the criteria and the diff |
| Score changes driven by the analysis prose | The score stays derived from per-criterion verdicts, so the number remains reproducible |
| Replacing the deterministic content delivered by spec 00054 | The section content contract holds; this specification changes how it is produced and adds the history, learning, and retro sections |
| Direct `skills/` edits by the retrospective | A code change needs a specification; the retro records, consolidates, and queues, and names what it routed |
| Live streaming of the report to a console or monitor | `sdw-monitor` (spec 00021) owns live telemetry; this specification writes a file |
| Retrospective or changelog consumption of the contributions beyond the retro section | Those surfaces own their own inputs and are not extended here |
| Relocating the committed companion to `.sdw/reports/` | Owned by the report relocation specification; this one keeps the delivered companion path and does not duplicate it |
| A memory backend that is reachable from every consumer | The run-scoped index carries the in-run contract; the vault stays the durable cross-run backend |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Contributions live in run state | Append-only `reportContributions` list | Run state already survives pause and resume, so the history survives with it | y |
| Render cadence | Every step boundary plus every convergence iteration | A run that stops mid-pipeline must still describe what already ran | y |
| In-progress location | Run artifact directory, uncommitted | Keeps the work tree clean during the run and avoids a commit per step | y |
| Committed companion source | The complete contribution set | One final render, so the committed file is the whole story | y |
| Learnings reach the next step through run state | Run-scoped index plus a per-step digest | A later step must apply what an earlier step learned without a reachable vault | y |
| Digest bound | Fixed cap, severity then recording step, path-pattern match | Keeps a step prompt bounded while the learnings grow | y |
| The judge writes the analysis | Optional verdict fields | The judge already holds the fenced criteria and diff, so no second context is needed | y |
| Analysis is advisory | Never feeds score, gates, review, or halts | Keeps the conformance number reproducible and the run deterministic | y |
| The retro fixes what its routes allow | Record, consolidate, queue; never edit `skills/` | Keeps spec-first intact while the retro stops being report-only | y |
| Missing contributions are normal | Sections render `Not available` and the report still writes | A run resumed from older state, or one that stops early, must not block reporting | y |
| Malformed contributions | Warn and continue | Matches the spec 00054 rule that reporting never blocks delivery | y |
| Companion destination | The spec 00054 path beside the specification, unchanged | Relocating it is owned by the report relocation specification, so this one introduces no new file class into the specification directory | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|--------------|---------------------|
| EARS syntax | All 29 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00057-sdw-orch-delivery-report-step-contributions.md` |
| Scope enclosure | The contribution contract, the learning contract, the two judge sections, and the retro closure | Inspect `## Description` plus `## Out of Scope` |
| Target inventory | Orchestrator, report writer, score evaluator, memory, retro, protocol and skill references, and tests | Inspect `## Notes` target list |
| Dependency | Spec 00054 is delivered, so the report writer and its sections exist | Check the registry row for 00054 |
| Dependency | `sdw-memory` and `sdw-retro` are delivered, so the learning and retro surfaces exist | Check the registry rows for their specifications |
| Baseline suite | Existing test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `state.reportContributions` grows by one entry per completed step, one per convergence iteration, one per recorded learning, and one for the retro.
- A run stopped after Step 5 leaves a report carrying the plan, task, verdict, and judgment sections with the later sections `Not available`.
- The `## Code Review` section lists one row per review iteration, including an iteration that applied no fix.
- The `## Verification` section lists every pre-PR gate attempt, so a gate that failed before passing appears twice.
- The `## Learnings` section lists every recorded learning and marks the ones a later step applied.
- The `## Retrospective` section lists the signals, the candidates, the fixes the retro applied, and the specifications it queued.
- A learning recorded in Step 4 appears in the Step 7 dispatch digest when its path patterns match the files under review.
- The rendered score equals `round(verified / total * 10)` and matches `state.score`.
- `--dry-run` prints the contribution summary and writes no report.

### Negative & Failing Test Scenarios

- Malformed contribution: an entry missing `kind` is skipped with a warning, and the remaining sections still render.
- Missing contributions: every affected section renders `Not available`; no error is recorded beyond an informational warning.
- Interrupted write: a render that fails mid-way leaves the previous report byte-identical, never a truncated file.
- Unreachable backend: a learning is recorded in the run-scoped index, the backend is reported unavailable, and the later step still receives the digest.
- Learning not applied: a learning whose path patterns match nothing stays listed without an applying step, and no step claims it.
- Retro boundary: a candidate that needs a `skills/` change is queued and named, and the file is left untouched.
- Score drift: a summary claiming a different score never changes `state.score`.
- Writer purity: the report writer module must not import a network client, a shell LLM runner, or read the judge prompt file.
- Resumed run: a second render over unchanged contributions produces byte-identical output.
- Budget: `skills/sdw-orch/SKILL.md`, `skills/sdw-memory/SKILL.md`, and `skills/sdw-retro/SKILL.md` stay within their Tier-1 line budgets after the new steps.
