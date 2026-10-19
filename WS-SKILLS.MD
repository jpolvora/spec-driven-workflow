# SDW vs. `workflow-skills` — Feature Comparison Report

**Date:** 2026-10-19

**Method:** read both repositories' docs, skill inventories, configs, orchestrator/validator scripts, and test suites; ran SDW's suite (`68/68 pass, 4.6 s`). workflow-skills was assessed from its `FEATURES.md`, `CATALOG.md`, package manifest, and 176 test modules (suite not executed).

**Bottom line:** `workflow-skills` is a mature delivery *platform*. SDW is a lean greenfield *kernel*: ~1/24th of the Tier-1 prompt corpus, ~1/8th of the code, a cleaner state model — but today it implements the **skeleton** of the pipeline, not the delivery machinery. The important gaps are four execution primitives, not the 50 missing convenience skills.

---

## 1. At a Glance

| Dimension | workflow-skills | SDW |
|---|---|---|
| Version / phase | `0.5.48`, production, 6+ months of iteration | `0.0.3`, greenfield proof-of-concept |
| Skills | 62 (54 workflow + 8 extra) + `ws-shared` hub | 6 |
| Skill source | `.agents/skills/ws-*` | `skills/sdw-*` |
| Tier-1 corpus (`SKILL.md`) | 445.7 KB · 5,745 lines · avg 93 · max 228 | 18.5 KB · 346 lines · avg 58 · max 61 |
| Scripts | 138 files · 1,682 KB | 18 files · 207 KB |
| Skill docs | 192 Markdown files · 1,233 KB | 17 Markdown files · ~60 KB |
| Tests | 176 test modules; coverage thresholds; installer/remote suites | 68 `node:test` cases in 6 files; 4.6 s |
| Install / distribution | npm CLI, npx, 3 package tiers, global/project, host targets | None (roadmap spec 006) |
| Config surface | ~10 sections, JSON schema, GUI editor | 11 flat keys (5 documented in schema) |
| Pipelines | Standard 0–9, Lite 0–5, batch, distributed baton, fable method, task lifecycle | One 8-step pipeline + batch queue |
| Host support | Cursor, Claude, Codex, Gemini/Antigravity, OpenCode, generic | Harness-agnostic by convention only |
| Runtime deps | Zero (dev-only `c8`) | Zero |

---

## 2. Capability Matrix

Legend: **None** = parity · **Shallow** = exists but materially less deep · **Missing** = absent in SDW · **SDW leads** = simpler/stronger in SDW.

### 2.1 Delivery pipelines

| Capability | workflow-skills | SDW today | Gap |
|---|---|---|---|
| Standard spec→PR pipeline | 0–9 FSM, per-step artifacts, dispatch table | 8-step state machine in one orchestrator | Shallow |
| Lite pipeline | 0–5, isolated state | — | Missing |
| Batch queue | `ws-spec-multi`: complexity routing, child artifacts, state verification | Queue, dry-run, `--continue-on-error`, resume | Shallow |
| Distributed multi-CLI | Step baton, runner templates, leases, coordinator | — | Missing |
| Direct problem solving | `ws-fable-method` 7-step loop | — | Missing |
| Prompt-driven work (non-spec) | `ws-task-lifecycle` | — | Missing |
| Vibe coding / what-next | `ws-megabrain` | — | Missing |
| Host subagent projections | Compiler to Cursor/Claude/generic, drift check | — | Missing |
| Unattended execution | `autoMode` chains 0→9, checkpoint/pause-turn | Batch protocol; no gates to bypass | Shallow |
| Turn-boundary resume | `checkpoint`, `pause-turn`, telemetry | Step state only | Shallow |
| Branch strategy | 4 strategies (`stay`, `from-current`, `from-base`, `prompt`) | `feature/{slug}` only | Shallow |
| Per-task worktrees | Scratch worktrees for fix-pr/fresh-verify | Built into Step 4 (untested path) | SDW leads (design) |
| Parallel-writer safety | Ownership matrix, file locks, foreign-commit guard | — | Missing |

### 2.2 Spec lifecycle

| Capability | workflow-skills | SDW today | Gap |
|---|---|---|---|
| EARS schema + validator | `ws-spec-format` / `validate_spec.cjs` | `sdw-spec` validator (closure, DoR, negative scenarios) | None |
| Free-text spec authoring | `ws-spec-write` + numbering | `sdw-spec new` + numbering | None |
| Tracker import | GitHub + ADO, attachments, visual refs | GitHub + ADO via `gh`/`az` | Shallow |
| Bulk import | `ws-spec-from-provider` | — | Missing |
| Outbound issue creation | `ws-spec-to-issue` | — | Missing |
| Project spec index | `index.PRD`: init, sync, promote, track | `index.specs.md`: init, sync, archive | Shallow |
| Kanban board | `ws-kanvas` (drag-drop, spec viewer) | — | Missing |
| Dual board / manage menu | `ws-spec-list` | `list` only | Shallow |
| Status subfolders / organizer | `ws-spec-organizer`, `plans.statusSubfolders` | — | Missing |
| Spec drift update | `ws-spec-update` | — | Missing |
| Human runbook / explain | `ws-spec-translate-to-human`, `ws-spec-explain` | — | Missing |
| Living feature wiki | `ws-wiki` (init, from-code, sync, verify/apply) | — | Missing |
| Spec closure quality | Out of Scope, Assumptions, DoR, negative tests | Same sections enforced | None |

