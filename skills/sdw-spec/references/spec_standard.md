# SDW Specification Standard & Formatting Reference

Canonical specification format and schema rules for Spec-Driven Workflow (SDW).

## 1. YAML Frontmatter

Every specification must begin with YAML frontmatter containing exactly these 5 keys:

```yaml
---
id: null                  # Remote tracker issue/work item ID (string or null)
slug: 001-feature-name    # Format: NNN-<kebab-case-name>
title: "Feature Title"    # Quoted human-readable title
source: local             # One of: 'local' | 'github' | 'azure-devops'
specDate: 2026-10-19      # ISO date (YYYY-MM-DD)
---
```

## 2. Autoincrement Prefix Convention

All specifications are prefixed with a 3-digit zero-padded integer (`001`, `002`, ..., `00N`):
- Scans `{specsDir}` for existing files matching `/^(\d{3})-.*\.md$/`.
- Resolves the highest existing integer and increments by 1.
- Initial prefix defaults to `001` if no numbered files exist.
- Both the file name (`{specsDir}/NNN-{slug}.md`) and frontmatter `slug` incorporate the prefix.

## 3. Required Section Hierarchy

A valid specification must contain the following section hierarchy in order:

1. `# Specification — <Title>`
2. `## Description`
   - High-level architectural context, scope, and technical boundaries.
3. `### Design Intent`
   - Architectural motivation, rationale, or greenfield statement.
4. `### Prior Work Sweep` *(Mandatory only when `source` is `github` or `azure-devops`)*
   - Cross-references to existing code, previous PRs, or existing modules.
5. `## Acceptance Criteria`
   - Enumerable bullets formatted strictly as `- AC<number>: <EARS pattern>`.
   - Sequential 1-based indexing (`AC1`, `AC2`, ..., `ACn`).
   - Atomic requirements (no composite requirements joining multiple imperatives with 'and'/'or').
6. `## Notes`
   - Implementation constraints, schema details, interface signatures.
7. `## Out of Scope`
   - Markdown table (`Feature` | `Reason`) with at least one non-placeholder row.
8. `## Assumptions & Open Questions`
   - Markdown table (`Assumption` | `Chosen default` | `Rationale` | `Confirmed`) with non-placeholder rationale.
9. `## Definition of Ready (DoR)`
   - Markdown table (`Readiness Item` | `Requirement` | `Verification Method`).
10. `## Validation & Observation Notes`
    - `### Telemetry & Observable Signals`
    - `### Negative & Failing Test Scenarios` (at least one failing/error test case).

## 4. EARS Syntax Patterns

Acceptance criteria must strictly match one of the 5 Easy Approach to Requirements Syntax (EARS) patterns:

| Pattern | Template | Example |
|---|---|---|
| **Ubiquitous** | `The <system> shall <response>` | `The system shall maintain a centralized specification index at {specsDir}/index.specs.md.` |
| **Event-driven** | `When <trigger>, the <system> shall <response>` | `When the list subcommand is executed, the system shall display all specifications.` |
| **State-driven** | `While <state>, the <system> shall <response>` | `While a specification is marked archived, the system shall prevent execution.` |
| **Optional-feature** | `Where <feature>, the <system> shall <response>` | `Where a status filter is passed via --status, the system shall restrict output.` |
| **Unwanted-behavior** | `If <trigger>, then the <system> shall <response>` | `If the index file already exists, then the system shall preserve existing records.` |
