---
id: null
slug: 007-sdw-memory-skill
title: "SDW Memory Skill & Anti-Regression Project Memory"
source: local
specDate: 2026-10-19
---

# Specification — SDW Memory Skill & Anti-Regression Project Memory

## Description

The Spec-Driven Workflow (SDW) framework orchestrates autonomous AI subagents to implement features according to rigorous engineering specifications. When AI agents execute subagent tasks in clean, bounded context windows, they often lack awareness of repository-specific idiosyncrasies, subtle environment quirks, and recurring framework traps. As a consequence, subagents frequently repeat the same mistakes, stumble upon known edge cases, or hallucinate solutions incompatible with the codebase.

This specification introduces an optional, toggleable Anti-Regression Project Memory system centered on a structured, lightweight `.sdw/MEMORY.md` file. The feature is encapsulated within a dedicated `sdw-memory` skill (`skills/sdw-memory/`), which provides standardized entry authoring, deterministic grep-friendly querying, and periodic semantic consolidation.

When enabled in `.sdw/config.json` via `memory.enabled: true`, the orchestrator (`sdw-orch`) integrates project memory into its execution lifecycle:
1. **Pre-Dispatch Query & Hint Injection:** Prior to dispatching each implementation subagent, `sdw-orch` queries `MEMORY.md` for known traps, constraints, and patterns relevant to the specific task and touched files. Relevant hints are injected into a fenced `<project_memory_hints>` block in the subagent's task prompt.
2. **Subagent Traps Reporting Protocol:** Dispatched subagents are instructed to identify unexpected errors, tool quirks, and environmental traps encountered during execution, reporting them in their structured completion output.
3. **Orchestrator Feedback Loop & Propagation:** Upon receiving subagent output, `sdw-orch` parses newly reported traps and records them into `MEMORY.md` via `sdw_memory.cjs record`. Newly recorded entries become immediately available in the active session, allowing subsequent subagent dispatches within the same DAG to benefit from the newly captured knowledge.
4. **Maintenance & Compaction:** To prevent unbounded file growth and linear context inflation, the `sdw-memory consolidate` command parses all entries, detects duplicate or overlapping learnings, merges redundant records into unified canonical items, and rewrites a compacted `MEMORY.md` file.

### Design Intent

Implements a deterministic, zero-dependency project memory mechanism that solves the recurring agent hallucination problem without introducing complex external infrastructure. By storing memory records in a simple, human-readable, grep-friendly markdown format (`MEMORY.md`, defaulting to `.sdw/MEMORY.md`) and leveraging standard library Node.js 22 CommonJS utilities, the architecture maintains absolute predictability, high execution speed, and version-controlled transparency.

Subagent context budgets are strictly protected: rather than injecting an entire historical memory log into every subagent prompt, the orchestrator performs targeted keyword and tag filtering to provide only the minimal slice of relevant hints. The consolidation engine ensures that knowledge accumulates quality over time rather than unbounded token volume.

## Acceptance Criteria

- AC1: The system shall provide an optional project memory feature toggled via the `memory.enabled` configuration property with a default path of `{projectRoot}/.sdw/MEMORY.md`.
- AC2: The system shall encapsulate memory querying, recording, and consolidation within the `skills/sdw-memory` skill following the three-tier architecture standard.
- AC3: The system shall enforce a standardized entry contract for `MEMORY.md` containing category type, metadata tags, issue description, and prevention solution.
- AC4: When loaded by an agent, the system shall output `"sdw-memory loaded."` as the canonical announcement header in `skills/sdw-memory/SKILL.md`.
- AC5: When querying memory for a task, the system shall filter entries by keywords and tags using deterministic line-matching search.
- AC6: While memory is enabled, the orchestrator shall query relevant memory entries and inject contextual hints into the subagent dispatch prompt before task execution.
- AC7: While a subagent executes a task, the system shall instruct the subagent to report newly discovered errors, environmental traps, and recurring gaps in its output.
- AC8: When a subagent returns output containing new traps or learnings, the orchestrator shall record the validated entries into `MEMORY.md` via `sdw_memory.cjs record`.
- AC9: While subsequent tasks in an orchestrator run remain pending, the orchestrator shall make newly recorded memory entries immediately available for subsequent subagent dispatches.
- AC10: When `sdw-memory consolidate` executes, the system shall analyze all entries in `MEMORY.md`, merge redundant records, and rewrite the compacted file without losing distinct learnings.
- AC11: Where `memory.enabled` is set to false in `.sdw/config.json`, the orchestrator shall bypass all memory query and recording steps without throwing errors.
- AC12: If `MEMORY.md` contains malformed entry syntax during query or consolidation, then the system shall report validation warnings and skip corrupted records without halting execution.

