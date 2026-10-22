---
id: null
slug: 00055-sdw-spec-list-by-priority
title: "SDW Spec Priority Ranking — Declared Priority Fields and the list-by-priority Subcommand"
source: local
status: draft
specDate: 2026-10-22
priority: high
value: "Ranks pending specifications for the next batch run instead of re-deriving the list by hand"
effort: M
---

# Specification — SDW Spec Priority Ranking

## Description

`sdw-spec` registers every specification in `index.specs.md` and `list` prints them in prefix order with status and validation health. The registry carries no notion of importance, so an operator choosing what to queue for a batch run must reconstruct the ranking by reading every pending specification, inspecting the target skills, and weighing delivery value by hand. That reconstruction happened outside the tool, was not reproducible, and left no artifact.

This specification adds a declared priority vocabulary to the specification frontmatter (`priority`, `value`, `effort`, `blockedBy`) plus a deterministic `list-by-priority` subcommand that ranks the pending backlog from those fields and observable signals (readiness, blocking, age). The command is read-only and advisory: it prints a ranked candidate table, a count line, an optional machine-readable object, and an optional surface-collision report for batch composition.

### Design Intent

Keep value judgement where it belongs, in the authoring path, and keep the CLI deterministic. The command never infers importance from diffs, velocity, or agent opinion; it orders rows from declared fields and file state, so the same inputs always produce the same bytes. `index.specs.md` stays a projection with its existing columns, and the four fields live only in frontmatter to avoid a second source of truth of the same class as the header/registry mismatch observed in delivered specifications 00050 and 00051.

## Acceptance Criteria

- AC1: The system shall provide the `sdw-spec list-by-priority [--root <path>] [--limit <n>] [--json] [--collisions]` subcommand.
- AC2: The system shall select the specifications whose registry status is `pending`.
- AC3: The system shall read `priority`, `value`, `effort`, and `blockedBy` from the frontmatter of every selected specification.
- AC4: Where `priority` is absent, the system shall treat the specification as `medium`.
- AC5: Where `effort` is absent, the system shall treat it as unset and order the row after `S`, `M`, and `L`.
- AC6: The system shall order rows by priority (high, medium, low), then unblocked before blocked, then readiness (ready-to-implement, draft, awaiting-approval), then effort (S, M, L, unset), then `specDate` ascending, then prefix ascending.
- AC7: While a `blockedBy` entry resolves to a specification whose registry status is `pending`, the system shall mark the row as blocked.
- AC8: If a `blockedBy` entry resolves to no specification, then the system shall exit `1` naming the blocked specification and the unresolved entry.
- AC9: If `priority` or `effort` carries a value outside its enum, then the system shall exit `1` naming the specification and the invalid value.
- AC10: The system shall print a ranked table carrying rank, prefix, priority, effort, acceptance-criteria count, readiness, blocked-by, and value, followed by a count line for pending, high, medium, low, and blocked totals.
- AC11: When `--limit <n>` is supplied, the system shall print at most the first `n` ranked rows while the count line keeps every pending specification.
- AC12: If `--limit` does not carry a positive integer, then the system shall exit `1` naming the invalid value.
- AC13: When `--json` is supplied, the system shall print an object carrying `counts` and `items` with rank, prefix, slug, title, priority, effort, acceptance-criteria count, readiness, registry status, blocked-by, blocked, value, and `specDate`, and shall omit every timestamp.
- AC14: When `--collisions` is supplied, the system shall print every pair of pending specifications that names the same `skills/` path, ordered by shared path count descending then prefix ascending.
- AC15: If no pending pair shares a named path, then the system shall print `No surface collisions among pending specifications.`
- AC16: The system shall produce byte-identical stdout across two consecutive runs over unchanged inputs.
- AC17: The system shall leave every specification file, `index.specs.md`, and run state unmodified.
- AC18: The authoring validator shall reject a `priority` or `effort` value outside its enum.
- AC19: The `sdw-spec` skill definition and the specification standard reference shall document the subcommand, the four frontmatter fields, their enums, and their defaults within the Tier-1 line budget.
- AC20: The pending specification set shall declare `priority`, `value`, and `effort` matching the backfill table in `## Notes`.

