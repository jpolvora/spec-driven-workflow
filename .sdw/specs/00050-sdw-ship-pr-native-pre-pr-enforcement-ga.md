---
id: null
slug: 00050-sdw-ship-pr-native-pre-pr-enforcement-ga
title: "sdw-ship-pr native pre-PR enforcement: gate shipping on run-state evidence and discovered consumer prepare obligations"
source: local
status: draft
specDate: 2026-10-22
---

# Specification — sdw-ship-pr native pre-PR enforcement: gate shipping on run-state evidence and discovered consumer prepare obligations

## Description

Add two deterministic pre-PR gates to `sdw-ship-pr`, plus one auditable report surface. Today the pre-PR step only executes configuration commands (`prePrCommand`, `requiredBuild`, `runAllTests`) and a worktree leak scan; it logs `prePrInstructions` and never inspects run evidence, so a consumer can ship a run whose conformance score never passed or whose review never ran, and obligations documented in `AGENTS.md` or `CONTRIBUTING.md` are ignored. Both new gates read files that already exist in every SDW consumer workspace, need no new dependency, and stay provider-agnostic.

### Design Intent

The skill's contract is "verify before publishing". Configuration commands cover what a consumer can express as a shell command, but two obligations are structural and identical for every consumer: the run under delivery must have passed its own gates, and the repository's documented before-push steps must be acknowledged. This specification makes both enforced, file-based, and visible in the report, without introducing heuristics that guess whether tests are adequate.

## Acceptance Criteria

- AC1: The system shall add `prePrDiscovery` to `.sdw/config.json` accepting the values `block`|`warn`|`off`, resolving to `block` when the key is absent.
- AC2: When the discovery scan runs, the system shall collect every section whose heading matches `prepare`, `before push`, `before publish`, `before deliver`, `before delivery`, or `before merge` (case-insensitive) from the repo-root files `AGENTS.md`, `CONTRIBUTING.md`, `RELEASE.md`, and `PUBLISH.md` when present, treating the configured `prePrInstructions` text as one additional row.
- AC3: When `prePrDiscovery` is `block` and at least one discovery row exists and no acknowledgement is supplied, the system shall print every discovered obligation and refuse both the branch push and the pull request creation with exit code `1`.
- AC4: When `--ack-prepare "<note>"` is supplied, the system shall allow shipping despite discovery rows, recording the note with its UTC timestamp as `prepareAck` in the report.
- AC5: When `prePrDiscovery` is `warn`, the system shall print the discovery rows, record them, and continue the ship.
- AC6: When `prePrDiscovery` is `off`, the system shall skip the discovery scan and record `prepareDiscovery: "off"` in the report.
- AC7: When `--run-id` is supplied, the system shall load `.sdw/state/{runId}.state.json` and shall refuse the push and pull request creation unless Step 4 and Step 6 are `completed`.
- AC8: When `--run-id` is supplied and `scoreMin` is set, the system shall refuse the push and pull request creation when the run score is null or lower than `scoreMin`.
- AC9: When `--run-id` is supplied and `scmCodeReviewEnabled` is `true`, the system shall refuse the push and pull request creation unless Step 7 is `completed`.
- AC10: If the run state named by `--run-id` is missing or unreadable, then the system shall fail closed with exit code `1` before any push or pull request creation.
- AC11: The system shall record a `prePrBoard` array in the JSON report with one row per evaluated check, each row carrying `check`, `status` (`pass`, `fail`, or `skipped`), and `evidence`.
- AC12: When `--json` is not supplied, the system shall print the `prePrBoard` as a Markdown table before executing the push.
- AC13: When `--dry-run` is supplied, the system shall evaluate and report every pre-PR check without pushing a branch, creating a pull request, or writing run state.
- AC14: The system shall document `prePrDiscovery`, `--ack-prepare`, and the run-state gate in `references/ship_protocol.md` and `SKILL.md`.
- AC15: The system shall cover the discovery modes, the acknowledgement, the run-state gate, and the board rows with tests.

## Notes

