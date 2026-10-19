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
- `resume`: Resumes an interrupted or paused run from its last recorded step in `.sdw/state/{runId}.state.json`.
- `resume-batch [batchId]`: Resumes an interrupted or halted batch queue from the first non-completed specification.
- `status`: Displays current execution progress, conformance score, and step status.

## Multi-Spec Unattended Mode (Mandatory Batch Protocol)

When executing multiple specifications (`run <spec1> <spec2> ...` or batch queue):
- **Continuous Unattended Execution:** Run uninterrupted through every specification from first to last without halting between specs for conversational check-ins or user confirmation.
- **Autonomous Gap Resolution:** Grilling decision gaps auto-resolve with recommended defaults (`autoResolveGaps`).
- **Continuous Queue Progression:** For each spec, complete DAG implementation, test verification (`npm test`), conformance scoring (≥ threshold), delivery commit, and code review, then immediately advance to the next queued spec.
- **Terminal Consolidation Only:** Halt only on unrecoverable failure (if `--continue-on-error` is omitted). Present the consolidated batch summary report only after the entire batch finishes.

## Steps

1. **Initialize State, Branch & Inspect Specification**
   Resolve project root and create an isolated run state in `.sdw/state/{runId}.state.json`. When `useFeatureBranches: true`, verify clean working tree and activate feature branch (`feature/{specSlug}`). If the spec is human-friendly, derive an agentic spec; if already formatted, skip derivation.
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> [options]`
   - Done when: Run state JSON exists on disk, feature branch is activated (if configured), and derivation status is recorded.

2. **Conduct Grilling Round**
   Walk decision tree paths for input bounds, failure recovery, and concurrency. In single-spec mode, query the user via `ask_question` if ambiguous gaps remain. In multi-spec batch mode, auto-resolve gaps autonomously using recommended defaults.
   - Done when: All decision gaps are resolved and spec is marked refined.

3. **Decompose into DAG Tasks & Execute Implementation**
   Analyze complexity and emit DAG execution units. When `useWorktrees: true` on multi-task plans, create exclusive worktrees under `.sdw/worktrees/{runId}/{taskId}`, dispatching subagents there and integrating commits via cherry-pick. Subagents adhere to `sdw-rules` simplicity first. Run test suites (`npm test`) until all tests pass.
   - Done when: DAG tasks are generated, implementation code is integrated, and tests pass.

4. **Evaluate Conformance Score & Security Gate**
   Compute conformance score (0-10) against touched files. If score < threshold (default 8/10), loop back with error feedback. When `securityChecksEnabled` is true, run pre-commit secret/leak scanner (`sdw-security-checks`); block on HIGH findings unless overridden via `--skip-security`.
   - Done when: Conformance score meets threshold and pre-commit security check passes or is bypassed.

5. **Deliver Commit & Remote Push**
   Stage and commit delivery code, execute automated review, package pull request metadata, mark specification completed in `index.specs.md`, and push the active branch to remote origin. In multi-spec mode, advance immediately to the next queued specification without stopping.
   - Done when: Specification is marked completed in index, delivery commit exists on git log, and changes are pushed to remote origin.

## References

- Architecture and state schema: [`references/orchestrator_protocol.md`](references/orchestrator_protocol.md)
