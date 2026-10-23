---
name: sdw-orch
description: End-to-end workflow orchestrator that coordinates spec execution, subagent dispatch, review loops, and delivery.
version: 0.2.0
invocation_names:
  - sdw-orch
  - sdw-orch run
  - sdw-orch implement
  - sdw-orch resume
  - sdw-orch status
  - sdw-orchestrator
  - orch
  - orch run
  - orch implement
---
# sdw-orch

> When this skill is loaded, output "sdw-orch loaded."

Orchestrates spec execution from input requirement to delivery commit, automated code review, and pull request.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) before running. A specification is a document, not an implementation order.

## Subcommands

- `run <specPath>`: Executes the full 8-step workflow pipeline for one specification.
- `run <specPath> --dry-run`: Validates the specification, prints the execution plan and the spec observations it found; executes nothing and writes no state, report, or artifact.
- `run <specPath> --second-pass` (alias `--refine`): Refines an already implemented specification: audits how it was delivered, fills acceptance criteria that are missing or drifted from the spec, then applies clear simplification or quality gains. Writes a `{slug}-refine.md` report, commits only when the pass changed code, and runs Step 8 only when that commit exists. Producing no change is valid only when every criterion already holds and no drift remains.
- `run <specPath> --sandbox`: Executes the whole pipeline against an isolated local clone of `HEAD`; never pushes or opens a pull request.
- `sandbox list | report --run-id <runId> | clean --run-id <runId>`: Lists isolated sandboxes with status, branch, and age; regenerates and prints a sandbox report; or deletes the clone keeping its metadata and report.
- `task next [--run-id <runId>] [--json]`: Dispatches the next ready DAG task and emits its dispatch envelope (subagent mode).
- `task finish --run-id <runId> --task <taskId> --evidence <evidencePath>`: Validates the dispatched task's evidence, accepts it, then saves it with one scoped checkpoint commit plus the tag `sdw-checkpoint-{runId}-{taskId}` (opt out: `--no-task-checkpoint`; a second-pass run commits the refinement at Step 6 and the report at Step 7).
- `task abandon --run-id <runId> --task <taskId> --reason <text>`: Returns the dispatched task to the queue after a lost or failed worker.
- `score submit --run-id <runId> --verdict <path>`: Submits the Step 5 judge verdict, applies the conformance score, and persists the optional `summary`, `risks`, and `followUps` as the judgment contribution.
- `report re-render --run-id <runId>`: Refreshes the delivery report and the in-progress report from run state; never commits or amends a pushed commit.
- `resume`: Resumes an interrupted or paused run from its last recorded step in `.sdw/state/{runId}.state.json`.
- `dag preview [--json] [--spec <path>]`: Prints the plan the classifier would generate, with complexity, `execMode`, wave levels, per-task criteria/files, file disjointness, and the two-spec split proposal when the cap refuses; writes no state, artifact, branch, sandbox, or registry row.
- `status`: Displays current execution progress, conformance score, step status, and the remaining task queue.

## One Specification Per Run

`sdw-orch` executes exactly one specification. A queue of specifications belongs to [`sdw-batch`](../sdw-batch/SKILL.md), which delegates each item to `sdw-orch run <spec>` and waits for it to finish. `sdw-batch` never refines: it skips specs already recorded as delivered, and refinement is always an explicit single-spec `sdw-orch run <spec> --second-pass` call.

## Second Pass (`--second-pass`)

- Requires an already delivered spec (registry `completed`/`archived`, or a completed run with a delivery commit); otherwise it refuses with exit `1`.
- Steps 2 and 3 are skipped in favor of one `task-refine` task, and `task finish` accepts an empty `filesChanged` for it. Gap closure comes first: each acceptance criterion is audited against the delivered code, tests, configuration, and docs, and missing, partial, or drifted behavior is implemented; simplification and quality passes follow inside the same specification scope.
- No code change: Steps 5-8 are `skipped`, the refinement report is written, and the command exits `0` with `refineOutcome: "no-change"` (honest only when every criterion already holds and no drift remains). Code change: scoring, review, and shipping run normally, the commit is `refine({slug}): second pass refinement`, and shipping runs only because that commit exists.

## Dry Run vs Sandbox

- `--dry-run` is plan-only on `run`: validate the spec, print the plan, create nothing. Mutually exclusive with `--sandbox`.
- `--sandbox` clones the committed `HEAD` to `{sandboxDir}/{runId}/repo` (default `.sdw/sandbox`) on branch `sdw-sandbox/{runId}` using a shallow single-branch clone (`--depth 1 --single-branch`), removes the clone's `origin`, and runs every step against that clone. Uncommitted changes are excluded and recorded (`baselineDirty`).
- Sandbox delivery is forced off: no push, `scmProvider: none`, and `sdw-ship-pr --dry-run`. The source checkout and `.sdw/state` are never touched.
- Follow-up commands print absolute sandbox paths and `--root <clonePath>`. After every invocation the report at `.sdw/sandbox/{runId}/report.md` is refreshed and the `sandbox clean` command is proposed; nothing is deleted automatically.

