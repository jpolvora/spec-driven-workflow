# Spec-Driven Workflow (SDW) — Agent Instructions & Rules

Mandatory repository rules and development guidelines for all AI agents working in this repository.

---

## 1. Project Identity & Architecture

**Spec-Driven Workflow (SDW)** is a streamlined, next-generation rework of the `workflow-skills` framework.
- **Core Philosophy:** Modern LLM architectures possess high reasoning and planning capabilities. Excessive prompt instructions and repetitive sediment are eliminated to minimize token consumption, reduce context window overhead, and dramatically accelerate execution speed.
- **Agent Agnostic (First-Class Feature):** The entire project, all skills, and tooling are strictly **agent-agnostic** and **harness-agnostic**. It is a mandatory, first-class requirement that no component creates dependencies on specific harnesses, proprietary vendors, or specific IDE implementations. Everything must be designed and implemented to ensure wide compatibility with most agents and harnesses.
- **Predictability & Determinism:** Workflows are orchestrated through clear state machines, empirical exit criteria (`Done when:`), and deterministic Node.js helper scripts instead of stochastic prompt guidelines.
- **No Backward Compatibility (Current Phase):** Breaking changes are allowed and encouraged when adding or updating specifications, skills, and tooling. Do not preserve compatibility: remove legacy paths instead of shimming them. Compatibility requirements produce excessive, unnecessary instructions and sediment; keep the project concise, small, and optimized.

---

## 2. Mandatory Global Rules (Canonical Source of Truth)

1. **Skills Source of Truth (`skills/`):**
   - The [`skills/`](skills/) directory contains the canonical source code for all skills in development (e.g., `skills/sdw-config/`, `skills/sdw-implement/`).
   - When creating, editing, or updating skills, **`skills/` is the exclusive directory source of truth**.
   - Packaging / installation target: When packaging for publication or installing into consumer projects, deployment scripts read from `skills/` and install to `{projectRoot}/.agents/skills/`.

2. **Consumer Workspace Template (`.sdw/`):**
   - The [`.sdw/`](.sdw/) directory in this repository is the canonical template and structure baseline for consumer projects.
   - Any new global default configuration keys, directory layout changes, or spec conventions must be reflected inside `.sdw/` (`config.json`, `directory-structure.md`, and `specs/`).

3. **No External Runtime Dependencies:**
   - All helper scripts must use **Node.js 22 CommonJS (`.cjs`)** and **Node standard library only** (`fs`, `path`, `process`, `child_process`).
   - Zero runtime npm dependencies are permitted in packaged skills.
   - Never author Python (`.py`) scripts for skill helpers or tooling anchors.

4. **Deterministic Tool Anchors:**
   - Skills must invoke helpers via explicit launchers (e.g., `node skills/<skill-name>/scripts/<helper>.cjs`).
   - Shell commands and scripts must handle paths portably across Windows and POSIX (normalize path separators with forward slashes `/`).

5. **Agent & Harness Agnosticism:**
   - Do not create dependencies on specific harnesses, proprietary agent runtimes, specific vendors, or particular IDE implementations.
   - Rely strictly on universal primitives: portable filesystem operations, standard CLI execution (Node.js 22 built-ins), standard Markdown/YAML/JSON formats, and portable stdin/stdout/file-based interaction.
   - Always ensure broad compatibility across diverse agents and harnesses (e.g., Claude Code, Cursor, Codex/Copilot, Antigravity, OpenCode, Windsurf, or generic CLI harnesses).

6. **Breaking Changes Encouraged (Current Phase):**
   - When adding or updating specifications, skills, or tooling, do not preserve backward compatibility; replace and remove legacy paths rather than wrapping or shimming them.
   - Do not author compatibility shims, deprecation wrappers, migration layers, or dual-support branches for superseded behavior.
   - This is a deliberate phase policy; the maintainer will update this rule when the project's compatibility behavior changes.

7. **No Unrequested Version Control Writes:**
   - Never run `git commit`, `git push`, or any other history-writing or remote-publishing operation unless the user explicitly requested it or if is part of a requirement of workflow running sdw-orch/sdw-implement requests.
   - Staging (`git add`) is permitted only as part of an explicitly requested commit.
   - Leave changes in the working tree and report them; the maintainer decides when and how to commit or push.

---

## 3. Skill Authoring Standard (3-Tier Progressive Disclosure)

When authoring or modifying skills under `skills/<skill-name>/`, adhere strictly to the 3-Tier layout:

- **Tier 1: `SKILL.md` (Context Budget: ≤ ~120 lines)**
  - Frontmatter with `name`, single-line `description` (optimized for trigger matching), `version`, and `invocation_names`.
  - Immediately following the primary `# <skill-name>` title heading, include:
    ```markdown
    > When this skill is loaded, output "<skill-name> loaded."
    ```
  - Compact state-machine steps with mandatory, checkable `Done when:` completion gates.
  - Zero prompt sediment, no vague advice, and no open negative constraints.

- **Tier 2: `references/*.md` (Progressive Disclosure)**
  - Schemas, complex examples, edge cases, and domain vocabulary.
  - Loaded on-demand only when a specific step requires it.

- **Tier 3: `scripts/*.cjs` (Deterministic Execution)**
  - Automated validators, parsers, scaffolders, and state updaters.
  - Provides empirical pass/fail exit codes (`0` for success, non-zero for failures).

---

## 4. Spec Formatting Standard (`.sdw/specs/`)

Specifications in `.sdw/specs/` must conform to the canonical SDW specification standard:
- **YAML Frontmatter:** `id`, `slug`, `title`, `source` (`local`, `github`, or `azure-devops`), and `specDate`.
- **Required Sections:**
  - `## Description`: Technical architecture, boundaries, and scope.
  - `### Design Intent`: Architectural rationale (or greenfield statement).
  - `## Acceptance Criteria`: Atomic, enumerable bullets (`- AC1: ...`, `- AC2: ...`) strictly formatted using **EARS** patterns:
    - *Ubiquitous:* `The <system> shall <response>`
    - *Event-driven:* `When <trigger>, the <system> shall <response>`
    - *State-driven:* `While <state>, the <system> shall <response>`
    - *Optional-feature:* `Where <feature>, the <system> shall <response>`
    - *Unwanted-behavior:* `If <trigger>, then the <system> shall <response>`
  - `## Notes`: Implementation constraints and dependencies.
  - `## Out of Scope`: Markdown table (`Feature` | `Reason`).
  - `## Assumptions & Open Questions`: Markdown table (`Assumption` | `Chosen default` | `Rationale` | `Confirmed`).
  - `## Definition of Ready (DoR)`: Markdown table (`Readiness Item` | `Requirement` | `Verification Method`).
  - `## Validation & Observation Notes`:
    - `### Telemetry & Observable Signals`
    - `### Negative & Failing Test Scenarios` (at least one failing test/error case).
- **Validation:** Must pass `node {skillsRoot}/ws-spec-format/scripts/validate_spec.cjs --mode=authoring <specFile>`.

---

## 5. Workflow State & Isolation Rules

- **Run State Isolation:** Workflow state for an active run is maintained in `.sdw/state/{runId}.state.json`. Never pollute shared configuration or global directories with ephemeral session state.
- **Subagent Context Fencing:** When orchestrators dispatch subagents (e.g. implementation units), provide only the necessary task slice and reference context rather than raw cumulative transcripts.
- **User Clarification Gate:** When ambiguous branch paths or decision gaps are detected during grilling, present explicit options with a recommended default (using host question prompt mechanisms like `ask_question` where supported, or structured interactive chat prompts).