## Original Issue Context

The specification originated from the user requirement:

> add a spec to be implemented later: a optional feature that could be toggled on/off to a simple but well designed MEMORY.md file that records traps/learnings for the project. This memory is helpful to record common/repeated mistakes that agents does due to lack of context/instructions/halucinating. When enabled, a specific skill sdw-memory will wrap the functionality of querying/recording to the memory file. Also when enabled, the sdw-orch skill should check if there is known issues/entries related to the tasks will implement. This step is enforced/inserted before dispatching the subagent, and the prompt to the subagent will contain these hints for the agent remember. Also the instructions should tell the agent that errors/gaps/traps should be returned to the orchestrator as output to the orchestrator and the orchestrator should check result/output and track/handle the command to write to memory and next task/subagent dispatched already will have access to these new info and the orch will decide if it is relevant to the prompt of new subagents. The memory entries structure should have a contract to honor and format, categorizing the type of entry, metadata, description of the issue and solution to fix, in a format that is cheap and easy to grep and filter the whole file even if it grows bigger and bigger, efficiently. The sdw-memory skill will also have a feature to re-read the whole file and analyze all entries, checking if entries can be merged/consolidated, as a way of cleaning/compacting/shrinking its size/lines from time to time as needed. It could be a subcommand sdw-memory consolidate.

## Notes

- Configuration Schema (`.sdw/config.json`):
  ```json
  {
    "memory": {
      "enabled": false,
      "path": "{projectRoot}/.sdw/MEMORY.md",
      "maxQueryResults": 5
    }
  }
  ```
  - When `memory.enabled` is false or omitted, all memory query, recording, and hint injection steps in `sdw-orch` are bypassed.
  - Path defaults to `{projectRoot}/.sdw/MEMORY.md` if not explicitly customized.

- Standard Memory Entry Contract:
  Each entry in `MEMORY.md` adheres to a strict delimited block format:
  ```markdown
  <!-- MEMORY-ENTRY:START -->
  ### [TRAP-001] windows-path-separators
  - **type**: trap
  - **tags**: paths, windows, posix, regex, normalization
  - **spec**: 001-sdw-implement-initial-version
  - **date**: 2026-10-19
  - **issue**: Node scripts using backslash separators on Windows fail cross-platform regex assertions.
  - **fix**: Always normalize file paths with forward slashes (`path.replace(/\\/g, '/')`).
  <!-- MEMORY-ENTRY:END -->
  ```
  - Recognized types: `trap`, `hallucination`, `constraint`, `pattern`, `tooling`.
  - Grep and filter efficiency: The explicit prefix markers (`<!-- MEMORY-ENTRY:START -->`, `- **tags**:`, `- **type**:`, `- **issue**:`, `- **fix**:`) permit single-pass line scanning and regex extraction using standard Node.js `fs` streams without AST parsing overhead.

- Skill 3-Tier Layout (`skills/sdw-memory/`):
  - Tier 1: `SKILL.md` (≤ 120 lines). Defines workflow states for querying, recording, checking, and consolidating memory. Includes announcement header `> When this skill is loaded, output "sdw-memory loaded."`.
  - Tier 2: `references/entry-contract.md`. Documents entry categories, required metadata fields, and consolidation merging rules.
  - Tier 3: `scripts/sdw_memory.cjs`. Deterministic Node.js 22 CommonJS CLI tool:
    ```bash
    # Query relevant entries matching keywords or tags
    node skills/sdw-memory/scripts/sdw_memory.cjs query <keywords...> [--limit=5]

    # Record a new validated memory entry
    node skills/sdw-memory/scripts/sdw_memory.cjs record --type=trap --title="windows-paths" --tags="paths,windows" --issue="..." --fix="..."

    # Consolidate and compact entries to reduce file size
    node skills/sdw-memory/scripts/sdw_memory.cjs consolidate [--dry-run]

    # Validate syntax and conformance of existing MEMORY.md
    node skills/sdw-memory/scripts/sdw_memory.cjs check
    ```

