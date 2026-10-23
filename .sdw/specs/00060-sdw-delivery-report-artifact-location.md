---
id: null
slug: 00060-sdw-delivery-report-artifact-location
title: "SDW Delivery Report Artifact — Relocate to .sdw/reports and Exclude It From Every Specification Scanner"
source: local
status: implemented
specDate: 2026-10-22
priority: high
value: "Stops delivery reports from being registered as specifications, shadowing a spec lookup, and polluting the backlog the priority ranking reads"
effort: M
---
# Specification — SDW Delivery Report Artifact Location

## Description

Spec 00054 made `sdw-orch` write a delivery report as a companion file beside the specification, named `{specFileNameWithoutExtension}-report.md`. The exclusion for that file class reached three readers (`spec_index.cjs`, `sdw_doctor.cjs`, `spec_grilling.cjs`) and missed the ones that write:

- `sdw-spec sync` scans every `*.md` in the specification directory (`spec_sync.cjs` step 2) and registers an untracked file as a `pending` specification with validation `FAIL`. `sdw-batch` runs that same sync after every completed item, so each delivery registers its own report as a new backlog entry.
- `sdw_spec.cjs` `findSpecFile` matches a prefix key against every `^\d{5}-.*\.md$` name, so `00038` resolves to `00038-sdw-spec-drift-repair-report.md` before the specification; `status`, `archive`, and `update` then target the report.
- `sdw-spec create` allocates the next prefix from the same unfiltered scan.
- `sdw-ship-pr` resolves the specification by filename with no report exclusion.

The consequence is in the registry today. Five `*-report` rows exist: 00038, 00054 and 00055 appear as specifications, and a later sync flipped them to `completed` because their slugs contain a completed specification's slug; 00057 and 00058 were added by the sync of 2026-10-22 20:35. `sdw-spec list-by-priority` ranks them like specifications, with empty priority, effort, and acceptance-criteria count.

This specification moves the committed companion out of the specification directory, into `.sdw/reports/`, and makes every scanner ignore a report wherever it lives, so the class cannot be registered, cannot shadow a lookup, and cannot distort the backlog. It also repairs the rows already written.

### Design Intent

One directory, one file class. A specification directory contains specifications; a report is a delivery artifact about a specification, so it belongs in an artifact directory the same way run state does. Exclusions stay as a second line of defense, because a legacy companion can already exist beside a specification and an operator can drop one there by hand.

## Acceptance Criteria

- AC1: The report writer shall resolve the committed companion to `.sdw/reports/{specFileNameWithoutExtension}-report.md`, and shall create that directory when it is absent.
- AC2: The system shall keep writing the in-progress report under the run artifact directory, unchanged by the relocation.
- AC3: When a scanner enumerates a specification directory, the system shall not treat a file named `*-report.md` as a specification, wherever that file is located.
- AC4: When `sdw-spec sync` discovers files, the system shall not register a `*-report.md` file as a specification entry and shall report how many files it excluded.
- AC5: When `sdw-spec status`, `archive`, or `update` resolves a key, the system shall resolve it only to a specification file and never to a `*-report.md` companion.
- AC6: When `sdw-spec create` allocates a prefix, the system shall ignore `*-report.md` files.
- AC7: When `sdw-ship-pr` resolves a specification by slug, the system shall ignore `*-report.md` files.
- AC8: The delivery of this specification shall move every existing `*-report.md` companion that sits in the specification directory into `.sdw/reports/`.
- AC9: The delivery of this specification shall remove every `*-report` row from `index.specs.md`, which is the five rows named 00038, 00054, 00055, 00057, and 00058 today.
- AC10: The system shall not re-add a removed `*-report` row on any later sync.
- AC11: When `sdw-doctor` finds a `*-report.md` file inside the specification directory, the system shall report it as a legacy location carrying the move target and shall not fail the audit.
- AC12: The CI and release validation loops shall keep skipping `*-report.md` files when they validate specifications under `.sdw/specs/`.
- AC13: The `sdw-orch` skill definition, the orchestrator protocol reference, `README.md`, `FEATURES.md`, and `.sdw/directory-structure.md` shall document the `.sdw/reports/` location and the delivery report feature.
- AC14: The test suite shall cover the relocation, each scanner's exclusion, the prefix-key lookup that used to return a report, the removed registry rows, the legacy companion report, and the sync exclusion count.

## Notes

