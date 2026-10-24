# Delivery Report — A superseded run must be recorded as terminal

## Metadata

| Field | Value |
|---|---|
| Specification file | `.sdw/specs/00071-superseded-runs-must-be-terminal.md` |
| Specification slug | 00071-superseded-runs-must-be-terminal |
| Run ID | run-1792845560345-00071-superseded-runs-must-be- |
| Run status | completed |
| Branch | `feature/00071-superseded-runs-must-be-terminal` |
| Base branch | `master` |
| Base commit | `454a0c04f0f5076c19405bf3cc2084904eeea907` |
| Delivery commit | `c0eb20cecccc580a5b17128cabea8bdc79ea4caa` |
| Ship status | review_pending |
| Score | 10/10 (scoreMin 8) |
| Implementation start | 2026-10-24T12:39:22.474Z |
| Implementation end | 2026-10-24T13:06:57.219Z |
| Total wall-clock duration | 27m 34s |
| Generated at | 2026-10-24T13:56:39.982Z |
| Step 1: derivation (skipped) | 6ms |
| Step 2: refinement (completed) | 42ms |
| Step 3: dag_generation (completed) | 10ms |
| Step 4: implementation (completed) | 30m 44s |
| Step 5: scoring (completed) | 28s |
| Step 6: delivery_commit (completed) | 338ms |
| Step 7: code_review (completed) | 1s |
| Step 8: pr_preparation (completed) | 45m 50s |


## Tasks

| ID | Title | Status | Covered ACs | Checkpoint commit | Started | Completed | Duration |
|---|---|---|---|---|---|---|---|
| task-1 | 00071-superseded-runs-must-be-terminal — Core Logic & Foundation | completed | AC1, AC2, AC3 | `5fc0f9c5c5d24d256b7521d766f6214ccf43ba7e` | 2026-10-24T12:39:22.474Z | 2026-10-24T12:55:13.763Z | 15m 51s |
| task-2 | 00071-superseded-runs-must-be-terminal — Workflows, Verification & PR Integration | completed | AC4, AC5 | `c0eb20cecccc580a5b17128cabea8bdc79ea4caa` | 2026-10-24T12:55:17.674Z | 2026-10-24T13:06:57.219Z | 11m 39s |

## Commits

| SHA | Subject | Range |
|---|---|---|
| `6410be9` | chore(00071-superseded-runs-must-be-terminal): mark the specification completed in the registry | base..HEAD |
| `7fd43a4` | docs(00071-superseded-runs-must-be-terminal): record delivery report | base..HEAD |
| `bd22aaa` | fix(00071-superseded-runs-must-be-terminal): recover an interrupted supersession on the next queue pass | base..HEAD |
| `f10af3b` | docs(00071-superseded-runs-must-be-terminal): record delivery report | base..HEAD |
| `9c84849` | fix(00071-superseded-runs-must-be-terminal): refuse a superseded run id and persist the replacement first | base..HEAD |
| `94baacd` | docs(00071-superseded-runs-must-be-terminal): record delivery report | base..HEAD |
| `c0eb20c` | task(00071-superseded-runs-must-be-terminal): task-2 | base..HEAD |
| `5fc0f9c` | task(00071-superseded-runs-must-be-terminal): task-1 | base..HEAD |

## Files Changed

### task-1: 00071-superseded-runs-must-be-terminal — Core Logic & Foundation

| File | Change |
|---|---|
| `skills/sdw-batch/scripts/batch_queue.cjs` | modified |
| `skills/sdw-orch/scripts/state_manager.cjs` | modified |
| `skills/sdw-orch/scripts/sdw_orch.cjs` | modified |
| `skills/sdw-orch/scripts/monitor.cjs` | modified |
| `skills/sdw-retro/scripts/retro.cjs` | modified |
| `tests/sdw_batch.test.cjs` | modified |
| `tests/sdw_retro.test.cjs` | modified |
| `tests/sdw_run_supersession.test.cjs` | added |

### task-2: 00071-superseded-runs-must-be-terminal — Workflows, Verification & PR Integration

| File | Change |
|---|---|
| `skills/sdw-retro/scripts/retro.cjs` | modified |
| `skills/sdw-retro/SKILL.md` | modified |
| `skills/sdw-retro/references/retro_protocol.md` | modified |
| `tests/sdw_retro.test.cjs` | modified |

