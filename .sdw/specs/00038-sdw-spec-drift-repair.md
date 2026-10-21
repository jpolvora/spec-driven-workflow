---
id: null
slug: 00038-sdw-spec-drift-repair
title: "SDW Spec Drift Repair"
source: local
status: ready-to-implement
specDate: 2026-10-21
---
# Specification — SDW Spec Drift Repair

## Description

Deterministic repair for specifications overtaken by direct implementation. This specification adds `sdw-spec update`, which compares working-tree, index, and untracked changes against a base commit, restricts attention to files already named by the target specification, shows a proposed Notes insertion and revision line, and writes that insertion only with explicit `--apply`.

### Design Intent

Repair drift without inventing intent. Exact path matching keeps the command conservative: related but unreferenced files remain visible as unmatched instead of being assigned to the wrong specification. The default behavior is read-only, while `--apply` records operator approval.

## Acceptance Criteria

- AC1: The system shall provide the `sdw-spec update --slug <slug> [--from <commit>] [--apply] [--root <path>] [--json]` subcommand.
- AC2: The system shall compare tracked working-tree and index changes against `--from` when supplied, otherwise against `HEAD`.
- AC3: The system shall include untracked non-ignored files in the changed set.
- AC4: The system shall exclude `.git/`, `.sdw/state/`, `.sdw/sandbox/`, and `.sdw/worktrees/` from drift detection.
- AC5: The system shall treat a changed file as in scope only when its project-relative path appears in the target specification.
- AC6: When `--apply` is omitted, the system shall print matched files, unmatched files, proposed insertion text, and one revision-history line without modifying files.
- AC7: When `--apply` is supplied, the system shall insert only the reported text under `## Notes` and preserve all other specification bytes.
- AC8: If `--from` does not resolve to a commit, then the system shall exit `1` naming the unresolved reference.
- AC9: If the slug has no specification file, then the system shall exit `1` naming the slug.
- AC10: If no changed file appears in the target specification, then the system shall exit `0` with `No specification drift found` and create no file.
- AC11: The system shall leave the specification header, lifecycle status, and registry row unchanged during drift repair.

## Notes

- CLI contract:
  ```bash
  node skills/sdw-spec/scripts/sdw_spec.cjs update --slug <slug> [--from <commit>] [--apply] [--root <path>] [--json]
  ```
- The changed set is the union of:
  - `git diff --name-status <base> -- .`
  - `git ls-files --others --exclude-standard -z`
  - where `<base>` is `--from` when supplied and `HEAD` otherwise.
- Path matching uses normalized forward-slash project-relative paths.
- The revision insertion is added at the end of `## Notes` in this form:
  ```markdown
  ### Drift Update (<UTC timestamp>; base <base>)
  - `<path>`: named by this specification and changed in the working set
  - Revision: <one-line description derived from changed paths>
  ```
- The JSON report contains `slug`, `base`, `matchedFiles`, `unmatchedFiles`, `insertion`, and `revisionLine`.
- `--apply` writes the entire reported insertion after the operator has reviewed it; partial hunk selection is not implemented.
- If `## Notes` is absent, the command exits `1` because the target is not a valid specification body.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Semantic similarity matching | Path inference could assign implementation work to the wrong specification. |
| Partial hunk application | One reviewed insertion keeps approval unambiguous. |
| Status or registry transitions | Drift repair records evidence only; lifecycle remains with the existing status and sync commands. |
| Ignored or ephemeral files | `.git`, run-state, sandbox, and worktree paths are not specification drift. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Mapping signal | Exact path mention in the target specification | Conservative matching avoids false specification assignments. | y |
| Unmatched changes | Reported, not assigned | Unreferenced work may belong to another specification or need an explicit amendment. | y |
| Base reference | Supplied commit, otherwise `HEAD` | Direct edits are normally uncommitted working-tree changes. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00038-sdw-spec-drift-repair.md` |
| Deterministic tests | One test file covers change collection, exclusions, exact matching, proposal-only mode, apply mode, invalid base, unknown slug, no-drift output, and metadata preservation | Run `npm test` |
| Skill integration | `sdw-spec` exposes `update` with help and JSON output | Run `node skills/sdw-spec/scripts/sdw_spec.cjs update --help` and a fixture command |
| Specification safety | A fixture specification remains valid after `--apply` | Run authoring validation before and after the fixture update |

## Validation & Observation Notes

### Telemetry & Observable Signals

- The report identifies the specification, base reference, matched paths, and unmatched paths.
- Proposal-only mode prints the insertion and revision line.
- JSON mode exposes the same report fields for tests.
- Apply mode reports the updated specification and preserved byte count outside the insertion.

### Negative & Failing Test Scenarios

- An unknown `--from` value exits `1` with the unresolved reference.
- An unknown slug exits `1` without touching files.
- A specification without `## Notes` exits `1` before proposing an insertion.
- Applying the same insertion twice produces two distinguishable revision entries unless the command is scoped to prevent repetition.
