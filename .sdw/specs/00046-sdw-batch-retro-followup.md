---
id: "46"
slug: 00046-sdw-batch-retro-followup
title: "Unattended Batch Retro Follow-Up — Queued Specs From Retrospective Candidates"
source: local
status: draft
specDate: 2026-10-21
---

# Specification — Unattended Batch Retro Follow-Up — Queued Specs From Retrospective Candidates

## Description

### Problem

`sdw-batch` runs a queue unattended, but everything a run learns stays inside that run's artifacts. With spec 00045 the retrospective runs automatically and writes candidates; inside a batch nobody reads them. A candidate that names a real defect (a duplicated run state, a missing guard, a prompt that lies) is written to a report and then forgotten, which is the same outcome as not running the retrospective at all.

The batch also has no policy for what to do with that knowledge, and a naive policy loops: every queued follow-up item produces its own run, whose retrospective can queue more items forever.

### Proposal

`sdw-batch` gains an explicit follow-up policy, driven by one config key:

1. After an item completes, read the `state.retro` record the orchestrator already wrote and summarize its candidates in the manifest.
2. Under the default `retro.followUp: "queue"`, turn every `critical` and `high` candidate into a draft specification through the `sdw-spec` CLI and append it to the same queue, after the operator's own items.
3. `"record"` writes a single follow-up report and creates nothing; `"none"` skips the work entirely.
4. Follow-up items carry `followUpDepth: 1` and are never used to generate further follow-ups, which bounds the queue.

No prompts, no halts, no direct edits: the batch routes knowledge into specs and keeps delivering.

### Scope

- `skills/sdw-batch/scripts/sdw_batch.cjs`: follow-up stage after an item completes, manifest fields, queued-item creation, summary output.
- `skills/sdw-batch/SKILL.md` and `skills/sdw-batch/references/batch_protocol.md`: policy, manifest fields, depth bound.
- `skills/sdw-retro/references/retro_protocol.md`: cross-reference the consumer of the candidate list.
- `skills/sdw-config/references/config_spec.md`, `.sdw/config.json`, `.sdw/config.schema.json`: `retro.followUp`.
- Tests: `tests/sdw_batch_retro.test.cjs`.

## Acceptance Criteria

- AC1: When a batch item completes and its run recorded `state.retro.reportJson`, the batch shall read the candidates and record `retroFollowUp` in the manifest with the candidate count, the severity breakdown, and the report path.
- AC2: When `retro.followUp` is `"queue"`, the batch shall create one draft specification for each candidate whose severity is `critical` or `high`, through the `sdw-spec` CLI, and append it to the manifest queue after the remaining items.
- AC3: If creating a follow-up specification fails, then the batch shall record the failure against that candidate, continue the queue, and list it in the summary.
- AC4: When `retro.followUp` is `"record"`, the batch shall write `.sdw/state/batch-{batchId}.followups.md` listing every candidate and shall create no specification.
- AC5: When `retro.followUp` is `"none"`, the batch shall not read the retro report and shall record `followUp: "skipped"`.
- AC6: When a queued follow-up item produces its own retrospective candidates, the batch shall record them and shall not queue further specifications from them.
- AC7: The batch follow-up stage shall never prompt the operator and shall not halt the queue; only the delegated run outcome halts or pauses it.
- AC8: The system shall document `retro.followUp` and the follow-up stage in the batch skill, the batch protocol, the retro protocol, and the config specification.

## Verification

- [ ] Completed item with two candidates, one `high` and one `low`, under `"queue"`: one spec exists, the manifest lists it, the summary shows both.
- [ ] `"record"`: report file exists, no spec created.
- [ ] `"none"`: no report read, manifest says `skipped`.
- [ ] Spec creation failure is recorded and the queue still advances.
- [ ] A follow-up item with candidates queues nothing further.
- [ ] `npm test` passes; `node skills/sdw-rules/scripts/sdw_rules.cjs doctor` passes.

## Notes

- The cause of a high candidate is the run's own state and reports; the batch never re-derives candidates, it consumes them.
- Follow-up specs are drafts. Their header status stays `draft` so the maintainer keeps authority over implementation.
- Node.js CommonJS, standard library only; no absolute OS paths in committed files.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Auto-fixing candidate findings in place | Skills and code changes require a specification; the batch queues specs instead |
| Memory recording of candidates | `sdw-memory` writes stay explicit; the follow-up report names them for the operator |
| Retro candidate generation | Owned by `sdw-retro` |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default `retro.followUp` | `"queue"` | The batch is explicitly the unattended lane; a human queue does not need it | y |
| Queue depth | `followUpDepth: 1` | Prevents a self-feeding queue | y |
| Severity threshold | `critical` and `high` | Low and medium candidates stay in the report | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `validate_spec.cjs --mode=authoring` |
| Upstream contract | `state.retro.reportJson` recorded by spec 00045 | Inspect the delivered `sdw_orch.cjs` completion block |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Manifest `retroFollowUp` per item: candidate count, severity breakdown, queued spec paths, failures.
- Batch summary prints queued and recorded follow-ups.

### Negative & Failing Test Scenarios

- Retro report missing for a completed item: recorded as `unavailable`, queue continues.
- Malformed candidate list: recorded as `invalid`, queue continues.
- Follow-up spec path collision: recorded as a failure, queue continues.
