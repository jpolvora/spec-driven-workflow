---
id: "20"
slug: 00041-us-20-versioned-spec-files-for-creation
title: "Versioned spec files for creation, editing, and drift repair"
source: github
status: draft
specDate: 2026-10-21
---

# Specification — Versioned spec files for creation, editing, and drift repair

## Description

# Versioned spec files for creation, editing, and drift repair

## Problem
Each spec is one file (`000NN-slug.md`). Updates via `sdw-spec update --apply` or drift repair overwrite history. Reviewers cannot diff v01 vs v02 or recover the approved baseline.

## Proposal
Keep prefix plus slug stable and insert a version token per revision:
- Original stays as is for v00 compatibility: `00036-sdw-changelog-delivery-records.md`.
- New revisions add `v-NN` after the numeric prefix: `00036-v01-sdw-changelog-delivery-records.md`, then `00036-v02-...`.
- Registry `index.specs.md` points to the latest version only; prior versions stay on disk as history.
- `sdw-spec update` defaults to write a new versioned file, never overwrite, unless an explicit overwrite flag is passed.
- `validate_spec.cjs` accepts versioned names and validates the latest; list commands group by prefix plus slug and show latest plus count.

## Scope
- `skills/sdw-spec/scripts/sdw_spec.cjs` create, update, list, sync logic plus filename parser.
- `skills/sdw-spec/scripts/validate_spec.cjs` authoring mode plus versioned names.
- `skills/sdw-spec/references/spec_standard.md` naming rule plus revision history rule.
- `.sdw/specs/index.specs.md` latest pointer convention.
- No change to run state or delivery commits in this cut.

## Verification
- [ ] New version writes `000NN-v01-slug.md`, original untouched.
- [ ] Index points to latest, history files remain valid.
- [ ] `npm test` passes.
- [ ] Docs updated: `spec_standard.md` only.


### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for Versioned spec files for creation, editing, and drift repair.

### Prior Work Sweep

Reviewed existing workspace implementations and tracker references prior to specification formulation.

## Acceptance Criteria

- AC1: The system shall new version writes `000NN-v01-slug.md`, original untouched.
- AC2: The system shall index points to latest, history files remain valid.
- AC3: The system shall `npm test` passes.
- AC4: The system shall docs updated: `spec_standard.md` only.

## Notes

- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00041-us-20-versioned-spec-files-for-creation |

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
