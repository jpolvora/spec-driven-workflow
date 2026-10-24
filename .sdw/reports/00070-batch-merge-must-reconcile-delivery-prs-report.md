# Delivery Report — Batch merge must reconcile delivery and follow-up pull requests

## Metadata

| Field | Value |
|---|---|
| Specification file | `.sdw/specs/00070-batch-merge-must-reconcile-delivery-prs.md` |
| Specification slug | 00070-batch-merge-must-reconcile-delivery-prs |
| Run ID | run-1792850307534-00070-batch-merge-must-reconci |
| Run status | completed |
| Branch | `feature/00070-batch-merge-must-reconcile-delivery-prs` |
| Base branch | `master` |
| Base commit | `b8e955f1e547a54ff6da60f71ca8120df222ca3c` |
| Delivery commit | `67822719fa2e9ca196f0b23a6b5d4f9784516737` |
| Ship status | pending |
| Score | 10/10 (scoreMin 8) |
| Implementation start | 2026-10-24T13:58:29.076Z |
| Implementation end | 2026-10-24T14:29:25.231Z |
| Total wall-clock duration | 30m 56s |
| Generated at | 2026-10-24T14:39:26.049Z |
| Step 1: derivation (skipped) | 5ms |
| Step 2: refinement (completed) | 41ms |
| Step 3: dag_generation (completed) | 10ms |
| Step 4: implementation (completed) | 34m 42s |
| Step 5: scoring (completed) | 26s |
| Step 6: delivery_commit (completed) | 315ms |
| Step 7: code_review (completed) | 841ms |
| Step 8: pr_preparation (completed) | 5m 34s |


## Tasks

| ID | Title | Status | Covered ACs | Checkpoint commit | Started | Completed | Duration |
|---|---|---|---|---|---|---|---|
| task-1 | 00070-batch-merge-must-reconcile-delivery-prs — Core Logic & Foundation | completed | AC1, AC2, AC3 | `412867fa720e91321e0ecfc59589a65829c7bf9a` | 2026-10-24T13:58:29.076Z | 2026-10-24T14:17:34.155Z | 19m 5s |
| task-2 | 00070-batch-merge-must-reconcile-delivery-prs — Workflows, Verification & PR Integration | completed | AC4, AC5 | `67822719fa2e9ca196f0b23a6b5d4f9784516737` | 2026-10-24T14:17:42.172Z | 2026-10-24T14:29:25.231Z | 11m 43s |

## Commits

| SHA | Subject | Range |
|---|---|---|
| `9baaeab` | chore(00070-batch-merge-must-reconcile-delivery-prs): mark the specification completed in the registry | base..HEAD |
| `79fcf2e` | docs(00070-batch-merge-must-reconcile-delivery-prs): record delivery report | base..HEAD |
| `6782271` | task(00070-batch-merge-must-reconcile-delivery-prs): task-2 | base..HEAD |
| `412867f` | task(00070-batch-merge-must-reconcile-delivery-prs): task-1 | base..HEAD |

## Files Changed

### task-1: 00070-batch-merge-must-reconcile-delivery-prs — Core Logic & Foundation

| File | Change |
|---|---|
| `skills/sdw-batch/scripts/batch_queue.cjs` | modified |
| `skills/sdw-orch/scripts/sdw_orch.cjs` | modified |
| `tests/sdw_batch.test.cjs` | modified |

### task-2: 00070-batch-merge-must-reconcile-delivery-prs — Workflows, Verification & PR Integration

| File | Change |
|---|---|
| `skills/sdw-batch/scripts/batch_queue.cjs` | modified |
| `tests/sdw_batch.test.cjs` | modified |
| `skills/sdw-batch/references/batch_protocol.md` | modified |
| `skills/sdw-batch/SKILL.md` | modified |
| `skills/sdw-orch/references/orchestrator_protocol.md` | modified |

### Unattributed changes

