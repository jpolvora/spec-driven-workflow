---
id: null
slug: 00076-fresh-context-subagent-code-review-fix-loop
title: "Fresh-Context Subagent Code Review and Local Autonomous Fix Loop"
source: local
status: implemented
specDate: 2026-11-21
priority: high
---
# Specification — Fresh-Context Subagent Code Review and Local Autonomous Fix Loop

## Description

In the Spec-Driven Workflow orchestrator (`sdw-run`), Step 7 (Code Review) evaluates code changes following task implementation (Step 4), conformance scoring judge evaluation (Step 5), and the delivery commit (Step 6). Currently, Step 7 executes shallow static regex checks via `sdw_code_review.cjs` synchronously inside the orchestrator process, coupled with an automated fix loop limited to basic regex replacements. This approach introduces two critical deficiencies: first, the host orchestrator session accumulates extensive conversation turns, implementation reasoning, and confirmation bias from earlier steps; second, regex-based linters cannot evaluate semantic correctness, architectural regressions, edge-case vulnerabilities, or holistic adherence to repository standards.

This specification introduces a dedicated, fresh-context subagent code reviewer and an autonomous local review-and-fix loop for Step 7. When `codeReview.mode` is set to `"subagent"` (the default), the orchestrator pauses execution and emits a structured dispatch envelope for a newly spawned reviewer subagent. The reviewer executes in an isolated conversation context without inheriting the implementer's or judge's conversation transcript. The reviewer is granted strictly read-only access to the codebase and is prohibited from making file or git mutations.

Both the reviewer and the fixer subagents are strictly injected with the project's authoritative context: repository instruction files (such as `AGENTS.md` or configured project instructions), relevant anti-pattern traps and decisions retrieved via `sdw-memory`, and `sdw-rules` simplicity directives. Every dispatched worker must respect and comply with these enforced business rules, guardrails, and architectural invariants.

Following the review policy of `.github/agentic-code-reviewers-prompt.md`, the reviewer subagent aggregates all occurrences of the same underlying defect class into a single finding thread rather than producing duplicate issues across multiple files. Each finding provides the primary `file:line` anchor, concrete failing evidence, a minimal proposed fix diff, and an aggregated list of all secondary `otherLocations`.

If the reviewer subagent discovers blocking findings, the orchestrator initiates an autonomous local fix loop (analogous to the post-PR review convergence loop in `sdw-ship-pr`, but operating locally on the working tree before PR preparation in Step 8). Remediation is dispatched to a completely separate, context-fresh fixer subagent. To enforce surgical scope enclosure, the fixer subagent is granted write access exclusively to the target files identified in the review findings and verified sibling locations; modifications outside this designated scope fence are strictly prohibited. Once the fixer applies surgical patches and confirms verification commands pass, the orchestrator records a scoped conventional commit, and dispatches a fresh reviewer subagent with clean context to re-evaluate the updated diff. The loop repeats until all blocking findings are resolved or until a configurable iteration ceiling (defaulting to 5 runs) is reached.

### Design Intent

Establish an impartial, rigorous code review and remediation gate between implementation scoring and PR creation. By isolating each review and fix run into a fresh subagent with clean context, the system eliminates transcript pollution and reviewer self-approval bias. Enforcing read-only access for the reviewer and scoped write-only access for the fixer ensures safe, deterministic execution. Requiring defect-class aggregation mirrors production PR review standards, eliminating duplicate chatter and focusing remediation on root causes. Injecting project memory, traps, and repository instructions (`AGENTS.md`, `sdw-rules`, `sdw-memory`) guarantees that all fixes strictly honor repository guardrails, architectural simplicity, and business invariants before PR preparation.

## Acceptance Criteria

