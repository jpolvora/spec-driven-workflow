---
id: null
slug: 00056-sdw-per-role-agent-models
title: "SDW Per-Role Agent Model Configuration"
source: local
status: draft
specDate: 2026-10-22
priority: medium
value: "Lets each orchestration role run its own model instead of one model for every step"
effort: L
---

# Specification — SDW Per-Role Agent Model Configuration

## Description

Today only Step 5 conformance scoring carries model hints (`scoring.judgeModel`, `scoring.judgeProvider`, `scoring.judgeEffort`, `scoring.judgeApiEndpoint`). Every other agent role in `sdw-orch` plus `sdw-batch` runs on the current agent model instance by implication: orchestrator planning (Steps 1-3 plus supervision), Step 4 task workers, Step 7 fresh reviewer, fixer remediation, Step 8 convergence, retro analysis. Operators cannot choose a smarter high-effort reasoning model for orchestration plus a fast low-effort model for task execution plus a distinct thorough model for code review.

This specification introduces a harness-agnostic `models` section in `.sdw/config.json` with per-role advisory hints plus a `default` fallback, layered with an optional start-of-run capability detection. Deterministic helpers validate shape, resolve with a documented fallback chain, display resolved hints in plan output, plus embed hints in dispatch envelopes with subagent briefs. When `models.detection` is enabled, Step 1 captures host plus harness capabilities before dispatch, then adapts unavailable hints down the fallback chain with recorded reasons. When disabled, the run uses static resolution without concern for per-step roles. Host harnesses interpret hints when spawning subagents. No helper invokes a model, calls a provider API, or stores credentials.

### Design Intent

Give operators cost plus quality control through declarative role-to-model mapping plus opt-in environment awareness while preserving product guarantees: opaque strings, file-based contracts, zero runtime dependencies, harness agnosticism. Keep one `orchestrator` hint for all planning in v1, reuse the existing scoring keys as judge fallback, default detection to disabled so existing runs stay untouched, fail open on detection errors so routing never blocks delivery, plus keep `sdw-batch` inheritance-only with no batch-level keys.

## Acceptance Criteria

- AC1: The models configuration shall provide a default fallback hint applied when a role-specific hint is absent.
- AC2: While orchestrated planning executes, the orchestrator shall apply the orchestrator hint to derivation, refinement, DAG generation.
- AC3: While Step 4 dispatch executes, the orchestrator shall include the worker hint in each task envelope plus prompt brief.
- AC4: While Step 7 review executes, the orchestrator shall include the reviewer hint in the fresh reviewer subagent brief.
- AC5: When fixer remediation is required, the orchestrator shall include the fixer hint in the fixer subagent brief.
- AC6: When Step 5 scoring executes, the system shall resolve the judge hint from the models judge entry before the scoring fallback.
- AC7: When Step 8 convergence executes, the system shall apply the ship hint with fallback to the fixer hint.
- AC8: Where retro analysis executes, the system shall apply the retro hint with fallback to the default hint.
- AC9: The models configuration shall provide a detection toggle defaulting to disabled static resolution.
- AC10: When detection is enabled at run start, the system shall bind capabilities once before task dispatch plus reuse the entry across steps.
- AC11: When a configured hint is unavailable in captured capabilities, the system shall adapt to the next fallback hint plus record requested, resolved, reason.
- AC12: The deterministic helpers shall reject malformed model hints without network access.
- AC13: When dry-run plan prints, the system shall display detection source, status, key plus resolved model hints per role without executing steps.
- AC14: If a role hint is absent, then the system shall fall back to the default hint before current behavior.
- AC15: The modified skill definitions shall remain within Tier-1 line budgets.

## Notes

