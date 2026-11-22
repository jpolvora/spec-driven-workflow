---
id: null
slug: 00079-sdw-retro-autonomous-candidate-generation-and-pipeline-learning
title: "SDW Retro Autonomous Candidate Generation and Pipeline Execution Learning"
source: local
type: feature
priority: high
status: implemented
specDate: 2026-11-22
---
# Specification — SDW Retro Autonomous Candidate Generation and Pipeline Execution Learning

## Description

The Spec-Driven Workflow (SDW) learning loop is anchored by the retrospective skill (`sdw-retro`), which reviews completed orchestrator runs. However, the current retrospective implementation operates strictly as a deterministic signal calculator (tracking timestamps, duration, retries, missing artifacts, and command slips), leaving candidate identification and improvement formulation entirely to manual operator or agent intervention. Furthermore, post-merge delivery via `sdw-ship-pr` bypasses the orchestrator retrospective trigger when review convergence occurs asynchronously.

Crucially, SDW is strictly agent-agnostic: it executes across diverse harnesses including Antigravity, Claude Code, OpenCode, Cursor, Codex, DeepSeek harness, and headless CI. Each harness maintains distinct conventions for logging session transcripts, subagent traces, and CLI outputs. Hardcoding vendor-specific filesystem layouts or deep paths directly into scripts or configurations violates SDW agnosticism and creates fragility. Instead, transcript discovery and log acquisition must be enforced at the skill level: the retrospective skill instructs the executing agent to identify and supply its own host session transcript and logs via `--transcript <path>`, while deterministic discovery helpers (`find_session_transcript.cjs`) evaluate generic environment facts, session identifiers, and deeper search bounds (up to depth 6) without vendor-specific path assumptions.

Additionally, configuration schemas and templates in `sdw-config` (`sdw_config.cjs`) exhibit drift: `retro`, `prePrDiscovery`, `branching`, and `skillsRoot` are absent from `DEFAULT_CONFIG` or `DEFAULT_SCHEMA`, meaning new workspace initializations omit required baseline keys. In standard configurations, `retro.enabled` defaults to `false`. When enabled and running in the canonical upstream repository (`spec-driven-workflow`), improvement candidates should translate directly into local bugfix specifications. In contrast, when running in consumer repositories, issues must be partitioned: application-level issues generate local specifications in consumer `.sdw/specs/`, whereas SDW framework-level issues generate issue submission drafts targeting the upstream repository (`github.com/jpolvora/spec-driven-workflow/issues`), preventing unauthorized local edits to vendored skills.

This specification elevates `sdw-retro` into an autonomous learning agent with agent-agnostic transcript resolution and repository topology awareness, repairs configuration initialization drift, and connects retrospective insights directly to automated specification synthesis or upstream issue reporting.

### Design Intent

Preserve SDW's core philosophy of empirical verification, continuous self-improvement, agent agnosticism, and strict scope enclosure. By automating root-cause retrospection, enforcing skill-level transcript resolution across all supported harnesses, partitioning consumer from framework defects, and enforcing complete configuration schema synchronization, SDW systematically transforms execution friction into actionable improvements without vendor lock-in, lost learnings, or architecture violations.

## Acceptance Criteria

- AC1: The system shall provide an autonomous candidate evaluation mode in `skills/sdw-retro/scripts/retro.cjs` triggered by `--generate-candidates` or configured via `retro.candidateMode` in `.sdw/config.json`.
- AC2: While evaluating candidates, the system shall analyze run state, step artifacts, dispatch prompts, task evidence, review threads, and session transcripts across agent harnesses to identify execution friction.
- AC3: The system shall validate that all autonomously generated candidates strictly comply with the candidate schema including `id`, `title`, `severity` (critical, high, medium, low), `category` (memory, harness-directive, reviewer-standard, automated-check, navigation-pointer, no-op-deletion), `targetScope` (upstream, consumer), `evidence`, and `proposedChange`.
- AC4: Where a generated candidate belongs to the `memory` category, the system shall include an `sdw-memory` draft record formatted with `Scenario / Context`, `DO NOT`, and `INSTEAD DO` structured fields.
- AC5: The system shall provide agent-agnostic skill instructions in `skills/sdw-retro/SKILL.md` directing the active agent harness to discover its own session transcript and logs from host facts and provide them via `--transcript <path>`.
- AC6: When `skills/sdw-retro/scripts/find_session_transcript.cjs` searches candidate roots, the system shall evaluate generic environment facts with search depth up to 6 and session identifier matching across all supported agent harnesses.
- AC7: While running in a consumer project workspace, the system shall classify framework-scoped defects as upstream issues and emit ready-to-file issue drafts for `github.com/jpolvora/spec-driven-workflow/issues` while preventing local modifications to vendored skills.
- AC8: While running in the canonical upstream repository, the system shall suggest local specifications with type `bugfix` for approved candidates.
- AC9: When `sdw-ship-pr` completes a pull request merge and updates the run state, the system shall update `state.status` to `completed` and execute the automatic retrospective when `retro.enabled` is `true`.
- AC10: Where `retro.followUp` is configured as `queue` in `sdw-batch`, the system shall synthesize draft bugfix specifications with type `bugfix` for consumer-scoped `critical` and `high` candidates via `sdw-spec new`.
- AC11: The system shall ensure `retro.enabled` defaults to `false` in `.sdw/config.schema.json` and in `sdw_config.cjs` `DEFAULT_CONFIG`.
- AC12: When `sdw-config init` initializes a consumer workspace, the system shall write all configuration keys including `retro`, `branching`, `skillsRoot`, `prePrDiscovery`, and `harness` into `.sdw/config.json` and synchronize `DEFAULT_SCHEMA` with `.sdw/config.schema.json`.
- AC13: If the autonomous candidate evaluation encounters an invalid or unparsable LLM response, then the system shall record an evaluation warning without corrupting the deterministic signals report.
- AC14: The system shall maintain 100% test pass rate across unit and integration tests asserting candidate generation, agent-agnostic transcript discovery, upstream versus consumer issue partitioning, and configuration schema initialization.