- Live evidence for this specification, from `develop` at `586ffb9`: `index.specs.md` carries `00038-sdw-spec-drift-repair-report`, `00054-sdw-orch-delivery-report-companion-file--report`, `00055-sdw-spec-list-by-priority-report`, `00057-sdw-orch-delivery-report-step-contributions-report`, and `00058-sdw-batch-delivery-integrity-report`. The first three read `completed` because `spec_sync` matched them against a completed run by substring, which is the same matcher that also drove the header drift spec 00058 fixed.
- Second line of defense, kept on purpose: `spec_index.cjs`, `sdw_doctor.cjs`, `spec_grilling.cjs`, and the CI loops already exclude `-report.md`. They keep the exclusion after the move, because a legacy file can exist beside a specification.
- Scanner inventory to prove in the tests, one assertion each: `spec_sync.cjs` (discovery), `sdw_spec.cjs` (`findSpecFile` and the prefix allocator), `spec_creator.cjs`, `sdw_ship_pr.cjs`, `spec_index.cjs`, `sdw_doctor.cjs`, `spec_grilling.cjs`.
- Path contract after the move: the delivery commit stages `.sdw/reports/{name}-report.md` instead of a file in `.sdw/specs/`; the report is still committed, still rewritten on resume, and still rendered from the complete contribution set, per spec 00057.
- Repair order matters: move the files first, then remove the rows, then run a sync and assert it adds nothing. A sync between the move and the row removal would keep the rows alive.
- A report row is not migrated to a different status; it is deleted. A report is an artifact, so it has no lifecycle of its own.
- `.sdw/reports/` stays tracked by git: the report is a committed delivery record, not ephemeral state.
- Target surfaces:
  - `skills/sdw-spec/scripts/spec_sync.cjs`: discovery exclusion and the excluded count in its report.
  - `skills/sdw-spec/scripts/sdw_spec.cjs`: `findSpecFile` and the prefix allocator.
  - `skills/sdw-spec/scripts/spec_creator.cjs`: the existing-file scan.
  - `skills/sdw-spec/scripts/spec_index.cjs`: the scan exclusion and the registry repair path.
  - `skills/sdw-orch/scripts/delivery_report.cjs`: `resolveReportPath` resolving to `.sdw/reports/`.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: the report commit and re-render paths, which stage the relocated path.
  - `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs`: specification resolution.
  - `skills/sdw-doctor/scripts/sdw_doctor.cjs`: the legacy-location advisory.
  - `.github/workflows/ci.yml` and `.github/workflows/release.yml`: the validation skip stays.
  - `skills/sdw-orch/SKILL.md`, `skills/sdw-orch/references/orchestrator_protocol.md`, `README.md`, `FEATURES.md`, `.sdw/directory-structure.md`: the location and the feature.
  - `tests/sdw_spec.test.cjs`, `tests/sdw_spec_update.test.cjs`, `tests/sdw_orch.test.cjs`, `tests/sdw_doctor.test.cjs`, `tests/sdw_ship_pr.test.cjs`: the cases named in AC14.
- All helper scripts remain Node.js CommonJS (.cjs) using standard library modules only. No new runtime dependencies.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Reworking the report's sections or the contribution set | Spec 00057 owns the content and the incremental rendering |
| Making runs fail when the report cannot be written | Reporting stays best effort, as spec 00054 decided |
| A lifecycle for report rows in the registry | A report is an artifact, so the rows are deleted, not migrated |
| Writing reports for archived or abandoned specifications | The report belongs to a run, and a run belongs to an implemented specification |
| Pruning older reports automatically | An operator archives artifacts deliberately; nothing is deleted on a timer |
| Publishing reports to the SCM pull request as a comment | A separate delivery channel, not a file location concern |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Artifact directory, not the specification directory | `.sdw/reports/` | Mirrors `.sdw/state/` for run artifacts and removes the class from the scanning root | y |
| Keep the filename | `{specFileNameWithoutExtension}-report.md` | The relocation alone removes the collision; the name carries the specification it describes | y |
| Keep the scanners' name exclusion | Yes, after the move | A legacy companion can already exist beside a specification | y |
| Existing rows are deleted | Five rows removed in the delivery | A report has no lifecycle, so a row for it is always wrong | y |
| Existing companions move | Yes, in the same delivery | Leaving them behind keeps the legacy advisory firing forever | y |
| Reports stay committed | Yes, still tracked by git | The report is a delivery record a reviewer reads without the run state | y |
| Legacy location fails the audit | Advisory only | An old report is not a product defect, and doctor stays actionable | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|--------------|---------------------|
| EARS syntax | All 14 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00060-sdw-delivery-report-artifact-location.md` |
| Scope enclosure | The relocation, the scanner exclusions, the row repair, and the documentation | Inspect `## Description` plus `## Out of Scope` |
| Target inventory | Seven scanners, the writer, the orchestrator, the doctor, the CI loops, the docs, and the tests | Inspect `## Notes` target list |
| Dependency | Spec 00054 and spec 00057 are delivered, so the report writer and its committed path exist | Check the registry rows |
| Baseline suite | Existing test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- A completed run writes `.sdw/reports/{specFileNameWithoutExtension}-report.md` and commits it from that path.
- `sdw-spec sync` reports an excluded count when it skips report files.
- `sdw-spec sync` after a delivery adds no `*-report` row to `index.specs.md`.
- `sdw-spec list-by-priority` prints no row whose title starts with `Delivery Report`.
- `sdw-spec status 00038 implemented` resolves the specification, never `00038-sdw-spec-drift-repair-report.md`.
- `sdw-doctor` passes with the relocated reports and advises when a legacy companion sits beside a specification.

### Negative & Failing Test Scenarios

- A report file placed directly in the specification directory: every scanner ignores it, the sync adds no row, and doctor advises the move.
- A prefix key with both a specification and a report present: `findSpecFile` returns the specification.
- A sync run twice in a row: no duplicate row appears, and the excluded count is stable.
- A fresh workspace with no `.sdw/reports/` directory: the writer creates it and the report is written.
- A registry containing a `*-report` row: the delivery removes it and no later sync restores it.
- The existing report tests still pass with the relocated path, proving the rewrite, the resume behaviour, and the commit are unchanged apart from the directory.
- Budget: `skills/sdw-orch/SKILL.md` stays within its Tier-1 line budget after the location wording changes.
