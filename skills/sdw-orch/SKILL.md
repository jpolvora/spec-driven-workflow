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
- `task finish --run-id <runId> --task <taskId> --evidence <evidencePath>`: Validates task evidence and records task completion (integrating worktree changes if applicable).
- `resume`: Resumes an interrupted or paused run from its last recorded step in `.sdw/state/{runId}.state.json`.
- `resume-batch [batchId]`: Resumes an interrupted or halted batch queue from the first non-completed specification.
- `status`: Displays current execution progress, conformance score, and step status.

## Multi-Spec Unattended Mode (Mandatory Batch Protocol)

When executing multiple specifications (`run <spec1> <spec2> ...` or batch queue):
- **Continuous Unattended Execution:** Run uninterrupted through every specification from first to last without halting between specs for conversational check-ins or user confirmation.
- **Autonomous Gap Resolution:** Grilling decision gaps auto-resolve with recommended defaults (`autoResolveGaps`).
- **Continuous Queue Progression:** For each spec, complete DAG implementation, test verification (`npm test`), conformance scoring (≥ threshold), delivery commit, and code review, then immediately advance to the next queued spec.
- **Terminal Consolidation Only:** Halt only on unrecoverable failure (if `--continue-on-error` is omitted) or handoff pause (code 4). Present the consolidated batch summary report after completion.

## Steps

1. **Spec Ingestion & Derivation**
   Resolve project root and create isolated run state in `.sdw/state/{runId}.state.json`. If `useFeatureBranches: true`, verify clean working tree and activate feature branch (`feature/{specSlug}`). If the spec is human-friendly, derive an agentic spec; if already formatted, skip derivation.
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> [options]`
   - Done when: Run state exists on disk, branch is active, and derivation status recorded.

2. **Conduct Refinement Round**
   Walk decision tree paths for input bounds, failure recovery, and concurrency, producing a technical blueprint. In single-spec mode, query user via `ask_question` if ambiguous gaps remain. In batch mode, auto-resolve gaps using recommended defaults.
   - Done when: Decision gaps resolved, blueprint generated, and refinement artifact `{slug}-step-2.md` persisted.

3. **Decompose into DAG Tasks**
   Analyze complexity and emit DAG execution units with context prompts and dependency graphs.
   - Done when: DAG tasks generated, and DAG artifact `{slug}-step-3.md` persisted.

4. **Implementation Execution & Verification Gates**
   In handoff mode (default), write prompt files under `.sdw/state/` enforcing `sdw-rules` simplicity, mark Step 4 `awaiting_implementation`, and pause with exit code 4. In command mode, execute configured subprocess in topological DAG order. When `useWorktrees: true`, create sequential worktrees, commit in worktree, cherry-pick to primary, and clean up. Once all tasks are accepted, execute build and test verification gates.
   - Done when: All DAG tasks have accepted evidence, changes corroborated, and build/test gates passed.

5. **Evaluate Conformance Score**
   Compute evidence-based conformance score (`round(verifiedAcs / totalAcs * 10)`). Criteria are verified only when referenced by accepted task evidence confirming existing changed files. Fails closed with 0/10 if 0 ACs exist. If score < threshold (default 8/10), trigger re-implementation loop (code 2).
   - Done when: Conformance score meets threshold and scoring artifact `{slug}-step-5.md` persisted.

6. **Delivery Commit & Security Gate**
   Refuse delivery commit if Step 4 is incomplete, any task unaccepted, or any gate failed. Run pre-commit secret leak scan (`sdw-security-checks`) when enabled. Stage and commit delivery changes atomically.
   - Done when: Step 4 quality guards pass, pre-commit security check passes, and delivery commit exists.

7. **Automated Code Review Loop**
   Compare branch changes to base commit, verifying rule invariants and clean syntax in an iterative loop (up to 3 auto-fix attempts).
   - Done when: Code review checks pass or fixes applied.

8. **PR Preparation, Delivery & Code Review Convergence**
   Evaluate `.sdw/config.json` delivery options (`scmProvider`, `pushDelivery`, `scmCodeReviewEnabled`):
   - When `pushDelivery: true` (or `--push`), push the branch to remote origin.
   - When `scmProvider` is active (`github` | `ado`), open or reuse the PR via the provider contract.
   - When `scmCodeReviewEnabled: true` (or `--poll-pr`), enter the post-PR review convergence loop:
     1. Await completion of remote CI workflows and automated/agentic review runs (`gh pr checks <PR>` / `check-pr-status`).
     2. Query review comments and active threads from provider (`gh pr view <PR> --comments` / `gh api` / `list-threads`).
     3. Critically evaluate review feedback against spec ACs and simplicity guidelines (`sdw-rules`).
     4. If actionable comments or test gaps are identified, execute surgical fixes, verify (`npm test`), commit, push, and iterate until checks pass green and threads are resolved.
     5. If feedback is technically invalid or counter-productive, provide explicit refutation with evidence.
   - When `scmCodeReviewEnabled: false`, skip remote review polling.
   - Done when: Specification marked completed in index, and if `pushDelivery`/`scmCodeReviewEnabled` are enabled, PR is created and review convergence loop completes per `config.json`.

## References

- Architecture, batch protocol, and step artifacts persistence: [`references/orchestrator_protocol.md`](references/orchestrator_protocol.md)

