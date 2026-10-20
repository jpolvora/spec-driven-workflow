# ✨ Spec-Driven Workflow (SDW) — Feature Showcase

> **The next-generation, deterministic framework empowering frontier AI agents to specify, build, verify, and deliver production software.**

---

## 🌟 Executive Summary

**Spec-Driven Workflow (SDW)** re-architects how engineering teams build software alongside autonomous coding agents. By replacing fragile, monolithic prompt instructions with compact state machines, progressive disclosure, and deterministic verification anchors, SDW delivers **dramatically faster turnaround times**, **unprecedented token efficiency**, and **guaranteed delivery quality**.

---

## ⚡ Core Value Proposition

| Pillar | Traditional Agent Frameworks | Spec-Driven Workflow (SDW) |
|---|---|---|
| **Context Window Overhead** | 3,000–10,000 tokens consumed on every turn by monolithic prompts | **≤ 120 lines** of Tier 1 dispatch rules, freeing 95%+ of context for code |
| **Execution Determinism** | Stochastic, unpredictable prompt suggestions | Empirical exit criteria (`Done when:`), automated tests, and strict scoring gates |
| **Agent / Harness Support** | Locked into proprietary harnesses or vendor-specific IDEs | **100% Agent & Harness Agnostic** (Antigravity, Cursor, Claude Code, OpenCode, Codex, CLI) |
| **Runtime Dependencies** | Heavy npm dependency trees and fragile Python wrappers | **Zero runtime npm dependencies** — pure Node.js 22 CommonJS standard library |
| **Quality Assurance** | "Looks good to me" subjective completions | **Quantitative Conformance Scoring (0–10)** with automated re-implementation feedback loops |

---

## 🚀 Implemented Capabilities & Subsystems

### 1. 🧭 `sdw-router` — Intelligent Autoload & Intent Traffic Controller

*The lightweight front door for every developer session, routing prompts with surgical precision.*

- **Ultra-Lean Context Footprint:** Tier 1 `SKILL.md` stays strictly under 120 lines, activating instantly upon session intake with zero prompt bloat.
- **Dual-Location Discovery:** Automatically discovers available skills in both active development environments (`skills/`) and portable consumer installations (`.agents/skills/`).
- **Intent-Driven Dispatch:** High-precision semantic keyword mapping analyzes user intent and routes execution seamlessly to `sdw-config`, `sdw-spec`, or `sdw-orch`.
- **Direct Invocation Support:** Honors explicit invocations (`/sdw-*`, `@sdw-*`) immediately with priority over heuristic scoring.
- **Tied-Confidence Disambiguation:** When prompts contain conflicting or equally weighted terms, the router initiates a structured clarification gate with pre-computed options and a recommended default.
- **Passive Non-Interference:** Generic coding prompts (e.g. styling, refactorings, script tweaks) pass through cleanly without interception.
- **Built-In Doctor Audit:** Self-diagnostic health checks detect missing skill directories, unreadable `SKILL.md` files, or broken references with actionable resolution errors.

---

### 2. 📋 `sdw-spec` — Enterprise Specification Lifecycle Engine

*From back-of-the-napkin ideas to crystal-clear, machine-executable specifications.*

- **EARS Acceptance Criteria Standard:** Enforces Easy Approach to Requirements Syntax (EARS) patterns (*Ubiquitous, Event-driven, State-driven, Optional-feature, Unwanted-behavior*) for bulletproof criteria.
- **Free-Text Spec Synthesis (`new`):** Transforms conversational human requirements into canonical, structured specifications with automatic 3-digit numbering (`NNN-{slug}.md`).
- **Unified SCM Tracker Importer (`import`):** Directly pulls issues and work items from GitHub Issues and Azure DevOps Boards via an agnostic SCM provider contract.
- **Central PRD Registry (`index.specs.md`):** Maintains a synchronized ledger of all project specifications, tracking lifecycle status (`pending`, `completed`, `archived`) and validation health.
- **Automated Validation Gates (`validate`):** Authoring-mode validator enforces YAML frontmatter, strict section hierarchy, and negative failure scenario requirements.
- **Live State Reconciliation (`sync`):** Automatically reconciles `index.specs.md` with active on-disk specifications and orchestrator run states.
- **Lifecycle Archiving (`archive`):** Safely retires completed specifications while guarding against unauthorized execution of legacy features.

