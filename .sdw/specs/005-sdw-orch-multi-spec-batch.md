---
id: null
slug: 005-sdw-orch-multi-spec-batch
title: "SDW Orchestrator Multi-Spec Batch Execution"
source: local
specDate: 2026-10-19
---

# Specification — SDW Orchestrator Multi-Spec Batch Execution

## Description

The `sdw-orch` orchestrator coordinates the implementation of specifications from derivation through pull request preparation. This specification introduces multi-specification batch execution, enabling users and agents to enqueue and execute multiple specifications sequentially via a single unified command (e.g. `sdw-orch run spec1.md spec2.md spec3.md`).

To preserve subagent context isolation and prevent conversational or syntactic pollution across tasks, each specification in the queue executes in an isolated child run context with its own independent state file (`.sdw/state/{runId}.state.json`). 

A dedicated Tier 3 batch runner module manages queue orchestration through a lightweight manifest (`.sdw/state/batch-{batchId}.json`). The batch engine coordinates pre-flight validation, sequential execution, failure recovery policies (`--continue-on-error` vs. default halt-on-error), automatic index synchronization via `sdw-spec sync`, and batch resumption.

Furthermore, multi-specification batch execution operates in mandatory unattended mode: the orchestrator runs continuously through every specification from first to last without halting between specifications for conversational check-ins or user confirmation, auto-resolving grilling and refinement decision gaps with recommended defaults.

### Design Intent

Extends the single-specification `sdw-orch` orchestrator with multi-specification queueing capabilities without bloating the Tier 1 agent context window. By maintaining strict subagent context fencing per specification and encapsulating queue state logic in a dedicated Tier 3 batch runner module, the architecture achieves optimal token efficiency, ergonomic CLI invocations, and deterministic batch recovery.

## Acceptance Criteria

- AC1: The system shall support variadic specification arguments for the `run` subcommand to execute multiple specifications in sequential queue order.
- AC2: When multiple specifications are provided, the system shall initialize a batch manifest file at `{stateDir}/batch-{batchId}.json` tracking queue progress.
- AC3: When processing each specification in a batch queue, the system shall execute an isolated orchestrator run with its own dedicated run state file.
- AC4: When a specification in the batch queue completes execution successfully, the system shall update the batch manifest and invoke `sdw-spec sync` to reconcile specification status.
- AC5: If a specification in the batch queue fails execution and the continue-on-error flag is omitted, then the system shall halt batch execution and record the failure state in the batch manifest.
- AC6: Where the continue-on-error flag is provided via `--continue-on-error`, the system shall log the failed specification and continue processing subsequent specifications in the queue.
- AC7: When the `resume-batch` subcommand is executed, the system shall restore queue state from the specified or latest batch manifest and resume from the first non-completed specification.
- AC8: If an input specification file in the batch queue does not exist on disk, then the system shall reject starting the batch before any specifications execute.
- AC9: Where the dry-run flag is provided via `--dry-run`, the system shall validate all queued specifications and display the execution plan without executing any tasks.
- AC10: When all specifications in the batch complete, the system shall emit a comprehensive summary report displaying per-specification execution status, elapsed duration, and commit or pull request references.
- AC11: While executing a batch item, the system shall fence subagent context to the current specification without leaking transcripts from preceding batch items.
- AC12: While executing a multi-specification batch queue, the system shall run continuously in unattended mode from first to last specification without conversational check-ins or user confirmation between specifications.
- AC13: While executing a batch queue, the system shall auto-resolve specification decision gaps using recommended defaults.

## Original Issue Context

The user requested native multi-specification orchestration:

