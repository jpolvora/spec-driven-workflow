# Spec-Driven Workflow (SDW)

A streamlined, deterministic framework for spec-driven software development with AI coding agents.

---

## 1. Overview & Motivation

**Spec-Driven Workflow (SDW)** is a modern reimagining and simplification of the `workflow-skills` framework.

### Why the Rework?
- **Smarter Frontier Models:** Modern LLMs possess advanced reasoning, tool calling, and architecture comprehension out of the box. They no longer require excessive boilerplate instructions, micro-managed prompts, or multi-page rule books.
- **Speed & Token Efficiency:** Eliminating prompt sediment drastically decreases token load per turn, lowers inference costs, minimizes API latency, and preserves precious context window space for actual project code.
- **Repeatable Predictability:** Rather than relying on fragile prompt suggestions, SDW relies on deterministic Node.js tool anchors, structured state-machine transitions, and empirical verification gates.

SDW standardizes how developers specify, refine, implement, review, and ship features across both local workspaces and remote trackers (GitHub, Azure DevOps).

---

## 2. The Core Workflow Orchestrator: `sdw-implement`

At the center of SDW is the **`sdw-implement`** orchestrator skill. It coordinates the feature delivery lifecycle end-to-end, managing a dedicated run state file (`.sdw/state/{runId}.state.json`) that enables pause, inspection, resume, and seamless data handoffs across subagents.

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

2. **Grilling Round (Ambiguity & Gap Elimination)**
   - Executes an exhaustive decision tree walk over the spec to detect underspecified logic, unhandled edge cases, and missing constraints.
   - Proactively queries project context, codebase structure, memory, and architectural rules to resolve gaps autonomously.
   - For decisions requiring human authority, triggers an interactive user prompt (`ask_question`), clearly presenting the gap, available options, and a recommended default.
   - Produces a refined, ambiguity-free specification ready for implementation.

3. **Complexity Analysis & DAG Task Decomposition**
   - Assesses technical scope, dependencies, and risk factors.
   - Generates a Directed Acyclic Graph (DAG) dividing the work into discrete, atomic execution units.
   - Simple changes produce a single execution unit; complex features produce sequential or parallel execution units.

4. **Isolated Subagent Dispatch & Implementation**
   - Dispatches focused subagents according to the DAG definition.
   - Enforces context fencing: each subagent receives only the relevant task prompt and scoped references, preventing context pollution and keeping the model tightly focused on its file set.

5. **Conformance Scoring Loop**
   - Evaluates implementation output by quantitatively comparing the resulting diffs and touched files against the refined spec's acceptance criteria.
   - If the score falls below the required threshold (e.g. `< 8/10`), the orchestrator loops back to implementation, attaching exact observations and gap findings to prevent repeating the same errors.
   - Re-implementation repeats until the quality bar is verified.

6. **Delivery Commit**
   - Once quality is assured by the conformance score, creates an atomic, structured delivery git commit.

7. **Automated Code Review Loop**
   - Compares the newly committed code against the base branch commit.
   - Evaluates project-specific coding standards, architectural invariants, security risks, and regressions.
   - If warnings or findings are reported, applies targeted surgical fixes and creates updated commits in an iterative loop until all findings are resolved.

8. **PR Preparation & Remote Review Resolution Loop**
   - Associates work items/tasks, marks the feature spec as completed, and opens/updates the Pull Request.
   - *Optional Remote Review Loop:* If enabled, schedules a monitoring timer to poll for PR reviewer comments. When comments are posted, the orchestrator analyzes the feedback, implements surgical fixes, pushes commits, and responds with resolution summaries until all threads are resolved.

---

## 3. Repository Architecture

```text
spec-driven-workflow/
├── .sdw/                         # Canonical template for consumer projects
│   ├── config.json               # Default configuration schema
│   ├── directory-structure.md    # Layout rules & documentation
│   └── specs/                    # Storage directory for feature specifications
│       └── 001-sdw-implement-initial-version.md
├── skills/                       # Canonical source of truth for all skills
│   ├── sdw-config/               # Project configuration & verification skill
│   │   ├── SKILL.md              # 3-Tier Tier 1 instructions
│   │   ├── references/           # Tier 2 reference schemas & contracts
│   │   └── scripts/              # Tier 3 deterministic Node.js helpers (sdw_config.cjs)
│   └── sdw-implement/            # Orchestrator skill (in development)
├── AGENTS.md                     # Mandatory rules and protocols for AI agents
└── README.md                     # Project documentation and architecture guide
```

### Key Principles

- **`skills/` as Source of Truth:** Skills in development live in `skills/`. When packaged or installed into consumer repositories, they target `{projectRoot}/.agents/skills/`.
- **Zero Heavy Dependencies:** All runtime skill scripts are lightweight **Node.js 22 CommonJS (`.cjs`)** using only Node standard library (`fs`, `path`, `process`, `child_process`). No npm installation overhead or external runtime dependencies.
- **Portability:** Path resolution automatically supports Windows and POSIX environments with forward-slash normalization.

---

## 4. Getting Started

### Using `sdw-config`

The `sdw-config` skill manages the `.sdw/` workspace infrastructure in any project:

```bash
# Initialize .sdw/ structure in current or target repository
node skills/sdw-config/scripts/sdw_config.cjs init [--root <path>] [--force]

# Verify integrity, syntax, and directory conformance
node skills/sdw-config/scripts/sdw_config.cjs check [--root <path>] [--json]

# Parse configuration and resolve path tokens (e.g. {projectRoot})
node skills/sdw-config/scripts/sdw_config.cjs parse [--root <path>] [--json]
```

### Creating Specifications

Specifications reside in `.sdw/specs/` using EARS-formatted acceptance criteria:

```bash
# Validate specification formatting and authoring readiness
node C:/Users/jpolv/.gemini/config/skills/ws-spec-format/scripts/validate_spec.cjs --mode=authoring .sdw/specs/<spec-name>.md
```

---

## 5. License & Contribution

Maintained under the Spec-Driven Workflow initiative. Contributions must adhere to the authoring guidelines documented in [AGENTS.md](AGENTS.md).