- Orchestrator (`sdw-orch`) Integration Lifecycle:
  1. *Step 4 (Subagent Dispatch Generation):* If `memory.enabled` is true, invoke `sdw_memory.cjs query` passing the task title, description, and target files. Wrap results in `<project_memory_hints>` within the subagent task manifest.
  2. *Subagent Manifest Guidance:* Include prompt directive:
     > Report any unexpected framework errors, tooling quirks, or newly discovered traps in your completion summary under `traps_encountered: [{ type, title, tags, issue, fix }]`.
  3. *Step 5 (Subagent Result Verification):* When evaluating subagent output, parse `traps_encountered`. If valid entries exist, invoke `sdw_memory.cjs record` to persist them to `MEMORY.md`.
  4. *Step 6 (DAG Progression):* Subsequent subagents in the execution run receive updated memory hints including the newly persisted records.

- Consolidation Engine (`sdw-memory consolidate`):
  - Iterates through all entries delimited by `<!-- MEMORY-ENTRY:START -->`.
  - Clusters entries sharing identical categories and overlapping tag sets.
  - Combines overlapping issue descriptions and merges actionable prevention rules into concise bullet points.
  - Preserves date ranges and origin references.
  - Re-serializes the compacted `MEMORY.md` file and outputs summary metrics (original entries, consolidated entries, bytes saved).

- Runtime Dependency Policy:
  - All scripts implemented in Node.js 22 CommonJS (`.cjs`) utilizing standard library modules only (`fs`, `path`, `process`). Zero external npm packages.

## Out of Scope

| Feature | Reason |
|---------|--------|
| External vector database integrations (e.g. Pinecone, Chroma, Milvus) | Retains zero external runtime dependencies and deterministic standard library execution |
| Cross-repository centralized global memory synchronization | Memory is strictly scoped to the repository workspace to avoid cross-project pollution |
| Continuous real-time background file-system watcher daemon | Memory operations are invoked on-demand by the orchestrator or manually via CLI |
| Modifying core orchestrator DAG topological scheduling logic | Memory hints provide additive context guidance and do not alter graph scheduling |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Memory file location | `{projectRoot}/.sdw/MEMORY.md` | Co-locates memory inside .sdw configuration directory while remaining version-controlled and accessible | y |
| Default activation state | Disabled (`memory.enabled: false`) | Opt-in configuration avoids unexpected file creation in existing consumer repositories | y |
| Entry storage format | Markdown delimited block format | Maximizes human legibility and enables fast regex line filtering without AST overhead | y |
| Consolidation invocation trigger | Explicit CLI command or end-of-run hook | Avoids unnecessary file rewriting churn during individual atomic task steps | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | Baseline `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/007-sdw-memory-skill.md` |
| Orchestrator baseline | Orchestrator skill structure is present in repository | Verify orchestrator scripts in `skills/sdw-orch/` or `skills/sdw-implement/` |
| Skill layout compliance | Skill architecture adheres to standard 3-tier structure | Validate planned paths under `skills/sdw-memory/` |
| Node runtime compatibility | Environment provides Node.js 22 or higher | Run `node -v` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Query execution output displaying matched keywords, scored entry IDs, and elapsed query time.
- Entry recording confirmation logs detailing generated entry IDs and destination file path.
- Consolidation summary metrics reporting pre-compaction entry count, post-compaction entry count, and file size reduction percentage.
- Orchestrator execution logs demonstrating `<project_memory_hints>` injected into subagent task prompt manifests.

### Negative & Failing Test Scenarios

- Missing memory file graceful fallback: when `MEMORY.md` does not exist on disk, `sdw_memory.cjs query` must output empty results and exit with code 0 without crashing.
- Malformed entry syntax resilience: when `MEMORY.md` contains unclosed delimiter comments or missing mandatory metadata fields, the parser must emit validation warnings and skip corrupted records without halting execution.
- Disabled memory bypass: when `memory.enabled` is false in configuration, `sdw-orch` must bypass all query and recording operations without creating files or modifying subagent prompts.
- Consolidation without duplication: when `sdw_memory.cjs consolidate` runs on a file with completely unique, non-overlapping entries, it must preserve all entries verbatim without data loss.
