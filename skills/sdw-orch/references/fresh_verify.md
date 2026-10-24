# Fresh Verification and Adversarial Audit

Spec 00018 separates implementation from judgment. Fresh verification re-derives
one evidence-or-zero verdict per acceptance criterion in a scratch worktree; the
adversarial audit re-derives the run's claims from the delivery diff and turns
any contradiction into a ship-blocking verdict.

Both stages are harness-agnostic: fresh verification hands a fenced prompt and a
verdict file to the host, and the audit reruns the configured test command. They
never call a vendor SDK or a provider API. They are opt-in, so a run that
disables both behaves exactly as before.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `verification.freshVerifyEnabled` | `boolean` | `false` | Run the Step 4 -> 5 fresh-verification stage. When enabled, scoring is blocked until every criterion has an accepted verdict. |
| `verification.testCommand` | `string \| null` | `null` | Command run inside the scratch worktree. It falls back to the legacy `testCommand`. Without it no fault is interpretable and every criterion stays `unverified`. |
| `verification.timeoutMs` | `integer` | `600000` | Test-command timeout in milliseconds. |
| `verification.auditVerdictsBlockShip` | `string` | `"refuted"` | `refuted` blocks `refuted` audit verdicts only; `caveats` also blocks `caveats`. |

## Verifier contract

1. `fresh-verify --run-id <runId>` creates `.sdw/worktrees/{runId}/fresh-verify`
   detached from the run's `baseCommit`, applies the delivery diff, and writes
   the verifier prompt plus a verdict template under the run artifact directory.
2. The verifier receives exactly two inputs: the specification acceptance
   criteria and the delivery diff. The prompt renderer refuses any other key, so
   the implementation transcript, worker reasoning, DAG prompts, judge verdicts,
   and run state cannot reach it.
3. The verdict file holds one entry per criterion and nothing else:

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

4. The only accepted verdict values are `verified` and `unverified`. A missing
   criterion, a duplicate id, or any other value rejects the whole file; no
   partial verdict is recorded.
5. `fresh-verify --run-id <runId> --verdict <path>` validates the file, applies
   the fault gate, records `state.freshVerify`, and removes the scratch worktree
   on every terminal path. Exit codes: `0` accepted, `1` failed closed (verdict
   rejected, fault injection failed, or cleanup failed), `4` awaiting a verdict
   or parked on residual defects.

### Fault injection rules

- One deterministic, reversible mutation per criterion. A fault is an
  exact-string replacement (`file`, `find`, `replace`) applied in isolation in
  the scratch worktree and reverted before the next criterion.
- The test command runs once on the unmutated scratch worktree. A `verified`
  claim needs both an observed passing baseline and a detected fault; anything
  less downgrades that criterion to `unverified` with the reason recorded.
- A fault that leaves the suite green is an adequacy defect: the criterion is
  `unverified`, because the test cannot fail for that behaviour.
- A criterion with no runnable surface uses `{ "acId": "ACn", "noOp": true,
  "reason": "..." }`. A documented no-op is still `unverified`; only a detected
  fault plus an observed passing baseline can verify.
- A supplied fault plan must cover every criterion in declaration order. The
  plan is a JSON array (or `{ "faults": [...] }`) passed with `--faults`. Without
  a plan every criterion degrades to a documented no-op.
- An inapplicable fault (target text not found exactly once, target outside the
  scratch tree, or a dirty tree after revert) fails closed rather than skipping.

### Round policy

- At most three fix-and-re-verify rounds; a fourth start is refused before any
  scratch worktree is created.
- Round 3 with residual defects records `paused_residual_defects`, lists each
  remaining criterion and reason, removes the scratch worktree, and keeps the
  run paused. Step 5 is never reached with unverified work.

## Audit verdict semantics

`audit --run-id <runId>` collects the criteria and files claimed by accepted
Step 4 tasks and the acceptance criteria ledger, compares them with
`git diff --name-only <baseCommit>[ <deliveryCommit>]`, reruns verification in
`.sdw/worktrees/{runId}/audit`, and records one verdict per claimed criterion on
`state.audit`.

| Verdict | Meaning | Ship effect |
| --- | --- | --- |
| `confirmed` | Claim and evidence agree: claimed files appear in the diff, the ledger verifies the criterion, proof evidence is linked, and re-verification passed. | None |
| `refuted` | Evidence contradicts the claim: a claimed file is absent from the diff, the ledger marks the criterion failed, or re-verification failed. | Always blocks ship. |
| `caveats` | Evidence is present but incomplete: re-verification is unavailable, the ledger is missing or unverified, no proof evidence is linked, no claimed file maps the criterion, or fresh verification marked it unverified. | Blocks ship only when `verification.auditVerdictsBlockShip` is `caveats`. |

The audit never rewrites tracked files; it fails closed when the run has no
`baseCommit` to compare against, and it removes its scratch worktree on success,
failure, and pause.

## Ship gate and reporting

- Step 8 evaluates the recorded audit verdicts before any pre-PR or ship work.
  Under policy `refuted` (default) any `refuted` verdict blocks; under policy
  `caveats` a `caveats` verdict blocks too. A blocked ship records Step 8
  `blocked_audit`, the `state.auditGate` decision, fails the run, exits non-zero,
  and names the blocking criteria in the error.
- No audit record means no gate, so a run that never audits is unchanged.
- The delivery report renders `## Fresh Verification & Audit` with the
  fresh-verify status, round, verified/unverified counts, scratch cleanup
  outcome, and residual-defect count, plus the audit verdict counts, policy, and
  blocking criteria. An absent record renders `not recorded` instead of failing
  the report.