---

### 3. 🎯 `sdw-orch` — Autonomous End-to-End Delivery Orchestrator

*Coordinating autonomous agent pipelines from initial spec ingestion to verified delivery git commits and pull requests.*

- **8-Stage Autonomous Pipeline:**
  1. **Spec Ingestion & Agentic Derivation:** Translates human requirements into agent-ready specifications (auto-skips if already formatted).
  2. **Grilling Round & Gap Elimination:** Exhaustively walks decision trees for input bounds, failure recovery, and state persistence, querying the user only when ambiguous decision gaps arise.
  3. **Complexity Analysis & DAG Task Decomposition:** Evaluates touchpoints (CLI, state, VCS, PR, UI) to generate Directed Acyclic Graph execution units.
  4. **Sequential Subagent Dispatch & Evidence Gate:** Dispatches exactly one DAG task at a time. `subagent` mode (default) emits a self-sufficient brief per task — verbatim criteria, scope fence, prohibitions, dependency context, honest evidence template, report contract — and the host agent runs one worker per envelope; `command` mode runs a configured subprocess per task. `task next` / `task finish` / `task abandon` enforce ordering and single-flight execution, evidence carries a required `status`, corroboration is anchored to a hash baseline captured at dispatch, and build/test gates run once every task is accepted.
  5. **LLM-Judge Conformance Scoring (0–10):** Delegates scoring to an LLM judge fenced to the acceptance criteria plus the generated diff (never transcripts). Per-criterion verdicts drive `round(verified / total * 10)`; `scoring.judgeCriticity` selects permissive, strict, or perfectionist review; the judge runs through `scoring.judgeCommand` or the current agent model via `score submit`. Fails closed on zero criteria, an unavailable judge, or a malformed verdict, and triggers the re-implementation loop below `scoreMin`.
  6. **Delivery Commit Quality Guard:** Refuses delivery commits if Step 4 is incomplete, any task unaccepted, or any gate failed. Stages and creates structured delivery git commits (`feat(...)`).
  7. **Automated SCM Code Review Loop:** Inspects committed diffs for forbidden scripts, credential leaks, active debugger statements, and unresolved TODOs, applying auto-fixes iteratively.
  8. **PR Packaging & Remote Publishing:** Compiles PR payloads, updates the specification index to `completed`, and pushes delivery branches to remote origins.
- **Task Dispatch Subcommands (`task next`, `task finish`, `task abandon`):** Enforces exactly one in-flight task, renders a complete worker brief per dispatch, rejects out-of-order completion, releases a lost worker's task back to the queue with a recorded reason, and corroborates changes against a hash baseline captured at dispatch so inherited edits never count.
- **Run State Isolation & Resumption:** Persists active run state in `.sdw/state/{runId}.state.json`, enabling seamless pauses, status inspections, and one-click resumption from interrupted steps.
- **Configurable Feature Branches & Task Worktrees:** Opt-in branch and worktree isolation (`useFeatureBranches: false`, `useWorktrees: false`). Derives feature branches from spec slugs (`feature/{slug}`), refuses activation on dirty trees, reuses existing branches safely, dispatches multi-task DAGs into isolated git worktrees (`.sdw/worktrees/{runId}/{taskId}`), integrates worktree changes via linear cherry-pick, safely cleans worktrees, and supports runtime CLI overrides (`--no-worktrees`, `--no-feature-branch`).
- **Multi-Specification Batch Queue Execution:** Enqueue and sequentially execute multiple specifications (`sdw-orch run spec1 spec2 ...`) with strict context fencing, batch manifest tracking (`.sdw/state/batch-{id}.json`), failure policies (`--continue-on-error`), dry-run pre-flight validation (`--dry-run`), automated resumption (`resume-batch`), batch queue pause on dispatch (exit code 4), and **enforced unattended execution** that runs continuously through all queued specifications without intermediate conversational interruption.

