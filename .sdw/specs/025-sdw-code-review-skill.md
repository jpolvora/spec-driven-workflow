---
id: null
slug: 025-sdw-code-review-skill
title: "SDW Code Review Skill — Deep Working Directory Code Review, Actionable Fix Planning, and Orchestrator Delegation"
source: local
specDate: 2026-10-19
---

# Specification — SDW Code Review Skill — Deep Working Directory Code Review, Actionable Fix Planning, and Orchestrator Delegation

## Description

In the current implementation of Spec-Driven Workflow (SDW), Step 7 of `sdw-orch` embeds automated code review routines directly within `review_runner.cjs` inside the orchestrator scripts directory. This tightly couples code review execution to the orchestrator pipeline, duplicates review logic and behavioral instructions, and prevents developers or subagents from invoking deep code review on-demand as a standalone utility.

Legacy code review implementations from `workflow-skills` (`ws-code-review`) were dense and bloated with excessive procedural concepts, including multi-stack matrix definitions, parallel general-purpose subagents, Fable fraud detection integrations, and multi-round review file writers. Modern LLM architectures possess high reasoning and planning capabilities; excessive prompt instructions and repetitive workflow sediment can be eliminated to accelerate execution speed and minimize context overhead.

This specification introduces `sdw-code-review`, a lean, standalone, and agent-agnostic skill located under `skills/sdw-code-review/`. The skill deeply analyzes code changes from the current working directory and committed changes against an auto-detected base branch (`main`, `master`, tracking remotes, or `.sdw/config.json`). It applies code rules inspired by Karpathy Guidelines (`karpathy-guidelines`) and `sdw-rules`, evaluating simplicity first (YAGNI, anti-overengineering, dead code, speculative generality), surgical changes (minimal diff footprint, style preservation), and syntax hygiene (active debugger statements, unresolved TODOs, secret leaks).

`sdw-code-review` outputs a structured review report in Markdown and JSON formats that directly doubles as an actionable execution plan for resolving identified issues. Furthermore, `sdw-orch` Step 7 delegates code review entirely to `sdw-code-review` via subagent dispatch or direct CLI execution, receiving the report to decide whether to advance to Step 8, apply surgical fixes, or pause. All duplicated code review instructions are removed from `sdw-orch`, keeping orchestrator context lean and focused.

### Design Intent

Provide a focused, fast, and harness-agnostic code review capability that operates identically whether invoked interactively by a user, executed via CLI script, or dispatched as a subagent under `sdw-orch`. Ground the review in Karpathy Guidelines and `sdw-rules` to enforce simplicity and anti-overengineering without inheriting the procedural bloat of legacy frameworks.

## Acceptance Criteria

- AC1: The system shall provide a standalone skill sdw-code-review under skills/sdw-code-review/ adhering to the 3-Tier progressive disclosure standard.
- AC2: The system shall implement sdw-code-review using Node.js 22 CommonJS with zero external runtime npm dependencies.
- AC3: The system shall expose a CLI entrypoint for sdw-code-review supporting options for base reference, target root, report destination, automated fixes, and structured JSON output.
- AC4: When resolving the base comparison target without an explicit base reference, the system shall auto-detect the base branch using configured settings, tracking remotes, or standard default branches.
- AC5: The system shall inspect both uncommitted working directory changes and committed branch diffs against the resolved base reference.
- AC6: While analyzing diffs, the system shall evaluate code simplicity and anti-patterns derived from Karpathy Guidelines and sdw-rules.
- AC7: While inspecting source files, the system shall detect syntax hygiene defects including active debugger statements, unresolved TODO comments, and sensitive credentials.
- AC8: When code review findings are discovered, the system shall assign each finding a stable identifier, severity classification, precise file location, rule citation, and actionable fix prescription.
- AC9: The system shall format the review output into a structured report artifact usable as an executable plan for resolving identified issues.
- AC10: When invoked with the automated fix option, the system shall execute surgical fixes for fixable findings up to the configured iteration ceiling.
- AC11: While dry-run mode is active, the system shall simulate code review analysis and report planned fixes without modifying files on disk.
- AC12: While sdw-orch Step 7 executes, the orchestrator shall delegate code review by dispatching a subagent invoking sdw-code-review.
- AC13: When sdw-code-review finishes under sdw-orch, the orchestrator shall evaluate the generated report output to determine whether to advance, iterate on fixes, or pause.
- AC14: The orchestrator shall eliminate duplicated internal review instructions by referencing sdw-code-review as the sole code review authority.
- AC15: The system shall register sdw-code-review in sdw-router to dispatch code review user intents and slash commands.
- AC16: If critical or warning findings remain unresolved after maximum fix iterations, then the system shall return a non-zero exit code with the unresolved report.
- AC17: The system shall provide automated test coverage validating standalone execution, base branch auto-detection, report generation, and orchestrator delegation.

## Notes