- Proposed schema (`models` alongside `scoring`, `implementation`, `branching`):
  - `models.default`: fallback hint used when a role entry is null or absent.
  - `models.orchestrator`: Steps 1-3 derivation, refinement grilling, DAG generation, plus run supervision. Intended for a smarter high-effort reasoning model.
  - `models.worker`: Step 4 task implementation subagents. Intended for a fast low-effort model.
  - `models.reviewer`: Step 7 fresh reviewer subagent under spec 00052 isolation. Intended for a thorough model distinct from worker.
  - `models.fixer`: `sdw-fixer` remediation in Step 7 fix iteration plus Step 8 convergence fixes. Intended for a fast surgical model.
  - `models.judge`: Step 5 conformance scoring. Canonical successor to `scoring.judge*`; see precedence below.
  - `models.ship`: Step 8 PR metadata plus review convergence dialogue. Optional override; falls back to fixer.
  - `models.retro`: `sdw-retro` analysis. Optional override; falls back to default.
  - Each role entry shape mirrors scoring: `{ "model": string|null, "provider": string|null, "effort": string|null, "apiEndpoint": string|null }`. All keys nullable; absent `models` resolves every role to null.
- Suggested role-to-model guidance (advisory, host interprets):
  - orchestrator: high reasoning effort, larger context window, slower plus accurate.
  - worker: low effort, fast iteration, code-focused.
  - reviewer: medium-high effort, critique-focused, different family from worker where possible to reduce blind spots.
  - fixer: same class as worker, surgical edit discipline.
  - judge: deterministic-leaning, strict criticity, fenced ACs plus diff only.
  - ship: conversational, thread-resolution tone, may reuse fixer.
  - retro: analytical, transcript summarization, may reuse orchestrator.
- Resolution precedence:
  - orchestrator, worker, reviewer, fixer: role entry, then `models.default`, then null (current behavior: current agent model instance).
  - ship: `models.ship`, then `models.fixer`, then `models.default`, then null.
  - retro: `models.retro`, then `models.default`, then null.
  - judge: `models.judge.*`, then `scoring.judgeModel|judgeProvider|judgeEffort|judgeApiEndpoint`, then `models.default`, then null. Existing scoring keys stay honored; no breaking change.
- `sdw-batch` defines no model keys. Each queued item runs its own `sdw-orch` Step 1 against the same consumer-local cache file; batch never carries in-memory capabilities across items.
- Capability detection (`models.detection`, opt-in, default disabled):
  - Shape: `{ "enabled": boolean, "command": string|null, "timeoutMs": integer }` with defaults `{ "enabled": false, "command": null, "timeoutMs": 30000 }`. Env fallback `SDW_MODELS_DETECT_COMMAND` mirrors the judge command pattern. CLI `--no-model-detect` forces skip for one run; CLI `--refresh-models` forces a fresh probe.
  - Disabled path: skip detection entirely; use static fallback-chain resolution; record `detection: { "status": "skipped" }` in state. Runs stay free of per-step model concern.
  - Enabled path binds once at Step 1 before dispatch, then reuses the entry across every step with no per-step re-probe. Re-probe only on `--refresh-models`, host or toolset change, explicit rebind, or a different session key.
  - Cache file: consumer-local gitignored `.sdw/host-capabilities.json` mapping one key per session model to `{ capabilities, supportedModels, probedAt, source }`. Hits return the stored entry; misses run one probe then upsert only the current key while preserving others; missing or unreadable cache behaves as a miss. The key mirrors the ws pattern (`hostId::sessionModel`) with neutral host identity plus session model id; skill text keeps neutral alias names only.
  - Cache-query-first: before dispatch the host queries the cached entry for the minimal token set (`model`, `provider`, `effort`) plus prefers the bound native path over shell equivalents for the same operation. No vendor shape pre-map is shipped; unknown hosts degrade to static resolution, never a startup failure.
  - Command path: when `models.detection.command` is set, the host executes it with tokens `{capabilitiesFile}`, `{targetRoot}`, `{slug}`, `{runId}`; the command writes a capabilities JSON file; helpers validate shape only.
  - Host-consult path: when command is null, the host interrogates its harness (LLM model query, environment probe, or configured inventory) plus writes the same capabilities file shape.
  - Capabilities file minimal contract: `{ "harness": string, "models": [{ "model": string, "provider": string|null, "effort": string|null, "available": boolean }] }`. Extra keys permitted; missing file plus malformed JSON plus timeout fail open with a warning.
  - Resolution precedence per role: CLI flag, then role entry, then `models.default`, then null (session model). Token `"current"` stops fallthrough at the session model. Unknown preset names are out of scope in v1; unsupported model ids fail soft per the adaptation rule below.
  - Adaptation rule: for each role, when the statically resolved hint names a model flagged unavailable in `supportedModels` or the capabilities list, walk down the role fallback chain to the first available entry, then `default`, then null; record `{ "role": string, "requested": string|null, "resolved": string|null, "reason": string }` per adaptation plus preserve the requested id as `configuredModel` in envelopes plus state when actual differs so telemetry stays auditable.
  - Portable dispatch: when the dispatch tool exposes a model field the host passes the resolved identifier through that field, otherwise it includes a `Model: {name}` header when the host supports model hints; null resolved means session model with no header.
  - Tier non-interference: detection routes model hints only; it never flips `implementation.mode` (`subagent` versus `command`) and never changes the Step 4 dispatch ladder.
  - Fail-open principle: detection errors never block delivery; the run proceeds on static resolution with `detection.status` of `failed-open` plus the error recorded in `state.errors` as a warning.
