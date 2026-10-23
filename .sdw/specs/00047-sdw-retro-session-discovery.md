---
id: null
slug: 00047-sdw-retro-session-discovery
title: "Host-Aware Session Transcript Discovery and Context Fallback for Retrospectives"
source: local
status: implemented
specDate: 2026-10-21
---
# Specification — Host-Aware Session Transcript Discovery and Context Fallback for Retrospectives

## Description

### Problem

Spec 00045 gives the retrospective a `--transcript` input, but nothing tells the agent where the current session transcript lives. That path is host-dependent and unknowable to a script:

- DeepSeek Harness stores `%DSH_HOME%\sessions\--<project>--\session-<DSH_SESSION_ID>\session.v4.jsonl.zstd`, compressed.
- Claude Code stores `~/.claude/projects/<slug>/<sessionId>.jsonl`.
- Codex stores `~/.codex/sessions/<date>/rollout-*.jsonl`.

A static lookup in `retro.cjs` would rot, would ship host knowledge into the product, and would still fail under a harness nobody anticipated. Yet without the transcript the retrospective cannot see the command slip that motivated spec 00045 in the first place.

### Proposal

Split the work by capability:

1. Model instructions in the skill: `sdw-retro` tells the agent how to find the current session transcript from host facts (environment variables, known layouts), and requires the path to be passed with `--transcript`.
2. Decompression handling: `retro.cjs` decodes zstd-compressed transcripts in memory with the standard library, including files made of many concatenated zstd frames, so the agent passes the path it found without shelling out to a codec.
3. Context fallback: when no supported transcript exists or it cannot be decoded, the agent writes the current session messages (one role-prefixed line each) to `.sdw/state/retro-session-{runId}.md` and passes that file.
4. Provenance: the report states which mode produced the transcript input, so a later reader knows whether it came from the host or from the agent's own context.

`retro.cjs` stays host-agnostic: it knows zstd framing, not one vendor's directory layout.

### Scope

- `skills/sdw-retro/SKILL.md`: the discovery procedure, the decompression rule, the fallback, and the provenance flag.
- `skills/sdw-retro/references/session_discovery.md` (new): per-host layouts, environment facts, and the exact commands to check them.
- `skills/sdw-retro/references/retro_protocol.md`: transcript provenance in the input section.
- `skills/sdw-retro/scripts/retro.cjs`: zstd frame decoding, `--transcript-mode <host|captured>` recorded in the report, non-text transcript produces `transcript_unreadable`.
- Tests: `tests/sdw_retro.test.cjs`.

## Acceptance Criteria

- AC1: The `sdw-retro` skill shall instruct the agent to locate the current session transcript from host facts, naming the DeepSeek Harness, Claude Code, and Codex layouts, and to pass the resolved path with `--transcript`.
- AC2: When a named transcript begins with a zstd frame, the retrospective shall decode every concatenated frame with the Node.js standard library before scanning, and shall report the decoded line count.
- AC3: When no supported transcript is found or it cannot be decoded, the skill shall require the agent to write the current session messages to `.sdw/state/retro-session-{runId}.md`, one role-prefixed line per message, and to pass that path with `--transcript`.
- AC4: When `--transcript-mode` is supplied, the retrospective shall record that mode in the report inputs, and shall default it to `host` when omitted.
- AC5: When a transcript file is neither decodable UTF-8 text nor a zstd frame, the retrospective shall report `transcript_unreadable` and exit `0`.
- AC6: The report shall state the transcript mode next to every transcript input, so a reader can tell a host transcript from an agent-captured one.
- AC7: The system shall document the discovery procedure, the fallback, and the mode field in the `sdw-retro` skill and its protocol reference.

## Verification

- [ ] Skill text names three host layouts and the environment facts each one needs.
- [ ] A zstd file with several concatenated frames decodes fully, not just the first frame.
- [ ] Fallback file path is `.sdw/state/retro-session-{runId}.md` and the format is one role-prefixed line per message.
- [ ] `--transcript-mode captured` appears in the report inputs and in the Markdown.
- [ ] A binary transcript reports `transcript_unreadable` with exit `0`.
- [ ] `npm test` passes; `doctor` passes.

## Notes

- The product ships no host paths: the reference document describes layouts generically with environment-variable placeholders, and local paths are resolved at run time by the agent.
- zstd decoding uses `zlib.zstdDecompressSync` (Node 22.15 or newer). Measured on this machine: a DeepSeek Harness session file holds 3745 concatenated frames, and a single call decodes only the first, so the decoder must iterate frames.
- The context fallback is the agent's own conversation, not a harness log; it is labeled `captured` so it is never mistaken for the host's record.
- Node.js CommonJS, standard library only.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Parsing host-specific JSON schemas | The scanner is line-based; the agent normalizes via the fallback when needed |
| Automatic discovery inside `retro.cjs` | Host knowledge belongs to the instructions, not the product script |
| Uploading transcripts anywhere | Local-only; nothing leaves the machine |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default `--transcript-mode` | `host` | Most transcripts come from the host file when discovery succeeds | y |
| Fallback location | `.sdw/state/retro-session-{runId}.md` | Same state tree as run artifacts, already excluded from delivery commits | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `validate_spec.cjs --mode=authoring` |
| Upstream contract | `--transcript` input and `transcript_unreadable` signal delivered by spec 00045 | Inspect `retro.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Report inputs carry `path (mode, N lines)`.
- `transcript_unreadable` names the path and the reason (missing or non-text).

### Negative & Failing Test Scenarios

- Host transcript present but compressed and no decoder available: fallback to captured context.
- Captured context empty: report proceeds without transcript inputs and says so.