### Unattributed changes

| File | Change |
|---|---|
| `.sdw/reports/00071-superseded-runs-must-be-terminal-report.md` | added |
| `.sdw/specs/00071-superseded-runs-must-be-terminal.md` | modified |
| `.sdw/specs/index.specs.md` | modified |
| `skills/sdw-batch/references/batch_protocol.md` | modified |
| `skills/sdw-orch/references/orchestrator_protocol.md` | modified |

## Verification

- test gate: status `passed`, exit code `0`, duration 3m 9s
- Step 8 delivery: `completed` (ship status `review_pending`)

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
- Report: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/00071-superseded-runs-must-be-terminal-step-7.md`

## Conformance Judgment

- Score: 10/10 (required minimum 8/10)
- Criteria: 5 verified, 0 failed (5 judged)
- Result: passed
- Source: Step 5 verdict contribution

| Criterion | Verdict | Evidence |
|---|---|---|
| AC1 | verified | skills/sdw-orch/scripts/state_manager.cjs:114 |
| AC2 | verified | skills/sdw-orch/scripts/monitor.cjs:48 |
| AC3 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:83 |
| AC4 | verified | skills/sdw-retro/scripts/retro.cjs:216 |
| AC5 | verified | tests/sdw_run_supersession.test.cjs:300 |

## Judge Analysis

- Source: Step 5 judge (advisory; it never changes the score, a gate, the review, or a halt decision)
- Summary: Supersession is now a recorded terminal state instead of a silent flag. `state_manager.markRunSuperseded` writes `status: superseded` with `supersededBy` and `supersededAt` under the run lock, and the batch's `--new-run` path generates the replacement run id first, marks the old state superseded with it, and records both `supersededRunId` and the replacement on the item. The status is terminal everywhere it is classified: `monitor` lists it in TERMINAL_STATUSES, the retro leftOver detection excludes it, `findOpenRunsForSpec` and `openRunsForSpec` treat it as closed, and `resume` refuses it with exit 1 before doing any work, naming the replacing run and the `resume --run-id <replacement>` remediation. The retrospective gains a `superseded_runs` signal and a `### Superseded Runs` section naming each replaced run and its replacement, and both authoritative retro docs are synced so the signal table and the leftover rule describe what the code emits (`leftover_run` excludes completed, failed, and superseded). One existing 00058 assertion that a replaced state stays `paused` was updated to the new contract rather than deleted, and the new coverage spans recording, monitor classification, resume refusal, retro exclusion, and sibling naming.

| Severity | Evidence | Risk |
|---|---|---|
| medium | skills/sdw-batch/scripts/batch_queue.cjs:33 | The `--new-run` path now assigns `item.runId` to the replacement before any delegation. A resume after an interrupted supersession could reconcile against a run that was never started; the superseded record makes the old run unambiguous, but the item's own status still needs care. |
| low | skills/sdw-orch/scripts/state_manager.cjs:114 | `markRunSuperseded` requires a non-empty replacing run id and otherwise leaves the state untouched; the batch is the only caller and always supplies one, but a future caller must handle the refusal. |
| low | tests/sdw_batch.test.cjs | The 00058 stale-run assertion changed from `paused` to `superseded`. A reviewer should confirm the new expectation is the intended contract rather than the old behavior being silently dropped. |

Follow-ups:
- Expose superseded runs in the batch summary with their replacement run id, so an operator reading the queue sees why an item starts a new run
- Let `monitor` group superseded runs behind a flag instead of only excluding them from the active list

## Learnings

Not available

## Retrospective

- Status: `passed`
- Report: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/run-1792845560345-00071-superseded-runs-must-be-.retro.md`
- Data: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/run-1792845560345-00071-superseded-runs-must-be-.retro.json`
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
- Executed tests: 11 recorded across 2 accepted task(s) (11 passed, 0 failed, 0 skipped)
- Verification gates: test passed

## Spec Observations

