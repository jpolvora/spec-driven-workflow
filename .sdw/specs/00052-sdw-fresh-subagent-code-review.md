---
id: null
slug: 00052-sdw-fresh-subagent-code-review
title: "SDW Fresh-Subagent Code Review Isolation"
source: local
status: implemented
specDate: 2026-10-22
---

# Specification — SDW Fresh-Subagent Code Review Isolation

## Description

In the current implementation, `sdw-orch` Step 7 and `sdw-code-review` Step 3 permit review through a subagent or through a CLI runner in the calling session. The calling session is frequently the same agent context that implemented the code. Reviewing implementation output inside the originating reasoning context introduces confirmation bias plus transcript contamination, which lowers defect detection quality for self-authored diffs.

This specification mandates context-fresh reviewer isolation: every orchestrated Step 7 verdict originates from a newly spawned subagent session with no implementation transcript. The reviewer brief carries only fenced inputs. The deterministic `sdw-code-review` CLI runs only inside that fresh reviewer session for verdict purposes. Standalone direct invocations receive the same recommendation whenever the caller authored the diff. Remediation through `sdw-fixer` uses a different fresh subagent session, preserving reviewer separation plus never-self-approve.

### Design Intent

Establish a single unbiased review posture across orchestrated plus standalone paths: the reviewer sees only the delivered diff, never the reasoning that produced it. Keep the change documentation-only across three skill surfaces, with no deterministic helper behavior change, so review quality improves without new runtime machinery.

## Acceptance Criteria

- AC1: While sdw-orch Step 7 executes, the orchestrator shall spawn a context-fresh reviewer subagent session for sdw-code-review.
- AC2: The orchestrator skill shall forbid same-session CLI review for a Step 7 verdict.
- AC3: When the reviewer subagent starts, the orchestrator shall provide a brief containing only target root, base reference, report path, scope fence.
- AC4: When the reviewer subagent starts, the orchestrator shall exclude the implementation transcript from the reviewer brief.
- AC5: The sdw-code-review skill shall mandate fresh-session execution for orchestrated invocations.
- AC6: Where the caller authored the diff under review, the sdw-code-review skill shall recommend fresh-session execution.
- AC7: When remediation is required, the orchestrator shall delegate findings to sdw-fixer in a fresh subagent session distinct from the reviewer session.
- AC8: The orchestrator skill shall forbid reviewer self-approval of fixer output.
- AC9: The orchestrator protocol reference shall define the fresh-context isolation contract including rationale, reviewer brief contents, forbidden transcript contents.
- AC10: The modified skill definitions shall remain within Tier-1 line budgets.

## Notes

- Target surfaces (documentation-only, no helper logic change):
  - `skills/sdw-orch/SKILL.md` Step 7: rename to fresh-subagent-only, forbid inline review, scope CLI to reviewer session plus standalone `doctor`/`--dry-run`, state bias rationale, require distinct fixer session.
  - `skills/sdw-orch/references/orchestrator_protocol.md` §2 Step 7 line plus §8 delegation contract: normative MUST plus MUST NOT, brief input list, forbidden transcript list, CLI-inside-reviewer-session rule, reviewer-fixer session separation.
  - `skills/sdw-code-review/SKILL.md`: fresh-context mandate block plus Step 3 retitle to fresh-session-only with never-same-session-CLI wording.
- Reviewer brief allowlist: target root, base reference, report destination path, scope fence. Reviewer brief denylist: implementation transcript, prior worker reasoning, DAG prompts, judge verdicts.
- CLI placement rule: `node skills/sdw-code-review/scripts/sdw_code_review.cjs run` executes inside the fresh reviewer session for Step 7 verdicts. Direct orchestrator-session execution does not constitute a valid Step 7 verdict. Standalone `doctor` plus `--dry-run` remain valid outside this rule.
- Fixer separation: reviewer session plus fixer session are always different sessions. Neither session approves its own output.
- All helper scripts remain Node.js CommonJS (.cjs) using standard library modules only. No new runtime dependencies.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Deterministic session-identity detector in CLI helpers | No runtime signal reliably proves subagent freshness; enforcement stays documentary |
| Step 5 LLM-judge isolation changes | Judge fencing is owned by a separate conformance concern |
| sdw-fixer remediation logic changes | Fixer intake plus scoring behavior is unchanged; only dispatch separation is stated |
| Remote PR review convergence changes | Post-delivery review loops belong to sdw-ship-pr |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Fresh means a new subagent session without implementation transcript | Brief carries fenced inputs only | Removes confirmation bias while keeping reviewer context minimal | y |
| Documentary enforcement is sufficient | No CLI gate proves caller session identity | Runtime detection would be unreliable plus harness-specific | y |
| Tier-1 line budget holds | Keep each SKILL.md near current length | Preserves progressive-disclosure readability | y |
| Standalone author-review stays recommendive | Mandate applies to orchestrated path only | Direct CLI users need a practical escape for quick checks | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| EARS syntax | All 10 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate .sdw/specs/00052-sdw-fresh-subagent-code-review.md --mode=authoring` |
| Scope enclosure | One isolation feature; no judge, fixer-logic, or ship changes | Inspect ## Description plus ## Out of Scope |
| Target inventory | All three skill surfaces named with exact step references | Inspect ## Notes target list |
| Baseline suite | Existing test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Orchestrator Step 7 text contains fresh-subagent-only wording plus same-session CLI prohibition plus bias rationale.
- Code-review skill text contains the fresh-context mandate block plus fresh-session-only triage wording.
- Protocol reference §8 contains the isolation contract including brief allowlist plus transcript denylist.
- Authoring-mode validation of this spec exits `0` with `PASS`.

### Negative & Failing Test Scenarios

- Same-session Step 7 verdict: a review executed inline in the orchestrator session does not satisfy AC1 plus AC2; the run must spawn a fresh reviewer subagent instead.
- Transcript leak: a reviewer brief carrying implementation reasoning violates AC4; the brief must be reissued with fenced inputs only.
- Shared reviewer-fixer session: remediating in the reviewer session violates AC7 plus AC8; a distinct fixer session is required.
