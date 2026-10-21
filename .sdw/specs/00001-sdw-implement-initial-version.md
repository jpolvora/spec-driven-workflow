---
id: null
slug: 00001-sdw-implement-initial-version
title: "SDW Implement Orchestrator Skill"
source: local
status: implemented
specDate: 2026-10-18
---

# Specification — SDW Implement Orchestrator Skill

## Description

The `sdw-implement` skill is an end-to-end workflow orchestrator that coordinates spec execution step-by-step. It manages session state persistence, dispatches and monitors subagents, resolves ambiguity through structured grilling, decomposes tasks into DAGs, validates code quality via conformance scoring, executes automated code reviews, and prepares pull requests with optional comment-resolution loops.

The architecture emphasizes simplicity, minimal token footprint, and deterministic progress tracking by using an isolated JSON state file for each run (`.sdw/state/{runId}.state.json`).

### Design Intent

Greenfield implementation for the Spec-Driven Workflow (SDW) initiative. It reworks prior complex orchestration approaches to leverage modern LLM capabilities with reduced prompt sediment, explicit state-machine transitions, and strict subagent context isolation.

## Acceptance Criteria

- AC1: The orchestrator shall maintain an isolated state JSON file for each execution run.
- AC2: When a paused execution run resumes, the orchestrator shall restore session state from the state file.
- AC3: When a human-friendly source spec is provided, the orchestrator shall derive an agent-optimized specification.
- AC4: Where the input specification is pre-formatted for agents, the orchestrator shall skip the specification derivation step.
- AC5: When performing the grilling round, the orchestrator shall walk decision tree paths to identify specification gaps.
- AC6: If unresolvable gaps remain after consulting context and memory, then the orchestrator shall query the user with options and a recommended default.
- AC7: The orchestrator shall generate a DAG task plan based on complexity analysis of the refined specification.
- AC8: When dispatching DAG tasks, the orchestrator shall run subagents in isolated contexts.
- AC9: When task implementation completes, the orchestrator shall compute a specification conformance score against touched files.
- AC10: While the conformance score remains below the configured threshold, the orchestrator shall loop back to implementation with attached feedback.
- AC11: When the conformance score meets the threshold, the orchestrator shall create a delivery commit.
- AC12: When comparing the delivery commit to the base commit, the orchestrator shall execute an automated code review.
- AC13: While unresolved code review findings exist, the orchestrator shall apply fixes and record update commits.
- AC14: When all review findings are resolved, the orchestrator shall prepare a pull request and mark the specification completed.
- AC15: Where remote PR review monitoring is enabled, the orchestrator shall poll for open PR comments and apply surgical fixes until resolved.
- AC16: If an unrecoverable subagent execution failure occurs, then the orchestrator shall persist the error state and halt execution.

## Original Issue Context

The user requested an initial specification for the `sdw-implement` orchestrator skill:

> The skill sdw-implement is an orchestrator skill that coordinates the whole process step-by-step, dispatching and observing subagents. It owns the state file specific for the run, updating state data for the session, allowing sharing data and continuation/pause by seeking the state and decide the next step until completion of the process.
>
> The initial/source spec is a HUMAN friendly format.
> The derived spec will be specific for agentic instructions. This step can be skipped if the initial spec is already written to agents.
> Then a grilling round begins, a deep analysis is started checking for gaps/missing instructions in order to prevent agents improvising or taking decisions by itself. The spec content is submited to a exhaustive checking for all possible decisions tree paths walk in order to determine/find gaps. The context, code, memory and rules can be queried to infer/fullfil the gaps. In case of any decisions needs atention, askQuestion for the user to decide, presenting the gap, and providing options will a pre-selected default answer recommended based on a most probable option. The result will be a refined spec ready for implementation/code generation.
> The next step complexity analysis and DAG file generation, breaking the refined spec into small tasks. It can result into a single execution unit if the spec is simple or in multiple/paralel units, depending on the complexity.
> next step is to prepare the prompt and dispatching subagents according to DAG definition, to implement in an isolated context, keeping the agent focused on its task.
> When finished the implementation step, then execute a score analysis comparing the source spec with the resulting code/files touched, taking into account all context/code/project. The analisys checks the quality of implementation, Depending on the score, if is lower than acceptable, it can get back to implementation step, attaching the gaps/errors/observations/findings and reforcing the task definition to fix and avoid commiting same mistakes. This is a loop, while score is not satisfied reimplement.
> After quality assured by the score, the next step is a commit.
> Now with code commited, a quick code-review is executed, comparing the current commit with the base commit (previous). This also is a loop. In case of code review findings/warnings, execute the necessary fixes. Until no more findings exist. A new commit should be made.
> The next step is prepare to PR. This process will associate tasks and mark spec as completed. The PR can optionally may trigger code-review process if configured. In this case, start a timer and a loop for checking if there are open comments to be solved.Analyze the findings, fix in the code, commit and push again. If available, close the comments with a summary of the fix. The loop ends when no more comments exists.

## Notes

- State schema records current step, active subagent IDs, DAG task status map, iteration counters for review loops, and handoff payloads.
- Subagents are provided with minimal necessary context prompts rather than entire conversation transcripts to preserve token limits.
- Conformance scoring compares AST-level and behavioral diffs against AC items from the refined spec.
- Code review loop focuses on syntax, project rules, regressions, and security invariants.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Direct production continuous deployment | The workflow concludes at pull request creation and approval readiness |
| Cross-repository multi-workspace orchestration | Each run executes within the boundary of a single workspace repository |
| Automated merge of PR without reviewer approval | Merging remains a human decision or external pipeline responsibility |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| State file directory | `.sdw/state/{runId}.state.json` | Co-locates run state with workspace `.sdw/` assets without polluting root | y |
| Conformance score threshold | 8 out of 10 | Balances delivery speed and rigorous quality gate | y |
| Interactive user clarification tool | `ask_question` tool | Standard Antigravity interactive prompt for user-gates | y |
| Pull request CLI integration | GitHub CLI (`gh`) or Azure DevOps CLI (`az`) | Relies on existing developer tooling configured in host environment | y |
| Absent lifecycle dimensions | N/A because execution is local CLI/agent process without hosted backend services | Local agent tool invocation | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification input | Source spec file is readable under `.sdw/specs/` | Verify file exists on disk and is non-empty |
| Git repository state | Workspace is a valid Git repository with clean working tree | Run `git status` check |
| Subagent runner capability | Agent environment supports subagent invocation or background execution | Verify tool availability |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Run state transitions saved to `.sdw/state/{runId}.state.json`.
- Step transition summaries logged to agent console on each phase completion.
- Quantitative conformance score report output after implementation step.
- Code review findings table detailing reviewed files, rule violations, and applied diffs.

### Negative & Failing Test Scenarios

- Re-implementation loop trigger: when conformance score is 6/10 (below threshold 8/10), the orchestrator must report failing criteria and trigger task re-implementation.
- Interrupted session recovery: when a run with state file at step 4 is resumed, the orchestrator must restore from step 4 without re-running steps 1 through 3.
- User cancellation at grilling: when the user rejects options at the grilling gate, the orchestrator must cleanly abort without dispatching implementation agents.