---

### 4. ⚙️ `sdw-config` — Workspace Configuration & Governance

*Zero-config defaults paired with enterprise-grade customization.*

- **Automated Workspace Scaffolding (`init`):** Bootstraps consumer repositories with canonical `.sdw/` directory trees, baseline `config.json`, and directory documentation.
- **Dynamic Token Resolution (`parse`):** Seamlessly substitutes environment tokens (such as `{projectRoot}`) across paths on Windows and POSIX systems.
- **JSON Schema Validation Gate (`check`):** Validates workspace configuration against `config.schema.json` to prevent invalid configurations from halting agent workflows.
- **Extensible Governance & SCM Provider Selection:** Centralizes scoring thresholds (`scoreMin`), remote code review flags (`scmCodeReviewEnabled`), branch push behaviors (`pushDelivery`), feature branches (`useFeatureBranches`), task worktrees (`useWorktrees`), security checks (`securityChecksEnabled`), and explicit SCM provider routing (`scmProvider`: `none` | `ado` | `github`) with fail-safe disable modes and CLI capability verification in `check`.

---

### 5. 📏 `sdw-rules` — Shared Behavioral Rules, Simplicity & Anti-Overengineering

*Canonical engineering discipline codifying simplicity first, surgical scope enclosure, and anti-regression traps.*

- **Ultra-Lean Context Budget:** Compact Tier 1 `SKILL.md` (≤ 80 lines) codifies the 4 core pillars with an announcement banner and zero prompt bloat.
- **Think & Ask Before Acting:** Prohibits silent scope expansion. When architectural opportunities arise, halts and presents an interactive clarification gate (`ask_question`), defaulting to minimal scope.
- **Simplicity First (YAGNI):** Enforces writing minimum code required to satisfy ACs. Explicitly rejects speculative abstractions, complex class registries, and unused helper modules.
- **Surgical Diff Hygiene:** Restricts modifications strictly to files and lines required by the current task, prohibiting adjacent reformatting or unnecessary refactoring.
- **Empirical Goal-Driven Verification:** Directs multi-step tasks to define clear, verifiable success criteria and tests before declaring completion.
- **Deterministic Compliance Doctor (`doctor`):** Audits installed skills for context line budgets (≤ 120 lines) and cross-references from downstream core skills (`sdw-spec`, `sdw-orch`).
- **Specification Scope Auditor (`audit-spec`):** Scans specifications for speculative scope creep markers, composite ACs, or missing Out of Scope boundaries.
- **Anti-Regression Trap Log (`log-trap`):** Appends verified friction and overengineering lessons to `.sdw/traps.md` at project scope to prevent repeating mistakes.

---

### 6. 🚢 `sdw-ship-pr` — Standalone Delivery, SCM Submission & Review Convergence

*End-to-end PR shipping, pre-PR requirement checks, remote publishing, and automated review convergence.*