- Target surfaces (documentation plus deterministic helpers, no model invocation):
  - `skills/sdw-config/references/config.schema.json` plus `.sdw/config.schema.json`: add `models` object with per-role hint schema plus `detection` sub-schema, `additionalProperties: false` inside each hint.
  - `skills/sdw-config/references/config_spec.md` §2 plus supported-properties table: document `models.*` plus `models.detection.*` keys with defaults null plus disabled.
  - `skills/sdw-config/scripts/sdw_config.cjs`: defaults, `check` shape validation, `parse` token-free passthrough plus resolved view including detection settings.
  - `skills/sdw-orch/SKILL.md` Step 1 plus Steps 4, 5, 7, 8: Step 1 detection sequence; which brief carries which hint; Step 5 judge resolution order.
  - `skills/sdw-orch/references/orchestrator_protocol.md` §§1, 2, 6, 8 plus dry-run §10: Step 1 bind-once lifecycle with cache key, hit versus probe source, 4-condition invalidation, envelope fields (`workerHint`, `reviewerHint`, `fixerHint`, `configuredModel`), prompt brief sections, judge prompt header, dry-run detection plus resolved-hints block, state `state.models` snapshot.
  - `skills/sdw-batch/references/batch_protocol.md`: inheritance note plus per-item recorded hints; no cross-item capability cache.
  - `skills/sdw-code-review/SKILL.md` plus `skills/sdw-fixer/SKILL.md`: advisory note that orchestrated briefs may carry reviewer plus fixer hints; standalone runs ignore absent hints.
