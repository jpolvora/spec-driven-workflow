---
id: null
slug: 00031-sdw-delivery-records-retro-learning-lifecycle
title: "SDW Delivery Records, Retrospective, Learning Loop, and Prompt-Task Lifecycle"
source: local
status: abandoned
specDate: 2026-10-21
---
# Specification — SDW Delivery Records, Retrospective, Learning Loop, and Prompt-Task Lifecycle

## Description

SDW today ends a delivery with a commit, a review report, and a pull request. It keeps no durable account of *what was asked, what was built, and what it cost*; it never turns a run's friction into an environment change; it has no trap memory for agents; and a prompt-driven task outside `sdw-orch` has no intake, verification, or completion contract. Every one of those gaps is currently covered by ad-hoc conversation state.

This specification adds four capability families, all deterministic and all optional at runtime:

1. **Delivery record (`sdw-changelog`)** — an append-only `CHANGELOG.md` entry per completed task: prompt intent, work done, outcome.
2. **Retrospective (`sdw-retro`)** — a single-run review that turns friction signals into ranked, evidence-bound improvement candidates; advisory only, it never writes project files.
3. **Learning loop (`sdw-learning`)** — pre-work trap consultation and post-work trap recording through an external store adapter, defaulting to the `memo` CLI (a `ws-memo` wrapper supplied by the host), never to files inside the consumer repository.
4. **Prompt-task lifecycle (`sdw-task-lifecycle`)** — an opt-in, blocking intake/verification/completion coordinator for direct implementation tasks that do not run through `sdw-orch`, plus an `sdw-spec update` subcommand that repairs spec drift after the fact.

The families are deliberately separate skills: each owns one trigger, one deterministic script anchor, and one documentation surface, so a consumer can install any subset without dragging the others in.

### Design Intent

The product rule is one-way dependency: the harness may depend on product skills, never the reverse. The workflow-skills inventory that inspired this work bundles record keeping, retrospection, memory, and lifecycle inside one `.ws/` runtime with `MEMORY.md`, `PLAN.md`, and host-specific loaders. That shape violates two SDW guarantees — *No in-repo agent memory* and *Harness & agent agnostic* — so the capabilities are re-cut here:

- **Records are product data, memory is external.** `CHANGELOG.md` describes delivered work and lives with the project. Traps describe agent behaviour and never enter the consumer repository; the store is a configured command or path outside the project.
- **Evidence or nothing.** A retro candidate without a resolvable run artifact is rejected, not softened into advice. A trap without scenario, `DO NOT`, and `INSTEAD DO` is rejected.
- **Propose only, write on explicit command.** Retro never edits a project file. Learning writes only through the adapter. `sdw-spec update` writes only with `--apply`. The lifecycle gate blocks product edits only when the consumer opts in.
- **Deterministic anchors.** Every subcommand exits `0`/`1` with a stable reason, so tests and CI can assert behaviour without an LLM in the loop.

## Acceptance Criteria

### Delivery Record (`sdw-changelog`)

- AC1: The system shall provide an `sdw-changelog` skill whose `SKILL.md` references `sdw-rules`.
- AC2: The system shall provide `scripts/append_changelog.cjs` accepting `--prompt`, `--done`, `--result`, and optional `--agent`.
- AC3: When the append script runs, the system shall insert one entry directly under the `# Changelog` heading.
- AC4: The system shall render each entry as a dated `###` heading followed by `Prompt`, `Done`, and `Result` bullets.
- AC5: The system shall resolve the changelog path from the `changelogFile` key in `.sdw/config.json`.
- AC6: The system shall default `changelogFile` to `{projectRoot}/CHANGELOG.md`.
- AC7: When the resolved file or its parent directory is missing, the system shall create it.
- AC8: If the file already contains an identical `Prompt`/`Done`/`Result` block, then the system shall skip the append and exit `0`.
- AC9: The system shall preserve every existing entry byte-identical when appending a new one.
- AC10: If a required argument is missing, then the system shall exit `1` with a usage message naming the missing flag.
- AC11: The system shall reject empty or whitespace-only `--done` and `--result` values.
- AC12: The system shall document the `changelogFile` key in `.sdw/config.schema.json`, `.sdw/config.json`, and `skills/sdw-config/references/config_spec.md`.

