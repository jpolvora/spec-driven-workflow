---
id: null
slug: 00032-sdw-fixer-skill
title: "SDW Fixer Skill — Shared Findings Intake, Context-Aware Remediation, and Result Reporting"
source: local
status: draft
specDate: 2026-10-21
---

# Specification — SDW Fixer Skill — Shared Findings Intake, Context-Aware Remediation, and Result Reporting

## Description

Fix remediation in SDW is currently fragmented across three call sites with incompatible contracts. Step 4 verification retries surgical edits inline, Step 7 `sdw-code-review --fix` handles only deterministic hygiene (`debugger` removal), while Step 8 `sdw-ship-pr` delegates to an unset `reviewFixCommand` that reports `review_pending` when threads remain. Each path re-implements scoring, context lookup, sibling sweeping, verification, plus reporting with different shapes, inflating token spend through repeated diff reads plus duplicated prompts.

This specification introduces `sdw-fixer`, a shared standalone skill under `skills/sdw-fixer/` following the 3-tier progressive disclosure standard. The skill accepts a findings list (file path, line, rule identifier, evidence snippet, severity hint), scores the batch once, queries repository code for defect-class siblings, consults project memory for known traps, applies surgical edits, executes verification suite, then emits a structured result report consumed by orchestrator dispatch, local fix loops, plus ship convergence.

### Design Intent

Establish a single remediation authority so review, verification, plus delivery converge through one deterministic contract. Preserve lean context budgets through batch intake (one invocation per finding set), file-scoped evidence loading, filtered memory lookup by defect class, deterministic trivial fixes before agent reasoning. Keep reviewer versus fixer separation to avoid self-approval bias.

## Acceptance Criteria

- AC1: The system shall provide a standalone skill `sdw-fixer` under `skills/sdw-fixer/` following the 3-tier progressive disclosure standard.
- AC2: The system shall implement `sdw-fixer` with zero external runtime dependencies using Node.js 22 standard library only.
- AC3: When fixer receives a findings list, the system shall validate each entry for file path, rule identifier, plus evidence reference.
- AC4: When validation succeeds, the system shall score findings through deterministic severity rubric.
- AC5: When context gathering starts, the system shall search repository code for defect-class siblings through grep lookup.
- AC6: While project memory is enabled, the system shall inject matching memory hints into remediation plan.
- AC7: The system shall apply surgical edits limited to finding scope including verified sibling hits.
- AC8: When remediation completes, the system shall execute verification suite through configured test command.
- AC9: When verification passes, the system shall emit JSON result report with per-finding status.
- AC10: Where dry-run flag is set, the system shall simulate fixes without mutating tracked files.
- AC11: If verification fails, then the system shall halt with non-zero exit preserving partial report.
- AC12: When `sdw-orch` reaches review remediation, the system shall delegate remediation task to `sdw-fixer` through subagent brief.
- AC13: When `sdw-ship-pr` detects active threads, the system shall delegate remediation to `sdw-fixer` through CLI invocation.
- AC14: The system shall register `sdw-fixer` intents in `sdw-router` routing table.

## Notes

- Implementation layout:
  - `skills/sdw-fixer/SKILL.md`: Tier-1 skill definition with frontmatter, subcommands (`run`, `doctor`), compact batch cycle, Done when gates (≤ 120 lines).
  - `skills/sdw-fixer/references/fixer_protocol.md`: Tier-2 reference detailing intake schema, scoring rubric, proactive discovery order, surgical scope gate, resolution report fields.
  - `skills/sdw-fixer/scripts/sdw_fixer.cjs`: Tier-3 deterministic helper parsing findings JSON, running grep sibling sweep, applying trivial patches, invoking verification, writing reports.
- CLI contract:
  ```bash
  node skills/sdw-fixer/scripts/sdw_fixer.cjs run --findings <path> --report <path> [--dry-run] [--json]
  node skills/sdw-fixer/scripts/sdw_fixer.cjs doctor [--json]
  ```
- Intake schema (`findings.json`): array of `{ file, line, rule, evidence, severityHint }`. Project-relative paths only, no absolute paths, no `..` traversal.
- Discovery order: code grep first, filtered memory lookup second, same-PR context third. Record `sourcesConsulted` per finding. Unavailable backends record `consult-skipped`.
- Size gate: fix local surgical hits in this round; record `path + reason` for large refactor scope; never close class with unfixed surgical siblings left unrecorded.
- Report schema (`result.json`): `{ batchId, fixed: [{ file, line, defectClass }], skipped: [{ file, reason }], verification: { exitCode }, reportPath }`. Markdown companion mirrors JSON for human audit.
- Integration points:
  - `skills/sdw-orch/SKILL.md` Steps 4, 7 delegate remediation batches to `sdw-fixer` instead of inline loops.
  - `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` invokes `sdw_fixer.cjs run` as default `reviewFixCommand` implementation when config value is empty.
  - `skills/sdw-router/scripts/sdw_router.cjs` routes `fix`, `remediate`, `apply-fix` intents to `sdw-fixer`.
- Token efficiency strategy: one batch invocation per finding set; file-scoped reads (changed files plus named paths only); capped grep context (50 hits, 5 lines); memory query filtered by defect class (top 5); deterministic trivial patches without agent round-trip; shared prompt referenced by all callers.
- Naming: `sdw-fixer` preferred over `sdw-fix` (verb collision with `--fix` flags), `sdw-remediate` (excess length), `sdw-repair` (breakage connotation). Noun form matches `sdw-doctor`, `sdw-router`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing `gh` or `az` thread I/O | Provider contract remains sole remote thread authority |
| Autonomous merge after fix | Merge policy stays with `sdw-ship-pr --merge` fire-and-forget |
| Vector database memory backend | Memory stays grep-filtered local markdown plus existing vault contract |
| UI dashboard for fix batches | Dedicated to CLI plus state file representations |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Skill name | `sdw-fixer` | Noun form matches existing skills plus avoids flag collision | y |
| Batch granularity | One invocation per finding set | Minimizes repeated diff reads plus prompt reloads | y |
| Memory source | Filtered local plus vault lookup by defect class | Reuses existing memory contract without new infrastructure | y |
| Fix ceiling | 3 iterations per batch | Matches existing review fix ceiling plus prevents loops | y |
| Commit ownership | Caller commits fixer-touched files | Preserves scoped delivery commit guard in orchestrator | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized plus valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00032-sdw-fixer-skill.md` |
| Skill layout compliance | Skill architecture adheres to standard 3-tier structure | Validate planned paths under `skills/sdw-fixer/` |
| Router integration | Fixer intents resolve to `sdw-fixer` | Run `node skills/sdw-router/scripts/sdw_router.cjs route "apply fix batch"` |
| Node runtime compatibility | Environment provides Node.js 22 or higher | Run `node -v` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output confirming batch intake: `[sdw-fixer] Scoring N findings`.
- Memory hint injection logs showing defect-class filter plus hit count.
- Verification output from configured test command with exit code.
- JSON result report with `fixed`, `skipped`, `verification` fields written to requested report path.

### Negative & Failing Test Scenarios

- Malformed findings JSON with missing file path halts with exit code 1 without mutating tracked files.
- Verification failure after edits halts with non-zero exit preserving partial JSON report for operator inspection.
- Dry-run invocation produces simulated report with zero filesystem mutations verified through `git status --porcelain`.
- Empty findings list exits 0 with empty fixed set plus explicit `no-op` status.
