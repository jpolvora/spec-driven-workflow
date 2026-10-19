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
    ├── state/                   # Ephemeral execution run state files (*.state.json)
    │   └── {slug}/{runId}/      # Human-auditable intermediate step artifacts ({slug}-step-{N}.md)
    ├── traps.md                 # Central anti-regression trap log
    └── worktrees/               # Ephemeral per-task git worktrees for isolated subagents
```

## Inventory

- **`.sdw/config.json`**: Primary project configuration defining paths, quality gates, and workflow options.
- **`.sdw/config.schema.json`**: JSON Schema validating `config.json` structure, data types, and value bounds.
- **`.sdw/directory-structure.md`**: Textual specification and inventory of the `.sdw` directory hierarchy.
- **`.sdw/specs/`**: Target directory for canonical specifications with EARS acceptance criteria and Definition of Ready.
- **`.sdw/specs/index.specs.md`**: Centralized specification index registering slugs, titles, lifecycle statuses (`pending`, `completed`, `archived`), and validation health.
- **`.sdw/state/`**: Dedicated directory for isolated execution run state files (`run-*.state.json`) and per-run step artifacts (`.sdw/state/{slug}/{runId}/{slug}-step-{N}.md`).
- **`.sdw/traps.md`**: Central anti-regression trap log capturing session friction, scope enclosure rules, and architectural traps.
- **`.sdw/worktrees/`**: Ephemeral per-task worktrees (`.sdw/worktrees/{runId}/{taskId}`) used when `useWorktrees: true`. Ignored by git.

## Skills Installation Topologies

SDW supports three installation topologies with automatic `{skillsRoot}` token resolution:

1. **Canonical Development Repository:** `{projectRoot}/skills/`
2. **Consumer Project-Local Vendoring:** `{projectRoot}/.agents/skills/`
3. **User-Wide Shared Installation (Hybrid Mode):** `$HOME/.agents/skills/`

In **Hybrid Mode**, skills are installed once globally under `$HOME/.agents/skills/` and shared across all projects on the workstation, while each consumer project strictly maintains its own isolated `.sdw/` directory. All configuration (`.sdw/config.json`), specs (`.sdw/specs/`), and run states (`.sdw/state/`) remain local to the consumer repository and never leak into global storage.