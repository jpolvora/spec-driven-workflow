---
id: "81"
slug: 00071-us-81-sdw-run-sync-spec-state-in-the-de
title: "sdw-run: sync spec state in the delivery commit, then ship/converge/merge autonomously on success"
source: github
status: implemented
specDate: 2026-10-29
---
# Specification — sdw-run: sync spec state in the delivery commit, then ship/converge/merge autonomously on success

## Description

A successful delivery currently leaves the run state split across two lifecycles and two manual steps.

**Specification state is not synced atomically.** In run `run-1793274991918-00041-us-20-versioned-spec-fil` (specification 00041), Step 6 committed the registry row as `completed` and Step 8 shipped the pull request, but the specification header stayed `ready-to-implement`. Closing that gap required a separate commit (`c3a02ec`), a direct push to `develop`, and an admin bypass of the branch ruleset.

**Registry rewrites destroy hand-written content.** The same run lost the "Lean-Core Cut (2026-10-25)" rationale block (20 lines) from `.sdw/specs/index.specs.md` because `sdw-spec status` and `sdw-spec sync` regenerate the file and discard every trailing section they do not own. The block had to be restored from git twice, and the delivery commit `0391fa1` shipped the deletion into `develop` (repaired in `147659b`).

**Shipping and merging are manual after a green run.** Steps 1-8 completed with score 10/10, review converged, and checks green, yet `sdw-ship-pr --push --poll-pr --merge` still had to be invoked by an operator afterwards.

The proposal is to make a successful delivery self-closing: fold the header and registry sync into the delivery commit, preserve content the registry writer does not own, and ship, converge, and merge autonomously when, and only when, every gate passed.

### Design Intent

Keep one transactional boundary per lifecycle concern. The registry and the specification header must move together with the code they describe, the writer must never destroy content it did not generate, and unattended delivery must remain fail-closed so no gate can be bypassed by automation.

### Prior Work Sweep

- `skills/sdw-run/scripts/sdw_run.cjs`: Step 6 creates the delivery commit from accepted evidence files plus `.sdw/specs/index.specs.md`; Step 8 delegates to `sdw-ship-pr` without `--merge`.
- `skills/sdw-spec/scripts/spec_index.cjs` and `skills/sdw-spec/scripts/spec_sync.cjs`: registry rendering owns the status definitions, the specification table, and the trailing newline; any other trailing section is discarded on rewrite.
- `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs`: already supports `--poll-pr` and `--merge`, so autonomous delivery is a wiring problem rather than a new capability.
- Issue #81 records the observed failures above with commit evidence.

## Acceptance Criteria

- AC1: When Step 5 scoring meets the configured minimum score, the orchestrator shall write the specification header status `implemented` and the registry row `completed` before creating the delivery commit.
- AC2: The delivery commit shall include the specification header change and the `.sdw/specs/index.specs.md` change together with the accepted implementation files.
- AC3: Where the project configuration enables autonomous delivery, the orchestrator shall invoke `sdw-ship-pr --push --poll-pr --merge` in the same invocation after Steps 6 and 7 pass.
- AC4: If any delivery gate fails, then the orchestrator shall skip ship and merge and shall record the blocking gate in the run state.
- AC5: When the registry writer rewrites `.sdw/specs/index.specs.md`, the system shall preserve every trailing section that it does not own.
- AC6: The system shall report a divergence between a specification header status and its registry row status without mutating either file.

## Notes

- Imported from github as item #81; the pull request must carry `Closes #81` so the merge closes the issue on the SCM.
- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.
- Issue text deliberately excluded from this specification: changing branch protection or rulesets on `develop` or `master`, and auto-merging while review convergence still has active threads.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00071-us-81-sdw-run-sync-spec-state-in-the-de |
| Branch protection and ruleset changes | Repository settings are maintainer-owned and outside the code surface |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Automation opt-in keys | `.sdw/config.json` object `automation` with boolean `autoShip` and `autoMerge`, both defaulting to `false` | Unattended merges must never happen unless the project asks for them | y |
| Registry owned-versus-foreign boundary | Treat the status definitions and the specification table as owned content and everything after them as foreign | Minimal change that stops data loss without a registry format redesign | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | Run validate_spec.cjs in authoring mode |
| Directory layout | Target workspace directories exist and are writable | File system check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Deterministic command execution logs and structured console progress reports naming the synchronized specification status.
- Non-zero exit codes returned upon validation or verification failures.

### Negative & Failing Test Scenarios

- Input rejection test case: the system must reject invalid inputs or malformed options with descriptive error messages.
- Fail-closed delivery: a failing gate must leave ship and merge unattempted and must record the gate name in the run state.
