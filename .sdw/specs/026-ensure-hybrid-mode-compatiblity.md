---
id: null
slug: 026-ensure-hybrid-mode-compatiblity
title: "Ensure Hybrid Mode Compatibility — Global and Local Skills Resolution"
source: local
specDate: 2026-10-19
---

# Specification — Ensure Hybrid Mode Compatibility — Global and Local Skills Resolution

## Description

The Spec-Driven Workflow (SDW) framework is strictly agent-agnostic and harness-agnostic. SDW skills (`sdw-router`, `sdw-config`, `sdw-spec`, `sdw-orch`, `sdw-ship-pr`, `sdw-code-review`, etc.) can be deployed across three distinct installation topologies:
1. **Canonical Development Repository:** `{projectRoot}/skills/`
2. **Consumer Project-Local Vendoring:** `{projectRoot}/.agents/skills/`
3. **User-Wide Shared Installation (Hybrid Mode):** `$HOME/.agents/skills/` (shared centrally across all repositories on a developer workstation)

In **Hybrid Mode**, skills are installed once globally under `$HOME/.agents/skills/` to eliminate per-repository duplication and ease updates, while each consumer project strictly maintains its own isolated `.sdw/` configuration directory (`.sdw/config.json`, `.sdw/config.schema.json`, `.sdw/directory-structure.md`, `.sdw/specs/`, and `.sdw/state/`).

This specification establishes dynamic, deterministic path resolution for SDW skills across local and global environments. It introduces the `{skillsRoot}` path token in configuration and runtime environments, defines the deterministic discovery precedence for cross-skill references, updates `sdw-router` discovery, enhances `sdw-config check` and `sdw-config init` for hybrid workflows, and standardizes consumer `AGENTS.md` instructions for autoloading `sdw-router` without hardcoded OS paths.

### Design Intent

Eliminates the rigid assumption that SDW skills must reside in the immediate workspace working directory (`skills/` or `.agents/skills/`). By providing a lightweight, zero-dependency resolution helper that dynamically locates the active skills root, skills can execute from a shared global directory (`$HOME/.agents/skills/`) or local workspace while preserving complete configuration isolation inside each project's `.sdw/` directory.

## Acceptance Criteria

- AC1: The system shall support a {skillsRoot} token in .sdw/config.json and runtime path resolution that resolves to the active skills installation directory.
- AC2: When resolving the skills root directory, the system shall inspect explicit CLI or environment overrides, project-local canonical and consumer skills directories, the enclosing directory of the executing script, and the global user directory in strict order.
- AC3: While executing within a project containing local skills, the system shall resolve cross-skill references to the project-local skills root.
- AC4: While executing within a project lacking local skills, the system shall resolve cross-skill references to the global user skills root in $HOME/.agents/skills.
- AC5: When sdw-config init executes in a project under hybrid mode, the system shall generate local .sdw configuration defaults without polluting the global skills directory.
- AC6: When sdw-config check executes, the system shall validate and report the resolved skills root path and active deployment mode.
- AC7: When sdw-router scans available skills, the system shall discover skills across project canonical, project-local consumer, and global user skills directories.
- AC8: When generating consumer project configuration and documentation, the system shall reference sdw-router autoloading using the resolved skillsRoot token.
- AC9: If neither local nor global skills directories exist on disk, then the system shall abort execution with an error indicating missing skills.
- AC10: When sdw-orch invokes helper scripts or delegated skills, the system shall locate target scripts via the resolved skills root rather than hardcoded workspace paths.

## Notes

- **Dynamic Skills Root Resolution Precedence:**
  1. Explicit CLI argument (`--skills-root <path>`) or environment variable (`SDW_SKILLS_ROOT`).
  2. Canonical repository root: `{projectRoot}/skills` (if exists and contains at least one valid SDW skill).
  3. Consumer project-local directory: `{projectRoot}/.agents/skills` (if exists and contains at least one valid SDW skill).
  4. Enclosing skill path: If the current executing script `__dirname` resides inside a skills tree (matching `.../skills/<skill-name>/...`), resolve the parent `skills` directory.
  5. User-level shared directory: `$HOME/.agents/skills` (or `%USERPROFILE%/.agents/skills` on Windows, normalized with forward slashes).

