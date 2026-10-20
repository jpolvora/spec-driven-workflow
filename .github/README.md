# GitHub Actions Automation & CI/CD

This directory defines the automated GitHub Actions workflows, agentic code review integration, and distribution pipeline for **Spec-Driven Workflow (SDW)**.

---

## 1. Workflow Inventory

| Workflow File | Trigger Events | Primary Responsibilities | Minimal Permissions |
|---|---|---|---|
| [`.github/workflows/ci.yml`](workflows/ci.yml) | `pull_request` (`opened`, `synchronize`, `reopened`) on `main`/`develop`<br>`push` on `main`/`develop` | • Validates all specifications in `.sdw/specs/` in authoring mode<br>• Runs the unit test suite (`npm test`)<br>• Executes skill packaging verification when present (`scripts/verify_skills.cjs`) | `contents: read` |
| [`.github/workflows/agentic-code-review.yml`](workflows/agentic-code-review.yml) | `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`) on `main`/`develop`<br>`workflow_dispatch` with `pr_number` | • Runs `agentic-code-reviewers` over the PR diff<br>• Evaluates SDW conformance using [`.github/agentic-code-reviewers-prompt.md`](agentic-code-reviewers-prompt.md)<br>• Skips gracefully on missing credentials (fork-safe)<br>• Blocks merge if unresolved review threads remain | `contents: read`<br>`pull-requests: write` |
| [`.github/workflows/release.yml`](workflows/release.yml) | `push` on tags matching `v*.*.*`<br>`workflow_dispatch` with `verify_only` option | • Runs authoring spec validation, unit tests, and packaging checks<br>• Publishes GitHub Release on tag push without build artifacts<br>• Keeps skills consumable directly via `npx skills` | `contents: write` |

---

## 2. Configuration & Repository Variables

Reviewer configuration is managed dynamically through repository variables (Settings → Secrets and variables → Actions → Variables) without requiring workflow edits:

| Variable Name | Default Value | Description |
|---|---|---|
| `SDW_CODE_REVIEW_ENGINE` | `opencode` | Code review engine (`opencode` or `cursor-sdk`) |
| `SDW_CODE_REVIEW_MODEL` | `opencode-go/claude-haiku-5-5` | Reviewer model identifier |
| `SDW_CODE_REVIEW_VARIANT` | `medium` | Intensity / variant (`low`, `medium`, `high`) |
| `SDW_CODE_REVIEW_MAX_ROUNDS` | `20` | PR review round budget before human handoff (`AGENTIC_CODE_REVIEWERS_MAX_ROUNDS`) |

---

## 3. Required Secrets

Configure repository secrets under Settings → Secrets and variables → Actions → Secrets:

| Secret Name | Required By | Description |
|---|---|---|
| `OPENCODE_API_KEY` | `agentic-code-review.yml` | API key required when using the default `opencode` review engine |
| `CURSOR_API_KEY` | `agentic-code-review.yml` | API key required when using the `cursor-sdk` review engine |

### Fork Safety & Credential Fallback
When a pull request originates from a fork or runs in an environment where neither secret is configured, the code review workflow emits an informational notice (`Review skipped: no OPENCODE_API_KEY or CURSOR_API_KEY secret configured`) and exits cleanly with code `0`. Pull request status checks remain green rather than failing.

---

## 4. Branch Protection (two-tier model)

This repository separates integration from release, so the two long-lived branches carry different rules:

| Rule | `develop` (integration / staging) | `master` (release) |
|---|---|---|
| Purpose | Features from feature branches are integrated and prepared here | Only selected, gated work goes live |
| Required status checks | `test` | `test` + `review` |
| Required approvals | 0 (PR required, self-merge allowed) | 0 (PR required, self-merge allowed) |
| Require conversation resolution | — | yes |
| Require up-to-date branch | no | no |
| Force pushes / deletions | blocked | blocked |
| Enforce for admins | no | no |
| Code review gate | advisory (runs, not required) | **enforced** |

Workflow: create a feature branch from `develop`, integrate it into `develop` through a pull request that passes `CI / test`, then release `develop` into `master` through the quality gate (`CI / test` **and** `Agentic Code Review / review`, with all conversations resolved).

Admins are not subject to the PR requirement, which is what lets `sdw-ship-pr` push `develop` directly after a delivery. Removing that bypass means the delivery flow must move to feature branches.

Apply or refresh the rules with the REST API (requires admin):

```bash
# develop: CI only
gh api -X PUT repos/{owner}/{repo}/branches/develop/protection --input develop-protection.json

# master: CI + agentic review + conversation resolution
gh api -X PUT repos/{owner}/{repo}/branches/master/protection --input master-protection.json
```

with `develop-protection.json`:

```json
{
  "required_status_checks": { "strict": false, "contexts": ["test"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "dismiss_stale_reviews": false, "require_code_owner_reviews": false, "required_approving_review_count": 0 },
  "restrictions": null,
  "required_conversation_resolution": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
```

and `master-protection.json` (identical except `contexts: ["test", "review"]`, `required_conversation_resolution: true`, `dismiss_stale_reviews: true`).

Notes:
- Context names are the **job** names reported by Actions (`test`, `review`), not `Workflow / job`. A context that never runs would block merges forever.
- `required_linear_history` stays `false` because releases are merged with `gh pr merge --merge` (merge commits).
- The unresolved-thread gate in `agentic-code-review.yml` (GraphQL `reviewThreads`) is what makes `review` fail on open threads; `required_conversation_resolution` covers the native conversation model at the same time.

---

## 5. Skills Distribution via `npx skills`

Skills in this repository are distributed as plain Markdown and Node.js CommonJS files:
- There is no compiler, bundler, or build artifact step.
- When a semantic tag (`v*.*.*`) is pushed, `release.yml` creates a release record marking the git tag.
- Consumers install or use skills directly from the repository using `npx skills` (e.g. `npx skills add jpolvora/spec-driven-workflow`).