## Steps

1. **Spec Ingestion & Derivation**
   Resolve project root and create isolated run state in `.sdw/state/{runId}.state.json`. If `useFeatureBranches: true`, activate feature branch (`feature/{specSlug}`); dirty trees are allowed and never block execution. If the spec is human-friendly, derive an agentic spec; if already formatted, skip derivation.
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs run <specPath> [options]`
   - Done when: Run state exists on disk, branch is active, and derivation status recorded.

2. **Conduct Refinement Round**
   Walk decision tree paths for input bounds, failure recovery, and concurrency, producing a technical blueprint. In single-spec mode, query user via `ask_question` if ambiguous gaps remain. In batch mode, auto-resolve gaps using recommended defaults. Record advisory spec observations (`overlap`, `superseded`, `conflict`) over sibling specifications in `steps[2].output.specObservations` and the Step 2 artifact; they never block the run.
   - Done when: Decision gaps resolved, blueprint generated, observations recorded, and refinement artifact `{slug}-step-2.md` persisted.

3. **Decompose into DAG Tasks**
   Classify by declared criteria: <=4 low (one task), 5-10 standard (foundation plus integration), >10 complex (three to five slices of <=4 criteria and <=3 target files, at most five tasks), escalated to complex at three touchpoints with >=7 criteria. Beyond five tasks the plan is refused with `split-required tasks-needed=N cap=5` plus a two-spec split proposal. Every plan records `execMode: sequential`, wave `levels`, per-task `parallelizable` flags, and pairwise file disjointness; dispatch stays one task at a time.
   - Done when: DAG tasks generated, and DAG artifact `{slug}-step-3.md` persisted.

4. **Implementation Execution (Sequential Subagent Dispatch)**
   In `subagent` mode (default), dispatch exactly one ready DAG task and pause with exit code 4. Each brief carries the `sdw-rules` simplicity constraints (minimum code, surgical scope, no unrequested features). For each envelope: spawn one subagent that reads the prompt file and executes it as written, wait for its report, then submit `task finish`. If the worker reports a non-`success` status or never returns, run `task abandon --reason` and dispatch again. In `command` mode, execute the configured subprocess in topological DAG order. Worktrees are command-mode only; subagent mode uses the primary tree with dispatch-baseline corroboration. Every accepted `task finish` immediately saves the task as one scoped commit of its `filesChanged` (message `task({specSlug}): {taskId}`) plus the checkpoint tag `sdw-checkpoint-{runId}-{taskId}`, so a crash or reset between tasks loses nothing; `--no-task-checkpoint` opts out and `--second-pass` keeps its single `refine(...)` delivery commit. Once every task is accepted, run build and test verification gates.
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs task next --run-id <runId>`
   - Done when: Every DAG task has accepted evidence, corroborated against its dispatch baseline and saved as a checkpoint commit plus tag, and build/test gates pass.
   - Exit codes: `4` dispatch pause (normal), `1` failure.

5. **Evaluate Conformance Score (LLM judge)**
   Score conformance with an LLM judge fenced to the acceptance criteria plus the generated diff — never transcripts. Per-criterion verdicts drive the score (`round(verified / total * 10)`); `scoring.judgeCriticity` sets strictness. When `scoring.judgeCommand` is unset, the current agent model judges: Step 5 writes `step-5-judge.prompt.md`, pauses with exit code 5, and accepts a verdict through `score submit`. Zero criteria, an unavailable judge, or a malformed verdict fails closed at 0/10. Below `scoreMin` (default 8/10) triggers the re-implementation loop (exit code 2).
   - Run: `node skills/sdw-orch/scripts/sdw_orch.cjs score submit --run-id <runId> --verdict <path>`
   - Done when: The judge verdict covers every criterion and the derived score meets the threshold, with the scoring artifact `{slug}-step-5.md` persisted.

6. **Delivery Commit & Security Gate**
   Refuse delivery commit if Step 4 is incomplete, any task unaccepted, or any gate failed. Run pre-commit secret leak scan (`sdw-security-checks`) when enabled. Stage and commit only tracked spec files (accepted evidence `filesChanged` + `index.specs.md`); unrelated worktree changes are never staged. Per-task checkpoint commits already cover accepted files, so Step 6 commits what remains and records `HEAD` when nothing is left.
   - Done when: Step 4 quality guards pass, pre-commit security check passes, and scoped delivery commit exists.