- **Standalone & Delegated Invocation:** Directly invokable standalone (`node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` / `/sdw-ship-pr`) with dedicated subcommands (`ship`, `list-threads`, `resolve-thread`, `check-status`), or delegated by `sdw-orch` Step 8.
- **Pre-PR Quality Verification Gates:** Evaluates `prePrInstructions`, `prePrCommand`, `requiredBuild`, `runAllTests`, and `securityChecksEnabled` from `.sdw/config.json`.
- **Remote Branch Publishing:** Synchronizes the active branch to remote origin (`pushDelivery: true` or `--push`).
- **Unified SCM PR Creation & Idempotency:** Agnostically creates or reuses open PRs for GitHub and Azure DevOps, or cleanly bypasses remote submission when `scmProvider: "none"`.
- **Cooperative & Proactive Review Convergence:** Enforces a strict 8-step lifecycle (wait review/CI finish → check active threads → fetch all → cooperative defect class fix across sibling files → test verification → commit → push → close related threads).
- **Push-Before-Resolve Mandate & Resolution Comment Contract:** Guarantees threads are never closed before the fix commit is pushed to the remote tracking branch. Posts a structured resolution reply comment citing the commit SHA, defect class, and fix summary.
- **Zero-Mutation Dry-Run Simulation:** Simulates pre-PR checks, branch push, PR creation, and review polling without remote mutations when `--dry-run` is active.

---

### 7. 🔒 `sdw-security-checks` — Configurable Pre-Commit Secrets & Leak Gate

*Deterministic, zero-dependency secret detection and leak prevention guarding against credential leaks before git commits.*

- **Zero External Runtime Dependencies:** Pure Node.js 22 standard library regex scanner over git inventories; no `ripgrep` or external binary required.
- **Configurable Workflow Gate (`securityChecksEnabled`):** Opt-in via `.sdw/config.json`. When enabled, enforces pre-commit inspections at delivery commit (Step 6) and review-fix commit (Step 7).
- **Confidence Model & Fail-Closed Semantics:** HIGH findings (API keys, AWS credentials, Slack tokens, private keys, database passwords, `.env` files) block commits; MEDIUM findings warn; scanner failures fail closed.
- **Redacted Audit Reporting:** Findings report file path, line number, pattern type, and severity without exposing raw secret values in output or logs.
- **Suppression & Bypass Pragma:** False-positive suppression via `# pragma: allowlist secret` and auditable operator bypass via `--skip-security` recorded in run state.

---

### 8. 🛡️ Orchestrator Refinement & Pre-PR Quality Gates

*Consolidated technical planning and ironclad repository-level quality gates before PR publication.*

- **Refinement Phase (Grilling + Technical Planning):** Step 2 merges adversarial decision gap analysis with constructive technical planning, producing a structured technical blueprint (`targetFiles`, `architecturalApproach`, `testPlan`) directly ingested by Step 3 DAG generation.
- **Configurable Pre-PR Quality Gates (`requiredBuild`, `runAllTests`):** Opt-in build verification (`buildCommand`, default `npm run build`) and full test execution pass (`testCommand`, default `npm test`) executed as mandatory prerequisites in Step 8 before remote push or PR creation.
- **Automated Surgical Fix Loop:** Autonomous remediation loop (up to 3 iterations) resolving build or test regressions with mandatory pre-commit secret leak checks before each fix commit.
- **Project Pre-PR Lifecycle Hook:** Support for project-specific instructions (`prePrInstructions`) and automation commands (`prePrCommand`) for semantic version bumping, changelog updates, and documentation synchronization.

---

### 9. 📜 Human-Auditable Step Artifacts Persistence

*Deterministic side-effect persistence capturing intermediate reasoning, task graphs, and verification evidence.*

- **Human-Auditable Evidence:** Steps 2, 3, 5, and 7 automatically persist structured Markdown artifacts under `.sdw/state/{slug}/{runId}/`, providing transparency without altering pipeline execution semantics.
- **Step 2 (Refinement Artifact `{slug}-step-2.md`):** Records detected decision gaps, resolutions applied per gap, the decision tree walk summary, and the full refined specification snapshot.
- **Step 3 (DAG Generation Artifact `{slug}-step-3.md`):** Documents complexity analysis, task decomposition (dependencies, covered acceptance criteria, target files), and context-fenced task prompts.
- **Step 5 (Scoring Artifact `{slug}-step-5.md`):** Summarizes implementation touched files, quantitative conformance score breakdown, verified criteria table, failing criteria table, and evaluator feedback.
- **Step 7 (Delegated Review Artifact `{slug}-step-7.md`):** The `sdw-code-review` Markdown fix-plan report (header, findings table, detailed findings, executable fix plan) written via `--report`.
- **State Linkage & Best-Effort Resilience:** The run state records `artifactsDir` and per-step `artifact` paths. Failures in artifact generation log warnings and record errors without halting delivery execution.