| File | Change |
|---|---|
| `.sdw/reports/00070-batch-merge-must-reconcile-delivery-prs-report.md` | added |
| `.sdw/specs/00070-batch-merge-must-reconcile-delivery-prs.md` | modified |
| `.sdw/specs/index.specs.md` | modified |

## Verification

- test gate: status `passed`, exit code `0`, duration 3m 46s
- Step 8 delivery: `completed`

## Fresh Verification & Audit

- Fresh verification: not recorded
- Fresh verification scratch cleanup: not recorded
- Audit: not recorded
- Audit ship gate: not recorded
- Audit blocking criteria: not recorded

## Code Review

- Status: `completed`
- Result: passed
- Findings: 0 error, 0 warning, 0 suggestion
- Blocking findings: 0
- Report: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/00070-batch-merge-must-reconcile-delivery-prs-step-7.md`

## Conformance Judgment

- Score: 10/10 (required minimum 8/10)
- Criteria: 5 verified, 0 failed (5 judged)
- Result: passed
- Source: Step 5 verdict contribution

| Criterion | Verdict | Evidence |
|---|---|---|
| AC1 | verified | skills/sdw-batch/scripts/batch_queue.cjs:179 |
| AC2 | verified | skills/sdw-batch/scripts/batch_queue.cjs:246 |
| AC3 | verified | skills/sdw-batch/scripts/batch_queue.cjs:241 |
| AC4 | verified | skills/sdw-batch/scripts/batch_queue.cjs:262 |
| AC5 | verified | tests/sdw_batch.test.cjs |

## Judge Analysis

- Source: Step 5 judge (advisory; it never changes the score, a gate, the review, or a halt decision)
- Summary: The merge stage now resolves the pull request from the number recorded on run state (`state.prNumber`, written at Step 8) and falls back to the head-branch lookup only when no number was recorded, so an earlier merge can no longer be re-issued against a stale lookup. Before any merge call it probes the provider: an already-merged delivery records `merge.status: merged` with `attempted: false` and `observed: merged`, and issues no call. After the delivery is recorded merged, a different open pull request on the same head branch is merged through the same required-check gate that the pre-flight uses (extracted into the shared `gatedMerge`), and recorded separately under `item.followUp` with its own checks, attempts, and retry outcome; a gate that cannot pass halts the queue naming the failing checks. The failure invariant holds at both write sites: a provider-refused merge is re-probed, and when the delivery is in fact merged it records `merged` with `attempted: true` and `observed: merged`, never `failed`, for the per-item delivery path, the pre-flight earlier-delivery path, and follow-ups. Coverage spans an already-merged delivery, a refused merge on a merged delivery (both write sites), a follow-up merge, a follow-up with pending checks that waits and then merges, and an item with no recorded pull request that records `skipped: no-pr` without fabricating a number. The batch and orchestrator references were synced to the new resolution order, record fields, and follow-up record.

| Severity | Evidence | Risk |
|---|---|---|
| medium | skills/sdw-batch/scripts/batch_queue.cjs:241 | The follow-up merge runs only after the delivery is recorded merged, and it reuses the same required-check gate. A follow-up whose checks never pass halts the queue even though the item itself is complete, so one stuck follow-up PR blocks every later item. |
| low | skills/sdw-batch/scripts/batch_queue.cjs:179 | `state.prNumber` is trusted when present; a run state that records a number for a different branch would target the wrong pull request. The delivery path writes both fields together, but nothing validates that the number belongs to the recorded head branch. |
| low | tests/sdw_batch.test.cjs | The 00058 assertion that the provider is queried exactly once was relaxed to assert the set of queried head branches, because the merge stage now lists the branch again to find a follow-up. Intent preserved, but the stricter call count is gone. |

Follow-ups:
- Record the follow-up merge outcome in the batch summary table so an operator sees a follow-up PR next to the item's delivery
- Validate that a recorded `prNumber` belongs to the item's head branch before trusting it as the delivery identity

## Learnings

Not available

## Retrospective

- Status: `passed`
- Report: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/run-1792850307534-00070-batch-merge-must-reconci.retro.md`
- Data: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/run-1792850307534-00070-batch-merge-must-reconci.retro.json`
- Signals: retries 4 (score 2, review 0, rounds 2, abandonments 0); leftover runs 0; missing artifacts 0; review findings 0 (0 open)
- Candidates: 0
- Applied fixes:
  - none

## Breaking Changes

None detected.

## Quality

- Conformance score: 10/10 (scoreMin 8)
- Judge verdicts: 5 verified, 0 failed (5 judged)
- Review findings: 0 error, 0 warning, 0 suggestion
- Blocking findings: 0
- Executed tests: 18 recorded across 2 accepted task(s) (18 passed, 0 failed, 0 skipped)
- Verification gates: test passed

## Spec Observations

| Kind | Other specification | Evidence | Severity |
|---|---|---|---|
| overlap | 00004-rename-sdw-implement-to-sdw-orch | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00004-rename-sdw-implement-to-sdw-orch" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00005-sdw-orch-multi-spec-batch | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00005-sdw-orch-multi-spec-batch" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00009-sdw-security-checks | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00009-sdw-security-checks" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00010-sdw-orch-branch-worktree-strategy | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00010-sdw-orch-branch-worktree-strategy" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00012-scm-provider-selection | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00012-scm-provider-selection" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00013-sdw-orch-refinement-and-pre-pr-gates | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00013-sdw-orch-refinement-and-pre-pr-gates" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00014-sdw-orch-step-artifacts-persistence | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00014-sdw-orch-step-artifacts-persistence" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00017-sdw-ac-ledger-traceability | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00017-sdw-ac-ledger-traceability" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00018-sdw-fresh-verify-adversarial-audit | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00018-sdw-fresh-verify-adversarial-audit" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00019-sdw-orch-checkpoint-resume | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00019-sdw-orch-checkpoint-resume" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00021-sdw-monitor-telemetry | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00021-sdw-monitor-telemetry" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00023-sdw-reporting-suite | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00023-sdw-reporting-suite" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00024-sdw-ship-pr | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00024-sdw-ship-pr" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00025-sdw-code-review-skill | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00025-sdw-code-review-skill" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00029-sdw-orch-sandboxed-execution" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00030-sdw-micro-task-dag-planning | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00030-sdw-micro-task-dag-planning" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00033-sdw-orch-diagnostic-mode | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00033-sdw-orch-diagnostic-mode" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00039-sdw-batch-skill | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00039-sdw-batch-skill" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00043-us-17-emphasize-step-number-progress-in | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00043-us-17-emphasize-step-number-progress-in" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00044-us-16-add-gitattributes-and-per-task-sa | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00044-us-16-add-gitattributes-and-per-task-sa" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00045-sdw-retro-auto-run | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00045-sdw-retro-auto-run" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00046-sdw-batch-retro-followup | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00046-sdw-batch-retro-followup" both name `tests/sdw_batch_retro.test.cjs`. | high |
| overlap | 00053-batch-auto-merge-sdw-batch-merges-each-d | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00053-batch-auto-merge-sdw-batch-merges-each-d" both name `skills/sdw-batch/scripts/batch_queue.cjs`. | high |
| overlap | 00053-batch-auto-merge-sdw-batch-merges-each-d | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00053-batch-auto-merge-sdw-batch-merges-each-d" both name `tests/sdw_batch.test.cjs`. | high |
| overlap | 00054-sdw-orch-delivery-report-companion-file- | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00054-sdw-orch-delivery-report-companion-file-" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00057-sdw-orch-delivery-report-step-contributions | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00057-sdw-orch-delivery-report-step-contributions" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00058-sdw-batch-delivery-integrity" both name `skills/sdw-batch/scripts/batch_queue.cjs`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00058-sdw-batch-delivery-integrity" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00058-sdw-batch-delivery-integrity" both name `tests/sdw_batch_retro.test.cjs`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00058-sdw-batch-delivery-integrity" both name `tests/sdw_batch.test.cjs`. | high |
| overlap | 00060-sdw-delivery-report-artifact-location | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00060-sdw-delivery-report-artifact-location" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00064-dag-planning-must-prove-acceptance-crite | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00064-dag-planning-must-prove-acceptance-crite" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00067-task-acceptance-links-test-evidence | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00067-task-acceptance-links-test-evidence" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00068-review-findings-must-be-adjudicated | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00068-review-findings-must-be-adjudicated" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00069-dag-planning-must-not-invent-target-files | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00069-dag-planning-must-not-invent-target-files" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00071-superseded-runs-must-be-terminal | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00071-superseded-runs-must-be-terminal" both name `skills/sdw-batch/scripts/batch_queue.cjs`. | high |
| overlap | 00071-superseded-runs-must-be-terminal | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00071-superseded-runs-must-be-terminal" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00071-superseded-runs-must-be-terminal | Specs "00070-batch-merge-must-reconcile-delivery-prs" and "00071-superseded-runs-must-be-terminal" both name `tests/sdw_batch.test.cjs`. | high |

## Notes

- Step 1 (derivation) skipped: not recorded
- Task task-2 accepted after re-dispatch (sequence 2)
- Environment: workspace: 9 changed file(s) in base..HEAD; feature branch reused; SCM provider: github; score iterations: 2

## Outcome

- Result: `completed`
- Delivery commit: `67822719fa2e9ca196f0b23a6b5d4f9784516737`
- Ship status: `pending`
- Duration: 30m 56s

## Step Contributions

- Recorded: 13 contribution(s)

### Step 1: derivation

- **derivation** 2026-10-24T13:58:28.662Z - Derivation skipped
  - Body: `{"status":"skipped","derivationNeeded":false}`

### Step 2: refinement

- **refinement** 2026-10-24T13:58:28.787Z - Refinement resolved 2 decision gap(s)
  - Body: `{"status":"completed","hasGaps":true,"gapsResolved":[{"dimension":"concurrency_and_ordering","question":"How should task execution ordering be scheduled?","chosenOption":"(Recommended) Execute sequentially by default, parallelizing only independent DAG tasks"},{"dimension":"state_persistence","question":"Where should session state be persisted across runs?","chosenOption":"(Recommended) Persist to .sdw/state/{runId}.state.json"}],"specObservations":[{"kind":"overlap","otherSpec":"00004-rename-sdw-implement-to-sdw-orch","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00004-rename-sdw-implement-to-sdw-orch\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00005-sdw-orch-multi-spec-batch","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00005-sdw-orch-multi-spec-batch\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00009-sdw-security-checks","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00009-sdw-security-checks\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00010-sdw-orch-branch-worktree-strategy","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00010-sdw-orch-branch-worktree-strategy\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00012-scm-provider-selection","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00012-scm-provider-selection\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00013-sdw-orch-refinement-and-pre-pr-gates","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00013-sdw-orch-refinement-and-pre-pr-gates\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00014-sdw-orch-step-artifacts-persistence","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00014-sdw-orch-step-artifacts-persistence\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00017-sdw-ac-ledger-traceability","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00017-sdw-ac-ledger-traceability\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00018-sdw-fresh-verify-adversarial-audit","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00018-sdw-fresh-verify-adversarial-audit\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00019-sdw-orch-checkpoint-resume","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00019-sdw-orch-checkpoint-resume\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00021-sdw-monitor-telemetry","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00021-sdw-monitor-telemetry\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00023-sdw-reporting-suite","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00023-sdw-reporting-suite\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00024-sdw-ship-pr","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00024-sdw-ship-pr\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00025-sdw-code-review-skill","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00025-sdw-code-review-skill\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00029-sdw-orch-sandboxed-execution\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00030-sdw-micro-task-dag-planning","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00030-sdw-micro-task-dag-planning\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00033-sdw-orch-diagnostic-mode","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00033-sdw-orch-diagnostic-mode\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00039-sdw-batch-skill","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00039-sdw-batch-skill\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00043-us-17-emphasize-step-number-progress-in","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00043-us-17-emphasize-step-number-progress-in\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00044-us-16-add-gitattributes-and-per-task-sa","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00044-us-16-add-gitattributes-and-per-task-sa\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00045-sdw-retro-auto-run","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00045-sdw-retro-auto-run\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00046-sdw-batch-retro-followup","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00046-sdw-batch-retro-followup\" both name 'tests/sdw_batch_retro.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00053-batch-auto-merge-sdw-batch-merges-each-d","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00053-batch-auto-merge-sdw-batch-merges-each-d\" both name 'skills/sdw-batch/scripts/batch_queue.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00053-batch-auto-merge-sdw-batch-merges-each-d","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00053-batch-auto-merge-sdw-batch-merges-each-d\" both name 'tests/sdw_batch.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00054-sdw-orch-delivery-report-companion-file-","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00054-sdw-orch-delivery-report-companion-file-\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00057-sdw-orch-delivery-report-step-contributions","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00057-sdw-orch-delivery-report-step-contributions\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00058-sdw-batch-delivery-integrity\" both name 'skills/sdw-batch/scripts/batch_queue.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00058-sdw-batch-delivery-integrity\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00058-sdw-batch-delivery-integrity\" both name 'tests/sdw_batch_retro.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00058-sdw-batch-delivery-integrity\" both name 'tests/sdw_batch.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00060-sdw-delivery-report-artifact-location","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00060-sdw-delivery-report-artifact-location\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00064-dag-planning-must-prove-acceptance-crite","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00064-dag-planning-must-prove-acceptance-crite\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00067-task-acceptance-links-test-evidence","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00067-task-acceptance-links-test-evidence\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00068-review-findings-must-be-adjudicated","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00068-review-findings-must-be-adjudicated\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00069-dag-planning-must-not-invent-target-files","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00069-dag-planning-must-not-invent-target-files\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00071-superseded-runs-must-be-terminal","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00071-superseded-runs-must-be-terminal\" both name 'skills/sdw-batch/scripts/batch_queue.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00071-superseded-runs-must-be-terminal","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00071-superseded-runs-must-be-terminal\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00071-superseded-runs-must-be-terminal","evidence":"Specs \"00070-batch-merge-must-reconcile-delivery-prs\" and \"00071-superseded-runs-must-be-terminal\" both name 'tests/sdw_batch.test.cjs'.","severity":"high"}]}`
  - Evidence: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/00070-batch-merge-must-reconcile-delivery-prs-step-2.md`

