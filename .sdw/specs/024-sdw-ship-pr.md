---
id: null
slug: 024-sdw-ship-pr
title: "SDW Ship PR Skill — Standalone Delivery, SCM Submission, and Review Convergence"
source: local
specDate: 2026-10-19
---

# Specification — SDW Ship PR Skill — Standalone Delivery, SCM Submission, and Review Convergence

## Description

The delivery and pull request lifecycle in SDW currently resides directly inside `sdw-orch` Step 8. This couples pre-PR verification gates (`prePrCommand`, `prePrInstructions`, `requiredBuild`, `runAllTests`), remote branch publishing (`pushDelivery`), SCM pull request creation/reuse (`createPullRequest`), and post-PR review convergence loops (`scmCodeReviewEnabled`) to the orchestrator state machine. This coupling inflates `sdw-orch` line count and context overhead, complicates environments where no SCM is configured (`scmProvider: "none"`), and prevents consumers from invoking delivery operations standalone outside of a full 8-step orchestrator run.

This specification refactors the PR preparation, delivery submission, and review convergence features into a dedicated, self-contained skill named `sdw-ship-pr`. The new skill operates both as an independent CLI tool (`node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` / `/sdw-ship-pr`) callable at any time, and as a delegated execution target consumed by `sdw-orch` Step 8. `sdw-ship-pr` strictly respects all related options in `.sdw/config.json` (`scmProvider`, `pushDelivery`, `scmCodeReviewEnabled`, `requiredBuild`, `runAllTests`, `prePrCommand`, `prePrInstructions`), supporting dry-run execution, decoupled error handling, and structured JSON output.

### Design Intent

Preserve lean context budgets and modular separation of concerns. By extracting PR delivery and convergence into a standalone skill, `sdw-orch` remains focused on task decomposition, implementation dispatch, and conformance scoring. Consumers gain the flexibility to ship PRs for ad-hoc branches or existing commits without running the full orchestrator, while environments without remote SCM backends or automated review loops can bypass delivery machinery without carrying unnecessary instructions.

## Acceptance Criteria

- AC1: The system shall provide a standalone skill `sdw-ship-pr` under `skills/sdw-ship-pr/` conforming to the 3-Tier progressive disclosure standard.
- AC2: The system shall implement `sdw-ship-pr` with zero external runtime npm dependencies using Node.js 22 standard library only.
- AC3: The system shall expose CLI commands for `sdw-ship-pr` accepting `--run-id`, `--spec`, `--head`, `--base`, `--title`, `--body`, `--push`, `--poll-pr`, `--dry-run`, and `--json`.
- AC4: While executing pre-PR verification, the system shall evaluate `prePrInstructions`, `prePrCommand`, `requiredBuild`, `runAllTests`, and `securityChecksEnabled` from `.sdw/config.json`.
- AC5: If pre-PR verification gates fail after maximum automated fix attempts, then the system shall halt and return a non-zero exit code with actionable error details.
- AC6: While `pushDelivery` is true or `--push` is passed, the system shall push the active branch to the remote origin before creating a pull request.
- AC7: When `scmProvider` is set to `github` or `ado`, the system shall create or reuse an open pull request using the unified SCM provider contract.
- AC8: While `scmProvider` is set to `none`, the system shall skip remote pull request creation and report local delivery readiness without error.
- AC9: While `scmCodeReviewEnabled` is true or `--poll-pr` is passed, the system shall execute the post-PR review convergence loop, polling CI status and reviewer comments.
- AC10: When review comments or failing checks are detected during convergence, the system shall execute surgical fixes, verify tests, commit review fixes, and push updates up to the configured iteration ceiling.
- AC11: While `--dry-run` is passed, the system shall simulate pre-PR checks, branch pushing, PR creation, and review polling without executing remote mutations or git commits.
- AC12: While `sdw-orch` Step 8 executes, the orchestrator shall delegate PR delivery by invoking `sdw-ship-pr` with the active run ID and specification parameters.
- AC13: When `sdw-ship-pr` completes under `sdw-orch`, the orchestrator shall record PR metadata, delivery URL, and ship status into `.sdw/state/{runId}.state.json`.
- AC14: The system shall update `sdw-router` to discover and route ship, delivery, and PR convergence intents to `sdw-ship-pr`.
- AC15: The system shall provide automated test coverage validating standalone execution, orchestrator delegation, dry-run simulation, and config-driven skip conditions.
- AC16: When resolving a review comment or thread during convergence, the system shall post a reply comment summarizing how the issue was resolved and mark the thread or comment resolved on the remote SCM provider.
- AC17: The system shall implement `listReviewThreads` and `resolveReviewThread` in the SCM provider contract for both GitHub and Azure DevOps.

