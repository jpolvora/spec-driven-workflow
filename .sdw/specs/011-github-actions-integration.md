---
id: null
slug: 011-github-actions-integration
title: "GitHub Actions Integration — CI, Agentic Code Review, and Skills Distribution"
source: local
specDate: 2026-10-19
---

# Specification — GitHub Actions Integration — CI, Agentic Code Review, and Skills Distribution

## Description

The repository currently ships no `.github/` automation: pull requests receive no automated specification validation, no test gate, no review enforcement, and version tags publish nothing. This specification establishes the repository's GitHub Actions integration as three workflow files plus one review prompt asset, adapted from the proven `workflow-skills` project examples (`.github/workflows/ci.yml`, `agentic-code-review.yml`, `deploy-site.yml`).

1. **Continuous Integration (`.github/workflows/ci.yml`)**: triggers on pull requests and on pushes to the default branch. Runs Node.js 22, validates every specification in `.sdw/specs/` in authoring mode, executes `npm test`, and runs the skill packaging verification script once it exists (spec 006).
2. **Agentic Code Review (`.github/workflows/agentic-code-review.yml`)**: triggers on pull request lifecycle events and manual dispatch. Runs the external `agentic-code-reviewers` runner against the pull request diff with an engine, model, and variant selected through repository Variables (defaults documented in the workflow), posts findings as review comments, and blocks merge while unresolved review threads exist. When no engine credential secret is configured (fork pull requests, fresh clones), the workflow skips with a notice instead of failing.
3. **Release and Distribution (`.github/workflows/release.yml`)**: triggers on semantic version tags (`v*.*.*`) and manual dispatch. Repeats validation, tests, and packaging verification, then publishes the repository tag for discovery through the open `npx skills` ecosystem (`vercel-labs/skills` / skills.sh). No build output is produced: distributed skills are the plain Markdown and Node.js files in the repository, keeping distribution vendor-neutral.

Additionally, `.github/agentic-code-reviewers-prompt.md` encodes the SDW-specific review contract (EARS conformance, three-tier skill budgets, agent agnosticism, breaking-changes policy, and the no-unrequested-commit rule) as the custom prompt for the reviewer's Custom stack.

Ownership boundary: this specification owns all `.github/workflows/` YAML files and the review prompt asset; spec 006 retains ownership of the packaging format and the `scripts/verify_skills.cjs` verification helper that the workflows invoke.

### Design Intent

Reuse the battle-tested workflow shapes from `workflow-skills` (validated on a public repository) while stripping project-specific machinery that SDW does not need, such as the GitHub Pages catalog deployment. Workflow logic delegates to deterministic Node.js scripts already owned by the repository instead of embedding logic in YAML, keeping the automation agent- and harness-agnostic per AGENTS.md rule 5. The review engine stays configurable through repository Variables so no workflow hard-codes a vendor model, and credential-less environments degrade gracefully rather than blocking contributors.

## Acceptance Criteria

- AC1: The system shall provide GitHub Actions workflow files under `.github/workflows/` covering continuous integration, agentic code review, and release distribution.
- AC2: When a pull request is opened, synchronized, or reopened, the CI workflow shall validate every specification in `.sdw/specs/` in authoring mode.
- AC3: When a pull request is opened, synchronized, or reopened, the CI workflow shall execute the unit test suite via `npm test`.
- AC4: When the packaging verification script from spec 006 exists, the CI workflow shall execute it as part of the pull request checks.
- AC5: The CI workflow shall run on Node.js 22 with no external npm dependencies beyond the repository's zero-dependency baseline.
- AC6: When a pull request requires review, the code review workflow shall execute the agentic code reviewer against the pull request diff.
- AC7: The code review workflow shall read engine, model, and variant selections from repository Variables with documented fallback defaults.
- AC8: If no review engine credential secret is configured, then the workflow shall skip the review with a notice instead of failing the pull request.
- AC9: When the agentic reviewer publishes findings, the code review workflow shall block merge while unresolved review threads remain.
- AC10: Where the SDW review prompt asset exists, the code review workflow shall pass it to the reviewer as the custom stack prompt.
- AC11: The system shall provide a review prompt asset at `.github/agentic-code-reviewers-prompt.md` encoding SDW conformance checks.
- AC12: When a tag matching `v*.*.*` is pushed, the release workflow shall run specification validation, tests, and packaging verification before publishing.
- AC13: Where the release workflow is dispatched manually, the system shall support verification-only execution without publishing a release.
- AC14: If any validation, test, or verification step fails, then the release workflow shall cancel publication.
- AC15: The system shall limit external workflow actions to official GitHub checkout, setup-node, and artifact actions.
- AC16: The code review workflow shall request minimal permissions consisting of read contents and write pull requests.
- AC17: When the review workflow is dispatched manually with a pull request number, the system shall resolve the pull request context via the GitHub CLI.
- AC18: The release workflow shall publish the repository tag without build artifacts, keeping distribution consumable via `npx skills` directly from the repository.
- AC19: The system shall document required secrets, variables, permissions, and branch protection expectations in the workflow file comments and `.github/README.md`.
- AC20: Where a pull request originates from a fork, the workflow shall skip credentialed steps without failing the check.

