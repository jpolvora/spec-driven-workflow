---
id: null
slug: 00012-scm-provider-selection
title: "SCM Provider Selection — Explicit GitHub/Azure DevOps Routing with Safe Disable"
source: local
status: implemented
specDate: 2026-10-19
---

# Specification — SCM Provider Selection — Explicit GitHub/Azure DevOps Routing with Safe Disable

## Description

SCM integration in SDW is currently implicit and permissive. `.sdw/config.json` carries a single `scmCodeReviewEnabled` boolean, `skills/sdw-spec/scripts/scm_provider_contract.cjs` exposes a `createScmProvider(providerName)` factory that accepts several aliases (`gh`, `az`, `azure-devops`, `azure_devops`), and `sdw-orch` step 8 enables PR polling from the boolean alone. Nothing prevents an agent from reaching for whichever CLI happens to exist on the machine, and nothing declares which SCM the operator actually wants to use.

This specification introduces the explicit provider selector `scmProvider` in `.sdw/config.json`:

```json
{
  "scmProvider": "none",
  "scmCodeReviewEnabled": false
}
```

- `none` (default): SCM integration is disabled. Every SCM-dependent operation is skipped or ignored where applicable, and the skip is reported to the user. The workflow proceeds with local-only behavior; no CLI is probed for execution beyond the capability report.
- `ado`: only the Azure DevOps implementation of the unified SCM contract is used, exclusively through the `az` CLI — importing and fetching issues/user stories (`az boards`) and polling pull request review comments (`az repos`). The `gh` CLI is never invoked.
- `github`: only the GitHub implementation is used, exclusively through the `gh` CLI — importing and loading specifications from issues and querying pull request results. The `az` CLI is never invoked.

The orchestrator (`sdw-orch`) resolves the provider at run start, honors it in step 8 PR/review polling, and records the resolution in run state. Preconditions are checked before any SCM call: the CLI must be installed and authenticated. When the configured provider is unavailable, the system reports an actionable error to the user and never installs, authenticates, reconfigures, auto-replaces, or auto-fixes anything, and never falls back to the other provider.

### Design Intent

Make SCM usage explicit, deterministic, and boring: one key selects exactly one provider, one CLI per provider, and absence of a working provider degrades into a reported skip instead of improvisation. The safe default `none` means existing consumers and public clones never trigger credentialed CLI calls, while the strict one-provider rule removes ambiguity about which story tracker or PR system is authoritative. Capability checks are report-only by design — resolving environment problems is the operator's decision, not the agent's.

## Acceptance Criteria

- AC1: The system shall support the `scmProvider` property in `.sdw/config.json` with allowed values `none`, `ado`, and `github`, defaulting to `none`.
- AC2: If `scmProvider` holds a value outside the allowed set, then the system shall reject configuration validation with a non-zero exit code.
- AC3: While `scmProvider` is `none`, the system shall skip SCM-dependent operations and report the skip to the user.
- AC4: When `scmProvider` is `github`, the system shall route all issue and pull request operations exclusively through the `gh` CLI.
- AC5: When `scmProvider` is `ado`, the system shall route all work item and pull request operations exclusively through the `az` CLI.
- AC6: The system shall never invoke an SCM CLI that does not match the configured `scmProvider`.
- AC7: When `sdw-spec import` executes without an explicit provider argument, the system shall resolve the provider from the `scmProvider` configuration value.
- AC8: Where an explicit provider argument is supplied to import, the system shall reject values outside the allowed set with a non-zero exit code.
- AC9: While `scmProvider` is `none`, the system shall reject SCM import operations with an actionable message instructing how to enable a provider.
- AC10: If the configured provider CLI is not installed, then the system shall report an actionable error and skip the SCM operation.
- AC11: If the configured provider CLI is not authenticated, then the system shall report an actionable error and skip the SCM operation.
- AC12: The system shall never install, authenticate, or reconfigure an SCM CLI on behalf of the user.
- AC13: If the configured provider is unavailable, then the system shall not fall back to another provider.
- AC14: When the orchestrator performs PR review polling while `scmCodeReviewEnabled` is true, the system shall poll using the resolved `scmProvider`.
- AC15: While `scmProvider` is `none`, the orchestrator shall report that polling is disabled instead of executing the polling loop.
- AC16: When `sdw-config check` executes, the system shall validate the `scmProvider` value and report provider CLI presence and authentication status.
- AC17: The system shall record the resolved provider, skip reasons, and SCM errors in the run state file.
- AC18: The system shall register `scmProvider` in `.sdw/config.schema.json` and in the configuration reference documentation.
- AC19: If an SCM-dependent import operation cannot execute, then the system shall fail with a non-zero exit code and an actionable message.
- AC20: When an auxiliary SCM step is skipped due to provider unavailability, the system shall continue the workflow while recording the reason in the run state.

