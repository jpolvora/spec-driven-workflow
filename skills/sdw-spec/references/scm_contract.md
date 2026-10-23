# Unified SCM Provider Contract Reference

Reference guide for the unified Source Code Management (SCM) provider contract utilized by `sdw-spec import`, `sdw-spec sync-up`, and `sdw-spec sync-down`.

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
   * Creates a tracker item from a specification and returns its identity.
   * `state` speaks the mirroring vocabulary (`open` | `closed`).
   */
  createWorkItem(options: { title: string; body: string; state: 'open' | 'closed' }): Promise<NormalizedWorkItem>;

  /**
   * Writes the local title, body, and state onto an existing tracker item.
   */
  updateWorkItem(options: { id: string; title: string; body: string; state: 'open' | 'closed' }): Promise<NormalizedWorkItem>;

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
  "url": "https://github.com/org/repo/issues/1234",
  "state": "open",
  "tags": ["feature", "backend"]
}
```

## 3. Provider Implementations

### GitHub Provider (`github`)
- Uses GitHub CLI (`gh issue view <id> --json number,title,body,url,state,labels`) or REST API.
- Extracts acceptance criteria from the issue markdown body (parsing checklists `- [ ]` or sections).
- Maps labels to `tags`.

### Azure DevOps Provider (`azure-devops`)
- Uses Azure DevOps CLI (`az boards work-item show --id <id> --output json`) or REST API.
- Normalizes `System.Title`, `System.Description`, `Microsoft.VSTS.Common.AcceptanceCriteria`, `System.State`, `System.Tags`.
- Converts HTML description/acceptance criteria to clean Markdown.

## 4. Spec-Issue Mirroring (`sync-up` / `sync-down`)

Both directions run only on explicit operator invocation and share one status mapping; no other module duplicates it.

| Local registry | `sync-up` remote state | Remote state | `sync-down` local effect |
|---|---|---|---|
| `pending` | `open` | `open` | `pending`; a `completed` or `archived` row is reported `skipped` and never reopened |
| `completed` | `closed` | `closed` | `completed`; the header follows through the registry projection |
| `archived` | `closed` while still open | n/a | unchanged |

- **Slug marker:** every issue body written by `sync-up` starts with `<!-- sdw-spec: <slug> -->`. The HTML comment is invisible when rendered and gives `sync-down` an exact slug lookup without title guessing.
- **Matching order:** `scmSpecId` (legacy `id` accepted), then the slug marker, then exact title. The marker and title fallbacks only claim specifications that carry no remote identity yet, so a linked row is never rebound to a different item.
- **Body drift:** the body is compared after the marker, line endings, and trailing whitespace are normalized, so a `sync-up` round trip never reads as drift. `sync-down` never writes body content: when a matched item's body differs, the report carries a `drift` entry and both bodies stay untouched, while the registry row still follows the remote state. `sync-up` owns the body on its own run.
- **Dry run:** `--dry-run` resolves the provider name from configuration only. It probes no CLI, constructs no provider, and executes no provider command. `sync-up` prints its planned creates, updates, and mapped states from local files. `sync-down` changes are remote-driven, so its plan lists the linked rows a live run would reconcile and states that remote state is not queried.
- **Refusals:** both directions exit non-zero naming the cause before any provider call or local write when the provider is `none`, or when the CLI is missing or unauthenticated.
