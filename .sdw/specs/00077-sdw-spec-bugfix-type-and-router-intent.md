---
id: null
slug: 00077-sdw-spec-bugfix-type-and-router-intent
title: "Bugfix Specification Type and Router Intent Support"
source: local
status: implemented
specDate: 2026-11-21
priority: high
---
# Specification — Bugfix Specification Type and Router Intent Support

## Description

The Spec-Driven Workflow (SDW) specification lifecycle currently treats all specifications as standard feature deliverables. When a bug is discovered after the development phase (e.g. in QA, staging, or production), users and agents need a straightforward way to create a specification to fix the bug, keeping the work registered in `{specsDir}/index.specs.md` without unnecessary complexity or overengineering.

Instead of introducing complex folder hierarchies or separate workflow engines, this specification introduces a simple classification:
1. **`sdw-spec new --type=bugfix`**: Supports an optional `--type` argument in `sdw-spec new` (accepting `bugfix`, `feature`, and `task`), defaulting to `feature` when omitted.
2. **Frontmatter `type`**: Emits `type: bugfix` in the YAML frontmatter of the synthesized specification file. If omitted, existing specifications default to `feature`, ensuring 100% backward compatibility.
3. **`sdw-router` Bugfix Intent Detection**: When the user asks to create a spec to fix a bug (e.g. "create a spec to fix a bug in auth" or "draft a bugfix spec for timeout"), `sdw-router` recognizes the bugfix intent and routes to `sdw-spec new --type=bugfix`. If not specified, standard prompts route to default feature specification creation.
4. **Preserved Work & Traceability**: Keeps all bugfix specifications alongside feature specifications in `{specsDir}`, fully tracked in `{specsDir}/index.specs.md` and visible in `sdw-spec list`.

### Design Intent

Keep the workflow simple and aligned with YAGNI principles. Rather than overengineering nested folders or parallel engines, add a minimal `--type=bugfix` flag to `sdw-spec` and teach `sdw-router` to recognize bugfix specification requests automatically, defaulting to standard feature specifications when unspecified.

## Acceptance Criteria

- AC1: The system shall support an optional --type argument in sdw-spec new with allowed values bugfix, feature, and task, defaulting to feature when omitted.
- AC2: The system shall record the resolved type in the YAML frontmatter of synthesized specifications.
- AC3: The system shall allow frontmatter type to be omitted in legacy and default specifications without emitting validation errors.
- AC4: If an unrecognized type value is provided, then the system shall reject the specification with an actionable error.
- AC5: When sdw-router route evaluates a prompt asking to create a specification to fix a bug, the system shall classify the target as sdw-spec with type bugfix.
- AC6: If a prompt requests specification authoring without mentioning a bug fix, then the system shall route to sdw-spec with default feature type.
- AC7: When sdw-spec list is executed, the system shall display the specification type for registered specifications.
- AC8: The system shall update specification and router documentation to document the bugfix type option and router intent mapping.
- AC9: The system shall provide automated unit tests verifying type argument parsing, frontmatter output, router bugfix classification, and validation compatibility.

## Notes

- Uses Node.js 22 standard library (CommonJS `.cjs`) adhering to product guarantees and zero runtime dependencies.
- Frontmatter schema addition:
  ```yaml
  type: bugfix  # Optional: 'feature' (default) | 'bugfix' | 'task'
  ```
- CLI interface:
  - `node skills/sdw-spec/scripts/sdw_spec.cjs new "<requirements>" [--type bugfix|feature|task]`
- Router integration:
  - Prompts matching patterns like `create (?:a )?spec to fix (?:a )?bug` or `bugfix spec` route to `sdw-spec` with `type: 'bugfix'`.

## Out of Scope

| Feature | Reason |
|---|---|
| Nested subfolder spec hierarchies | Unnecessary filesystem complexity; flat layout with type attribute keeps structure simple |
| Remote issue label synchronization | Bounded strictly to local specification classification and existing PR closing keywords |
| Dedicated bug triage workflow engine | Standard sdw-spec lifecycle handles authoring, validation, and execution cleanly |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Default specification type | `feature` | Complete backward compatibility with all existing specifications | y |
| Supported type values | `bugfix`, `feature`, `task` | Matches common task and bug classifications without taxonomy bloat | y |
| Router detection keywords | Bug/defect phrases in spec authoring prompts | Simple regex/keyword classification without model overhead | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Specification syntax | Valid YAML frontmatter and strict EARS acceptance criteria conformance | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring` |
| Zero runtime dependencies | Implemented purely with Node.js 22 built-ins | Source code inspection |
| Backward compatibility | Specifications without type pass validation unchanged | Automated test suite execution |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node skills/sdw-router/scripts/sdw_router.cjs route "create a spec to fix the memory leak"` outputs `targetSkill: "sdw-spec"` with `options: { type: "bugfix" }`.
- `node skills/sdw-spec/scripts/sdw_spec.cjs new "Fix memory leak" --type=bugfix` generates a specification with `type: bugfix` in frontmatter.
- `node skills/sdw-spec/scripts/sdw_spec.cjs list` displays `TYPE` column.

### Negative & Failing Test Scenarios

- Passing `--type=invalid_type` to `sdw-spec new` exits with non-zero error and message listing allowed types.
- A specification with an invalid frontmatter `type` fails validation under `validate_spec.cjs`.
