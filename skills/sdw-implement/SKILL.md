---
name: sdw-implement
description: End-to-end workflow orchestrator that coordinates spec execution, subagent dispatch, review loops, and delivery.
version: 0.1.0
invocation_names:
  - sdw-implement
  - sdw-implement run
  - sdw-implement resume
  - sdw-implement status
---
# sdw-implement

> When this skill is loaded, output "sdw-implement loaded."

Orchestrates spec execution from input requirement to delivery commit, automated code review, and pull request.

## Subcommands

- `run <specPath>`: Executes the full 8-step workflow pipeline for the target specification.
- `resume`: Resumes an interrupted or paused run from its last recorded step in `.sdw/state/{runId}.state.json`.
- `status`: Displays current execution progress, conformance score, and step status.

## Steps

1. **Initialize State & Inspect Specification**
   Resolve project root and create an isolated run state in `.sdw/state/{runId}.state.json`. If the spec is human-friendly, derive an agentic spec; if already formatted for agents, skip derivation.
   - Run: `node skills/sdw-implement/scripts/sdw_implement.cjs run <specPath> [options]`
   - Done when: Run state JSON exists on disk and derivation status is recorded.

2. **Conduct Grilling Round**
   Walk decision tree paths for input bounds, failure recovery, and concurrency. If unresolvable gaps remain, query the user via `ask_question` with options and a recommended default.
   - Done when: All decision gaps are resolved and spec is marked refined.

3. **Decompose into DAG Tasks & Dispatch Subagents**
   Analyze complexity and emit DAG execution units. Dispatch subagents in isolated contexts using scoped prompts rather than cumulative chat history.
   - Done when: DAG tasks are generated and implementation outputs are received.

4. **Evaluate Conformance Score & Review**
   Compute conformance score (0-10) against touched files. If score < threshold (default 8/10), loop back with error feedback. Once passing, stage and commit the delivery code, then execute automated code review against `baseCommit`.
   - Done when: Conformance score meets threshold and code review findings are resolved.

5. **Prepare PR & Complete Lifecycle**
   Package pull request metadata, associate work items, mark specification completed, and optionally poll for remote review comments.
   - Done when: Specification is marked completed and PR artifacts are prepared.

## References

- Architecture and state schema: [`references/orchestrator_protocol.md`](references/orchestrator_protocol.md)
