---
id: null
slug: 00034-sdw-memory-skill
title: "SDW Memory Skill — Central Knowledge Wrapper with Pluggable Store Backends"
source: local
status: draft
specDate: 2026-10-21
---

# Specification — SDW Memory Skill — Central Knowledge Wrapper with Pluggable Store Backends

## Description

Product knowledge (traps, gaps, patterns, errors) was read and written through scattered paths: `sdw-fixer` grepped `.sdw/traps.md` directly plus shelled out to the `memo` vault, `sdw-rules log-trap` appended rows with an optional sync hook, while no single contract defined entry shape, backend routing, or deduplication.

This specification introduces `sdw-memory`, the single central wrapper for all product knowledge operations. The skill exposes `query`, `record`, `consolidate`, `classify`, plus `doctor` subcommands over a unified entry model (`trap|gap|pattern|error`) and delegates to pluggable store backends implemented as separated files under `skills/sdw-memory/scripts/backends/` (contract `base.cjs`): native `ws-memo` vault support plus local `.sdw/memory/traps.md` file fallback plus read-only memory files. `sdw-rules` gains a dependency on `sdw-memory` plus a MEMORY-FIRST rule mandatory for every skill. This spec supersedes plus replaces `00007-sdw-memory-skill`.

### Design Intent

Establish one auditable knowledge authority so implementing, fixing, reviewing, plus orchestrating flows share identical query semantics and write paths. Keep backends pluggable behind a stable CLI plus programmatic contract, default to the `ws-memo` vault where reachable, degrade to the local traps file offline, never auto-delete vault records, never store secrets.

## Acceptance Criteria

- AC1: The system shall provide a standalone skill `sdw-memory` under `skills/sdw-memory/` following the 3-tier progressive disclosure standard.
- AC2: The system shall implement `sdw-memory` with zero external runtime dependencies using Node.js 22 standard library only.
- AC3: When memory query is invoked, the system shall search enabled backends for related entries capped at the requested limit.
- AC4: When memory record is invoked, the system shall validate kind, title, avoid, plus action before persisting.
- AC5: When an entry with an existing slug is recorded, the system shall refuse duplication with an explicit reason.
- AC6: While the `ws-memo` backend is reachable, the system shall route writes through the vault plus tag entries with the original kind.
- AC7: Where the vault is unreachable, the system shall fall back to the local traps file without failing the call.
- AC8: When memory consolidate is invoked, the system shall merge duplicate local rows while reporting vault duplicates without deleting them.
- AC9: The system shall classify free text into trap, gap, pattern, or error through a deterministic keyword rubric.
- AC10: If a memory payload contains secret material, then the system shall reject the write before any backend mutation.
- AC11: The system shall declare an `sdw-memory` dependency inside `sdw-rules` plus enforce a MEMORY-FIRST rule for every skill.
- AC12: The system shall register `sdw-memory` intents in `sdw-router` routing plus `sdw-doctor` expected skills.
- AC13: The system shall implement each backend as a separated file implementing the backend contract under `skills/sdw-memory/scripts/backends/`.
- AC14: The system shall select enabled backends per user from `.sdw/config.json memory.backends` with missing keys defaulting to enabled.
- AC15: When no backend is enabled or reachable, the system shall complete queries with empty hints plus records with a no-op report instead of failing.

## Notes

- Implementation layout:
  - `skills/sdw-memory/SKILL.md`: Tier-1 skill definition with frontmatter, subcommands (`query`, `record`, `consolidate`, `classify`, `doctor`), compact batch cycle (≤ 120 lines).
  - `skills/sdw-memory/references/memory_protocol.md`: Tier-2 reference detailing unified entry model, backend routing, kind mapping, discovery order, report schemas.
  - `skills/sdw-memory/scripts/sdw_memory.cjs`: Tier-3 deterministic helper parsing CLI subcommands, routing to separated backend implementations, validating entries, deduplicating writes, merging local duplicates.
- CLI contract:
  ```bash
  node skills/sdw-memory/scripts/sdw_memory.cjs query "<text>" [--kind trap|gap|pattern|error] [--backend auto|ws-memo|traps|files|all] [--limit N] [--json]
  node skills/sdw-memory/scripts/sdw_memory.cjs record --kind <kind> --title "..." --avoid "..." --action "..." [--slug S] [--tags a,b] [--paths f] [--json]
  node skills/sdw-memory/scripts/sdw_memory.cjs consolidate [--backend traps] [--dry-run] [--json]
  node skills/sdw-memory/scripts/sdw_memory.cjs classify "<text>" [--json]
  node skills/sdw-memory/scripts/sdw_memory.cjs doctor [--json]
  ```
- Backend routing: `--backend auto` uses the vault when the `memo` CLI is reachable (resolved without a shell, including Windows npm shims; `SDW_MEMORY_NO_MEMO=1` opts out), otherwise the local file; explicit backends pin the set (`all` writes vault plus traps on record, `files` is read-only); `.sdw/config.json memory.backends` selects enabled backends per user with missing keys defaulting to enabled. When no backend is enabled or reachable, queries return empty hints plus records report `noop: true` instead of failing, so callers never block.
- Kind mapping: all four SDW kinds persist to memo kind `trap` with an `sdw-kind:<kind>` tag; query searches memo kind `trap`.
- Programmatic hook: `recordTrap({ slug, title, avoid, action, layer, root, ... })` serves the `sdw-rules log-trap` integration without double-writing the local file.
- Supersession: `00007-sdw-memory-skill` is removed; its `MEMORY.md`-file design is replaced by the vault-native wrapper defined here.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Vector database backends | Vault FTS plus local grep satisfy deterministic lookup |
| Automatic vault deletion or TTL | Lifecycle stays with `memo gc` plus `forget` under operator control |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Native backend | `ws-memo` vault | Vault already backs session memory plus FTS search | y |
| Local fallback | `.sdw/memory/traps.md` table | Existing project trap log stays readable offline | y |
| Backend layout | Separated files under `skills/sdw-memory/scripts/backends/` | Contract plus per-backend files keep routing free of store logic | y |
| Record default | Vault when reachable, file otherwise | Single source of truth online, portable offline | y |
| Preserved spec | None; 00007 removed | New wrapper contract replaces the file-centric design | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized plus valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00034-sdw-memory-skill.md` |
| Skill layout compliance | Skill architecture adheres to standard 3-tier structure | Validate planned paths under `skills/sdw-memory/` |
| Router integration | Memory intents resolve to `sdw-memory` | Run `node skills/sdw-router/scripts/sdw_router.cjs route "query memory for traps"` |
| Node runtime compatibility | Environment provides Node.js 22 or higher | Run `node -v` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output confirming backend selection: `[sdw-memory]`, vault versus traps paths.
- Query output listing merged hints with per-backend consult status.
- Record output naming the recording backend plus slug, or the refusal reason.
- Consolidate output reporting removed versus kept counts.

### Negative & Failing Test Scenarios

- Record with unknown kind halts with exit code 1 plus zero backend mutations.
- Duplicate slug record is refused with an explicit already-registered reason.
- Vault unreachable falls back to the local file without failing the call.
- Fully disabled or unreachable backends complete queries with empty hints plus records with a no-op report instead of failing.
- Secret-bearing payload is rejected before any backend mutation.
