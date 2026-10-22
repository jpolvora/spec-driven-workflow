---
id: null
slug: 00054-sdw-orch-delivery-report-companion-file-
title: "sdw-orch delivery report companion file and spec-conflict observations at ingestion"
source: local
status: implemented
specDate: 2026-10-22
---

# Specification — sdw-orch delivery report companion file and spec-conflict observations at ingestion

## Description

Two gaps share one root cause: the run knows things the operator only discovers later, and it keeps them in state files instead of next to the specification.

First, a completed run leaves its evidence scattered across `.sdw/state/**` (state JSON, step artifacts, judge verdict) with nothing a reviewer can read beside the spec. Step 8 pushes the branch and opens the pull request without a delivery record, so a reviewer has to reconstruct base commit, timing, tasks, commits, and implementation quality from commit subjects and state files.

Second, ingestion treats the target specification as the only document in the workspace. It never checks whether a delivered specification already covers the same files, whether a later specification supersedes this one, or whether two specifications declare contradictory decisions. Those conflicts only surface after the branch exists.

This specification adds a delivery report written after Step 7 and before Step 8 delegates to `sdw-ship-pr`, stored as a companion file next to the specification and shipped with the pull request, and a read-only spec-conflict analysis performed during ingestion and refinement whose findings become observations in that report.

### Design Intent

The report must be the durable, human-readable answer to "what did this run do, how long did it take, how good is the result, and what should I worry about", and it must travel with the delivery instead of living in state. The conflict analysis stays advisory: it reads other specifications and records what it finds, but never rewrites a specification, never blocks a run, and never guesses at semantics it cannot prove from file content.

## Acceptance Criteria

- AC1: When Step 7 completes and before Step 8 delegates to `sdw-ship-pr`, the system shall write a delivery report as a companion file to the specification, named `{specFileNameWithoutExtension}-report.md` in the specification directory.
- AC2: The delivery report shall record the run id, specification slug, score against `scoreMin`, branch, base branch, base commit, delivery commit, ship status, implementation start and end timestamps, total duration, and per-step durations.
- AC3: The delivery report shall summarize every accepted task with its id, title, status, covered acceptance criteria, checkpoint commit SHA, start and end timestamps, and duration.
- AC4: The delivery report shall list every commit included in the delivery from the base commit to the branch head, each with its SHA and subject.
- AC5: The delivery report shall list the changed files with their change type (`added`, `modified`, `deleted`) grouped by task.
- AC6: The delivery report shall record the verification gate results and the code review outcome.
- AC7: The delivery report shall record breaking-change candidates covering configuration keys, CLI flags and commands, configuration schema, and file layout, stating `None detected` when no candidate exists.
- AC8: The delivery report shall record the quality of the implementation: per-criterion judge verdict counts, review finding counts by severity, and the executed test totals.
- AC9: The delivery report shall record notes covering warnings, skipped steps, abandoned or re-dispatched tasks, and environment facts relevant to interpreting the delivery.
- AC10: The delivery report shall include a `## Spec Observations` section carrying the observations produced by the ingestion analysis.
- AC11: When another specification that is `completed` or `implemented` names a target file also named by the target specification, the system shall record an `overlap` observation naming both specifications and the shared file.
- AC12: When another specification names the target specification's slug or id in a supersession context, the system shall record a `superseded` observation naming the other specification and the matched reference.
- AC13: When two specifications declare the same configuration key with different values or semantics, the system shall record a `conflict` observation naming both specifications, the key, and both values.
- AC14: The system shall record every observation with `kind`, `otherSpec`, `evidence`, and `severity` in the Step 2 output and the Step 2 artifact, and shall never block or alter the run because of an observation.
- AC15: When the delivery report is written, the system shall commit it with a scoped commit that stages only that file, recording its path in run state.
- AC16: When the delivery report cannot be written or committed, the system shall record a warning in run state and continue the run without failing delivery.
- AC17: When a run is resumed, the system shall regenerate the delivery report at the same path from current run state rather than appending to it.
- AC18: The system shall print the observations on `--dry-run` without writing a report or an artifact.
- AC19: The system shall document the report template and the observation rules in `references/orchestrator_protocol.md` and `SKILL.md`, and shall cover the report, the three observation kinds, the resume rewrite, and the dry-run behavior with tests.

## Notes