### Retrospective (`sdw-retro`)

- AC13: The system shall provide an `sdw-retro` skill whose `SKILL.md` references `sdw-rules`.
- AC14: The system shall provide `retro run [--run-id <id>]` reading the run state file and the run's step artifacts.
- AC15: When `--run-id` is omitted, the system shall select the most recent completed run under `.sdw/state`.
- AC16: The system shall write `<runId>.retro.md` and `<runId>.retro.json` under the run artifact directory.
- AC17: If an expected artifact is missing, then the system shall record the absence in the report and shall not synthesize its content.
- AC18: The system shall define a candidate record with `id`, `title`, `severity`, `category`, `evidence`, and `proposedChange`.
- AC19: The system shall restrict candidate `severity` to `critical`, `high`, `medium`, and `low`.
- AC20: The system shall restrict candidate `category` to `memory`, `harness-directive`, `reviewer-standard`, `automated-check`, `navigation-pointer`, and `no-op-deletion`.
- AC21: The system shall require `evidence.artifact`, `evidence.ref`, and `proposedChange.target` in every candidate.
- AC22: The system shall provide `scripts/validate_candidates.cjs` exiting `0` only when every candidate is accepted.
- AC23: If a candidate lacks a required field, then the system shall reject it with a stable reason code.
- AC24: If a candidate cites an artifact that does not resolve under the project root, then the system shall reject it.
- AC25: If a candidate targets a path under `skills/`, then the system shall reject it and name the specification route instead.
- AC26: The system shall order candidates by severity from `critical` to `low`.
- AC27: The system shall not modify any project file during a retro run.
- AC28: While `retro.enabled` is not `true`, the system shall not run retro automatically.
- AC29: When retro runs automatically, the system shall propose only and exit `0` regardless of findings.

### Learning Loop (`sdw-learning`)

- AC30: The system shall provide an `sdw-learning` skill whose `SKILL.md` references `sdw-rules`.
- AC31: The system shall provide `learning query --keywords <list>` returning traps through the configured store adapter.
- AC32: The system shall provide `learning record --draft <path>` validating the trap template before writing.
- AC33: The system shall define the trap template with `scenario`, `doNot`, `insteadDo`, `severity`, `layer`, `module`, and `pathPatterns`.
- AC34: The system shall restrict trap `severity` to `low`, `medium`, `high`, and `critical`.
- AC35: The system shall define the store adapter contract as JSON over stdin and stdout with `query` and `record` operations.
- AC36: The system shall default `learning.command` to `memo`.
- AC37: If the configured learning command is unavailable, then the system shall exit `0` with `skipped: command-unavailable`.
- AC38: If `learning.mode` is `none`, then the system shall exit `0` with `skipped: disabled`.
- AC39: The system shall reject a draft containing injection patterns before recording it.
- AC40: The system shall never write learning records inside the consumer repository.
- AC41: The system shall include the learning consult step in every dispatched implementation prompt.
- AC42: The system shall add a `learning` field to the evidence schema.
- AC43: If a success evidence lacks a `learning` value while the learning adapter is enabled, then the system shall reject it.
- AC44: The system shall add the two-failure reflection rule to `sdw-rules`.

### Specification Drift Repair (`sdw-spec update`)

- AC45: The system shall provide the `sdw-spec update --slug <slug>` subcommand.
- AC46: When `--from <commit>` is provided, the system shall map the files changed since that commit to the specification of record.
- AC47: The system shall print the proposed body diff and one revision-history line without writing by default.
- AC48: When `--apply` is provided, the system shall write only the approved hunks and append the revision line.
- AC49: If no specification matches the changed files, then the system shall exit `0` with `No existing spec found`.
- AC50: The system shall not modify the registry row during `sdw-spec update`.

### Prompt-Task Lifecycle (`sdw-task-lifecycle`)