| Kind | Other specification | Evidence | Severity |
|---|---|---|---|
| overlap | 00004-rename-sdw-implement-to-sdw-orch | Specs "00071-superseded-runs-must-be-terminal" and "00004-rename-sdw-implement-to-sdw-orch" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00005-sdw-orch-multi-spec-batch | Specs "00071-superseded-runs-must-be-terminal" and "00005-sdw-orch-multi-spec-batch" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00009-sdw-security-checks | Specs "00071-superseded-runs-must-be-terminal" and "00009-sdw-security-checks" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00010-sdw-orch-branch-worktree-strategy | Specs "00071-superseded-runs-must-be-terminal" and "00010-sdw-orch-branch-worktree-strategy" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00012-scm-provider-selection | Specs "00071-superseded-runs-must-be-terminal" and "00012-scm-provider-selection" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00013-sdw-orch-refinement-and-pre-pr-gates | Specs "00071-superseded-runs-must-be-terminal" and "00013-sdw-orch-refinement-and-pre-pr-gates" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00014-sdw-orch-step-artifacts-persistence | Specs "00071-superseded-runs-must-be-terminal" and "00014-sdw-orch-step-artifacts-persistence" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00014-sdw-orch-step-artifacts-persistence | Specs "00071-superseded-runs-must-be-terminal" and "00014-sdw-orch-step-artifacts-persistence" both name `skills/sdw-orch/scripts/state_manager.cjs`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00071-superseded-runs-must-be-terminal" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00071-superseded-runs-must-be-terminal" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-orch/scripts/state_manager.cjs`. | high |
| overlap | 00017-sdw-ac-ledger-traceability | Specs "00071-superseded-runs-must-be-terminal" and "00017-sdw-ac-ledger-traceability" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00017-sdw-ac-ledger-traceability | Specs "00071-superseded-runs-must-be-terminal" and "00017-sdw-ac-ledger-traceability" both name `skills/sdw-orch/scripts/state_manager.cjs`. | high |
| overlap | 00018-sdw-fresh-verify-adversarial-audit | Specs "00071-superseded-runs-must-be-terminal" and "00018-sdw-fresh-verify-adversarial-audit" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00019-sdw-orch-checkpoint-resume | Specs "00071-superseded-runs-must-be-terminal" and "00019-sdw-orch-checkpoint-resume" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00019-sdw-orch-checkpoint-resume | Specs "00071-superseded-runs-must-be-terminal" and "00019-sdw-orch-checkpoint-resume" both name `skills/sdw-orch/scripts/state_manager.cjs`. | high |
| overlap | 00021-sdw-monitor-telemetry | Specs "00071-superseded-runs-must-be-terminal" and "00021-sdw-monitor-telemetry" both name `skills/sdw-orch/scripts/monitor.cjs`. | high |
| overlap | 00021-sdw-monitor-telemetry | Specs "00071-superseded-runs-must-be-terminal" and "00021-sdw-monitor-telemetry" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00023-sdw-reporting-suite | Specs "00071-superseded-runs-must-be-terminal" and "00023-sdw-reporting-suite" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00024-sdw-ship-pr | Specs "00071-superseded-runs-must-be-terminal" and "00024-sdw-ship-pr" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00025-sdw-code-review-skill | Specs "00071-superseded-runs-must-be-terminal" and "00025-sdw-code-review-skill" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00071-superseded-runs-must-be-terminal" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00071-superseded-runs-must-be-terminal" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-orch/scripts/state_manager.cjs`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00071-superseded-runs-must-be-terminal" and "00029-sdw-orch-sandboxed-execution" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00071-superseded-runs-must-be-terminal" and "00029-sdw-orch-sandboxed-execution" both name `skills/sdw-orch/scripts/state_manager.cjs`. | high |
| overlap | 00030-sdw-micro-task-dag-planning | Specs "00071-superseded-runs-must-be-terminal" and "00030-sdw-micro-task-dag-planning" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00033-sdw-orch-diagnostic-mode | Specs "00071-superseded-runs-must-be-terminal" and "00033-sdw-orch-diagnostic-mode" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00037-sdw-run-retrospective-candidates | Specs "00071-superseded-runs-must-be-terminal" and "00037-sdw-run-retrospective-candidates" both name `skills/sdw-retro/scripts/retro.cjs`. | high |
| overlap | 00039-sdw-batch-skill | Specs "00071-superseded-runs-must-be-terminal" and "00039-sdw-batch-skill" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00043-us-17-emphasize-step-number-progress-in | Specs "00071-superseded-runs-must-be-terminal" and "00043-us-17-emphasize-step-number-progress-in" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00044-us-16-add-gitattributes-and-per-task-sa | Specs "00071-superseded-runs-must-be-terminal" and "00044-us-16-add-gitattributes-and-per-task-sa" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00045-sdw-retro-auto-run | Specs "00071-superseded-runs-must-be-terminal" and "00045-sdw-retro-auto-run" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00045-sdw-retro-auto-run | Specs "00071-superseded-runs-must-be-terminal" and "00045-sdw-retro-auto-run" both name `skills/sdw-orch/scripts/state_manager.cjs`. | high |
| overlap | 00045-sdw-retro-auto-run | Specs "00071-superseded-runs-must-be-terminal" and "00045-sdw-retro-auto-run" both name `skills/sdw-retro/scripts/retro.cjs`. | high |
| overlap | 00045-sdw-retro-auto-run | Specs "00071-superseded-runs-must-be-terminal" and "00045-sdw-retro-auto-run" both name `tests/sdw_retro.test.cjs`. | high |
| overlap | 00047-sdw-retro-session-discovery | Specs "00071-superseded-runs-must-be-terminal" and "00047-sdw-retro-session-discovery" both name `skills/sdw-retro/scripts/retro.cjs`. | high |
| overlap | 00047-sdw-retro-session-discovery | Specs "00071-superseded-runs-must-be-terminal" and "00047-sdw-retro-session-discovery" both name `tests/sdw_retro.test.cjs`. | high |
| overlap | 00048-sdw-retro-signal-precision | Specs "00071-superseded-runs-must-be-terminal" and "00048-sdw-retro-signal-precision" both name `skills/sdw-retro/scripts/retro.cjs`. | high |
| overlap | 00048-sdw-retro-signal-precision | Specs "00071-superseded-runs-must-be-terminal" and "00048-sdw-retro-signal-precision" both name `tests/sdw_retro.test.cjs`. | high |
| overlap | 00053-batch-auto-merge-sdw-batch-merges-each-d | Specs "00071-superseded-runs-must-be-terminal" and "00053-batch-auto-merge-sdw-batch-merges-each-d" both name `skills/sdw-batch/scripts/batch_queue.cjs`. | high |
| overlap | 00053-batch-auto-merge-sdw-batch-merges-each-d | Specs "00071-superseded-runs-must-be-terminal" and "00053-batch-auto-merge-sdw-batch-merges-each-d" both name `tests/sdw_batch.test.cjs`. | high |
| overlap | 00054-sdw-orch-delivery-report-companion-file- | Specs "00071-superseded-runs-must-be-terminal" and "00054-sdw-orch-delivery-report-companion-file-" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00057-sdw-orch-delivery-report-step-contributions | Specs "00071-superseded-runs-must-be-terminal" and "00057-sdw-orch-delivery-report-step-contributions" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00057-sdw-orch-delivery-report-step-contributions | Specs "00071-superseded-runs-must-be-terminal" and "00057-sdw-orch-delivery-report-step-contributions" both name `skills/sdw-retro/scripts/retro.cjs`. | high |
| overlap | 00057-sdw-orch-delivery-report-step-contributions | Specs "00071-superseded-runs-must-be-terminal" and "00057-sdw-orch-delivery-report-step-contributions" both name `tests/sdw_retro.test.cjs`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00071-superseded-runs-must-be-terminal" and "00058-sdw-batch-delivery-integrity" both name `skills/sdw-batch/scripts/batch_queue.cjs`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00071-superseded-runs-must-be-terminal" and "00058-sdw-batch-delivery-integrity" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00071-superseded-runs-must-be-terminal" and "00058-sdw-batch-delivery-integrity" both name `tests/sdw_batch.test.cjs`. | high |
| overlap | 00060-sdw-delivery-report-artifact-location | Specs "00071-superseded-runs-must-be-terminal" and "00060-sdw-delivery-report-artifact-location" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00064-dag-planning-must-prove-acceptance-crite | Specs "00071-superseded-runs-must-be-terminal" and "00064-dag-planning-must-prove-acceptance-crite" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00067-task-acceptance-links-test-evidence | Specs "00071-superseded-runs-must-be-terminal" and "00067-task-acceptance-links-test-evidence" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00068-review-findings-must-be-adjudicated | Specs "00071-superseded-runs-must-be-terminal" and "00068-review-findings-must-be-adjudicated" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |
| overlap | 00068-review-findings-must-be-adjudicated | Specs "00071-superseded-runs-must-be-terminal" and "00068-review-findings-must-be-adjudicated" both name `skills/sdw-retro/scripts/retro.cjs`. | high |
| overlap | 00068-review-findings-must-be-adjudicated | Specs "00071-superseded-runs-must-be-terminal" and "00068-review-findings-must-be-adjudicated" both name `tests/sdw_retro.test.cjs`. | high |
| overlap | 00069-dag-planning-must-not-invent-target-files | Specs "00071-superseded-runs-must-be-terminal" and "00069-dag-planning-must-not-invent-target-files" both name `skills/sdw-orch/scripts/sdw_orch.cjs`. | high |

