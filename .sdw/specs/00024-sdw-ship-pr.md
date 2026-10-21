---
id: null
slug: 00024-sdw-ship-pr
title: "SDW Ship PR Skill — Standalone Delivery, SCM Submission, and Review Convergence"
source: local
status: implemented
specDate: 2026-10-19
---

# Specification — SDW Ship PR Skill — Standalone Delivery, SCM Submission, and Review Convergence

## Description

The delivery and pull request lifecycle in SDW currently resides directly inside `sdw-orch` Step 8. This couples pre-PR verification gates (`prePrCommand`, `prePrInstructions`, `requiredBuild`, `runAllTests`), remote branch publishing (`pushDelivery`), SCM pull request creation/reuse (`createPullRequest`), and post-PR review convergence loops (`scmCodeReviewEnabled`) to the orchestrator state machine. This coupling inflates `sdw-orch` line count and context overhead, complicates environments where no SCM is configured (`scmProvider: "none"`), and prevents consumers from invoking delivery operations standalone outside of a full 8-step orchestrator run.

This specification refactors the PR preparation, delivery submission, and review convergence features into a dedicated, self-contained skill named `sdw-ship-pr`. The new skill operates both as an independent CLI tool (`node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` / `/sdw-ship-pr`) callable at any time with dedicated subcommands (`ship`, `list-threads`, `resolve-thread`, `check-status`), and as a delegated execution target consumed by `sdw-orch` Step 8. `sdw-orch` delegates the entire convergence lifecycle cleanly without embedding duplicated convergence, review, or fix instructions.

Furthermore, `sdw-ship-pr` implements a cooperative and proactive review convergence protocol inspired by `ws-fix-pr` and `COOPERATIVE_FIX.md`. Rather than treating reviewer feedback as isolated line edits, the skill identifies the underlying defect class and sweeps across sibling files in the pull request. It enforces a strict order of operations: wait for code reviews and CI checks to complete, fetch all active threads, apply cooperative fixes, verify tests, commit, push to remote, and only then resolve threads with an informative resolution comment citing the fixing commit SHA and defect class. A strict push-before-resolve invariant guarantees that no thread is closed before its fix is pushed to the remote branch.

### Design Intent

Preserve lean context budgets and modular separation of concerns. By extracting PR delivery and convergence into a standalone skill, `sdw-orch` remains focused on task decomposition, implementation dispatch, and conformance scoring. Consumers gain the flexibility to ship PRs for ad-hoc branches or existing commits without running the full orchestrator, while environments without remote SCM backends or automated review loops can bypass delivery machinery without carrying unnecessary instructions.

## Acceptance Criteria

