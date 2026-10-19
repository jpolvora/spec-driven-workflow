---
id: null
slug: 003-sdw-router-skill
title: "SDW Router Autoload Skill"
source: local
specDate: 2026-10-19
---

# Specification — SDW Router Autoload Skill

## Description

The `sdw-router` skill is an always-applied, lightweight skill router designed for consumer projects and developer workspaces. It acts as the central entrypoint and traffic controller across all Spec-Driven Workflow (SDW) skills located in `skills/` (or installed under `.agents/skills/`).

Instead of loading instructions from every skill into the agent context on every interaction, `sdw-router` enforces progressive disclosure. By maintaining a minimal context footprint (Tier 1 `SKILL.md` under 120 lines), it analyzes the user's prompt or intent, matches it against a deterministic dispatch table, and routes the agent to load and execute the appropriate specialized skill (e.g., `sdw-config`, `sdw-spec`, or `sdw-orch`).

Consumer projects enable this routing mechanism by adding a reference to `sdw-router` in their project-level `AGENTS.md`.

### Design Intent

Greenfield implementation for the Spec-Driven Workflow (SDW) initiative. It replaces legacy, monolithic skill autoloading configurations from `workflow-skills` with an ultra-compact, token-efficient dispatch router that preserves context window headroom while providing deterministic discovery and routing for all workspace skills.

## Acceptance Criteria

- AC1: The system shall serve as an always-autoloaded entrypoint routing agent tasks across all available skills.
- AC2: When referenced in a consumer project `AGENTS.md`, the system shall load on session start with minimal context budget.
- AC3: When a prompt matches project configuration or environment verification intents, the system shall route execution to `sdw-config`.
- AC4: When a prompt matches specification authoring, formatting, listing, or archiving intents, the system shall route execution to `sdw-spec`.
- AC5: When a prompt matches specification implementation, orchestration, or resumption intents, the system shall route execution to `sdw-orch`.
- AC6: Where the user prompt explicitly specifies a skill invocation by name, the system shall honor the explicit invocation directly.
- AC7: While evaluating multiple candidate skill matches with equal confidence, the system shall query the user for clarification with a recommended default.
- AC8: If a routed skill directory is missing or unreadable on disk, then the system shall report an actionable resolution error.
- AC9: The system shall provide a deterministic command-line helper script to scan available skills and test prompt intent routing.
- AC10: When scanning installed skills, the system shall discover skills in both the canonical repository directory and consumer project locations.
- AC11: The system shall document instructions and markdown reference snippets for consumer projects to configure the router in `AGENTS.md`.
- AC12: If no recognized skill matches the user prompt, then the system shall allow standard agent execution without intercepting.

## Original Issue Context

The user requested an initial specification for the `sdw-router` skill:

> create another spec for implement an always autoloaded skill for consumer projects which is a router of all skills in skills/ . name it sdw-router. The consumer may add a reference to it in the consumer project agents.md (manually)

## Notes

- Router architecture follows the 3-Tier standard:
  - Tier 1: `skills/sdw-router/SKILL.md` (≤ 120 lines) containing the core state machine, trigger phrases, output announcement (`> When this skill is loaded, output "sdw-router loaded."`), and high-level routing matrix.
  - Tier 2: `skills/sdw-router/references/` containing `routing_table.md` (full intent keyword map, examples, edge cases) and `consumer_agents_setup.md` (manual copy-paste snippets for consumer `AGENTS.md`).
  - Tier 3: `skills/sdw-router/scripts/` containing `sdw_router.cjs` (CLI helper with subcommands `scan`, `route <prompt>`, and `doctor`).
- Location discovery rules:
  1. Primary: `{projectRoot}/skills/<skill-name>/` (canonical development repository).
  2. Consumer fallback: `{projectRoot}/.agents/skills/<skill-name>/` (installed consumer projects).
- Execution precedence:
  1. Explicit user instructions / direct skill invocation in current turn (`/sdw-*` or `@sdw-*`).
  2. High-confidence intent keyword match from dispatch table.
  3. Interactive clarification via `ask_question` with recommended option when confidence is tied.
  4. Pass-through for generic conversational or coding prompts unrelated to SDW workflows.
- All automation scripts must be implemented in Node.js 22 CommonJS (`.cjs`) using standard library modules only (`fs`, `path`, `process`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic remote downloading of missing skills during runtime | Skills must be packaged and installed before execution |
| Unprompted automated mutation of consumer `AGENTS.md` | Configuration in consumer `AGENTS.md` is manually added by the user |
| Intercepting arbitrary general programming queries | The router only handles SDW workflow and skill lifecycle tasks |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Router reference mechanism | Manual addition to consumer `AGENTS.md` | Gives consumer full control over their agent instructions | y |
| Router loading announcement | Output `sdw-router loaded.` upon load | Complies with AGENTS.md Tier 1 heading standard | y |
| Skill discovery search path | `{projectRoot}/skills` then `{projectRoot}/.agents/skills` | Seamlessly handles both development and installed consumer workspaces | y |
| CLI script runtime | Node.js 22 CommonJS (`.cjs`) with zero npm dependencies | Conforms to AGENTS.md rule: standard library only | y |
| Absent lifecycle dimensions | N/A because execution is local CLI/agent tool invocation | Local agent execution model | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Skills directory access | Canonical `skills/` directory exists and contains developed skills | Inspect directory listing |
| Git repository state | Workspace is a valid Git repository | Run `git status` check |
| Router helper CLI | Script `sdw_router.cjs` exists in `skills/sdw-router/scripts/` | Execute `node skills/sdw-router/scripts/sdw_router.cjs --help` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output confirming router activation: `sdw-router loaded.`.
- Explicit dispatch log indicating target skill invocation (e.g. `[sdw-router] Routing intent to sdw-spec`).
- CLI test runner output displaying matched intent, target skill, and confidence score.
- Structured JSON output when invoked via `node sdw_router.cjs route --json "<prompt>"`.

### Negative & Failing Test Scenarios

- Missing target skill detection: when a prompt matches a skill whose directory does not exist on disk, `sdw_router.cjs doctor` and the runtime dispatch must report an actionable error naming the missing directory.
- Ambiguous intent conflict resolution: when a prompt contains conflicting keywords belonging to two skills equally, the router must trigger user clarification rather than arbitrarily selecting one.
- Passive non-interference: when an ordinary coding prompt (e.g. "fix indentation in this CSS file") is evaluated, the router must return a pass-through signal without hijacking the prompt.
