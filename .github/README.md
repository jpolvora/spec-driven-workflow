# GitHub Actions Automation & CI/CD

This directory defines the automated GitHub Actions workflows, agentic code review integration, and distribution pipeline for **Spec-Driven Workflow (SDW)**.

---

## 1. Workflow Inventory

| Workflow File | Trigger Events | Primary Responsibilities | Minimal Permissions |
|---|---|---|---|
| [`.github/workflows/ci.yml`](workflows/ci.yml) | `pull_request` (`opened`, `synchronize`, `reopened`) on `main`/`master`/`develop`<br>`push` on `main`/`master`/`develop` | • Validates all specifications in `.sdw/specs/` in authoring mode<br>• Runs the unit test suite (`npm test`)<br>• Executes skill packaging verification when present (`scripts/verify_skills.cjs`) | `contents: read` |
| [`.github/workflows/agentic-code-review.yml`](workflows/agentic-code-review.yml) | `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`) on `main`/`master`/`develop`<br>`workflow_dispatch` with `pr_number` | • Runs `agentic-code-reviewers` over the PR diff<br>• Evaluates SDW conformance using [`.github/agentic-code-reviewers-prompt.md`](agentic-code-reviewers-prompt.md)<br>• Skips gracefully on missing credentials (fork-safe)<br>• Blocks merge if unresolved review threads remain | `contents: read`<br>`pull-requests: write` |
| [`.github/workflows/release.yml`](workflows/release.yml) | `push` on tags matching `v*.*.*`<br>`workflow_dispatch` with `verify_only` option | • Runs authoring spec validation, unit tests, and packaging checks<br>• Publishes GitHub Release on tag push without build artifacts<br>• Keeps skills consumable directly via `npx skills` | `contents: write` |
| [`.github/workflows/production-promotion.yml`](workflows/production-promotion.yml) | `pull_request` targeting `master` (`opened`, `synchronize`, `reopened`, `edited`, `ready_for_review`) | • Allows only `develop`, `release/*`, or `hotfix/*` to merge into `master`<br>• Fails feature-branch promotions before review starts | `contents: read` |

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

## 4. Branching Model & Branch Protection

The repository follows a gitflow lane model:

- `feature/*` integrates into `develop` through pull requests.
- `develop` is the protected integration lane.
- `master` is production and receives promotions from `develop` only; `release/*` and `hotfix/*` are the explicit exceptions.

### Required rules

| Rule | `develop` | `master` |
|---|---|---|
| Pull request required | yes | yes |
| Approving reviews | 1 | 1 |
| Dismiss stale reviews on push | yes | yes |
| Required check `test` (`ci.yml`) | yes | yes |
| Required check `review` (`agentic-code-review.yml`) | yes | yes |
| Required check `promotion-guard` (`production-promotion.yml`) | no | yes |
| Conversation resolution | yes | yes |
| Force pushes and deletions | blocked | blocked |

Apply them with the GitHub CLI:

```bash
gh api -X PUT repos/{owner}/{repo}/branches/develop/protection --input develop-protection.json
```

The unresolved-thread check in `agentic-code-review.yml` blocks merge until every reviewer comment is addressed or resolved, so conversation resolution must stay enabled.

---

## 5. Skills Distribution via `npx skills`

Skills in this repository are distributed as plain Markdown and Node.js CommonJS files:
- There is no compiler, bundler, or build artifact step.
- When a semantic tag (`v*.*.*`) is pushed, `release.yml` creates a release record marking the git tag.
- Consumers install or use skills directly from the repository using `npx skills` (e.g. `npx skills add jpolvora/spec-driven-workflow`).