## Notes

- Step 1 (derivation) skipped: not recorded
- Task task-2 accepted after re-dispatch (sequence 2)
- Environment: workspace: 15 changed file(s) in base..HEAD; feature branch reused; SCM provider: github; score iterations: 2

## Outcome

- Result: `completed`
- Delivery commit: `c0eb20cecccc580a5b17128cabea8bdc79ea4caa`
- Ship status: `review_pending`
- Duration: 27m 34s

## Step Contributions

- Recorded: 13 contribution(s)

### Step 1: derivation

- **derivation** 2026-10-24T12:39:21.925Z - Derivation skipped
  - Body: `{"status":"skipped","derivationNeeded":false}`

### Step 2: refinement

- **refinement** 2026-10-24T12:39:22.237Z - Refinement resolved 1 decision gap(s)
  - Body: `{"status":"completed","hasGaps":true,"gapsResolved":[{"dimension":"concurrency_and_ordering","question":"How should task execution ordering be scheduled?","chosenOption":"(Recommended) Execute sequentially by default, parallelizing only independent DAG tasks"}],"specObservations":[{"kind":"overlap","otherSpec":"00004-rename-sdw-implement-to-sdw-orch","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00004-rename-sdw-implement-to-sdw-orch\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00005-sdw-orch-multi-spec-batch","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00005-sdw-orch-multi-spec-batch\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00009-sdw-security-checks","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00009-sdw-security-checks\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00010-sdw-orch-branch-worktree-strategy","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00010-sdw-orch-branch-worktree-strategy\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00012-scm-provider-selection","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00012-scm-provider-selection\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00013-sdw-orch-refinement-and-pre-pr-gates","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00013-sdw-orch-refinement-and-pre-pr-gates\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00014-sdw-orch-step-artifacts-persistence","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00014-sdw-orch-step-artifacts-persistence\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00014-sdw-orch-step-artifacts-persistence","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00014-sdw-orch-step-artifacts-persistence\" both name 'skills/sdw-orch/scripts/state_manager.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-orch/scripts/state_manager.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00017-sdw-ac-ledger-traceability","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00017-sdw-ac-ledger-traceability\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00017-sdw-ac-ledger-traceability","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00017-sdw-ac-ledger-traceability\" both name 'skills/sdw-orch/scripts/state_manager.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00018-sdw-fresh-verify-adversarial-audit","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00018-sdw-fresh-verify-adversarial-audit\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00019-sdw-orch-checkpoint-resume","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00019-sdw-orch-checkpoint-resume\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00019-sdw-orch-checkpoint-resume","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00019-sdw-orch-checkpoint-resume\" both name 'skills/sdw-orch/scripts/state_manager.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00021-sdw-monitor-telemetry","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00021-sdw-monitor-telemetry\" both name 'skills/sdw-orch/scripts/monitor.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00021-sdw-monitor-telemetry","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00021-sdw-monitor-telemetry\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00023-sdw-reporting-suite","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00023-sdw-reporting-suite\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00024-sdw-ship-pr","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00024-sdw-ship-pr\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00025-sdw-code-review-skill","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00025-sdw-code-review-skill\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-orch/scripts/state_manager.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00029-sdw-orch-sandboxed-execution\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00029-sdw-orch-sandboxed-execution\" both name 'skills/sdw-orch/scripts/state_manager.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00030-sdw-micro-task-dag-planning","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00030-sdw-micro-task-dag-planning\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00033-sdw-orch-diagnostic-mode","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00033-sdw-orch-diagnostic-mode\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00037-sdw-run-retrospective-candidates","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00037-sdw-run-retrospective-candidates\" both name 'skills/sdw-retro/scripts/retro.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00039-sdw-batch-skill","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00039-sdw-batch-skill\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00043-us-17-emphasize-step-number-progress-in","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00043-us-17-emphasize-step-number-progress-in\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00044-us-16-add-gitattributes-and-per-task-sa","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00044-us-16-add-gitattributes-and-per-task-sa\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00045-sdw-retro-auto-run","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00045-sdw-retro-auto-run\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00045-sdw-retro-auto-run","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00045-sdw-retro-auto-run\" both name 'skills/sdw-orch/scripts/state_manager.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00045-sdw-retro-auto-run","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00045-sdw-retro-auto-run\" both name 'skills/sdw-retro/scripts/retro.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00045-sdw-retro-auto-run","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00045-sdw-retro-auto-run\" both name 'tests/sdw_retro.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00047-sdw-retro-session-discovery","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00047-sdw-retro-session-discovery\" both name 'skills/sdw-retro/scripts/retro.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00047-sdw-retro-session-discovery","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00047-sdw-retro-session-discovery\" both name 'tests/sdw_retro.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00048-sdw-retro-signal-precision","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00048-sdw-retro-signal-precision\" both name 'skills/sdw-retro/scripts/retro.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00048-sdw-retro-signal-precision","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00048-sdw-retro-signal-precision\" both name 'tests/sdw_retro.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00053-batch-auto-merge-sdw-batch-merges-each-d","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00053-batch-auto-merge-sdw-batch-merges-each-d\" both name 'skills/sdw-batch/scripts/batch_queue.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00053-batch-auto-merge-sdw-batch-merges-each-d","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00053-batch-auto-merge-sdw-batch-merges-each-d\" both name 'tests/sdw_batch.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00054-sdw-orch-delivery-report-companion-file-","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00054-sdw-orch-delivery-report-companion-file-\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00057-sdw-orch-delivery-report-step-contributions","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00057-sdw-orch-delivery-report-step-contributions\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00057-sdw-orch-delivery-report-step-contributions","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00057-sdw-orch-delivery-report-step-contributions\" both name 'skills/sdw-retro/scripts/retro.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00057-sdw-orch-delivery-report-step-contributions","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00057-sdw-orch-delivery-report-step-contributions\" both name 'tests/sdw_retro.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00058-sdw-batch-delivery-integrity\" both name 'skills/sdw-batch/scripts/batch_queue.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00058-sdw-batch-delivery-integrity\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00058-sdw-batch-delivery-integrity\" both name 'tests/sdw_batch.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00060-sdw-delivery-report-artifact-location","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00060-sdw-delivery-report-artifact-location\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00064-dag-planning-must-prove-acceptance-crite","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00064-dag-planning-must-prove-acceptance-crite\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00067-task-acceptance-links-test-evidence","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00067-task-acceptance-links-test-evidence\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00068-review-findings-must-be-adjudicated","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00068-review-findings-must-be-adjudicated\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00068-review-findings-must-be-adjudicated","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00068-review-findings-must-be-adjudicated\" both name 'skills/sdw-retro/scripts/retro.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00068-review-findings-must-be-adjudicated","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00068-review-findings-must-be-adjudicated\" both name 'tests/sdw_retro.test.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00069-dag-planning-must-not-invent-target-files","evidence":"Specs \"00071-superseded-runs-must-be-terminal\" and \"00069-dag-planning-must-not-invent-target-files\" both name 'skills/sdw-orch/scripts/sdw_orch.cjs'.","severity":"high"}]}`
  - Evidence: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/00071-superseded-runs-must-be-terminal-step-2.md`

### Step 3: dag_generation

- **plan** 2026-10-24T12:39:22.360Z - DAG plan: 2 task(s)
  - Body: `{"taskIds":["task-1","task-2"],"dependencyOrder":[{"id":"task-1","dependencies":[]},{"id":"task-2","dependencies":["task-1"]}],"dispatchMode":"subagent","complexity":{"acCount":5,"touchpoints":["state"],"targetFileCount":8,"level":"standard","isComplex":false}}`
  - Evidence: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/00071-superseded-runs-must-be-terminal-step-3.md`

