---
id: null
slug: 00016-sdw-scm-delivery-intents
title: "SDW SCM Delivery Intents — GitHub and Azure DevOps Pull Request Lifecycle"
source: local
status: abandoned
specDate: 2026-10-19
priority: low
value: "Superseded by 00024, 00050, and 00051; keep only as the abandoned design record"
effort: M
---
# Specification — SDW SCM Delivery Intents — GitHub and Azure DevOps Pull Request Lifecycle

## Description

`sdw-orch` Step 8 currently assembles a pull request payload object and optionally pushes the active branch. It does not create a pull request, comment on the tracker, resolve review threads, triage failing checks, or merge. Spec 012 introduced explicit GitHub and Azure DevOps provider selection for specification import, but it does not define or implement delivery operations. The result is that the pipeline stops at a local commit and cannot close the loop from verified implementation to merged pull request.

This specification defines a named SCM delivery intent contract shared by the GitHub and Azure DevOps providers, and wires those intents into Step 8. The intent set is: `validate-auth`, `create-pr`, `list-threads`, `resolve-thread`, `comment-issue`, `close-issue`, `check-pr-status`, and `merge-pr`. Orchestrators call intents by name; provider-specific CLI recipes remain inside each provider adapter. Every intent supports a dry-run mode where remote mutation is possible.

### Design Intent

Keep the orchestrator provider-agnostic and make both supported SCM backends interchangeable. A named intent contract prevents `gh` and `az` commands from leaking into orchestration logic, makes parity testable, and lets a consumer disable remote delivery without changing the pipeline. Idempotent pull request creation and explicit tracker transitions avoid duplicate PRs and stale issues. Dry-run behavior makes the contract safe to exercise in local review.

## Acceptance Criteria

- AC1: The system shall define named SCM delivery intents `validate-auth`, `create-pr`, `list-threads`, `resolve-thread`, `comment-issue`, `close-issue`, `check-pr-status`, and `merge-pr`.
- AC2: The system shall implement every delivery intent for both the `github` and `azure-devops` providers.
- AC3: The system shall select the active SCM provider from `scmProvider` in `.sdw/config.json`.
- AC4: If provider authentication validation fails, then the system shall stop without falling back to another provider.
- AC5: When `create-pr` executes, the system shall reuse an existing open pull request for the same head and base branches.
- AC6: When `create-pr` executes for a tracker-linked specification, the system shall include `Closes #<id>` in the pull request body.
- AC7: When `create-pr` executes with `--dry-run`, the system shall print the payload without mutating the remote.
- AC8: When `list-threads` executes, the system shall return structured review threads with an active-thread count.
- AC9: When `resolve-thread` executes with `--dry-run`, the system shall skip remote mutation.
- AC10: When `check-pr-status` executes, the system shall classify each failing check as `diff-regression`, `baseline`, or `infra-flake`.
- AC11: The system shall allow at most one rerun for a check classified as `infra-flake`.
- AC12: When `merge-pr` executes, the system shall wait for required checks before merging.
- AC13: The system shall not delete the configured working branch during merge.
- AC14: When Step 8 executes with remote delivery enabled, the system shall call `create-pr` and record the pull request URL in run state.
- AC15: When a pull request is created, the system shall call `comment-issue` with the pull request URL and summary.
- AC16: When a pull request is merged, the system shall call `close-issue` for the linked tracker item.
- AC17: The system shall provide a provider parity test that fails when an intent is missing from either provider.
- AC18: The system shall expose delivery intents through `sdw-orch scm <intent>` with `--json` output.
- AC19: If a delivery intent fails, then the system shall record the failure in run state and leave the specification status unchanged.
- AC20: The system shall document each intent, its inputs, outputs, and dry-run behavior in the SCM provider contract.

## Notes

- Implementation surfaces:
  - `skills/sdw-orch/scripts/scm_intents.cjs` (new): intent dispatcher, argument normalization, dry-run handling, and structured results.
  - `skills/sdw-orch/scripts/providers/github.cjs` and `providers/azure_devops.cjs` (new): provider adapters using `gh` and `az` respectively.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: Step 8 calls `create-pr`, `comment-issue`, and records the PR URL; optional thread and merge commands are exposed through the `scm` subcommand.
  - `skills/sdw-orch/references/scm_delivery_contract.md` (new): canonical intent table and payload schemas.
  - `.sdw/config.json` / `config.schema.json`: `scmProvider`, `scmRemoteDelivery`, `scmMergePolicy`, and `scmCheckTimeoutMs`.
