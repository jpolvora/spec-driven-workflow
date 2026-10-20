---
name: sdw-orch
description: End-to-end workflow orchestrator that coordinates spec execution, subagent dispatch, review loops, and delivery.
version: 0.1.0
invocation_names:
  - sdw-orch
  - sdw-orch run
  - sdw-orch resume
  - sdw-orch status
  - sdw-orchestrator
  - orch
---
# sdw-orch

> When this skill is loaded, output "sdw-orch loaded."

Orchestrates spec execution from input requirement to delivery commit, automated code review, and pull request.

## Subcommands

- `run <specPath...>`: Executes the full 8-step workflow pipeline for single specification or unattended multi-spec batch queue.
- `task next [--run-id <runId>] [--json]`: Dispatches the next ready DAG task and emits its dispatch envelope (subagent mode).
- `task finish --run-id <runId> --task <taskId> --evidence <evidencePath>`: Validates the dispatched task's evidence and accepts it.
- `task abandon --run-id <runId> --task <taskId> --reason <text>`: Returns the dispatched task to the queue after a lost or failed worker.
- `score submit --run-id <runId> --verdict <path>`: Submits the Step 5 judge verdict and applies the conformance score.
- `resume`: Resumes an interrupted or paused run from its last recorded step in `.sdw/state/{runId}.state.json`.
- `resume-batch [batchId]`: Resumes an interrupted or halted batch queue from the first non-completed specification.
- `status`: Displays current execution progress, conformance score, and step status.

## Multi-Spec Unattended Mode (Mandatory Batch Protocol)

When executing multiple specifications (`run <spec1> <spec2> ...` or batch queue):
- **Continuous Unattended Execution:** Run uninterrupted through every specification from first to last without halting between specs for conversational check-ins or user confirmation.
- **Autonomous Gap Resolution:** Grilling decision gaps auto-resolve with recommended defaults (`autoResolveGaps`).
- **Continuous Queue Progression:** For each spec, complete DAG implementation, test verification (`npm test`), conformance scoring (≥ threshold), delivery commit, and code review, then immediately advance to the next queued spec.
- **Terminal Consolidation Only:** Halt only on unrecoverable failure (if `--continue-on-error` is omitted) or dispatch pause (code 4). Present the consolidated batch summary report after completion.

## Steps

1. **Spec Ingestion & Derivation**
   Resolve project root and create isolated run state in `.sdw/state/{runId}.state.json`. If `useFeatureBranches: true`, activate feature branch (`feature/{specSlug}`); dirty trees are allowed and never block execution. If the spec is human-friendly, derive an agentic spec; if already formatted, skip derivation.
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> [options]`
   - Done when: Run state exists on disk, branch is active, and derivation status recorded.

2. **Conduct Refinement Round**
   Walk decision tree paths for input bounds, failure recovery, and concurrency, producing a technical blueprint. In single-spec mode, query user via `ask_question` if ambiguous gaps remain. In batch mode, auto-resolve gaps using recommended defaults.
   - Done when: Decision gaps resolved, blueprint generated, and refinement artifact `{slug}-step-2.md` persisted.

3. **Decompose into DAG Tasks**
   Analyze complexity and emit DAG execution units with context prompts and dependency graphs.
   - Done when: DAG tasks generated, and DAG artifact `{slug}-step-3.md` persisted.

4. **Implementation Execution (Sequential Subagent Dispatch)**
   In `subagent` mode (default), dispatch exactly one ready DAG task and pause with exit code 4. Each brief carries the `sdw-rules` simplicity constraints (minimum code, surgical scope, no unrequested features). For each envelope: spawn one subagent that reads the prompt file and executes it as written, wait for its report, then submit `task finish`. If the worker reports a non-`success` status or never returns, run `task abandon --reason` and dispatch again. In `command` mode, execute the configured subprocess in topological DAG order. Worktrees are command-mode only; subagent mode uses the primary tree with dispatch-baseline corroboration. Once every task is accepted, run build and test verification gates.
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs task next --run-id <runId>`
   - Done when: Every DAG task has accepted evidence, corroborated against its dispatch baseline, and build/test gates pass.
   - Exit codes: `4` dispatch pause (normal), `1` failure.

5. **Evaluate Conformance Score (LLM judge)**
   Score conformance with an LLM judge fenced to the acceptance criteria plus the generated diff — never transcripts. Per-criterion verdicts drive the score (`round(verified / total * 10)`); `scoring.judgeCriticity` sets strictness. When `scoring.judgeCommand` is unset, the current agent model judges: Step 5 writes `step-5-judge.prompt.md`, pauses with exit code 5, and accepts a verdict through `score submit`. Zero criteria, an unavailable judge, or a malformed verdict fails closed at 0/10. Below `scoreMin` (default 8/10) triggers the re-implementation loop (exit code 2).
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs score submit --run-id <runId> --verdict <path>`
   - Done when: The judge verdict covers every criterion and the derived score meets the threshold, with the scoring artifact `{slug}-step-5.md` persisted.

6. **Delivery Commit & Security Gate**
   Refuse delivery commit if Step 4 is incomplete, any task unaccepted, or any gate failed. Run pre-commit secret leak scan (`sdw-security-checks`) when enabled. Stage and commit only tracked spec files (accepted evidence `filesChanged` + `index.specs.md`); unrelated worktree changes are never staged.
   - Done when: Step 4 quality guards pass, pre-commit security check passes, and scoped delivery commit exists.

7. **Delegated Code Review via sdw-code-review**
   Dispatch subagent or CLI runner for `sdw-code-review`; inspect generated report to advance to Step 8 or trigger fix iteration.
   - Run: `node skills/sdw-code-review/scripts/sdw_code_review.cjs run --target <root> [--base <ref>] --report <artifact> [--fix] [--json]`
   - `sdw-code-review` is the sole code review authority; no duplicated internal review instructions.
   - Done when: Report shows 0 blocking findings (`critical`/`warning`) or fix ceiling reached with residual recorded.

8. **PR Preparation, Delivery & Review Convergence**
   Delegate pull request preparation, pre-PR verification gates, remote publishing, SCM submission, and post-PR review convergence to `sdw-ship-pr`. Pass active run ID, specification slug, and CLI options (`--push`, `--poll-pr`, `--dry-run`).
   - Run: `node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --run-id <runId> --spec <specSlug> [options]`
   - Done when: `sdw-ship-pr` completes with exit code 0, delivery outcome is recorded in `.sdw/state/{runId}.state.json`, and specification is marked completed in index.

## References

- Architecture, batch protocol, and step artifacts persistence: [`references/orchestrator_protocol.md`](references/orchestrator_protocol.md)

