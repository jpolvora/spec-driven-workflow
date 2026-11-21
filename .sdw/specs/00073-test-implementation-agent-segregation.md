---
id: null
slug: 00073-test-implementation-agent-segregation
title: "Test and Implementation Agent Segregation in Orchestrator Dispatch"
source: local
status: implemented
specDate: 2026-11-19
priority: high
---
# Specification — Test and Implementation Agent Segregation in Orchestrator Dispatch

## Description

The current SDW orchestrator (`sdw-run`) dispatches a single worker per DAG task that writes both implementation code and verification tests in the same conversation turn. This creates an implementer bias where workers weaken test assertions, remove tests, or mock out components to achieve passing status before delivery.

This specification introduces strict context and role segregation between test authoring and code implementation. Step 4 supports paired test and implementation sub-tasks with non-overlapping scope fences. Test author agents write tests derived strictly from specification acceptance criteria without modifying production code. Implementation agents write production code against the immutable test suite and are strictly prohibited from modifying test files. The orchestrator enforces this boundary deterministically at the `task finish` gate.

### Design Intent

Preserve test objectivity and eliminate self-grading moral hazard. Tests must serve as an external, immutable contract derived from the specification. By executing test authoring and code implementation in separate subagent contexts with mutually exclusive file scope fences, the system guarantees that green tests reflect genuine specification conformance rather than adjusted test assertions.

## Acceptance Criteria

- AC1: The system shall provide a configurable setting `implementation.segregateTests` in `.sdw/config.json` defaulting to `true`.
- AC2: When `implementation.segregateTests` is enabled, the DAG planner (Step 3) shall decompose each testable requirement unit into a sequential pair: a test authoring task and an implementation task.
- AC3: The system shall assign test authoring tasks a scope fence containing only test files matching configured test file patterns.
- AC4: The system shall assign implementation tasks a scope fence containing only production code files and explicitly excluding all test files.
- AC5: When generating dispatch prompts for test authoring tasks, the system shall include instructions to write failing tests strictly asserting assigned acceptance criteria without modifying production code.
- AC6: When generating dispatch prompts for implementation tasks, the system shall include instructions to satisfy the existing test suite and declare test file modifications strictly prohibited.
- AC7: When an implementation task submits evidence via `task finish`, the orchestrator shall verify that `filesChanged` contains no paths matching test file patterns.
- AC8: If an implementation task attempts to submit evidence containing modified test files, then the system shall reject the submission with an actionable error and exit code 1.
- AC9: When a test authoring task submits evidence via `task finish`, the orchestrator shall verify that `filesChanged` contains only test files and no production files.
- AC10: If a test authoring task attempts to submit evidence containing modified production files, then the system shall reject the submission with an actionable error and exit code 1.
- AC11: The system shall record the task role (`test_author` or `implementation`) in run state under `steps["4"].tasks[taskId]`.
- AC12: The system shall create an atomic checkpoint commit and tag for completed test authoring tasks before dispatching the corresponding implementation task.
- AC13: Where `implementation.segregateTests` is disabled, the system shall preserve single-worker task dispatch with combined scope fences.
- AC14: The system shall add a non-negotiable directive to `sdw-rules` prohibiting code implementers from modifying test assertions to force test passes.
- AC15: The system shall add automated tests validating paired DAG generation, test task scope fencing, implementation task scope fencing, and rejection of prohibited test modifications at `task finish`.

## Notes

- Implementation surfaces:
  - `skills/sdw-run/scripts/dag_planner.cjs`: paired task generation logic when `segregateTests: true`.
  - `skills/sdw-run/scripts/implementation_runner.cjs`: prompt rendering with role-specific prohibitions and scope fences.
  - `skills/sdw-run/scripts/evidence_validator.cjs` / `sdw_run.cjs`: role-based `filesChanged` validation against test patterns.
  - `skills/sdw-rules/SKILL.md` and `skills/sdw-rules/references/anti_patterns.md`: test tampering prohibition directive.
  - `.sdw/config.schema.json` and `.sdw/config.json`: `implementation.segregateTests` and `implementation.testPatterns` definitions.
- Default test patterns: `["tests/**", "**/*.test.*", "**/*.spec.*"]`.

## Out of Scope

| Feature | Reason |
|---|---|
| Mutation testing frameworks | Heavy external npm dependencies violate zero-dependency guarantee |
| Automated test re-writing on refactoring | Test updates must be authored by a dedicated test agent or user |
| Cross-spec test isolation | Scope is bounded to the active specification and run |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Default segregation state | Enabled (`true`) | Enforces test integrity by default across all runs | y |
| Test file detection | Glob patterns in config | Simple, portable across languages and test frameworks | y |
| Rollback on rejection | Abandon task and keep clean | Prevents dirty state contamination between workers | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Specification syntax | Valid EARS format and section hierarchy | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring` |
| Zero runtime dependencies | Node.js 22 built-ins only | Code inspection |
| Backward compatibility toggle | Config flag allows opt-out | Automated unit tests |

## Validation & Observation Notes

### Telemetry & Observable Signals
- Task dispatch output indicates `[role: test_author]` or `[role: implementation]`.
- State file `steps["4"].tasks[taskId].role` accurately records role.
- Distinct checkpoint commits: `task(slug): task-1-test` and `task(slug): task-1-impl`.

### Negative & Failing Test Scenarios
- Implementation worker modifies `tests/my_test.test.cjs`: `task finish` fails with exit 1 and message `Rejecting task: implementation worker modified test file tests/my_test.test.cjs`.
- Test author worker modifies `skills/sdw-run/scripts/sdw_run.cjs`: `task finish` fails with exit 1 and message `Rejecting task: test author worker modified production file skills/sdw-run/scripts/sdw_run.cjs`.
