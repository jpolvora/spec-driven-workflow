---
id: null
slug: 00062-sdw-spec-issue-provider-sync
title: "SDW Spec-Issue Two-Way Sync with Registered Provider"
source: local
status: implemented
specDate: 2026-10-23
priority: medium
value: "Keeps local specs and remote tracker issues mirrored in both directions including status changes"
effort: M
---

# Specification — SDW Spec-Issue Two-Way Sync with Registered Provider

## Description

`sdw-spec import` pulls a remote tracker item into a local specification once and then stops: it is create-only and fails closed on duplicates. `sdw-spec sync` reconciles only local state: the index against on-disk files and orchestrator run states, never contacting the provider. There is no path that pushes local specification content or status changes back to the tracker, and no path that pulls remote edits or closures into existing local specifications. Reviews done in the tracker and edits done locally drift apart silently.

This specification adds two explicit directions under the registered provider (`scmProvider` in `.sdw/config.json`):

1. `sdw-spec sync-up` mirrors local specifications to remote tracker issues: it creates issues for specifications with a null `scmSpecId` and updates title, body, and state for specifications that already carry one, including status changes.
2. `sdw-spec sync-down` mirrors remote tracker items to local specifications: it creates local specifications for unmatched remote items and updates registry rows from remote state for matched ones, including status changes.

Each direction wins on its own run and never auto-merges body content: a body drift is reported and both sides are left untouched. Execution stays deterministic, dry-runnable, and provider-agnostic at the call site with all CLI syntax confined to the provider modules.

### Design Intent

Import proved the read path and the `scmSpecId`/`source` frontmatter anchor; this specification reuses both instead of inventing a second linkage. Splitting the sync into two named directions keeps precedence obvious (the named direction wins) and keeps each run reviewable in `--dry-run` before any write. Status mapping lives in one table so GitHub and Azure DevOps differ only in state vocabulary, and the slug marker embedded in created issue bodies makes the reverse match exact without title guessing.

## Acceptance Criteria

- AC1: The system shall provide a `sync-up` subcommand that mirrors local specifications to the registered provider.
- AC2: The system shall provide a `sync-down` subcommand that mirrors remote tracker items to local specifications.
- AC3: When the registered provider is `none`, the system shall refuse both directions with a non-zero exit naming the provider.
- AC4: When the provider CLI is missing or unauthenticated, the system shall exit non-zero naming the missing capability.
- AC5: When `sync-up` finds a local specification with a null `scmSpecId`, the system shall create a remote issue and persist the returned id in frontmatter.
- AC6: When `sync-up` finds a local specification with a non-null `scmSpecId`, the system shall update the remote title, body, and state from the local specification.
- AC7: The system shall map registry `completed` and `archived` to remote `closed` during `sync-up`.
- AC8: When `sync-down` finds a remote item with no matching local specification, the system shall create a local specification carrying the remote scmSpecId and source.
- AC9: When `sync-down` finds a remote item matching a local specification scmSpecId, the system shall update the registry row from the remote state without regressing completed rows.
- AC10: If local and remote disagree on body content, then the system shall report the drift and change neither side.
- AC11: The system shall embed the specification slug marker in every issue body created by `sync-up`.
- AC12: When `--dry-run` is supplied, the system shall print planned creates, updates, and status changes without contacting the provider.
- AC13: Where `--json` is supplied, the system shall emit the transition list with direction, action, and identifiers.
- AC14: While `sync-down` runs, the system shall keep the specification header as the authored-status source and change it only through the existing repair rule.
- AC15: The system shall document both directions with the status mapping table in skill docs.
- AC16: The system shall cover create, update, status mapping, dry-run, and disabled-provider cases with tests.
- AC17: The system shall treat the filename prefix as the immutable localSpecId.
- AC18: If a specification carries a legacy `id` key, then the system shall read it as scmSpecId during migration.

## Notes