- AC1: The system shall provide a configurable setting `codeReview.mode` in `.sdw/config.json` supporting values `"subagent"`, `"cli"`, and `"command"`, defaulting to `"subagent"`.
- AC2: The system shall provide a configurable setting `codeReview.maxIterations` in `.sdw/config.json` defining the maximum number of review-and-fix iterations, defaulting to 5.
- AC3: While `codeReview.mode` is `"subagent"`, the orchestrator in Step 7 shall dispatch a context-fresh reviewer subagent session without inheriting prior implementation, grilling, or judge conversation transcripts.
- AC4: When generating the reviewer subagent brief, the orchestrator shall restrict worker permissions to read-only access with zero file mutations permitted.
- AC5: When generating subagent briefs for review and remediation rounds, the orchestrator shall inject repository instructions, active memory traps from sdw-memory, and sdw-rules guardrails.
- AC6: The system shall require the reviewer subagent to aggregate duplicate occurrences of the same defect class into a single finding referencing primary file line coordinates and secondary locations.
- AC7: The system shall instruct the reviewer subagent to format findings with concrete failing evidence, minimal fix diffs, and severity ratings in a structured review report JSON.
- AC8: When the reviewer subagent submits a review report with zero blocking findings, the orchestrator shall mark Step 7 as completed and advance to Step 8.
- AC9: When the reviewer subagent submits a review report containing blocking findings and the current iteration is below `codeReview.maxIterations`, the orchestrator shall initiate a local remediation round.
- AC10: While initiating a remediation round, the orchestrator shall dispatch a context-fresh fixer subagent session distinct from the reviewer subagent.
- AC11: When generating the fixer subagent brief, the orchestrator shall scope write access exclusively to target files identified in the review findings.
- AC12: The system shall prohibit the fixer subagent from modifying files outside the target finding scope fence.
- AC13: When the fixer subagent completes surgical modifications and verification passes, the orchestrator shall stage and commit the fix changes with a conventional commit subject.
- AC14: When a remediation round commit is recorded, the orchestrator shall increment the iteration counter and dispatch a fresh reviewer subagent session to re-evaluate the updated diff.
- AC15: If the review-and-fix loop reaches `codeReview.maxIterations` and blocking findings remain unresolved, then the orchestrator shall record `review_failed` in Step 7 state and halt execution.
- AC16: Where `codeReview.maxIterations` is specified via CLI flag `--review-max-iterations`, the orchestrator shall override the configuration value for the active run.
- AC17: While `codeReview.mode` is `"cli"`, the orchestrator shall execute legacy deterministic review checks using `sdw_code_review.cjs`.
- AC18: While `codeReview.mode` is `"command"`, the orchestrator shall execute the custom command defined in `codeReview.command`.
- AC19: The system shall register `codeReview` configuration properties in `.sdw/config.schema.json` with `sdw-config` validation rules.
- AC20: The system shall update `skills/sdw-run/references/orchestrator_protocol.md` and `skills/sdw-code-review/SKILL.md` to document the fresh-subagent review and local fix loop protocol.
- AC21: The system shall provide automated unit tests verifying Step 7 envelope synthesis, read-only reviewer fencing, defect-class aggregation parsing, fixer write scoping, and iteration limit exhaustion.

## Notes

- Configuration schema updates:
  - Add `codeReview` object to `.sdw/config.schema.json`:
    - `mode`: enum `["subagent", "cli", "command"]`, default `"subagent"`.
    - `maxIterations`: integer, minimum 1, default `5`.
    - `command`: optional string for custom external runner.
    - `model`: optional string to override reviewer model.
    - `effort`: optional string to override reasoning effort.
- Reviewer subagent contract:
  - Permissions: strictly read-only. Prohibited commands: `git commit`, `git push`, file edits, file creations, file deletions.
  - Context fencing: diff between `baseCommit` and `HEAD`, touched files list, specification acceptance criteria, and project harness skills.
  - Project rules injection: prompt includes discovered repository instructions (`AGENTS.md`, `CLAUDE.md`, or `config.projectInstructions`), active traps queried from `sdw-memory`, and `sdw-rules` simplicity directives.
  - Defect aggregation policy (aligned with `.github/agentic-code-reviewers-prompt.md`):
    - Maximum 6 findings per review round.
    - Collect identical defect patterns into a single thread anchored at the first occurrence.
    - Report schema:
      ```json
      {
        "passed": false,
        "blockingCount": 1,
        "findings": [
          {
            "id": "CR-001",
            "defectClass": "unhandled-null-rejection",
            "file": "skills/sdw-run/scripts/sdw_run.cjs",
            "line": 240,
            "evidence": "Null dereference when options.scoring is undefined",
            "suggestedFix": "- if (options.scoring.mode)\n+ if (options.scoring && options.scoring.mode)",
            "otherLocations": [
              "skills/sdw-run/scripts/score_evaluator.cjs:112"
            ],
            "severity": "critical"
          }
        ],
        "summary": "1 blocking defect class identified across 2 locations."
      }
      ```
