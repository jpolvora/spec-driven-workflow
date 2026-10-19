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
  4. **Context-Fenced Subagent Dispatch:** Prepares isolated prompts for subagents, preventing transcript drift and context pollution.
  5. **Quantitative Conformance Scoring (0–10):** Measures actual git diffs and touched files against required acceptance criteria. If score < threshold (default 8/10), automatically triggers a feedback re-implementation loop.
  6. **Atomic Delivery Commit:** Automatically stages and creates structured, conventional delivery git commits (`feat(...)`).
  7. **Automated SCM Code Review Loop:** Inspects committed diffs for forbidden scripts, credential leaks, active debugger statements, and unresolved TODOs, applying auto-fixes iteratively.
  8. **PR Packaging & Remote Publishing:** Compiles PR payloads, updates the specification index to `completed`, and pushes delivery branches to remote origins.
- **Run State Isolation & Resumption:** Persists active run state in `.sdw/state/{runId}.state.json`, enabling seamless pauses, status inspections, and one-click resumption from interrupted steps.
- **Configurable Feature Branches & Task Worktrees:** Opt-in branch and worktree isolation (`useFeatureBranches: false`, `useWorktrees: false`). Derives feature branches from spec slugs (`feature/{slug}`), refuses activation on dirty trees, reuses existing branches safely, dispatches multi-task DAGs into isolated git worktrees (`.sdw/worktrees/{runId}/{taskId}`), integrates worktree changes via linear cherry-pick, safely cleans worktrees, and supports runtime CLI overrides (`--no-worktrees`, `--no-feature-branch`).
- **Multi-Specification Batch Queue Execution:** Enqueue and sequentially execute multiple specifications (`sdw-orch run spec1 spec2 ...`) with strict context fencing, batch manifest tracking (`.sdw/state/batch-{id}.json`), failure policies (`--continue-on-error`), dry-run pre-flight validation (`--dry-run`), automated resumption (`resume-batch`), and **enforced unattended execution** that runs continuously through all queued specifications without intermediate conversational interruption.

---

### 4. ⚙️ `sdw-config` — Workspace Configuration & Governance

*Zero-config defaults paired with enterprise-grade customization.*

- **Automated Workspace Scaffolding (`init`):** Bootstraps consumer repositories with canonical `.sdw/` directory trees, baseline `config.json`, and directory documentation.
- **Dynamic Token Resolution (`parse`):** Seamlessly substitutes environment tokens (such as `{projectRoot}`) across paths on Windows and POSIX systems.
- **JSON Schema Validation Gate (`check`):** Validates workspace configuration against `config.schema.json` to prevent invalid configurations from halting agent workflows.
- **Extensible Governance:** Centralizes scoring thresholds (`scoreMin`), remote code review flags (`scmCodeReviewEnabled`), branch push behaviors (`pushDelivery`), and specs directories.

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

### 6. 🔒 `sdw-security-checks` — Configurable Pre-Commit Secrets & Leak Gate

*Deterministic, zero-dependency secret detection and leak prevention guarding against credential leaks before git commits.*

- **Zero External Runtime Dependencies:** Pure Node.js 22 standard library regex scanner over git inventories; no `ripgrep` or external binary required.
- **Configurable Workflow Gate (`securityChecksEnabled`):** Opt-in via `.sdw/config.json`. When enabled, enforces pre-commit inspections at delivery commit (Step 6) and review-fix commit (Step 7).
- **Confidence Model & Fail-Closed Semantics:** HIGH findings (API keys, AWS credentials, Slack tokens, private keys, database passwords, `.env` files) block commits; MEDIUM findings warn; scanner failures fail closed.
- **Redacted Audit Reporting:** Findings report file path, line number, pattern type, and severity without exposing raw secret values in output or logs.
- **Suppression & Bypass Pragma:** False-positive suppression via `# pragma: allowlist secret` and auditable operator bypass via `--skip-security` recorded in run state.

---

### 7. 🧪 Battle-Tested Quality & Zero-Flake Test Suite

*Engineering rigor backed by 100% native automated tests.*

- **Native Node.js Test Runner:** Built with `node:test` and `node:assert/strict` — zero third-party testing frameworks required.
- **77 Comprehensive Test Scenarios:**
  - `sdw_config.test.cjs`: Configuration parsing, schema validation, token expansion, and initialization gates.
  - `sdw_spec.test.cjs`: Index bootstrapping, EARS validation, synthesis, SCM provider contract, state synchronization, and archival quality gates.
  - `sdw_orch.test.cjs`: State machine transitions, derivation, grilling decision trees, DAG decomposition, scoring gates, code review auto-fixing, remote push publishing, and unattended multi-spec batch queue execution.
  - `sdw_branch_worktree.test.cjs`: Feature branch lifecycle, dirty tree refusal, branch reuse, worktree creation/cleanup, cherry-pick integration, and runtime overrides.
  - `sdw_router.test.cjs`: Minimal context budget enforcement (SKILL.md ≤ 120 lines), explicit invocations, keyword classification, tied-confidence disambiguation, missing directory resolution, and pass-through non-interference.
  - `sdw_rules.test.cjs`: Three-tier progressive disclosure, announcement banners, Karpathy simplicity principles, doctor compliance verification, scope creep audits, and trap logging.
  - `sdw_security_checks.test.cjs`: Secrets scanning, staged diff inspection, redaction hygiene, pragma suppression, fail-closed gate handling, and orchestrator bypass verification.
- **Sub-Second Execution:** Entire test suite runs in ~5 seconds with 100% pass rate.

---

## 🗺️ Product Roadmap & Upcoming Horizons

The following specifications are scheduled for upcoming execution phases:

- **006 — Packaging & Vercel Skills Compatibility:** Standalone npm packaging, one-command installer, and seamless distribution across `.agents/skills/`.
- **007 — SDW Memory Skill:** Integrated anti-regression project memory and vault trap retrieval.
- **011 — GitHub Actions CI/CD Integration:** Automated workflow runs, agentic PR reviews, and skill distribution pipelines.
- **012 — SCM Provider Selection:** Granular GitHub / Azure DevOps routing with fail-safe disable modes.
- **013 — Refinement Step & Pre-PR Gates:** Refinement step merging grilling with technical planning, build/test gates, and pre-PR lifecycle hooks.
- **014 — Step Artifacts Persistence:** Per-step human-auditable markdown artifacts persistence under `{stateDir}/{slug}/{runId}/`.
