---
id: null
slug: 00048-sdw-retro-signal-precision
title: "Transcript Signal Precision — Command Shape and Repeated Invocation Matching"
source: local
status: implemented
specDate: 2026-10-21
---
# Specification — Transcript Signal Precision — Command Shape and Repeated Invocation Matching

## Description

### Problem

Spec 00047 made the retrospective read host session transcripts. Measured against the real DeepSeek Harness session for this repository, the scanner produced a false positive on its first live run:

- `repeated_run_invocation` reported lines 6669 and 6676 for `00000-manual.md`. Those lines are agent messages that quote a tool command; neither is an orchestrator invocation.
- The reported specification name kept a trailing backtick, so it matches no specification file.

Cause: the scanner accepts any line that mentions `sdw_orch.cjs` and contains the word `run` somewhere, and it captures the `--spec` value including surrounding punctuation. Every agent message that quotes a command, and every transcript format that echoes a command inside its result, can therefore produce a signal.

A detector that reports the wrong thing is worse than no detector: the operator learns to ignore the signal that was built to catch a real slip.

### Proposal

1. Command shape: an invocation is a line where the orchestrator executable is immediately followed by the command word (`run` or `resume`), allowing a closing quote between them. A prose sentence that happens to contain `sdw_orch.cjs` and the word `run` is not an invocation.
2. Spec capture: strip surrounding quotes, backticks, and trailing punctuation from the `--spec` value before deriving the specification name.
3. Adjacent duplicates: two matching lines with identical normalized text within two lines count once, covering formats that echo a call in its own result.
4. Regression proof: fixtures built from the shapes that produced the false positive, including a quoted command inside a JSON message and a prose line containing both tokens.

### Scope

- `skills/sdw-retro/scripts/retro.cjs`: the invocation matcher, the spec normalization, and adjacent-duplicate collapsing.
- `skills/sdw-retro/references/retro_protocol.md`: the matching rule, stated exactly as implemented.
- Tests: `tests/sdw_retro.test.cjs`.

## Acceptance Criteria

- AC1: The retrospective shall treat a line as an orchestrator invocation only when the orchestrator executable is followed by the command word `run` or `resume`, optionally separated by a closing quote.
- AC2: When a line mentions the orchestrator executable and the word `run` without that command shape, the retrospective shall not report a `repeated_run_invocation` signal.
- AC3: When the `--spec` value carries surrounding quotes, backticks, or trailing punctuation, the retrospective shall normalize it to the specification file stem before comparison.
- AC4: When two matching lines are adjacent with identical normalized text, the retrospective shall count them as one invocation.
- AC5: The system shall document the matching rule in the retro protocol reference as implemented, including the command shape and the normalization.

## Verification

- [ ] A prose line containing `sdw_orch.cjs` and the word `run` produces no signal.
- [ ] A quoted command inside a JSON message (`\"...sdw_orch.cjs\" run --spec ...`) is recognized.
- [ ] Two adjacent identical command lines produce one invocation, not a repeat.
- [ ] A genuine duplicate (two invocations separated by other events) still produces the signal with both line numbers.
- [ ] `--spec .sdw/specs/00000-x.md\`` normalizes to `00000-x`.
- [ ] `npm test` passes; `doctor` passes.

## Notes

- Line-based scanning stays; the fix is precision, not a parser.
- The real session that exposed the defect is not committed and must not be committed; fixtures reproduce its shape.
- Node.js CommonJS, standard library only.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full JSON transcript parsing | Host formats differ; the line scanner plus command shape covers the observed cases |
| Semantic judgment of commands | Signals stay deterministic; judgment belongs to the operator or candidate review |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Adjacent-duplicate window | Two lines | Covers call plus echoed result without merging genuinely separated repeats | y |
| Command word position | Immediately after the executable | Distinguishes a command from prose that mentions both tokens | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | `validate_spec.cjs --mode=authoring` |
| Reproduction | A real transcript line shape that produced the false positive | Fixture in `tests/sdw_retro.test.cjs` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- The signal continues to cite path and line numbers only.

### Negative & Failing Test Scenarios

- A transcript whose only orchestrator mention is inside a quoted report: no signal.
- A single invocation echoed by the tool result: no signal.