### Step 3: dag_generation

- **plan** 2026-10-24T13:58:29.006Z - DAG plan: 2 task(s)
  - Body: `{"taskIds":["task-1","task-2"],"dependencyOrder":[{"id":"task-1","dependencies":[]},{"id":"task-2","dependencies":["task-1"]}],"dispatchMode":"subagent","complexity":{"acCount":5,"touchpoints":["state","vcs","pr"],"targetFileCount":4,"level":"standard","isComplex":false}}`
  - Evidence: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/00070-batch-merge-must-reconcile-delivery-prs-step-3.md`

### Step 4: implementation

- **task** 2026-10-24T14:33:11.370Z - Task task-1 accepted
  - Body: `{"taskId":"task-1","outcome":"success","filesChanged":["skills/sdw-batch/scripts/batch_queue.cjs","skills/sdw-orch/scripts/sdw_orch.cjs","tests/sdw_batch.test.cjs"],"retries":0,"abandonments":[],"commit":"412867fa720e91321e0ecfc59589a65829c7bf9a","acIds":["AC1","AC2","AC3"]}`
  - Evidence: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/task-task-1.evidence.json`

### Step 5: scoring

- **verdict** 2026-10-24T14:33:44.167Z - Conformance score 10/8
  - Body: `{"score":10,"minScore":8,"passed":true,"verifiedCount":5,"failingCount":0,"verdicts":[{"id":"AC1","verdict":"verified","evidence":"skills/sdw-batch/scripts/batch_queue.cjs:179"},{"id":"AC2","verdict":"verified","evidence":"skills/sdw-batch/scripts/batch_queue.cjs:246"},{"id":"AC3","verdict":"verified","evidence":"skills/sdw-batch/scripts/batch_queue.cjs:241"},{"id":"AC4","verdict":"verified","evidence":"skills/sdw-batch/scripts/batch_queue.cjs:262"},{"id":"AC5","verdict":"verified","evidence":"tests/sdw_batch.test.cjs"}]}`
  - Evidence: `skills/sdw-batch/scripts/batch_queue.cjs:179`, `skills/sdw-batch/scripts/batch_queue.cjs:246`, `skills/sdw-batch/scripts/batch_queue.cjs:241`, `skills/sdw-batch/scripts/batch_queue.cjs:262`, `tests/sdw_batch.test.cjs`