7. **Fresh-Subagent Code Review via sdw-code-review**
   Spawn one context-fresh reviewer subagent session for `sdw-code-review`; the reviewer sees only the delivered diff, never the reasoning that produced it. A Step 7 verdict exists only inside that session: running the review CLI in this orchestrator session is forbidden and is not a verdict. Standalone `doctor` and `--dry-run` remain valid outside this rule.
   - Reviewer brief carries only target root, base reference, report path, and scope fence; never the implementation transcript, prior worker reasoning, DAG prompts, or judge verdicts.
   - Run inside the reviewer session: `node skills/sdw-code-review/scripts/sdw_code_review.cjs run --target <root> [--base <ref>] --report <artifact> [--fix] [--json]`
   - `sdw-code-review` is the sole code review authority; no duplicated internal review instructions.
   - When remediation is required, delegate the findings batch to `sdw-fixer` in a fresh subagent session distinct from the reviewer session; its brief carries only the findings file, target root, and report path (`node skills/sdw-fixer/scripts/sdw_fixer.cjs run --findings <path> --report <path>`).
   - The reviewer session never approves fixer output: a fixer delivery is re-reviewed in a new context-fresh reviewer session, so no session approves its own output.
   - Done when: Report shows 0 blocking findings (`critical`/`warning`) or fix ceiling reached with residual recorded.

8. **PR Preparation, Delivery & Review Convergence**
   Delegate pull request preparation, pre-PR verification gates, remote publishing, SCM submission, and post-PR review convergence to `sdw-ship-pr`. Pass active run ID, specification slug, and CLI options (`--push`, `--poll-pr`, `--dry-run`).
   - Run: `node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --run-id <runId> --spec <specSlug> [options]`
   - Done when: `sdw-ship-pr` completes with exit code 0, delivery outcome is recorded in `.sdw/state/{runId}.state.json`, and specification is marked completed in index.

## Delivery Pause, Registry Truth & Stale Runs

- Delivery is proven by evidence, never by the registry row: the queue resolves the run id, delivery commit, branch, and pull request from the item's run state, then from the most recent completed run carrying a delivery commit, then from the SCM provider by head branch.
- An unconverged delivery pauses with exit code `6`: run `paused`, Step 8 `blocked_convergence`. Converge the pull request, then `resume`; nothing is marked failed or completed.
- Step 6 never writes the registry. Only after the delivery stage reports the delivery, or with `--skip-pr`, does Step 8 mark the specification `completed` and set its header `status: implemented` in the same transition; a run that fails earlier leaves both unchanged.
- An open run whose recorded base commit is not an ancestor of the refreshed work lane is stale and is never resumed: `--new-run` starts a fresh run and records the superseded id.

## Delivery Report, Contributions & Spec Observations

- After Step 7 resolves and before Step 8 delegates, write `.sdw/reports/{specFileNameWithoutExtension}-report.md` (the directory is created when absent) with: metadata (run id, slug, branch, base/delivery commit, ship status, score/`scoreMin`, timings per step), tasks, commits, files changed per task, verification, code review, conformance judgment (score, minimum, verified/failed counts, one row per criterion), advisory judge analysis (summary, risks, follow-ups), learnings, retrospective, breaking-change candidates, quality, spec observations, notes, and outcome; a section whose contributions are absent renders `Not available`.
- Every step appends one entry to `state.reportContributions` (`step`, `stepName`, `at`, `kind`, `title`, `body`, `evidence`) before the next step begins, and both report paths re-render from the whole list at that boundary; entries are ordered by step then time, malformed entries are skipped with a recorded warning, the write is atomic, and `--dry-run` prints the contribution summary instead of writing.
- Every `sdw-memory record --run <runId>` becomes a `learning` contribution and an append-only `.sdw/state/{slug}/{runId}/learnings.json` entry; before a step acts it receives the matching learnings digest, and `sdw-memory apply` names the step that applied each one. When the retrospective completes, its `retro` contribution is appended and the report re-renders; `report re-render` refreshes the companion from run state without amending a pushed commit.
- Commit it with `docs({specSlug}): record delivery report`, staging only that file, whenever it is written; record its path in `state.deliveryReport`. A write or commit failure records a warning in run state and delivery continues. A resumed run rewrites the same path from current state instead of appending. `--skip-pr` and second-pass runs commit the report too, after their own delivery or `refine` commit.
- Step 2 records advisory observations as `kind` (`overlap` when a delivered spec names the same target file, `superseded` when another spec names this slug/id in a supersession context, `conflict` when both declare the same configuration key differently), `otherSpec`, `evidence`, and `severity`. They never block, rewrite, or alter a run; `--dry-run` prints them without writing a report or artifact.

## References

- Architecture, batch protocol, and step artifacts persistence: [`references/orchestrator_protocol.md`](references/orchestrator_protocol.md)