- Fixer subagent contract:
  - Permissions: write access strictly restricted to `targetFiles` (derived from `finding.file` and `finding.otherLocations`).
  - Prohibitions: editing files outside `targetFiles`, modifying test assertions to force passes, creating git commits directly.
  - Context fencing: aggregated findings JSON, target files, relevant `sdw-memory` traps, and project verification commands (`verification.buildCommand`, `verification.testCommand`).
  - Fix submission:
    - `node skills/sdw-run/scripts/sdw_run.cjs review fix-finish --run-id <runId> --evidence <evidencePath>`.
- Commit format for local review fixes:
  - Message: `fix(<slug>): address code review findings (round <N>)`.
- State tracking:
  - `steps["7"].codeReview`:
    - `mode`: `"subagent"`.
    - `round`: current round number (1..maxIterations).
    - `maxIterations`: configured budget (default 5).
    - `status`: `"awaiting_review"` | `"awaiting_review_fix"` | `"completed"` | `"review_failed"`.
    - `rounds`: array recording per-round review report and fix evidence artifacts.

## Out of Scope

| Feature | Reason |
|---|---|
| Remote PR review polling | Remote review convergence belongs to `sdw-ship-pr` Step 8 |
| Interactive user chat in Step 7 | Review and fix iterations run unattended under the configured budget |
| Shared context reviewer-fixer sessions | Reviewer and fixer must execute in distinct subagent sessions to prevent self-approval |
| Automatic merge execution | Merge decisions belong to repository operators and `sdw-ship-pr` configuration |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Default review mode | `"subagent"` | Provides objective, deep semantic review without context pollution | y |
| Default iteration limit | 5 rounds | Matches user specification while preventing unbounded execution loops | y |
| Context isolation | Clean subagent sessions per round | Guarantees unbiased evaluation on every review and fix iteration | y |
| Fixer write scope | Restricted to finding files | Enforces surgical scope enclosure and prevents drive-by edits | y |
| Defect aggregation | One thread per defect class | Aligns with agentic-code-reviewers standard and eliminates redundant feedback | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| EARS syntax conformance | All 21 criteria conform to strict EARS patterns | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00076-fresh-context-subagent-code-review-fix-loop.md` |
| Scope enclosure | Focussed on Step 7 review subagent and local fix loop | Inspection of Description and Out of Scope sections |
| Schema integration | Configuration properties defined with defaults | Inspection of Notes section |
| Zero runtime dependencies | Standard Node.js 22 built-ins only | Code inspection of scripts and contracts |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Step 7 output indicates: `[Step 7: Delegated Review] Dispatched fresh-context reviewer subagent [round: 1/5, mode: subagent]`.
- Envelope artifacts generated: `{artifactsDir}/{slug}-step-7-review-round-1.prompt.md` and report file destination.
- Review report logs aggregated findings with `otherLocations` list matching defect class occurrences.
- Fixer envelope generated with locked `targetFiles` scope matching finding locations.
- State file records `steps["7"].codeReview = { mode: "subagent", round: 1, maxIterations: 5, status: "awaiting_review" }`.
- Remediation commit produced: `fix(<specSlug>): address code review findings (round 1)`.

### Negative & Failing Test Scenarios

- If the reviewer subagent attempts to write or modify project files, execution halts and the violation is recorded.
- If the fixer subagent attempts to touch files outside the assigned finding scope fence, `review fix-finish` rejects the evidence with exit code 1.
- If the review-and-fix loop reaches the configured maximum iterations (e.g. 5) with unresolved blocking findings, Step 7 transitions to `review_failed`, records blocked gate `review`, and exits with code 1.
- If a reviewer subagent submits an invalid JSON report or malformed findings schema, `review submit` rejects the verdict with exit code 1.
- If `codeReview.maxIterations` is configured to a non-positive integer, `sdw-config` rejects the value during configuration validation.