- AC51: The system shall provide an `sdw-task-lifecycle` skill whose `SKILL.md` references `sdw-rules`.
- AC52: While `taskLifecycle.enabled` is `true`, the system shall refuse product-file edits until a registered specification exists.
- AC53: The system shall provide `lifecycle check --slug <slug>` reporting a missing specification, a missing registry row, and a missing verification command.
- AC54: When `verification.testCommand` is set, the system shall run it before completion.
- AC55: When `verification.testCommand` is null, the system shall record a skip note and exit `0`.
- AC56: If the verification command exits non-zero, then the system shall block completion and exit `1`.
- AC57: The system shall walk `taskLifecycle.trackingFiles` in order and update only files that exist.
- AC58: When a tracking file is missing, the system shall emit one skip note naming the path.
- AC59: The system shall run the completion chain as changelog, then learning, then `sdw-spec update`.
- AC60: The system shall not create a run state tree for a prompt task.
- AC61: The system shall never stage changes with `git add -A`.
- AC62: The system shall document the new keys and subcommands in `.sdw/config.schema.json`, `.sdw/config.json`, and the affected `SKILL.md` files.
- AC63: The system shall cover each new deterministic script with tests.

## Notes

- **Status: registered, not authorized.** This specification records a design for later implementation. Do not execute it without an explicit implementation order.
- **Config additions.**
  - `changelogFile`: string, default `{projectRoot}/CHANGELOG.md`.
  - `learning.mode`: `command` | `none`, default `command`.
  - `learning.command`: string, default `memo`; must be an executable on `PATH` or an absolute path.
  - `learning.timeoutMs`: integer, default `15000`.
  - `retro.enabled`: boolean, default `false`.
  - `taskLifecycle.enabled`: boolean, default `false`.
  - `taskLifecycle.trackingFiles`: string array, default `["FEATURES.md"]`.
- **CLI surfaces.**
  - `node skills/sdw-changelog/scripts/append_changelog.cjs --prompt "…" --done "…" --result "…" [--agent <id>] [--root <path>]`
  - `node skills/sdw-retro/scripts/retro.cjs run [--run-id <id>] [--json] [--root <path>]`
  - `node skills/sdw-retro/scripts/validate_candidates.cjs --input <file> [--json] [--repo-root <path>]`
  - `node skills/sdw-learning/scripts/learning.cjs query --keywords "a,b" [--paths "x,y"] [--json] [--root <path>]`
  - `node skills/sdw-learning/scripts/learning.cjs record --draft <file> [--json] [--root <path>]`
  - `node skills/sdw-task-lifecycle/scripts/lifecycle.cjs check --slug <slug> [--json] [--root <path>]`
  - `node skills/sdw-task-lifecycle/scripts/lifecycle.cjs close --slug <slug> [--prompt "…"] [--done "…"] [--result "…"] [--root <path>]`
  - `node skills/sdw-spec/scripts/sdw_spec.cjs update --slug <slug> [--from <commit>] [--apply] [--json] [--root <path>]`
- **Store adapter contract (learning).** The child process receives one JSON object on stdin and must print one JSON object on stdout:
  - Request: `{ "operation": "query" | "record", "keywords": [], "paths": [], "record": { … } }`
  - Response: `{ "ok": true, "records": [] }` or `{ "ok": false, "error": "…" }`.
  - Non-zero exit, timeout, malformed JSON, or unavailability maps to `skipped: command-unavailable` in query mode and to exit `1` in record mode.
- **Changelog template.**
  ```markdown
  ### [YYYY-MM-DD HH:MM] Agent: {agent}
  - **Prompt**: …
  - **Done**: …
  - **Result**: …
  ```
- **Retro artifacts** are run-local: `<artifactsDir>/<runId>.retro.md` and `<runId>.retro.json`. They are never committed, never block delivery, and never modify a project file; an apply/`--approve` path is intentionally absent.
- **Phased delivery** (each phase is independently shippable, in this order): A changelog, B retro, C learning, D spec update, E lifecycle. Phases A-C have no dependency on D-E; E depends on A and C.
- **Guarantee compliance.** No new runtime dependency, Node.js 22 only, no vendor SDK, no in-repo memory, no harness import. The `memo` default is an optional external command, never an import of `.agents/skills/ws-memo`.

## Out of Scope

