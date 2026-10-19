---
id: null
slug: 002-sdw-spec-management
title: "SDW Spec Management Skill"
source: local
specDate: 2026-10-19
---

# Specification — SDW Spec Management Skill

## Description

The `sdw-spec` skill is a specification lifecycle, authoring, and formatting manager integrated directly with the `sdw-orch` orchestrator. It establishes canonical formatting standards, validates frontmatter and acceptance criteria against strict EARS syntax, and maintains a centralized specification index (`{specsDir}/index.specs.md`).

The skill provides subcommands for comprehensive specification workflows:
- `init`: Bootstraps `{specsDir}/index.specs.md` with standard tables and status definitions (`pending`, `completed`, `archived`).
- `list`: Displays registered specifications with statuses and validation health.
- `new`: Ingests free-text requirements and synthesizes well-formatted canonical specifications with autoincremented numerical prefixes (`001`, `002`, ..., `00N`).
- `import`: Imports remote tracker items from GitHub issues or Azure DevOps work items using a unified SCM provider contract and reformulates them into local canonical specifications.
- `validate`: Enforces authoring-mode validation against YAML frontmatter, section hierarchy, and EARS syntax rules.
- `archive`: Transitions completed specifications to `archived` in `index.specs.md`.

### Design Intent

Greenfield implementation for the Spec-Driven Workflow (SDW) initiative. It unifies specification formatting rules, SCM tracker importation, and lifecycle tracking from prior workflow frameworks into a streamlined, token-efficient skill that enforces deterministic formatting standards without superfluous prompt overhead.

## Acceptance Criteria

- AC1: The system shall maintain a centralized specification index at `{specsDir}/index.specs.md` tracking specification metadata and statuses.
- AC2: The system shall automatically assign an incremental 3-digit numerical prefix (`NNN`) to every newly created or imported specification based on the highest existing prefix in `{specsDir}`.
- AC3: When the `init` subcommand is executed, the system shall bootstrap `{specsDir}/index.specs.md` with standard headers, status definitions, and detected existing specifications.
- AC4: If `{specsDir}/index.specs.md` already exists on disk, then the system shall preserve existing records unless the `--force` flag is provided.
- AC5: When the `list` subcommand is executed, the system shall display all specifications with their slug, title, status (`pending`, `completed`, `archived`), and validation health.
- AC6: Where a status filter is passed to the `list` subcommand via `--status`, the system shall restrict the output to specifications matching the requested status.
- AC7: When the `archive` subcommand is executed for a completed specification, the system shall update its status to `archived` in `index.specs.md` with an archival timestamp.
- AC8: If the `archive` subcommand targets a specification not currently marked `completed`, then the system shall reject the operation unless the `--force` flag is provided.
- AC9: When the `validate` subcommand is executed, the system shall verify YAML frontmatter, required section hierarchy, EARS pattern conformance for all acceptance criteria, and authoring closure tables.
- AC10: If any acceptance criterion in a validated specification violates EARS syntax, then the system shall report the offending criterion identifier and exit with a non-zero code.
- AC11: When the `new` subcommand is executed with free-text input, the system shall reformulate the input into a canonical specification conforming to all required sections and EARS patterns.
- AC12: When a new specification is generated via the `new` subcommand, the system shall register the specification with status `pending` in `{specsDir}/index.specs.md`.
- AC13: The system shall define a unified SCM provider contract enforcing identical fetch and query operations across GitHub and Azure DevOps integrations.
- AC14: When the `import` subcommand is executed with a valid provider and item identifier, the system shall retrieve the remote work item using the SCM client contract.
- AC15: When a remote work item is retrieved via the `import` subcommand, the system shall transform it into a canonical specification with the appropriate source attribute, autoincremented prefix, and EARS acceptance criteria.
- AC16: If the requested remote work item cannot be retrieved by the SCM provider, then the system shall report an actionable error and halt without creating a partial specification.
- AC17: If an imported work item already has an existing specification in `{specsDir}`, then the system shall reject overwriting the existing specification unless the `--force` flag is provided.
- AC18: When `sdw-orch` initiates execution for a specification, the system shall update or verify the specification status as `pending` in `index.specs.md`.
- AC19: When `sdw-orch` completes pull request preparation and delivery, the system shall mark the specification status as `completed` in `index.specs.md`.
- AC20: While a specification is marked `archived` in `index.specs.md`, the system shall prevent `sdw-orch` execution unless an override flag is explicitly provided.

## Original Issue Context

The user requested the `sdw-spec` skill and subsequent enhancements:

> create a spec for specify the sdw-spec skill for managing specs integrated with sdw-implement skill. bring to this project the same standards and rules for formatting specs. add subcommands list, archive, init (init a index.specs.md) for mark specs status pending, completed, archived.
>
> I forgot to mention including a sdw-spec import which will depends on a specific scm client integration (azure devops and github), which both should implement a contract which will enforce the same operations for any scm provider. Also need a sdw-spec new subcommand allowing free text as parameter to help user add a new spec well writen following sdw spec standards. Enhance sdw-spec for autoincrement prefix every new spec 001, 002, 00N).