## Original Issue Context

The specification originated from the user request to automate GitHub-side integration:

> implement the integration github actions for code-review, deployment etc - check necessary instructions/steps to integrate build for vercel npx skills utility format distribution. The spec contemplates workflow files .yml for github - check workflow-skills project example and adapt to this project

## Notes

- Workflow Inventory:

| File | Trigger | Jobs |
|---|---|---|
| `.github/workflows/ci.yml` | `pull_request`, `push` (default branch) | spec validation loop, `npm test`, packaging verification (when present) |
| `.github/workflows/agentic-code-review.yml` | `pull_request` (opened, synchronize, reopened, ready_for_review), `workflow_dispatch` (pr_number input) | agentic review run, unresolved-thread gate |
| `.github/workflows/release.yml` | tag `v*.*.*`, `workflow_dispatch` (verify-only input) | validation, tests, packaging verification, tag release publish |

- CI Workflow Steps (adapted from `workflow-skills/.github/workflows/ci.yml`):
  1. `actions/checkout` with `fetch-depth: 0`.
  2. `actions/setup-node` with Node 22.
  3. Spec validation loop: `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring --repo-root . .sdw/specs/<file>` for every spec file; any failure exits non-zero.
  4. `npm test` (Node built-in test runner over `tests/*.test.cjs`).
  5. Packaging verification (`node scripts/verify_skills.cjs`) guarded by an existence check so it activates automatically once spec 006 lands.
  - Deliberately dropped from the source example: ripgrep installation and the `ws-check-workflows` simulation, both specific to `workflow-skills`.
- Code Review Workflow (adapted from `workflow-skills/.github/workflows/agentic-code-review.yml`):
  - Repository Variables: `SDW_CODE_REVIEW_ENGINE` (default `opencode`), `SDW_CODE_REVIEW_MODEL` (default `opencode-go/claude-haiku-5-5`), `SDW_CODE_REVIEW_VARIANT` (default `medium`).
  - Secrets: `OPENCODE_API_KEY` for the opencode engine, `CURSOR_API_KEY` for the cursor-sdk engine; exactly one is required at run time.
  - Runner: `curl` of `agentic-code-reviewers` `release/run.sh`, invoked with `--engine`, `--model`, `--variant`, `--gh`, `--pr-id`, `--stack Custom`, `--custom-prompt .github/agentic-code-reviewers-prompt.md`, `--source-branch`, and `--target-branch`.
  - Credential detection runs before the review step; when the required secret is absent the job logs a skip notice and exits 0 (fork-safe).
  - Unresolved-thread gate: GraphQL query over `pullRequest.reviewThreads` where `isResolved == false` and `isOutdated == false`; a non-zero count fails the job with an actionable message.
  - `concurrency` group keyed on the pull request number with `cancel-in-progress: true`; job timeout 25 minutes.
