# Unified SCM Provider Contract Reference

Reference guide for the unified Source Code Management (SCM) provider contract utilized by `sdw-spec import`.

## 1. Interface Definition

Any SCM provider implementation must conform to the unified `ScmProvider` contract:

```typescript
interface ScmProvider {
  /**
   * Fetches a single work item or issue by identifier.
   */
  fetchWorkItem(itemId: string | number): Promise<NormalizedWorkItem>;

  /**
   * Queries work items matching criteria.
   */
  queryWorkItems(query: Record<string, any>): Promise<NormalizedWorkItem[]>;

  /**
   * Reports whether the provider can block on native pull-request check watch
   * instead of caller-side timer polling. Defaults to false.
   */
  supportsNativeWatch(): boolean;

  /**
   * Blocks until the pull-request checks settle, when supported.
   * Rejects with a descriptive error when the capability is unavailable.
   */
  watchPrChecks(prNumber: string | number, options?: { intervalSeconds?: number }): Promise<string>;

  /**
   * Reports whether the pull request actually reached the MERGED/completed
   * state. An accepted merge command is not proof of a merge.
   */
  isPullRequestMerged(prNumber: string | number): Promise<boolean>;
}
```

## 2. NormalizedWorkItem Schema

All provider implementations must return items normalized to this canonical structure:

```json
{
  "id": "1234",
  "title": "Implement feature X",
  "description": "Markdown body text of the issue or work item",
  "acceptanceCriteria": [
    "The system shall do X",
    "When Y occurs, the system shall do Z"
  ],
  "source": "github",
  "repo": "org/repo",
  "org": null,
  "project": null,
  "url": "https://github.com/org/repo/issues/1234",
  "state": "open",
  "tags": ["feature", "backend"]
}
```

`repo` is set by the GitHub provider from the item URL; `org` and `project` are set by the Azure DevOps provider. A provider that cannot derive a coordinate returns `null`, and `sdw-spec import` persists only the truthy ones (see §2.1).

### 2.1 Persisted Specification Coordinates (spec 00080)

When `sdw-spec import` writes a specification from a tracker item, it persists the provider coordinates in the spec frontmatter so the closing reference is a pure function of persisted values:

| Frontmatter key | Shape | Meaning |
|---|---|---|
| `sourceIssue` | positive integer | Tracker issue or work-item number. |
| `sourceRepo` | `owner/repo` | Repository that owns the GitHub issue, for cross-repository delivery. |
| `sourceOrg` | non-empty segment | Azure DevOps organization; provenance only. |
| `sourceProject` | non-empty segment | Azure DevOps project; provenance only. |
| `sourceUrl` | absolute URL | Canonical item URL returned by the provider. |

The validator checks `sourceIssue` and `sourceRepo` only when present: a non-integer `sourceIssue` or a `sourceRepo` outside `owner/repo` is rejected with an error naming the offending key. Specs that omit these keys stay valid.

`sdw-ship-pr` renders the closing reference from these keys: `github` with `sourceRepo` → `Closes <sourceRepo>#<sourceIssue>`; `github` without `sourceRepo` → `Closes #<sourceIssue|id>`; `azure-devops` → `Fixes AB#<sourceIssue|id>`. A tracker specification that resolves no closing reference fails the `closing-reference` pre-PR gate (see `sdw-ship-pr/references/ship_protocol.md` §1.4).

## 3. Provider Implementations

### GitHub Provider (`github`)
- Uses GitHub CLI (`gh issue view <id> --json number,title,body,url,state,labels`) or REST API.
- Extracts acceptance criteria from the issue markdown body (parsing checklists `- [ ]` or sections).
- Maps labels to `tags`.

### Azure DevOps Provider (`azure-devops`)
- Uses Azure DevOps CLI (`az boards work-item show --id <id> --output json`) or REST API.
- Normalizes `System.Title`, `System.Description`, `Microsoft.VSTS.Common.AcceptanceCriteria`, `System.State`, `System.Tags`.
- Converts HTML description/acceptance criteria to clean Markdown.
