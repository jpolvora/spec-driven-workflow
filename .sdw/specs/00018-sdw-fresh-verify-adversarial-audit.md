---
id: null
slug: 00018-sdw-fresh-verify-adversarial-audit
title: "SDW Fresh-Context Verification and Adversarial Audit"
source: local
status: implemented
specDate: 2026-10-19
priority: medium
value: "Independent fresh-context verification with fault injection, so tests must prove they can fail"
effort: L
blockedBy: ["00017"]
---

# Specification — SDW Fresh-Context Verification and Adversarial Audit

## Description

Spec 015 makes implementation evidence mandatory and spec 017 makes the score derive from an acceptance criteria ledger. Neither prevents an implementer from marking its own work as verified based on plausible-looking files or tests that do not actually exercise the requirement. The current Step 7 is a deterministic pattern scan, not an independent verification of behavior. There is no fresh-context re-derivation of acceptance criteria, no fault injection to prove tests can fail, and no adversarial audit of claimed work against the real diff.

This specification adds a fresh-context verification stage and an adversarial audit command. Fresh verification runs in a scratch worktree, receives only the specification criteria and the diff, and must produce one evidence-or-zero verdict per acceptance criterion. The verifier injects one deliberate fault per criterion and requires the test suite to fail; a criterion whose fault is not detected is marked unverified. The audit command recomputes claims against git diffs and re-run verification, returning `confirmed`, `refuted`, or `caveats`.

### Design Intent

Separate implementation from judgment. Fresh context prevents the verifier from inheriting the implementer's assumptions and rationalizations. Fault injection turns "tests pass" into "tests can fail for the right reason", which is the cheapest deterministic evidence of test adequacy. The audit command preserves the adversarial posture at ship time without requiring a second full pipeline. The stage is harness-agnostic: it reuses the spec 015 execution contract (`handoff` or `command`) and never embeds a vendor SDK.

## Acceptance Criteria

- AC1: The system shall provide a `fresh-verify` command that runs after Step 4 evidence acceptance and before final scoring.
- AC2: When `fresh-verify` starts, the system shall create a scratch worktree from the delivery diff.
- AC3: The system shall provide the verifier only the specification acceptance criteria and the diff.
- AC4: The system shall require one verdict per acceptance criterion with `verified` or `unverified`.
- AC5: The system shall inject one deliberate fault per acceptance criterion into the scratch worktree.
- AC6: When a fault injection does not produce a failing test, the system shall mark the corresponding acceptance criterion unverified.
- AC7: The system shall require observed passing test evidence before marking an acceptance criterion verified.
- AC8: The system shall allow at most three fix and re-verify rounds.
- AC9: If residual defects remain after the third round, then the system shall pause the run with the residual defect list.
- AC10: The system shall remove the scratch worktree after verification completes or fails.
- AC11: The system shall provide an `audit` command that compares claimed work against git diffs and reruns verification.
- AC12: The system shall classify each audit verdict as `confirmed`, `refuted`, or `caveats`.
- AC13: If an audit verdict is `refuted`, then the system shall block ship.
- AC14: Where `auditVerdictsBlockShip` is `caveats`, the system shall also block ship for `caveats` verdicts.
- AC15: The system shall record fresh-verify and audit results in run state and the Step 5 report.
- AC16: The system shall document the verifier contract, fault injection rules, and audit verdict semantics.
- AC17: If the scratch worktree cannot be created, then the system shall fail closed without scoring.
- AC18: When `fresh-verify` uses command mode, the system shall execute `verification.freshVerifyCommand` with `{promptFile}`, `{evidenceFile}`, `{cwd}`, and `{slug}` substitutions.
- AC19: The system shall add tests for fresh verification, fault injection, residual defects, audit verdicts, and scratch cleanup.

## Notes

- Implementation surfaces:
  - `skills/sdw-orch/scripts/fresh_verify.cjs` (new): scratch worktree lifecycle, verifier prompt rendering, fault injection, verdict validation, and cleanup.
  - `skills/sdw-orch/scripts/audit_runner.cjs` (new): claim-to-diff comparison, re-verification dispatch, and verdict aggregation.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: insert the fresh-verify phase between Step 4 and Step 5; expose `audit`; apply ship blocking.
  - `skills/sdw-orch/scripts/ac_ledger.cjs`: link fresh-verify and audit evidence to AC records.
  - `skills/sdw-orch/references/fresh_verify_contract.md` (new): verifier prompt, verdict schema, fault rules, and audit semantics.
