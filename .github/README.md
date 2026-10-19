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
| `SDW_CODE_REVIEW_MODEL` | `opencode-go/deepseek-v4.1-flash` | Reviewer model identifier |
| `SDW_CODE_REVIEW_VARIANT` | `medium` | Intensity / variant (`low`, `medium`, `high`) |

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

## 4. Branch Protection Recommendations

For repository maintainers, the following branch protection rules are recommended on `main` and `develop`:

1. **Require status checks to pass before merging**:
   - `CI / test` (from `ci.yml`)
   - `Agentic Code Review / review` (from `agentic-code-review.yml`)
2. **Require review thread resolution**:
   - The unresolved thread check in `agentic-code-review.yml` queries active GraphQL review threads and blocks merge until all reviewer comments have been addressed or resolved.
3. **Require linear history** or squash merges to keep the commit history clean and atomic.

---

## 5. Skills Distribution via `npx skills`

Skills in this repository are distributed as plain Markdown and Node.js CommonJS files:
- There is no compiler, bundler, or build artifact step.
- When a semantic tag (`v*.*.*`) is pushed, `release.yml` creates a release record marking the git tag.
- Consumers install or use skills directly from the repository using `npx skills` (e.g. `npx skills add jpolvora/spec-driven-workflow`).
