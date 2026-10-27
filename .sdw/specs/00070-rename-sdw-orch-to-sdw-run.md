---
id: null
slug: 00070-rename-sdw-orch-to-sdw-run
title: "Rename the sdw-orch skill to sdw-run"
source: local
status: draft
specDate: 2026-10-27
priority: high
value: "Names the skill after the act it performs and matches the vocabulary the product already uses (run, runId, run state, resume), dropping an abbreviation that is trivially mistyped and decoded only by insiders"
effort: L
---
# Specification — Rename the sdw-orch skill to sdw-run

## Description

The skill that drives one specification through the 8-step pipeline is named `sdw-orch`, a contraction of "orchestrator". Everything around it already speaks in runs: `run` is the entry subcommand, `--run-id` and `runId` identify an execution, the state file is `.sdw/state/{runId}.state.json`, `resume` continues a run, and `.sdw/sandbox/{runId}/` holds its clone. The skill folder and its entry script are the only surfaces that say "orch".

The rename is mechanical but wide: 64 live files and 511 occurrences of `sdw-orch`, `sdw_orch`, or `sdwOrch`, of which 242 are in tests. It touches the skill directory, the entry script, module require paths, invocation names, log prefixes, error messages, the router routing table, the doctor expected-skill lists, batch delegation, the DAG fallback bucket, config schema descriptions, the package entry, root documentation, and seven test file names. Historical specifications (43 files, 318 occurrences) and the changelog (2) keep the old name because they record what was true when they were written.

### Design Intent

A tool name should describe what a user does with it. `sdw-run` reads as the action, sorts beside `sdw-rules`, `sdw-router`, and `sdw-spec`, and needs no glossary entry to decode. The product already pays for the current name twice: every delegation line carries a three-word path, and the `orch` shorthand collides with shell verbs and is mistyped in ad-hoc requests. This phase allows breaking renames, so the old name is removed outright rather than aliased.

## Acceptance Criteria

- AC1: While the rename is applied, the repository shall serve the skill from `skills/sdw-run/SKILL.md` with no `skills/sdw-orch/` directory.
- AC2: The system shall expose the pipeline CLI at `skills/sdw-run/scripts/sdw_run.cjs`.
- AC3: When `node skills/sdw-run/scripts/sdw_run.cjs status` runs in this repository, the system shall exit 0.
- AC4: When a related skill delegates to the pipeline, the system shall invoke `skills/sdw-run/scripts/sdw_run.cjs`.
- AC5: The system shall list `sdw-run` in the `sdw-doctor` expected and core skill sets.
- AC6: The system shall route pipeline intents to `sdw-run` in the routing table and the known-skill list.
- AC7: The system shall match the DAG fallback bucket on `sdw-run` slugs and name only files under `skills/sdw-run/`.
- AC8: The package entry `index.cjs` shall require the renamed module paths and export `sdwRun`.
- AC9: If `sdw-orch` is invoked, then the system shall exit non-zero with a message naming `sdw-run`.
- AC10: The `sdw-run` skill frontmatter shall declare no invocation name containing `orch`.
- AC11: When the full suite runs, the system shall pass every `tests/sdw_run*.test.cjs` file with no `tests/sdw_orch*.test.cjs` file present.
- AC12: If a live repository file still contains `sdw-orch`, `sdw_orch`, or `sdwOrch`, then the rename guard test shall fail.
- AC13: When the two doctor commands run after the rename, the system shall exit 0 for both.
- AC14: The documentation set shall name `sdw-run` in `AGENTS.md`, `README.md`, `FEATURES.md`, `GLOSSARY.md`, `.sdw/directory-structure.md`, and `.github/agentic-code-reviewers-prompt.md`.

## Notes

### Live Surface Inventory (64 files, 511 occurrences)

| Area | Files | Occurrences | Action |
|---|---|---|---|
| The skill itself | 8 | 111 | `git mv` the directory, rename the entry script, rewrite prefixes and messages |
| Delegating skills | 23 | 88 | Replace the skill name and the script path |
| Tests | 24 | 242 | Rename 7 files, update requires, variables, and string assertions |
| Root docs and entry | 6 | 65 | `AGENTS.md`, `README.md`, `FEATURES.md`, `GLOSSARY.md`, `index.cjs`, `result.json` |
| `.sdw` template | 2 | 4 | Config schema descriptions and `directory-structure.md` |
| `.github` | 1 | 1 | Agentic reviewer prompt |
| Historical record | 44 | 320 | Delivered specifications and `CHANGELOG.md`: keep, never rewrite |

