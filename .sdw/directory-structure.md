# SDW Directory Structure & Guidelines

Baseline directory layout for consumer projects adopting Spec-Driven Workflow:

```text
{projectRoot}/
├── CHANGELOG.md                 # Project task delivery changelog (governed by changelogFile)
└── .sdw/
    ├── config.json              # Main project workflow configuration
    ├── config.schema.json       # JSON Schema definition for config.json validation
    ├── directory-structure.md   # Structural guidelines and directory inventory
    ├── specs/                   # Canonical feature specifications (*.md)
    │   ├── index.specs.md       # Centralized specification index and lifecycle tracking table
    │   └── *.md                 # Feature specifications
    ├── reports/                 # Committed delivery reports ({specFileNameWithoutExtension}-report.md)
    ├── state/                   # Ephemeral execution run state files (*.state.json)
    │   └── {slug}/{runId}/      # Human-auditable step artifacts ({slug}-step-{N}.md), dispatch prompts
    │                            # (task-{taskId}.prompt.md), task evidence (task-{taskId}.evidence.json),
    │                            # and Step 5 judge files (step-5-judge.prompt.md, .verdict.json)
    ├── memory/                  # Product knowledge entries (versioned)
    │   └── traps.md             # Central anti-regression trap log
    ├── worktrees/               # Ephemeral per-task git worktrees (command mode only)
    └── sandbox/                 # Ephemeral isolated clones for --sandbox runs (configurable via sandboxDir)
        └── {runId}/             # repo/ (clone), sandbox.json (metadata), report.md (execution report)
```

## Inventory

- **`CHANGELOG.md`**: Project task delivery changelog updated by `sdw-changelog` with prompt, done, and result entries.
- **`.sdw/config.json`**: Primary project configuration defining paths, quality gates, and workflow options.
- **`.sdw/config.schema.json`**: JSON Schema validating `config.json` structure, data types, and value bounds.
- **`.sdw/directory-structure.md`**: Textual specification and inventory of the `.sdw` directory hierarchy.
- **`.sdw/specs/`**: Target directory for canonical specifications (*.md) with EARS acceptance criteria and Definition of Ready. It holds specifications only; delivery reports live in `.sdw/reports/`.
- **`.sdw/specs/index.specs.md`**: Centralized specification index registering slugs, titles, lifecycle statuses (`pending`, `completed`, `archived`), and validation health.
- **`.sdw/reports/`**: Committed delivery reports written by `sdw-orch` as `{specFileNameWithoutExtension}-report.md` when a run reaches Step 8 (created on first write). A report is a delivery artifact, so it stays out of `.sdw/specs/` and never gets a registry row; a legacy `*-report.md` found beside a specification is reported by `sdw-doctor` with the move target.
- **`.sdw/state/`**: Dedicated directory for isolated execution run state files (`run-*.state.json`) and per-run step artifacts (`.sdw/state/{slug}/{runId}/{slug}-step-{N}.md`). Step 4 keeps one dispatch prompt and one evidence file per DAG task; Step 5 keeps the fenced judge prompt and its verdict. The directory also carries the run-scoped learning index (`.sdw/state/{slug}/{runId}/learnings.json`), the append-only record of every memory entry the run recorded, which later steps query with `sdw-memory query --run <runId>` when no memory backend is reachable.
- **`.sdw/memory/traps.md`**: Central anti-regression trap log capturing session friction, scope enclosure rules, and architectural traps.
- **`.sdw/worktrees/`**: Ephemeral per-task worktrees (`.sdw/worktrees/{runId}/{taskId}`) used only when `implementation.mode` is `command` and `useWorktrees: true`. Ignored by git.
- **`.sdw/sandbox/`**: Ephemeral isolated local clones created by `sdw-orch run --sandbox` under the configured `sandboxDir` (default `{projectRoot}/.sdw/sandbox`; tokens `{projectRoot}`, `{skillsRoot}`, `{temp}`). A custom value must resolve outside the project root. Each `{runId}/` holds `repo/` (the clone), `sandbox.json` (branch, base commit, baseline-dirty flag, status), and `report.md` (step, task, gate, commit, and diff facts). Removed explicitly with `sdw-orch sandbox clean --run-id <runId>`. The default location is gitignored.

## Skills Installation Topologies

SDW supports three installation topologies with automatic `{skillsRoot}` token resolution in `.sdw/config.json`:

1. **Canonical Development Repository:** `{projectRoot}/skills/`
2. **Consumer Project-Local Vendoring:** `{projectRoot}/.agents/skills/`
3. **User-Wide Shared Installation (Hybrid Mode):** `$HOME/.agents/skills/`

In **Hybrid Mode**, skills are installed once globally under `$HOME/.agents/skills/` and shared across all projects on the workstation, while each consumer project strictly maintains its own isolated `.sdw/` directory. All configuration (`.sdw/config.json`), specs (`.sdw/specs/`), and run states (`.sdw/state/`) remain local to the consumer repository and never leak into global storage.