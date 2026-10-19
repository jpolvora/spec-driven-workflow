# SDW Ship PR Protocol & Specifications

This document defines the detailed reference protocol for the `sdw-ship-pr` skill.

---

## 1. Pre-PR Verification Gates

Before publishing branches or creating remote pull requests, `sdw-ship-pr` evaluates configuration gates defined in `.sdw/config.json`:

| Config Key | Type | Default | Description | Failure Behavior |
|---|---|---|---|---|
| `prePrInstructions` | string | null | Guidance or mandatory instructions to review before shipping | Logged to console |
| `prePrCommand` | string | null | Shell command to execute (e.g. `npm run lint` or custom verify script) | Non-zero exit code halts ship |
| `requiredBuild` | boolean | false | If true, runs `npm run build` or project build command | Build failure halts ship |
| `runAllTests` | boolean | false | If true, runs `npm test` or full test suite | Test failure halts ship |
| `securityChecksEnabled` | boolean | true | Scans git diff for credentials, private keys, or exposed tokens | Leak detection halts ship |

---

## 2. Remote Branch Publishing (`pushDelivery`)

- When `pushDelivery: true` in `.sdw/config.json` or `--push` is passed on CLI:
  - Executes `git push -u origin <headBranch>`.
  - In `--dry-run` mode, git execution is logged without remote mutation.
- When `pushDelivery: false` and `--push` is omitted:
  - Skips remote push. If the branch has never been pushed to the remote origin, remote SCM PR creation will require push.

---

## 3. Pull Request Creation & Idempotency

`sdw-ship-pr` delegates to `skills/sdw-spec/scripts/scm_provider_contract.cjs`:

1. **Provider Resolution:**
   - Reads `scmProvider` from `.sdw/config.json`.
   - If `none`: PR creation is skipped. Standalone delivery is marked complete locally.
   - If `github` or `ado`: SCM CLI capability (`gh` or `az`) is verified.
2. **Idempotent Reuse:**
   - Queries open pull requests matching head branch into base branch (`gh pr list --head ...` or `az repos pr list --source-branch ...`).
   - If an open PR already exists, reuses the existing PR number and URL without creating duplicates.
3. **Creation Payload:**
   - `title`: Extracted from specification title or `--title`.
   - `body`: Markdown PR body describing delivered features, referenced issue number, and verification summary.

---

## 4. Review Convergence & Resolution Protocol

When `scmCodeReviewEnabled: true` or `--poll-pr` is active, `sdw-ship-pr` executes automated review convergence:

### 4.1 Polling & Settle Period
- Waits initial settle time (default 15–30 seconds) for CI actions and automated reviewer workflows (such as `agentic-code-reviewers`) to trigger.
- Runs up to 3 iterative convergence rounds.

### 4.2 Review Thread Inspection
- Calls `provider.listReviewThreads(prIdentifier)`.
- Categorizes threads by status:
  - Active: `isResolved === false` and no resolution reply marker.
  - Resolved: `isResolved === true` or contains `<!-- resolution-reply -->`.

### 4.3 Surgical Fix & Resolution Comment Requirement
When active review threads or failing checks are detected:
1. **Analyze:** Parse the feedback, file paths, line numbers, and suggested corrections.
2. **Fix:** Apply surgical edits to the codebase addressing the specific defect class.
3. **Verify:** Execute tests (`npm test`) to confirm fixes pass without regressions.
4. **Commit & Push:**
   - Commit: `git commit -m "fix(review): address review feedback"`
   - Push: `git push origin <headBranch>`
5. **Resolve Thread via SCM Provider:**
   - For every resolved thread or review comment, call `provider.resolveReviewThread({ prNumber, threadId, comment, model, dryRun })`.
   - The resolution `comment` must summarize:
     - What changed (files modified and technical rationale).
     - Why the fix resolves the reported defect.
   - On GitHub: The provider runs a GraphQL mutation executing both `addPullRequestReviewThreadReply` and `resolveReviewThread` atomically.
   - On Azure DevOps: The provider posts a reply comment via `pullRequestThreadComments` and patches thread status to `fixed` (`2`).

---

## 5. Structured Output Schema

When invoked with `--json`, `sdw-ship-pr` emits JSON with the following structure:

```json
{
  "success": true,
  "head": "develop",
  "base": "master",
  "scmProvider": "github",
  "pushed": true,
  "pullRequest": {
    "number": "3",
    "url": "https://github.com/owner/repo/pull/3",
    "reused": true
  },
  "reviewConvergence": {
    "enabled": true,
    "converged": true,
    "rounds": 1,
    "resolvedThreads": 2,
    "activeThreads": 0
  },
  "shipStatus": "delivered"
}
```
