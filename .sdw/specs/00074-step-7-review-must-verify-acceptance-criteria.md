---
id: null
localSpecId: "00074"
slug: 00074-step-7-review-must-verify-acceptance-criteria
title: "Step 7 review must verify acceptance-criterion conformance"
source: local
status: draft
specDate: 2026-10-25
priority: medium
value: "Turns an independent review that found zero defects on two conditional implementations into one that checks the delivered behavior against the acceptance criteria"
effort: M
---

# Specification — Step 7 review must verify acceptance-criterion conformance

## Description

Step 7 must verify each acceptance criterion against the delivered behavior, not only the diff hygiene.

In batch `batch-1792826020541`, Step 7 recorded zero findings on all five deliveries, and the conformance judge verified every criterion. The provider's independent reviewer then found two real defects: `00069` AC4 was implemented only for specifications registered as pending and not sandboxed, so an unregistered pathless specification still planned with zero target files; and `00070` selected an already merged pull request on the reused head branch as the follow-up. Both were fixed after the merge attempt (`370f3b7`, `a0fed31`).

The local reviewer cannot catch either class. Its brief allowlist carries only target root, base reference, report path, and scope fence ([`orchestrator_protocol.md`](../../skills/sdw-orch/references/orchestrator_protocol.md) section 8), so it never reads the acceptance criteria; the deterministic scan checks syntax and hygiene rules only ([`code_review_rules.md`](../../skills/sdw-code-review/references/code_review_rules.md)). A criterion implemented under a condition the specification does not state therefore passes review, and the judge scores the ledger it was given.

### Design Intent

The reviewer is the only independent reader of the diff before ship. Giving it the acceptance-criteria text and requiring one verdict per criterion turns "no findings" into a claim about the contract, not just about code style. The criteria are contract text, not the implementation transcript, so they belong in the fenced brief without weakening the fresh-session rule.

## Acceptance Criteria

- AC1: When Step 7 review starts for a run, the system shall provide the reviewer with the specification acceptance criteria in addition to the existing scope fence.
- AC2: The system shall require one conformance verdict per acceptance criterion with `satisfied`, `violated`, or `unverifiable` as the only accepted values.
- AC3: If a criterion has no verdict when the review completes, then the system shall record an `unverifiable` verdict for it.
- AC4: When a verdict is `violated`, the system shall record a blocking finding naming the criterion id and the contradicting behavior.
- AC5: If a criterion holds only under a condition the specification does not state, then the system shall record a `violated` verdict naming that condition.
- AC6: The system shall record the per-criterion verdicts on the Step 7 output and in the delivery report.
- AC7: The system shall cover the satisfied, violated, unverifiable, missing-verdict, and conditional-implementation paths with tests.

## Notes

- Evidence: `00069` AC4 found by the provider review at `11:17:16Z` and fixed in `370f3b7`; `00070` follow-up selection found at `14:40:22Z` and fixed in `a0fed31`; both runs recorded zero Step 7 findings.
- Implementation surfaces: [`sdw_orch.cjs`](../../skills/sdw-orch/scripts/sdw_orch.cjs) (`buildReviewerBrief` at line 1595 and the Step 7 recording), [`orchestrator_protocol.md`](../../skills/sdw-orch/references/orchestrator_protocol.md) section 8, [`code_review_rules.md`](../../skills/sdw-code-review/references/code_review_rules.md) and [`sdw_code_review.cjs`](../../skills/sdw-code-review/scripts/sdw_code_review.cjs) for the report schema, [`delivery_report.cjs`](../../skills/sdw-orch/scripts/delivery_report.cjs), [`tests/sdw_code_review.test.cjs`](../../tests/sdw_code_review.test.cjs) and [`tests/sdw_orch.test.cjs`](../../tests/sdw_orch.test.cjs).
- The deterministic CLI cannot judge semantics. The verdicts come from the fresh reviewer session; the CLI and the report record them. The deterministic scan stays unchanged.
- The brief remains fenced: acceptance criteria are contract text. Worker reasoning, the implementation transcript, DAG prompts, and judge verdicts stay excluded.
- Verdict ids use the specification's own criterion ids (`AC1`, `AC2`); no second identity is minted.
- A `violated` verdict becomes a Step 7 finding and flows through the disposition gate from spec 00068, so it must be fixed or waived before ship.
- `unverifiable` is not a violation. It is recorded and reported, and the judge and score decide the outcome.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing the deterministic review rules | The semantic verdict supplements the scan, never replaces it |
| Changing the reviewer model | Model routing stays advisory, per spec 00056 |
| Auto-fixing a violated criterion | The fixer and worker paths own remediation |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Verdict source | The fresh reviewer session | The CLI is deterministic and cannot judge semantics | y |
| Brief allowlist change | Add the specification path, criteria text only | Contract text is not implementation reasoning | y |
| Missing verdict | `unverifiable` plus a finding | Silence is not evidence of conformance | y |
| Conditional implementation | `violated` | Matches the observed `00069` defect | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Reviewer brief | `buildReviewerBrief` and the allowlist rule understood | Read the function and protocol section 8 |
| Report schema | Current review report fields and writer identified | Read `code_review_rules.md` and `sdw_code_review.cjs` |
| Finding lifecycle | `fixed`/`waived` disposition gate understood | Read spec 00068 and `review_findings.cjs` |
| Test seams | Step 7 output and report assertions located | Read `tests/sdw_orch.test.cjs` and `tests/sdw_code_review.test.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `step7.output.acVerdicts` with one entry per criterion.
- Counts of `satisfied`, `violated`, and `unverifiable` in the delivery report.
- A finding per `violated` or missing verdict, carrying the criterion id.

### Negative & Failing Test Scenarios

- Missing verdict: the criterion is recorded `unverifiable` and a finding names it.
- Conditional implementation: the criterion is recorded `violated` with the unstated condition.
- A `violated` verdict with no disposition blocks Step 8.
- A brief that carries the transcript: the renderer refuses the extra key.
