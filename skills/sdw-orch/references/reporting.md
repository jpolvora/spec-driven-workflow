# sdw-orch Reporting Reference

`report activity`, `report standup`, and `report explain` project existing delivery
evidence into a report. They never create or change evidence: a fact no source
answers is the literal `unknown`, and a date without delivery work is a valid
empty report with exit code `0`.

## Commands and flags

| Command | Flags | Output |
| --- | --- | --- |
| `report activity --date <YYYY-MM-DD>` | `--date` (required), `--json` | One row per run delivered on that UTC day |
| `report standup` | `--hours <n>` (default `36`), `--json` | Delivered, in-progress, and next items |
| `report explain <spec>` | positional registered slug, `--json` | Status, delivered files, verification, and manual test steps |

- `--json` serializes the same object the table renders, so the two surfaces cannot drift.
- Global `--root <path>` selects the workspace root.
- Exit codes: `0` when a report is produced, including an empty delivery day; `1` for a missing or malformed `--date`, an invalid or non-positive `--hours`, a missing slug, or a slug absent from the registry (the message names `sdw_spec.cjs list`).
- `--date` parses the day as UTC; a non-existent day such as `2026-02-30` is rejected instead of normalized.

## Data sources

| Source | Location | Feeds |
| --- | --- | --- |
| Run state | `{stateDir}/{runId}.state.json` | status, current step, steps, delivery commit, pull request, score, artifact directory, update time |
| Telemetry | `{artifactsDir}/telemetry.jsonl` | standup last event; explain gate fallback |
| AC ledger | `{artifactsDir}/ac-ledger.json` | explain verified and unverified criteria, tests observed, manual steps, delivered files |
| Git history | `git show -s --format=%cI <sha>`, `git show --name-only --format= <sha>` | activity end, standup delivery clock, explain delivered files |
| Registry | `.sdw/specs/index.specs.md` | explain status and slug validation; standup next items |
| Run artifacts | `{artifactsDir}/**` file mtimes | activity start (earliest creation clock) |
| Spec file | `.sdw/specs/{slug}.md` | explain title fallback and `specPath` |
| PR thread comments | caller-supplied `provider` hook | activity end; the CLI never queries a provider |

`{stateDir}` is `stateDir` from `.sdw/config.json` (default `.sdw/state`);
`{artifactsDir}` is the run's `artifactsDir`, else `{stateDir}/{slug}/{runId}`.
An unreadable run-state file is skipped and listed in `warnings[]`.

## Source markers

A derived value names its evidence. A `null` marker means no source answered and
the value is `unknown` (or `null` when the fact is not applicable).

| Report | Field | Marker values |
| --- | --- | --- |
| activity | `startSource` | `artifact:<path>`, `state.createdAt`, `state.mtime` |
| activity | `endSource` | `delivery-commit`, `pr-thread` |
| activity | `statusSource` | `run-state` |
| standup | `deliverySource` | `delivery-commit`, `step-6-completed`, `state.updatedAt`, `state.mtime`, `telemetry` |
| standup | `lastEventSource` | `telemetry`, `state.updatedAt`, `state.mtime` |
| explain | `statusSource` | `registry` |
| explain | `scoreSource` | `state.score`, `step-5-output` |
| explain | `gatesSource` | `run-state`, `telemetry` |
| explain | `deliveredFilesSource` | list of `run-state`, `ac-ledger`, `git` |
| explain | `acceptanceCriteriaSource`, `testsObservedSource`, `manualTestStepsSource` | `ac-ledger` |

## Output fields

### activity

Table: `SDW Activity Report`, `Date`, `State`, then `Spec | Run | Start | End |
Duration | Commit | PR | Status` and `Entries: <n>`. An empty day prints
`Entries: 0` and `No delivery activity for <date>`.

JSON: `command`, `date`, `generatedAt`, `stateDir`, `entries[]`, `warnings[]`.
Entry: `date`, `specSlug`, `runId`, `start`, `startSource`, `startUnknownReason`,
`end`, `endSource`, `endUnknownReason`, `durationMs`, `duration`,
`durationUnknownReason`, `deliveryCommit`, `deliveryCommitUnknownReason`,
`prUrl`, `status`, `statusSource`, `statusUnknownReason`.

