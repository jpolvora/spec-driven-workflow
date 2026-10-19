---
id: null
slug: 017-sdw-ac-ledger-traceability
title: "SDW Acceptance Criteria Ledger and Traceability"
source: local
specDate: 2026-10-19
---

# Specification — SDW Acceptance Criteria Ledger and Traceability

## Description

Spec 015 requires implementation task evidence and removes lexical keyword scoring from Step 5, but it does not define a durable, auditable ledger that aggregates evidence from implementation, tests, review, and sabotage. Today the score is recomputed from whatever files and diffs happen to exist, and the reasoning behind a verified acceptance criterion is not preserved. A run cannot answer which AC each change, test, commit, or review finding supports, and a later score recomputation can silently disagree with the earlier result.

This specification introduces a per-run acceptance criteria ledger at `{stateDir}/{slug}/{runId}/ac-ledger.json`. The ledger is the single source of truth for AC status and evidence. Every accepted task, test result, review finding, and sabotage outcome links to one or more AC ids. Step 5 derives its score from the ledger only. The ledger is hashed into run state so tampering or drift is detectable.

### Design Intent

Make verification traceable and reproducible. The ledger records facts, not opinions: an AC is verified only when at least one typed evidence entry exists. A hash anchors the ledger to run state, so a score cannot be authored directly or changed after the fact without detection. The ledger is machine-readable JSON for tooling and has a deterministic Markdown report for humans. Keeping the ledger per run preserves evidence across re-runs and allows comparison between iterations.

## Acceptance Criteria

- AC1: The system shall initialize `ac-ledger.json` in the run artifact directory when a run starts.
- AC2: The system shall create one ledger record per acceptance criterion with `id`, `text`, `status`, and `evidence`.
- AC3: The system shall provide a `ledger link` command that accepts one or more AC ids and an evidence payload.
- AC4: The system shall restrict evidence types to `file`, `test`, `commit`, `review`, and `sabotage`.
- AC5: If `ledger link` references an unknown AC id, then the system shall reject the update without modifying the ledger.
- AC6: When Step 4 accepts task evidence, the system shall link the evidence files and commit SHA to the referenced AC records.
- AC7: When Step 5 computes the score, the system shall count only AC records with at least one evidence entry.
- AC8: The system shall derive the 0–10 score from the verified ledger count and the total AC count.
- AC9: The system shall record a SHA-256 hash of the ledger in run state after every accepted update.
- AC10: If the ledger hash in run state does not match the ledger file, then the system shall fail verification.
- AC11: The system shall provide a `ledger report` command that emits a Markdown or JSON summary of AC status and evidence.
- AC12: The system shall provide a `ledger audit` command that lists acceptance criteria without evidence.
- AC13: If an acceptance criterion declares a negative scenario without an observed passing test, then the system shall cap the score at 8.
- AC14: The system shall record ledger evidence paths relative to the project root with forward slashes.
- AC15: The system shall preserve ledger records across resume and reject duplicate evidence entries.
- AC16: The system shall document the ledger schema, commands, and score derivation in the orchestrator protocol.
- AC17: If ledger initialization fails, then the system shall fail the run before Step 1 completes.

## Notes

- Implementation surfaces:
  - `skills/sdw-orch/scripts/ac_ledger.cjs` (new): schema initialization, evidence linking, validation, hashing, reporting, and auditing.
  - `skills/sdw-orch/scripts/sdw_orch.cjs`: initialize the ledger before Step 1; link task evidence after Step 4; derive Step 5 score from the ledger.
  - `skills/sdw-orch/scripts/score_evaluator.cjs`: consume ledger status instead of scanning diffs or keyword matching.
  - `skills/sdw-orch/scripts/state_manager.cjs`: persist `acLedgerPath` and `acLedgerSha256`.
  - `skills/sdw-orch/references/orchestrator_protocol.md`: document schema, commands, hash rules, and score derivation.
- Ledger schema (example):
  ```json
  {
    "runId": "run-1792400000000-015-sdw-orch-implementation-execution",
    "specSlug": "015-sdw-orch-implementation-execution",
    "generatedAt": "2026-10-19T12:00:00.000Z",
    "criteria": [
      {
        "id": "AC1",
        "text": "The system shall support handoff and command modes.",
        "status": "verified",
        "evidence": [
          { "type": "file", "path": "skills/sdw-orch/scripts/implementation_runner.cjs", "taskId": "task-1" },
          { "type": "commit", "sha": "a1b2c3d", "taskId": "task-1" }
        ]
      }
    ]
  }
  ```