### Step 4: implementation

- **task** 2026-10-24T13:10:06.679Z - Task task-1 accepted
  - Body: `{"taskId":"task-1","outcome":"success","filesChanged":["skills/sdw-batch/scripts/batch_queue.cjs","skills/sdw-orch/scripts/state_manager.cjs","skills/sdw-orch/scripts/sdw_orch.cjs","skills/sdw-orch/scripts/monitor.cjs","skills/sdw-retro/scripts/retro.cjs","tests/sdw_batch.test.cjs","tests/sdw_retro.test.cjs","tests/sdw_run_supersession.test.cjs"],"retries":0,"abandonments":[],"commit":"5fc0f9c5c5d24d256b7521d766f6214ccf43ba7e","acIds":["AC1","AC2","AC3"]}`
  - Evidence: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/task-task-1.evidence.json`

### Step 5: scoring

- **verdict** 2026-10-24T13:10:41.589Z - Conformance score 10/8
  - Body: `{"score":10,"minScore":8,"passed":true,"verifiedCount":5,"failingCount":0,"verdicts":[{"id":"AC1","verdict":"verified","evidence":"skills/sdw-orch/scripts/state_manager.cjs:114"},{"id":"AC2","verdict":"verified","evidence":"skills/sdw-orch/scripts/monitor.cjs:48"},{"id":"AC3","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:83"},{"id":"AC4","verdict":"verified","evidence":"skills/sdw-retro/scripts/retro.cjs:216"},{"id":"AC5","verdict":"verified","evidence":"tests/sdw_run_supersession.test.cjs:300"}]}`
  - Evidence: `skills/sdw-orch/scripts/state_manager.cjs:114`, `skills/sdw-orch/scripts/monitor.cjs:48`, `skills/sdw-orch/scripts/sdw_orch.cjs:83`, `skills/sdw-retro/scripts/retro.cjs:216`, `tests/sdw_run_supersession.test.cjs:300`
- **judgment** 2026-10-24T13:10:41.589Z - Judge analysis
  - Body: `{"summary":"Supersession is now a recorded terminal state instead of a silent flag. 'state_manager.markRunSuperseded' writes 'status: superseded' with 'supersededBy' and 'supersededAt' under the run lock, and the batch's '--new-run' path generates the replacement run id first, marks the old state superseded with it, and records both 'supersededRunId' and the replacement on the item. The status is terminal everywhere it is classified: 'monitor' lists it in TERMINAL_STATUSES, the retro leftOver detection excludes it, 'findOpenRunsForSpec' and 'openRunsForSpec' treat it as closed, and 'resume' refuses it with exit 1 before doing any work, naming the replacing run and the 'resume --run-id <replacement>' remediation. The retrospective gains a 'superseded_runs' signal and a '### Superseded Runs' section naming each replaced run and its replacement, and both authoritative retro docs are synced so the signal table and the leftover rule describe what the code emits ('leftover_run' excludes completed, failed, and superseded). One existing 00058 assertion that a replaced state stays 'paused' was updated to the new contract rather than deleted, and the new coverage spans recording, monitor classification, resume refusal, retro exclusion, and sibling naming.","risks":[{"severity":"medium","evidence":"skills/sdw-batch/scripts/batch_queue.cjs:33","note":"The '--new-run' path now assigns 'item.runId' to the replacement before any delegation. A resume after an interrupted supersession could reconcile against a run that was never started; the superseded record makes the old run unambiguous, but the item's own status still needs care."},{"severity":"low","evidence":"skills/sdw-orch/scripts/state_manager.cjs:114","note":"'markRunSuperseded' requires a non-empty replacing run id and otherwise leaves the state untouched; the batch is the only caller and always supplies one, but a future caller must handle the refusal."},{"severity":"low","evidence":"tests/sdw_batch.test.cjs","note":"The 00058 stale-run assertion changed from 'paused' to 'superseded'. A reviewer should confirm the new expectation is the intended contract rather than the old behavior being silently dropped."}],"followUps":["Expose superseded runs in the batch summary with their replacement run id, so an operator reading the queue sees why an item starts a new run","Let 'monitor' group superseded runs behind a flag instead of only excluding them from the active list"]}`
  - Evidence: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/00071-superseded-runs-must-be-terminal-step-5.md`

