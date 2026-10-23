# Delivery Report — SDW Per-Role Agent Model Configuration

## Metadata

| Field | Value |
|---|---|
| Specification file | `.sdw/specs/00056-sdw-per-role-agent-models.md` |
| Specification slug | 00056-sdw-per-role-agent-models |
| Run ID | run-1792750694534-00056-sdw-per-role-agent-model |
| Run status | completed |
| Branch | `feature/00056-sdw-per-role-agent-models` |
| Base branch | `master` |
| Base commit | `d04c2636b0e9d76cd983ac2f3bb428b7e6f085e3` |
| Delivery commit | `fb8fc9b36109b2fa2a2217588afdde9a47a951a3` |
| Ship status | pending |
| Score | 9/10 (scoreMin 8) |
| Implementation start | 2026-10-23T10:18:16.125Z |
| Implementation end | 2026-10-23T11:41:33.330Z |
| Total wall-clock duration | 1h 23m 17s |
| Generated at | 2026-10-23T11:59:19.579Z |
| Step 1: derivation (skipped) | 1ms |
| Step 2: refinement (completed) | 36ms |
| Step 3: dag_generation (completed) | 37ms |
| Step 4: implementation (completed) | 1h 25m 30s |
| Step 5: scoring (completed) | 11m 39s |
| Step 6: delivery_commit (completed) | 361ms |
| Step 7: code_review (completed) | 974ms |
| Step 8: pr_preparation (completed) | 3m 37s |


## Tasks

| ID | Title | Status | Covered ACs | Checkpoint commit | Started | Completed | Duration |
|---|---|---|---|---|---|---|---|
| task-1 | 00056-sdw-per-role-agent-models — Slice 1 of 5 | completed | AC1, AC2, AC3 | `2e4c3e6e382bbdf2e86445a6753081fa53fe8e15` | 2026-10-23T10:18:16.125Z | 2026-10-23T10:35:28.111Z | 17m 11s |
| task-2 | 00056-sdw-per-role-agent-models — Slice 2 of 5 | completed | AC4, AC5, AC6 | `134b2777ae6d13846a0f546e8fbd5b5b4d9aaba2` | 2026-10-23T10:35:28.185Z | 2026-10-23T10:54:21.200Z | 18m 53s |
| task-3 | 00056-sdw-per-role-agent-models — Slice 3 of 5 | completed | AC7, AC8, AC9 | `f9b99f29d3bf9f8e0f433339223f0e307f6ac94e` | 2026-10-23T10:54:21.275Z | 2026-10-23T11:05:01.697Z | 10m 40s |
| task-4 | 00056-sdw-per-role-agent-models — Slice 4 of 5 | completed | AC10, AC11, AC12 | `6804b6b2f81cca69b82bd25355d2516c5a3602db` | 2026-10-23T11:05:01.790Z | 2026-10-23T11:34:20.641Z | 29m 18s |
| task-5 | 00056-sdw-per-role-agent-models — Slice 5 of 5 | completed | AC13, AC14, AC15 | `fb8fc9b36109b2fa2a2217588afdde9a47a951a3` | 2026-10-23T11:34:20.712Z | 2026-10-23T11:41:33.330Z | 7m 12s |

## Commits

| SHA | Subject | Range |
|---|---|---|
| `b446ad2` | chore(00056-sdw-per-role-agent-models): mark the specification completed in the registry | base..HEAD |
| `d04a3e7` | docs(00056-sdw-per-role-agent-models): record delivery report | base..HEAD |
| `fb8fc9b` | task(00056-sdw-per-role-agent-models): task-5 | base..HEAD |
| `6804b6b` | task(00056-sdw-per-role-agent-models): task-4 | base..HEAD |
| `f9b99f2` | task(00056-sdw-per-role-agent-models): task-3 | base..HEAD |
| `134b277` | task(00056-sdw-per-role-agent-models): task-2 | base..HEAD |
| `2e4c3e6` | task(00056-sdw-per-role-agent-models): task-1 | base..HEAD |

## Files Changed

### task-1: 00056-sdw-per-role-agent-models — Slice 1 of 5

| File | Change |
|---|---|
| `.sdw/config.json` | modified |
| `skills/sdw-config/references/config.schema.json` | modified |
| `skills/sdw-orch/scripts/sdw_orch.cjs` | modified |

### task-2: 00056-sdw-per-role-agent-models — Slice 2 of 5

| File | Change |
|---|---|
| `.sdw/config.schema.json` | modified |
| `skills/sdw-config/references/config_spec.md` | modified |
| `skills/sdw-config/scripts/sdw_config.cjs` | modified |
| `skills/sdw-orch/scripts/sdw_orch.cjs` | modified |
| `tests/sdw_orch.test.cjs` | modified |

### task-3: 00056-sdw-per-role-agent-models — Slice 3 of 5

| File | Change |
|---|---|
| `skills/sdw-orch/SKILL.md` | modified |
| `skills/sdw-orch/references/orchestrator_protocol.md` | modified |
| `skills/sdw-batch/references/batch_protocol.md` | modified |
| `skills/sdw-orch/scripts/sdw_orch.cjs` | modified |
| `tests/sdw_orch.test.cjs` | modified |

### task-4: 00056-sdw-per-role-agent-models — Slice 4 of 5

| File | Change |
|---|---|
| `skills/sdw-code-review/SKILL.md` | modified |
| `skills/sdw-config/scripts/sdw_config.cjs` | modified |
| `skills/sdw-fixer/SKILL.md` | modified |
| `skills/sdw-orch/references/orchestrator_protocol.md` | modified |
| `skills/sdw-orch/scripts/model_capabilities.cjs` | added |
| `skills/sdw-orch/scripts/sdw_orch.cjs` | modified |
| `tests/sdw_config.test.cjs` | modified |
| `tests/sdw_orch.test.cjs` | modified |

### task-5: 00056-sdw-per-role-agent-models — Slice 5 of 5

| File | Change |
|---|---|
| `skills/sdw-orch/SKILL.md` | modified |
| `skills/sdw-orch/references/orchestrator_protocol.md` | modified |
| `skills/sdw-orch/scripts/sdw_orch.cjs` | modified |
| `tests/sdw_orch.test.cjs` | modified |

### Unattributed changes

| File | Change |
|---|---|
| `.sdw/reports/00056-sdw-per-role-agent-models-report.md` | added |
| `.sdw/specs/00056-sdw-per-role-agent-models.md` | modified |
| `.sdw/specs/index.specs.md` | modified |

## Verification

- test gate: status `passed`, exit code `0`, duration 2m 12s
- Step 8 delivery: `completed`

## Code Review

