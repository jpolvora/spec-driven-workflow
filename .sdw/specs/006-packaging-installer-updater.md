---
id: null
slug: 006-packaging-installer-updater
title: "Packaging, Distribution, and Vercel Skills Compatibility"
source: local
specDate: 2026-10-19
---

# Specification — Packaging, Distribution, and Vercel Skills Compatibility

## Description

The Spec-Driven Workflow (SDW) framework provides a lightweight, token-efficient methodology for specification management, project configuration, and orchestrated implementation. This specification establishes packaging verification and portable distribution for SDW skills. Distribution is optional convenience: the repository ships plain Markdown and Node.js files that any agent or harness can consume directly, while the open Vercel Labs `skills` package manager (`npx skills`) provides an additional one-command installation channel. No component may depend on a specific harness, vendor runtime, or IDE.

Distributable skills reside under `skills/<skill-name>/` with standard `SKILL.md` entrypoints and YAML frontmatter. This enables developers and AI agents to discover, install, and update individual or bundled SDW skills (`sdw-config`, `sdw-spec`, `sdw-orch`, `sdw-router`, `sdw-memory`, `sdw-rules`, `sdw-security-checks`) into portable agent customization directories (e.g., `.agents/skills/`) using `npx skills add` and `npx skills update`.

Release stability is provided by a deterministic packaging verification script plus the GitHub Actions workflows defined in spec 011 (github-actions-integration), which run test suites, validate all specifications, and verify skill structure conformance before publishing a tag.

### Design Intent

Implements the minimal packaging and distribution requirements necessary to make SDW skills installable via `npx skills`. By relying directly on the open Vercel Labs `skills` ecosystem rather than introducing custom installer machinery, the architecture avoids overengineering, eliminates unnecessary maintenance overhead, and maintains zero runtime dependencies.

## Acceptance Criteria

- AC1: The system shall organize all distributable skills under `skills/` with standard YAML frontmatter compatible with the `npx skills` package manager.
- AC2: When `npx skills add` is executed against the repository, the system shall expose discoverable skills for installation into agent customization directories.
- AC3: Where an explicit skill name is specified via the skill flag during `npx skills add`, the system shall install only the targeted skill folder.
- AC4: The system shall provide a deterministic packaging verification script using Node.js standard library modules without external runtime dependencies.
- AC5: When the packaging script executes with the verify flag, the system shall validate that all skills adhere to the three-tier architecture guidelines.
- AC6: If a required skill file or script is missing during packaging verification, then the system shall abort verification with an exit code of one.
- AC7: Where release or review workflows execute, the system shall defer all workflow definitions to spec 011 (github-actions-integration).

## Original Issue Context

The specification originated from the user draft in `.sdw/specs/006-packaging-installer-updater.md`:

> draft - when releasing new versions (preferrable automated via ci/cd), we must create a package deployable compatible with npx skills (vercel) - learn how to do and how it works at https://github.com/vercel-labs/skills

## Notes

- Ecosystem Compatibility with `vercel-labs/skills`:
  - Repository structure adheres to standard multi-skill layout:
    ```text
    skills/
    ├── sdw-config/
    │   ├── SKILL.md
    │   ├── references/
    │   └── scripts/
    ├── sdw-orch/
    │   ├── SKILL.md
    │   ├── references/
    │   └── scripts/
    ├── sdw-spec/
    │   ├── SKILL.md
    │   ├── references/
    │   └── scripts/
    └── sdw-router/
        ├── SKILL.md
        ├── references/
        └── scripts/
    ```
  - Standard CLI invocations for consumers:
    ```bash
    # Install all skills into .agents/skills/
    npx skills add <owner>/spec-driven-workflow

    # Install specific skill
    npx skills add <owner>/spec-driven-workflow --skill sdw-router

    # List available skills in repository
    npx skills add <owner>/spec-driven-workflow --list

    # Update installed skills to latest version
    npx skills update
    ```
- Packaging Verification Helper (`scripts/verify_skills.cjs`):
  - Validates that each skill in `skills/` contains:
    - Tier 1: `SKILL.md` with valid YAML frontmatter (`name`, `description`), announcement header (`> When this skill is loaded, output "... loaded."`), and context line budget (≤ 120 lines).
    - Tier 2: `references/` directory with referenced documentation files present on disk.
    - Tier 3: `scripts/` directory with all referenced `.cjs` scripts present and executable.
    - Zero external runtime npm dependencies.
- CI/CD Ownership Boundary: all `.github/workflows/` YAML files (continuous integration, agentic code review, release) are defined by spec 011 (github-actions-integration); this specification owns the packaging format and the `scripts/verify_skills.cjs` helper that those workflows invoke.
- Runtime Constraints:
  - All automation scripts must be implemented in Node.js 22 CommonJS (`.cjs`) using standard library modules only (`fs`, `path`, `process`, `child_process`).
- Verification Scope & Extensibility:
  - The skill tree listing above is illustrative, not exhaustive.
  - Packaging verification is directory-driven: every folder under `skills/` is audited automatically, so future skills (`sdw-memory`, `sdw-rules`, `sdw-security-checks`) are covered without editing the verification script or the CI workflow.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Custom native installer or updater CLI tool | Installation and updates are handled via `npx skills` (`add`/`update`) or manual copy; no custom installer is authored |
| Consumer workspace template scaffolding installer | Initial project configuration remains handled by `sdw-config` rather than a distribution installer |
| Hosting a dedicated proprietary package registry | Discovery and distribution rely on GitHub and `skills.sh` |
| Authoring verification scripts in non-Node runtimes | Standard library Node.js 22 CommonJS is mandatory per repository standards |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Skills packaging format | Standard `skills/<skill-name>/SKILL.md` layout | Natively discovered and supported by `vercel-labs/skills` | y |
| Package manager mechanism | Exclusively `npx skills` | User requested omitting custom native installer tooling | y |
| Release automation trigger | Git semantic tag push (`v*.*.*`) | Standard trigger for GitHub Actions CI/CD workflows | y |
| Distribution dependency | Optional convenience only; skills remain plain files consumable by any agent | Satisfies the AGENTS.md agent & harness agnosticism rule while keeping `npx skills` support | y |
| Packaging script dependency policy | Zero external runtime dependencies | Standard library Node.js 22 CommonJS only per AGENTS.md | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | Baseline `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Skills directory layout | All skills under `skills/` contain valid `SKILL.md` frontmatter | Verify with packaging verification helper |
| Specification validation | Specification passes authoring mode validation | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate` |
| Git repository state | Workspace is a valid Git repository with clean working tree | Run `git status` check |
| Node runtime compatibility | Environment provides Node.js 22 or higher | Run `node -v` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Packaging verification logs detailing audited skills, line counts, and script existence.
- CI/CD workflow run execution logs showing pass/fail status per test suite and spec validation step.
- Semantic release tagging confirmation logs in GitHub Actions output.

### Negative & Failing Test Scenarios

- Packaging verification missing file abort: when a skill directory lacks `SKILL.md` or a referenced helper script, the verification script must exit with code 1.
- Broken frontmatter rejection: when a skill `SKILL.md` has missing or invalid YAML frontmatter (e.g. missing `name` or `description`), packaging verification must exit with code 1.
- Release pipeline failure halt: when any specification fails authoring validation or any unit test fails in `tests/`, the CI/CD pipeline must fail and abort the release.