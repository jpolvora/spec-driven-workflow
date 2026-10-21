# .sdw Configuration & Directory Structure Reference

## 1. Directory Structure

Consumer projects following the Spec-Driven Workflow (SDW) standard store project-level workflow assets inside the `.sdw/` folder located at the project root:

```text
{projectRoot}/
└── .sdw/
    ├── config.json              # Main project workflow configuration
    ├── config.schema.json       # JSON Schema definition for config.json validation
    ├── directory-structure.md   # Structural guidelines and layout rules
    ├── specs/                   # Target directory for canonical specifications
    └── state/                   # Ephemeral execution run state files (*.state.json)
```

### 1.1 Components

- **`.sdw/config.json`**: Primary JSON configuration file defining paths and behaviors for SDW skills and tools.
- **`.sdw/config.schema.json`**: JSON Schema draft-07 specification validating `config.json`.
- **`.sdw/directory-structure.md`**: Textual specification and inventory of the directory hierarchy.
- **`.sdw/specs/`**: Default repository for feature specifications formatted with YAML frontmatter, EARS acceptance criteria, and Definition of Ready.
- **`.sdw/state/`**: Isolated session state files (`run-*.state.json`) recording execution progress, conformance scores, and DAG tasks.

---

## 2. Configuration Schema (`config.json`)

The configuration file `.sdw/config.json` conforms to `config.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://spec-driven-workflow.org/schemas/config.schema.json",
  "title": "SDW Configuration Schema",
  "description": "Configuration schema for Spec-Driven Workflow (.sdw/config.json).",
  "type": "object",
  "required": ["specsDir"],
  "properties": {
    "$schema": {
      "type": "string",
      "description": "Relative path or URL to the JSON schema definition file."
    },
    "specsDir": {
      "type": "string",
      "description": "Path to the directory containing feature specifications. Supports tokens {projectRoot} and {skillsRoot}.",
      "default": "{projectRoot}/.sdw/specs"
    },
    "scoreMin": {
      "type": "integer",
      "description": "Minimum conformance score (0-10) required before creating delivery commits.",
      "minimum": 0,
      "maximum": 10,
      "default": 8
    },
    "scmCodeReviewEnabled": {
      "type": "boolean",
      "description": "Enable remote pull request review polling loop and automated review comment resolution.",
      "default": false
    },
    "pushDelivery": {
      "type": "boolean",
      "description": "Automatically push the delivery commit and branch to remote origin upon workflow completion.",
      "default": false
    },
    "changelogEnabled": {
      "type": "boolean",
      "description": "Enable appending delivery records to the project changelog. When false, sdw-changelog exits 0 with 'skipped: disabled' and writes nothing.",
      "default": true
    },
    "changelogFile": {
      "type": "string",
      "description": "Path to the project changelog. Supports the {projectRoot} token; the resolved path must stay inside the project root.",
      "default": "{projectRoot}/CHANGELOG.md"
    },
    "stateDir": {
      "type": "string",
      "description": "Path to the directory storing run session state files. Supports tokens {projectRoot} and {skillsRoot}.",
      "default": "{projectRoot}/.sdw/state"
    },
    "sandboxDir": {
      "type": "string",
      "description": "Path to the directory that holds sandbox clones created by sdw-orch --sandbox. Defaults to {projectRoot}/.sdw/sandbox; any other value must resolve outside the project root. Supports tokens {projectRoot}, {skillsRoot}, and {temp}.",
      "default": "{projectRoot}/.sdw/sandbox"
    },
    "skillsRoot": {
      "type": "string",
      "description": "Path to the active skills directory. Supports tokens {projectRoot} and {skillsRoot}."
    },
    "autoResolveGaps": {
      "type": "boolean",
      "description": "Automatically apply recommended defaults for unhandled grilling gaps when running non-interactively.",
      "default": true
    },
    "securityChecksEnabled": {
      "type": "boolean",
      "description": "Enable pre-commit secrets and credentials leak scanning.",
      "default": false
    },
    "useWorktrees": {
      "type": "boolean",
      "description": "Enable per-task isolated git worktrees for dispatched subagents under .sdw/worktrees/{runId}/.",
      "default": false
    },
    "useFeatureBranches": {
      "type": "boolean",
      "description": "Automatically create and activate an isolated feature branch derived from specification slug.",
      "default": false
    },
    "scmProvider": {
      "type": "string",
      "enum": ["none", "ado", "github"],
      "default": "none",
      "description": "Configured SCM provider for issues, work items, and pull requests. Allowed: none, ado, github."
    },
    "requiredBuild": {
      "type": "boolean",
      "description": "Enforce successful build verification in Step 8 before creating delivery commit or PR.",
      "default": false
    },
    "buildCommand": {
      "type": "string",
      "description": "Command to execute for build verification.",
      "default": "npm run build"
    },
    "runAllTests": {
      "type": "boolean",
      "description": "Enforce passing all test suites in Step 8 before creating delivery commit or PR.",
      "default": false
    },
    "testCommand": {
      "type": "string",
      "description": "Command to execute for test verification pass.",
      "default": "npm test"
    },
    "prePrCommand": {
      "type": "string",
      "description": "Optional project-specific shell command to execute before PR preparation (e.g. version bump, lint).",
      "default": ""
    },
    "prePrInstructions": {
      "type": "string",
      "description": "Optional project-specific instructions or checklist for agents to verify prior to PR submission.",
      "default": ""
    },
    "reviewFixCommand": {
      "type": "string",
      "description": "Optional command that applies review-thread fixes. When unset, sdw-ship-pr never resolves active threads automatically.",
      "default": ""
    },
    "maxPreemptions": {
      "type": "integer",
      "minimum": 0,
      "description": "Maximum concurrent-push adaptation budget for post-PR review convergence before draining rounds.",
      "default": 3
    },
    "memory": {
      "type": "object",
      "description": "Product memory backend selection for sdw-memory (central knowledge wrapper). The ws-memo vault is the default integration; local traps file and memory files are fallbacks.",
      "properties": {
        "backends": {
          "type": "object",
          "description": "Enable or disable each memory store backend. Missing keys default to enabled.",
          "properties": {
            "wsMemo": {
              "type": "boolean",
              "description": "Use the ws-memo vault (memo CLI) as the default knowledge store.",
              "default": true
            },
            "traps": {
              "type": "boolean",
              "description": "Use the local .sdw/memory/traps.md table backend.",
              "default": true
            },
            "files": {
              "type": "boolean",
              "description": "Search local MEMORY.md and memory/*.md files (read-only).",
              "default": true
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": true
    }
  },
  "additionalProperties": true
}
```