- Status: `completed`
- Result: passed
- Findings: 0 error, 0 warning, 2 suggestion
- Blocking findings: 0
- Report: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/00056-sdw-per-role-agent-models-step-7.md`

## Conformance Judgment

- Score: 9/10 (required minimum 8/10)
- Criteria: 14 verified, 1 failed (15 judged)
- Result: passed
- Source: Step 5 verdict contribution

| Criterion | Verdict | Evidence |
|---|---|---|
| AC1 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:863 |
| AC2 | failed | skills/sdw-orch/scripts/sdw_orch.cjs:2356 — the orchestrator hint is only logged and copied into Steps 1-3 output metadata; deriveAgentSpec, analyzeSpecificationGaps, and generateDagPlan never receive it, and no committed test asserts orchestratorHint anywhere in tests/ |
| AC3 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:4269 |
| AC4 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:1091 |
| AC5 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:1106 |
| AC6 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:889 |
| AC7 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:870 |
| AC8 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:906 |
| AC9 | verified | skills/sdw-config/scripts/sdw_config.cjs:323 |
| AC10 | verified | skills/sdw-orch/scripts/model_capabilities.cjs:275 |
| AC11 | verified | skills/sdw-orch/scripts/model_capabilities.cjs:145 |
| AC12 | verified | skills/sdw-config/scripts/sdw_config.cjs:827 |
| AC13 | verified | skills/sdw-orch/scripts/sdw_orch.cjs:1064 |
| AC14 | verified | tests/sdw_orch.test.cjs:2925 |
| AC15 | verified | tests/sdw_orch.test.cjs:2959 |

## Judge Analysis

- Source: Step 5 judge (advisory; it never changes the score, a gate, the review, or a halt decision)
- Summary: The delivery adds the full advisory models contract (default plus seven roles plus a disabled-by-default detection block) to the tracked config and both schemas, and implements static resolution, judge precedence over scoring.judge*, ship-to-fixer and retro-to-default fallback, capability bind-once with per-session cache and fail-open, unavailable-hint adaptation with requested/resolved/reason, shape rejection before any probe, and the dry-run detection/hint block. Fourteen of fifteen criteria hold. AC2 is failed: the orchestrator hint is resolved and echoed into Step 1-3 output metadata, but derivation, refinement, and DAG generation never consume it, and the committed suite contains no orchestratorHint assertion at all, so the criterion's application is unproven and would not regress if removed. The diff shown in the judge prompt is truncated at 120,000 bytes (of 142,086); every criterion was checked against the real checkout, including the unshown test hunks. The focused 00056 tests (16/16) and the full suite (586/586) pass on this tree.

| Severity | Evidence | Risk |
|---|---|---|
| high | skills/sdw-orch/scripts/sdw_orch.cjs:2356 | AC2 is metadata-only: the hint is printed and attached to Steps 1-3 outputs, but no planning function takes it, and no test references orchestratorHint. A reviewer must decide whether host-side routing from that metadata is enough; if it is, the missing committed test still leaves the behaviour uncorroborated. |
| medium | skills/sdw-orch/SKILL.md:92 | SKILL.md Step 7 still states that the reviewer and fixer briefs carry only target root, base reference, report path, and scope fence (fixer: findings, target, report), which contradicts the added Model hint line; and cmdRun prints the brief and then runs the review/fix inline, so no subagent consumes it in this path. |
| medium | skills/sdw-orch/scripts/sdw_orch.cjs:3982 | The ship hint is only logged and put in the Step 8 payload, and the retro hint is only logged plus snapshotted; neither the sdw-ship-pr argv (line 3775) nor runRetroForCompletedRun (line 369) receives a hint, so routing is entirely host-side. |
| medium | skills/sdw-orch/references/orchestrator_protocol.md:90 | The protocol promises state.models always records static, capabilities, supportedModels, resolved, and adaptations, but the disabled-detection branch writes only detection plus flat *Hint fields (skills/sdw-orch/scripts/sdw_orch.cjs:2324); consumers reading the documented snapshot shape get undefined on the default, zero-config path. |
| low | skills/sdw-orch/scripts/sdw_orch.cjs:1045 | The dry-run probe branch is untested and dry-run can only print skipped, hit, or probe, never the failed-open state named in the spec validation notes; also sdw-config parse iterates raw keys, so an absent models block yields no models in the parsed view. |

Follow-ups:
- Either pass the orchestrator hint to the planning entry points or add a committed test asserting orchestratorHint on Steps 1-3 outputs and the DAG plan, so AC2 has observable evidence.
- Resolve how host-side roles actually receive reviewer, fixer, ship, and retro hints (state field, env, or CLI), and align the Step 7 'carries only' wording in skills/sdw-orch/SKILL.md with the Model hint line.
- Write the full state.models snapshot (static, resolved, adaptations) in the disabled-detection path, or narrow the protocol's snapshot contract.
- Add dry-run coverage for the enabled cache-miss/probe preview and decide whether failed-open can be represented without probing.

## Learnings

Not available

## Retrospective

- Status: `passed`
- Report: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/run-1792750694534-00056-sdw-per-role-agent-model.retro.md`
- Data: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/run-1792750694534-00056-sdw-per-role-agent-model.retro.json`
- Signals: retries 4 (score 2, review 0, rounds 2, abandonments 0); leftover runs 0; missing artifacts 0; review findings 2 (2 open)
- Candidates: 0
- Applied fixes:
  - none

## Breaking Changes

- **Configuration key** `models.default` added with value null in `.sdw/config.json`
- **Configuration key** `models.detection.command` added with value null in `.sdw/config.json`
- **Configuration key** `models.detection.enabled` added with value false in `.sdw/config.json`
- **Configuration key** `models.detection.timeoutMs` added with value 30000 in `.sdw/config.json`
- **Configuration key** `models.fixer` added with value null in `.sdw/config.json`
- **Configuration key** `models.judge` added with value null in `.sdw/config.json`
- **Configuration key** `models.orchestrator` added with value null in `.sdw/config.json`
- **Configuration key** `models.retro` added with value null in `.sdw/config.json`
- **Configuration key** `models.reviewer` added with value null in `.sdw/config.json`
- **Configuration key** `models.ship` added with value null in `.sdw/config.json`
- **Configuration key** `models.worker` added with value null in `.sdw/config.json`
- **Configuration schema** `definitions.modelHint.additionalProperties` added with value false in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.description` added with value "Advisory model hint passed through verbatim to the host harness." in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.apiEndpoint.default` added with value null in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.apiEndpoint.description` added with value "Optional API endpoint identifier." in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.apiEndpoint.type` added with value ["string","null"] in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.effort.default` added with value null in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.effort.description` added with value "Reasoning-effort token passed through verbatim (for example high, medium, low)." in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.effort.type` added with value ["string","null"] in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.model.default` added with value null in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.model.description` added with value "Opaque model identifier." in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.model.type` added with value ["string","null"] in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.provider.default` added with value null in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.provider.description` added with value "Opaque provider identifier." in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.properties.provider.type` added with value ["string","null"] in `.sdw/config.schema.json`
- **Configuration schema** `definitions.modelHint.type` added with value "object" in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.additionalProperties` added with value false in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.description` added with value "Advisory per-role model hints interpreted by the host harness. Hints carry opaque identifiers only; helpers never invoke a model, call a provider API, or store credentials." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.default.anyOf` added with value [{"$ref":"#/definitions/modelHint"},{"type":"null"}] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.default.description` added with value "Fallback hint applied when the role-specific entry is null or absent." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.additionalProperties` added with value false in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.description` added with value "Opt-in start-of-run host capability detection. Disabled by default so runs resolve hints statically." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.command.default` added with value null in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.command.description` added with value "Optional command that writes the capabilities JSON file. Supports {capabilitiesFile}, {targetRoot}, {slug}, {runId}. When null, the host consults its harness." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.command.type` added with value ["string","null"] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.enabled.default` added with value false in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.enabled.description` added with value "Bind capabilities once at run start before task dispatch." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.enabled.type` added with value "boolean" in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.timeoutMs.default` added with value 30000 in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.timeoutMs.description` added with value "Maximum detection command runtime in milliseconds." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.timeoutMs.minimum` added with value 1 in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.properties.timeoutMs.type` added with value "integer" in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.detection.type` added with value "object" in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.fixer.anyOf` added with value [{"$ref":"#/definitions/modelHint"},{"type":"null"}] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.fixer.description` added with value "Hint for fixer remediation in Step 7 fix iteration and Step 8 convergence fixes." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.judge.anyOf` added with value [{"$ref":"#/definitions/modelHint"},{"type":"null"}] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.judge.description` added with value "Hint for Step 5 conformance scoring; resolved before the legacy scoring.judge* keys." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.orchestrator.anyOf` added with value [{"$ref":"#/definitions/modelHint"},{"type":"null"}] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.orchestrator.description` added with value "Hint for Steps 1-3 derivation, refinement grilling, DAG generation, and run supervision." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.retro.anyOf` added with value [{"$ref":"#/definitions/modelHint"},{"type":"null"}] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.retro.description` added with value "Hint for retro analysis; falls back to the default hint." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.reviewer.anyOf` added with value [{"$ref":"#/definitions/modelHint"},{"type":"null"}] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.reviewer.description` added with value "Hint for the Step 7 fresh reviewer subagent." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.ship.anyOf` added with value [{"$ref":"#/definitions/modelHint"},{"type":"null"}] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.ship.description` added with value "Hint for Step 8 PR metadata and review convergence dialogue; falls back to the fixer hint." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.worker.anyOf` added with value [{"$ref":"#/definitions/modelHint"},{"type":"null"}] in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.properties.worker.description` added with value "Hint for Step 4 task implementation subagents." in `.sdw/config.schema.json`
- **Configuration schema** `properties.models.type` added with value "object" in `.sdw/config.schema.json`
- **CLI flag** `--no-model-detect` added in `skills/sdw-orch/scripts/sdw_orch.cjs`
- **CLI flag** `--refresh-models` added in `skills/sdw-orch/scripts/sdw_orch.cjs`

## Quality

- Conformance score: 9/10 (scoreMin 8)
- Judge verdicts: 14 verified, 1 failed (15 judged)
- Review findings: 0 error, 0 warning, 2 suggestion
- Blocking findings: 0
- Executed tests: 30 recorded across 5 accepted task(s) (30 passed, 0 failed, 0 skipped)
- Verification gates: test passed

## Spec Observations

| Kind | Other specification | Evidence | Severity |
|---|---|---|---|
| overlap | 00001-sdw-implement-initial-version | Specs "00056-sdw-per-role-agent-models" and "00001-sdw-implement-initial-version" both name `.sdw/config.json`. | high |
| overlap | 00001-sdw-implement-initial-version | Specs "00056-sdw-per-role-agent-models" and "00001-sdw-implement-initial-version" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00002-sdw-spec-management | Specs "00056-sdw-per-role-agent-models" and "00002-sdw-spec-management" both name `.sdw/config.json`. | high |
| overlap | 00002-sdw-spec-management | Specs "00056-sdw-per-role-agent-models" and "00002-sdw-spec-management" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00002-sdw-spec-management | Specs "00056-sdw-per-role-agent-models" and "00002-sdw-spec-management" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00003-sdw-router-skill | Specs "00056-sdw-per-role-agent-models" and "00003-sdw-router-skill" both name `.sdw/config.json`. | high |
| overlap | 00003-sdw-router-skill | Specs "00056-sdw-per-role-agent-models" and "00003-sdw-router-skill" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00004-rename-sdw-implement-to-sdw-orch | Specs "00056-sdw-per-role-agent-models" and "00004-rename-sdw-implement-to-sdw-orch" both name `.sdw/config.json`. | high |
| overlap | 00004-rename-sdw-implement-to-sdw-orch | Specs "00056-sdw-per-role-agent-models" and "00004-rename-sdw-implement-to-sdw-orch" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00005-sdw-orch-multi-spec-batch | Specs "00056-sdw-per-role-agent-models" and "00005-sdw-orch-multi-spec-batch" both name `.sdw/config.json`. | high |
| overlap | 00005-sdw-orch-multi-spec-batch | Specs "00056-sdw-per-role-agent-models" and "00005-sdw-orch-multi-spec-batch" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00006-packaging-installer-updater | Specs "00056-sdw-per-role-agent-models" and "00006-packaging-installer-updater" both name `.sdw/config.json`. | high |
| overlap | 00006-packaging-installer-updater | Specs "00056-sdw-per-role-agent-models" and "00006-packaging-installer-updater" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00008-sdw-rules-skill | Specs "00056-sdw-per-role-agent-models" and "00008-sdw-rules-skill" both name `.sdw/config.json`. | high |
| overlap | 00008-sdw-rules-skill | Specs "00056-sdw-per-role-agent-models" and "00008-sdw-rules-skill" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00008-sdw-rules-skill | Specs "00056-sdw-per-role-agent-models" and "00008-sdw-rules-skill" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00009-sdw-security-checks | Specs "00056-sdw-per-role-agent-models" and "00009-sdw-security-checks" both name `.sdw/config.json`. | high |
| overlap | 00009-sdw-security-checks | Specs "00056-sdw-per-role-agent-models" and "00009-sdw-security-checks" both name `.sdw/config.schema.json`. | high |
| overlap | 00009-sdw-security-checks | Specs "00056-sdw-per-role-agent-models" and "00009-sdw-security-checks" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00009-sdw-security-checks | Specs "00056-sdw-per-role-agent-models" and "00009-sdw-security-checks" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00009-sdw-security-checks | Specs "00056-sdw-per-role-agent-models" and "00009-sdw-security-checks" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00010-sdw-orch-branch-worktree-strategy | Specs "00056-sdw-per-role-agent-models" and "00010-sdw-orch-branch-worktree-strategy" both name `.sdw/config.json`. | high |
| overlap | 00010-sdw-orch-branch-worktree-strategy | Specs "00056-sdw-per-role-agent-models" and "00010-sdw-orch-branch-worktree-strategy" both name `.sdw/config.schema.json`. | high |
| overlap | 00010-sdw-orch-branch-worktree-strategy | Specs "00056-sdw-per-role-agent-models" and "00010-sdw-orch-branch-worktree-strategy" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00010-sdw-orch-branch-worktree-strategy | Specs "00056-sdw-per-role-agent-models" and "00010-sdw-orch-branch-worktree-strategy" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00010-sdw-orch-branch-worktree-strategy | Specs "00056-sdw-per-role-agent-models" and "00010-sdw-orch-branch-worktree-strategy" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00011-github-actions-integration | Specs "00056-sdw-per-role-agent-models" and "00011-github-actions-integration" both name `.sdw/config.json`. | high |
| overlap | 00011-github-actions-integration | Specs "00056-sdw-per-role-agent-models" and "00011-github-actions-integration" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00011-github-actions-integration | Specs "00056-sdw-per-role-agent-models" and "00011-github-actions-integration" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00012-scm-provider-selection | Specs "00056-sdw-per-role-agent-models" and "00012-scm-provider-selection" both name `.sdw/config.json`. | high |
| overlap | 00012-scm-provider-selection | Specs "00056-sdw-per-role-agent-models" and "00012-scm-provider-selection" both name `.sdw/config.schema.json`. | high |
| overlap | 00012-scm-provider-selection | Specs "00056-sdw-per-role-agent-models" and "00012-scm-provider-selection" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00012-scm-provider-selection | Specs "00056-sdw-per-role-agent-models" and "00012-scm-provider-selection" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00013-sdw-orch-refinement-and-pre-pr-gates | Specs "00056-sdw-per-role-agent-models" and "00013-sdw-orch-refinement-and-pre-pr-gates" both name `.sdw/config.json`. | high |
| overlap | 00013-sdw-orch-refinement-and-pre-pr-gates | Specs "00056-sdw-per-role-agent-models" and "00013-sdw-orch-refinement-and-pre-pr-gates" both name `.sdw/config.schema.json`. | high |
| overlap | 00013-sdw-orch-refinement-and-pre-pr-gates | Specs "00056-sdw-per-role-agent-models" and "00013-sdw-orch-refinement-and-pre-pr-gates" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00013-sdw-orch-refinement-and-pre-pr-gates | Specs "00056-sdw-per-role-agent-models" and "00013-sdw-orch-refinement-and-pre-pr-gates" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00013-sdw-orch-refinement-and-pre-pr-gates | Specs "00056-sdw-per-role-agent-models" and "00013-sdw-orch-refinement-and-pre-pr-gates" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00014-sdw-orch-step-artifacts-persistence | Specs "00056-sdw-per-role-agent-models" and "00014-sdw-orch-step-artifacts-persistence" both name `.sdw/config.json`. | high |
| overlap | 00014-sdw-orch-step-artifacts-persistence | Specs "00056-sdw-per-role-agent-models" and "00014-sdw-orch-step-artifacts-persistence" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00014-sdw-orch-step-artifacts-persistence | Specs "00056-sdw-per-role-agent-models" and "00014-sdw-orch-step-artifacts-persistence" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00014-sdw-orch-step-artifacts-persistence | Specs "00056-sdw-per-role-agent-models" and "00014-sdw-orch-step-artifacts-persistence" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00014-sdw-orch-step-artifacts-persistence | Specs "00056-sdw-per-role-agent-models" and "00014-sdw-orch-step-artifacts-persistence" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00056-sdw-per-role-agent-models" and "00015-sdw-orch-implementation-execution" both name `.sdw/config.json`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00056-sdw-per-role-agent-models" and "00015-sdw-orch-implementation-execution" both name `.sdw/config.schema.json`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00056-sdw-per-role-agent-models" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00056-sdw-per-role-agent-models" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-config/references/config.schema.json`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00056-sdw-per-role-agent-models" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00056-sdw-per-role-agent-models" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00056-sdw-per-role-agent-models" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00015-sdw-orch-implementation-execution | Specs "00056-sdw-per-role-agent-models" and "00015-sdw-orch-implementation-execution" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00024-sdw-ship-pr | Specs "00056-sdw-per-role-agent-models" and "00024-sdw-ship-pr" both name `.sdw/config.json`. | high |
| overlap | 00024-sdw-ship-pr | Specs "00056-sdw-per-role-agent-models" and "00024-sdw-ship-pr" both name `.sdw/config.schema.json`. | high |
| overlap | 00024-sdw-ship-pr | Specs "00056-sdw-per-role-agent-models" and "00024-sdw-ship-pr" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00024-sdw-ship-pr | Specs "00056-sdw-per-role-agent-models" and "00024-sdw-ship-pr" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00025-sdw-code-review-skill | Specs "00056-sdw-per-role-agent-models" and "00025-sdw-code-review-skill" both name `.sdw/config.json`. | high |
| overlap | 00025-sdw-code-review-skill | Specs "00056-sdw-per-role-agent-models" and "00025-sdw-code-review-skill" both name `skills/sdw-code-review/SKILL.md`. | high |
| overlap | 00025-sdw-code-review-skill | Specs "00056-sdw-per-role-agent-models" and "00025-sdw-code-review-skill" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00025-sdw-code-review-skill | Specs "00056-sdw-per-role-agent-models" and "00025-sdw-code-review-skill" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00025-sdw-code-review-skill | Specs "00056-sdw-per-role-agent-models" and "00025-sdw-code-review-skill" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00026-ensure-hybrid-mode-compatiblity | Specs "00056-sdw-per-role-agent-models" and "00026-ensure-hybrid-mode-compatiblity" both name `.sdw/config.json`. | high |
| overlap | 00026-ensure-hybrid-mode-compatiblity | Specs "00056-sdw-per-role-agent-models" and "00026-ensure-hybrid-mode-compatiblity" both name `.sdw/config.schema.json`. | high |
| overlap | 00026-ensure-hybrid-mode-compatiblity | Specs "00056-sdw-per-role-agent-models" and "00026-ensure-hybrid-mode-compatiblity" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00056-sdw-per-role-agent-models" and "00028-sdw-orch-sequential-subagent-implementation" both name `.sdw/config.json`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00056-sdw-per-role-agent-models" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00056-sdw-per-role-agent-models" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-config/references/config.schema.json`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00056-sdw-per-role-agent-models" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00056-sdw-per-role-agent-models" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00056-sdw-per-role-agent-models" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00028-sdw-orch-sequential-subagent-implementation | Specs "00056-sdw-per-role-agent-models" and "00028-sdw-orch-sequential-subagent-implementation" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00056-sdw-per-role-agent-models" and "00029-sdw-orch-sandboxed-execution" both name `.sdw/config.json`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00056-sdw-per-role-agent-models" and "00029-sdw-orch-sandboxed-execution" both name `.sdw/config.schema.json`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00056-sdw-per-role-agent-models" and "00029-sdw-orch-sandboxed-execution" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00056-sdw-per-role-agent-models" and "00029-sdw-orch-sandboxed-execution" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00056-sdw-per-role-agent-models" and "00029-sdw-orch-sandboxed-execution" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00056-sdw-per-role-agent-models" and "00029-sdw-orch-sandboxed-execution" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00029-sdw-orch-sandboxed-execution | Specs "00056-sdw-per-role-agent-models" and "00029-sdw-orch-sandboxed-execution" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00030-sdw-micro-task-dag-planning | Specs "00056-sdw-per-role-agent-models" and "00030-sdw-micro-task-dag-planning" both name `.sdw/config.json`. | high |
| overlap | 00030-sdw-micro-task-dag-planning | Specs "00056-sdw-per-role-agent-models" and "00030-sdw-micro-task-dag-planning" both name `.sdw/config.schema.json`. | high |
| overlap | 00030-sdw-micro-task-dag-planning | Specs "00056-sdw-per-role-agent-models" and "00030-sdw-micro-task-dag-planning" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00030-sdw-micro-task-dag-planning | Specs "00056-sdw-per-role-agent-models" and "00030-sdw-micro-task-dag-planning" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00030-sdw-micro-task-dag-planning | Specs "00056-sdw-per-role-agent-models" and "00030-sdw-micro-task-dag-planning" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00030-sdw-micro-task-dag-planning | Specs "00056-sdw-per-role-agent-models" and "00030-sdw-micro-task-dag-planning" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00032-sdw-fixer-skill | Specs "00056-sdw-per-role-agent-models" and "00032-sdw-fixer-skill" both name `.sdw/config.json`. | high |
| overlap | 00032-sdw-fixer-skill | Specs "00056-sdw-per-role-agent-models" and "00032-sdw-fixer-skill" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00032-sdw-fixer-skill | Specs "00056-sdw-per-role-agent-models" and "00032-sdw-fixer-skill" both name `skills/sdw-fixer/SKILL.md`. | high |
| overlap | 00032-sdw-fixer-skill | Specs "00056-sdw-per-role-agent-models" and "00032-sdw-fixer-skill" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00032-sdw-fixer-skill | Specs "00056-sdw-per-role-agent-models" and "00032-sdw-fixer-skill" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00034-sdw-memory-skill | Specs "00056-sdw-per-role-agent-models" and "00034-sdw-memory-skill" both name `.sdw/config.json`. | high |
| overlap | 00034-sdw-memory-skill | Specs "00056-sdw-per-role-agent-models" and "00034-sdw-memory-skill" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00034-sdw-memory-skill | Specs "00056-sdw-per-role-agent-models" and "00034-sdw-memory-skill" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00036-sdw-changelog-delivery-records | Specs "00056-sdw-per-role-agent-models" and "00036-sdw-changelog-delivery-records" both name `.sdw/config.json`. | high |
| overlap | 00036-sdw-changelog-delivery-records | Specs "00056-sdw-per-role-agent-models" and "00036-sdw-changelog-delivery-records" both name `.sdw/config.schema.json`. | high |
| overlap | 00036-sdw-changelog-delivery-records | Specs "00056-sdw-per-role-agent-models" and "00036-sdw-changelog-delivery-records" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00036-sdw-changelog-delivery-records | Specs "00056-sdw-per-role-agent-models" and "00036-sdw-changelog-delivery-records" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00036-sdw-changelog-delivery-records | Specs "00056-sdw-per-role-agent-models" and "00036-sdw-changelog-delivery-records" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00037-sdw-run-retrospective-candidates | Specs "00056-sdw-per-role-agent-models" and "00037-sdw-run-retrospective-candidates" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00038-sdw-spec-drift-repair | Specs "00056-sdw-per-role-agent-models" and "00038-sdw-spec-drift-repair" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00039-sdw-batch-skill | Specs "00056-sdw-per-role-agent-models" and "00039-sdw-batch-skill" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00040-sdw-branching-strategy | Specs "00056-sdw-per-role-agent-models" and "00040-sdw-branching-strategy" both name `.sdw/config.json`. | high |
| overlap | 00040-sdw-branching-strategy | Specs "00056-sdw-per-role-agent-models" and "00040-sdw-branching-strategy" both name `.sdw/config.schema.json`. | high |
| overlap | 00040-sdw-branching-strategy | Specs "00056-sdw-per-role-agent-models" and "00040-sdw-branching-strategy" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00040-sdw-branching-strategy | Specs "00056-sdw-per-role-agent-models" and "00040-sdw-branching-strategy" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00040-sdw-branching-strategy | Specs "00056-sdw-per-role-agent-models" and "00040-sdw-branching-strategy" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00042-us-18-reduce-repeated-full-test-suite-r | Specs "00056-sdw-per-role-agent-models" and "00042-us-18-reduce-repeated-full-test-suite-r" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00043-us-17-emphasize-step-number-progress-in | Specs "00056-sdw-per-role-agent-models" and "00043-us-17-emphasize-step-number-progress-in" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00044-us-16-add-gitattributes-and-per-task-sa | Specs "00056-sdw-per-role-agent-models" and "00044-us-16-add-gitattributes-and-per-task-sa" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00044-us-16-add-gitattributes-and-per-task-sa | Specs "00056-sdw-per-role-agent-models" and "00044-us-16-add-gitattributes-and-per-task-sa" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00045-sdw-retro-auto-run | Specs "00056-sdw-per-role-agent-models" and "00045-sdw-retro-auto-run" both name `.sdw/config.json`. | high |
| overlap | 00045-sdw-retro-auto-run | Specs "00056-sdw-per-role-agent-models" and "00045-sdw-retro-auto-run" both name `.sdw/config.schema.json`. | high |
| overlap | 00045-sdw-retro-auto-run | Specs "00056-sdw-per-role-agent-models" and "00045-sdw-retro-auto-run" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00046-sdw-batch-retro-followup | Specs "00056-sdw-per-role-agent-models" and "00046-sdw-batch-retro-followup" both name `.sdw/config.json`. | high |
| overlap | 00046-sdw-batch-retro-followup | Specs "00056-sdw-per-role-agent-models" and "00046-sdw-batch-retro-followup" both name `.sdw/config.schema.json`. | high |
| overlap | 00046-sdw-batch-retro-followup | Specs "00056-sdw-per-role-agent-models" and "00046-sdw-batch-retro-followup" both name `skills/sdw-batch/references/batch_protocol.md`. | high |
| overlap | 00046-sdw-batch-retro-followup | Specs "00056-sdw-per-role-agent-models" and "00046-sdw-batch-retro-followup" both name `skills/sdw-config/references/config_spec.md`. | high |
| overlap | 00050-sdw-ship-pr-native-pre-pr-enforcement-ga | Specs "00056-sdw-per-role-agent-models" and "00050-sdw-ship-pr-native-pre-pr-enforcement-ga" both name `.sdw/config.json`. | high |
| overlap | 00050-sdw-ship-pr-native-pre-pr-enforcement-ga | Specs "00056-sdw-per-role-agent-models" and "00050-sdw-ship-pr-native-pre-pr-enforcement-ga" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00051-issue-linkage-imported-scm-issues-close- | Specs "00056-sdw-per-role-agent-models" and "00051-issue-linkage-imported-scm-issues-close-" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00052-sdw-fresh-subagent-code-review | Specs "00056-sdw-per-role-agent-models" and "00052-sdw-fresh-subagent-code-review" both name `skills/sdw-code-review/SKILL.md`. | high |
| overlap | 00052-sdw-fresh-subagent-code-review | Specs "00056-sdw-per-role-agent-models" and "00052-sdw-fresh-subagent-code-review" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00052-sdw-fresh-subagent-code-review | Specs "00056-sdw-per-role-agent-models" and "00052-sdw-fresh-subagent-code-review" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00053-batch-auto-merge-sdw-batch-merges-each-d | Specs "00056-sdw-per-role-agent-models" and "00053-batch-auto-merge-sdw-batch-merges-each-d" both name `.sdw/config.json`. | high |
| overlap | 00053-batch-auto-merge-sdw-batch-merges-each-d | Specs "00056-sdw-per-role-agent-models" and "00053-batch-auto-merge-sdw-batch-merges-each-d" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00054-sdw-orch-delivery-report-companion-file- | Specs "00056-sdw-per-role-agent-models" and "00054-sdw-orch-delivery-report-companion-file-" both name `.sdw/config.json`. | high |
| overlap | 00054-sdw-orch-delivery-report-companion-file- | Specs "00056-sdw-per-role-agent-models" and "00054-sdw-orch-delivery-report-companion-file-" both name `.sdw/config.schema.json`. | high |
| overlap | 00054-sdw-orch-delivery-report-companion-file- | Specs "00056-sdw-per-role-agent-models" and "00054-sdw-orch-delivery-report-companion-file-" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00054-sdw-orch-delivery-report-companion-file- | Specs "00056-sdw-per-role-agent-models" and "00054-sdw-orch-delivery-report-companion-file-" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00055-sdw-spec-list-by-priority | Specs "00056-sdw-per-role-agent-models" and "00055-sdw-spec-list-by-priority" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00055-sdw-spec-list-by-priority | Specs "00056-sdw-per-role-agent-models" and "00055-sdw-spec-list-by-priority" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00057-sdw-orch-delivery-report-step-contributions | Specs "00056-sdw-per-role-agent-models" and "00057-sdw-orch-delivery-report-step-contributions" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00057-sdw-orch-delivery-report-step-contributions | Specs "00056-sdw-per-role-agent-models" and "00057-sdw-orch-delivery-report-step-contributions" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00057-sdw-orch-delivery-report-step-contributions | Specs "00056-sdw-per-role-agent-models" and "00057-sdw-orch-delivery-report-step-contributions" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00056-sdw-per-role-agent-models" and "00058-sdw-batch-delivery-integrity" both name `skills/sdw-batch/references/batch_protocol.md`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00056-sdw-per-role-agent-models" and "00058-sdw-batch-delivery-integrity" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00056-sdw-per-role-agent-models" and "00058-sdw-batch-delivery-integrity" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00058-sdw-batch-delivery-integrity | Specs "00056-sdw-per-role-agent-models" and "00058-sdw-batch-delivery-integrity" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00059-sdw-ship-pr-review-thread-fidelity | Specs "00056-sdw-per-role-agent-models" and "00059-sdw-ship-pr-review-thread-fidelity" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00060-sdw-delivery-report-artifact-location | Specs "00056-sdw-per-role-agent-models" and "00060-sdw-delivery-report-artifact-location" both name `skills/sdw-orch/references/orchestrator_protocol.md`. | high |
| overlap | 00060-sdw-delivery-report-artifact-location | Specs "00056-sdw-per-role-agent-models" and "00060-sdw-delivery-report-artifact-location" both name `skills/sdw-orch/SKILL.md`. | high |
| overlap | 00060-sdw-delivery-report-artifact-location | Specs "00056-sdw-per-role-agent-models" and "00060-sdw-delivery-report-artifact-location" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |
| overlap | 00062-sdw-spec-issue-provider-sync | Specs "00056-sdw-per-role-agent-models" and "00062-sdw-spec-issue-provider-sync" both name `.sdw/config.json`. | high |
| overlap | 00062-sdw-spec-issue-provider-sync | Specs "00056-sdw-per-role-agent-models" and "00062-sdw-spec-issue-provider-sync" both name `skills/sdw-config/scripts/sdw_config.cjs`. | high |
| overlap | 00062-sdw-spec-issue-provider-sync | Specs "00056-sdw-per-role-agent-models" and "00062-sdw-spec-issue-provider-sync" both name `skills/sdw-spec/scripts/validate_spec.cjs`. | high |