## Notes

- CLI contract:
  ```bash
  node skills/sdw-spec/scripts/sdw_spec.cjs list-by-priority [--root <path>] [--limit <n>] [--json] [--collisions]
  ```
- Declared frontmatter fields, appended after the six required keys:

  | Field | Enum | Default | Meaning |
  |-------|------|---------|---------|
  | `priority` | `high`, `medium`, `low` | `medium` | Declared delivery importance |
  | `value` | free text, one line | none | Why the specification matters, printed in the `VALUE` column |
  | `effort` | `S`, `M`, `L` | unset | Declared size, used only as a tie-break |
  | `blockedBy` | list of prefixes or slugs | empty | Specifications that must reach `completed` or `archived` first |

- Ordering keys, applied in this order: `priority` descending, blocked last, readiness (`ready-to-implement`, `draft`, `awaiting-approval`), `effort` (`S`, `M`, `L`, unset), `specDate` ascending, prefix ascending. The prefix key makes ties total, so the output never depends on directory iteration order.
- Collision detection: collect every `skills/...` token in the specification body (inline code, fenced blocks, and tables), trim trailing punctuation, and ignore tokens carrying `*`. Two pending specifications collide when they share at least one token.
- Registry read path: reuse `readIndex` in `skills/sdw-spec/scripts/spec_index.cjs`; the `pending` filter and the readiness column come from the registry row plus the header `status:` value.
- Target surfaces:
  - `skills/sdw-spec/scripts/sdw_spec.cjs`: new `list-by-priority` dispatch, `parseArgs` flags (`--limit`), and the ranking renderer.
  - `skills/sdw-spec/scripts/spec_index.cjs`: frontmatter accessor for the four declared fields, reusing `readIndex` and `parseFrontmatter`.
  - `skills/sdw-spec/scripts/validate_spec.cjs`: enum checks for `priority` and `effort`.
  - `skills/sdw-spec/SKILL.md`: subcommand line plus the declared-field summary, inside the 120-line Tier-1 budget (currently 88 lines).
  - `skills/sdw-spec/references/spec_standard.md`: section 1 currently states the frontmatter holds "exactly these 6 keys"; it must document the four optional fields, their enums, and their defaults.
  - `tests/sdw_spec.test.cjs`: ranking order, defaults, blocking, invalid enum, limit, JSON shape, collisions, determinism, and read-only assertions.
  - `.sdw/specs/*.md`: the backfill below, applied to every pending specification including this one.
- Backfill table (declared values; `blockedBy` stays empty, see `## Assumptions & Open Questions`):

  | Prefix | `priority` | `effort` | `value` |
  |--------|-----------|----------|---------|
  | 00038 | high | S | Adds `sdw-spec update` drift repair so a delivered specification keeps describing what shipped |
  | 00052 | high | S | Removes self-review bias: Step 7 verdicts come from a transcript-free reviewer session |
  | 00053 | high | M | Merges each batch item's pull request before the queue advances, ending stale-base conflicts |
  | 00054 | high | M | Writes a per-specification delivery report and flags overlapping or superseded specifications at ingestion |
  | 00055 | high | M | Ranks pending specifications for the next batch run instead of re-deriving the list by hand |
  | 00030 | high | L | Replaces the two-task DAG cap so large specifications stop shipping as two giant tasks |
  | 00043 | medium | S | Step-number progress output during orchestrated runs |
  | 00019 | medium | M | Run lock, revision guard, and crash-safe resume |
  | 00023 | medium | M | Activity, standup, and specification-explanation reporting |
  | 00033 | low | S | Diagnostic run mode with follow-up specification suggestions |
  | 00041 | low | M | Versioned specification files; needs a design decision against the registry model |
  | 00016 | low | M | SCM delivery intents; largely superseded by 00024, 00050, and 00051 |
  | 00021 | low | M | Append-only run telemetry |
  | 00022 | low | M | Harness diagnostics beyond `sdw-doctor`: pipeline simulation and Tier-1 budget audit |
  | 00017 | low | L | Acceptance-criteria ledger and traceability |
  | 00018 | low | L | Fresh-context verification and adversarial audit |