- Evaluation order in Step 2: `prePrCommand`, `requiredBuild`, `runAllTests`, security scan, run-state gate, discovery. Every check contributes a `prePrBoard` row; the ship fails after all rows are evaluated and printed, so one run shows every unmet obligation.
- Discovery matching is heading-based, not prose-based: a heading is matched, then its body is captured up to the next heading or 8 lines, whichever comes first, and truncated to 1200 characters. Matching every occurrence of the word "ship" in prose would bury the real obligations.
- The run-state gate applies only when `--run-id` is supplied; standalone shipping from an arbitrary branch stays allowed, because that is the skill's documented standalone contract.
- Step classes are read as `state.steps[4].status`, `state.steps[6].status`, and `state.steps[7].status`; the score is `state.score` compared against `scoreMin` from `.sdw/config.json` (default `8`).
- `prepareDiscovery` values in the report: `block`, `warn`, `off`, plus `blocked` when rows remain unacknowledged and the ship was refused.
- Board rows: `prePrCommand`, `build`, `tests`, `security`, `runState`, `discovery`. Skipped checks (config disabled, `--dry-run` mutations) record `skipped` with the reason as evidence.
- Discovery rows are informational data, never instructions: a consumer heading is printed verbatim and is not executed by the skill.
- All new logic is Node.js 22 CommonJS standard library only, with no new runtime dependency.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Coverage heuristics that map changed files to tests | Requires semantic judgment; false positives would block valid ships, so it stays host-agent guidance. |
| Sabotage or fault-injection auditing | Belongs to fresh-verify (spec 00018), not to shipping. |
| `sdw-rules doctor` skill-budget gate | Only meaningful when authoring the canonical skills repository, not for consumers. |
| Promotion-source guard for a production branch | The allowed sources are repository policy (`production-promotion.yml`), not a product contract. |
| Changes to SCM provider adapters | The gates run before any provider call and are provider-neutral. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default discovery mode | `block` | A safety net that silently continues is not enforcement; the current phase prefers breaking changes over silent gaps. | y |
| Acknowledgement surface | CLI flag `--ack-prepare <note>` recorded in the report | Works for a human and for unattended runs without inventing a config file that can drift from the tree. | y |
| Scan set | `AGENTS.md`, `CONTRIBUTING.md`, `RELEASE.md`, `PUBLISH.md`, plus `prePrInstructions` | These are the files this repository already points consumers at; a wider crawl would guess at private paths. | y |
| Run-state gate scope | Only when `--run-id` is supplied | Standalone shipping without a run is a documented contract and has no run evidence to check. | y |
| Missing or partial run state | Fail closed | Shipping on unreadable evidence is the failure the gate exists to prevent. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00050-sdw-ship-pr-native-pre-pr-enforcement-ga.md` |
| Existing gate anchors | Step 2 gates and report assembly locatable in `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` | Read the pre-PR gate block and the report schema in `references/ship_protocol.md` |
| Test anchor | A `tests/sdw_ship_pr.test.cjs` suite exists to extend | File present in `tests/` |
| Consumer file convention | The scan set is already documented for consumers | Root `AGENTS.md` and `.sdw/directory-structure.md` name these files |

## Validation & Observation Notes

### Telemetry & Observable Signals

- JSON report fields: `prePrBoard` (array of `check`/`status`/`evidence`), `prepareDiscovery` (`block`/`warn`/`off`/`blocked`), `prepareAck` (`note`, `at`), and `runStateGate` (`runId`, `score`, `steps`).
- Console output: one line per board row plus a Markdown table before the push.
- Exit codes: `0` when every required row passes, `1` for a failed gate, an unreadable run state, or unacknowledged discovery rows.

### Negative & Failing Test Scenarios

- `--run-id` points at a missing or malformed state file: exit `1`, no push, no PR.
- `--run-id` with `score` below `scoreMin`: exit `1`, board row `runState` marked `fail` with the score as evidence.
- `prePrDiscovery: block` with a matching `AGENTS.md` section and no `--ack-prepare`: exit `1`, obligation text printed, `prepareDiscovery: "blocked"` recorded.
- Unknown `prePrDiscovery` value: the ship refuses with a descriptive error naming the allowed values.