## Notes

- Step 1 (derivation) skipped: not recorded
- Task task-2 accepted after re-dispatch (sequence 2)
- Task task-3 accepted after re-dispatch (sequence 3)
- Task task-4 accepted after re-dispatch (sequence 4)
- Task task-5 accepted after re-dispatch (sequence 5)
- Environment: workspace: 17 changed file(s) in base..HEAD; feature branch reused; SCM provider: github; score iterations: 2

## Outcome

- Result: `completed`
- Delivery commit: `fb8fc9b36109b2fa2a2217588afdde9a47a951a3`
- Ship status: `pending`
- Duration: 1h 23m 17s

## Step Contributions

- Recorded: 13 contribution(s)

### Step 1: derivation

- **derivation** 2026-10-23T10:18:15.790Z - Derivation skipped
  - Body: `{"status":"skipped","derivationNeeded":false}`

### Step 2: refinement

- **refinement** 2026-10-23T10:18:15.919Z - Refinement resolved 2 decision gap(s)
  - Body: `{"status":"completed","hasGaps":true,"gapsResolved":[{"dimension":"concurrency_and_ordering","question":"How should task execution ordering be scheduled?","chosenOption":"(Recommended) Execute sequentially by default, parallelizing only independent DAG tasks"},{"dimension":"state_persistence","question":"Where should session state be persisted across runs?","chosenOption":"(Recommended) Persist to .sdw/state/{runId}.state.json"}],"specObservations":[{"kind":"overlap","otherSpec":"00001-sdw-implement-initial-version","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00001-sdw-implement-initial-version\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00001-sdw-implement-initial-version","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00001-sdw-implement-initial-version\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00002-sdw-spec-management","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00002-sdw-spec-management\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00002-sdw-spec-management","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00002-sdw-spec-management\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00002-sdw-spec-management","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00002-sdw-spec-management\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00003-sdw-router-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00003-sdw-router-skill\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00003-sdw-router-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00003-sdw-router-skill\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00004-rename-sdw-implement-to-sdw-orch","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00004-rename-sdw-implement-to-sdw-orch\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00004-rename-sdw-implement-to-sdw-orch","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00004-rename-sdw-implement-to-sdw-orch\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00005-sdw-orch-multi-spec-batch","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00005-sdw-orch-multi-spec-batch\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00005-sdw-orch-multi-spec-batch","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00005-sdw-orch-multi-spec-batch\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00006-packaging-installer-updater","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00006-packaging-installer-updater\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00006-packaging-installer-updater","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00006-packaging-installer-updater\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00008-sdw-rules-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00008-sdw-rules-skill\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00008-sdw-rules-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00008-sdw-rules-skill\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00008-sdw-rules-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00008-sdw-rules-skill\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00009-sdw-security-checks","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00009-sdw-security-checks\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00009-sdw-security-checks","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00009-sdw-security-checks\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00009-sdw-security-checks","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00009-sdw-security-checks\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00009-sdw-security-checks","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00009-sdw-security-checks\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00009-sdw-security-checks","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00009-sdw-security-checks\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00010-sdw-orch-branch-worktree-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00010-sdw-orch-branch-worktree-strategy\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00010-sdw-orch-branch-worktree-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00010-sdw-orch-branch-worktree-strategy\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00010-sdw-orch-branch-worktree-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00010-sdw-orch-branch-worktree-strategy\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00010-sdw-orch-branch-worktree-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00010-sdw-orch-branch-worktree-strategy\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00010-sdw-orch-branch-worktree-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00010-sdw-orch-branch-worktree-strategy\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00011-github-actions-integration","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00011-github-actions-integration\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00011-github-actions-integration","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00011-github-actions-integration\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00011-github-actions-integration","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00011-github-actions-integration\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00012-scm-provider-selection","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00012-scm-provider-selection\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00012-scm-provider-selection","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00012-scm-provider-selection\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00012-scm-provider-selection","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00012-scm-provider-selection\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00012-scm-provider-selection","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00012-scm-provider-selection\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00013-sdw-orch-refinement-and-pre-pr-gates","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00013-sdw-orch-refinement-and-pre-pr-gates\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00013-sdw-orch-refinement-and-pre-pr-gates","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00013-sdw-orch-refinement-and-pre-pr-gates\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00013-sdw-orch-refinement-and-pre-pr-gates","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00013-sdw-orch-refinement-and-pre-pr-gates\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00013-sdw-orch-refinement-and-pre-pr-gates","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00013-sdw-orch-refinement-and-pre-pr-gates\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00013-sdw-orch-refinement-and-pre-pr-gates","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00013-sdw-orch-refinement-and-pre-pr-gates\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00014-sdw-orch-step-artifacts-persistence","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00014-sdw-orch-step-artifacts-persistence\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00014-sdw-orch-step-artifacts-persistence","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00014-sdw-orch-step-artifacts-persistence\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00014-sdw-orch-step-artifacts-persistence","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00014-sdw-orch-step-artifacts-persistence\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00014-sdw-orch-step-artifacts-persistence","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00014-sdw-orch-step-artifacts-persistence\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00014-sdw-orch-step-artifacts-persistence","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00014-sdw-orch-step-artifacts-persistence\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00015-sdw-orch-implementation-execution\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00015-sdw-orch-implementation-execution\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-config/references/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00015-sdw-orch-implementation-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00015-sdw-orch-implementation-execution\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00024-sdw-ship-pr","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00024-sdw-ship-pr\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00024-sdw-ship-pr","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00024-sdw-ship-pr\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00024-sdw-ship-pr","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00024-sdw-ship-pr\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00024-sdw-ship-pr","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00024-sdw-ship-pr\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00025-sdw-code-review-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00025-sdw-code-review-skill\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00025-sdw-code-review-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00025-sdw-code-review-skill\" both name 'skills/sdw-code-review/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00025-sdw-code-review-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00025-sdw-code-review-skill\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00025-sdw-code-review-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00025-sdw-code-review-skill\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00025-sdw-code-review-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00025-sdw-code-review-skill\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00026-ensure-hybrid-mode-compatiblity","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00026-ensure-hybrid-mode-compatiblity\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00026-ensure-hybrid-mode-compatiblity","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00026-ensure-hybrid-mode-compatiblity\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00026-ensure-hybrid-mode-compatiblity","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00026-ensure-hybrid-mode-compatiblity\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-config/references/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00028-sdw-orch-sequential-subagent-implementation","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00028-sdw-orch-sequential-subagent-implementation\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00029-sdw-orch-sandboxed-execution\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00029-sdw-orch-sandboxed-execution\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00029-sdw-orch-sandboxed-execution\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00029-sdw-orch-sandboxed-execution\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00029-sdw-orch-sandboxed-execution\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00029-sdw-orch-sandboxed-execution\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00029-sdw-orch-sandboxed-execution","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00029-sdw-orch-sandboxed-execution\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00030-sdw-micro-task-dag-planning","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00030-sdw-micro-task-dag-planning\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00030-sdw-micro-task-dag-planning","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00030-sdw-micro-task-dag-planning\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00030-sdw-micro-task-dag-planning","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00030-sdw-micro-task-dag-planning\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00030-sdw-micro-task-dag-planning","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00030-sdw-micro-task-dag-planning\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00030-sdw-micro-task-dag-planning","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00030-sdw-micro-task-dag-planning\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00030-sdw-micro-task-dag-planning","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00030-sdw-micro-task-dag-planning\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00032-sdw-fixer-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00032-sdw-fixer-skill\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00032-sdw-fixer-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00032-sdw-fixer-skill\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00032-sdw-fixer-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00032-sdw-fixer-skill\" both name 'skills/sdw-fixer/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00032-sdw-fixer-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00032-sdw-fixer-skill\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00032-sdw-fixer-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00032-sdw-fixer-skill\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00034-sdw-memory-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00034-sdw-memory-skill\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00034-sdw-memory-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00034-sdw-memory-skill\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00034-sdw-memory-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00034-sdw-memory-skill\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00036-sdw-changelog-delivery-records","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00036-sdw-changelog-delivery-records\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00036-sdw-changelog-delivery-records","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00036-sdw-changelog-delivery-records\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00036-sdw-changelog-delivery-records","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00036-sdw-changelog-delivery-records\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00036-sdw-changelog-delivery-records","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00036-sdw-changelog-delivery-records\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00036-sdw-changelog-delivery-records","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00036-sdw-changelog-delivery-records\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00037-sdw-run-retrospective-candidates","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00037-sdw-run-retrospective-candidates\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00038-sdw-spec-drift-repair","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00038-sdw-spec-drift-repair\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00039-sdw-batch-skill","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00039-sdw-batch-skill\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00040-sdw-branching-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00040-sdw-branching-strategy\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00040-sdw-branching-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00040-sdw-branching-strategy\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00040-sdw-branching-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00040-sdw-branching-strategy\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00040-sdw-branching-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00040-sdw-branching-strategy\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00040-sdw-branching-strategy","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00040-sdw-branching-strategy\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00042-us-18-reduce-repeated-full-test-suite-r","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00042-us-18-reduce-repeated-full-test-suite-r\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00043-us-17-emphasize-step-number-progress-in","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00043-us-17-emphasize-step-number-progress-in\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00044-us-16-add-gitattributes-and-per-task-sa","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00044-us-16-add-gitattributes-and-per-task-sa\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00044-us-16-add-gitattributes-and-per-task-sa","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00044-us-16-add-gitattributes-and-per-task-sa\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00045-sdw-retro-auto-run","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00045-sdw-retro-auto-run\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00045-sdw-retro-auto-run","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00045-sdw-retro-auto-run\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00045-sdw-retro-auto-run","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00045-sdw-retro-auto-run\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00046-sdw-batch-retro-followup","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00046-sdw-batch-retro-followup\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00046-sdw-batch-retro-followup","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00046-sdw-batch-retro-followup\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00046-sdw-batch-retro-followup","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00046-sdw-batch-retro-followup\" both name 'skills/sdw-batch/references/batch_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00046-sdw-batch-retro-followup","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00046-sdw-batch-retro-followup\" both name 'skills/sdw-config/references/config_spec.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00050-sdw-ship-pr-native-pre-pr-enforcement-ga","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00050-sdw-ship-pr-native-pre-pr-enforcement-ga\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00050-sdw-ship-pr-native-pre-pr-enforcement-ga","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00050-sdw-ship-pr-native-pre-pr-enforcement-ga\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00051-issue-linkage-imported-scm-issues-close-","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00051-issue-linkage-imported-scm-issues-close-\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00052-sdw-fresh-subagent-code-review","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00052-sdw-fresh-subagent-code-review\" both name 'skills/sdw-code-review/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00052-sdw-fresh-subagent-code-review","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00052-sdw-fresh-subagent-code-review\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00052-sdw-fresh-subagent-code-review","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00052-sdw-fresh-subagent-code-review\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00053-batch-auto-merge-sdw-batch-merges-each-d","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00053-batch-auto-merge-sdw-batch-merges-each-d\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00053-batch-auto-merge-sdw-batch-merges-each-d","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00053-batch-auto-merge-sdw-batch-merges-each-d\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00054-sdw-orch-delivery-report-companion-file-","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00054-sdw-orch-delivery-report-companion-file-\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00054-sdw-orch-delivery-report-companion-file-","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00054-sdw-orch-delivery-report-companion-file-\" both name '.sdw/config.schema.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00054-sdw-orch-delivery-report-companion-file-","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00054-sdw-orch-delivery-report-companion-file-\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00054-sdw-orch-delivery-report-companion-file-","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00054-sdw-orch-delivery-report-companion-file-\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00055-sdw-spec-list-by-priority","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00055-sdw-spec-list-by-priority\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00055-sdw-spec-list-by-priority","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00055-sdw-spec-list-by-priority\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00057-sdw-orch-delivery-report-step-contributions","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00057-sdw-orch-delivery-report-step-contributions\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00057-sdw-orch-delivery-report-step-contributions","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00057-sdw-orch-delivery-report-step-contributions\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00057-sdw-orch-delivery-report-step-contributions","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00057-sdw-orch-delivery-report-step-contributions\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00058-sdw-batch-delivery-integrity\" both name 'skills/sdw-batch/references/batch_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00058-sdw-batch-delivery-integrity\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00058-sdw-batch-delivery-integrity\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00058-sdw-batch-delivery-integrity","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00058-sdw-batch-delivery-integrity\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00059-sdw-ship-pr-review-thread-fidelity","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00059-sdw-ship-pr-review-thread-fidelity\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00060-sdw-delivery-report-artifact-location","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00060-sdw-delivery-report-artifact-location\" both name 'skills/sdw-orch/references/orchestrator_protocol.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00060-sdw-delivery-report-artifact-location","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00060-sdw-delivery-report-artifact-location\" both name 'skills/sdw-orch/SKILL.md'.","severity":"high"},{"kind":"overlap","otherSpec":"00060-sdw-delivery-report-artifact-location","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00060-sdw-delivery-report-artifact-location\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00062-sdw-spec-issue-provider-sync","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00062-sdw-spec-issue-provider-sync\" both name '.sdw/config.json'.","severity":"high"},{"kind":"overlap","otherSpec":"00062-sdw-spec-issue-provider-sync","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00062-sdw-spec-issue-provider-sync\" both name 'skills/sdw-config/scripts/sdw_config.cjs'.","severity":"high"},{"kind":"overlap","otherSpec":"00062-sdw-spec-issue-provider-sync","evidence":"Specs \"00056-sdw-per-role-agent-models\" and \"00062-sdw-spec-issue-provider-sync\" both name 'skills/sdw-spec/scripts/validate_spec.cjs'.","severity":"high"}]}`
  - Evidence: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/00056-sdw-per-role-agent-models-step-2.md`

### Step 3: dag_generation

- **plan** 2026-10-23T10:18:16.051Z - DAG plan: 5 task(s)
  - Body: `{"taskIds":["task-1","task-2","task-3","task-4","task-5"],"dependencyOrder":[{"id":"task-1","dependencies":[]},{"id":"task-2","dependencies":["task-1"]},{"id":"task-3","dependencies":["task-2"]},{"id":"task-4","dependencies":["task-3"]},{"id":"task-5","dependencies":["task-4"]}],"dispatchMode":"subagent","complexity":{"acCount":15,"touchpoints":["cli","state","vcs","pr","ui"],"targetFileCount":13,"level":"complex","isComplex":true}}`
  - Evidence: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/00056-sdw-per-role-agent-models-step-3.md`