- Reference output after the backfill, over the pending set at authoring time (16 rows):
  `00038, 00052, 00053, 00054, 00055, 00030, 00043, 00019, 00023, 00033, 00041, 00016, 00021, 00022, 00017, 00018`.
- This specification declares `priority: high`, `value`, and `effort: M` in its own frontmatter as the first consumer of the new fields.
- The command writes nothing: no header transition, no registry rewrite, no run-state write. Lifecycle changes stay with `sdw-spec status`, `sync`, and `archive`.
- All helper scripts remain Node.js CommonJS (.cjs) using standard library modules only. No new runtime dependencies.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic queue composition or leverage-aware sequencing | The ranking is a candidate list; the operator still chooses batch order, for example landing a batch-mechanism specification before the rest of a queue |
| A mutator such as `sdw-spec priority --set` | Frontmatter is the single source; declared values change through the specification authoring path |
| A Priority column in `index.specs.md` | The registry is a projection; duplicating priority adds a drift surface of the same class as the delivered-specification header mismatch found today |
| Priority inference from diffs, velocity, or agent judgement | No deterministic signal exists; declared fields keep the ranking auditable and reproducible |
| Selection or filtering consumed by `sdw-orch` or `sdw-batch` | Queue selection stays an explicit operator decision per `sdw-rules` |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Priority is declared during authoring | `priority` defaults to `medium` when absent | Keeps the command usable before every specification is backfilled while keeping the ranking auditable | y |
| Ranking is advisory | Batch order stays an operator decision | Leverage, such as landing auto-merge before the rest of a queue, is not a per-specification field | y |
| Collision signal | `skills/` path tokens found in the specification body | Cheap and deterministic; no semantic file inference from prose | y |
| Empty `blockedBy` in the initial backfill | No pending specification has a true blocker | Sequencing constraints such as 00038 against 00041 are ordering advice, not blockers | y |
| Registry columns stay unchanged | Declared fields live only in frontmatter | Avoids a second source of truth for the same fact | y |
| Ranking stability matters more than freshness | No timestamp appears in table or JSON output | Determinism is testable; run time is already visible in run state | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|--------------|---------------------|
| EARS syntax | All 20 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00055-sdw-spec-list-by-priority.md` |
| Scope enclosure | One read-only ranking command plus its declared fields and backfill | Inspect `## Description` plus `## Out of Scope` |
| Target inventory | CLI, registry accessor, validator, skill definition, standard reference, tests, and pending specifications | Inspect `## Notes` target list |
| Baseline suite | Existing test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `list-by-priority` prints the reference order recorded in `## Notes` for the backfilled pending set.
- The count line totals equal the registry pending count, including rows hidden by `--limit`.
- `--json` parses and carries no timestamp field.
- `--collisions` reports the 00052 and 00054 pair through `skills/sdw-orch/references/orchestrator_protocol.md`.
- Authoring-mode validation of this specification exits `0` with `PASS`.

### Negative & Failing Test Scenarios

- Missing priority: a pending specification without `priority` ranks as `medium` and never leads the high group.
- Invalid enum: `priority: urgent` makes the command exit `1` naming the specification and the value.
- Unresolved blocker: `blockedBy: ["00999"]` exits `1` naming the entry instead of silently ignoring it.
- Blocked ranking: a high-priority specification blocked by a pending specification ranks after every unblocked high-priority specification.
- Collision false positive: a path mentioned in prose without a `skills/` token creates no pair.
- Write attempt: no specification file, registry row, or run-state byte changes after a run.