- Implementation layout:
  - `skills/sdw-code-review/SKILL.md`: Tier-1 skill definition with frontmatter, subcommands (`run`, `fix`, `doctor`), compact state steps, and Done when criteria (≤ 120 lines).
  - `skills/sdw-code-review/references/code_review_rules.md`: Tier-2 reference detailing code smells (Fowler baseline), Karpathy rules, hygiene invariants, evidence requirements, and report schema.
  - `skills/sdw-code-review/scripts/sdw_code_review.cjs`: Tier-3 deterministic execution helper parsing CLI arguments, detecting base branch, inspecting working tree and committed diffs, generating the report, and applying auto-fixes.
- Base branch resolution order:
  - 1. Explicit `--base <ref>` argument if provided.
  - 2. `baseBranch` configured in `.sdw/config.json`.
  - 3. Tracking remote branch `refs/remotes/origin/main` or `refs/remotes/origin/master`.
  - 4. Local branch `refs/heads/main` or `refs/heads/master`.
  - 5. Fallback to `git merge-base HEAD origin/main` or initial commit.
- Orchestrator integration:
  - In `skills/sdw-orch/SKILL.md` and `skills/sdw-orch/references/orchestrator_protocol.md`, Step 7 is updated to state: `Dispatch subagent or CLI runner for sdw-code-review; inspect generated report to advance to Step 8 or trigger fix iteration.`
  - `skills/sdw-orch/scripts/sdw_orch.cjs` Step 7 delegates execution to `node skills/sdw-code-review/scripts/sdw_code_review.cjs` (or dispatches subagent in handoff mode) and parses the JSON report output.
  - Legacy `review_runner.cjs` in `skills/sdw-orch/scripts/` is replaced or delegated to `sdw-code-review`.
- Report format:
  - Header with target branch, base branch, reviewed commit/working tree summary, and status.
  - Table of findings: ID, Severity (`critical`, `warning`, `suggestion`), Path (`file:line`), Rule Citation, and Status (`open`/`fixed`).
  - Detailed findings section: For each finding, quotes the offending code hunk, states the failure scenario / rule violation, and provides the step-by-step fix prescription.
  - Can be passed directly to an agent as prompt context to execute the recommended fixes.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-stack matrix rule packs | Avoids overcomplicated framework definitions from legacy workflow-skills |
| Fable judge and fraud detection frameworks | Eliminates excessive prompt sediment and token consumption |
| Parallel multi-agent debate tournaments | Single subagent or deterministic script execution is faster and cheaper |
| Direct remote git push | Branch publishing belongs to sdw-ship-pr or sdw-orch |
| Automated pull request comment posting | Remote PR interaction belongs to sdw-ship-pr |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Base branch resolution precedence | Config `baseBranch` -> `origin/main` / `origin/master` -> `main` / `master` | Matches standard git conventions across multiple remote setups | y |
| Report file destination | Standalone: `.sdw/state/code-review.report.md`; Orch: `{stateDir}/{slug}/{runId}/{slug}-step-7.md` | Standardized audit trail locations that are easily parsed | y |
| Blocking finding severity | `critical` and `warning` block advance; `suggestion` is advisory | Prevents accumulation of quality and security defects | y |
| Auto-fix iteration ceiling | 3 iterations | Prevents infinite churn on non-fixable or conflicting findings | y |
| Delegation interface | Subagent dispatch or CLI execution with structured JSON output | Guarantees harness and agent agnosticism | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Rule Catalog Alignment | Rules grounded in Karpathy Guidelines and sdw-rules | Inspect ## Description and ## Acceptance Criteria |
| Strict EARS Syntax | All 17 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/025-sdw-code-review-skill.md` |
| Orchestrator Step 7 Contract | Delegation boundary and instruction deduplication defined | Inspect AC12, AC13, AC14, and ## Notes |
| Baseline Test Suite Pass | Existing unit test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output indicates base branch resolution, e.g. `[sdw-code-review] Comparing working tree and HEAD against base 'origin/main'...`.
- Summary line emitted: `[sdw-code-review] Code review passed with 0 findings.` or `[sdw-code-review] Code review failed with N blocking error(s).`.
- Structured JSON output emitted when `--json` flag is provided, containing `passed`, `errorCount`, `warningCount`, `suggestionCount`, and `findings` array.
- Markdown report artifact persisted at configured report destination with complete fix plan details.
- Orchestrator Step 7 logs indicating delegation to `sdw-code-review` and receipt of structured report output.

### Negative & Failing Test Scenarios

- Unresolvable base reference: When `--base` specifies an invalid or non-existent Git ref, `sdw-code-review` exits with code 1 and descriptive error message.
- Unresolved critical findings: When files contain active `debugger` statements, unresolved TODOs, or committed credentials that are not auto-fixed, `sdw-code-review` exits with code 1 and outputs the unresolved findings plan.
- Non-existent target directory: When `--target` points to an invalid path, `sdw-code-review` fails closed with code 1.
- Non-git workspace: When executed outside of a Git repository without Git history, `sdw-code-review` reports Git unavailability and exits with code 1.
