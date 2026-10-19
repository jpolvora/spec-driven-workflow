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

1. **Initialize State & Inspect Specification**
   Resolve project root and create an isolated run state in `.sdw/state/{runId}.state.json`. If the spec is human-friendly, derive an agentic spec; if already formatted for agents, skip derivation.
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> [options]`
   - Done when: Run state JSON exists on disk and derivation status is recorded.

2. **Conduct Grilling Round**
   Walk decision tree paths for input bounds, failure recovery, and concurrency. In single-spec mode, query the user via `ask_question` if ambiguous gaps remain. In multi-spec batch mode, auto-resolve gaps autonomously using recommended defaults.
   - Done when: All decision gaps are resolved and spec is marked refined.

3. **Decompose into DAG Tasks & Execute Implementation**
   Analyze complexity and emit DAG execution units. Subagents must adhere to `sdw-rules` simplicity first and surgical diff directives (minimum code to satisfy ACs). Run test suites (`npm test`) until all tests pass.
   - Done when: DAG tasks are generated, implementation code is written, and tests pass.

4. **Evaluate Conformance Score & Review**
   Compute conformance score (0-10) against touched files. If score < threshold (default 8/10), loop back with error feedback. Once passing, stage and commit the delivery code, then execute automated code review against `baseCommit`.
   - Done when: Conformance score meets threshold and code review findings are resolved.

5. **Deliver Commit & Remote Push**
   Execute `node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> --push` to create the delivery git commit, package pull request metadata, mark specification completed in `index.specs.md`, and push the active branch to remote origin. In multi-spec mode, advance immediately to the next queued specification without stopping.
   - Done when: Specification is marked completed in index, delivery commit exists on git log, and changes are pushed to remote origin.

## References

- Architecture and state schema: [`references/orchestrator_protocol.md`](references/orchestrator_protocol.md)