### 2.1 Supported Properties

| Key | Type | Default | Description |
|:---|:---|:---|:---|
| `$schema` | `string` | `"./config.schema.json"` | Schema definition reference for editor autocomplete and validation |
| `specsDir` | `string` | `"{projectRoot}/.sdw/specs"` | Path to specifications directory (supports `{projectRoot}` and `{skillsRoot}`) |
| `scoreMin` | `integer` | `8` | Minimum acceptable conformance score (range: 0–10) |
| `scoring.judgeCommand` | `string \| null` | `null` | Optional judge command that writes the Step 5 verdict JSON. Supports `{promptFile}`, `{verdictFile}`, `{diffFile}`, `{criteriaFile}`, `{slug}`, `{targetRoot}`. When unset, the current agent model instance judges via `score submit`. Env fallback: `SDW_JUDGE_COMMAND` |
| `scoring.judgeModel` | `string \| null` | `null` | Judge model identifier passed to the judge command or host agent |
| `scoring.judgeProvider` | `string \| null` | `null` | Judge provider identifier passed to the judge command or host agent |
| `scoring.judgeEffort` | `string \| null` | `null` | Judge reasoning-effort hint passed to the judge command or host agent |
| `scoring.judgeApiEndpoint` | `string \| null` | `null` | Judge API endpoint passed to the judge command or host agent |
| `scoring.judgeCriticity` | `string` | `"strict"` | Judge strictness: `permissive`, `strict`, or `perfectionist` |
| `implementation.mode` | `string` | `"subagent"` | Step 4 mode: `subagent` (sequential host-dispatched workers) or `command` (automated subprocess per task). `handoff` was replaced by `subagent` |
| `implementation.command` | `string \| null` | `null` | Required when `implementation.mode` is `command`; supports `{taskId}`, `{promptFile}`, `{evidenceFile}`, `{workingDir}`, `{targetRoot}`, `{slug}` |
| `implementation.timeoutMs` | `integer` | `1800000` | Per-task execution timeout for `command` mode |
| `scmCodeReviewEnabled` | `boolean` | `false` | Whether remote PR comment polling and automated fix resolution loop is active |
| `pushDelivery` | `boolean` | `false` | Whether to automatically push delivery commits to remote origin |
| `changelogEnabled` | `boolean` | `true` | Enable appending delivery records to the project changelog; `false` skips the append with exit `0` and writes nothing |
| `changelogFile` | `string` | `"{projectRoot}/CHANGELOG.md"` | Changelog path; supports `{projectRoot}` and must resolve inside the project root |
| `stateDir` | `string` | `"{projectRoot}/.sdw/state"` | Path to isolated execution run state directory (supports `{projectRoot}` and `{skillsRoot}`) |
| `sandboxDir` | `string` | `"{projectRoot}/.sdw/sandbox"` | Root directory for `sdw-orch --sandbox` clones; each run creates `{sandboxDir}/{runId}/repo`. Supports `{projectRoot}`, `{skillsRoot}`, and `{temp}` (OS temp directory). A custom value must resolve **outside** the project root; only the default may live inside it |
| `skillsRoot` | `string` | — | Path to the active skills directory (supports `{projectRoot}` and `{skillsRoot}`) |
| `autoResolveGaps` | `boolean` | `true` | Whether to auto-apply recommended grilling defaults when non-interactive |
| `securityChecksEnabled` | `boolean` | `false` | Enable pre-commit secrets and credentials leak scanning |
| `useWorktrees` | `boolean` | `false` | Enable per-task isolated git worktrees for dispatched subagents under `.sdw/worktrees/{runId}/` |
| `useFeatureBranches` | `boolean` | `false` | Automatically create and activate an isolated feature branch derived from specification slug |
| `scmProvider` | `string` | `"none"` | Configured SCM provider for issues, work items, and pull requests (`none`, `ado`, `github`) |
| `requiredBuild` | `boolean` | `false` | Enforce successful build verification in Step 8 before creating delivery commit or PR |
| `buildCommand` | `string` | `"npm run build"` | Command to execute for build verification |
| `runAllTests` | `boolean` | `false` | Enforce passing all test suites in Step 8 before creating delivery commit or PR |
| `testCommand` | `string` | `"npm test"` | Command to execute for test verification pass |
| `prePrCommand` | `string` | `""` | Optional project-specific shell command to execute before PR preparation |
| `prePrInstructions` | `string` | `""` | Optional project-specific instructions or checklist for agents to verify prior to PR |
| `reviewFixCommand` | `string` | `""` | Optional command that applies review-thread fixes. When unset, sdw-ship-pr never resolves active threads automatically |
| `maxPreemptions` | `integer` | `3` | Maximum concurrent-push adaptation budget for post-PR review convergence before draining rounds |
| `memory.backends.wsMemo` | `boolean` | `true` | Use the ws-memo vault (memo CLI) as the default sdw-memory knowledge store |
| `memory.backends.traps` | `boolean` | `true` | Use the local .sdw/memory/traps.md table backend |
| `memory.backends.files` | `boolean` | `true` | Search local MEMORY.md and memory/*.md files (read-only) |

### 2.2 Supported Path Tokens

- `{projectRoot}`: Replaced by the absolute, forward-slash normalized path of the consumer project root (e.g., `C:/projects/my-app` or `/home/user/my-app`).
- `{skillsRoot}`: Replaced by the absolute, forward-slash normalized path of the resolved active skills directory.

### 2.3 Default Configuration Baseline

```json
{
  "$schema": "./config.schema.json",
  "specsDir": "{projectRoot}/.sdw/specs",
  "scoreMin": 8,
  "scmCodeReviewEnabled": false,
  "pushDelivery": false,
  "changelogEnabled": true,
  "changelogFile": "{projectRoot}/CHANGELOG.md",
  "stateDir": "{projectRoot}/.sdw/state",
  "sandboxDir": "{projectRoot}/.sdw/sandbox",
  "autoResolveGaps": true,
  "securityChecksEnabled": false,
  "useWorktrees": false,
  "useFeatureBranches": false,
  "scmProvider": "none",
  "requiredBuild": false,
  "runAllTests": false,
  "reviewFixCommand": "",
  "maxPreemptions": 3
}
```

---

## 3. Subcommand Reference

### 3.1 `init`
- **Purpose**: Creates `.sdw/`, `.sdw/specs/`, `.sdw/state/`, `.sdw/config.json`, `.sdw/config.schema.json`, and `.sdw/directory-structure.md` in the target project root.
- **Flags**:
  - `--root <path>`: Explicit project root directory (defaults to current working directory).
  - `--skills-root <path>`: Explicit active skills directory; `SDW_SKILLS_ROOT` is honored when the flag is absent, and both take precedence over `.sdw/config.json` `skillsRoot`.
  - `--force`: Overwrites existing configuration and documentation files.
  - `--json`: Returns structured JSON summary of created and skipped files.
- **Exit Code**: Always `0` on success.

### 3.2 `check`
- **Purpose**: Validates presence of `.sdw/`, validates `config.json` against `config.schema.json` (syntax, required keys, types, value bounds), disk existence of `specsDir`, and presence of `directory-structure.md`.
- **Flags**:
  - `--root <path>`: Explicit project root directory.
  - `--skills-root <path>`: Optional explicit active skills directory override (falls back to `SDW_SKILLS_ROOT`, then `.sdw/config.json` `skillsRoot`, then auto-detection).
  - `--json`: Emits `{ "valid": boolean, "root": string, "skillsRoot": string, "skillsMode": string, "checks": [...], "errors": [...] }`.
- **Exit Code**: `0` when all checks pass; `1` if any check fails.

### 3.3 `parse`
- **Purpose**: Reads `.sdw/config.json`, substitutes tokens (e.g. `{projectRoot}`), and outputs the resolved configuration.
- **Flags**:
  - `--root <path>`: Explicit project root directory.
  - `--skills-root <path>`: Optional explicit active skills directory override (precedence: flag, then `SDW_SKILLS_ROOT`, then `.sdw/config.json` `skillsRoot`).
  - `--json`: Emits pure JSON formatted output including the resolved `projectRoot`, `skillsRoot`, and `skillsMode` (`canonical`, `local`, `global`, or `unknown`).
  - `--key <name>`: Extracts a single resolved configuration key.
- **Exit Code**: `0` on success; `1` on missing file, invalid JSON, or missing key.