### Step 6: delivery_commit

- **delivery** 2026-10-24T13:10:42.318Z - Delivery commit c0eb20cecccc580a5b17128cabea8bdc79ea4caa
  - Body: `{"deliveryCommit":"c0eb20cecccc580a5b17128cabea8bdc79ea4caa","deliveryCommitCreated":false,"stagedFiles":[".sdw/specs/00071-superseded-runs-must-be-terminal.md",".sdw/specs/index.specs.md","skills/sdw-batch/scripts/batch_queue.cjs","skills/sdw-orch/scripts/monitor.cjs","skills/sdw-orch/scripts/sdw_orch.cjs","skills/sdw-orch/scripts/state_manager.cjs","skills/sdw-retro/SKILL.md","skills/sdw-retro/references/retro_protocol.md","skills/sdw-retro/scripts/retro.cjs","tests/sdw_batch.test.cjs","tests/sdw_retro.test.cjs","tests/sdw_run_supersession.test.cjs"],"securityGate":{"bypassed":false,"status":"not run"}}`
  - Evidence: `.sdw/specs/00071-superseded-runs-must-be-terminal.md`, `.sdw/specs/index.specs.md`, `skills/sdw-batch/scripts/batch_queue.cjs`, `skills/sdw-orch/scripts/monitor.cjs`, `skills/sdw-orch/scripts/sdw_orch.cjs`, `skills/sdw-orch/scripts/state_manager.cjs`, `skills/sdw-retro/SKILL.md`, `skills/sdw-retro/references/retro_protocol.md`, `skills/sdw-retro/scripts/retro.cjs`, `tests/sdw_batch.test.cjs`, `tests/sdw_retro.test.cjs`, `tests/sdw_run_supersession.test.cjs`

