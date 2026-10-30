---
id: null
slug: 00072-specification-priority-ordering-validate
title: "Specification priority ordering: validated priority frontmatter, registry column, and deterministic list ordering"
source: local
status: draft
specDate: 2026-10-29
priority: high
---

# Specification — Specification priority ordering

## Description

Priority is currently informal metadata. Four specifications (`00059`, `00063`, `00069`, `00070`) carry `priority: high` in their frontmatter, but nothing reads it: `validate_spec.cjs` checks only the six required keys and ignores unknown ones, the registry table has no priority column, `registerSpec` and `sync` never project the value, and `list` prints prefix, slug, status, health, and title with no ordering signal. A maintainer asking "which specification is next?" must open the files and compare them by hand.

This specification makes priority a first-class, validated field and exposes it as a deterministic order. It covers four surfaces: frontmatter validation, registry projection, `list` ordering, and the vocabulary that currently denies the product has any priority model. The registry keeps its lifecycle meaning: priority ranks authored work, it does not schedule or authorize execution, and an explicit maintainer order still wins.

### Design Intent

The registry is SDW's backlog. A backlog that cannot state what comes first needs a separate note or a human memory, and both drift. A small closed enum stored in the spec file is enough: the spec remains the single source of truth, `sync` derives the registry column, and `list` renders the order on request without changing what existing callers see. Defaulting absent values to `medium` keeps every existing specification valid and gives a stable tie-break by numeric prefix.

### Prior Work Sweep

| Surface | Current behavior | Gap |
|---|---|---|
| `skills/sdw-spec/scripts/validate_spec.cjs` | Requires `id`, `slug`, `title`, `source`, `status`, `specDate`; extra keys pass unchecked | `priority` has no enum or default |
| `skills/sdw-spec/scripts/spec_index.cjs` | `readIndex` and `writeIndex` use a fixed 8-column table; `registerSpec` writes the known metadata | No priority field or column |
| `skills/sdw-spec/scripts/spec_sync.cjs` | Reconciles status, validation, and metadata; discovers untracked files | Priority is never read from frontmatter |
| `skills/sdw-spec/scripts/sdw_spec.cjs` | `list` prints `PREFIX`, `SLUG`, `STATUS`, `HEALTH`, `TITLE` in registry order | No ordering option or rank |
| `GLOSSARY.md` | Backlog row and redefinition table state SDW has no priority model | Contradicts the field this change introduces |
| `00059`, `00063`, `00069`, `00070` | Carry `priority: high` already | Must keep validating and gain a registry value without edits |

## Acceptance Criteria

- AC1: The sdw-spec validator shall accept an optional `priority` frontmatter key whose value is `high`, `medium`, or `low`.
- AC2: Where `priority` is absent from a specification frontmatter, the system shall treat that specification as priority `medium`.
- AC3: If `priority` carries an unknown value, then the system shall reject validation with a message that names `high`, `medium`, and `low`.
- AC4: When `sync` reconciles the registry, the system shall write a Priority value for every specification row.
- AC5: The system shall project the frontmatter priority through `registerSpec` into the new registry Priority column.
- AC6: Where priority ordering is requested, the system shall order non-archived rows `high` first, then `medium`, then `low`.
- AC7: When two non-archived specifications share a priority, the system shall order them by numeric prefix ascending.
- AC8: Where priority ordering is requested, the system shall print a rank that states each row's implement position.
- AC9: Where priority ordering is not requested, the system shall keep the existing `list` columns and order unchanged.
- AC10: When priority ordering is applied, the system shall place archived specifications after every non-archived row regardless of priority.
- AC11: The system shall replace the GLOSSARY statement that SDW has no priority model with the definition of the validated priority field.
- AC12: The system shall keep the GLOSSARY Backlog and Registry status rows truthful about priority.
- AC13: The system shall validate specifications 00059, 00063, 00069, and 00070 with their existing `priority: high` frontmatter unchanged.
- AC14: When `sync` runs, the system shall record priority `high` for specifications 00059, 00063, 00069, and 00070 without manual file edits.
- AC15: The system shall document that an explicit maintainer implementation order overrides the computed priority order.

## Notes