## Notes

- Specification frontmatter must strictly include: `id` (null or string), `slug` (`NNN-<kebab-name>`), `title` (quoted human-readable title), `source` (`local`, `github`, or `azure-devops`), and `specDate` (`YYYY-MM-DD`).
- Autoincrement sequence rules:
  - Scans `{specsDir}` for filenames matching `/^(\d{3})-.*\.md$/`.
  - Determines highest existing integer value; increments by 1; zero-pads to 3 digits (e.g. `001`, `002`, ..., `010`).
  - If no numbered specifications exist, initial prefix defaults to `001`.
- Required section hierarchy:
  - `## Description`
  - `### Design Intent`
  - `## Acceptance Criteria` (strictly formatted with EARS patterns)
  - `## Notes`
  - `## Out of Scope`
  - `## Assumptions & Open Questions`
  - `## Definition of Ready (DoR)`
  - `## Validation & Observation Notes` (with `### Telemetry & Observable Signals` and `### Negative & Failing Test Scenarios`)
- Unified SCM Provider Contract (`scm_provider_contract.cjs`):
  - Interface methods:
    - `fetchWorkItem(itemId: string | number): Promise<NormalizedWorkItem>`
    - `queryWorkItems(query: object): Promise<NormalizedWorkItem[]>`
  - `NormalizedWorkItem` standard structure:
    - `id`: string (remote issue/WI number)
    - `title`: string
    - `description`: string (markdown body)
    - `acceptanceCriteria`: string[]
    - `source`: `'github'` | `'azure-devops'`
    - `url`: string
    - `state`: string
    - `tags`: string[]
  - Provider implementations:
    - GitHub Provider: invokes `gh issue view` CLI command or GitHub REST API.
    - Azure DevOps Provider: invokes `az boards work-item show` CLI command or ADO REST API.
- All automation scripts must be implemented in Node.js 22 CommonJS (`.cjs`) using standard library modules only (`fs`, `path`, `process`, `child_process`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Mutating remote issue/work item state during import | Import is strictly a read operation to create a local specification |
| Automatic physical deletion of specification files upon archiving | Specs must be retained for auditing and historical traceability |
| Interactive graphical user interface for spec editing | Skill operates through deterministic CLI commands and agent prompts |
| Real-time multi-user bidirectional sync with remote trackers | Handled via periodic explicit import or dedicated SCM hooks |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Specification directory path | `.sdw/specs` (resolved via `.sdw/config.json`) | Consistent with canonical repository workspace structure | y |
| Numerical prefix format | 3-digit zero-padded (`NNN`) | Provides clean alphabetical and chronological file sorting up to 999 specs | y |
| SCM client authentication | Host environment CLI authentication (`gh auth status`, `az account show`) | Relies on existing developer tool credentials without storing tokens | y |
| Supported status values | `pending`, `completed`, `archived` | Explicitly requested by user to track lifecycle progress | y |
| Index file naming | `index.specs.md` placed in `{specsDir}` | Explicitly specified in user requirement | y |
| Absent lifecycle dimensions | N/A because execution is local CLI/agent tool invocation | Local agent execution model | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification directory | Directory `{specsDir}` exists and is writable | Inspect file system access |
| Git repository state | Workspace is a valid Git repository | Run `git status` check |
| Spec format validator script | Validator logic available in `skills/sdw-spec/scripts/` | Execute `node skills/sdw-spec/scripts/validate_spec.cjs --help` |
| SCM CLI availability | `gh` and/or `az` CLI tools available when testing import | Run `gh --version` or `az --version` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Standard tabular output on `list` command showing spec slugs, titles, statuses, and validation pass/fail.
- Console confirmation messages upon `init`, `new`, `import`, `validate`, and `archive` invocations.
- Updated markdown table rows in `{specsDir}/index.specs.md`.
- Machine-readable JSON output when invoked with `--json`.

### Negative & Failing Test Scenarios

- EARS syntax violation rejection: when an acceptance criterion does not conform to one of the 5 EARS patterns (e.g. free-form text or missing modal verbs), `validate` must fail and name the offending AC identifier.
- Duplicate init refusal: when `init` is executed on an existing non-empty `index.specs.md` without `--force`, the command must exit with an error message and preserve the file.
- Uncompleted spec archive refusal: when attempting to archive a specification with status `pending` without `--force`, the command must reject the action.
- SCM provider retrieval failure: when `import` is invoked for a non-existent remote work item ID, the command must report an error and not create an orphaned or empty specification file.
- SCM duplicate import refusal: when attempting to import a remote work item whose corresponding specification already exists on disk, the system must abort unless `--force` is specified.
- Execution block on archived spec: when `sdw-orch` is triggered on a spec marked `archived`, the orchestrator must halt and warn the user.