- Companion path: the report replaces the `.md` suffix of the spec file with `-report.md`, so `.sdw/specs/00054-example.md` yields `.sdw/specs/00054-example-report.md`. It lives beside the specification, not under `.sdw/state/`.
- Deliberate exception: this specification carries 19 criteria because the maintainer required the report contract and the ingestion analysis in one spec. Keep each criterion atomic; do not fold the report sections back into a single clause.
- Report template, in order: `# Delivery Report — {specTitle}`, `## Metadata`, `## Tasks`, `## Commits`, `## Files Changed`, `## Verification`, `## Code Review`, `## Breaking Changes`, `## Quality`, `## Spec Observations`, `## Notes`, `## Outcome`.
- Metadata rows: spec file, slug, run id, status, branch, base branch, base commit, delivery commit, ship status, score / `scoreMin`, implementation start (first dispatch), implementation end (last task accepted), total wall-clock duration, and one row per step with its duration.
- Tasks table: `id | title | status | covered ACs | checkpoint commit | started | completed | duration`.
- Commits section: `git log --format='%h %s' <baseCommit>..HEAD` for the branch, plus the delivery commit when it is not on that range.
- Files Changed section: change type from `git diff --name-status <baseCommit>..HEAD`, attributed to the task whose `filesChanged` names the path; a file owned by several tasks lists each.
- Breaking Changes detection is deterministic and citation-based: configuration keys that appear in `.sdw/config.json` or `.sdw/config.schema.json` diffs, CLI flags added or removed in `skills/*/scripts/*.cjs` help or `parseArgs`, schema property changes, and renamed or removed files under `skills/`. Each candidate cites the diff path; an empty set renders `None detected`.
- Quality section reads existing evidence only: judge verdicts from Step 5, finding counts from the Step 7 report, and test totals from the Step 4 gates and task evidence. It never re-runs anything.
- Notes section records `state.errors`, skipped steps, `steps[4].dispatch.abandonments`, `securityGate` bypasses, and environment facts already captured in state when present.
- Observation rules are file-content heuristics and must stay explainable from the evidence they cite:
  - Target files come from backticked project-relative paths that contain a `/` and a file extension, the same extraction the DAG planner uses.
  - Supersession matches phrases such as `supersedes`, `superseded by`, `replaces`, `replaced by`, `abandoned in favor of`, `will not implement`, applied to the target specification's slug or numeric prefix.
  - Config conflicts match mentions of a key that also exists in `.sdw/config.json` (for example `prePrDiscovery`, `branching.worktree`, `scoreMin`) when the two specifications state different values for it.
- Observations never fail validation and never rewrite anything. They are advisory by contract, and `severity` is `high` only when the other specification is already delivered and shares the same target files.
- Ordering: Step 2 records the observations; Step 7 writes the report; Step 8 pushes the branch with the report committed, so the pull request carries it.
- The report commit uses the existing scoped staging rules (`isScopedExcluded`), never `git add -A`, and never rewrites the delivery commit.
- All new logic is Node.js 22 CommonJS standard library only, with no new runtime dependency.

## Out of Scope

| Feature | Feature reason |
|---------|----------------|
| Semantic or LLM-based conflict judgment | Heuristics must stay explainable from cited evidence; an LLM judgment would make the observation unreproducible. |
| Blocking a run on a conflict observation | The operator decides; the run records and continues. |
| Rewriting or repairing specifications automatically | Spec authoring stays explicit (`sdw-spec`); the run only observes. |
| Publishing the report to the SCM as a pull request comment | The report ships as a committed file; posting it is an SCM delivery concern. |
| Re-running gates or review to enrich the report | The report reads recorded evidence; re-execution would double cost and could disagree with the gate history. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Report location | Companion file beside the spec | The operator opens the spec; the report must be readable at the same place and diffable in git. | y |
| Report timing | After Step 7, before Step 8 | It must include the review outcome and still ship with the pull request. | y |
| Report failure handling | Warn and continue | A missing report must not block a verified delivery; the warning lands in state. | y |
| Breaking-change source | Config and schema diffs, CLI parsing changes, file renames | These are deterministic reads that cite a path, unlike prose judgment. | y |
| Observation blocking | Never blocks | False positives are inevitable in file heuristics; advisory keeps the run safe. | y |
| Timestamps source | Run state timestamps plus git commit times when absent | State already records dispatch and acceptance times; git covers commits outside the state. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00054-sdw-orch-delivery-report-companion-file-.md` |
| Step anchors | Step 7 completion and Step 8 delegation locatable in the orchestrator | Read `skills/sdw-orch/scripts/sdw_orch.cjs` Step 7 and Step 8 blocks |
| Ingestion anchor | Step 2 refinement output and artifact writer exist | Read `skills/sdw-orch/scripts/spec_grilling.cjs` and `artifact_writer.cjs` |
| Evidence sources | Run state records tasks, gates, score, review, and errors | Read `skills/sdw-orch/references/orchestrator_protocol.md` § 1 |
| Test anchor | An orchestrator test suite exists to extend | `tests/sdw_step_artifacts.test.cjs` and `tests/sdw_orch.test.cjs` present |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Run state: `state.deliveryReport` (project-relative path), `steps[2].output.specObservations` (array), `steps[2].artifact` already records the Step 2 artifact path.
- Console: one line per observation (`[sdw-orch] Spec observation (overlap, high): ...`) and one line naming the written report.
- Report `## Metadata` exposes `shipStatus` as `pending` when written before Step 8 completes, and the report is regenerated on resume once the outcome exists.

### Negative & Failing Test Scenarios

- Report path not writable: warning recorded, run continues, delivery still succeeds.
- Resume after a partial run: the report is rewritten, not appended, and contains the latest score, timings, and outcome.
- Target spec names no target files: no `overlap` observations, section present with `None`.
- A delivered spec shares a target file: `overlap` with `severity: high` and the shared path in `evidence`.
- A newer spec says `supersedes <target>`: `superseded` observation naming that spec.
- Two specs state different values for the same config key: `conflict` observation naming the key and both values.
- A delivery with no configuration or CLI change: `## Breaking Changes` renders `None detected`.
- `--dry-run` prints observations and writes no report file or Step 2 artifact.
