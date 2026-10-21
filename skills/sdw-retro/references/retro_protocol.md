# Retro Protocol

`sdw-retro` is a human-invoked review of one `sdw-orch` run. It turns the run's
own record into deterministic friction signals and leaves every improvement
judgment to an explicit operator decision. It never runs as part of delivery,
never changes project code, and never writes memory records.

## Invocation

```bash
node skills/sdw-retro/scripts/retro.cjs run [--run-id <runId>] [--root <path>] [--json]
```

- `--run-id` selects one run. Omit it to select the most recent run whose state
  has `status: "completed"` under `.sdw/state`.
- `--root` selects the project root. Omit it to walk up from the current
  directory to the nearest directory containing `.sdw/`.
- `--json` prints the report object on stdout. Selection telemetry moves to
  stderr so stdout stays machine readable.
- Exit `0` means both report files were written. Exit `1` means the subcommand,
  argument, run, or report write failed; the error names the cause.

## Inputs

The only retro inputs are:

1. The selected run state file: `.sdw/state/run-<timestamp>-<slug>.state.json`.
2. Every project-relative path that the state declares as an artifact:
   `steps.<n>.artifact`, `steps.4.tasks.<id>.promptPath`,
   `steps.4.tasks.<id>.evidencePath`, `steps.5.output.judgePromptPath`, and
   `steps.5.output.judgeVerdictPath`.

The analyzer never enumerates host transcript directories, session stores, chat
logs, or agent conversation records. If a declared path looks like a transcript,
session log, or chat log, the path is listed under `excludedInputs` with reason
`host-log` and is not read. Declared paths outside the project root are listed
with reason `outside-project-root`.

## Run Selection

- Candidate state files are the top-level `*.state.json` files under `.sdw/state`.
- Explicit `--run-id` accepts the full run identifier, a bare file name, a short
  timestamp, or a spec slug segment; the newest match wins.
- Without `--run-id`, only `status: "completed"` runs qualify. The newest
  `updatedAt` wins; ties fall back to the run identifier.
- `--run-id` may name a paused or failed run for diagnosis. Default selection
  never picks one.

## Signals

Signals are read from the state object, never invented from prose.

| Signal | Source | Notes |
|---|---|---|
| `timestamps` | `createdAt`, `updatedAt`, `steps.*` | Run timestamps plus per-step start and completion times. |
| `retries` | `scoreIteration`, `reviewIteration`, `steps.8.output.reviewConvergence.rounds`, dispatch abandonments | Numeric iteration and re-dispatch counters. |
| `abandonedDispatches` | `steps.4.dispatch.abandonments[*]` | Task, reason, time, and locator. |
| `scoreIterations` | `steps.5.output` | Score, minimum score, pass flag, judge score, and iteration. |
| `gateRepairs` | `steps.4.gates.*`, `steps.4.output.gates.*` | Gates whose recorded status is not `passed` or whose exit code is not `0`. |
| `reviewFindings` | `steps.7.output.findings[*]` | Counts by severity, open findings, and locators. |
| `unresolvedThreads` | `steps.8.output.reviewConvergence` | Active, resolved, and pending threads with locators. |
| `missingArtifacts` | declared artifact paths | Present only when a declared path is absent. |

The state stores only the latest gate record, so a repaired gate can appear as
`passed` with no failure history. `gateRepairs` reports what the state records;
it does not infer unrecorded repairs.

## Artifacts And Missing Content

- Expected artifacts come from the run state; nothing else is treated as an
  artifact.
- A missing path is recorded as `{ path, expectedBy, present: false }` under
  `signals.missingArtifacts` and listed in the Markdown report.
- The report never fabricates, summarizes, or back-fills content for a missing
  artifact.

## Report Files

Both files are written inside the run artifact directory, which the state names
as `artifactsDir`:

- `<runId>.retro.md` — human-readable report.
- `<runId>.retro.json` — machine-readable report with `inputs`, `artifacts`,
  `excludedInputs`, `signals`, `candidates`, and `candidateContract`.

Each report has `signals` and `candidates`. An empty `candidates` array is valid
for a smooth run. Candidates are operator- or agent-supplied judgments; the
shape and allowed values are defined in
[`candidate_contract.md`](candidate_contract.md).

Validate candidates before they enter a report:

```bash
node skills/sdw-retro/scripts/validate_candidates.cjs --input <file> [--root <path>] [--json]
```

The validator exits `0` only when every candidate is complete and ordered
`critical` -> `low`. Rejections carry a stable reason code; a direct `skills/`
edit is rejected with `skills-requires-spec` and the specification route, and a
`memory` candidate must carry an `sdw-memory` record draft instead of a
repository modification.

## Boundaries

- The run writes only the two report files. It does not edit source, specs, or
  memory, and it does not run git.
- `.sdw/state/` is git-ignored, so a retro run leaves the working tree unchanged.
- Every run needs an explicit operator invocation; no delivery step starts one.