- AC1: The system shall provide a standalone skill `sdw-ship-pr` under `skills/sdw-ship-pr/` conforming to the 3-Tier progressive disclosure standard.
- AC2: The system shall implement `sdw-ship-pr` with zero external runtime npm dependencies using Node.js 22 standard library only.
- AC3: The system shall expose CLI subcommands for `sdw-ship-pr` (`ship`, `list-threads`, `resolve-thread`, `check-status`) accepting `--run-id`, `--spec`, `--head`, `--base`, `--title`, `--body`, `--push`, `--poll-pr`, `--dry-run`, and `--json`.
- AC4: While executing pre-PR verification, the system shall evaluate `prePrInstructions`, `prePrCommand`, `requiredBuild`, `runAllTests`, and `securityChecksEnabled` from `.sdw/config.json`.
- AC5: If pre-PR verification gates fail after maximum automated fix attempts, then the system shall halt and return a non-zero exit code with actionable error details.
- AC6: While `pushDelivery` is true or `--push` is passed, the system shall push the active branch to the remote origin before creating a pull request.
- AC7: When `scmProvider` is set to `github` or `ado`, the system shall create or reuse an open pull request using the unified SCM provider contract.
- AC8: While `scmProvider` is set to `none`, the system shall skip remote pull request creation and report local delivery readiness without error.
- AC9: While `scmCodeReviewEnabled` is true or `--poll-pr` is passed, the system shall execute the post-PR review convergence loop, waiting for remote code reviews and CI checks to complete before evaluating active threads.
- AC10: When active review threads or failing checks are detected during convergence, the system shall fetch all active threads, execute cooperative and proactive fixes across sibling files, verify tests, commit review fixes, and push updates before resolving any threads.
- AC11: While `--dry-run` is passed, the system shall simulate pre-PR checks, branch pushing, PR creation, and review polling without executing remote mutations or git commits.
- AC12: While `sdw-orch` Step 8 executes, the orchestrator shall delegate PR delivery and review convergence to `sdw-ship-pr` without carrying internal convergence or review instructions.
- AC13: When `sdw-ship-pr` completes under `sdw-orch`, the orchestrator shall record PR metadata, delivery URL, and ship status into `.sdw/state/{runId}.state.json`.
- AC14: The system shall update `sdw-router` to discover and route ship, delivery, and PR convergence intents to `sdw-ship-pr`.
- AC15: The system shall provide automated test coverage validating standalone execution, orchestrator delegation, dry-run simulation, and config-driven skip conditions.
- AC16: When resolving a review comment or thread during convergence, the system shall post a resolution reply comment referencing the commit SHA and defect class, and mark the thread resolved on the remote SCM provider only after pushing the fix commit.
- AC17: The system shall implement `listReviewThreads` and `resolveReviewThread` in the SCM provider contract for both GitHub and Azure DevOps.
- AC18: When analyzing review feedback, the system shall execute a cooperative and proactive defect class sweep across all files changed in the pull request to resolve identical patterns.
- AC19: If an active review thread is addressed, then the system shall forbid resolving the thread without first pushing the fixing commit to the remote tracking branch.
- AC20: If a thread resolution comment is posted, then the system shall reject empty, whitespace-only, or hash-only resolution comments.
- AC21: Where a thread is resolved via `resolve-thread`, the system shall format the resolution comment with the standard prefix and commit reference.
- AC22: When CI checks are superseded by a newer push during convergence, the system shall wait out the superseded checks, reset the convergence window up to the preemption budget, and continue polling instead of halting.
- AC23: The system shall provide opt-in `merge` and `allow merge` invocation parameters that default to disabled.
- AC24: When merge is enabled and the pull request converged, the system shall issue exactly one merge command through the configured SCM provider CLI.
- AC25: If the merge command fails, then the system shall record the failure and keep the delivery outcome unchanged.
- AC26: When merge is enabled but convergence, a pull request, or an SCM provider is unavailable, the system shall skip the merge and record the skip reason.

## Notes

- Implementation layout:
  - `skills/sdw-ship-pr/SKILL.md`: Tier-1 skill definition with frontmatter, subcommands (`ship`, `list-threads`, `resolve-thread`, `check-status`), compact 8-step convergence cycle, and Done when criteria (≤ 120 lines).
  - `skills/sdw-ship-pr/references/ship_protocol.md`: Tier-2 reference detailing pre-PR checks, cooperative proactive resolution protocol, resolution comment contract, push-before-resolve invariant, and SCM provider convergence transitions.
  - `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs`: Tier-3 deterministic execution helper parsing CLI subcommands, reading `.sdw/config.json`, running pre-PR gates, creating PRs, fetching threads, driving review convergence, and resolving threads with structured comments.
- Cooperative convergence order of operations:
  1. Wait code-review and CI finish (polling until status settles).
  2. Query active threads via provider contract.
  3. If active threads exist: fetch all open threads and comments.
  4. Cooperative & proactive fix: identify defect class and fix all occurrences across related files.
  5. Verify: run test suite (`npm test`) to guarantee clean pass.
  6. Commit: stage surgical fix files and commit.
  7. Push: push fix commit to remote tracking branch.
  8. Close related threads with resolution comment citing the commit SHA, defect class, and explanation.
- Push-before-resolve invariant:
  - A thread must NEVER be marked resolved before the commit containing the fix is pushed to the remote tracking branch.
- Resolution comment contract:
  - Format: `<!-- resolution-reply -->\nResolved review issue: applied fix and verified acceptance criteria.\n\nFixed in commit {commitSha}.\n\nSummary: {summary}.\nDefect class: {defectClass}\nProactive sweep: {proactiveSweep}`.
- Orchestrator integration:
  - `skills/sdw-orch/SKILL.md` Step 8 delegates to `sdw-ship-pr` without carrying internal review convergence loops.
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
| Authoring Standard | Specification passes EARS authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00024-sdw-ship-pr.md` |
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