## Original Issue Context

The specification originated from the user request to make SCM usage explicit and safe:

> add config.json new options: scmProvider: "none" default, allowed options: none, ado, github. Honor the configured scm provider in orchestrator sdw-orch in the PR / review polling. When ado is configured, it will only use azure devops implementation of contracts: when importing/fetching issues/user stories/polling pull request code-review for comments to solve. Else if github is set, it will only try to import/load/query specs and PR results via gh client. In case of none, the scm integration is effectively disabled, it will be skipped/ignored where is applicable and reported to the user: github error/not installed/not authenticated. check config and cli tools installed. same for ado (uses az client). Do not use other cli/scm that is not configured to use. do not try to auto replace. do not try to fix. report user.

## Notes

- Configuration Integration:
  - `skills/sdw-config/scripts/sdw_config.cjs`: add `scmProvider: 'none'` to `DEFAULT_CONFIG`, an enum property definition to `DEFAULT_SCHEMA`, and a validation branch accepting exactly `none`, `ado`, or `github`.
  - `.sdw/config.schema.json`: add `"scmProvider": { "type": "string", "enum": ["none", "ado", "github"], "default": "none" }`.
  - `skills/sdw-config/references/config_spec.md`: add the property row and update the default configuration baseline.
- Key Interaction Rule: PR polling executes only when `scmCodeReviewEnabled` is `true` and `scmProvider` is not `none`. The provider key never upgrades or downgrades the polling toggle; `none` short-circuits it with a report.
- Provider Resolution (`skills/sdw-spec/scripts/scm_provider_contract.cjs`):
  - New helper `resolveScmProvider({ config, explicit })` returning `{ provider, name, reason }` or an actionable error; `none` resolves to a disabled sentinel that callers must handle explicitly.
  - `createScmProvider` remains the constructor for `github` and `ado` only; the config-facing values are the strict set while internal aliases stay for backward call sites.
  - Resolution precedence: explicit `--provider` flag, then `scmProvider` config value, then `none` default.
- Capability Checks (report-only):
  - CLI presence: `where gh` / `where az` on Windows, `command -v` on POSIX.
  - Authentication: `gh auth status` for GitHub, `az account show` for Azure DevOps.
  - `sdw-config check` reports each probe result; when the configured provider fails a probe, the check exits non-zero with the reason, and never attempts login, installation, or configuration changes.
- Import Integration (`skills/sdw-spec/scripts/sdw_spec.cjs import`):
  - Resolves provider through `resolveScmProvider`; `none` produces the actionable enablement message; uninstalled or unauthenticated CLI produces the corresponding report and exits non-zero.
- Orchestrator Integration (`skills/sdw-orch/scripts/sdw_orch.cjs` step 8):
  - At run start, resolve provider once and persist `scmProvider` plus capability results in run state.
  - Polling loop: `none` logs `SCM polling skipped (scmProvider: none)`; `github` uses `gh pr view`/`gh api` review-thread queries; `ado` uses `az repos pr show` and review-comment queries.
  - Unavailable provider during an auxiliary poll skips with a recorded error; the workflow continues (imports, by contrast, fail hard).
  - Match behavior to spec 011's review workflow: unresolved review threads remain the merge gate, resolved through the configured provider only.
- Run State Additions: `scm: { provider, resolvedFrom, cliInstalled, cliAuthenticated, skipped, skipReason, errors[] }`.
- Provider-Specific Operation Map:

| Operation | `github` | `ado` |
|---|---|---|
| Fetch work item / user story | `gh issue view --json` | `az boards work-item show --output json` |
| Query work items | `gh issue list --json` | `az boards query --wiql` |
| PR review comments | `gh pr view --json` / `gh api` review threads | `az repos pr show` / PR thread queries |
| Authentication probe | `gh auth status` | `az account show` |

- Test Coverage: extend `tests/sdw_config.test.cjs` with `scmProvider` validation cases and add resolver tests covering `none`, explicit override, and unavailable-CLI reporting.

## Out of Scope

| Feature | Reason |
|---------|--------|
| GitLab, Bitbucket, or generic REST providers | Allowed set is strictly `none`, `ado`, `github` per the requirement |
| Automatic installation, authentication, or repair of `gh`/`az` | Environment mutation is the operator's decision; the system only reports |
| Automatic provider fallback when the configured CLI is unavailable | Silent fallback would violate the single-provider determinism requirement |
| Remote push, PR creation, or merge automation outside the existing workflow scope | SCM-facing automation beyond import and review polling remains out of scope |
| Caching or persisting SCM credentials beyond the CLI's own store | Credential management stays with the vendor CLI |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default provider | `none` | Disabled-by-default keeps clones, forks, and offline runs free of credentialed CLI calls | y |
| CLI mapping | `github` → `gh`, `ado` → `az` | Matches the existing contract implementations in `scm_provider_contract.cjs` | y |
| Config value strictly lowercase | `none`, `ado`, `github` | Deterministic validation; internal alias handling stays out of configuration | y |
| `scmCodeReviewEnabled` retained | Kept as the polling toggle | Avoids removing an existing key; interaction rule documented instead | y |
| Import failure semantics | Hard failure with non-zero exit | Imports produce specifications; silent skips would corrupt the workflow | y |
| Auxiliary polling failure semantics | Skip and continue with recorded reason | Polling is auxiliary and must not block delivery | y |
| Capability check scope | Presence plus authentication probe only | Sufficient for actionable reporting without mutating the environment | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature is tracked in `.sdw/specs/index.specs.md` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification adheres to canonical SDW standard and EARS syntax | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate .sdw/specs/00012-scm-provider-selection.md --mode=authoring` |
| Contract baseline | `scm_provider_contract.cjs` provides the GitHub and Azure DevOps providers | Inspect `skills/sdw-spec/scripts/scm_provider_contract.cjs` |
| Orchestrator baseline | `sdw_orch.cjs` step 8 reads `scmCodeReviewEnabled` for polling | Inspect `skills/sdw-orch/scripts/sdw_orch.cjs` around step 8 |
| CLI availability (optional) | `gh` and/or `az` presence is detected for report verification | Run `where gh` and `where az` (Windows) or `command -v` (POSIX) |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Configuration resolution output: `node skills/sdw-config/scripts/sdw_config.cjs parse --key scmProvider`.
- Capability report lines, e.g. `scmProvider=github cli=gh installed=true authenticated=true`.
- Skip notices, e.g. `SCM polling skipped (scmProvider: none)` and `SCM import disabled: set scmProvider to "github" or "ado"`.
- Provider usage logs naming the exact CLI command executed for each SCM operation.
- Run state `scm` object recording provider, resolution source, capability results, and errors.

### Negative & Failing Test Scenarios

- Invalid provider value: when `scmProvider` is set to `gitlab` or `GitHub` (case variant), `sdw_config.cjs check` must exit with code 1 naming the allowed set.
- Disabled provider import: with `scmProvider: none`, `sdw_spec.cjs import --id 42` must fail with the actionable enablement message and must not invoke `gh` or `az`.
- Missing CLI: with `scmProvider: github` and `gh` absent from PATH, capability checks must report the missing CLI and the import must exit non-zero without attempting `az`.
- Unauthenticated CLI: with the CLI installed but not authenticated, the probe must report the authentication failure and no SCM call may be executed.
- No cross-provider fallback: with `scmProvider: ado` and a working `gh` installation, the system must never execute `gh` commands.
- Polling disabled by provider: with `scmCodeReviewEnabled: true` and `scmProvider: none`, the orchestrator must log the disabled notice, record the skip in run state, and complete the run without polling.