### Path Map

| Current | Target | Notes |
|---|---|---|
| `skills/sdw-orch/` | `skills/sdw-run/` | 13 files moved with `git mv` |
| `skills/sdw-orch/SKILL.md` | `skills/sdw-run/SKILL.md` | frontmatter `name`, banner, body |
| `skills/sdw-orch/scripts/sdw_orch.cjs` | `skills/sdw-run/scripts/sdw_run.cjs` | entry script, snake_case of the skill |
| `skills/sdw-orch/references/orchestrator_protocol.md` | `skills/sdw-run/references/orchestrator_protocol.md` | file name kept, parent moved |
| `tests/sdw_orch.test.cjs` | `tests/sdw_run.test.cjs` | plus `sdw_orch_branch_guard`, `_dispatch`, `_implementation`, `_refine`, `_retro`, `_scoring` |
| `.agents/skills/sdw-orch/` (consumer installs) | `.agents/skills/sdw-run/` | reinstalled by the consumer, no shim shipped |

### Symbol and String Map

| Current | Target | Where |
|---|---|---|
| `sdw_orch.cjs` | `sdw_run.cjs` | usage line, every delegation command, sandbox hints |
| `require('../skills/sdw-orch/scripts/...')` | `require('../skills/sdw-run/scripts/...')` | `index.cjs`, 24 test files, `batch_queue.cjs`, `sdw_doctor.cjs` |
| `sdwOrch` | `sdwRun` | `index.cjs` export, test locals |
| `[sdw-orch]`, `[sdw-orch dry-run]` | `[sdw-run]`, `[sdw-run dry-run]` | log prefixes in `artifact_writer`, `sdw_run`, `implementation_runner` (10 dry-run lines) |
| `sdw-orch run \| resume \| status \| sandbox \| task \| score` | `sdw-run run \| resume \| status \| sandbox \| task \| score` | docs, batch, doctor smoke test, sandbox hints |
| `rule: 'orch'` | `rule: 'run'` | `dag_planner.cjs` `FALLBACK_RULES`, matching `sdw-run` |
| `sdw-orchestrator`, `orch`, `orch run`, `orch implement`, `sdw-orch implement` | removed | `invocation_names` (9 entries become the `sdw-run` family) |
| `'sdw-orch'` entries | `'sdw-run'` | `sdw_doctor.cjs` `EXPECTED_SKILLS`, `CORE_SKILLS`, sandbox smoke path |
| `'sdw-orch'` router entries | `'sdw-run'` | `knownExplicitSkills`, `expectedSkills`, routing-table row, `recommendedOption` text |
| `sdw-orch` in three schema descriptions | `sdw-run` | `.sdw/config.schema.json` (`sandboxDir`, `retro.enabled`, `retro.transcripts`), embedded copy in `sdw_config.cjs` |
| `result.json` (3 occurrences) | deleted | stray fixer output at repository root, no consumer |

### Execution Order

1. `git mv skills/sdw-orch skills/sdw-run` and `git mv skills/sdw-run/scripts/sdw_orch.cjs skills/sdw-run/scripts/sdw_run.cjs`.
2. Rewrite `SKILL.md`: name, banner, invocation names, every command and path in the body.
3. Rewrite the skill's own scripts: log prefixes, usage block, error messages, sandbox hints, DAG fallback bucket.
4. Rewrite delegating skills: `sdw-batch` (SKILL, protocol, `batch_queue.cjs`, `sdw_batch.cjs`), `sdw-doctor` (SKILL, checks, script), `sdw-router` (SKILL, script, routing table, consumer setup), `sdw-retro` (SKILL, protocol, `retro.cjs`, candidate contract, validator), `sdw-ship-pr`, `sdw-code-review`, `sdw-spec`, `sdw-security-checks`, `sdw-rules` interaction modes, `sdw-config` spec.
5. Update `index.cjs` require paths and the `sdwRun` export; delete `result.json`.
6. Update config descriptions in `.sdw/config.schema.json` and the embedded schema in `sdw_config.cjs`.
7. Update root documentation and `.sdw/directory-structure.md` and `.github/agentic-code-reviewers-prompt.md`.
8. Rename the seven `tests/sdw_orch*.test.cjs` files, then update requires, variables, and assertions in all 24 test files.
9. Add `tests/sdw_rename_guard.test.cjs`: fail when a tracked file outside the allowlist matches `/sdw[-_]orch|sdwOrch/i`; allowlist `.sdw/specs/**`, `CHANGELOG.md`, and the guard file itself.
10. Run `npm test`, `node skills/sdw-rules/scripts/sdw_rules.cjs doctor`, `node skills/sdw-doctor/scripts/sdw_doctor.cjs`, and a `--dry-run` plan parity check.

