---
id: null
slug: 009-sdw-security-checks
title: "SDW Security Checks Skill — Configurable Pre-Commit Secrets & Leak Gate"
source: local
specDate: 2026-10-19
---

# Specification — SDW Security Checks Skill — Configurable Pre-Commit Secrets & Leak Gate

## Description

The SDW orchestrator creates git commits at two points in its state machine: the delivery commit (step 6) and the review-fix commit (step 7) inside `skills/sdw-implement/scripts/sdw_implement.cjs`. Today neither path performs any secret, credential, or PII inspection, so a leak can be committed into history before the code review step ever runs.

This specification introduces `skills/sdw-security-checks/`, a new first-class SDW skill ported from the global user skill `ws-secrets-leak-review` (`$HOME/.agents/skills/ws-secrets-leak-review`). The port preserves the leak-audit methodology — high/medium/low confidence model, secret pattern catalog, sensitive file inventory, `.gitignore` advisories, and `allowlist secret` false-positive pragma — while conforming to SDW standards: three-tier progressive disclosure and Node.js 22 standard library only, with no external binary dependency such as ripgrep.

The feature is opt-in through a new optional configuration key `securityChecksEnabled` (`boolean`, default `false`) in `.sdw/config.json`. While the key is `false` the workflow behaves exactly as today. When the key is `true`, the orchestrator resolves the configuration and runs the deterministic scanner immediately before every commit it creates; HIGH findings block the commit, MEDIUM findings warn, and any scanner execution failure blocks by default (fail-closed) so a broken scan is never reported as clean. An explicit `--skip-security` flag provides an auditable operator override recorded in the run state.

### Design Intent

Concentrate all secret/leak guardrails into one reusable, deterministic gate instead of scattering prompt-level reminders across skills. Defaulting the key to `false` keeps existing consumers unaffected and avoids surprising friction, while the fail-closed semantics and `allowlist secret` pragma keep the gate trustworthy enough to enforce unconditionally wherever enabled. The stdlib-only scanner guarantees identical behavior on any machine that already has Node and git, matching the repository rule that packaged skills carry zero runtime dependencies.

## Acceptance Criteria

- AC1: The system shall provide a canonical security checks skill at `skills/sdw-security-checks/` following the three-tier progressive disclosure layout.
- AC2: When the `sdw-security-checks` skill is loaded, the system shall output "sdw-security-checks loaded."
- AC3: The system shall support an optional `securityChecksEnabled` boolean property in `.sdw/config.json` that defaults to `false`.
- AC4: If `securityChecksEnabled` holds a non-boolean value, then the system shall fail configuration validation with a non-zero exit code.
- AC5: While `securityChecksEnabled` is `false`, the system shall skip the pre-commit security gate without interrupting the workflow.
- AC6: When the orchestrator reaches the delivery commit step while `securityChecksEnabled` is `true`, the system shall run the leak scan before staging or committing.
- AC7: When the orchestrator creates a review-fix commit while `securityChecksEnabled` is `true`, the system shall run the leak scan before staging or committing.
- AC8: If the leak scan reports HIGH severity findings, then the system shall block the commit and return a non-zero exit code.
- AC9: If the leak scanner cannot execute, then the system shall block the commit instead of reporting a clean result.
- AC10: When the leak scan reports MEDIUM severity findings, the system shall print them as warnings and allow the commit.
- AC11: The system shall implement the scanner using Node.js 22 standard library modules only, excluding external binaries such as ripgrep.
- AC12: Where `--skip-security` is supplied to the orchestrator, the system shall bypass the pre-commit security gate and record the bypass in the run state file.
- AC13: The system shall report each finding with file path, line number, pattern type, and severity without printing raw secret values.
- AC14: The system shall provide reference documentation cataloging secret patterns, sensitive file types, PII patterns, and the `allowlist secret` suppression pragma.
- AC15: Where the scan runs in staged mode, the system shall restrict detection to content staged for commit.
- AC16: The system shall register the `securityChecksEnabled` key in `.sdw/config.schema.json` and the configuration reference documentation.
- AC17: Where `--json` is supplied to the scanner, the system shall emit a machine-readable report of findings and exit status.
- AC18: Where the tracked repository omits recommended secret ignore patterns from `.gitignore`, the system shall emit advisory warnings without blocking.

