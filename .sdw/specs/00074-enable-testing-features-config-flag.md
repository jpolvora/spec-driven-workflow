---
id: null
slug: 00074-enable-testing-features-config-flag
title: "Configurable Testing Features Toggle to Enable or Disable Test Generation, Execution, and Subagent Segregation"
source: local
status: ready-to-implement
specDate: 2026-11-21
priority: high
---
# Specification — Configurable Testing Features Toggle to Enable or Disable Test Generation, Execution, and Subagent Segregation

## Description

In many software development contexts, projects are lightweight, prototyping-focused, or script-based where dedicated test suites, automated unit test generation, and segregated test-author subagents introduce unnecessary token overhead, execution latency, and workflow complexity. Previously, Spec 00073 introduced mandatory test authoring segregation (`segregateTests: true` by default), and pre-PR gates enforced test suite runs whenever test commands or `runAllTests` were present.

This specification introduces a global master configuration flag `enableTestingFeatures` in `.sdw/config.json`, defaulting to `false`. When disabled (`enableTestingFeatures: false`), the workflow skips all testing-related activities across all stages:
1. In Step 2 (Refinement), test plan authoring and test target file requirements are omitted.
2. In Step 3 (DAG Planning), test author tasks (`role: 'test_author'`) and test segregation pairs are not generated. Direct single implementation tasks are produced instead. Implementation prompts instruct workers to deliver acceptance criteria directly without referring to immutable test suites.
3. In Step 4 (Implementation & Integrated Tree Verification), test suite execution is skipped and recorded as skipped in the run state.
4. In Step 7 (Code Review) and `sdw-code-review`, review findings do not prescribe re-running test suites.
5. In Step 8 (Delivery & Pre-PR Verification) and `sdw-ship-pr`, pre-PR test suite gates and post-PR review-fix test execution loops are skipped, recording `skipped` on the pre-PR verification board.

When explicitly enabled (`enableTestingFeatures: true`), the system restores full test generation, test-author agent segregation, and test execution verification gates.

### Design Intent

Provide ultimate workflow adaptability and simplicity for simple, lean, or prototype projects. A developer building a utility script, document generator, or small internal tool should not be burdened with subagent test segregation or mandatory test suites. The default `enableTestingFeatures: false` ensures that the default workflow remains fast, lightweight, and focused purely on implementation, while projects requiring rigorous test guarantees can opt in via `enableTestingFeatures: true`.

## Acceptance Criteria

- AC1: The system shall provide a configurable setting `enableTestingFeatures` in `.sdw/config.json` defaulting to `false`.
- AC2: While `enableTestingFeatures` is `false`, the DAG planner (Step 3) shall omit test authoring tasks (`role: 'test_author'`) and generate only direct implementation tasks.
- AC3: While `enableTestingFeatures` is `false`, the system shall bypass test agent segregation regardless of the `implementation.segregateTests` setting.
- AC4: While `enableTestingFeatures` is `false`, the system shall generate implementation task prompts that instruct workers to satisfy assigned acceptance criteria directly and reference `sdw-rules` without referencing existing test suites or test modification prohibitions.
- AC5: While `enableTestingFeatures` is `false`, the system shall skip test suite execution during Step 4 integrated tree verification gates.
- AC6: While `enableTestingFeatures` is `false`, the system shall record the test verification gate status as skipped in the run state.
- AC7: While `enableTestingFeatures` is `false`, the system shall skip test suite execution during Step 8 and `sdw-ship-pr` pre-PR verification gates.
- AC8: While `enableTestingFeatures` is `false`, the system shall record tests as skipped on the pre-PR verification board (`boardRow('tests', 'skipped', 'enableTestingFeatures is false')`).
- AC9: While `enableTestingFeatures` is `false`, the `sdw-ship-pr` skill shall skip test command execution during post-PR review fix convergence loops.
- AC10: While `enableTestingFeatures` is `false`, the `sdw-code-review` skill shall omit instructions to re-run test suites from review finding fix prescriptions.
- AC11: While `enableTestingFeatures` is `false`, the refinement runner (Step 2) shall omit test plan requirements and test target files from the generated blueprint.
- AC12: While `enableTestingFeatures` is `false`, the system shall allow configuration validation to pass without `verification.testCommand` even if `runAllTests` is present.
- AC13: Where `enableTestingFeatures` is set to `true`, the system shall execute test author task generation, paired test segregation, and test suite execution gates.
- AC14: The system shall register `enableTestingFeatures` as a boolean property in `.sdw/config.schema.json` and validate its type in `sdw-config`.
- AC15: The system shall update skill instructions, reference documents, and protocols across `sdw-run`, `sdw-ship-pr`, `sdw-code-review`, `sdw-config`, and `sdw-rules` to document the `enableTestingFeatures` toggle.
- AC16: The system shall add automated unit tests verifying DAG generation, gate suppression, pre-PR board skipping, and configuration validation when `enableTestingFeatures` is `false`.