### 2.3 Quality gates

| Capability | workflow-skills | SDW today | Gap |
|---|---|---|---|
| Evidence-based AC ledger | `ac-ledger.json`, per-AC evidence, tamper-resistant score | Lexical keyword score | Missing |
| Configurable verify bar | `minVerifyScore` default 9 | `scoreMin` default 8 | Shallow |
| Score & refine | Second polish pass + overengineering sweep | — | Missing |
| Fresh independent verify | New worker, fault injection per AC, evidence-or-zero | — | Missing |
| Mutation / regression sabotage | `ws-testing` + `run_sabotage.cjs` | — | Missing |
| Code review loop | Two-phase review, 4-part exploitability proof, fix→re-review | Regex scan; auto-fix only `debugger;` | Shallow |
| Adversarial audit | `ws-fable-judge` (refute claims against diffs) | — | Missing |
| Secrets/PII scan | Dedicated skill, patterns, optional pre-commit hook | Regex scanner, HIGH blocks | Shallow |
| Stack invariants | Rule packs + static scan, caps score at 7 | — | Missing |
| Pre-ship doc sync | Wiki + index + changelog gate | — | Missing |
| Preview dry-run before PR | `ws-preview` reuses consumer command | — | Missing |
| Commit-before-review | G2 gate blocks uncommitted product files | Step 6 commits before Step 7 | None (ordering) |
| Worker liveness watchdog | Marker + baseline + wedge detection | — | Missing |
| State validation before transition | `validate_state.cjs` on every step | `state_manager` transitions | Shallow |
| Delivery gate | `ws-senior-developer` | `sdw-rules` + review rules | Shallow |
| Build/test execution gate | Build, test, coverage, mutation commands | Flags defined; **no test execution** | Missing |

### 2.4 SCM / provider parity

| Capability | workflow-skills | SDW today | Gap |
|---|---|---|---|
| GitHub + Azure parity | 11 named intents, parity test | Fetch/query only | Missing |
| `create-pr` / `merge-pr` | Reuse open PR, wait for checks | PR payload object only | Missing |
| `list-threads` / `resolve-thread` | Structured threads, dry-run | — | Missing |
| CI triage | `check-pr-status`, flake classification | — | Missing |
| `comment-issue` / `close-issue` | Tracker transitions | — | Missing |
| `sweep-prior-work` | Prior PRs + recent commits | — | Missing |
| `create-issue` | Anonymized defect report from monitor | — | Missing |
| Local spec provider | `ws-spec-provider-local` | Local file ingest | None (basic) |
| Remote review polling | Real thread loop | `pollEnabled: true` flag only | Missing |

### 2.5 Memory & knowledge

| Capability | workflow-skills | SDW today | Gap |
|---|---|---|---|
| Local anti-regression memory | `MEMORY.md` + `memory/*.md` | `.sdw/traps.md` | Shallow |
| Path-pattern trap query | `--match-paths` | — | Missing |
| Fail-closed memory compile | Rejects undated / incomplete traps | `log-trap` append only | Shallow |
| Changelog | `ws-changelog` | — | Missing |
| External vault (spec-memo) | `ws-spec-memo` bridge + `ws-memo` runtime | — | Missing |
| Session/prompt tracking | `ws-session-tracking` | — | Missing |
| Domain adapters | `ws-fable-domain` | — | Missing |
| Consumer patterns generator | `ws-patterns-generator` | — | Missing |

### 2.6 Harness, diagnostics & observability

| Capability | workflow-skills | SDW today | Gap |
|---|---|---|---|
| Intent router | `ws-spec-manager` + autoload vocabulary | `sdw-router` scan/route/doctor | SDW leads (cleaner) |
| Install/runtime doctor | `ws-doctor`, `ws-version` | `router doctor`, `rules doctor` | Shallow |
| Harness integrity audit | `ws-check-harness` Phases 0–5c | — | Missing |
| FSM simulation | `ws-check-workflows` (all pipelines) | — | Missing |
| Live monitor / stall detection | `ws-monitor` (transcript follow, open issue) | — | Missing |
| Session harness snapshot | `ws-show-harness` | — | Missing |
| Integrity digests | SHA-256 manifest, verify on install | — | Missing |
| Telemetry | Append-only JSONL + report | — | Missing |
| Dispatch prompt audit | Durable `.prompt.md` + manifest per dispatch | — | Missing |
| Context budgets | 32 KB global, 18 KB floor, per-step overrides | — | Missing |
| Benchmarks | Harness benchmarks + evolution reporting | — | Missing |
| Cleanup / retro | `ws-cleanup`, `ws-retro` | — | Missing |
| Skill authoring protocol | `ws-write-a-skill` | AGENTS.md rules | Shallow |