- **Deployment Mode Classifications:**
  - `canonical`: Running from within the core SDW development repository (`{projectRoot}/skills`).
  - `local`: Consumer project with vendored skills in `{projectRoot}/.agents/skills`.
  - `global` / `hybrid`: Skills installed in `$HOME/.agents/skills`, executing against a consumer project root with its own `.sdw/` configuration directory.

- **Configuration & Token Expansion:**
  - In `.sdw/config.json`, both `{projectRoot}` and `{skillsRoot}` tokens are supported.
  - `{projectRoot}` expands to the normalized path of the target project repository.
  - `{skillsRoot}` expands to the resolved active skills directory path.
  - Default `.sdw/config.json` templates and schemas remain project-isolated; ephemeral session run state (`.sdw/state/`) and feature specifications (`.sdw/specs/`) never leak into the global user directory.

- **Cross-Skill Reference Portability:**
  - Relative requires between co-located skills (`../../<sibling-skill>/scripts/...`) naturally function because sibling skills are installed side-by-side in `{skillsRoot}`.
  - Spawning child processes or resolving delegated skill entrypoints (e.g., `sdw-ship-pr`, `sdw-code-review`) utilizes the resolved `skillsRoot` directory.

- **Consumer `AGENTS.md` Autoload Pattern:**
  - Consumer repositories autoload `sdw-router` by referencing `{skillsRoot}/sdw-router/SKILL.md` (e.g., `@.agents/skills/sdw-router/SKILL.md` when vendored locally, or `@~/.agents/skills/sdw-router/SKILL.md` when running globally).

- **Runtime & Architectural Constraints:**
  - All helpers and resolution logic must use Node.js 22 CommonJS (`.cjs`) standard library only (`fs`, `path`, `os`, `process`, `child_process`).
  - Zero external runtime npm dependencies.
  - Cross-platform portability across Windows and POSIX (paths normalized with forward slashes `/`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Package downloading or remote git clone machinery | Skill installation and fetching is handled by package managers (`npx skills`) or manual clone; SDW only performs local path resolution |
| Automatic syncing of global skills to local projects | Skills remain decoupled; users explicitly choose between shared global execution and local vendoring |
| Global configuration overriding project configuration | Project configurations in `.sdw/config.json` are strictly project-scoped to prevent unexpected cross-project side effects |
| Non-Node.js path resolution helpers | All helper logic must strictly adhere to the repository standard of Node.js 22 CommonJS standard library |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Global shared skills directory path | `$HOME/.agents/skills` | Standard user-level agent customization location across diverse agent harnesses | y |
| Precedence between local and global skills | Local project skills take precedence over global skills | Allows individual projects to pin or customize specific skill versions without affecting other repositories | y |
| Configuration token naming | `{skillsRoot}` | Follows the established `{projectRoot}` token convention in `.sdw/config.json` | y |
| Project configuration requirement in hybrid mode | Always required in `{projectRoot}/.sdw` | Preserves repository autonomy, deterministic verification, and clean state separation | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema validation | Conforms to SDW EARS specification standard | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate .sdw/specs/026-ensure-hybrid-mode-compatiblity.md --mode=authoring` |
| Index registration | Registered in `.sdw/specs/index.specs.md` with pending status | Run `node skills/sdw-spec/scripts/sdw_spec.cjs sync` |
| Baseline configuration integrity | Workspace `.sdw/config.json` passes schema validation | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Node runtime environment | Node.js 22 or higher available | Run `node -v` |
| Test suite stability | Existing test suites continue to pass cleanly | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `sdw-config check` diagnostic output printing the resolved `skillsRoot` directory and deployment mode (`canonical`, `local`, `global`).
- `sdw-router scan` output listing discovered skills from local and global search locations with their respective origin tags.
- Orchestrator execution logs displaying resolved helper script locations during step execution.

### Negative & Failing Test Scenarios

- Missing skills directory abort: When neither local nor global skills directories exist on disk, `sdw-config check` or `sdw-router` must report an error and exit with code 1.
- Invalid skillsRoot path rejection: When a configuration file specifies a non-existent or inaccessible path for `{skillsRoot}`, configuration validation must report a failure.
- Global directory isolation: When `sdw-config init` runs in hybrid mode, it must never write configuration, state, or spec files into `$HOME/.agents/skills/`.