### Step 4: implementation

- **task** 2026-10-23T11:43:46.267Z - Task task-1 accepted
  - Body: `{"taskId":"task-1","outcome":"success","filesChanged":[".sdw/config.json","skills/sdw-config/references/config.schema.json","skills/sdw-orch/scripts/sdw_orch.cjs"],"retries":0,"abandonments":[],"commit":"2e4c3e6e382bbdf2e86445a6753081fa53fe8e15","acIds":["AC1","AC2","AC3"]}`
  - Evidence: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/task-task-1.evidence.json`

### Step 5: scoring

- **verdict** 2026-10-23T11:55:33.538Z - Conformance score 9/8
  - Body: `{"score":9,"minScore":8,"passed":true,"verifiedCount":14,"failingCount":1,"verdicts":[{"id":"AC1","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:863"},{"id":"AC2","verdict":"failed","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:2356 — the orchestrator hint is only logged and copied into Steps 1-3 output metadata; deriveAgentSpec, analyzeSpecificationGaps, and generateDagPlan never receive it, and no committed test asserts orchestratorHint anywhere in tests/"},{"id":"AC3","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:4269"},{"id":"AC4","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:1091"},{"id":"AC5","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:1106"},{"id":"AC6","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:889"},{"id":"AC7","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:870"},{"id":"AC8","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:906"},{"id":"AC9","verdict":"verified","evidence":"skills/sdw-config/scripts/sdw_config.cjs:323"},{"id":"AC10","verdict":"verified","evidence":"skills/sdw-orch/scripts/model_capabilities.cjs:275"},{"id":"AC11","verdict":"verified","evidence":"skills/sdw-orch/scripts/model_capabilities.cjs:145"},{"id":"AC12","verdict":"verified","evidence":"skills/sdw-config/scripts/sdw_config.cjs:827"},{"id":"AC13","verdict":"verified","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:1064"},{"id":"AC14","verdict":"verified","evidence":"tests/sdw_orch.test.cjs:2925"},{"id":"AC15","verdict":"verified","evidence":"tests/sdw_orch.test.cjs:2959"}]}`
  - Evidence: `skills/sdw-orch/scripts/sdw_orch.cjs:863`, `skills/sdw-orch/scripts/sdw_orch.cjs:2356 — the orchestrator hint is only logged and copied into Steps 1-3 output metadata; deriveAgentSpec, analyzeSpecificationGaps, and generateDagPlan never receive it, and no committed test asserts orchestratorHint anywhere in tests/`, `skills/sdw-orch/scripts/sdw_orch.cjs:4269`, `skills/sdw-orch/scripts/sdw_orch.cjs:1091`, `skills/sdw-orch/scripts/sdw_orch.cjs:1106`, `skills/sdw-orch/scripts/sdw_orch.cjs:889`, `skills/sdw-orch/scripts/sdw_orch.cjs:870`, `skills/sdw-orch/scripts/sdw_orch.cjs:906`, `skills/sdw-config/scripts/sdw_config.cjs:323`, `skills/sdw-orch/scripts/model_capabilities.cjs:275`, `skills/sdw-orch/scripts/model_capabilities.cjs:145`, `skills/sdw-config/scripts/sdw_config.cjs:827`, `skills/sdw-orch/scripts/sdw_orch.cjs:1064`, `tests/sdw_orch.test.cjs:2925`, `tests/sdw_orch.test.cjs:2959`
- **judgment** 2026-10-23T11:55:33.538Z - Judge analysis
  - Body: `{"summary":"The delivery adds the full advisory models contract (default plus seven roles plus a disabled-by-default detection block) to the tracked config and both schemas, and implements static resolution, judge precedence over scoring.judge*, ship-to-fixer and retro-to-default fallback, capability bind-once with per-session cache and fail-open, unavailable-hint adaptation with requested/resolved/reason, shape rejection before any probe, and the dry-run detection/hint block. Fourteen of fifteen criteria hold. AC2 is failed: the orchestrator hint is resolved and echoed into Step 1-3 output metadata, but derivation, refinement, and DAG generation never consume it, and the committed suite contains no orchestratorHint assertion at all, so the criterion's application is unproven and would not regress if removed. The diff shown in the judge prompt is truncated at 120,000 bytes (of 142,086); every criterion was checked against the real checkout, including the unshown test hunks. The focused 00056 tests (16/16) and the full suite (586/586) pass on this tree.","risks":[{"severity":"high","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:2356","note":"AC2 is metadata-only: the hint is printed and attached to Steps 1-3 outputs, but no planning function takes it, and no test references orchestratorHint. A reviewer must decide whether host-side routing from that metadata is enough; if it is, the missing committed test still leaves the behaviour uncorroborated."},{"severity":"medium","evidence":"skills/sdw-orch/SKILL.md:92","note":"SKILL.md Step 7 still states that the reviewer and fixer briefs carry only target root, base reference, report path, and scope fence (fixer: findings, target, report), which contradicts the added Model hint line; and cmdRun prints the brief and then runs the review/fix inline, so no subagent consumes it in this path."},{"severity":"medium","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:3982","note":"The ship hint is only logged and put in the Step 8 payload, and the retro hint is only logged plus snapshotted; neither the sdw-ship-pr argv (line 3775) nor runRetroForCompletedRun (line 369) receives a hint, so routing is entirely host-side."},{"severity":"medium","evidence":"skills/sdw-orch/references/orchestrator_protocol.md:90","note":"The protocol promises state.models always records static, capabilities, supportedModels, resolved, and adaptations, but the disabled-detection branch writes only detection plus flat *Hint fields (skills/sdw-orch/scripts/sdw_orch.cjs:2324); consumers reading the documented snapshot shape get undefined on the default, zero-config path."},{"severity":"low","evidence":"skills/sdw-orch/scripts/sdw_orch.cjs:1045","note":"The dry-run probe branch is untested and dry-run can only print skipped, hit, or probe, never the failed-open state named in the spec validation notes; also sdw-config parse iterates raw keys, so an absent models block yields no models in the parsed view."}],"followUps":["Either pass the orchestrator hint to the planning entry points or add a committed test asserting orchestratorHint on Steps 1-3 outputs and the DAG plan, so AC2 has observable evidence.","Resolve how host-side roles actually receive reviewer, fixer, ship, and retro hints (state field, env, or CLI), and align the Step 7 'carries only' wording in skills/sdw-orch/SKILL.md with the Model hint line.","Write the full state.models snapshot (static, resolved, adaptations) in the disabled-detection path, or narrow the protocol's snapshot contract.","Add dry-run coverage for the enabled cache-miss/probe preview and decide whether failed-open can be represented without probing."]}`
  - Evidence: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/00056-sdw-per-role-agent-models-step-5.md`

