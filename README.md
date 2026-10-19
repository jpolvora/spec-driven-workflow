# Spec-Driven Workflow (SDW)

[![Agentic Code Review](https://github.com/jpolvora/spec-driven-workflow/actions/workflows/agentic-code-review.yml/badge.svg)](https://github.com/jpolvora/spec-driven-workflow/actions/workflows/agentic-code-review.yml)

A streamlined, deterministic framework for spec-driven software development with AI coding agents.

---

## 1. Overview & Motivation

**Spec-Driven Workflow (SDW)** is a modern reimagining and simplification of the `workflow-skills` framework.

### Why the Rework?
- **Smarter Frontier Models:** Modern LLMs possess advanced reasoning, tool calling, and architecture comprehension out of the box. They no longer require excessive boilerplate instructions, micro-managed prompts, or multi-page rule books.
- **Speed & Token Efficiency:** Eliminating prompt sediment drastically decreases token load per turn, lowers inference costs, minimizes API latency, and preserves precious context window space for actual project code.
- **Repeatable Predictability:** Rather than relying on fragile prompt suggestions, SDW relies on deterministic Node.js tool anchors, structured state-machine transitions, and empirical verification gates.

SDW standardizes how developers specify, refine, implement, review, and ship features across both local workspaces and remote trackers (GitHub, Azure DevOps).

> 📖 **Feature Showcase:** For an in-depth, presentation-style breakdown of all implemented capabilities, subsystems, and the product roadmap, see [FEATURES.md](FEATURES.md).

---

## 2. The Core Workflow Orchestrator: `sdw-orch`

At the center of SDW is the **`sdw-orch`** orchestrator skill. It coordinates the feature delivery lifecycle end-to-end, managing a dedicated run state file (`.sdw/state/{runId}.state.json`) that enables pause, inspection, resume, and seamless data handoffs across subagents.

```mermaid
flowchart TD
    A[Human Source Spec / Issue] --> B[1. Spec Ingestion & Derivation]
    B --> C[2. Grilling Round & Gap Resolution]
    C -->|Interactive Q&A if needed| C
    C --> D[3. Complexity Analysis & DAG Generation]
    D --> E[4. Isolated Subagent Implementation]
    E --> F[5. Conformance Score Analysis]
    F -->|< Min Threshold| E
    F -->|Passes Score| G[6. Delivery Commit]
    G --> H[7. Automated Code Review Loop]
    H -->|Findings Detected| H
    H -->|Clean Diff| I[8. PR Preparation & Comment Resolution Loop]
```

### End-to-End Workflow Stages

1. **Spec Ingestion & Agentic Derivation**
   - Ingests human-friendly requirements from local files or remote issue trackers (GitHub Issues, Azure DevOps Work Items).
   - Translates human goals into clear, technical, agentic specifications.
   - *Optimization:* This step is automatically skipped if the input specification is already formatted for agentic execution.

2. **Refinement Round (Grilling + Technical Planning)**
   - Executes an exhaustive decision tree walk over the spec to detect underspecified logic, unhandled edge cases, and missing constraints.
   - Proactively queries project context, codebase structure, memory, and architectural rules to resolve gaps autonomously.
   - Generates a structured technical blueprint (`targetFiles`, `architecturalApproach`, `testPlan`) and persists the human-auditable refinement artifact `{slug}-step-2.md`.
   - For decisions requiring human authority in interactive mode, prompts the user (`ask_question`) with recommended defaults.

3. **Complexity Analysis & DAG Task Decomposition**
   - Assesses technical scope, dependencies, and risk factors, directly ingesting the Step 2 technical blueprint.
   - Generates a Directed Acyclic Graph (DAG) dividing the work into discrete, atomic execution units with context prompts.
   - Persists the DAG plan artifact `{slug}-step-3.md`. Supports isolated git worktrees (`useWorktrees: true`) for multi-task plans.

4. **Implementation Execution Contract & Evidence Gate**
   - Dispatches implementation via default handoff mode (writes prompt files, sets `awaiting_implementation`, exits code 4) or opt-in command mode (executing subprocesses with token substitution and environment sanitization).
   - In worktree mode (`useWorktrees: true`), isolates tasks in sequential git worktrees branching from primary `HEAD`, committing in worktree, cherry-picking to primary, and cleaning up safely.
   - Corroborates changes in worktrees or primary tree, rejecting empty worktrees or unmodified working trees.
   - Requires task completion via `sdw-orch task finish` with schema-validated evidence files.
   - Executes build and test verification gates (`verification.buildCommand`, `verification.testCommand`) once all tasks are accepted.

5. **Evidence-Based Conformance Scoring**
   - Strictly evaluates conformance score based on accepted task evidence records (`round(verified / total * 10)`).
   - Verifies criteria only when referenced by accepted evidence confirming real existing changed files on disk. Fails closed with 0/10 if no ACs exist.
   - Persists the preliminary implementation report artifact `{slug}-step-5.md` with verified criteria and evidence links.
   - If the score falls below the required threshold (default `< 8/10`), triggers a feedback re-implementation loop (code 2).

6. **Delivery Commit & Quality Guard**
   - Refuses delivery commits if Step 4 is incomplete, any task unaccepted, or any verification gate failed.
   - Runs pre-commit secret leak scan (`sdw-security-checks`) when enabled.
   - Creates an atomic, structured delivery git commit (`feat(...)`).

7. **Automated Code Review Loop (Delegated to `sdw-code-review`)**
   - Dispatches `sdw-code-review` to inspect working-tree and branch diffs against an auto-detected base branch.
   - Evaluates Karpathy Guidelines, `sdw-rules` simplicity, surgical diff hygiene, and syntax invariants.
   - Generates an actionable Markdown fix plan (`{slug}-step-7.md`) and applies surgical fixes in an iterative loop.

8. **PR Preparation, Delivery & Review Convergence (Delegated to `sdw-ship-pr`)**
   - Delegates pre-PR verification gates (`requiredBuild`, `runAllTests`, `prePrCommand`, `prePrInstructions`) and delivery publishing to `sdw-ship-pr`.
   - Executes cooperative and proactive review convergence with push-before-resolve guarantees, posting structured resolution comments before closing threads.
   - Updates the specification index to `completed` and records PR metadata in the run state.

---

## 3. Repository Architecture

```text
spec-driven-workflow/
├── bin/                          # Repository tooling (local review dry run)
│   └── review-dry-run.cjs        # Pinned OpenCode 1.19.1 + agentic-code-reviewers
├── .github/                      # GitHub Actions automation & CI/CD
│   ├── workflows/                # Continuous integration, code review, and release pipelines
│   │   ├── ci.yml
│   │   ├── agentic-code-review.yml
│   │   └── release.yml
│   ├── agentic-code-reviewers-prompt.md # SDW review contract for agentic reviewers
│   └── README.md                 # GitHub integration documentation
├── .sdw/                         # Canonical template for consumer projects
│   ├── config.json               # Default configuration schema
│   ├── directory-structure.md    # Layout rules & documentation
│   └── specs/                    # Storage directory for feature specifications
│       ├── index.specs.md        # Central specification index
│       └── *.md                  # Canonical feature specifications
│   ├── state/                    # Ephemeral execution run state and step artifacts
│   │   └── {slug}/{runId}/       # Human-auditable step artifacts ({slug}-step-{N}.md)
│   ├── traps.md                  # Central anti-regression trap log
│   └── worktrees/                # Ephemeral per-task git worktrees for isolated subagents
├── skills/                       # Canonical source of truth for all skills
│   ├── sdw-code-review/          # Standalone deep working-tree review & fix planning
│   ├── sdw-config/               # Project configuration & verification skill
│   ├── sdw-orch/                 # End-to-end workflow orchestrator skill
│   ├── sdw-router/               # Always-autoloaded entrypoint and skill router
│   ├── sdw-rules/                # Shared behavioral rules, simplicity & anti-overengineering
│   ├── sdw-security-checks/      # Pre-commit secrets and credentials leak scanner
│   ├── sdw-ship-pr/              # Standalone PR shipping & review convergence skill
│   └── sdw-spec/                 # Spec authoring, validation, sync, and index manager
├── tests/                        # Automated unit & integration test suites
│   ├── sdw_branch_worktree.test.cjs
│   ├── sdw_code_review.test.cjs
│   ├── sdw_config.test.cjs
│   ├── sdw_github_actions.test.cjs
│   ├── sdw_orch.test.cjs
│   ├── sdw_orch_implementation.test.cjs
│   ├── sdw_refinement_gates.test.cjs
│   ├── sdw_router.test.cjs
│   ├── sdw_rules.test.cjs
│   ├── sdw_scm_provider.test.cjs
│   ├── sdw_security_checks.test.cjs
│   ├── sdw_ship_pr.test.cjs
│   ├── sdw_spec.test.cjs
│   └── sdw_step_artifacts.test.cjs
├── AGENTS.md                     # Mandatory rules and protocols for AI agents
├── FEATURES.md                   # Feature showcase and architecture presentation
└── README.md                     # Project documentation and architecture guide
```

### Key Principles

- **`skills/` as Source of Truth:** Skills in development live in `skills/`. When packaged or installed into consumer repositories, they target `{projectRoot}/.agents/skills/`.
- **Zero Heavy Dependencies:** All runtime skill scripts are lightweight **Node.js 22 CommonJS (`.cjs`)** using only Node standard library (`fs`, `path`, `process`, `child_process`). No npm installation overhead or external runtime dependencies.
- **Portability:** Path resolution automatically supports Windows and POSIX environments with forward-slash normalization.

---

## 4. Installing Skills with `npx skills` (Consumers)

Install the SDW skills into any consumer project using the open agent skills tool (`npx skills`, see [vercel-labs/skills](https://github.com/vercel-labs/skills) / [skills.sh](https://skills.sh)). Run from your project root. Requires **Node.js 22.20 or later**.

Verify what is available before installing:

```bash
npx skills add jpolvora/spec-driven-workflow --list
```

Expected: `10` discoverable skills — the 8 `sdw-*` skills plus `karpathy-guidelines` and `ws-memo`:

| Skill | Purpose |
|---|---|
| `sdw-router` | Always-autoloaded router, dispatches prompts to the right SDW skill |
| `sdw-config` | Initializes and verifies the `.sdw/` workspace (`init`, `check`, `parse`) |
| `sdw-spec` | Spec authoring, EARS validation, index sync |
| `sdw-orch` | End-to-end 8-step delivery workflow (spec → DAG → implement → review → PR) |
| `sdw-rules` | Shared simplicity / anti-overengineering rules |
| `sdw-security-checks` | Pre-commit secrets and credentials leak gate |
| `sdw-code-review` | Standalone working-tree review and fix planning (also Step 7 delegation) |
| `sdw-ship-pr` | Pre-PR checks, branch push, PR creation, review convergence |

### Copy-paste: install all SDW skills (recommended)

```bash
npx skills add jpolvora/spec-driven-workflow --skill sdw-router --skill sdw-config --skill sdw-spec --skill sdw-orch --skill sdw-rules --skill sdw-security-checks --skill sdw-code-review --skill sdw-ship-pr -y
```

One-liner alternative (installs everything discoverable, including `karpathy-guidelines` and `ws-memo`):

```bash
npx skills add jpolvora/spec-driven-workflow --all
```

Interactive install (pick skills and agents from a menu):

```bash
npx skills add jpolvora/spec-driven-workflow
```

### Scope, agents, and lifecycle

```bash
# Project scope (default): installs to ./.agents/skills/, commit with your project
# Global scope: available across all projects on the machine
npx skills add jpolvora/spec-driven-workflow --skill sdw-router --skill sdw-config --skill sdw-spec --skill sdw-orch --skill sdw-rules --skill sdw-security-checks --skill sdw-code-review --skill sdw-ship-pr -g -y

# Target specific agents (default is auto-detected agents; use '*' for all agents)
npx skills add jpolvora/spec-driven-workflow --skill sdw-orch -a opencode -y
npx skills add jpolvora/spec-driven-workflow --skill sdw-orch --skill sdw-spec -a claude-code -a cursor -y

# Verify, update, remove
npx skills list
npx skills check
npx skills update
npx skills remove sdw-orch
```

Installed layout (project scope, OpenCode / Cursor / Codex / Amp / Replit share `.agents/skills/`; Claude Code also links under `.claude/skills/`):

```text
<projectRoot>/.agents/skills/sdw-orch/SKILL.md
<projectRoot>/.agents/skills/sdw-spec/SKILL.md
...
<projectRoot>/skills-lock.json
```

### After install: initialize the workspace

```bash
# Initialize .sdw/ structure in the consumer project
node .agents/skills/sdw-config/scripts/sdw_config.cjs init

# Verify installation and workspace health
node .agents/skills/sdw-config/scripts/sdw_config.cjs check
node .agents/skills/sdw-router/scripts/sdw_router.cjs scan
```

> Note: contributor docs in this repo use canonical paths (`node skills/<name>/scripts/*.cjs`). Consumers installed via `npx skills` use the same script names under `node .agents/skills/<name>/scripts/*.cjs`.

---

## 5. Getting Started

### Using `sdw-router` (Autoload & Routing)

The `sdw-router` skill is an always-applied router that inspects prompts and dispatches to specialized skills:

```bash
# Analyze prompt intent or explicit invocations (/sdw-*)
node skills/sdw-router/scripts/sdw_router.cjs route "<prompt>" [--json]

# Scan available skills across canonical (skills/) and consumer (.agents/skills/) paths
node skills/sdw-router/scripts/sdw_router.cjs scan [--json]

# Audit skills integrity and directory health
node skills/sdw-router/scripts/sdw_router.cjs doctor [--json]
```

### Using `sdw-config` (Workspace Configuration)

The `sdw-config` skill manages the `.sdw/` workspace infrastructure:

```bash
# Initialize .sdw/ structure in current or target repository
node skills/sdw-config/scripts/sdw_config.cjs init [--root <path>] [--force]

# Verify integrity, syntax, and directory conformance
node skills/sdw-config/scripts/sdw_config.cjs check [--root <path>] [--json]

# Parse configuration and resolve path tokens (e.g. {projectRoot})
node skills/sdw-config/scripts/sdw_config.cjs parse [--root <path>] [--json]
```

### Using `sdw-spec` (Specification Management)

The `sdw-spec` skill manages specification authoring, formatting, validation, and lifecycle:

```bash
# Synthesize a new specification from free-text requirements
node skills/sdw-spec/scripts/sdw_spec.cjs new "<requirements>"

# Validate specification formatting and EARS syntax readiness
node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/<spec-name>.md

# Reconcile index.specs.md with active on-disk specifications and run states
node skills/sdw-spec/scripts/sdw_spec.cjs sync

# List all specifications and their validation health
node skills/sdw-spec/scripts/sdw_spec.cjs list
```

### Using `sdw-orch` (Workflow Orchestrator)

The `sdw-orch` skill executes the end-to-end 8-step delivery workflow:

```bash
# Execute the full delivery pipeline for a specification
node skills/sdw-orch/scripts/sdw_orch.cjs run .sdw/specs/<spec-name>.md [--push]

# Execute a multi-specification sequential batch queue
node skills/sdw-orch/scripts/sdw_orch.cjs run <spec1.md> <spec2.md> ... [--continue-on-error] [--dry-run]

# Resume an interrupted single-spec run
node skills/sdw-orch/scripts/sdw_orch.cjs resume [--run-id <runId>]

# Resume an interrupted multi-spec batch queue
node skills/sdw-orch/scripts/sdw_orch.cjs resume-batch [batchId]

# Inspect status of active execution
node skills/sdw-orch/scripts/sdw_orch.cjs status
```

### Using `sdw-security-checks` (Secrets & Credentials Gate)

The `sdw-security-checks` skill guards against committing sensitive tokens and credentials:

```bash
# Scan working tree (ignore-aware) for secrets and leaks
node skills/sdw-security-checks/scripts/sdw_security_checks.cjs scan

# Scan staged changes only (git diff --cached)
node skills/sdw-security-checks/scripts/sdw_security_checks.cjs scan --staged

# Emit structured JSON report
node skills/sdw-security-checks/scripts/sdw_security_checks.cjs scan --staged --json
```

### Using `sdw-ship-pr` (PR Shipping & Review Convergence)

The `sdw-ship-pr` skill executes pre-PR verification, publishes branches, creates/reuses PRs, and runs automated review convergence:

```bash
# Execute standalone PR shipping with pre-PR verification
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --head <branch> --base <baseBranch>

# Dry-run simulation without git push or remote mutations
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --head develop --dry-run --json

# Ship and run review convergence loop with resolution summary comments
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --head develop --push --poll-pr
```

### Using `sdw-code-review` (Deep Review & Fix Planning)

The `sdw-code-review` skill deeply analyzes committed and uncommitted working-tree changes against an auto-detected base branch, and doubles as the `sdw-orch` Step 7 delegation target:

```bash
# Review working tree and HEAD diffs (auto-detected base), write Markdown fix plan
node skills/sdw-code-review/scripts/sdw_code_review.cjs run

# Review with surgical auto-fixes (up to 3 iterations) and JSON output
node skills/sdw-code-review/scripts/sdw_code_review.cjs fix --json

# Simulate fixes without modifying files
node skills/sdw-code-review/scripts/sdw_code_review.cjs run --fix --dry-run --json
```

### Local Agentic Code Review Dry Run

Runs the same `agentic-code-reviewers` recipe as CI against the current branch (`develop` → `master`) without publishing PR threads:

```bash
npm install          # installs the pinned opencode-ai@1.19.1 dev dependency
npm run review:dry   # alias: npm run review
```

The helper uses the `OPENCODE_API_KEY` from the OS environment through the `opencode-go` provider, forces the pinned OpenCode `1.19.1` binary, and passes `--dry-run` with the Custom stack prompt. Findings are printed as `::error` / `::warning` annotations and the command exits `0` even when issues are found. See [AGENTS.md](AGENTS.md#10-local-code-review-dry-run-agentic-code-reviewers) for overrides.

## 6. License & Contribution

Maintained under the Spec-Driven Workflow initiative. Contributions must adhere to the authoring guidelines documented in [AGENTS.md](AGENTS.md).