- Status mapping lives in one table and nowhere else:

  | Local registry | `sync-up` remote state | Remote state | `sync-down` local effect |
  |---|---|---|---|
  | `pending` | `open` | `open` | `pending`, unless the row is `completed` or `archived`, which is reported skipped and never regressed |
  | `completed` | `closed` | `closed` | `completed`, with the header repaired through the existing header-drift rule |
  | `archived` | `closed` when still open | n/a | unchanged |

  Azure DevOps vocabulary maps onto the same table: `Done` reads as `closed`, every other work-item state reads as `open`; `sync-up` moves a finished specification to `Closed`.
- Identifier scheme: `localSpecId` is the five-digit filename prefix (mirrored in the registry Prefix column), assigned once at creation and never changed; `scmSpecId` is the remote tracker item id as a string, null while unlinked. `scmSpecId` replaces the legacy frontmatter `id` key: implementation renames the required key in `validate_spec.cjs`, updates every reader (`spec_index.cjs`, `spec_creator.cjs`, `sdw-ship-pr` issue-link lookup from spec 00051), and rewrites tracked files (`id:` to `scmSpecId:`, plus `localSpecId:` set to the file prefix). Until that migration lands, this and every other specification file keeps the current `id` key so authoring validation passes.
- The slug marker is an HTML comment on the first line of created issue bodies: `<!-- sdw-spec: <slug> -->`. It stays invisible in rendered views and gives `sync-down` an exact match before any title fallback. Matching order is frontmatter `scmSpecId` (legacy `id` accepted), then marker, then exact title.
- `sync-down` creation reuses the `import` duplicate guard: an item whose `scmSpecId` already has a specification is an update candidate, never a second file. The created file receives the next free prefix as its `localSpecId`.
- A specification with `source: local` and null `scmSpecId` is creatable by `sync-up`: on success its `source` becomes the registered provider name and its `scmSpecId` the returned item id, while `localSpecId` stays unchanged. Specifications whose `source` names a different provider than the registered one are reported skipped.
- `sync` (local-only reconciliation) keeps its current contract unchanged; the two new subcommands own every remote call.
- Implementation surfaces:
  - `skills/sdw-spec/scripts/providers/base.cjs`: `createWorkItem` and `updateWorkItem` on the provider contract, including body, title, and state transitions.
  - `skills/sdw-spec/scripts/providers/github.cjs`: `gh issue create`, `gh issue edit`, `gh issue close` and reopen adapters behind the new contract methods.
  - `skills/sdw-spec/scripts/providers/ado.cjs`: `az boards` work-item create and update adapters behind the same contract methods.
  - `skills/sdw-spec/scripts/scm_provider_contract.cjs`: capability check reuse (`checkScmCapability`) plus the new method exports.
  - `skills/sdw-spec/scripts/spec_sync_remote.cjs` (new): direction planners producing a transition list, dry-run printer, JSON emitter, and appliers that write frontmatter ids, registry rows, and created files.
  - `skills/sdw-spec/scripts/sdw_spec.cjs`: `sync-up` and `sync-down` subcommands with `--dry-run`, `--json`, and `--provider` override.
  - `skills/sdw-spec/SKILL.md`, `skills/sdw-spec/references/scm_contract.md`: directions, marker format, and the status mapping table.
  - `tests/sdw_spec_sync_remote.test.cjs` (new): create on null id, update on existing id, both status directions, no-regress guard, body-drift report, dry-run purity, disabled-provider refusal, all against an injected fake executor.