### Step 6: delivery_commit

- **delivery** 2026-10-23T11:55:34.348Z - Delivery commit fb8fc9b36109b2fa2a2217588afdde9a47a951a3
  - Body: `{"deliveryCommit":"fb8fc9b36109b2fa2a2217588afdde9a47a951a3","deliveryCommitCreated":false,"stagedFiles":[".sdw/config.json",".sdw/config.schema.json",".sdw/specs/00056-sdw-per-role-agent-models.md",".sdw/specs/index.specs.md","skills/sdw-batch/references/batch_protocol.md","skills/sdw-code-review/SKILL.md","skills/sdw-config/references/config.schema.json","skills/sdw-config/references/config_spec.md","skills/sdw-config/scripts/sdw_config.cjs","skills/sdw-fixer/SKILL.md","skills/sdw-orch/SKILL.md","skills/sdw-orch/references/orchestrator_protocol.md","skills/sdw-orch/scripts/model_capabilities.cjs","skills/sdw-orch/scripts/sdw_orch.cjs","tests/sdw_config.test.cjs","tests/sdw_orch.test.cjs"],"securityGate":{"bypassed":false,"status":"not run"}}`
  - Evidence: `.sdw/config.json`, `.sdw/config.schema.json`, `.sdw/specs/00056-sdw-per-role-agent-models.md`, `.sdw/specs/index.specs.md`, `skills/sdw-batch/references/batch_protocol.md`, `skills/sdw-code-review/SKILL.md`, `skills/sdw-config/references/config.schema.json`, `skills/sdw-config/references/config_spec.md`, `skills/sdw-config/scripts/sdw_config.cjs`, `skills/sdw-fixer/SKILL.md`, `skills/sdw-orch/SKILL.md`, `skills/sdw-orch/references/orchestrator_protocol.md`, `skills/sdw-orch/scripts/model_capabilities.cjs`, `skills/sdw-orch/scripts/sdw_orch.cjs`, `tests/sdw_config.test.cjs`, `tests/sdw_orch.test.cjs`

