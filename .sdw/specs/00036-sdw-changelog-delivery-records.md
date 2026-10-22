---
id: null
slug: 00036-sdw-changelog-delivery-records
title: "SDW Changelog Delivery Records"
source: local
status: implemented
specDate: 2026-10-21
---
# Specification — SDW Changelog Delivery Records

## Description

Product delivery history for consumer repositories. This specification adds `sdw-changelog`, an append-only record of a completed task’s prompt, work, and result. It adapts the `ws-changelog` entry contract to SDW configuration and product guarantees. The changelog is project history, not agent memory, and it does not write to an external vault.

### Design Intent

Keep delivery history inspectable without changing delivery semantics. Changelog entries remain project data. The implementation resolves configuration and paths locally, preserves unrelated history exactly, and never calls host memory systems.

## Acceptance Criteria

- AC1: The system shall provide an `sdw-changelog` skill whose `SKILL.md` references `sdw-rules`.
- AC2: The system shall provide `scripts/append_changelog.cjs` accepting `--prompt`, `--done`, `--result`, and optional `--agent`, `--date`, `--root`, and `--json`.
- AC3: While `changelogEnabled` is false, the system shall exit `0` with `skipped: disabled` without creating or changing files.
- AC4: The system shall resolve the changelog path from `changelogFile` in `.sdw/config.json`.
- AC5: Where `changelogFile` is absent, the system shall default to `{projectRoot}/CHANGELOG.md`.
- AC6: When the resolved file or parent directory is missing, the system shall create it.
- AC7: If the file already contains an identical Prompt/Done/Result block, then the system shall skip the append and exit `0`.
- AC8: The system shall preserve every existing entry byte-identical when appending a new one.
- AC9: If a required argument is missing, then the system shall exit `1` with a usage message naming the missing flag.
- AC10: The system shall reject empty or whitespace-only required values.
- AC11: If the resolved path is absolute or escapes the project root, then the system shall exit `1` without writing.
- AC12: The system shall document `changelogEnabled` and `changelogFile` in `.sdw/config.schema.json`, `.sdw/config.json`, and `skills/sdw-config/references/config_spec.md`.

## Notes

- CLI contract:
  ```bash
  node skills/sdw-changelog/scripts/append_changelog.cjs --prompt "…" --done "…" --result "…" [--agent <id>] [--date "YYYY-MM-DD HH:MM"] [--root <path>] [--json]
  ```
- Configuration:
  - `changelogEnabled`: boolean, default `true`.
  - `changelogFile`: string, default `{projectRoot}/CHANGELOG.md`.
- Entry contract:
  ```markdown
  ### [YYYY-MM-DD HH:MM] Agent: {agent}
  - **Prompt**: …
  - **Done**: …
  - **Result**: …
  ```
- The new entry is inserted immediately below `# Changelog`; foreign entries remain below it and byte-identical.
- Omitted `--date` uses the current local timestamp. Explicit `--date` values support deterministic tests.
- The file is published through a temporary file followed by an atomic rename.
- No vault dual-write is implemented. Memory handling belongs to existing memory facilities, not this history record.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Vault or external memory writes | The changelog is project history, while agent memory is handled elsewhere. |
| Legacy workflow configuration paths | The product resolves configuration only through `.sdw/config.json`. |
| Cross-process file locking | Atomic replacement and byte-identical preservation cover the supported writer contract. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default history behavior | Enabled | A delivery record is normally worth preserving; consumers can disable it explicitly. | y |
| Timestamp source | Local time unless `--date` is supplied | Matches the existing entry template and keeps tests deterministic. | y |
| Project-root containment | Reject absolute or escaping paths | Prevents accidental writes outside the consumer repository. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00036-sdw-changelog-delivery-records.md` |
| Configuration contract | `changelogEnabled` and `changelogFile` have defaults and documentation | Run `node skills/sdw-config/scripts/sdw_config.cjs check`, inspect schema, configuration, and reference |
| Deterministic tests | One test file covers append, duplicate, disabled, missing-argument, whitespace, and path-escape behavior | Run `npm test` |
| Skill layout | Tier-1 skill, references, and deterministic script follow the 3-tier standard | Inspect `skills/sdw-changelog/` and run `node --check` on scripts |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Successful append prints the resolved changelog path.
- Duplicate input prints `skipped: duplicate-block`.
- Disabled configuration prints `skipped: disabled`.
- JSON mode prints a structured append or skip result.

### Negative & Failing Test Scenarios

- Missing `--done` exits `1` and names the missing flag.
- Re-running the same Prompt/Done/Result leaves the file byte-identical.
- Empty `--result` exits `1` before reading or changing the file.
- An absolute changelog path exits `1` without creating a file.