## Notes

- Configuration additions in `.sdw/config.schema.json` and `sdw_config.cjs`:
  ```json
  "retro": {
    "type": "object",
    "description": "Configuration for post-delivery retrospective analysis and learning loop.",
    "properties": {
      "enabled": { "type": "boolean", "default": false },
      "followUp": { "type": "string", "enum": ["queue", "record", "none"], "default": "queue" },
      "candidateMode": { "type": "string", "enum": ["subagent", "command", "none"], "default": "none" },
      "candidateModel": { "type": ["string", "null"], "default": null },
      "candidateEffort": { "type": ["string", "null"], "enum": ["low", "medium", "high", null], "default": null },
      "transcripts": { "type": "array", "items": { "type": "string" }, "default": [] }
    },
    "additionalProperties": false
  }
  ```
- Evaluator prompt input combines:
  - Run state summary (status, duration, score iterations, review rounds, blocked gates).
  - Step 4 task failure evidence and compiler/test diagnostics.
  - Step 5 judge friction points and criterion deductions.
  - Step 7 / Step 8 code review findings and remote PR thread discussions.
  - Discovered session transcript command slip sequences.
- Agent-agnostic transcript discovery:
  - Skill level instructions in `SKILL.md` and `references/session_discovery.md` guide the active agent to identify its session transcript (e.g. Antigravity transcript in app data brain directory, Claude Code session JSON, OpenCode execution logs, Cursor chat files) using runtime host facts and pass `--transcript <path>`.
  - Finder script (`find_session_transcript.cjs`) applies generic heuristics (depth up to 6, session ID string matching in path segments, environment root scoring) without hardcoding vendor names or paths.
- Upstream vs consumer scope partitioning:
  - `skillsMode === 'canonical'` identifies the upstream repository (`spec-driven-workflow`). All candidates map to `targetScope: 'upstream'` proposing local specs via `sdw-spec new --type bugfix`.
  - `skillsMode !== 'canonical'` identifies consumer repositories. Defects in `{projectRoot}/skills` or `.agents/skills` map to `targetScope: 'upstream'` emitting GitHub issue bodies targeting `github.com/jpolvora/spec-driven-workflow/issues`. Defects in application code map to `targetScope: 'consumer'` proposing local consumer specs.

## Out of Scope

| Feature | Reason |
|---|---|
| Hardcoding agent-specific directory paths in scripts | Violates SDW agnosticism; transcript identification is enforced at the skill level through agent self-discovery |
| Automatic code modification during retro | Retrospectives produce candidates, draft specifications, or issue drafts; direct edits to production code are strictly forbidden by `sdw-rules` |
| Direct remote GitHub issue creation via API | Retrospectives output markdown issue templates ready for human review; unattended remote issue submission is excluded to avoid spam |
| Modifying vendored skills in consumer projects | Product skills in consumer `.agents/skills/` are immutable deployment artifacts; changes belong in the upstream repository |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Default retro activation | `false` across all consumer templates | Retrospectives run only when opted in, avoiding unwanted overhead or execution stalls | Yes |
| Upstream public repository coordinates | `github.com/jpolvora/spec-driven-workflow` | Official canonical repository for Spec-Driven Workflow issues and contributions | Yes |
| Candidate generation prompt failure | Graceful fallback to deterministic signals | Evaluator errors should never invalidate the run or block reporting | Yes |
| Agent agnosticism in discovery | Skill-guided agent discovery with depth 6 generic finder fallback | Balances automated discovery with harness-level flexibility across diverse AI agents | Yes |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Architectural clarity | Evaluation prompt and candidate output schema defined | Inspect candidate contract reference in `skills/sdw-retro/references/candidate_contract.md` |
| Agent agnosticism | No hardcoded vendor-specific paths in scripts or schemas | Review code diff against `skills/sdw-retro/scripts/` |
| Schema completeness | All config keys declared across `config.schema.json` and `sdw_config.cjs` | Run `node skills/sdw-config/scripts/sdw_config.cjs validate` |
| Partitioning logic | Scope classifier partitions consumer and upstream issues | Execute unit tests asserting candidate target scopes |
| Spec validation | Specification complies with canonical EARS and section rules | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `retro.cjs` emits candidate count and severity breakdown in console summary and `<runId>.retro.json`.
- `find_session_transcript.cjs` emits `found: true` with discovered session transcript path regardless of agent harness.
- `sdw-batch` console logs queued follow-up specifications referencing candidate IDs.
- Consumer retro reports output an "Upstream Issue Candidates" section with Markdown links to `github.com/jpolvora/spec-driven-workflow/issues/new`.

### Negative & Failing Test Scenarios

- Candidate generation with malformed LLM JSON output logs warning and preserves deterministic signals report without throwing.
- Transcript discovery with non-existent session ID safely returns `found: false` and exits code 0.
- `validate_candidates.cjs` rejects candidates missing required fields or violating category enums.
- Attempt to author consumer specs targeting `.agents/skills/` is rejected with `skills-requires-spec` upstream direction.
