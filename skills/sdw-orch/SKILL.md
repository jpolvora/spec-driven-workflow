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

- `run <specPath...>`: Executes the full 8-step workflow pipeline for single specification or multi-spec sequential batch queue.
- `resume`: Resumes an interrupted or paused run from its last recorded step in `.sdw/state/{runId}.state.json`.
- `resume-batch [batchId]`: Resumes an interrupted or halted batch queue from the first non-completed specification.
- `status`: Displays current execution progress, conformance score, and step status.

## Steps

1. **Initialize State & Inspect Specification**
   Resolve project root and create an isolated run state in `.sdw/state/{runId}.state.json`. If the spec is human-friendly, derive an agentic spec; if already formatted for agents, skip derivation.
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> [options]`
   - Done when: Run state JSON exists on disk and derivation status is recorded.

2. **Conduct Grilling Round**
   Walk decision tree paths for input bounds, failure recovery, and concurrency. If unresolvable gaps remain, query the user via `ask_question` with options and a recommended default.
   - Done when: All decision gaps are resolved and spec is marked refined.

3. **Decompose into DAG Tasks & Execute Implementation**
   Analyze complexity and emit DAG execution units. Dispatch subagents in isolated contexts using scoped prompts (or execute the implementation tasks). Run test suites (`npm test`) until all tests pass.
   - Done when: DAG tasks are generated, implementation code is written, and tests pass.

4. **Evaluate Conformance Score & Review**
   Compute conformance score (0-10) against touched files. If score < threshold (default 8/10), loop back with error feedback. Once passing, stage and commit the delivery code, then execute automated code review against `baseCommit`.
   - Done when: Conformance score meets threshold and code review findings are resolved.

5. **Deliver Commit & Remote Push**
   Execute `node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> --push` to create the delivery git commit, package pull request metadata, mark specification completed in `index.specs.md`, and push the active branch to remote origin.
   - Done when: Specification is marked completed in index, delivery commit exists on git log, and changes are pushed to remote origin.

## References

- Architecture and state schema: [`references/orchestrator_protocol.md`](references/orchestrator_protocol.md)