- Schema: `priority` is optional, closed to `high | medium | low`, and defaults to `medium` when absent. The default applies at read time in `validate_spec.cjs`, `spec_index.cjs`, and `spec_sync.cjs`, so no migration rewrites existing files.
- Registry shape: add a `Priority` column to the owned specifications table in `index.specs.md`. `readIndex` must resolve columns by header name instead of fixed cell positions, and `writeIndex` must emit the column for every row. Existing rows read as `medium` until the next `sync`.
- Projection: `registerSpec` accepts and stores `priority`; `syncIndex` reads `priority` from each latest frontmatter, defaults it to `medium`, and updates the row. `scanSpecsDir` supplies the same default for untracked files.
- Ordering: `list` gains an explicit opt-in, `--order=priority`. It sorts `high`, `medium`, `low`, then numeric prefix ascending, then places archived rows last. The rank is printed only in this mode.
- Backward compatibility: without `--order=priority`, both the text table and the JSON payload keep today's columns, field names, and order.
- Files: `skills/sdw-spec/scripts/validate_spec.cjs`, `skills/sdw-spec/scripts/spec_index.cjs`, `skills/sdw-spec/scripts/spec_sync.cjs`, `skills/sdw-spec/scripts/sdw_spec.cjs`, `skills/sdw-spec/references/spec_standard.md`, `GLOSSARY.md`, and the matching tests under `tests/`.
- Documentation: `spec_standard.md` § 1 gains `priority` as the one optional frontmatter key; § 5 keeps status and priority distinct.
- All scripts remain Node.js CommonJS (`.cjs`) with standard-library modules only.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Sprint, capacity, or scheduling semantics | Priority is a rank over authored specs, not a delivery plan |
| Automatic selection or execution of the highest-priority spec | `sdw-run` keeps requiring an explicit implementation order |
| Recomputing or rewriting historical priority values | The four existing `high` values stay untouched |
| A configurable priority weight or additional priority levels | The closed three-value enum covers the need |
| Changing registry lifecycle statuses or the spec header status machine | Priority is orthogonal to both |
| A dashboard or telemetry for priority | The CLI output is the observation surface |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Opt-in flag name | `--order=priority` | Names the requested order and leaves the default path untouched | y |
| Registry column position | After `Status` | Keeps identity columns first and lifecycle metadata adjacent | y |
| Absent priority | `medium` | Existing specs keep validating and sort between high and low | y |
| Tie-break | Numeric prefix ascending | The prefix already orders specs and is stable | y |
| Archived rows | Last, regardless of priority | Archived work is retired and must never look next | y |
| Explicit maintainer order | Documented precedence, not stored | The order arrives as a prompt or run instruction, not registry data | y |
| Four existing specs | No manual edits | Their files already carry `priority: high` | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Baseline validator | The current suite and validator pass before the change | `node skills/sdw-spec/scripts/sdw_spec.cjs validate .sdw/specs/00059-sdw-ship-pr-review-thread-fidelity.md --mode=authoring` |
| Registry format understood | `readIndex`, `writeIndex`, `registerSpec`, and `syncIndex` column handling read | Inspect `skills/sdw-spec/scripts/spec_index.cjs` and `spec_sync.cjs` |
| Four priority specs confirmed | `00059`, `00063`, `00069`, and `00070` carry `priority: high` | Read their frontmatter |
| Default output captured | A `list` snapshot exists before adding `--order=priority` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Glossary rows located | The Backlog row, Registry status row, and redefinition table entry are identified | Read `GLOSSARY.md` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node skills/sdw-spec/scripts/sdw_spec.cjs list --order=priority` prints a `RANK` column and lists `high` rows before `medium` and `low`.
- `index.specs.md` shows a `Priority` column with a value on every row after `sync`.
- `validate_spec.cjs` accepts a spec without `priority` and reports it as valid.
- The text table and JSON payload of a plain `list` match the pre-change snapshot.

### Negative & Failing Test Scenarios

- A spec with `priority: urgent` fails validation and the error names `high`, `medium`, and `low`.
- A spec with no `priority` key validates and appears as `medium` in the registry.
- An archived spec with `priority: high` appears after a pending `low` row in priority order.
- A plain `list` after the change prints the same columns in the same order as the captured baseline.
- A registry row without a priority cell parses as `medium` instead of shifting the following columns.