### Step 7: code_review

- **review** 2026-10-24T13:10:43.788Z - Review iteration 1
  - Body: `{"iteration":1,"findings":{"error":0,"warning":0,"suggestion":0,"info":0},"fixes":[],"passed":true}`
  - Evidence: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/00071-superseded-runs-must-be-terminal-step-7.md`

### Step 8: pr_preparation

- **convergence** 2026-10-24T13:56:33.864Z - Convergence iteration 1
  - Body: `{"iteration":1,"rounds":2,"failingChecks":[],"openThreads":0,"resolvedThreads":0,"fixCommit":null,"converged":false}`
- **convergence** 2026-10-24T13:56:34.827Z - Convergence iteration 2
  - Body: `{"iteration":2,"rounds":2,"failingChecks":[],"openThreads":0,"resolvedThreads":0,"fixCommit":null,"converged":true}`
- **gates** 2026-10-24T13:56:35.617Z - Pre-PR gates: 6 result(s)
  - Body: `{"gates":[{"name":"prePrCommand","status":"skipped","detail":"prePrCommand is not configured"},{"name":"build","status":"skipped","detail":"requiredBuild is false"},{"name":"tests","status":"pass","detail":"npm test exited 0"},{"name":"security","status":"pass","detail":"sdw-security-checks found no blocking leak"},{"name":"runState","status":"pass","detail":"step 4, step 6 and step 7 completed; score 10 >= scoreMin 8"},{"name":"discovery","status":"pass","detail":"no prepare obligations discovered"}]}`
- **ship** 2026-10-24T13:56:35.617Z - Pull request #73
  - Body: `{"pushed":true,"branch":"feature/00071-superseded-runs-must-be-terminal","pullRequest":{"number":"73","url":"https://github.com/jpolvora/spec-driven-workflow/pull/73","title":null},"shipStatus":"delivered"}`
  - Evidence: `https://github.com/jpolvora/spec-driven-workflow/pull/73`

### Step 9: retrospective

- **retro** 2026-10-24T13:56:39.444Z - Retrospective passed: 0 candidate(s)
  - Body: `{"status":"passed","runStatus":"completed","signals":{"retries":{"scoreIterations":2,"reviewIterations":0,"reviewRounds":2,"dispatchAbandonments":0,"total":4},"leftoverRuns":0,"missingArtifacts":0,"reviewFindings":{"total":0,"open":0}},"candidates":[],"fixes":{"recorded":[],"consolidated":null,"queuedSpecifications":[],"failures":[]},"routedCandidates":[],"reportMd":".sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/run-1792845560345-00071-superseded-runs-must-be-.retro.md","reportJson":".sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/run-1792845560345-00071-superseded-runs-must-be-.retro.json"}`
  - Evidence: `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/run-1792845560345-00071-superseded-runs-must-be-.retro.md`, `.sdw/state/00071-superseded-runs-must-be-terminal/run-1792845560345-00071-superseded-runs-must-be-/run-1792845560345-00071-superseded-runs-must-be-.retro.json`
