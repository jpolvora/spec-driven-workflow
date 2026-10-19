# SDW Directory Structure & Guidelines

Baseline directory layout for consumer projects adopting Spec-Driven Workflow:

```text
{projectRoot}/
└── .sdw/
    ├── config.json              # Main project workflow configuration
    ├── config.schema.json       # JSON Schema definition for config.json validation
    ├── directory-structure.md   # Structural guidelines and directory inventory
    ├── specs/                   # Canonical feature specifications (*.md)
    │   └── index.specs.md       # Centralized specification index and lifecycle tracking table
    └── state/                   # Ephemeral execution run state files (*.state.json)
```

## Inventory

- **`.sdw/config.json`**: Primary project configuration defining paths, quality gates, and workflow options.
- **`.sdw/config.schema.json`**: JSON Schema validating `config.json` structure, data types, and value bounds.
- **`.sdw/directory-structure.md`**: Textual specification and inventory of the `.sdw` directory hierarchy.
- **`.sdw/specs/`**: Target directory for canonical specifications with EARS acceptance criteria and Definition of Ready.
- **`.sdw/specs/index.specs.md`**: Centralized specification index registering slugs, titles, lifecycle statuses (`pending`, `completed`, `archived`), and validation health.
- **`.sdw/state/`**: Dedicated directory for isolated execution run state files (`run-*.state.json`).