- **judgment** 2026-10-24T14:33:44.167Z - Judge analysis
  - Body: `{"summary":"The merge stage now resolves the pull request from the number recorded on run state ('state.prNumber', written at Step 8) and falls back to the head-branch lookup only when no number was recorded, so an earlier merge can no longer be re-issued against a stale lookup. Before any merge call it probes the provider: an already-merged delivery records 'merge.status: merged' with 'attempted: false' and 'observed: merged', and issues no call. After the delivery is recorded merged, a different open pull request on the same head branch is merged through the same required-check gate that the pre-flight uses (extracted into the shared 'gatedMerge'), and recorded separately under 'item.followUp' with its own checks, attempts, and retry outcome; a gate that cannot pass halts the queue naming the failing checks. The failure invariant holds at both write sites: a provider-refused merge is re-probed, and when the delivery is in fact merged it records 'merged' with 'attempted: true' and 'observed: merged', never 'failed', for the per-item delivery path, the pre-flight earlier-delivery path, and follow-ups. Coverage spans an already-merged delivery, a refused merge on a merged delivery (both write sites), a follow-up merge, a follow-up with pending checks that waits and then merges, and an item with no recorded pull request that records 'skipped: no-pr' without fabricating a number. The batch and orchestrator references were synced to the new resolution order, record fields, and follow-up record.","risks":[{"severity":"medium","evidence":"skills/sdw-batch/scripts/batch_queue.cjs:241","note":"The follow-up merge runs only after the delivery is recorded merged, and it reuses the same required-check gate. A follow-up whose checks never pass halts the queue even though the item itself is complete, so one stuck follow-up PR blocks every later item."},{"severity":"low","evidence":"skills/sdw-batch/scripts/batch_queue.cjs:179","note":"'state.prNumber' is trusted when present; a run state that records a number for a different branch would target the wrong pull request. The delivery path writes both fields together, but nothing validates that the number belongs to the recorded head branch."},{"severity":"low","evidence":"tests/sdw_batch.test.cjs","note":"The 00058 assertion that the provider is queried exactly once was relaxed to assert the set of queried head branches, because the merge stage now lists the branch again to find a follow-up. Intent preserved, but the stricter call count is gone."}],"followUps":["Record the follow-up merge outcome in the batch summary table so an operator sees a follow-up PR next to the item's delivery","Validate that a recorded 'prNumber' belongs to the item's head branch before trusting it as the delivery identity"]}`
  - Evidence: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/00070-batch-merge-must-reconcile-delivery-prs-step-5.md`

### Step 6: delivery_commit

- **delivery** 2026-10-24T14:33:44.785Z - Delivery commit 67822719fa2e9ca196f0b23a6b5d4f9784516737
  - Body: `{"deliveryCommit":"67822719fa2e9ca196f0b23a6b5d4f9784516737","deliveryCommitCreated":false,"stagedFiles":[".sdw/specs/00070-batch-merge-must-reconcile-delivery-prs.md",".sdw/specs/index.specs.md","skills/sdw-batch/SKILL.md","skills/sdw-batch/references/batch_protocol.md","skills/sdw-batch/scripts/batch_queue.cjs","skills/sdw-orch/references/orchestrator_protocol.md","skills/sdw-orch/scripts/sdw_orch.cjs","tests/sdw_batch.test.cjs"],"securityGate":{"bypassed":false,"status":"not run"}}`
  - Evidence: `.sdw/specs/00070-batch-merge-must-reconcile-delivery-prs.md`, `.sdw/specs/index.specs.md`, `skills/sdw-batch/SKILL.md`, `skills/sdw-batch/references/batch_protocol.md`, `skills/sdw-batch/scripts/batch_queue.cjs`, `skills/sdw-orch/references/orchestrator_protocol.md`, `skills/sdw-orch/scripts/sdw_orch.cjs`, `tests/sdw_batch.test.cjs`

### Step 7: code_review

- **review** 2026-10-24T14:33:45.982Z - Review iteration 1
  - Body: `{"iteration":1,"findings":{"error":0,"warning":0,"suggestion":0,"info":0},"fixes":[],"passed":true}`
  - Evidence: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/00070-batch-merge-must-reconcile-delivery-prs-step-7.md`