---

### 10. 🧪 Battle-Tested Quality & Zero-Flake Test Suite

*Engineering rigor backed by 100% native automated tests.*

- **Native Node.js Test Runner:** Built with `node:test` and `node:assert/strict` — zero third-party testing frameworks required.
- **166 Comprehensive Test Scenarios:**
  - `sdw_code_review.test.cjs`: Standalone execution, base auto-detection, report generation, surgical auto-fix, dry-run simulation, orchestrator delegation, router registration, and fail-closed negatives.
  - `sdw_config.test.cjs`: Configuration parsing, schema validation, token expansion, and initialization gates.
  - `sdw_spec.test.cjs`: Index bootstrapping, EARS validation, synthesis, SCM provider contract, state synchronization, and archival quality gates.
  - `sdw_orch.test.cjs`: State machine transitions, derivation, grilling decision trees, DAG decomposition, scoring gates, code review auto-fixing, remote push publishing, and unattended multi-spec batch queue execution.
  - `sdw_ship_pr.test.cjs`: Standalone PR shipping, dry-run simulation, pre-PR requirement checks, review convergence with summary comments, and orchestrator delegation.
  - `sdw_refinement_gates.test.cjs`: Step 2 Refinement state machine naming, technical blueprint ingestion into Step 3, config schema validation, build and test quality gates, automated fix retry loops, and pre-PR lifecycle hooks.
  - `sdw_step_artifacts.test.cjs`: Intermediate step artifact persistence (steps 2, 3, 5), directory isolation (`.sdw/state/{slug}/{runId}/`), run state linkage, deterministic overwrite on re-execution, and resilient failure handling.
  - `sdw_branch_worktree.test.cjs`: Feature branch lifecycle, dirty tree refusal, branch reuse, worktree creation/cleanup, cherry-pick integration, and runtime overrides.
  - `sdw_scm_provider.test.cjs`: SCM provider resolution, capability checks, safe disable modes, strict CLI isolation (`gh` vs `az`), and orchestrator polling integration.
  - `sdw_router.test.cjs`: Minimal context budget enforcement (SKILL.md ≤ 120 lines), explicit invocations, keyword classification, tied-confidence disambiguation, missing directory resolution, and pass-through non-interference.
  - `sdw_rules.test.cjs`: Three-tier progressive disclosure, announcement banners, Karpathy simplicity principles, doctor compliance verification, scope creep audits, and trap logging.
  - `sdw_security_checks.test.cjs`: Secrets scanning, staged diff inspection, redaction hygiene, pragma suppression, fail-closed gate handling, and orchestrator bypass verification.
- **Sub-Second Execution:** Entire test suite runs in ~5 seconds with 100% pass rate.

---

### 11. 🤖 GitHub Actions CI/CD, Agentic Code Review & Skills Distribution

*Zero-dependency CI verification, fork-resilient agentic PR reviews, and vendor-neutral skills distribution.*