### Guard Test Contract

- Inputs: the tracked file list (`git ls-files`), the three spellings, the allowlist.
- Output: a list of offending `path:line` entries and exit `1` when the list is non-empty.
- It never rewrites files; its only job is to keep the old name from creeping back in.

## Out of Scope

| Feature | Reason |
|---|---|
| Renaming the English role noun "orchestrator" (329 occurrences) | It names the role, not the skill; a vocabulary pass is a separate change |
| Renaming subcommands (`run`, `resume`, `status`, `task`, `score`, `sandbox`, `dag`) | The CLI identity stays; `sdw-run run` redundancy is accepted |
| Renaming `references/orchestrator_protocol.md` | The file names the protocol, not the skill |
| Migrating installed `.agents/skills/sdw-orch/` copies in consumer workspaces | Consumers reinstall; this phase ships no compatibility shim |
| Rewriting delivered specifications and changelog entries | Historical record of what was true then |
| Removing `findings.json` and `WS-SKILLS.MD` | Unrelated stray files, separate cleanup |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| New skill name | `sdw-run` | Names the action and matches `runId`/run state vocabulary | y |
| Entry script name | `sdw_run.cjs` | Matches the snake_case of every other entry script | y |
| Short aliases | Drop `orch`, `orch run`, `orch implement`, `sdw-orchestrator` | Breaking-change phase; a bare `orch` collides with shell verbs | y |
| Noun "orchestrator" in prose | Keep | Accurate role noun; renaming it would double the diff for no user gain | n |
| Subcommands | Unchanged | Rename only the skill; `sdw-run run` is accepted | n |
| Protocol file name | Keep `orchestrator_protocol.md` | It documents the protocol, not the skill | n |
| `result.json` | Delete as a stray artifact | Committed fixer output with no consumer | n |
| Historical specifications | Not rewritten | They record the old name as history | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Baseline suite green | `npm test` passes before the first rename commit | `npm test` |
| Inventory reproduced | The 64-file, 511-occurrence count matches `HEAD` | `git grep -l -i -e sdw-orch -e sdw_orch -e sdwOrch` |
| Doctor and router understood | `EXPECTED_SKILLS`, `CORE_SKILLS`, `knownExplicitSkills`, and the routing table read | Read the four files |
| Historical allowlist agreed | The maintainer signs off the keep list | This spec's Assumptions table |
| No competing change | No open pull request touches `skills/sdw-orch/` | `gh pr list --state open` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `sdw-doctor` prints `Skills: 14/14 present` and any missing-skill finding names `sdw-run`.
- `sdw-router` prints `Matched intent -> sdw-run` for an implementation request.
- Every CLI line carries `[sdw-run]` or `[sdw-run dry-run]`, never the old prefix.
- `--dry-run` prints the same strategy, lanes, and step list as before the rename, differing only in the skill name.
- The guard test prints one `path:line` entry per stale reference.

### Negative & Failing Test Scenarios

- A stale `require('../skills/sdw-orch/...')` throws `MODULE_NOT_FOUND` in the suite.
- `node skills/sdw-orch/scripts/sdw_orch.cjs status` exits non-zero and the message names `sdw-run`.
- A specification whose DAG slice names `skills/sdw-orch/...` is refused by the target-file rule because the bucket no longer matches.
- A consumer workspace that still has `.agents/skills/sdw-orch/` fails the doctor with `skill-missing sdw-run`.
- The guard test fails when a documentation edit reintroduces the old name.