- Review Prompt Asset (`.github/agentic-code-reviewers-prompt.md`): adapted from `workflow-skills/.github/agentic-code-reviewers-prompt.md`, encoding SDW checks — EARS acceptance-criteria conformance, Tier 1 `SKILL.md` line budget (≤ ~120 lines), zero external runtime dependencies in bundled skills, agent and harness agnosticism, breaking-changes-encouraged policy (no compatibility shims expected), and the no-unrequested-version-control-writes rule.
- Release Workflow: on tag push, run the same validation chain as CI, then `gh release create <tag>` with generated notes; on manual dispatch, run verification only. Publishing a release is what makes the tag discoverable by the `npx skills` ecosystem; no site or binary build step exists.
- Ownership Boundary (spec 006): the packaging format, frontmatter conformance, and `scripts/verify_skills.cjs` helper remain defined by spec 006; this specification consumes them and owns only the workflow files.
- Vendor Neutrality: workflow logic lives in Node.js `.cjs` helpers invoked from YAML; the only external actions are official GitHub actions (checkout, setup-node, upload-artifact). Distribution does not depend on GitHub Actions at all.
- Documentation Asset (`.github/README.md`): lists required secrets (`OPENCODE_API_KEY` or `CURSOR_API_KEY`), repository Variables, minimal permissions, and the recommended branch protection rule requiring the CI and review checks before merge.

## Out of Scope

| Feature | Reason |
|---------|--------|
| GitHub Pages catalog site and `deploy-site.yml` | SDW ships no documentation site; the source example's deployment job is not portable without a site generator |
| Self-hosted runners or non-GitHub CI platforms | The request is explicitly GitHub Actions; workflow logic stays portable in Node scripts should another platform be added later |
| Automatic pull request creation or merge automation by the orchestrator | Remote SCM operations remain manual; the no-unrequested-version-control-writes rule applies to agents |
| Release versioning automation (semantic-release, version bumping) | Tags are maintainer-created; no versioning policy is prescribed yet |
| Matrix builds across Node versions or operating systems | Node 22 is the single supported runtime per AGENTS.md |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Review engine default | `opencode` with `opencode-go/claude-haiku-5-5` | Matches the proven default in the `workflow-skills` example | y |
| Credential-less behavior | Skip review with notice | Keeps fork pull requests and fresh clones green without secrets | y |
| Release trigger | Tag push matching `v*.*.*` | Consistent with spec 006 and standard release practice | y |
| Review prompt source | Adapted copy of the `workflow-skills` prompt | The source prompt is validated in production and only needs SDW-specific checks added | y |
| Distribution mechanism | Repository tag consumed by `npx skills` | No build artifacts exist for Markdown and Node.js skills; `vercel-labs/skills` reads the repository directly | y |
| Workflow runtime | Node.js 22 only | Single supported runtime; avoids matrix complexity | y |
| Cost model | Public repository standard GitHub-hosted runners | Repository is public; minutes are free | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Workspace configuration | `.sdw/config.json` is initialized and valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | Feature is tracked in `.sdw/specs/index.specs.md` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | Specification adheres to canonical SDW standard and EARS syntax | Run `node skills/sdw-spec/scripts/sdw_spec.cjs validate .sdw/specs/011-github-actions-integration.md --mode=authoring` |
| Test suite availability | `npm test` passes locally before enabling CI | Run `npm test` |
| Source workflow examples | Reference workflow files are readable for adaptation | Inspect `L:\source\workflow-skills\.github\workflows\` |
| Review runner repository | `jpolvora/agentic-code-reviewers` release channel is reachable | Fetch `https://raw.githubusercontent.com/jpolvora/agentic-code-reviewers/release/run.sh` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- CI check runs appear on pull requests with per-step logs for spec validation, tests, and packaging verification.
- Review workflow logs the selected engine, model, and variant before execution, e.g. `engine=opencode model=opencode-go/claude-haiku-5-5 variant=medium`.
- Skip notice emitted when no credential is configured: `Review skipped: no OPENCODE_API_KEY or CURSOR_API_KEY secret configured`.
- Unresolved-thread gate prints the active thread count and fails with an actionable error listing the count.
- Release workflow logs the tag, validation results, and the created release URL.

### Negative & Failing Test Scenarios

- Malformed specification blocking CI: when any `.sdw/specs/*.md` fails authoring validation, the CI job must fail with the validator error output and the pull request check must be red.
- Test failure blocking release: when `npm test` fails on a tagged commit, the release workflow must cancel publication and no GitHub release must exist for that tag.
- Missing credential resilience: when neither review secret is configured, the review job must skip with a notice and exit successfully rather than failing the pull request.
- Unresolved thread enforcement: with an open, non-outdated review thread, the thread gate must fail the job and block merge.
- Packaging verification failure: when a skill directory violates the three-tier structure, the packaging step must exit non-zero and fail the workflow.
- Fork pull request safety: when a fork pull request cannot access secrets, credentialed steps must be skipped without workflow failure.