- **Continuous Integration (`ci.yml`):** Automatically validates all specifications in `.sdw/specs/` in authoring mode, runs the zero-dependency unit test suite (`npm test`), and verifies skill packaging integrity (`scripts/verify_skills.cjs` when present) on pull requests and pushes to `main` and `develop`.
- **Agentic Code Review (`agentic-code-review.yml`):** Runs the `agentic-code-reviewers` engine against the PR diff using configurable repository Variables (`SDW_CODE_REVIEW_ENGINE`, `SDW_CODE_REVIEW_MODEL`, `SDW_CODE_REVIEW_VARIANT`).
- **Fork Safety & Credential Graceful Degradation:** When required secrets (`OPENCODE_API_KEY` or `CURSOR_API_KEY`) are missing (fork PRs or fresh clones), emits a standardized informational notice and exits cleanly with code `0` without failing PR checks.
- **Unresolved Thread Merge Block:** Queries active GraphQL review threads (`pullRequest.reviewThreads`) and blocks merge until all reviewer comments have been addressed or resolved.
- **SDW Review Prompt Contract (`.github/agentic-code-reviewers-prompt.md`):** Custom stack prompt encoding EARS conformance, Tier 1 line budgets (≤ ~120 lines), zero external runtime dependencies, agent and harness agnosticism, and breaking-changes policies.
- **Local Review Dry Run (`npm run review:dry`):** Reproduces the CI reviewer locally against the current branch (`develop` → `master`) with the Custom stack prompt, a pinned `opencode-ai@1.19.1` dev dependency, the OS `OPENCODE_API_KEY` through the `opencode-go` provider, and `--dry-run` so no PR threads are created.
- **Safe Review Convergence:** `sdw-ship-pr` waits between rounds (`--poll-interval`, default 20s) and refuses to resolve active review threads unless a `reviewFixCommand` or `threadFixer` applied and verified a fix; unresolved threads are reported as `review_pending`. Concurrent pushes during polling are adapted to, not halted on: superseded CI checks are waited out and the convergence window resets up to `--max-preemptions` (default 3).
- **Skills Distribution (`release.yml`):** Triggers on semantic version tags (`v*.*.*`) or manual dispatch (`verify_only`), repeating validation and tests before creating a GitHub release without build artifacts, keeping skills directly consumable via `npx skills`.

### 12. 🔍 `sdw-code-review` — Standalone Deep Review, Fix Planning & Orchestrator Delegation

*Lean, harness-agnostic working-tree code reviewer that doubles as the `sdw-orch` Step 7 authority.*

- **Standalone & User-Invocable:** Directly runnable at any time (`node skills/sdw-code-review/scripts/sdw_code_review.cjs run|fix|doctor` / `/sdw-code-review`), or dispatched as a subagent/CLI runner under `sdw-orch` Step 7.
- **Auto-Detected Base & Full-Tree Scope:** Resolves the comparison target via explicit `--base`, config `baseBranch`, tracking remotes (`origin/main|master`), local branches, merge-base, or initial commit; inspects committed (`base..HEAD`) plus uncommitted (staged, unstaged, untracked) diffs.
- **Karpathy-Grounded Rules:** Enforces simplicity first (YAGNI, surgical scope, no speculative generality) and syntax hygiene (active `debugger`, unresolved TODOs, committed secrets, sensitive filenames) with Fowler-baseline smells (oversized diffs).
- **Executable Report Contract:** Emits a Markdown fix plan (header, findings table, detailed hunks, ordered checklist) plus structured JSON (`passed`, `errorCount`, `warningCount`, `suggestionCount`, `findings` with stable `CR-001` IDs, severity, `file:line`, rule, and fix prescription).
- **Surgical Auto-Fix & Dry-Run:** Applies minimal fixes (debugger removal) up to the iteration ceiling (default 3); `--dry-run` reports planned fixes without touching disk; blocking residuals exit non-zero.
- **Orchestrator Delegation:** `sdw-orch` Step 7 holds no duplicated review logic — it dispatches the CLI, parses JSON, gates fix commits through `sdw-security-checks`, and persists `{slug}-step-7.md`.

---

## 🗺️ Product Roadmap & Upcoming Horizons

The following specifications are scheduled for upcoming execution phases:

- **006 — Packaging & Vercel Skills Compatibility:** Standalone npm packaging, one-command installer, and seamless distribution across `.agents/skills/`.
- **007 — SDW Memory Skill:** Integrated anti-regression project memory and vault trap retrieval.