## Original Issue Context

The specification originated from the user request to promote the global leak-review skill into a first-class SDW skill with an optional workflow gate:

> create a new spec to creating a new featured skill: inspire/copy global user skill ws-secrets-leak-review instructions to a new skill at skills/ sdw-security-checks that will be optionally integrated into pipeline workflow (if enabled in config.json) check config and do a secret/security check always before any commit in workflow.

## Notes

- Skill Architecture (`skills/sdw-security-checks/`):
  - **Tier 1 (`SKILL.md`)**: Announcement banner (`> When this skill is loaded, output "sdw-security-checks loaded."`), the read-only interactive audit procedure inherited from the source skill (bounded grep/glob budget, confidence model, report format, hard-stop rules), and routing for the `scan` subcommand.
  - **Tier 2 (`references/`)**:
    - `pattern_catalog.md`: Port of the source `REFERENCE.md` — API key/token patterns, database connection strings, cloud credential variables, PII shapes, sensitive file types, `.gitignore` recommendations, and the `allowlist secret` pragma.
    - `integration_contract.md`: Gate contract for the orchestrator — invocation signature, exit codes, severity policy, and bypass recording format.
  - **Tier 3 (`scripts/sdw_security_checks.cjs`)**:
    - Zero-dependency Node.js 22 CommonJS script; ports the logic of `secrets_scanner.cjs` from the source skill.
    - Subcommands/limited flags: `scan` (tracked worktree, ignore-aware), `scan --staged` (added lines of staged diff via `git diff --cached`), `--json`, `--fail-on high|medium`, `--root <dir>`.
    - Exit codes: `0` clean or advisory-only, `1` blocking findings present, `2` scanner failure (fail-closed signal for callers).
    - Env controls: `SECURITY_SCAN_MAX_HITS` (default `50`), `SECURITY_SCAN_IGNORE_PRAGMA` (default `allowlist secret`).
- Port Mapping and Deliberate Adaptations:

| Source artifact (`ws-secrets-leak-review`) | SDW target | Adaptation |
|---|---|---|
| `SKILL.md` Tier 1 audit procedure | `SKILL.md` | Compacted within the ≤ 120 line context budget; adds `scan` routing and gate semantics |
| `REFERENCE.md` pattern catalog | `references/pattern_catalog.md` | Patterns preserved verbatim; adds exit-code and pragma contract |
| `scripts/secrets_scanner.cjs` (ripgrep-dependent) | `scripts/sdw_security_checks.cjs` | Rewritten to Node stdlib regex scanning over git inventories; no `rg` requirement |
| `scripts/pre-commit.sh` + `scripts/install-hook.sh` (bash hook) | Not ported | Bash hook installation conflicts with the cross-platform Node standard; the workflow gate supersedes it |
| `evals/evals.json` | Optional `evals/evals.json` | Regression fixtures retained when available |

- Configuration Integration:
  - `skills/sdw-config/scripts/sdw_config.cjs`: add `securityChecksEnabled: false` to `DEFAULT_CONFIG`, the property definition to `DEFAULT_SCHEMA`, and a boolean validation branch.
  - `.sdw/config.schema.json`: add the `securityChecksEnabled` property with `"type": "boolean"` and `"default": false`.
  - `skills/sdw-config/references/config_spec.md`: add the property row to the supported properties table and default configuration baseline.
  - `.sdw/config.json` template: key stays omitted or explicit `false`; enabling is a consumer opt-in.
- Orchestrator Integration (`skills/sdw-implement/scripts/sdw_implement.cjs`):
  - `loadProjectConfig` fallback object gains `securityChecksEnabled: false`.
  - Step 6 (delivery commit): when enabled, invoke `node skills/sdw-security-checks/scripts/sdw_security_checks.cjs scan --staged --json` and abort before `git add -A` on exit code `1` or `2`.
  - Step 7 (review-fix commit): same gate applied before the automated fix commit.
  - New CLI flag `--skip-security`; when used, the run state records `securityGate: { bypassed: true, reason: "--skip-security" }`.
  - Step 6/7 state output records the structured scan summary (`severityCounts`, `findings`, `exitCode`).