`end` is the later of the last PR thread comment and the delivery commit time.
The CLI supplies no PR provider, so a run with a pull request reports `end:
unknown` with the provider reason instead of guessing.

### standup

Sections and columns:

- `Delivered (n)`: `Spec | Run | Step | Delivered | Last event | Blocking gate`
- `In progress (n)`: `Spec | Run | Step | Last event | Blocking gate`
- `Next (n)`: `Spec | Title | Status | Step | Last event`

An empty section prints `- none`.

JSON: `command`, `hours`, `generatedAt`, `window{start,end}`, `stateDir`,
`delivered[]`, `inProgress[]`, `next[]` or `"unknown"`, `nextUnknownReason`,
`warnings[]`. Item: `specSlug`, `runId`, `status`, `currentStep`, `totalSteps`,
`stepName`, `stepUnknownReason`, `notStarted`, `deliveredAt`, `deliverySource`,
`deliveryCommit`, `lastEventAt`, `lastEventSource`, `blockingGate`,
`blockingGateStatus`, `blockingGateUnknownReason`; a next item adds `title` and
has no run (`currentStep: null`, `notStarted: true`).

### explain

Sections: `Lifecycle`, `Delivered files`, `Verification`, `Acceptance criteria`
(verified and unverified tables), `Tests observed`, `Manual test steps`.

JSON: `command`, `specSlug`, `generatedAt`, `title`, `titleUnknownReason`,
`status`, `statusSource`, `statusUnknownReason`, `specPath`, `lifecycle`,
`deliveredFiles`, `deliveredFilesSource`, `deliveredFilesUnknownReason`,
`verification`, `acceptanceCriteria`, `acceptanceCriteriaSource`,
`testsObserved`, `testsObservedSource`, `testsObservedUnknownReason`,
`manualTestSteps`, `manualTestStepsSource`, `manualTestStepsUnknownReason`,
`unknowns[]`, `warnings[]`.

- `lifecycle`: `registryStatus`, `runId`, `runStatus`, `currentStep`,
  `totalSteps`, `stepUnknownReason`, `updatedAt`, `updatedAtUnknownReason`,
  `steps`, `stepsUnknownReason`.
- `verification`: `score`, `scoreSource`, `scoreUnknownReason`, `minScore`,
  `scorePassed`, `gates`, `gatesSource`, `gatesUnknownReason`, `review`
  (`stepStatus`, `outcome`, `blockingCount`, `findings[]`),
  `reviewUnknownReason`.
- `acceptanceCriteria`: `verified[]`, `unverified[]`, `unknownReason`.

## `unknown` semantics

- `unknown` is a literal string: never an empty string, a zero, or a guess.
- activity adds `startUnknownReason`, `endUnknownReason`,
  `durationUnknownReason`, `deliveryCommitUnknownReason`, and
  `statusUnknownReason`. explain adds a reason per unknown field and lists every
  one in `unknowns[]` as `{field, reason}`. standup uses `nextUnknownReason` for
  `next: "unknown"` and `blockingGateUnknownReason` for an unknown gate;
  `deliveredAt` and `lastEventAt` read `unknown` with a `null` source when no
  clock answers.
- `null` means the fact is not applicable (a pending specification has no
  `runId`; a report without a pull request has no `prUrl`). `unknown` means the
  contract asks for the fact and no source answered it.
- An unreadable registry makes `standup.next` `"unknown"` with a reason instead
  of a zero count. A run with no recorded step, gate map, or status reports
  `unknown`, never "not started", "none", or a default.
- An empty date is not `unknown`: the report lists no entries, prints the zero
  count, and exits `0`.

## Read-only guarantee

Reporting only reads run state, run artifacts, telemetry, the AC ledger, the
registry, and read-only git queries. It never initializes `{stateDir}`, never
writes run state, a ledger, telemetry, or a report artifact, and never runs a
git write command or a provider mutation. `now`, `git`, and `provider` are
injectable, so tests are deterministic; the CLI uses the system clock for
`generatedAt` and the standup window.