- `ledger link` usage:
  ```bash
  node skills/sdw-orch/scripts/sdw_orch.cjs ledger link --run-id <id> --ac AC1 AC2 --type test --name "implementation contract" --status passed
  node skills/sdw-orch/scripts/sdw_orch.cjs ledger link --run-id <id> --ac AC3 --type commit --sha a1b2c3d
  ```
- Status rules: `unverified` has no evidence; `verified` has at least one evidence entry. Evidence entries are append-only and de-duplicated by type plus stable identity (`path`, `sha`, test name, review id).
- Score rule: `score = round(verifiedCount / totalCount * 10)`, capped at 8 when a declared negative scenario lacks observed passing test evidence. A specification with zero ACs scores 0 and fails closed.
- Hash rule: SHA-256 over canonical JSON (sorted keys, stable array order) written to state after every accepted link. A mismatch fails Step 5 and blocks Step 6.
- Failure policy: ledger initialization or write failures fail the run before Step 1; link validation failures leave the ledger unchanged and return a non-zero exit code.
- Tests: add `tests/sdw_ac_ledger.test.cjs`. Cover initialization, one record per AC, unknown AC rejection, evidence type validation, duplicate suppression, hash mismatch, score derivation, negative-scenario cap, report and audit output, and resume preservation.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Independent fresh-context verification and fault injection | Tracked by spec 018 |
| Mutation testing execution and sabotage runners | The ledger records sabotage evidence but does not run the tools |
| Authoring or rewriting acceptance criteria | The ledger consumes the canonical specification as written |
| Cross-run historical analytics and dashboards | Reporting is tracked separately by spec 023 |
| Encrypted or signed ledger storage | A SHA-256 anchor in run state is sufficient for drift detection |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Ledger scope | One ledger per run | Preserves evidence per execution and supports comparison across runs | y |
| Source of truth | Ledger JSON, not computed diffs | Makes verification reproducible and auditable | y |
| Evidence granularity | Typed entries with stable identities | Enables de-duplication and traceability without a graph database | y |
| Negative-scenario cap | Cap at 8 | Mirrors the workflow-skills convention and prevents shipping untested failure paths | y |
| Hash algorithm | SHA-256 over canonical JSON | Standard library support and deterministic comparison | y |
| Initialization failure | Fail the run before Step 1 | A run without a ledger cannot produce a trustworthy score | y |
| Resume behavior | Preserve the existing ledger and append new evidence | Avoids losing prior accepted evidence | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Implementation execution | Spec 015 task evidence contract implemented | Run the spec 015 test suite |
| Artifact layout | Spec 014 run artifact directory available | Inspect `.sdw/state/{slug}/{runId}/` |
| Workspace configuration | `.sdw/config.json` valid with resolved `stateDir` | Run `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specification index | This specification registered as `pending` | Run `node skills/sdw-spec/scripts/sdw_spec.cjs list` |
| Authoring standard | This specification passes canonical authoring validation | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/017-sdw-ac-ledger-traceability.md` |
| Test baseline | Existing `node:test` suite passes | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Console output for ledger initialization and each accepted link, e.g. `[Ledger] AC1 verified (file, commit)`.
- `ac-ledger.json` exists under the run artifact directory and contains one record per AC.
- Run state contains `acLedgerPath` and `acLedgerSha256` after each accepted update.
- Step 5 output reports verified and unverified counts derived from the ledger.
- `ledger audit` lists every AC without evidence and exits non-zero when any remain.
- `ledger report` renders the same verified count as Step 5.

### Negative & Failing Test Scenarios

- Unknown AC: linking `AC99` in a specification with fewer criteria is rejected and the ledger is unchanged.
- Invalid evidence type: `--type screenshot` is rejected with the allowed enum.
- Duplicate evidence: linking the same test twice produces one ledger entry.
- Hash mismatch: editing `ac-ledger.json` after a link makes Step 5 fail.
- Missing negative test: an AC with a declared negative scenario and no passing test caps the score at 8.
- Initialization failure: a read-only artifact directory fails the run before Step 1.
- Zero ACs: a specification without acceptance criteria scores 0 and fails closed.
- Resume preservation: resuming a run keeps prior evidence and appends new entries without duplication.