- Configuration:
  ```json
  {
    "freshVerifyEnabled": true,
    "freshVerifyMaxRounds": 3,
    "freshVerifyCommand": null,
    "faultInjectionEnabled": true,
    "auditVerdictsBlockShip": "refuted"
  }
  ```
- Verifier evidence schema:
  ```json
  {
    "criteria": [
      {
        "id": "AC1",
        "verdict": "verified",
        "passingEvidence": "tests/sdw_orch.test.cjs::handoff pause",
        "faultInjected": "removed exit code 4 branch",
        "faultObserved": true
      }
    ],
    "residualDefects": []
  }
  ```
- Fault injection rules: one deterministic mutation per AC, applied in isolation on the scratch worktree; the injected change must be reverted before the next AC. A fault that does not cause a test failure is an adequacy defect. When a criterion has no runnable test, the verdict is `unverified` regardless of implementation quality.
- Round policy: round 1 is a full verification; rounds 2 and 3 re-verify only residual defects and the tasks that changed. Round 3 with residual defects pauses the run; the operator may resume after a fix.
- Audit rules: an audit re-derives each AC verdict from the diff, the ledger, and the tests. `confirmed` means claim and evidence agree; `refuted` means evidence contradicts the claim; `caveats` means evidence is incomplete or unverifiable. `refuted` always blocks ship; `caveats` blocks only under the configured policy.
- Scratch cleanup: remove the worktree and temporary branch on success, failure, pause, and process interruption. Preserve the worktree only when fault injection cannot be reverted.
- Tests: add `tests/sdw_fresh_verify.test.cjs`. Cover scratch creation failure, context exclusion, one-verdict-per-AC enforcement, fault detection and non-detection, max rounds, residual pause, audit verdicts, ship blocking, command mode, and cleanup on failure.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing Step 7 static review | Fresh verification complements, not replaces, the review loop |
| Running mutation testing tools | Fault injection is a targeted per-AC check, not a full mutation score |
| Vendor-specific verifier agents or API calls | The execution contract reuses spec 015 handoff or command modes |
| Rewriting acceptance criteria during verification | Verification reads the canonical specification |
| Cross-run trend analytics for verification outcomes | Reporting is tracked by spec 023 |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Verification execution | Reuse spec 015 handoff or command contract | Avoids a second execution mechanism and vendor coupling | y |
| Verifier context | Criteria plus diff only | Prevents implementer bias from contaminating judgment | y |
| Fault granularity | One fault per AC | Bounded cost and directly tied to criterion adequacy | y |
| Maximum rounds | Three | Matches existing review-loop conventions and bounds runtime | y |
| Residual defects after round three | Pause the run | Preserves a human decision point instead of shipping unverified work | y |
| Audit default policy | Block on `refuted` only | Preserves the safety floor while allowing incomplete evidence to be reviewed | y |
| Scratch failure | Fail closed | Verification cannot be trusted if isolation cannot be established | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Execution contract | Spec 015 handoff and command modes implemented | Run the spec 015 test suite |
| Ledger | Spec 017 ledger linking available | Run the spec 017 test suite |
| Git baseline | Worktree creation and removal available | Execute `git worktree add` and `git worktree remove` in a fixture |
| Test runner | A configured test command exists for fault detection | Inspect `verification.testCommand` |
| Workspace configuration | `.sdw/config.json` valid | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | This specification registered as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | This specification passes canonical authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00018-sdw-fresh-verify-adversarial-audit.md` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output per criterion, e.g. `[Fresh Verify] AC1 verified (fault observed, evidence ...)`.
- Run state contains `freshVerify.rounds`, per-AC verdicts, fault results, and residual defects.
- The scratch worktree is absent after a successful, failed, or paused verification.
- Audit output lists each verdict with the claim, observed evidence, and blocking decision.
- Step 5 report includes fresh-verify verdicts and audit outcomes.

### Negative & Failing Test Scenarios

- Fault not detected: a fault that leaves tests green marks the AC unverified.
- No test for AC: a criterion without runnable evidence is unverified even when files exist.
- Missing verdict: a verifier output that omits an AC is rejected.
- Scratch failure: an unwritable worktree path fails closed before scoring.
- Residual defects: three rounds with remaining defects pause the run and list them.
- Audit refuted: a claim contradicted by the diff blocks ship.
- Audit caveats: under `auditVerdictsBlockShip: caveats`, incomplete evidence blocks ship.
- Cleanup failure: a worktree that cannot be removed is reported without silently continuing.
- Command mode error: a fresh-verify command exiting non-zero marks verification failed.
