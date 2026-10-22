---
name: sdw-retro
description: Retrospective over a completed sdw-orch run, automatic when retro.enabled is true, reporting evidence-bound friction signals, transcript command slips, and improvement candidates.
version: 0.3.0
invocation_names:
  - sdw-retro
  - retro run
---
# sdw-retro

> When this skill is loaded, output "sdw-retro loaded."

Reviews one `sdw-orch` run after delivery. It reads the run state file, the step
artifacts that state declares, and the transcript the finder resolves or the
operator explicitly names. It reports deterministic friction signals and applies
every fix its routes allow; a code change still needs a specification.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) before acting.

## Behavior

- `sdw-orch` runs this skill automatically for a completed run when `retro.enabled` is `true` and records the outcome in `state.retro`; a retro failure never changes the completed status or the exit code.
- When `retro.enabled` is `false` or absent, `sdw-orch` prints the advisory command only; the operator starts the retro.
- Inputs are the run state file, the step artifacts it declares, and the transcripts named by `retro.transcripts` or `--transcript`, nothing else.
- Unconfigured host transcripts, session logs, and agent chat logs stay excluded from the analyzer and are reported as excluded inputs.
- Configured transcripts are scanned line by line; the report cites path and line numbers only and never copies transcript line bodies.
- Missing declared artifacts are recorded as absences; the report never synthesizes their content.
- The report carries the `leftover_run`, `repeated_run_invocation`, and `transcript_unreadable` signals.
- The run writes `<runId>.retro.md` and `<runId>.retro.json` inside the run artifact directory.
- A report with signals and no candidates is valid for a smooth delivery.
- `scripts/validate_candidates.cjs` accepts only complete candidates ordered `critical` -> `low`; rejections carry a stable reason code.
- Memory candidates emit an `sdw-memory` record draft; the retro records it when it runs with candidates and reports the slug and backend.
- The retro applies only what its routes allow: memory records and duplicate consolidation run immediately, a candidate that needs a change under `skills/` or `tests/` is queued as a follow-up specification and named, and the file is never edited.
- The report carries `fixes` (recorded entries, consolidation counts, queued specifications, failures) and `routedCandidates` (one route and status per candidate).

## Signals

- `leftover_run`: a sibling run state of the same specification never reached a terminal status. Names the run id, status, and age.
- `repeated_run_invocation`: one transcript contains more than one `sdw-orch ... run` invocation for the same `--spec` with no `resume` between them. Names the file and line numbers.
- `transcript_unreadable`: a named transcript path does not exist, cannot be read, or is not decodable text. Names the file and reason; the command still exits `0`.

## Start Guard

`sdw-orch run` refuses to start when the same specification already has a run that is neither `completed` nor `failed`. It names the open run id, points to `resume --run-id <runId>`, and exits non-zero; `--new-run` overrides for an intentional restart. Repeating `run` instead of `resume` is the slip `repeated_run_invocation` reports.

## Steps

1. **Select the run**
   Omit `--run-id` to take the most recent completed run under `.sdw/state`, or name one explicitly.
   - Done when: the command prints the selected run identifier and artifact directory.

2. **Locate the session transcript**
   Use a transcript named by `retro.transcripts` or `--transcript` first. When none is configured, run the finder before any capture fallback:
   ```bash
   node skills/sdw-retro/scripts/find_session_transcript.cjs [--root <projectRoot>] [--json]
   ```
   It prints JSON with `found`, `path`, `score`, `source`, `sessionId`, `entriesScanned`, `elapsedMs`, and `roots`, and never prints transcript content.
   - `found: true`: pass `path` with `--transcript <path>` and keep the default mode; omit `--transcript-mode` (default `host`).
   - `found: false`: write this session's messages to `.sdw/state/retro-session-{runId}.md`, one `user:`/`assistant:`/`tool:` line per message, and pass `--transcript <file> --transcript-mode captured`.
   Procedure and bounds: [`references/session_discovery.md`](references/session_discovery.md).
   - Done when: the transcript path exists and came from a configured input, the finder, or this session's capture.

3. **Run the analysis**
   ```bash
   node skills/sdw-retro/scripts/retro.cjs run [--run-id <runId>] [--root <projectRoot>] [--candidates <file>] [--transcript <path>]... [--transcript-mode <host|captured>] [--json]
   ```
   Name transcripts with `retro.transcripts` or repeated `--transcript`; the script never discovers them and decodes zstd frames in memory. `--transcript-mode <host|captured>` defaults to `host` and labels every transcript input in both reports. Name candidates with `--candidates <file>` (an array or a saved report's `candidates`), and the run applies their routes before it writes the reports.
   - Done when: the command exits `0`, writes both report files, and reports `fixes` plus `routedCandidates` for every candidate handed in, even when a transcript is unreadable.

4. **Review signals and record candidates**
   Read the deterministic signals. A candidate is an operator- or agent-supplied judgment with `id`, `title`, `severity`, `category`, `evidence`, and `proposedChange`.
   - Done when: each recorded candidate uses an allowed severity and category and cites run evidence.

5. **Validate the candidates**
   ```bash
   node skills/sdw-retro/scripts/validate_candidates.cjs --input <file> [--root <projectRoot>] [--json]
   ```
   - Done when: the command exits `0` with every candidate complete and ordered `critical` -> `low`; memory candidates carry an `sdw-memory` draft.

6. **Apply the routes**
   Pass the accepted candidates with `--candidates`; the retro records the memory entries, consolidates duplicate entries, and queues a follow-up specification for every candidate that needs a code change. A candidate that needs a change under `skills/` or `tests/` is queued and named (`queuedSpecifications`), never edited; a route that cannot be applied is reported under `fixes.failures`.
   - Done when: every candidate has a `routedCandidates` entry, each applied fix is named on the report, and an empty candidate list still yields a valid report.

## Reference

- Run selection, inputs, signals, and report contract: [`references/retro_protocol.md`](references/retro_protocol.md)
- Generic transcript discovery and capture fallback: [`references/session_discovery.md`](references/session_discovery.md)
- Candidate fields, locator rules, memory drafts, reason codes: [`references/candidate_contract.md`](references/candidate_contract.md)
- Deterministic analyzer: [`scripts/retro.cjs`](scripts/retro.cjs)
- Deterministic candidate validator: [`scripts/validate_candidates.cjs`](scripts/validate_candidates.cjs)
