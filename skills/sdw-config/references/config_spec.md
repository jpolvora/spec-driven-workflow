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
      "description": "Path to the directory containing feature specifications. Supports token {projectRoot}.",
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
    "stateDir": {
      "type": "string",
      "description": "Path to the directory storing run session state files. Supports token {projectRoot}.",
      "default": "{projectRoot}/.sdw/state"
    },
    "autoResolveGaps": {
      "type": "boolean",
      "description": "Automatically apply recommended defaults for unhandled grilling gaps when running non-interactively.",
      "default": true
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
    }
  },
  "additionalProperties": true
}
```

### 2.1 Supported Properties

| Key | Type | Default | Description |
|:---|:---|:---|:---|
| `$schema` | `string` | `"./config.schema.json"` | Schema definition reference for editor autocomplete and validation |
| `specsDir` | `string` | `"{projectRoot}/.sdw/specs"` | Path to specifications directory (supports `{projectRoot}`) |
| `scoreMin` | `integer` | `8` | Minimum acceptable conformance score (range: 0–10) |
| `scmCodeReviewEnabled` | `boolean` | `false` | Whether remote PR comment polling and automated fix resolution loop is active |
| `pushDelivery` | `boolean` | `false` | Whether to automatically push delivery commits to remote origin |
| `stateDir` | `string` | `"{projectRoot}/.sdw/state"` | Path to isolated execution run state directory (supports `{projectRoot}`) |
| `autoResolveGaps` | `boolean` | `true` | Whether to auto-apply recommended grilling defaults when non-interactive |
| `requiredBuild` | `boolean` | `false` | Enforce successful build verification in Step 8 before creating delivery commit or PR |
| `buildCommand` | `string` | `"npm run build"` | Command to execute for build verification |
| `runAllTests` | `boolean` | `false` | Enforce passing all test suites in Step 8 before creating delivery commit or PR |
| `testCommand` | `string` | `"npm test"` | Command to execute for test verification pass |
| `prePrCommand` | `string` | `""` | Optional project-specific shell command to execute before PR preparation |
| `prePrInstructions` | `string` | `""` | Optional project-specific instructions or checklist for agents to verify prior to PR |

### 2.2 Supported Path Tokens

- `{projectRoot}`: Replaced by the absolute, forward-slash normalized path of the consumer project root (e.g., `C:/projects/my-app` or `/home/user/my-app`).

### 2.3 Default Configuration Baseline

```json
{
  "$schema": "./config.schema.json",
  "specsDir": "{projectRoot}/.sdw/specs",
  "scoreMin": 8,
  "scmCodeReviewEnabled": false,
  "pushDelivery": false,
  "stateDir": "{projectRoot}/.sdw/state",
  "autoResolveGaps": true,
  "requiredBuild": false,
  "runAllTests": false
}
```

---

## 3. Subcommand Reference

### 3.1 `init`
- **Purpose**: Creates `.sdw/`, `.sdw/specs/`, `.sdw/state/`, `.sdw/config.json`, `.sdw/config.schema.json`, and `.sdw/directory-structure.md` in the target project root.
- **Flags**:
  - `--root <path>`: Explicit project root directory (defaults to current working directory).
  - `--force`: Overwrites existing configuration and documentation files.
  - `--json`: Returns structured JSON summary of created and skipped files.
- **Exit Code**: Always `0` on success.

### 3.2 `check`
- **Purpose**: Validates presence of `.sdw/`, validates `config.json` against `config.schema.json` (syntax, required keys, types, value bounds), disk existence of `specsDir`, and presence of `directory-structure.md`.
- **Flags**:
  - `--root <path>`: Explicit project root directory.
  - `--json`: Emits `{ "valid": boolean, "root": string, "checks": [...], "errors": [...] }`.
- **Exit Code**: `0` when all checks pass; `1` if any check fails.

### 3.3 `parse`
- **Purpose**: Reads `.sdw/config.json`, substitutes tokens (e.g. `{projectRoot}`), and outputs the resolved configuration.
- **Flags**:
  - `--root <path>`: Explicit project root directory.
  - `--json`: Emits pure JSON formatted output.
  - `--key <name>`: Extracts a single resolved configuration key.
- **Exit Code**: `0` on success; `1` on missing file, invalid JSON, or missing key.
