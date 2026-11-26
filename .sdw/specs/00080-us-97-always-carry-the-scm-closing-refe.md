---
id: "97"
slug: 00080-us-97-always-carry-the-scm-closing-refe
title: "Always carry the SCM closing reference for specs imported from a provider (incl. cross-repo items)"
source: github
type: feature
status: implemented
specDate: 2026-11-26
---
# Specification — Always carry the SCM closing reference for specs imported from a provider (incl. cross-repo items)

## Description

Specs imported through `sdw-spec import --provider github|azure-devops` must always produce a pull request that closes the originating tracker item. Spec [00051](00051-issue-linkage-imported-scm-issues-close-.md) established the linkage, but it only carries two frontmatter values: `id` and `source`.

That is sufficient when the imported item belongs to the same repository that receives the pull request, as verified on `jpolvora/wzp` PR #12 (`Closes #11` closed issue #11 on squash merge). It is not sufficient for the general import case, and four defects follow from the same root cause: the import never records where the item came from.

1. **Cross-repository items** render `Closes #11`, which targets issue 11 in the pull request's repository, not the repository that owns the imported item. GitHub supports `Closes owner/repo#11`, but no formatter emits it because the origin repository is not persisted.
2. **Duplicate suppression misses qualified forms.** `CLOSING_KEYWORD_LINE` in `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` matches `(Closes|Fixes|Resolves)\s+(AB)?#\d+` only, so a body that already contains `Closes owner/repo#11` receives a second closing line.
3. **Azure DevOps identity is unrecorded.** `Fixes AB#<id>` assumes the pull request lives in the same organization as the imported work item; the import records neither `organization` nor `project`.
4. **The gate is open by default.** `resolveIssueLink()` yields no keyword for a missing id or unsupported provider and shipping proceeds, so a tracker-driven delivery can ship a pull request that never closes its source item.

The change persists the provider coordinates at import time and makes `sdw-ship-pr` build the closing reference from those coordinates. The scope is the import writer, the pull request body assembly, the closing-line matcher, frontmatter validation, the two provider references, and their tests. Nothing else in the delivery pipeline changes.

Affected surfaces:

- `skills/sdw-spec/scripts/spec_creator.cjs` (`importRemoteSpec`, `synthesizeCanonicalSpec`)
- `skills/sdw-spec/scripts/providers/github.cjs` and `providers/ado.cjs` (normalized item)
- `skills/sdw-spec/scripts/validate_spec.cjs` (optional frontmatter keys)
- `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` (`resolveIssueLink`, `ISSUE_CLOSING_KEYWORDS`, `CLOSING_KEYWORD_LINE`, `buildPrBody`, `appendClosingKeyword`, pre-PR gate board)
- `skills/sdw-spec/references/scm_contract.md` and `skills/sdw-ship-pr/references/ship_protocol.md`
- `tests/sdw_scm_provider.test.cjs`, `tests/sdw_spec.test.cjs`, `tests/sdw_ship_pr.test.cjs`

### Design Intent

A tracker id that is recorded without its coordinates is ambiguous metadata. The provider already closes items when a merged pull request names them, so the product must record the item's location once, at import, and emit the richest reference that location supports. Resolving the pull request's own repository at ship time would add a network call and a failure mode; persisting `sourceRepo` removes both. The closing reference becomes a pure function of persisted spec frontmatter.

### Prior Work Sweep

- Spec [00051](00051-issue-linkage-imported-scm-issues-close-.md) defined the current behavior: `resolveIssueLink()` reads `id` and `source`, `appendClosingKeyword()` strips then appends one line, and a missing keyword is not a gate.
- `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` lines 89-97 hold the keyword map and the matcher; lines 112-130 read `id`/`source`; line 186 returns an explicit `--body` unchanged; lines 1155-1156 throw pre-PR gate failures before push.
- `skills/sdw-spec/scripts/spec_creator.cjs` `importRemoteSpec` writes `id: String(item.id)` and `source: item.source`, and deduplicates imports by `id`.
- `skills/sdw-spec/scripts/providers/github.cjs` already returns `url`; `providers/ado.cjs` returns `data.url` or `_links.html.href`, from which organization and project are derivable.
- Vault traps applied: `closing-keyword-needs-default-branch` (a closing reference is inert unless the pull request targets the default branch, so the gate reasons about presence, not merge outcome) and `spec-id-collides-with-issue-number` (`id` must stay the provider item id).
- `tests/sdw_ship_pr.test.cjs` already covers same-repo `Closes #N`; `tests/sdw_scm_provider.test.cjs` covers normalized provider output.