### Step 7: code_review

- **review** 2026-10-23T11:55:35.669Z - Review iteration 1
  - Body: `{"iteration":1,"findings":{"error":0,"warning":0,"suggestion":2,"info":0},"fixes":[],"passed":true}`
  - Evidence: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/00056-sdw-per-role-agent-models-step-7.md`

### Step 8: pr_preparation

- **convergence** 2026-10-23T11:59:11.919Z - Convergence iteration 1
  - Body: `{"iteration":1,"rounds":2,"failingChecks":[],"openThreads":0,"resolvedThreads":0,"fixCommit":null,"converged":false}`
- **convergence** 2026-10-23T11:59:13.093Z - Convergence iteration 2
  - Body: `{"iteration":2,"rounds":2,"failingChecks":[],"openThreads":0,"resolvedThreads":0,"fixCommit":null,"converged":true}`
- **gates** 2026-10-23T11:59:14.502Z - Pre-PR gates: 6 result(s)
  - Body: `{"gates":[{"name":"prePrCommand","status":"skipped","detail":"prePrCommand is not configured"},{"name":"build","status":"skipped","detail":"requiredBuild is false"},{"name":"tests","status":"pass","detail":"npm test exited 0"},{"name":"security","status":"pass","detail":"sdw-security-checks found no blocking leak"},{"name":"runState","status":"pass","detail":"step 4, step 6 and step 7 completed; score 9 >= scoreMin 8"},{"name":"discovery","status":"pass","detail":"no prepare obligations discovered"}]}`
- **ship** 2026-10-23T11:59:14.502Z - Pull request #54
  - Body: `{"pushed":true,"branch":"feature/00056-sdw-per-role-agent-models","pullRequest":{"number":"54","url":"https://github.com/jpolvora/spec-driven-workflow/pull/54","title":null},"shipStatus":"delivered"}`
  - Evidence: `https://github.com/jpolvora/spec-driven-workflow/pull/54`

### Step 9: retrospective

- **retro** 2026-10-23T11:59:19.205Z - Retrospective passed: 0 candidate(s)
  - Body: `{"status":"passed","runStatus":"completed","signals":{"retries":{"scoreIterations":2,"reviewIterations":0,"reviewRounds":2,"dispatchAbandonments":0,"total":4},"leftoverRuns":0,"missingArtifacts":0,"reviewFindings":{"total":2,"open":2}},"candidates":[],"fixes":{"recorded":[],"consolidated":null,"queuedSpecifications":[],"failures":[]},"routedCandidates":[],"reportMd":".sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/run-1792750694534-00056-sdw-per-role-agent-model.retro.md","reportJson":".sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/run-1792750694534-00056-sdw-per-role-agent-model.retro.json"}`
  - Evidence: `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/run-1792750694534-00056-sdw-per-role-agent-model.retro.md`, `.sdw/state/00056-sdw-per-role-agent-models/run-1792750694534-00056-sdw-per-role-agent-model/run-1792750694534-00056-sdw-per-role-agent-model.retro.json`
