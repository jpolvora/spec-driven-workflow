# Specific Recommendations: spec-driven-workflow (SDW)

Review focus: Node.js skill packages, orchestrator state machine, agent-agnostic skills (`skills/`), specifications (`.sdw/specs/`), and GitHub Actions workflows. Prioritize findings that compromise agent agnosticism, break deterministic tool anchors, introduce external dependencies, violate EARS acceptance criteria, exceed skill line budgets, or violate version control safety.

---

## 1. Core Architecture & Architectural Invariants

**Review priorities — high signal (always report):**
1. **Agent and Harness Agnosticism (Rule 5):**
   - The entire project, all skills, and tooling must be strictly **agent-agnostic** and **harness-agnostic**.
   - Flag any dependency on specific harnesses (e.g. Claude Code, Cursor, Copilot, Antigravity, OpenCode, Windsurf) or proprietary agent runtimes.
   - All logic must rely strictly on universal primitives: portable filesystem operations, standard Node.js 22 built-ins, standard Markdown/YAML/JSON formats, and portable paths (normalize with forward slashes `/`).
2. **Zero External Runtime Dependencies (Rule 3):**
   - All helper scripts must use **Node.js 22 CommonJS (`.cjs`)** and Node standard library only (`fs`, `path`, `process`, `child_process`).
   - Zero runtime npm dependencies are permitted in packaged skills.
   - Python (`.py`) scripts are strictly forbidden.
3. **No Unrequested Version Control Operations (Rule 7):**
   - In ad-hoc queries, explorations, and isolated refactorings outside of authorized `sdw-orch` pipelines, agents must never run `git commit` or `git push` unless explicitly requested.
   - Flag any unrequested git mutation.
4. **Breaking Changes Encouraged / No Backward Compatibility (Rule 6):**
   - Breaking changes are allowed and encouraged when adding or updating specifications, skills, and tooling.
   - Do NOT author compatibility shims, deprecation wrappers, migration layers, or dual-support branches for superseded behavior. Remove legacy paths directly.
5. **Secrets & Security Leak Prevention:**
   - Secrets, API keys, tokens, or private keys must never be committed into repository code, documentation, or fixtures.

---

## 2. Skill Authoring Standard (3-Tier Architecture)

When reviewing changes under `skills/<skill-name>/`:
- **Tier 1: `SKILL.md` (Context Budget: ≤ ~120 lines):**
  - Must include YAML frontmatter with `name`, single-line `description` (optimized for trigger matching), `version`, and `invocation_names`.
  - Immediately following the primary `# <skill-name>` title heading, it must contain:
    ```markdown
    > When this skill is loaded, output "<skill-name> loaded."
    ```
  - Compact state-machine steps with mandatory, checkable `Done when:` completion gates.
  - Zero prompt sediment, no vague advice, and no open negative constraints.
  - Flag any `SKILL.md` that exceeds ~120 lines or lacks `Done when:` completion criteria.
- **Tier 2: `references/*.md` (Progressive Disclosure):**
  - Schemas, detailed protocols, decision trees, and domain vocabulary loaded on-demand.
- **Tier 3: `scripts/*.cjs` (Deterministic Execution):**
  - Automated validators, parsers, scaffolders, and state updaters using Node.js 22 CommonJS and standard library only.
  - Must exit with empirical pass/fail status codes (`0` for success, non-zero for failure).

---

## 3. Specification Standard (`.sdw/specs/`)

When reviewing specifications under `.sdw/specs/`:
- **YAML Frontmatter:** Must include `id`, `slug`, `title`, `source`, and `specDate`.
- **Acceptance Criteria (EARS Syntax):**
  - Every acceptance criterion must be atomic, enumerable (`- AC1: ...`, `- AC2: ...`), and formatted using **EARS** patterns:
    - *Ubiquitous:* `The <system> shall <response>`
    - *Event-driven:* `When <trigger>, the <system> shall <response>`
    - *State-driven:* `While <state>, the <system> shall <response>`
    - *Optional-feature:* `Where <feature>, the <system> shall <response>`
    - *Unwanted-behavior:* `If <trigger>, then the <system> shall <response>`
- **Required Sections:**
  - `## Description` & `### Design Intent`
  - `## Acceptance Criteria`
  - `## Notes`
  - `## Out of Scope` (Markdown table)
  - `## Assumptions & Open Questions` (Markdown table)
  - `## Definition of Ready (DoR)` (Markdown table)
  - `## Validation & Observation Notes` (with Telemetry and Negative/Failing Test Scenarios)
- Must pass `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring --repo-root . <specFile>`.

---

## 4. Workflows & Scripts (`.github/workflows/`)

- External actions must be limited to official GitHub actions (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`).
- All workflow logic must delegate to deterministic Node.js `.cjs` scripts rather than complex shell inline logic.
- Least-privilege permissions: CI uses `contents: read`; Code Review uses `contents: read` and `pull-requests: write`.
- Code review workflow must use `--stack Custom` with `--custom-prompt .github/agentic-code-reviewers-prompt.md`.
- Graceful degradation: credential-less environments (such as forks or fresh clones) must log a skip notice and exit 0 without failing PR status checks.

---

## 5. Minimum Score Threshold (`score_min: 5`)

- Create review threads **ONLY** for findings with severity score **>= 5** (1–10 scale).
- Filter out trivial suggestions, cosmetic styling, and formatting-only markdown churn without behavioral or architectural impact.