## Notes

- Configuration schema updates:
  - Add root property `"enableTestingFeatures": { "type": "boolean", "default": false, "description": "Global master toggle for testing features. When false, test generation, test execution, test runner gates, and test segregation agents are disabled." }`.
- Implementation surfaces:
  - `skills/sdw-config/scripts/sdw_config.cjs` & `skills/sdw-config/references/config.schema.json`: schema validation and default derivation.
  - `skills/sdw-run/scripts/dag_planner.cjs`: checks `enableTestingFeatures !== false` before generating paired test author tasks.
  - `skills/sdw-run/scripts/implementation_runner.cjs`: adjusts prompt templates when `enableTestingFeatures` is disabled.
  - `skills/sdw-run/scripts/sdw_run.cjs`: suppresses Step 4 test command execution when `enableTestingFeatures: false`.
  - `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs`: skips Step 2 pre-PR test gates and Step 6 review-fix test runs when `enableTestingFeatures: false`.
  - `skills/sdw-code-review/scripts/sdw_code_review.cjs`: removes test re-run steps from remediation prescriptions when testing features are disabled.
  - `skills/sdw-rules/SKILL.md`: clarifies that Rule 8 (Immutable Test Assertions) and Rule 6 (Goal-Driven Verification) apply within the scope of the configured testing features.

## Out of Scope

| Feature | Reason |
|---|---|
| Dynamic test runner auto-detection | Keep configuration explicit and deterministic; zero external dependencies |
| Per-task testing feature toggles | Granularity is project-level or specification-level, not per individual micro-task |
| Removal of existing project tests | Disabling testing features suppresses generation and execution; it does not delete existing files |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Default value | `false` | As requested by user; caters to simple projects and minimizes token/subagent overhead | y |
| Precedence over `runAllTests` | `enableTestingFeatures` dominates | A master switch must cleanly disable all subordinate test gates without requiring multiple edits | y |
| Prompt shape | Direct implementation prompt | When tests are disabled, workers should focus strictly on acceptance criteria implementation | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Specification syntax | Valid EARS format and section hierarchy | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring` |
| Zero runtime dependencies | Node.js 22 built-ins only | Code inspection |
| Opt-in symmetry | Setting `enableTestingFeatures: true` restores full testing features | Automated unit tests |

## Validation & Observation Notes

### Telemetry & Observable Signals
- Step 3 DAG generation outputs: `[Step 3: DAG Generation] Testing features disabled (enableTestingFeatures: false); skipping test task generation.`
- Step 4 verification gate outputs: `[Step 4: Verification Gate] Test execution skipped (enableTestingFeatures: false).`
- Step 8 pre-PR board contains row: `| tests | skipped | enableTestingFeatures is false |`.
- Dispatch prompt logs show direct implementation instructions without test suite references.

### Negative & Failing Test Scenarios
- When `enableTestingFeatures` is `false` and a broken test file exists in `tests/`, `sdw-run` Step 4 and `sdw-ship-pr` Step 2 do NOT fail because the test gate is skipped.
- When `enableTestingFeatures` is not a boolean (e.g. `"yes"`), `sdw-config` validation fails with an actionable error.
