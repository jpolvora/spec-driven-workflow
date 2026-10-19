# .sdw Configuration & Directory Structure Reference

## 1. Directory Structure

Consumer projects following the Spec-Driven Workflow (SDW) standard store project-level workflow assets inside the `.sdw/` folder located at the project root:

```text
{projectRoot}/
└── .sdw/
    ├── config.json              # Main project workflow configuration
    ├── directory-structure.md   # Structural guidelines and layout rules
    └── specs/                   # Target directory for canonical specifications
```

### 1.1 Components

- **`.sdw/config.json`**: Primary JSON configuration file defining paths and behaviors for SDW skills and tools.
- **`.sdw/directory-structure.md`**: Textual specification and inventory of the directory hierarchy.
- **`.sdw/specs/`**: Default repository for `.spec.md` feature specifications.

---

## 2. Configuration Schema (`config.json`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "SDWConfig",
  "type": "object",
  "required": ["specsDir"],
  "properties": {
    "specsDir": {
      "type": "string",
      "description": "Path to the directory containing feature specifications. Supports token {projectRoot}."
    }
  },
  "additionalProperties": true
}
```

### 2.1 Supported Path Tokens

- `{projectRoot}`: Replaced by the absolute, forward-slash normalized path of the consumer project root (e.g., `C:/projects/my-app` or `/home/user/my-app`).

### 2.2 Default Configuration

```json
{
  "specsDir": "{projectRoot}/.sdw/specs"
}
```

---

## 3. Subcommand Reference

### 3.1 `init`
- **Purpose**: Creates `.sdw/`, `.sdw/specs/`, `.sdw/config.json`, and `.sdw/directory-structure.md` in the target project root.
- **Flags**:
  - `--root <path>`: Explicit project root directory (defaults to current working directory).
  - `--force`: Overwrites existing `config.json` and `directory-structure.md`.
  - `--json`: Returns structured JSON summary of created and skipped files.
- **Exit Code**: Always `0` on success.

### 3.2 `check`
- **Purpose**: Validates presence and integrity of `.sdw/` directory, JSON syntax of `config.json`, presence of required `specsDir` property, disk existence of `specsDir`, and presence of `directory-structure.md`.
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