- Cross-Skill References: `skills/sdw-implement/SKILL.md` cites the gate in step 4 of its workflow description; the future `sdw-router` skill routes secret-audit requests to `sdw-security-checks`.
- Portability & Packaging: included under `skills/` so it is discoverable and installable via `npx skills add <repo> --skill sdw-security-checks`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Git native pre-commit hook installer | The bash-based installer from the source skill conflicts with the cross-platform Node standard; the workflow gate covers managed commits |
| gitleaks / trufflehog integration | External binaries contradict the zero-dependency rule; both remain optional manual tools outside the gate |
| Dependency vulnerability or SBOM auditing | Scope is secrets and PII leak prevention, not package CVE scanning |
| Configurable severity threshold configuration key | Default HIGH-blocks/MEDIUM-warns policy satisfies the guardrail; revisit only on explicit consumer demand |
| Remote push protection (provider-side secret scanning) | Platform feature outside repository control |
| Scanning binary artifacts, archives, or git history backfill | Keeps the scanner deterministic, bounded, and dependency-free |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Feature default state | Disabled via `securityChecksEnabled: false` | Preserves current behavior for existing consumers; enabling is an explicit opt-in | y |
| Blocking severity policy | HIGH blocks, MEDIUM warns | Mirrors the source skill confidence model and limits false-positive friction | y |
| Scanner runtime | Node.js 22 standard library only | Repository rule forbids external runtime dependencies in packaged skills | y |
| External tool binaries | Not required for the gate | ripgrep and gitleaks stay optional manual aids, as in the source skill | y |
| Bypass mechanism | Explicit `--skip-security` flag | A deliberate, auditable override during incidents rather than a silent skip | y |
| Port reference source | `$HOME/.agents/skills/ws-secrets-leak-review` | User-designated reference implementation for the port | y |
| Staged scan strategy | Added lines of the staged diff | Matches the source hook behavior and avoids scanning untouched backlog noise | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` validates after the schema key addition | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature is tracked in `.sdw/specs/index.specs.md` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification adheres to canonical SDW standard and EARS syntax | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate .sdw/specs/009-sdw-security-checks.md --mode=authoring` |
| Source skill availability | Reference skill is readable for porting | Inspect `$HOME/.agents/skills/ws-secrets-leak-review` |
| Node runtime compatibility | Environment provides Node.js 22 or higher | Run `node -v` check |
| Clean repository state | Git working tree has no uncommitted corruption before implementation | Run `git status` check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Skill announcement banner: `sdw-security-checks loaded.`
- Orchestrator gate logs at step 6 and step 7, e.g. `[Step 6: Security Gate] securityChecksEnabled=true; running pre-commit leak scan`.
- Structured scanner report with HIGH/MEDIUM severity tables, plus `.gitignore` advisories.
- Scanner exit codes: `0` clean, `1` blocking findings, `2` scanner failure.
- Run state step output records `severityCounts`, `exitCode`, and the `securityGate` bypass object.
- Resolved configuration visible through `node skills/sdw-config/scripts/sdw_config.cjs parse --key securityChecksEnabled`.

### Negative & Failing Test Scenarios

- Blocked delivery commit: with a staged `AKIA...`-shaped string and security checks enabled, the gate must halt before `git add -A`, no new commit sha is produced, and step 6 remains not completed.
- Fail-closed scan error: when the scanner throws (e.g. invalid root or git unavailable), the gate must block the commit and must not print a clean-scan message.
- Invalid configuration: when `securityChecksEnabled` is set to the string `"true"`, `sdw_config.cjs check` must exit with code 1.
- Secret value leakage: when a finding is reported, the output must contain only file, line, and type — never the raw secret value.
- Suppressed false positive: a line containing the `allowlist secret` pragma must not produce any finding.
- Empty staged set: with no staged files in staged mode, the scanner must exit `0` with a "nothing to scan" notice and the orchestrator must continue using the existing commit sha.