> propose a way of implementing multiple specs with existing orchestrator. Is it better to create a separated skill for orchestrating multiple orchestrators (queue loop calling sdw-orch or add an additional mode to existing orchestrator ? I would like to call the parent multi-orchestrator passing as parameters the references of specs I wish to enqueue to implement like sdw-orch spec1, spec2, spec3, etc
>
> yes author the new spec formalizing as suggested

## Notes

- Command-line syntax:
  ```bash
  # Variadic execution
  node skills/sdw-orch/scripts/sdw_orch.cjs run <spec1> <spec2> ... [options]

  # Options:
  #   --continue-on-error   Continue executing subsequent queue items on failure
  #   --dry-run             Validate specs and print batch plan without execution
  #   --no-sync             Skip auto-invocation of sdw-spec sync between specs

  # Resumption
  node skills/sdw-orch/scripts/sdw_orch.cjs resume-batch [batchId]
  ```
- Batch manifest schema (`.sdw/state/batch-{batchId}.json`):
  ```json
  {
    "batchId": "batch-1792386000000",
    "createdAt": "2026-10-19T00:55:00.000Z",
    "updatedAt": "2026-10-19T00:58:00.000Z",
    "status": "in_progress",
    "policy": {
      "continueOnError": false,
      "syncIndex": true
    },
    "total": 3,
    "currentIndex": 1,
    "queue": [
      {
        "index": 0,
        "spec": ".sdw/specs/001-feature.md",
        "slug": "001-feature",
        "status": "completed",
        "runId": "run-1792386010000-001-feature",
        "branch": "feature/001-feature",
        "deliveryCommit": "abc1234",
        "durationMs": 45000,
        "error": null
      },
      {
        "index": 1,
        "spec": ".sdw/specs/002-feature.md",
        "slug": "002-feature",
        "status": "in_progress",
        "runId": "run-1792386050000-002-feature",
        "branch": "feature/002-feature",
        "deliveryCommit": null,
        "durationMs": null,
        "error": null
      }
    ]
  }
  ```
- Subagent context fencing: each queue item is dispatched as an independent subagent or process execution, preventing token exhaustion and cross-task context contamination.
- State directory resolution: reads `stateDir` from `.sdw/config.json`, falling back to `{projectRoot}/.sdw/state`.
- All automation scripts must be implemented in Node.js 22 CommonJS (`.cjs`) using standard library modules only (`fs`, `path`, `process`, `child_process`).
- Orchestrator Path (spec 004): batch execution targets the canonical `skills/sdw-orch/scripts/sdw_orch.cjs`; no wrapper for the removed `sdw-implement` path is maintained.
- Side-Effect-Free Dry Run: `--dry-run` validates and prints the batch plan only; it must not create branches, worktrees, commits, or `in_progress` batch manifests.
- Branch & Worktree Interaction (spec 010): when `useFeatureBranches` or `useWorktrees` are enabled, each queued item executes on its own feature branch with per-task worktrees; the pre-flight clean-tree check applies between items and the active branch is recorded per queue entry.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Parallel / concurrent multi-spec execution | Concurrent runs risk conflicting git operations and branch collisions; execution is strictly FIFO sequential |
| Cross-repository multi-batch orchestration | Each batch executes within the boundary of a single workspace repository |
| Automatic interactive resolution of ambiguous grilling gaps in batch mode | Unresolvable decision gaps without defaults halt the batch item unless `--auto-resolve-gaps` is enabled |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Execution scheduling | Strictly sequential (FIFO) | Ensures deterministic git history, predictable branch state, and clean isolation | y |
| Default failure policy | Halt on first error (`continueOnError: false`) | Prevents cascading failures on interdependent specifications | y |
| State manifest location | `{stateDir}/batch-{batchId}.json` | Co-locates batch manifests with individual run state files | y |
| Post-spec index sync | Auto-invokes `sdw-spec sync` on success | Keeps `{specsDir}/index.specs.md` immediately synchronized with batch progress | y |
| Absent lifecycle dimensions | N/A because execution is local CLI/agent tool invocation | Local agent execution model | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Orchestrator entrypoint | Script `sdw_orch.cjs` exists in `skills/sdw-orch/scripts/` | Verify script exists and exports `cmdRun` and `cmdBatchRun` |
| Target specifications | All referenced specification files exist and are readable | Run pre-flight check in batch runner |
| Spec format validity | Queued specs pass authoring validation | Run `validate_spec.cjs` against all queued specs |
| Git repository state | Workspace is a valid Git repository with clean working tree | Run `git status` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Batch initialization banner displaying total enqueued items and batch ID.
- Progress updates emitted before each item begins: `[sdw-orch batch] [X/Y] Starting specification: <slug>`.
- Item completion log displaying duration and status.
- Final tabular summary output reporting each specification's status, duration, delivery commit, and PR URL.
- Machine-readable JSON output when invoked with `--json`.

### Negative & Failing Test Scenarios

- Pre-flight missing specification rejection: when one specification in a multi-spec argument list does not exist on disk, the batch runner must abort immediately before any specification executes.
- Default halt-on-error enforcement: when a specification in the batch fails at conformance scoring or review and `--continue-on-error` is false, remaining specifications must remain `queued` and unexecuted.
- Continue-on-error queue progression: when `--continue-on-error` is specified and an item fails, the batch runner must record the failure and proceed to execute remaining queue items.
- Interrupted batch resumption: when a batch halted midway is resumed via `resume-batch`, already completed specifications must be skipped and execution must resume from the first non-completed item.
