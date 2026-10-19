---
id: null
slug: 002-sdw-spec-management
title: "SDW Spec Management Skill"
source: local
specDate: 2026-10-19
---

# Specification — SDW Spec Management Skill

## Description

The `sdw-spec` skill is a specification lifecycle and formatting manager integrated directly with the `sdw-implement` orchestrator. It establishes standard formatting rules, validates frontmatter and acceptance criteria against strict EARS syntax, and maintains a centralized specification index (`{specsDir}/index.specs.md`).

Through its subcommands (`init`, `list`, `archive`, `validate`, and `create`), `sdw-spec` enables teams and agents to track specification statuses (`pending`, `completed`, `archived`), prevent specification format drift, and coordinate seamlessly with `sdw-implement` during development workflows.

### Design Intent

Greenfield implementation for the Spec-Driven Workflow (SDW) initiative. It unifies specification formatting rules and lifecycle tracking from prior workflow frameworks into a streamlined, token-efficient skill that enforces deterministic formatting standards without superfluous prompt overhead.

## Acceptance Criteria

- AC1: The system shall maintain a centralized specification index at `{specsDir}/index.specs.md` tracking specification metadata and statuses.
- AC2: When the `init` subcommand is executed, the system shall bootstrap `{specsDir}/index.specs.md` with standard headers, status definitions, and detected existing specifications.
- AC3: If `{specsDir}/index.specs.md` already exists on disk, then the system shall preserve existing records unless the `--force` flag is provided.
- AC4: When the `list` subcommand is executed, the system shall display all specifications with their slug, title, status (`pending`, `completed`, `archived`), and validation health.
- AC5: Where a status filter is passed to the `list` subcommand via `--status`, the system shall restrict the output to specifications matching the requested status.
- AC6: When the `archive` subcommand is executed for a completed specification, the system shall update its status to `archived` in `index.specs.md` with an archival timestamp.
- AC7: If the `archive` subcommand targets a specification not currently marked `completed`, then the system shall reject the operation unless the `--force` flag is provided.
- AC8: When the `validate` subcommand is executed, the system shall verify YAML frontmatter, required section hierarchy, EARS pattern conformance for all acceptance criteria, and authoring closure tables.
- AC9: If any acceptance criterion in a validated specification violates EARS syntax, then the system shall report the offending criterion identifier and exit with a non-zero code.
- AC10: When `sdw-implement` initiates execution for a specification, the system shall update or verify the specification status as `pending` in `index.specs.md`.
- AC11: When `sdw-implement` completes pull request preparation and delivery, the system shall mark the specification status as `completed` in `index.specs.md`.
- AC12: While a specification is marked `archived` in `index.specs.md`, the system shall prevent `sdw-implement` execution unless an override flag is explicitly provided.
- AC13: When scaffolding a new specification via `create`, the system shall generate all mandatory sections, EARS bullet templates, and authoring closure tables.

## Original Issue Context

The user requested an initial specification for the `sdw-spec` skill:

> create a spec for specify the sdw-spec skill for managing specs integrated with sdw-implement skill. bring to this project the same standards and rules for formatting specs. add subcommands list, archive, init (init a index.specs.md) for mark specs status pending, completed, archived.

## Notes

- Specification frontmatter must strictly include: `id` (null or string), `slug` (kebab-case identifier), `title` (quoted human-readable title), `source` (`local`, `github`, or `azure-devops`), and `specDate` (`YYYY-MM-DD`).
- Required section hierarchy: `## Description`, `### Design Intent`, `## Acceptance Criteria`, `## Notes`, `## Out of Scope`, `## Assumptions & Open Questions`, `## Definition of Ready (DoR)`, `## Validation & Observation Notes` (with `### Telemetry & Observable Signals` and `### Negative & Failing Test Scenarios`).
- EARS pattern rules:
  - Ubiquitous: `The <system> shall <response>`
  - Event-driven: `When <trigger>, the <system> shall <response>`
  - State-driven: `While <state>, the <system> shall <response>`
  - Optional-feature: `Where <feature>, the <system> shall <response>`
  - Unwanted-behavior: `If <trigger>, then the <system> shall <response>`
- The index file `{specsDir}/index.specs.md` stores a markdown table with columns: `| Slug | Title | Status | Updated | Spec File |`.
- All automation scripts must be implemented in Node.js 22 CommonJS (`.cjs`) using standard library modules only (`fs`, `path`, `process`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Direct synchronization with external remote trackers (GitHub/ADO) | Handled by specialized provider skills or external tool anchors |
| Automatic physical deletion of specification files upon archiving | Specs must be retained for auditing and historical traceability |
| Interactive graphical user interface for spec editing | Skill operates through deterministic CLI commands and agent prompts |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Specification directory path | `.sdw/specs` (resolved via `.sdw/config.json`) | Consistent with canonical repository workspace structure | y |
| Supported status values | `pending`, `completed`, `archived` | Explicitly requested by user to track lifecycle progress | y |
| Index file naming | `index.specs.md` placed in `{specsDir}` | Explicitly specified in user requirement | y |
| Helper implementation language | Node.js 22 CommonJS (`.cjs`) | Conforms to AGENTS.md rule: zero runtime npm dependencies | y |
| Absent lifecycle dimensions | N/A because execution is local CLI/agent tool invocation | Local agent execution model | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification directory | Directory `{specsDir}` exists and is writable | Inspect file system access |
| Git repository state | Workspace is a valid Git repository | Run `git status` check |
| Spec format validator script | Validator logic available in `skills/sdw-spec/scripts/` | Execute `node skills/sdw-spec/scripts/validate_spec.cjs --help` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Standard tabular output on `list` command showing spec slugs, titles, statuses, and validation pass/fail.
- Console confirmation messages upon `init`, `create`, `validate`, and `archive` invocations.
- Updated markdown table rows in `{specsDir}/index.specs.md`.
- Machine-readable JSON output when invoked with `--json`.

### Negative & Failing Test Scenarios

- EARS syntax violation rejection: when an acceptance criterion does not conform to one of the 5 EARS patterns (e.g. free-form text or missing modal verbs), `validate` must fail and name the offending AC identifier.
- Duplicate init refusal: when `init` is executed on an existing non-empty `index.specs.md` without `--force`, the command must exit with an error message and preserve the file.
- Uncompleted spec archive refusal: when attempting to archive a specification with status `pending` without `--force`, the command must reject the action.
- Execution block on archived spec: when `sdw-implement` is triggered on a spec marked `archived`, the orchestrator must halt and warn the user.
