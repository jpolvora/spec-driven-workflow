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

---

### 4. ⚙️ `sdw-config` — Workspace Configuration & Governance

*Zero-config defaults paired with enterprise-grade customization.*

- **Automated Workspace Scaffolding (`init`):** Bootstraps consumer repositories with canonical `.sdw/` directory trees, baseline `config.json`, and directory documentation.
- **Dynamic Token Resolution (`parse`):** Seamlessly substitutes environment tokens (such as `{projectRoot}`) across paths on Windows and POSIX systems.
- **JSON Schema Validation Gate (`check`):** Validates workspace configuration against `config.schema.json` to prevent invalid configurations from halting agent workflows.
- **Extensible Governance:** Centralizes scoring thresholds (`scoreMin`), remote code review flags (`scmCodeReviewEnabled`), branch push behaviors (`pushDelivery`), and specs directories.

---

### 5. 🧪 Battle-Tested Quality & Zero-Flake Test Suite

*Engineering rigor backed by 100% native automated tests.*

- **Native Node.js Test Runner:** Built with `node:test` and `node:assert/strict` — zero third-party testing frameworks required.
- **40 Comprehensive Test Scenarios:**
  - `sdw_config.test.cjs`: Configuration parsing, schema validation, token expansion, and initialization gates.
  - `sdw_spec.test.cjs`: Index bootstrapping, EARS validation, synthesis, SCM provider contract, state synchronization, and archival quality gates.
  - `sdw_orch.test.cjs`: State machine transitions, derivation, grilling decision trees, DAG decomposition, scoring gates, code review auto-fixing, and remote push publishing.
  - `sdw_router.test.cjs`: Minimal context budget enforcement (SKILL.md ≤ 120 lines), explicit invocations, keyword classification, tied-confidence disambiguation, missing directory resolution, and pass-through non-interference.
- **Sub-Second Execution:** Entire test suite runs in ~1.2 seconds with 100% pass rate.

---

## 🗺️ Product Roadmap & Upcoming Horizons

The following specifications are scheduled for upcoming execution phases:

- **005 — Multi-Spec Batch Execution:** Parallel and sequential pipeline batching for multi-feature delivery.
- **006 — Packaging & Vercel Skills Compatibility:** Standalone npm packaging, one-command installer, and seamless distribution across `.agents/skills/`.
- **007 — SDW Memory Skill:** Integrated anti-regression project memory and vault trap retrieval.
- **008 — SDW Rules Shared Skill:** Shared behavioral constraints for simplicity, scope enclosure, and anti-overengineering.
- **009 — SDW Security Checks:** Configurable pre-commit secret leak scanners and PII protection gates.
- **010 — Branch & Worktree Strategy:** Configurable feature branches and per-task isolated worktrees.
- **011 — GitHub Actions CI/CD Integration:** Automated workflow runs, agentic PR reviews, and skill distribution pipelines.
- **012 — SCM Provider Selection:** Granular GitHub / Azure DevOps routing with fail-safe disable modes.
