---
id: null
slug: 00008-sdw-rules-skill
title: "SDW Rules Shared Skill — Simplicity, Scope Enclosure, and Anti-Overengineering"
source: local
status: implemented
specDate: 2026-10-19
---

# Specification — SDW Rules Shared Skill — Simplicity, Scope Enclosure, and Anti-Overengineering

## Description

The Spec-Driven Workflow (SDW) emphasizes token efficiency, deterministic execution, and eliminating prompt sediment. However, LLM agents have a tendency toward scope creep, silent inference of unrequested capabilities, speculative flexibility, and overengineering (such as creating 50 lines of machinery where 20 lines of standard code suffice).

This specification introduces `sdw-rules`, a centralized, shared skill under `skills/sdw-rules/`. It provides a canonical source of truth for behavioral principles and engineering constraints across the entire SDW ecosystem. Rather than duplicating rules across individual skills (`sdw-config`, `sdw-spec`, `sdw-orch`, `sdw-router`, `sdw-memory`), downstream skills reference `sdw-rules` to enforce disciplined development.

Inspired by Andrej Karpathy's coding observations (`karpathy-guidelines`), `ws-senior-developer`, and `ws-self-learning`, `sdw-rules` establishes four fundamental operational directives:
1. **Think & Ask Before Acting:** Never assume or expand scope silently. When architectural enhancements or opportunities arise, halt and present them to the user via interactive clarification using the host's question prompt mechanism (e.g. `ask_question` where supported) or a structured chat prompt, defaulting to the minimal requested scope.
2. **Simplicity First (YAGNI):** Write the minimum code required to satisfy acceptance criteria. Prohibit speculative abstractions, single-use helper modules, and unnecessary configuration options. If a solution takes 50 lines but could be done in 20, choose 20.
3. **Surgical Scope Enclosure:** Touch only what the task requires. Avoid modifying adjacent code, reformating working files, or refactoring functional logic.
4. **Empirical Goal-Driven Verification:** Transform every requirement into a verifiable check, test, or empirical pass/fail signal.

Additionally, `sdw-rules` incorporates a lightweight anti-regression trap log, recorded at project scope in `.sdw/traps.md` (with `references/traps_log.md` retained as the schema template), capturing real session friction and overengineering mistakes to prevent repeating them across future workflow runs.

### Design Intent

Establishes a single, reusable repository authority for agent discipline and minimalism. By consolidating anti-overengineering and scope enclosure directives into a Tier 1/Tier 2 skill layout, SDW preserves precious context window budget in orchestrators and subagents while providing a deterministic standard for lean, surgical implementations.

## Acceptance Criteria

- AC1: The system shall provide a canonical shared rules skill under `skills/sdw-rules/` adhering to the three-tier progressive disclosure standard.
- AC2: When the `sdw-rules` skill is loaded by an agent, the system shall output `"sdw-rules loaded."` as its announcement banner.
- AC3: The system shall codify core directives for simplicity first, surgical diff hygiene, and goal-driven verification inspired by the Karpathy guidelines.
- AC4: When an architectural opportunity or unrequested enhancement is detected, the system shall require asking the user for confirmation with the minimal scope as the recommended default.
- AC5: While implementing tasks or synthesizing specifications, the system shall enforce minimal viable code and reject speculative abstractions.
- AC6: The system shall provide reference documentation detailing anti-patterns and concrete overengineering traps.
- AC7: Where downstream skills `sdw-spec` and `sdw-orch` execute, the system shall integrate references to `sdw-rules` without duplicating core prompt text.
- AC8: The system shall provide a deterministic command-line helper script to verify skill compliance and audit repository adherence to shared rules.
- AC9: If unrequested features or unnecessary code expansions are introduced, then the system shall flag them during review verification.
- AC10: When friction or an overengineering defect occurs during workflow execution, the system shall record the resolved trap in a lightweight anti-regression log.

## Original Issue Context

The specification originated from the user request to prevent unsolicited specification expansion and establish common engineering guidelines:

> remove from the 00006-packaging-installer-updater.md the native installer specification. For now I want only the vercel compatible format. I noticed that adding specification for native installer was an undesired decision that you've inferred. When new enhancements/possibilities comes up as oportunity to add it to specs, I wish instead of automatically you decides to add it for some reason, confirm with the user/askQuestion - default option is write to spec only what was requested/asked for. Suggest me what are the smartest/simplest way to enforce this rule - implement only what was requested / do the minimal work for satisfy the requirements/do not overengineer/if the result/solution was 50 lines but it could be done in 20, prefer to do in 20/simplify implementation. I guess we can create a common shared skill for all other skills reference it/include it, which will prevent duplication of instructions - we could name it sdw-rules - and we add/refine instructions as soons as we need it in the development lifecycle of the project. I like instructions and best practices of the skill karpathy-guidelines, we can inspire from it.