## Notes

- Implementation layout:
  - `skills/sdw-ship-pr/SKILL.md`: Tier-1 skill definition with frontmatter, subcommands, compact state steps, and Done when criteria (≤ 120 lines).
  - `skills/sdw-ship-pr/references/ship_protocol.md`: Tier-2 reference detailing pre-PR checks, SCM provider interaction, and convergence state transitions.
  - `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs`: Tier-3 deterministic execution helper parsing CLI arguments, reading `.sdw/config.json`, running pre-PR gates, creating PRs, and driving review convergence.
- Orchestrator integration:
  - `skills/sdw-orch/scripts/sdw_orch.cjs` Step 8 invokes `sdw-ship-pr` via command execution (`node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --run-id <runId> ...`) or programmatic module call when available.
  - Step 8 updates `state.steps[8]` with `sdw-ship-pr` JSON output (`pullRequest`, `shipStatus`, `pushedBranch`, `reviewConvergence`).
- Router integration:
  - Update `skills/sdw-router/scripts/sdw_router.cjs` and `references/routing_table.md` to map `ship`, `deliver`, `create-pr`, `pr-review`, and `converge` keywords to `sdw-ship-pr`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing `gh` or `az` CLI binaries | Host CLI tools remain universal provider anchors |
| Multi-repository release pipelines | Releases are handled by release automation, not single PR shipping |
| Full GitHub/Azure DevOps thread webhook listeners | Polling loop via CLI status is deterministic and portable across agent runtimes |
| UI Kanban boards for shipping | Dedicated to CLI and state file representations |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Delegation mechanism | CLI / programmatic dual invocation | Allows standalone script execution and testable in-process invocation | y |
| SCM disabled behavior | Skip remote actions and exit 0 | Matches `scmProvider: "none"` specification contract | y |
| Standalone branch default | Current git branch (`HEAD`) | Standalone users expect the currently checked-out branch to ship | y |
| Review iteration ceiling | 3 rounds of automated fix attempts | Prevents infinite retry loops on intractable review comments | y |
| State persistence during delegation | `sdw-ship-pr` writes to state file when `--run-id` provided | Preserves single source of truth for run state | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| SCM Provider Contract | `createPullRequest` implemented for `github` and `ado` | Inspect `skills/sdw-spec/scripts/scm_provider_contract.cjs` |
| Configuration Schema | `scmCodeReviewEnabled`, `pushDelivery`, `scmProvider` declared | Inspect `.sdw/config.schema.json` |
| Authoring Standard | Specification passes EARS authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/024-sdw-ship-pr.md` |
| Base Test Suite | Existing unit test suite passes cleanly | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output indicates pre-PR verification progress, e.g. `[sdw-ship-pr] Evaluating pre-PR requirements...`.
- SCM pull request creation logs output with URL: `[sdw-ship-pr] Pull request created/reused: https://...`.
- State file `.sdw/state/{runId}.state.json` contains structured `pullRequest` object with `number`, `url`, `head`, `base`, `reused`, and `shipStatus`.
- When `--dry-run` is active, console output prints planned actions with `(dry-run)` marker and does not execute git commits or remote pushes.

### Negative & Failing Test Scenarios

- Pre-PR test gate failure: When `runAllTests: true` and tests fail without auto-fix, `sdw-ship-pr` exits with code 1 and records the failure.
- Secret leak detected: When `securityChecksEnabled: true` and pre-PR changes contain a secret, `sdw-ship-pr` halts with code 1 without committing.
- SCM CLI not installed: When `scmProvider: "github"` but `gh` is missing, `sdw-ship-pr` returns code 1 with an actionable installation error.
- Non-existent branch: When `--head` specifies a branch that does not exist, `sdw-ship-pr` fails closed before remote push.
- Review convergence timeout: When review threads remain unresolved after maximum iterations, `sdw-ship-pr` reports unresolved status.