- Harness-agnostic contract: helpers treat hints plus capabilities as opaque strings, never validate reachability beyond file-shape checks, never emit credentials, never add runtime dependencies. Effort values (`high`, `medium`, `low` or provider-native tokens) pass through verbatim. Detection transport (command vs host consult) stays host-side.
- All helper scripts remain Node.js CommonJS (.cjs) using standard library modules only. No new runtime dependencies.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Live model invocation or provider API calls | Harness owns execution; config carries advisory hints only |
| Cost metering, quota enforcement, usage telemetry | Operator concern; no billing signals in run state |
| Credential plus key management | Secrets stay outside config; hints carry identifiers, never tokens |
| Batch-level model overrides | Batch delegates per item; per-item roles inherit orchestrator resolution |
| Planner sub-role split (derivation vs refinement vs DAG) | V1 keeps a single orchestrator hint; split only on measured need |
| Named model presets plus numeric step overrides | ws-style `modelPresets` plus `stepModels` deferred; v1 keeps role, default, session only |
| Vendor host-shape pre-map | No shipped shape table; unknown hosts degrade to static resolution |
| Prompt tuning per model family | Brief contents stay model-neutral; family quirks belong to the harness |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Opaque hint strings suffice across harnesses | model, provider, effort, apiEndpoint as nullable strings | Host harnesses differ; strings stay portable plus mirror the scoring pattern | y |
| Judge migration preserves scoring keys | models.judge overrides scoring.judge* with fallback | Avoids breaking existing consumers configured for Step 5 | y |
| Null means current behavior | Absent role plus absent default resolves to null | Preserves zero-config default of current agent model instance | y |
| Single orchestrator hint covers planning in v1 | No derivation, refinement, DAG split | Keeps YAGNI scope; split only when evidence shows divergent needs | y |
| Fresh-reviewer isolation unchanged | Reviewer hint rides inside the fenced brief | Spec 00052 isolation contract stays authoritative; hint adds routing only | y |
| Detection disabled preserves current runs | detection.enabled defaults to false with static-only resolution | Existing zero-config behavior stays untouched; opt-in awareness only | y |
| Detection failure never blocks delivery | Fail-open with warning plus static fallback | Routing is optimization, not a correctness gate, unlike judge fail-closed | y |
| Tier-1 line budgets hold | Wording fits within 120-line skill caps | Preserves progressive-disclosure readability | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| EARS syntax | All 15 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00056-sdw-per-role-agent-models.md` |
| Scope enclosure | One models feature with detection layer; no invocation, metering, or credential changes | Inspect ## Description plus ## Out of Scope |
| Schema inventory | Roles default, orchestrator, worker, reviewer, fixer, judge, ship, retro named with fallback chains plus detection toggle, keyed cache, CLI overrides | Inspect ## Notes role catalog, precedence list, detection block |
| Target inventory | Config schema, config spec, orch, batch, review, fixer surfaces named | Inspect ## Notes target surfaces |
| Baseline suite | Existing test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Authoring-mode validation of this spec exits `0` with `PASS`.
- `sdw-config check` plus `parse` round-trip `models` hints plus `models.detection` settings with resolved per-role view.
- `sdw-orch run --dry-run` prints a detection block (source hit, probe, skipped, failed-open; status; key; command source) plus a resolved-hints block naming orchestrator, worker, judge, reviewer, fixer, ship, retro.
- Step 1 with detection enabled records `state.models` with static, capabilities, supportedModels, resolved, adaptations, detection status, source, probedAt, key, plus one `model-capability-bind` telemetry line.
- Task envelopes plus prompt briefs carry `workerHint`; reviewer plus fixer briefs carry their hints; run state records a `state.models` snapshot.
- Step 5 judge prompt header cites the resolved judge hint plus criticity.

### Negative & Failing Test Scenarios

- Malformed hint: a non-string `effort` value fails `sdw-config check` without network access; the run refuses to start with a shape error.
- Detection disabled: the run records `detection.status` skipped, performs no capability probe, plus resolves hints statically.
- Detection failure: a missing capabilities file, malformed JSON, or timeout records `failed-open` with a warning plus proceeds on static resolution without blocking delivery.
- Cache reuse: a second Step 1 with an unchanged session key plus bound toolset reuses the cached entry with source hit plus performs no probe; `--refresh-models` forces a fresh probe.
- Unavailable hint: a configured worker model flagged unavailable adapts to `default` with an adaptation record naming requested plus resolved values, preserving requested as `configuredModel`.
- Absent role: a missing `models.reviewer` entry falls back to `models.default`, never fails resolution.
- Judge backward compatibility: null `models.judge` still honors `scoring.judgeModel` plus provider, effort, endpoint.
- Same-session review with reviewer hint: executing Step 7 inline in the orchestrator session still violates spec 00052; a fresh reviewer subagent is required regardless of hint presence.
- Unknown role key: an extra `models.planner` entry fails schema validation; v1 accepts only the catalogued roles plus default.