## Acceptance Criteria

- AC1: When the GitHub provider imports an issue, the system shall persist `sourceRepo` as `<owner>/<repo>` and `sourceIssue` as the item number in the specification frontmatter.
- AC2: When the Azure DevOps provider imports a work item, the system shall persist `sourceOrg`, `sourceProject`, and `sourceIssue` in the specification frontmatter.
- AC3: When any provider import succeeds, the system shall persist `sourceUrl` with the item URL returned by the provider.
- AC4: Where a specification declares `source: github` and `sourceRepo`, the system shall render the closing reference as `Closes <owner>/<repo>#<sourceIssue>`.
- AC5: If a GitHub specification has no `sourceRepo`, then the system shall fall back to the `Closes #<id>` closing reference.
- AC6: Where a specification declares `source: azure-devops`, the system shall render the closing reference as `Fixes AB#<sourceIssue>`.
- AC7: When `--body` supplies the pull request body, the system shall append the resolved closing reference to that body.
- AC8: While a pull request body already contains a closing line, the system shall strip it before appending, including the qualified form `Closes <owner>/<repo>#<number>`.
- AC9: If a specification declares a tracker `source` and no closing reference resolves, then the system shall refuse to push or create the pull request.
- AC10: Where `--allow-missing-closing-reference` is passed, the system shall record the unresolved reference as a warning and continue shipping.
- AC11: If `sourceIssue` or `sourceRepo` is present with an invalid shape, then the specification validator shall report an error naming the offending key.
- AC12: The system shall document the new frontmatter keys and the fail-closed gate in `scm_contract.md` and `ship_protocol.md`.
- AC13: The system shall cover same-repo GitHub, cross-repo GitHub, Azure DevOps, duplicate suppression, and the fail-closed gate in automated tests.

## Notes

Frontmatter schema (keys are optional; absent keys keep every existing spec valid):

```yaml
source: github
sourceIssue: 11
sourceRepo: owner/repo
sourceUrl: https://github.com/owner/repo/issues/11
# source: azure-devops
# sourceIssue: 123
# sourceOrg: org
# sourceProject: project
# sourceUrl: https://dev.azure.com/org/project/_workitems/edit/123
```

Implementation constraints:

- `id` keeps its current meaning: the provider item id as a string. `sourceIssue` is the numeric twin used by the formatter; when it is absent the formatter reads `id`.
- Emit the new keys immediately after `source` in `synthesizeCanonicalSpec`, because `resolveIssueLink()` and `getSpecTitle()` read only the first 25 lines of the spec file.
- Keyword table stays a single mapping keyed by provider. GitHub formatter prefers `sourceRepo`; the unqualified form is the fallback, not the default.
- `Fixes AB#<id>` is organization-scoped in Azure DevOps and has no project-qualified variant. `sourceOrg` and `sourceProject` are persisted for provenance and diagnostics, not interpolated into the keyword.
- Duplicate matching must recognize `Closes owner/repo#N`, `Closes #N`, `Fixes #N`, `Fixes AB#N`, and `Resolves #N` case-insensitively, with optional surrounding whitespace.
- `resolveIssueLink()` returns `{ id, provider, keyword, present, sourceRepo, sourceOrg, sourceProject, sourceIssue }` so the JSON report explains the decision.
- The fail-closed check is a pre-PR gate board row evaluated before push, joined through the existing `gateFailures` throw. It applies only when `source` is `github` or `azure-devops` and `id` is non-null.
- `--allow-missing-closing-reference` is a ship flag; it downgrades the row to `warn` and records the reason in the JSON report. No new `.sdw/config.json` key.
- No new runtime dependencies. Node 22 standard library only.
- A closing reference only takes effect when the pull request targets the provider default branch; the gate guarantees presence, not that the provider closed the item.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Project-qualified Azure DevOps closing syntax | `AB#<id>` is organization-scoped and no project-qualified keyword exists. |
| Verifying after merge that the provider closed the item | The gate guarantees the reference is present, not the provider's post-merge state. |
| Backfilling coordinates into already imported specifications | Existing specs keep their frontmatter; only new imports persist coordinates. |
| Retro or batch candidate identifiers as `id` | `id` remains the provider item id; candidate ids must not leak into SCM linkage. |
| Resolving the pull request repository at ship time | Persisting `sourceRepo` removes the need for a network call and its failure mode. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| `id` keeps the provider item id while `sourceIssue` is added | Keep `id`, add `sourceIssue` | Preserves the spec 00051 contract and existing consumers; this deviates from the issue text, which proposes `id` as the local spec id, so the maintainer must confirm | No |
| GitHub always renders the qualified `owner/repo#N` form when `sourceRepo` exists | Qualified form when known, unqualified fallback otherwise | GitHub accepts the qualified form for same-repo issues, so no PR-repository lookup is required | No |
| Fail-closed applies only to tracker-backed specs with a non-null id | Gate `source in (github, azure-devops)` and `id != null` | Local specs have no item to close; gating them would break existing deliveries | Yes |
| Opt-out flag name and shape | `--allow-missing-closing-reference` | Matches the issue proposal and the existing kebab-case flag style | No |
| Azure DevOps keeps `Fixes AB#<id>` and records coordinates for provenance | Keep the keyword, persist `sourceOrg` and `sourceProject` | Work item ids are organization-scoped; project data serves diagnostics | Yes |
| New keys sit immediately after `source` | Place them after `source` in generated frontmatter | `resolveIssueLink()` reads only the first 25 lines of the spec file | Yes |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Frontmatter schema | New optional keys accepted; invalid shapes rejected with a key-naming error | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00080-us-97-always-carry-the-scm-closing-refe.md` |
| Provider coordinates | GitHub and Azure DevOps normalized items expose the data needed to derive repo, org, project, and issue | `node --test tests/sdw_scm_provider.test.cjs` |
| Closing reference table | All provider forms and the fallback enumerated | `node --test tests/sdw_ship_pr.test.cjs` |
| Fail-closed ordering | Gate evaluated before push or PR creation | Code read of the pre-PR gate section in `sdw_ship_pr.cjs` |
| Duplicate suppression | Qualified and unqualified closing lines both stripped | New cases in `tests/sdw_ship_pr.test.cjs` |
| Documentation | Both references describe keys and gate | Diff review of `scm_contract.md` and `ship_protocol.md` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `report.issueLink` in the ship JSON report includes `id`, `provider`, `keyword`, `present`, `sourceRepo`, `sourceOrg`, `sourceProject`, and `sourceIssue`.
- The pre-PR gate board gains a `closing-reference` row with `pass`, `warn`, or `fail` plus the resolved keyword as evidence.
- `--dry-run` prints the assembled pull request body, so the closing line is observable before push.
- `sdw-spec import` prints the persisted coordinates in its success output.
- A gated ship exits non-zero with a message naming the spec and the missing reference.

### Negative & Failing Test Scenarios

- Imported GitHub spec without `sourceRepo`: shipping falls back to `Closes #97` and does not raise the gate.
- Body already containing `Closes other/repo#97`: after assembly exactly one closing line remains.
- Tracker-backed spec with `id: null`: ship exits non-zero, pushes nothing, and creates no pull request.
- `--allow-missing-closing-reference` with the same spec: ship continues and the report records `present: false` with a warning.
- Spec with `sourceIssue: twelve` or `sourceRepo: notowner`: validation fails with an error naming the offending key.
- Azure DevOps item URL without a project segment: import fails with a descriptive error instead of persisting partial coordinates.