### 2.7 Reporting & productivity

| Capability | workflow-skills | SDW |
|---|---|---|
| Timesheet / activity report | `ws-activity-report` | — |
| Standup briefing | `ws-pre-daily` (36 h) | — |
| Spec/US panorama | `ws-spec-explain` | — |
| Human runbook | `ws-spec-translate-to-human` | — |
| Kanban | `ws-kanvas` | — |
| Vibe-coding menu | `ws-megabrain` | — |

### 2.8 Distribution & configuration

| Capability | workflow-skills | SDW |
|---|---|---|
| npm package + CLI | `bin/cli.js`, `npx github:...` | None |
| Install / update / uninstall | Yes, dependency closure, cascade | None |
| Package tiers | Full / Workflows / Extra | None |
| Global vs project scope | Yes, local overrides global | None |
| Host targets | canonical, Claude, Codex, Gemini/Antigravity | None |
| SHA-256 integrity | Sign, verify, fail closed | None |
| Self-overwrite guard | Blocks install into source repo | None |
| Config GUI editor | WinForms desktop editor | None |
| Docs site / wiki | Generated catalog + static wiki | None |
| Zero runtime dependencies | Yes | Yes |
| Config schema completeness | Full schema + validation + GUI | 11 keys used; 5 in schema |

### 2.9 Engineering architecture

| Capability | workflow-skills | SDW |
|---|---|---|
| 3-tier progressive disclosure | Yes (Tier 1/2/3) | Yes (cleaner, enforced) |
| Tier-1 line budget | ~228 max, not uniformly enforced | 51–61, strongly enforced |
| Transactional run state | JSON + Markdown dual-write, revision, index | JSON only |
| Checkpoint tags | `uswf/{id}/before-step-N` | — |
| Run-state isolation | Per-workflow ID, batch run folders | Per-run JSON |
| Context fencing | Bounded subagent contracts + plan slices | Task prompt strings |
| Concurrency contract | Ownership matrix + locks | — |
| Test portability | Windows/macOS/Linux, install fixtures | Windows/macOS/Linux (Node APIs) |
| Test volume | 176 modules | 68 cases |

---

## 3. Depth Check — What SDW Actually Executes Today

This is the most important section: FEATURES/README describe the *intended* pipeline, but several stages are scaffolds.

| Stage | Claimed behavior | Reality in code | Impact |
|---|---|---|---|
| 1. Derivation | Reformulates human spec; skips if ready | Template wrapper; derived text kept **in memory** and never written to disk | Source spec stays human-formatted |
| 2. Grilling | Decision-tree walk, user gate, refined spec | 4 regex dimensions; inserts defaults into an in-memory copy; never persists refined spec | Decisions are not auditable |
| 3. DAG | Complexity analysis → atomic units | 1 task, or 2 tasks split by AC count/touchpoints; target files hardcoded to SDW's own skills | Not general-purpose decomposition |
| 4. Implementation | Context-fenced subagent dispatch | Prints task prompts; creates worktrees but **runs no implementation**; no subagent API | Nothing is built by the orchestrator |
| 5. Scoring | Diff/AC conformance 0–10 | Keyword coverage ≥40% across diff + touched files + current tree | False positives; score is not evidence |
| 6. Delivery commit | Atomic structured commit | Real `git add -A` + commit | Works (but stages everything) |
| 7. Review | Coding standards, invariants, security, regressions | Regex scan (Python in skills, `debugger`, `TODO`, secret filenames); auto-fix only `debugger;` | Not a code review |
| 8. PR | Create/update PR, resolve threads | Builds a PR payload object, optional `git push`; no `gh`/`az` PR call; poll flag is a no-op | No PR is created |

Additional verified gaps:

- `runAllTests` and `requiredBuild` are **defined and validated but never read** by the orchestrator — no `npm test` execution despite the skill claim.
- `scmCodeReviewEnabled` only sets `prPayload.pollEnabled = true`; no polling loop exists.
- The conformance evaluator can include the spec file itself in the haystack, so an AC can "pass" on its own wording.
- The config schema documents 5 keys; the loader validates 11. `securityChecksEnabled`, `useWorktrees`, `useFeatureBranches`, `pushDelivery`, `requiredBuild`, `runAllTests` are absent from `config.schema.json`.
- `AGENTS.md` §4 still references `skills/ws-spec-format/scripts/validate_spec.cjs` — a leftover from workflow-skills; the real path is `skills/sdw-spec/scripts/validate_spec.cjs`.

