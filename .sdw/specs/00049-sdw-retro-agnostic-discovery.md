---
id: "49"
slug: 00049-sdw-retro-agnostic-discovery
title: "Agent-Agnostic Transcript Discovery — Environment Facts and Bounded Search"
source: local
status: ready-to-implement
specDate: 2026-10-21
---

# Specification — Agent-Agnostic Transcript Discovery — Environment Facts and Bounded Search

## Description

### Problem

Spec 00047 taught the retrospective to find the current session transcript by naming three hosts: DeepSeek Harness, Claude Code, and Codex. That violates the product rule that SDW depends on no specific agent, IDE, or harness, and it already fails for OpenCode, Antigravity, Cursor, and anything not in the list.

Two concrete symptoms:

- `skills/sdw-retro/references/session_discovery.md` is a vendor catalogue: `DSH_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`. Adding a fourth tool means editing a shipped document, and it still never covers the operator's actual tool.
- A host that ships no such variable gets the capture fallback even when its transcript is plainly on disk under a home or data directory it does export.

The product needs one procedure that works from facts every host can provide, bounded so it stays cheap.

### Proposal

1. A deterministic finder, `skills/sdw-retro/scripts/find_session_transcript.cjs`, with no vendor knowledge:
   - file-valued environment facts: any variable whose value is an existing file with a transcript-shaped extension;
   - session-identifier facts: any variable whose name carries a session or conversation identifier, used to match file names under candidate roots;
   - candidate roots: directories named by home, data, config, or profile environment variables that exist on disk.
2. Bounds: depth, entries scanned, and wall-clock budget, all reported, so the finder is cheap on a large home directory.
3. Instructions: run the finder first, pass what it returns with `--transcript`, and use the captured-context fallback only when it returns nothing.
4. Vendor neutrality is a shipped guarantee: no third-party agent, IDE, or harness name appears in the skill, its references, or its scripts.

### Scope

- `skills/sdw-retro/scripts/find_session_transcript.cjs` (new).
- `skills/sdw-retro/references/session_discovery.md`: rewritten as the generic procedure.
- `skills/sdw-retro/SKILL.md`, `skills/sdw-retro/references/retro_protocol.md`: vendor names removed, finder step added.
- Tests: `tests/sdw_retro_discovery.test.cjs`.

## Acceptance Criteria

- AC1: The `sdw-retro` skill, its references, and its scripts shall name no third-party agent, IDE, or harness.
- AC2: When no transcript is configured, the skill shall instruct the agent to run `find_session_transcript.cjs` before any capture fallback.
- AC3: The finder shall derive candidates only from environment facts and filesystem conventions: file-valued variables, session-identifier-valued variables, and existing directories named by home, data, config, or profile variables.
- AC4: The finder shall bound its work with a maximum entry count, a maximum directory depth, and a wall-clock budget, and shall report the entries scanned and the elapsed time.
- AC5: The finder shall exit `0` both when it returns a candidate and when it returns none, printing a machine-readable result either way.
- AC6: When the finder returns a candidate path, the skill shall require passing it with `--transcript` and mode `host`; when it returns none, the skill shall require the captured-context fallback with mode `captured`.
- AC7: The finder shall print no transcript content and shall not create, modify, or copy any file.

## Verification

- [ ] `grep -ri "dsh\|claude\|codex\|cursor\|antigravity\|opencode" skills/sdw-retro` returns nothing.
- [ ] A fake environment with a file-valued session variable resolves that file.
- [ ] A fake environment with a session-id variable and a matching file under a data root resolves the match.
- [ ] Nothing found: exit `0`, `found: false`, bounds reported.
- [ ] A home directory with many entries stops at the entry bound within the time budget.
- [ ] Finder output contains no line of transcript text.
- [ ] `npm test` passes; `doctor` passes.

## Notes

- The finder never reads transcript bodies; it stats files and sniffs the first bytes only to reject non-text binaries early.
- Vendor names may appear in this specification as the reason for the change; they must not appear in shipped skill content.
- Node.js CommonJS, standard library only.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic discovery inside `retro.cjs` | The finder is a separate deterministic step the agent runs and can override |
| Indexing or caching transcript locations | Bounded on-demand search is cheaper than maintained state |
| Uploading or copying transcripts | Local-only, read-only input |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Entry bound | 4000 entries, depth 4, 2 seconds | Covers ordinary session layouts without touching a whole home directory | y |
| Recency filter | Files modified within 24 hours | Session files of a live run are recent; older ones are noise | y |
| Extension set | `.jsonl .json .log .txt .md .zst .zstd` | Covers plain and compressed session formats | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `validate_spec.cjs --mode=authoring` |
| Reproduction | Current vendor catalogue measured in `skills/sdw-retro` | `grep` over the skill |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Finder JSON: `found`, `path`, `source`, `entriesScanned`, `elapsedMs`, `roots`.
- The skill requires reporting the finder result (found or not) when it reports inputs.

### Negative & Failing Test Scenarios

- Variable value points to a directory: skipped, not followed as a file.
- Session id appears in thousands of unrelated names: entry bound stops the scan.
- Permission-denied directory: skipped, scan continues.
