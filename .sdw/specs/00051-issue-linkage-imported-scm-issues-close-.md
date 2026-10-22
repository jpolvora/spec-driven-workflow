---
id: null
slug: 00051-issue-linkage-imported-scm-issues-close-
title: "issue linkage: imported SCM issues close automatically when the implementing pull request references the source item id"
source: local
status: implemented
specDate: 2026-10-22
---

# Specification — issue linkage: imported SCM issues close automatically when the implementing pull request references the source item id

## Description

`sdw-spec import` already persists the tracker item id (`id`) and provider (`source`) in the specification frontmatter and rejects a second import of the same item. The linkage stops there: `sdw-ship-pr` assembles the pull request body from git context (`buildPrBody` in `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs`), and that body never names the source item, so merging the pull request leaves the issue open. This specification closes the loop: the imported id is visible in the specification, and every pull request that delivers that specification carries the provider-specific closing keyword.

### Design Intent

A tracker id that is recorded but never referenced downstream is dead metadata. The provider already knows how to close an item when a merged pull request names it, so the product only has to emit the reference in the body it already builds. The change stays provider-agnostic at the call site and confines syntax to one mapping table.

## Acceptance Criteria

- AC1: The system shall persist the imported tracker item id in the specification frontmatter `id` field and the provider in the `source` field.
- AC2: When `sdw-spec import` writes a specification, the system shall render one line naming the provider and item id under `## Notes`.
- AC3: When `sdw-ship-pr` assembles a pull request body for a specification whose `id` is not null and whose `source` is `github`, the system shall include `Closes #<id>` in the body.
- AC4: When `sdw-ship-pr` assembles a pull request body for a specification whose `id` is not null and whose `source` is `azure-devops`, the system shall include `Fixes AB#<id>` in the body.
- AC5: When the specification `id` is null or the `source` is `local`, the system shall omit the closing keyword and every placeholder for it.
- AC6: When `sdw-ship-pr` reuses an existing open pull request, the system shall ensure the closing keyword appears exactly once in the body.
- AC7: When `--dry-run` is supplied, the system shall print the assembled body with the closing keyword without creating or editing a pull request.
- AC8: The system shall record `issueLink` in the JSON report with the fields `id`, `provider`, `keyword`, and `present`.
- AC9: If the specification file cannot be read or the provider is unsupported, then the system shall omit the closing keyword, record `issueLink.present` as `false`, and continue the ship without failing it.
- AC10: The system shall document the frontmatter `id`/`source` contract and the close-keyword mapping in `skills/sdw-spec/SKILL.md` and `skills/sdw-ship-pr/references/ship_protocol.md`.
- AC11: The system shall add tests for the GitHub keyword, the Azure DevOps keyword, a local specification, keyword reuse on an existing pull request, dry-run output, and a missing or unsupported provider.

## Notes

- Provider mapping lives in one table and nowhere else: `github` → `Closes #<id>`, `azure-devops` → `Fixes AB#<id>`. Any other provider emits no keyword.
- The keyword is appended to the existing `## Summary` block built by `buildPrBody`, before `## Commits`; it is not a new section, so bodies stay short.
- Dedupe rule for AC6: when assembling an amending body, drop every existing line matching `/^(Closes|Fixes|Resolves)\s+(AB)?#\d+\b/i` before appending the current keyword.
- The specification lookup reuses the `--spec <slug>` value already resolved by `sdw-ship-pr`; frontmatter is parsed with a regex like the import path already uses, not a new YAML dependency.
- Azure DevOps links the work item with `AB#<id>`; the transition to a closed state remains the project's completion-policy concern and no explicit API close is added here (spec 00016 owns that intent).
- The imported specification keeps its current slug shape `{prefix}-us-{id}-{titleSlug}`; no renaming is part of this specification.
- All new logic is Node.js 22 CommonJS standard library only, with no new runtime dependency.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Explicit `close-issue` API calls after merge | Owned by the SCM delivery intents (spec 00016); this specification only emits the reference the provider already understands. |
| Commenting on, labeling, or assigning the issue | The closing reference is the product contract; issue management beyond it is repository policy. |
| Importing issue bodies, comments, or attachments | Import already maps title, description, and acceptance criteria; widening it is a separate feature. |
| Re-importing to refresh an existing specification | Import stays create-only and fails closed on duplicates by design. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Closing syntax per provider | `Closes #<id>` (GitHub), `Fixes AB#<id>` (Azure DevOps) | Both are the provider-documented linkage forms; GitHub accepts all three keywords, and `AB#` is the ADO work-item prefix. | y |
| Keyword placement | End of the `## Summary` block | Closest to the change description without adding a section or truncating existing content. | y |
| Behaviour when metadata is absent | Omit silently and record `issueLink.present = false` | Standalone shipping from an arbitrary branch is legal and must not fail because a spec has no tracker item. | y |
| Spec lookup failure | Skip the link, do not fail the ship | A missing spec file is a standalone-ship case, not a delivery defect. | y |
| Frontmatter parsing | Regex over the existing `id:` and `source:` keys | The repository already parses frontmatter this way; a YAML parser would add a dependency the product forbids. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00051-issue-linkage-imported-scm-issues-close-.md` |
| Import anchor | Frontmatter `id`/`source` written by `importRemoteSpec` | Read `skills/sdw-spec/scripts/spec_creator.cjs` around the synthesized frontmatter |
| PR body anchor | `buildPrBody` locatable and testable | Read `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` and its exported test hook |
| Provider contract | The `github` and `ado` providers already create and amend pull requests | Read `skills/sdw-spec/scripts/providers/*.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- JSON report field `issueLink` with `id`, `provider`, `keyword`, and `present`.
- Console line naming the closing keyword and the pull request body it belongs to.
- Exit codes unchanged: `0` when the ship succeeds, including when the link is skipped; the field is the observable, not a new failure mode.

### Negative & Failing Test Scenarios

- A specification with `id: null` and `source: local`: body has no `Closes` or `Fixes` line, `issueLink.present` is `false`.
- A specification with an unsupported `source` value: no keyword, `present: false`, ship continues.
- An existing pull request whose body already contains `Closes #12` and the same keyword is re-appended: the body ends with exactly one `Closes #12` line.
- A duplicate import of an item that already has a specification: `sdw-spec import` refuses without `--force`, unchanged by this specification.
