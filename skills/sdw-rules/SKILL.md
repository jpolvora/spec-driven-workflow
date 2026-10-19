---
name: sdw-rules
description: Shared behavioral rules and engineering guidelines enforcing simplicity, scope enclosure, and anti-overengineering.
version: 0.1.0
invocation_names:
  - sdw-rules
  - sdw-rules doctor
  - sdw-rules audit-spec
  - sdw-rules log-trap
---
# sdw-rules

> When this skill is loaded, output "sdw-rules loaded."

Shared behavioral rules and engineering discipline enforcing simplicity first, surgical scope enclosure, and anti-overengineering across all SDW workflows.

## Subcommands

- `doctor`: Audits installed skills for line budgets and `sdw-rules` cross-references.
- `audit-spec <specFile>`: Scans a specification for potential scope creep or speculative abstractions.
- `log-trap --slug <slug> --title <title> --avoid <avoid> --action <action>`: Records a verified trap in `.sdw/traps.md`.

## Core Directives

1. **Think & Ask Before Acting:** Never assume or expand scope silently. When architectural opportunities or unrequested enhancements arise, halt and present them to the user via interactive clarification (`ask_question`), defaulting to the minimal requested scope.
2. **Simplicity First (YAGNI):** Write the minimum code required to satisfy acceptance criteria. Prohibit speculative abstractions, single-use helper modules, and unnecessary configuration options. If a solution takes 50 lines but could be done in 20, choose 20.
3. **Surgical Scope Enclosure:** Touch only what the task requires. Avoid modifying adjacent code, reformatting working files, or refactoring functional logic.
4. **Empirical Goal-Driven Verification:** Transform every requirement into a verifiable check, test, or empirical pass/fail signal.
5. **Explicit Authorization Before Acting:** Never start implementing, editing files, or running state-changing commands on the basis of a topic statement, observation, or implied direction. Act only on an explicit user command or an approved plan. In case of any ambiguity about what was asked, stop and ask for clarification before inferring intent or deciding on the user's behalf.

## Steps

1. **Audit Rules Compliance**
   Validate that skills adhere to line budgets (≤ 120 lines) and reference shared rules.
   - Run: `node skills/sdw-rules/scripts/sdw_rules.cjs doctor [--json]`
   - Done when: All skills pass compliance check with exit code `0`.

2. **Audit Specification for Scope Creep**
   Scan specifications for speculative features or unrequested scope expansions.
   - Run: `node skills/sdw-rules/scripts/sdw_rules.cjs audit-spec <specPath> [--json]`
   - Done when: Specification audit report confirms minimal scope enclosure.

3. **Log Anti-Regression Trap**
   Record friction or an overengineering defect in the project trap log.
   - Run: `node skills/sdw-rules/scripts/sdw_rules.cjs log-trap --slug <slug> --title <title> --avoid <avoid> --action <action>`
   - Done when: New trap entry is appended to `{projectRoot}/.sdw/traps.md`.

## References

- In-depth Karpathy principles & code comparisons: [`references/karpathy_rules.md`](references/karpathy_rules.md)
- Catalog of LLM anti-patterns & traps: [`references/anti_patterns.md`](references/anti_patterns.md)
- Anti-regression traps log template: [`references/traps_log.md`](references/traps_log.md)
