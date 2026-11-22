---
id: null
slug: 00078-sdw-harness-adapters-and-agent-agnostic-dispatch
title: "SDW Harness Adapters and Agent-Agnostic Subagent Dispatch"
source: local
status: draft
specDate: 2026-11-22
priority: high
---

# Specification — SDW Harness Adapters and Agent-Agnostic Subagent Dispatch

## Description

A core guarantee of the Spec-Driven Workflow (SDW) is harness and agent agnosticism: nothing in the product depends on a specific vendor, IDE, agent runtime, or proprietary API. In practice, however, developers and teams run SDW across multiple distinct agent environments, including Google Antigravity (AGY), Claude Code, OpenCode, Cursor, and standard terminal CLIs. 

While the core lifecycle (specifications in `.sdw/specs/`, run states in `.sdw/state/`, DAG planning, and deterministic `.cjs` scripts) is completely universal, each harness has unique execution mechanics for three key operations:
1. **Subagent and Task Dispatch**: Antigravity uses `invoke_subagent` and `swarm`; OpenCode uses `opencode run -m <model>`; Claude Code uses subagent markdown files (`agents/<name>.md`) or CLI flags; generic terminal workflows use isolated child processes.
2. **Model and Reasoning Effort Selection**: Different harnesses expose distinct flags or parameters for setting model tiers and reasoning effort (e.g. `--effort low` in `agy`, `--model` in `opencode`, `Model: "flash"` in `invoke_subagent`).
3. **User Confirmation Modality**: Antigravity exposes interactive multiple-choice tools (`ask_question`), terminal CLIs use interactive `readline` prompts, and headless CI pipelines require automated default-option selection.

This specification introduces a pluggable **Harness Adapter Layer** into SDW (`sdw-run` and `sdw-config`):
- **Adapter Contract**: A standard, zero-dependency interface defining `detectHarness()`, `formatSubagentDispatch()`, and `formatConfirmation()`.
- **Environment Detection (`adapter: "auto"`)**: Automatically detects the runtime harness by inspecting environment variables and process markers (e.g. `ANTIGRAVITY_APP`, `CLAUDE_CODE`, `OPENCODE_API_KEY`).
- **Flexible Model and Effort Mapping**: Normalizes model tiers (`inherit`, `flash_lite`, `flash`, `pro`) and effort levels (`low`, `medium`, `high`) across harnesses, allowing specifications and project configuration to dispatch subagents with the lowest necessary effort and token overhead.
- **Configurable Override**: Allows projects to configure `harness.adapter` explicitly in `.sdw/config.json` or override per run via CLI flags (`--harness <name>`).

### Design Intent

Preserve SDW's core agnosticism and file-based contracts while providing seamless, native integration with each major AI harness. By isolating vendor-specific dispatch envelopes and prompt conventions behind lightweight standard-library adapters, SDW allows the same specification and orchestration logic to execute effortlessly in Antigravity, Claude Code, OpenCode, or headless CI.

## Acceptance Criteria

- AC1: The system shall provide a configurable setting harness.adapter in .sdw/config.json supporting values auto, antigravity, claude-code, opencode, cursor, and generic, defaulting to auto.
- AC2: While harness.adapter is set to auto, the system shall detect the active agent harness by evaluating environment variables and process markers.
- AC3: When executing in an Antigravity environment, the system shall emit task dispatch envelopes containing invoke_subagent tool parameters including Model and Role.
- AC4: When executing in an OpenCode environment, the system shall emit task dispatch commands targeting the opencode CLI with designated model flags.
- AC5: When executing in a Claude Code environment, the system shall emit task dispatch instructions formatted for Claude Code subagent execution.
- AC6: The system shall support configurable subagent model and effort defaults under harness.subagent in .sdw/config.json.
- AC7: Where a specification defines model or effort in frontmatter, the system shall override harness configuration defaults for task dispatches within that specification.
- AC8: If an unrecognized harness adapter name is configured, then the system shall fall back to generic CLI dispatch and log an actionable warning.
- AC9: When user confirmation is required, the system shall select the confirmation modality corresponding to the active harness adapter.
- AC10: The system shall register harness configuration properties in .sdw/config.schema.json with sdw-config validation rules.
- AC11: The system shall update sdw-run and sdw-rules reference documentation to define the harness adapter interface and multi-harness dispatch protocol.
- AC12: The system shall provide automated unit tests verifying harness auto-detection, adapter envelope synthesis, frontmatter override precedence, and fallback handling.

## Notes

- Implementation uses Node.js 22 standard library (CommonJS `.cjs`) adhering to zero runtime dependencies and portable paths.
- Adapter interface design (`skills/sdw-run/scripts/harness_adapters.cjs`):
  ```javascript
  module.exports = {
    detectHarness(env),
    getAdapter(name),
    formatDispatch(adapterName, taskContext, options),
    formatConfirmation(adapterName, promptContext)
  };
  ```
- Environment detection indicators:
  - `antigravity`: presence of `ANTIGRAVITY_APP`, `AGY_SESSION_ID`, or `~/.gemini/antigravity`.
  - `claude-code`: presence of `CLAUDE_CODE` or `CLAUDE_PROJECT_DIR`.
  - `opencode`: presence of `OPENCODE_API_KEY` or `OPENCODE_RUN`.
  - `cursor`: presence of `CURSOR_PROJECT_DIR`.
  - `generic`: default fallback when no specific markers match.
- Configuration additions in `.sdw/config.schema.json`:
  ```json
  "harness": {
    "type": "object",
    "properties": {
      "adapter": { "type": "string", "enum": ["auto", "antigravity", "claude-code", "opencode", "cursor", "generic"], "default": "auto" },
      "subagent": {
        "type": "object",
        "properties": {
          "defaultModel": { "type": "string", "default": "flash" },
          "defaultEffort": { "type": "string", "enum": ["low", "medium", "high"], "default": "low" }
        }
      }
    }
  }
  ```

## Out of Scope

| Feature | Reason |
|---|---|
| Vendor-proprietary API network calls | SDW relies on CLI commands and standard files; direct proprietary REST APIs are not imported |
| Emulation of missing harness capabilities | When a harness lacks subagent support, fallback to sequential primary-tree commands |
| Automatic binary installation of third-party CLIs | Harness CLIs (agy, opencode, claude) must be provided by the host environment |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Default adapter resolution | `auto` | Seamless out-of-the-box developer experience without manual configuration | y |
| Default subagent model tier | `flash` | Minimizes token cost and execution latency for routine implementation tasks | y |
| Default reasoning effort | `low` | Prevents unnecessary thinking overhead on straightforward DAG tasks | y |
| Unrecognized harness handling | Fallback to `generic` CLI runner | Guarantees non-blocking execution across unknown or minimal environments | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Specification syntax | Valid YAML frontmatter and strict EARS acceptance criteria conformance | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring` |
| Zero runtime dependencies | Implemented purely with Node.js 22 built-ins | Code inspection |
| Backward compatibility | Existing projects without `harness` configuration default cleanly to `auto` | Automated unit test suite |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `sdw-run` Step 4 logs active adapter: `[Step 4: Dispatch] Harness adapter resolved: antigravity (detected via environment)`.
- Dispatch envelope output includes harness-tailored brief and command.
- Configuration validation passes with exit code 0 when `harness` object is present.

### Negative & Failing Test Scenarios

- Setting `harness.adapter: "invalid_adapter"` triggers warning and falls back to `generic` without crashing.
- Setting invalid effort tier (e.g. `defaultEffort: "extreme"`) fails configuration schema validation.
- Missing third-party CLI binary triggers an actionable error recommending installation or fallback mode.