## Notes

- Skill Architecture (`skills/sdw-rules/`):
  - **Tier 1 (`SKILL.md`)**: Compact guidelines (≤ 80 lines) defining the 4 core pillars, announcement banner (`> When this skill is loaded, output "sdw-rules loaded."`), and brief triggers.
  - **Tier 2 (`references/`)**:
    - `karpathy_rules.md`: In-depth rationale, examples of minimal solutions vs. bloated solutions, and trade-off checklists.
    - `anti_patterns.md`: Catalog of common LLM traps (e.g. inventing unasked CLI tools, adding speculative parameters, refactoring adjacent code, premature generalisation).
    - `traps_log.md`: Schema template and seed content for the anti-regression log; live entries are written to project scope (`{projectRoot}/.sdw/traps.md`, see Notes) so installed skill directories remain read-only.
  - **Tier 3 (`scripts/sdw_rules.cjs`)**:
    - Zero-dependency Node.js 22 CommonJS script.
    - Subcommands:
      - `doctor`: Audits installed skills to verify they reference `sdw-rules` and adhere to context line budgets.
      - `audit-spec <specFile>`: Scans a specification for potential scope creep markers or excessive complexity.
      - `log-trap --slug <slug> --title <title> --avoid <avoid> --action <action>`: Appends a new verified trap entry to `{projectRoot}/.sdw/traps.md`, delegating to `sdw_memory.cjs record` when project memory (spec 007) is enabled.
- Downstream Integration Points:
  - In `skills/sdw-spec/SKILL.md`: Adds cross-reference instruction: *"When formulating or editing specifications, apply sdw-rules for scope enclosure. Never infer unprompted features without user-gate."*
  - In `skills/sdw-orch/SKILL.md`: Adds cross-reference instruction: *"Subagents must adhere to sdw-rules simplicity first and surgical diff directives. Minimum code to satisfy ACs."*
  - In `skills/sdw-router/SKILL.md`: Routes rule, guideline, or coding standard inquiries to `sdw-rules`.
- Packaging & Portability:
  - Included under `skills/` so it is automatically discoverable and installable via `npx skills add <repo> --skill sdw-rules`.
- Cross-Spec Memory Boundary (spec 007):
  - `sdw-rules` records behavioral and rule-policy traps; `sdw-memory` records project runtime traps.
  - When both are enabled, `MEMORY.md` is the single sink and `.sdw/traps.md` retains only rule-policy audit entries.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing project test runners or compilers | sdw-rules governs behavioral conventions, not language compilation |
| Complex AST-level code rewriting linters | Static checks focus on file existence, line budgets, and structural compliance |
| External memory databases or cloud syncing | Trap logging is stored in lightweight local markdown within the repository |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Canonical location | `skills/sdw-rules/` | Conforms to SDW 3-tier skill layout standard | y |
| Integration strategy | Cross-reference from existing skills | Eliminates duplicate prompt text while maintaining modularity | y |
| Default clarification policy | Minimal requested scope as default | Enforces strict scope enclosure when opportunities arise | y |
| Trap memory format | Append-only markdown table in `{projectRoot}/.sdw/traps.md` | Installed skill directories stay read-only; project scope keeps the log version-controlled and portable | y |
| Runtime dependency policy | Standard library Node.js 22 CommonJS only | Adheres to repository architectural guidelines in AGENTS.md | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature is tracked in `.sdw/specs/index.specs.md` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification adheres to canonical SDW standard and EARS syntax | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate` |
| Clean repository state | Git working tree has no uncommitted unstaged corruptions | Run `git status` check |
| Node runtime compatibility | Environment provides Node.js 22 or higher | Run `node -v` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output confirming rules activation: `sdw-rules loaded.`.
- Diagnostic output from `sdw_rules.cjs doctor` detailing checked skills and compliance health.
- Clear error notices when unrequested scope or composite ACs are detected.
- Formatted trap entry additions emitted by `sdw_rules.cjs log-trap`.

### Negative & Failing Test Scenarios

- Scope creep detection: when an unrequested feature is added to a task without user confirmation, the review gate must flag it as an unapproved scope expansion.
- Broken reference check: when `sdw_rules.cjs doctor` scans skills and detects a skill missing the `sdw-rules` reference anchor, it must exit with code 1.
- Line budget breach: when a skill's Tier 1 `SKILL.md` exceeds the context budget (e.g. > 120 lines), `sdw_rules.cjs doctor` must fail verification.
- Invalid trap format rejection: when attempting to log a trap without required avoid or action fields, `sdw_rules.cjs log-trap` must reject the operation with a non-zero exit code.
