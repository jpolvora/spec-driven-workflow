---
name: sdw-retro
description: Human-invoked retrospective over a completed sdw-orch run that reports evidence-bound friction signals and improvement candidates.
version: 0.2.0
invocation_names:
  - sdw-retro
  - retro run
---
# sdw-retro

> When this skill is loaded, output "sdw-retro loaded."

Reviews one `sdw-orch` run after delivery. It reads the run state file and the
step artifacts that state declares, reports deterministic friction signals, and
leaves every improvement judgment to an explicit operator decision.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) before acting. Never run a retro automatically.

## Behavior

- Inputs are the run state file and the step artifacts it declares, nothing else.
- Host transcripts, session logs, and agent chat logs are excluded and reported as excluded inputs.
- Missing declared artifacts are recorded as absences; the report never synthesizes their content.
- The run writes `<runId>.retro.md` and `<runId>.retro.json` inside the run artifact directory.
- A report with signals and no candidates is valid for a smooth delivery.
- `scripts/validate_candidates.cjs` accepts only complete candidates ordered `critical` -> `low`; rejections carry a stable reason code.
- Memory candidates emit an `sdw-memory` record draft; a retro never records it and never edits `skills/` directly.

## Steps

1. **Select the run**
   Omit `--run-id` to take the most recent completed run under `.sdw/state`, or name one explicitly.
   - Done when: the command prints the selected run identifier and artifact directory.

2. **Run the analysis**
   ```bash
   node skills/sdw-retro/scripts/retro.cjs run [--run-id <runId>] [--root <projectRoot>] [--json]
   ```
   - Done when: the command exits `0` and writes both report files.

3. **Review signals and record candidates**
   Read the deterministic signals. A candidate is an operator- or agent-supplied judgment with `id`, `title`, `severity`, `category`, `evidence`, and `proposedChange`.
   - Done when: each recorded candidate uses an allowed severity and category and cites run evidence.

4. **Validate the candidates**
   ```bash
   node skills/sdw-retro/scripts/validate_candidates.cjs --input <file> [--root <projectRoot>] [--json]
   ```
   - Done when: the command exits `0` with every candidate complete and ordered `critical` -> `low`; memory candidates carry an `sdw-memory` draft.

5. **Decide the follow-up**
   Route an accepted candidate to a specification, an `sdw-memory` record, or an operator edit. A retro never applies changes; a direct `skills/` edit is rejected with `skills-requires-spec` and the specification route.
   - Done when: the operator knows the route for each candidate or accepts an empty candidate list.

## Reference

- Run selection, inputs, signals, and report contract: [`references/retro_protocol.md`](references/retro_protocol.md)
- Candidate fields, locator rules, memory drafts, reason codes: [`references/candidate_contract.md`](references/candidate_contract.md)
- Deterministic analyzer: [`scripts/retro.cjs`](scripts/retro.cjs)
- Deterministic candidate validator: [`scripts/validate_candidates.cjs`](scripts/validate_candidates.cjs)
