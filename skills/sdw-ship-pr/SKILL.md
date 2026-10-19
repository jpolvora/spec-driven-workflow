---
name: sdw-ship-pr
description: Standalone PR shipping, pre-PR requirement checks, SCM PR creation/reuse, and review convergence.
version: 0.1.0
invocation_names:
  - sdw-ship-pr
  - ship-pr
  - sdw-ship-pr list-threads
  - sdw-ship-pr resolve-thread
  - sdw-ship-pr check-status
---

# sdw-ship-pr

> When this skill is loaded, output "sdw-ship-pr loaded."

Self-contained PR shipping manager for Spec-Driven Workflow (SDW). Orchestrates pre-PR requirement verification gates, remote branch publishing, pull request creation or reuse across configured SCM providers, and automated post-PR review convergence loops.

## Invocation

Standalone CLI:
```bash
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs [options]
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs list-threads --pr <number>
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs resolve-thread --pr <number> --thread <id> --comment "<text>"
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs check-status --pr <number>
```

Parameters:
- `--run-id <id>`: Active orchestrator run identifier (updates `.sdw/state/{runId}.state.json`).
- `--spec <slug>`: Specification slug (derives default PR title/body).
- `--head <branch>`: PR source head branch (defaults to current active git branch).
- `--base <branch>`: PR target base branch (defaults to `.sdw/config.json` `baseBranch`, then `master`/`main`).
- `--title <string>`: Custom PR title.
- `--body <string>`: Custom PR description body.
- `--push`: Force push active branch to remote origin before PR creation.
- `--poll-pr`: Enable post-PR review polling and convergence loop.
- `--max-iterations <n>`: Review convergence ceiling (default `3`).
- `--poll-interval <ms>`: Wait between convergence rounds (default `20000`).
- `--max-preemptions <n>`: Concurrent-push adaptation budget (default `3`).
- `--dry-run`: Simulate pre-PR checks, branch push, PR creation, and review polling without remote mutations.
- `--json`: Output structured JSON execution report.

Detailed protocol: [`references/ship_protocol.md`](references/ship_protocol.md).

## State Machine Steps

### Step 1: Preflight & Options Resolution
1. Read configuration from `.sdw/config.json` (`scmProvider`, `pushDelivery`, `scmCodeReviewEnabled`, `requiredBuild`, `runAllTests`, `prePrCommand`, `prePrInstructions`, `securityChecksEnabled`).
2. Resolve head branch (explicit `--head` or current `git rev-parse --abbrev-ref HEAD`) and base branch (explicit `--base`, config `baseBranch`, or detected repository default).
3. Verify SCM capability (`github` via `gh`, `ado` via `az`, or `none`).
- Done when: Head, base, SCM provider, and quality options resolved; working tree verified.

### Step 2: Pre-PR Verification Gates
1. If `prePrInstructions` is configured, evaluate and display the instructions.
2. If `prePrCommand` is set, execute the command (e.g. custom linter or checklist). Halt if it fails.
3. If `requiredBuild: true`, execute `npm run build` or project build command. Halt if it fails.
4. If `runAllTests: true`, execute test suite. Halt if tests fail.
5. If `securityChecksEnabled: true`, inspect staged diff for secret leaks or sensitive patterns.
- Done when: All configured pre-PR gates evaluate to pass; failures halt execution with exit code 1.

### Step 3: Remote Branch Push
1. If `pushDelivery: true` or `--push` passed:
   - When not in `--dry-run`, execute `git push -u origin <head>`.
   - When `--dry-run`, log simulated branch push.
2. If `pushDelivery: false` and no `--push`, proceed without pushing.
- Done when: Remote branch is synchronized with origin or push is explicitly bypassed.

### Step 4: SCM Pull Request Creation / Reuse
1. When `scmProvider` is `none`: skip remote PR creation, log local delivery readiness, and return exit 0.
2. When `scmProvider` is `github` or `ado`:
   - Assemble PR title and body from specification or CLI parameters.
   - Query open PRs matching `<head>` into `<base>` using the unified SCM provider contract (`findActivePullRequest`).
   - If an open PR exists, reuse its number and URL. Complement the active PR: push commits to the PR branch and update the PR description with the amending delivery details (`### Amending Delivery: {specSlug}`).
   - While amending an active PR undergoing review/approval is not a recommended practice, adapt as a non-blocking operation: continue the delivery process without failing or blocking.
   - Otherwise, create a new pull request via `provider.createPullRequest({ title, body, head, base, dryRun })`.
- Done when: Pull request number and URL are captured or reused, description amended if reused, or SCM creation skipped cleanly.

### Step 5: Post-PR Review Convergence (Cooperative & Proactive Fix Cycle)
1. When `scmCodeReviewEnabled: true` or `--poll-pr` passed (and `scmProvider != "none"`):
   - **Wait for code-review & CI:** Await remote CI workflows and automated/agentic review runs (`provider.checkPrStatus` / `gh pr checks`) to finish.
   - Loop up to configured iteration ceiling (default 3 rounds):
     a. **Check active threads:** Call `provider.listReviewThreads(prNumber)`. If all checks pass and `activeCount === 0`, mark converged and exit loop.
     b. **Fetch it all:** If active threads exist, retrieve all open threads, file locations, line numbers, and reviewer comments.
     c. **Cooperative & proactive fix:** Analyze feedback critically. Name the underlying defect class (e.g. unhandled error, type mismatch, missing validation). Proactively sweep sibling files and related PR modifications for the same pattern, fixing all occurrences rather than patching only the reported line. Apply minimal surgical fixes (`sdw-rules` simplicity first; no unrequested refactorings).
     d. **Verify:** Run test suite (`npm test`) and project build to ensure fixes pass cleanly without regressions.
     e. **Commit:** Stage only surgical fix paths and commit: `git commit -m "fix(review): address review feedback"`.
     f. **Push:** Push the commit to the remote tracking branch: `git push origin <head>`.
     g. **Close related threads with comment:** **Only after pushing**, call `provider.resolveReviewThread({ prNumber, threadId, comment })` for each addressed thread, posting an informative comment explaining the fix that was implemented (commit SHA, files modified, changes made, and why it resolves the issue).
2. If unresolved issues remain after maximum iterations, record review residual and report status. Never close a thread before pushing, and never close without an explanatory fix comment.
3. **Concurrent-push adaptation:** Cancelled/superseded CI checks (`cancelled`, `timed_out`) are waited out, never treated as failures. When a newer run replaces the observed one, the loop resets its round window (up to `--max-preemptions` times) and follows the latest status instead of halting.
- Done when: Active threads resolved with explanatory comments after push and CI checks green, or iteration ceiling reached with status recorded.

### Step 6: Delivery Outcome & State Persistence
1. Record PR URL, PR number, ship status, and review convergence results.
2. If `--run-id` is provided, persist delivery metadata into `.sdw/state/{runId}.state.json` under `steps[8]`.
3. Output markdown summary or structured JSON.
- Done when: State file updated (if runId provided) and execution report emitted to stdout.