None of this invalidates the architecture — but the report should distinguish **designed** from **delivered**.

---

## 4. Where SDW Genuinely Leads

| Area | Evidence |
|---|---|
| Prompt economy | 18.5 KB Tier-1 corpus vs 445.7 KB (~24× smaller); every `SKILL.md` 51–61 lines |
| Code economy | 207 KB scripts vs 1,682 KB (~8× smaller); 37 files vs 330+ |
| Cognitive simplicity | 6 skills, 1 pipeline, 11 config keys vs 62 skills, 4 pipelines, 10 config sections |
| Router quality | Explicit invocation, keyword confidence, tie-breaking gate, clean pass-through, doctor |
| Test speed | 68 cases in 4.6 s vs a 176-module suite with installer/remote variants |
| State isolation | Clean per-run `{runId}.state.json`; no dual-write complexity |
| Batch protocol | Explicit unattended contract with dry-run, pre-flight disk validation, resume |
| Worktree design | Per-task worktrees + cherry-pick integration is first-class (but unexercised) |
| Spec closure | DoR, Out of Scope, Assumptions, negative-test content enforced at authoring time |
| Zero sediment | No legacy shims, no backward-compat branching, no vendor coupling |

---

## 5. Gap Priorities

### P0 — adoption blockers (without these, SDW cannot deliver)

| # | Gap | Why it blocks | Maps to |
|---|---|---|---|
| 1 | Installer / packaging | Consumers cannot adopt; no `npx`, no update path | Spec 006 |
| 2 | Real implementation dispatch (Step 4) | Orchestrator cannot build anything | New spec |
| 3 | SCM intents (create PR, comment, close, threads, merge) | Pipeline stops at local commit | Spec 012 |
| 4 | Evidence-based verification (AC ledger) | Current score is lexical and gameable | New spec |
| 5 | Build/test execution gate | Claims tests pass without running them | New spec |

### P1 — quality and continuity

| # | Gap | Maps to |
|---|---|---|
| 6 | Persist refined spec + per-step artifacts | Spec 014 |
| 7 | Memory skill / trap retrieval | Spec 007 |
| 8 | Fresh independent verify + adversarial audit | New spec |
| 9 | Config schema alignment (11 keys) | Quick fix |
| 10 | Turn-boundary checkpoint / resume hardening | New spec |
| 11 | Branch strategy options beyond `feature/{slug}` | Spec 010 (partial) |

### P2 — ecosystem and observability

| # | Gap | Recommendation |
|---|---|---|
| 12 | Live monitor / telemetry | Adopt a slim `sdw-monitor` |
| 13 | Doctor + harness audit + FSM simulation | Adopt simplified `doctor`/`check` |
| 14 | Activity/standup/explain reporting | Optional, consumer-driven |
| 15 | Wiki / kanban / dual board | Defer; high surface, low core value |
| 16 | Multi-host subagent projection | Defer until installer exists |
| 17 | Distributed multi-CLI baton | Skip — complexity not justified yet |
| 18 | Benchmark suite / GUI editor / 3 package tiers | Skip |

---

## 6. Adopt / Adapt / Skip

| Decision | Features |
|---|---|
| **Adopt** | Installer + integrity, AC ledger, provider intents, memory vault bridge, doctor, context budgets, prompt audit, daily/weekly reporting (light) |
| **Adapt** | Quality gates (keep fail-closed, drop 10-gate ceremony), config (keep flat, complete schema), monitor (state + telemetry only), subagent projection (single generic compiler) |
| **Skip for now** | Distributed baton, kanban, wiki, benchmarks, GUI editor, three package tiers, retro, megabrain, fable domain adapters |
| **Never copy** | Feature parity for its own sake; 62-skill granularity; dual-write state; per-step prompt prose sediment |

---

## 7. Shared DNA (Don't Re-Learn)

Both projects already agree on the fundamentals, which is why SDW can stay small:

- Spec is the contract of record; plans are run artifacts.
- EARS acceptance criteria + closure tables + negative tests.
- Fail-closed gates; no shipping on the agent's word.
- Node 22 CJS helpers, zero runtime dependencies, Windows/POSIX paths.
- Harness-agnostic skills, progressive disclosure, explicit launchers.
- Anti-regression memory and surgical diff discipline.
- GitHub/Azure as interchangeable backends (SDW: import only so far).

The rework's thesis is sound. The risk is mistaking a **clean kernel** for a **finished product**: `workflow-skills` earned its 62 skills through production friction. SDW should port the *four execution primitives* first and let the convenience surface grow only when a consumer asks for it.
