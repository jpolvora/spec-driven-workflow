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
| `securityChecksEnabled` | boolean | true | Delegates to `sdw-security-checks` over the worktree for credentials, private keys, or exposed tokens | Leak detection or scanner failure halts ship |
| `reviewFixCommand` | string | null | Command that applies review-thread fixes before the convergence loop resolves threads | Unset: active threads are reported as `review_pending`, never auto-resolved without verified fix |

---

## 2. Remote Branch Publishing (`pushDelivery`)

- When `pushDelivery: true` in `.sdw/config.json` or `--push` is passed on CLI:
  - Executes `git push -u origin <headBranch>`.
  - In `--dry-run` mode, git execution is logged without remote mutation.
- When `pushDelivery: false` and `--push` is omitted:
  - Skips remote push. If the branch has never been pushed to the remote origin, remote SCM PR creation will require push.

---

## 3. Pull Request Creation & Idempotency

`sdw-ship-pr` delegates to `skills/sdw-spec/scripts/scm_provider_contract.cjs`, a facade over `skills/sdw-spec/scripts/providers/{base,github,ado}.cjs`:

1. **Provider Resolution:**
   - Reads `scmProvider` from `.sdw/config.json`.
   - If `none`: PR creation is skipped. Standalone delivery is marked complete locally.
   - If `github` or `ado`: SCM CLI capability (`gh` or `az`) is verified.
2. **Idempotent Reuse & Active PR Adaptation:**
   - Queries open pull requests matching head branch into base branch (`gh pr list --head ...` or `az repos pr list --source-branch ...`).
   - If an open PR already exists, reuses the existing PR number and URL without creating duplicates.
   - **Complementing Active PR:** Commits are pushed to the existing branch, and the PR description is updated with an amending delivery section (`### Amending Delivery: {specSlug}\n- Commit: \`{sha}\`\n- Timestamp: {iso}`).
   - **Non-blocking Adaptation:** While amending an active PR undergoing code review or awaiting approval is not a recommended practice, the system adapts as a non-blocking operation rather than halting or failing. If review convergence ends while checks or approvals are pending, it records `shipStatus: review_pending`, marks delivery completed in state, and exits 0 cleanly.
3. **Creation Payload:**
   - `title`: Enriched by default from `git log {base}..{head}` and spec title (`feat({specSlug}): deliver {specTitle} ({n} commits)` or `feat({head}): {firstSubject} (+n more)`); explicit `--title` overrides.
   - `body`: Markdown with `## Summary`, `## Commits` (sha/subject/author/date), `## Features` grouped (Features/Fixes/Other), `## Files changed` (`git diff --name-status`), and `## Verification` (gates from config). Explicit `--body` overrides; empty git context falls back to legacy one-liner.

---

## 4. Cooperative & Proactive Review Convergence Protocol

When `scmCodeReviewEnabled: true` or `--poll-pr` is active, `sdw-ship-pr` executes automated review convergence grounded in cooperative and proactive problem resolution (inspired by `ws-fix-pr` and `COOPERATIVE_FIX.md`):

### 4.1 Mandatory Order of Operations

```text
1. Wait code-review & CI finish ──────────► Poll check status until settled
2. Check active threads ──────────────────► Query provider.listReviewThreads
3. If active threads exist: Fetch it all ─► Retrieve all open threads, file locations & comments
4. Cooperative & proactive fix ───────────► Analyze defect class & fix all occurrences (not just anchor)
5. Verify ────────────────────────────────► Run npm test / build suite to confirm clean pass
6. Commit ────────────────────────────────► Stage surgical fix paths; git commit -m "fix(review): ..."
7. Push ──────────────────────────────────► git push origin <head> (remote must have the commit)
8. Close related threads with comment ────► Call provider.resolveReviewThread with detailed fix summary
```

> [!IMPORTANT]
> **Push before Resolve:** A thread must NEVER be marked resolved before the commit containing the fix is pushed to the remote tracking branch. Reviewers and CI verify the PR against remote commits.
> **Explain before Closing:** A thread must NEVER be closed without an informative resolution comment detailing what was fixed and why it resolves the defect. Hash-only or empty comments are forbidden.

### 4.2 Settle Period & Status Polling
- Waits between rounds with the provider's native capability first: `provider.supportsNativeWatch()` selects `provider.watchPrChecks(prNumber, { intervalSeconds })` (GitHub runs `gh run watch <run-id> --exit-status` on the Actions runs behind the checks), which blocks until the runs finish instead of firing a shell timer. `--no-native-watch` disables it.
- Falls back to waiting `--poll-interval` milliseconds between rounds (default `20000`) when the provider, the CLI, or the flag is unavailable.
- Runs up to `--max-iterations` convergence rounds (default `3`).
- Polls `provider.checkPrStatus(prNumber)` and `provider.listReviewThreads(prNumber)`.
- If all checks pass and `activeCount === 0`, marks review converged.