- All new logic is Node.js 22 CommonJS standard library only, with no new runtime dependency. Provider tests inject a fake executor instead of calling `gh` or `az`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Merge-time closing keywords in pull request bodies | Owned by spec 00051; sync changes tracker state directly instead of referencing it. |
| Issue comments, labels, assignment, or attachments | State and content mirroring is the contract; tracker workflow beyond it is repository policy. |
| Deleting remote issues or local specifications | Destructive mirroring is never implicit; removal stays a manual operator act. |
| Automatic body merges on drift | The named direction wins for its own fields; conflicting bodies are reported, never blended. |
| Changing local-only `sync` semantics | The existing index, disk, and run-state reconciliation keeps its contract untouched. |
| A daemon or scheduled sync | Both directions run only on explicit operator invocation. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Identifier split | `localSpecId` is the prefix, `scmSpecId` is the tracker item | Local identity is stable across renames; remote identity belongs to the provider. | y |
| Provider transport | Installed `gh` and `az` CLIs through the existing provider modules | The contract already shells to these CLIs; no REST client is added. | y |
| Direction precedence | The invoked direction wins for the fields it owns | Explicit runs stay predictable; silent two-sided merges do not. | y |
| Body drift policy | Report only, change neither side | Content conflicts need a human decision, not a heuristic. | y |
| Completed regression guard | Remote `open` never reopens a `completed` or `archived` row | Delivery evidence on disk outranks a tracker state that may lag behind it. | y |
| Marker format | First-line HTML comment `<!-- sdw-spec: <slug> -->` | Invisible when rendered, exact when matched. | y |
| Disabled provider | Refuse non-zero naming `none` | Mirroring without a registered provider is a configuration error, not a no-op. | y |
| Runtime dependencies | Node.js 22 standard library only | Repository policy forbids runtime npm dependencies in packaged skills. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is valid with `scmProvider` resolving | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Provider baseline | `fetchWorkItem` and `queryWorkItems` read paths inspected for both providers | Read `skills/sdw-spec/scripts/providers/github.cjs` and `ado.cjs` |
| Sync baseline | Local-only reconciliation and header-drift repair inspected | Read `skills/sdw-spec/scripts/spec_sync.cjs` |
| Import guard baseline | Duplicate-import refusal and `id`/`source` persistence inspected | Read `skills/sdw-spec/scripts/spec_creator.cjs` |
| Identifier migration baseline | Required frontmatter keys and every `id` reader located | Read `validate_spec.cjs` required keys, `spec_index.cjs` parsing, and the spec 00051 ship-pr lookup |
| Specification index | Row `062` registered as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list --status pending` and inspect the row |
| Authoring standard | Specification passes canonical SDW authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00062-sdw-spec-issue-provider-sync.md` |
| Test baseline | Existing `node:test` suite passes before changes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `sync-up --dry-run` prints one line per planned action, e.g. `[sync-up dry-run] create issue for 00062-sdw-spec-issue-provider-sync` and `[sync-up dry-run] close #47 from registry completed`.
- `sync-down --json` emits `{ direction, transitions: [{ action, slug, id, from, to }] }` with exit `0`.
- Registry transitions record the remote evidence (`issue #47 closed`, `work item 12 Done`) in the reason field.
- Capability refusal names the cause: `SCM provider is disabled (none)` or the missing CLI and login command.

### Negative & Failing Test Scenarios

- Disabled provider: `sync-up` with `scmProvider: none` exits non-zero and changes no file and creates no issue.
- Unauthenticated CLI: missing `gh` auth exits non-zero before any plan is applied.
- Null-id create: a local specification with null `scmSpecId` yields one created issue and the returned id persisted in frontmatter; a second `sync-up` updates instead of creating again.
- No-regress guard: a `completed` registry row facing a remote `open` state stays `completed` with a `skipped` transition recorded.
- Body drift: differing local and remote bodies produce a drift report with both sides unchanged.
- Unknown remote item on `sync-down`: an item with no id, marker, or title match is reported unmatched and creates nothing.
- Cross-provider skip: a specification with `source: azure-devops` under registered `github` is reported skipped without remote calls.
- Legacy id: a specification carrying only the old `id` key matches and syncs as if it carried `scmSpecId`, with no duplicate created.