### Step 8: pr_preparation

- **convergence** 2026-10-24T14:39:20.543Z - Convergence iteration 1
  - Body: `{"iteration":1,"rounds":2,"failingChecks":[],"openThreads":0,"resolvedThreads":0,"fixCommit":null,"converged":false}`
- **convergence** 2026-10-24T14:39:21.124Z - Convergence iteration 2
  - Body: `{"iteration":2,"rounds":2,"failingChecks":[],"openThreads":0,"resolvedThreads":0,"fixCommit":null,"converged":true}`
- **gates** 2026-10-24T14:39:21.775Z - Pre-PR gates: 6 result(s)
  - Body: `{"gates":[{"name":"prePrCommand","status":"skipped","detail":"prePrCommand is not configured"},{"name":"build","status":"skipped","detail":"requiredBuild is false"},{"name":"tests","status":"pass","detail":"npm test exited 0"},{"name":"security","status":"pass","detail":"sdw-security-checks found no blocking leak"},{"name":"runState","status":"pass","detail":"step 4, step 6 and step 7 completed; score 10 >= scoreMin 8"},{"name":"discovery","status":"pass","detail":"no prepare obligations discovered"}]}`
- **ship** 2026-10-24T14:39:21.775Z - Pull request #74
  - Body: `{"pushed":true,"branch":"feature/00070-batch-merge-must-reconcile-delivery-prs","pullRequest":{"number":"74","url":"https://github.com/jpolvora/spec-driven-workflow/pull/74","title":null},"shipStatus":"delivered"}`
  - Evidence: `https://github.com/jpolvora/spec-driven-workflow/pull/74`

### Step 9: retrospective

- **retro** 2026-10-24T14:39:25.415Z - Retrospective passed: 0 candidate(s)
  - Body: `{"status":"passed","runStatus":"completed","signals":{"retries":{"scoreIterations":2,"reviewIterations":0,"reviewRounds":2,"dispatchAbandonments":0,"total":4},"leftoverRuns":0,"missingArtifacts":0,"reviewFindings":{"total":0,"open":0}},"candidates":[],"fixes":{"recorded":[],"consolidated":null,"queuedSpecifications":[],"failures":[]},"routedCandidates":[],"reportMd":".sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/run-1792850307534-00070-batch-merge-must-reconci.retro.md","reportJson":".sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/run-1792850307534-00070-batch-merge-must-reconci.retro.json"}`
  - Evidence: `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/run-1792850307534-00070-batch-merge-must-reconci.retro.md`, `.sdw/state/00070-batch-merge-must-reconcile-delivery-prs/run-1792850307534-00070-batch-merge-must-reconci/run-1792850307534-00070-batch-merge-must-reconci.retro.json`