### 4.2b Concurrent-Push Preemption Adaptation
Concurrent pushes to the shipped head branch while polling are an allowed event, not a failure. The loop adapts instead of halting:
- **Superseded checks are not failures:** `cancelled` and `cancel` states are reported as `supersededChecks` and waited out. Only `fail`, `failure`, `action_required`, and the terminal `timed_out`/`startup_failure` states feed the fixer/blocker path, since those indicate a run that executed and failed (or never started) rather than one replaced by a newer push. A superseded `state` takes precedence over a coarse `bucket` value.
- **Fresh window for the replacement run:** check states are snapshotted per round. When a check moves from a terminal state back to pending/passing, or the check set changes between rounds, a newer CI run replaced the observed one: the loop logs the preemption, resets the round counter, and follows the latest status. Resets are capped by `--max-preemptions` (default `3`, also readable from `maxPreemptions` config); beyond the cap the loop falls back to the normal exhaustion path (`review_pending`).
- **No extra provider queries:** preemption is inferred from `checkPrStatus` state transitions already polled each round; no head-SHA lookup is required, so the behavior is identical for `github` and `ado`.

### 4.3 Cooperative & Proactive Analysis & Fixing
When active review threads or failing checks are detected:
1. **Analyze Root Cause & Defect Class:** Do not treat review comments as isolated line bugs. Name the underlying defect class (e.g. missing boundary check, unhandled promise rejection, type conversion issue, unrequested scope).
2. **Proactive Sibling Sweep:** Grep the pull request diff and sibling modules for identical anti-patterns. If the reviewer flagged an issue in one file, proactively inspect and fix the same issue across all related files in the change.
3. **Surgical Scope Enclosure:** Apply minimal fixes satisfying acceptance criteria and `sdw-rules` simplicity first. Avoid drive-by refactorings or speculative abstractions.
4. **Execution Methods:**
   - **Agent / Subagent Mode:** When an AI agent executes `sdw-ship-pr` (standalone or via `sdw-orch`), the agent directly performs the cooperative fix cycle, verifies with tests, commits, pushes, and calls `resolve-thread`.
   - **Dirty Working Tree (LLM-selected):** before publishing, the host agent plans the selection with `dirty-plan` (candidates, run files, state path) and analyzes each candidate against this session's tasks, prompts, and dependencies. It writes the approved project-relative paths to `.sdw/state/<runId>/dirty-files.json` and ship-pr stages only those paths (`git add -A -- <path>`), commits (`chore(delivery): include pending working-tree changes`), then pushes. Without an approved list, ship-pr falls back to the run evidence files; when neither exists it refuses to commit and leaves the tree untouched. The outcome is recorded as `report.dirtyCommit` (`mode`, `sha`, `files`, `excluded`); dry-run only reports them. Configure the message with `dirtyCommitMessage` in `.sdw/config.json`.
- **Command Mode:** In automated pipelines, `reviewFixCommand` (or `--review-fix-command`) executes the fix command, runs tests, commits, pushes, and resolves threads.
   - **Fixer Delegation:** When `reviewFixCommand` is unset and `skills/sdw-fixer` is present, ship-pr builds a findings batch that carries each `threadId` and runs `sdw_fixer.cjs`. It then consumes the structured report collaboratively: threads listed in `report.comments` are resolved with the fixer's own resolution comment, threads the fixer skipped stay open with the recorded reason, and `report.amendments` is surfaced in the log. The convergence loop never resolves a thread the fixer did not close.
   - **Programmatic Mode:** `options.threadFixer` allows custom runners to supply fixes and per-thread resolution notes.

### 4.4 Thread Resolution Comment Contract
For every addressed thread, `provider.resolveReviewThread({ prNumber, threadId, comment })` posts a comment following the standard template:

```markdown
<!-- resolution-reply -->
Resolved review issue: applied fix and verified acceptance criteria.

Fixed in commit {commitSha}.

Summary: {Files modified and exact technical correction applied}. {Why this resolves the review feedback}.
Defect class: {defectClass}
Proactive sweep: {proactiveFixed or "None (single instance)"}
```

- **GitHub:** Executed via GraphQL mutation atomically calling `addPullRequestReviewThreadReply` and `resolveReviewThread`.
- **Azure DevOps:** Posts a reply comment via `pullRequestThreadComments` and updates thread status to `fixed` (`2`).

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
    "activeThreads": 0,
    "pendingThreads": [],
    "preemptions": 0,
    "supersededChecks": [],
    "issuesFixed": [
      {
        "threadId": "PRRT_kwTEST123",
        "resolution": "<!-- resolution-reply -->\nResolved review issue..."
      }
    ]
  },
  "shipStatus": "delivered"
}
```