- Intent contract (inputs → outputs):
  - `validate-auth` → `{ provider, authenticated, account }`; stop on failure.
  - `create-pr` → `{ number, url, head, base, reused }`; idempotent per head/base.
  - `list-threads` → `{ threads: [{ id, path, line, body, resolved }], activeCount }`.
  - `resolve-thread` → `{ threadId, resolved }`; dry-run skips mutation.
  - `comment-issue` → `{ issueId, commentUrl }`; no-op for local specs.
  - `close-issue` → `{ issueId, state }`; explicit transition after merge.
  - `check-pr-status` → `{ checks: [{ name, status, classification }], failures }`.
  - `merge-pr` → `{ merged, method, sha }`; waits for required checks.
- Step 8 flow: validate auth → create or reuse PR → comment tracker → record URL and state `shipStatus` → optionally wait for checks → optionally resolve threads → merge when configured → close linked issue.
- Dry-run must never call a mutating provider command. Provider adapters return the exact command, arguments, and payload that would be used.
- Merge policy: `manual` (default) stops after PR creation; `auto` waits for checks and merges. Branch deletion is always disabled.
- Failure policy: intent failures are recorded in `state.errors` with intent name, provider, exit code, and redacted stderr; the run status becomes `failed` unless the caller explicitly allows continuation.
- Tests: add provider parity coverage and adapter tests with fake executors. Cover PR reuse, `Closes` body, dry-run, thread listing/resolution, CI classification, one-flake rerun, merge gating, and tracker transitions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| CI workflow authoring and GitHub Actions distribution | Tracked by spec 011 |
| Reviewer assignment, labels, milestones, and PR templates | Delivery contract covers lifecycle operations only |
| Merge queues and multi-repository releases | Deferred until single-repository delivery is stable |
| Release tagging, changelog publication, and deployment | Separate release-management concern |
| Replacing provider CLIs with direct HTTP APIs | `gh` and `az` remain the supported host tooling |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Active provider source | `scmProvider` in `.sdw/config.json` | Spec 012 already established explicit provider selection | y |
| Provider tooling | `gh` for GitHub and `az` for Azure DevOps | Matches the existing import adapters and host prerequisites | y |
| Default merge policy | `manual` | A human or caller decides when to merge unless automation is explicitly enabled | y |
| Branch deletion | Never delete the working branch | Prevents loss of local delivery context and matches safe defaults | y |
| Dry-run scope | All remote-mutating intents | Makes local review and tests safe | y |
| Tracker linkage | Specification `id` field | Existing frontmatter already carries the tracker id | y |
| Failure handling | Record and fail the run | Silent provider fallback hides configuration errors | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Provider selection | Spec 012 provider configuration implemented and valid | Inspect `.sdw/config.json` and run `sdw-config check` |
| Implementation execution | Spec 015 execution contract available for Step 4 | Run the spec 015 test suite |
| Provider authentication | `gh auth status` or `az account show` succeeds for the configured provider | Execute the provider CLI status command |
| Workspace configuration | `.sdw/config.json` valid with `scmProvider` | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | This specification registered as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | This specification passes canonical authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00016-sdw-scm-delivery-intents.md` |
| Test baseline | Existing `node:test` suite passes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output for each intent, e.g. `[SCM] create-pr -> #42 https://... (reused=false)`.
- Run state contains `pullRequest.number`, `pullRequest.url`, `pullRequest.head`, `pullRequest.base`, and `shipStatus`.
- `list-threads` reports an `activeCount` that reaches zero after resolution.
- `check-pr-status` classifies every failing check and records at most one flake rerun.
- Tracker comment and close transitions are visible in the provider UI and recorded in state.
- Dry-run output contains the provider command and payload with no remote mutation.

### Negative & Failing Test Scenarios

- Authentication failure: `validate-auth` fails and the run stops without trying the other provider.
- Missing intent: the parity test fails when one provider omits an intent.
- Duplicate PR: `create-pr` reuses an open PR for the same head/base instead of creating another.
- Thread resolution failure: a provider error is recorded and the thread remains active.
- Flake rerun limit: a second `infra-flake` failure is reported instead of rerun again.
- Merge blocked: required checks failing prevent merge and leave the PR open.
- Missing tracker id: `comment-issue` and `close-issue` are skipped for local specifications without failing the run.
- Dry-run mutation: a fake executor that detects a mutating call fails the test.