| Feature | Reason |
|---|---|
| Web dashboard or report UI | The product is CLI- and file-first; artifacts are Markdown and JSON. |
| Tracker synchronization (Jira, Azure DevOps) | No SCM/tracker dependency in this phase; `sdw-spec import` already owns remote intake. |
| LLM-authored retro prose without run evidence | Retro candidates must be evidence-bound; generation is not a product guarantee. |
| Automatic trap recording without approval | Learning writes only through the configured adapter; the product never writes memory on its own. |
| Retro-applied edits | Retro is advisory in this phase; it proposes candidates and never writes project files. |
| In-repo memory files (`MEMORY.md`, `.agents/plans/`) | Violates the *No in-repo agent memory* guarantee. |
| Telemetry stream and live run monitor | Belongs to spec 021; this specification reads existing state artifacts only. |
| Automatic `skills/` edits from retro candidates | Product changes require a specification; AC25 rejects those targets. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Learning backend | `learning.command: memo`, mode `command` | The host already ships `ws-memo`; the adapter contract keeps the product independent of it. | Yes |
| Changelog location | `{projectRoot}/CHANGELOG.md` | Visible to humans and release tooling; the consumer opts out by setting `changelogFile`. | Yes |
| Lifecycle gate | `taskLifecycle.enabled: false`, blocking when true | Traceability is valuable but must not surprise a consumer; opt-in keeps the default friction-free. | Yes |
| Skill surface | Four new skills plus `sdw-spec update` | One trigger and one script anchor per family; installable in subsets. | Yes |
| Evidence `learning` field | Required when `learning.mode` is `command` and the adapter responded | A disabled adapter must not turn every evidence file into a failure. | Yes |
| Retro output | Proposals only; no apply path | Retro is advisory; approved changes are applied by the operator or through a specification. | Yes |
| Tracking files | `["FEATURES.md"]` by default | The only tracking document SDW assumes today; the key is overridable. | Yes |
| Lifecycle product-file set | `skills/**` only | `.sdw/**` is workspace state, not delivered product code. | Yes |
| One spec, phased delivery | Phase A-E order above | Fifteen-plus ACs per phase keep runs reviewable without splitting the registry row. | Yes |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Spec validated | `validate_spec.cjs --mode=authoring` exits `0` | `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00031-sdw-delivery-records-retro-learning-lifecycle.md` |
| Config contract | `changelogFile`, `learning.*`, `retro.enabled`, `taskLifecycle.*` documented in schema and reference | `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Zero dependencies | New scripts require Node.js built-ins only | `package.json` has no runtime dependencies; script audit |
| Guarantee preserved | No new script writes inside the project except `CHANGELOG.md` and `.sdw/` artifacts | Code audit plus AC40 test |
| Deterministic anchors | Every subcommand has a documented exit-code contract | `--help` and tests |
| Test plan | One test file per deterministic script | `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Changelog append: one new entry per task, identical re-run produces no second entry, exit code `0`.
- Retro: candidate count, accepted/rejected counts, and stable rejection reasons printed by the validator.
- Learning: `skipped: command-unavailable` and `skipped: disabled` are distinguishable and exit `0`.
- Lifecycle: gate refusals name the missing specification and the command to create it; verification failures name the command and exit code.
- Spec update: proposed files, hunk count, and revision line are printed before any write.

### Negative & Failing Test Scenarios

- `append_changelog.cjs --prompt "x"` without `--done` exits `1` with the missing flag named.
- Re-running the same append skips the duplicate and leaves the file byte-identical.
- `validate_candidates.cjs` rejects a candidate whose `evidence.artifact` does not exist.
- `validate_candidates.cjs` rejects a candidate targeting `skills/sdw-orch/scripts/sdw_orch.cjs` and names the spec route.
- `learning query` with `learning.command` pointing to a missing binary exits `0` with `skipped: command-unavailable`.
- `learning record` with a draft missing `doNot` exits `1` before any write.
- `lifecycle close` with a failing `verification.testCommand` exits `1` and does not run the completion chain.
- `sdw-spec update --slug <unknown>` exits `0` with `No existing spec found` and creates no file.
- A retro run leaves the working tree byte-identical; candidate application is not a product behavior.
