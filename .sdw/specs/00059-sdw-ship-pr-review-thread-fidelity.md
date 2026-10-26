---
id: null
slug: 00059-sdw-ship-pr-review-thread-fidelity
title: "SDW Review Thread Fidelity — Full Thread Content in list-threads and the Fixer Input"
source: local
status: implemented
specDate: 2026-10-22
priority: high
value: "Lets the convergence loop and the operator read the whole review thread instead of its first line, so a fix targets the reported defect and the analysis behind it"
effort: S
---
# Specification — SDW Review Thread Fidelity

## Description

The scm provider already fetches a review thread in full. `GitHubProvider.listReviewThreads` runs one GraphQL query that requests `reviewThreads(first: 50)` and, for each thread, `comments(first: 50)` with `id`, `databaseId`, `body`, `author`, and `createdAt`, and it maps every comment into the returned thread. The bodies arrive complete.

Two consumers throw that content away:

- `sdw-ship-pr list-threads` prints one line per thread built from `comments[0].body.split('\n')[0].slice(0, 80)`, so the operator sees the first line of the first comment, cut at 80 characters. The GitHub page for the same thread shows the whole message, including the suggested correction and the analysis block.
- The convergence loop builds the default fixer findings from `comments[0].body.slice(0, 500)`, so `sdw-fixer` receives one truncated paragraph of a thread whose later text names the defective line, the scenario, the missing protection, and the suggested fix.

The consequence is observable in this repository's own review history: a finding that explained the defect in four numbered points reached the operator as a single warning line, and a fixer would have worked from the first 500 characters of that line. Convergence quality depends on the reviewer's reasoning reaching the agent that applies the fix, and today only its title does.

This specification makes both consumers carry the whole thread. The provider query stays as it is, because it is already complete; the change is in what the CLI prints and what the fixer receives. No truncation, no first-comment-only rule, and no loss of the multi-comment exchange that shows what was already tried.

### Design Intent

Read one source and render it faithfully. The provider is the single fetch point, so a fidelity bug is a consumer bug: fix the consumers and keep one fetching path. Full bodies are worth the extra output because a review thread is the specification of a defect, and every cut removes the part that explains why the code is wrong.

## Acceptance Criteria

- AC1: When `list-threads` prints a thread, the system shall print every comment of that thread with its complete body, preserving the body's line breaks.
- AC2: The system shall print each comment with its author and its creation timestamp.
- AC3: When `--json` is supplied, the system shall emit every comment with its complete body, author, and timestamp for each thread.
- AC4: The system shall not truncate a comment body and shall not reduce a thread to its first comment in either output mode.
- AC5: When a thread carries no comments, the system shall print a placeholder line for that thread and shall still exit `0`.
- AC6: The system shall separate consecutive comments and consecutive threads, so a thread with several long comments stays readable.
- AC7: When the convergence loop builds the default fixer findings, the system shall carry the complete text of every comment in the thread as the finding's evidence, in chronological order, instead of the first comment cut to a fixed length.
- AC8: The system shall print, for each thread, its resolution status, identifier, path, line, and comment count.
- AC9: The system shall keep the `resolve-thread` command and the resolution reply it posts unchanged, so thread fidelity never alters the resolution contract.
- AC10: The `sdw-ship-pr` skill definition and the ship protocol reference shall document the full-thread output and the fixer evidence rule within the Tier-1 line budget.
- AC11: The test suite shall cover a thread with several comments printed in full, a body longer than 80 characters and several lines deep, a thread with no comments, the `--json` payload, and the fixer finding carrying every comment.

## Notes

- Root cause is in the consumers, not the query. `GitHubProvider.listReviewThreads` already returns every comment with its complete `body`; `AzureDevOpsProvider` must be confirmed to do the same while implementing, and only a genuine gap there becomes an in-scope provider change.
- Current narrowing sites to remove:
  - `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` `list-threads` rendering: `t.comments[0].body.split('\n')[0].slice(0, 80)`.
  - `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs` `buildDefaultFixerCommand`: `firstComment.trim().slice(0, 500)`.
- Output shape for a thread: a header line carrying `[ACTIVE|RESOLVED]`, the thread id, `path:line`, and `N comment(s)`, then one block per comment carrying `author`, `createdAt`, and the body verbatim, then a blank line between threads.
- The `--json` payload keeps the provider's thread shape and adds nothing that the text output hides, so a script and a human read the same fields.
- A resolution reply is a comment, so it prints like any other comment; the resolution status stays the thread's `isResolved` flag and never a body marker.
- Target surfaces:
  - `skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs`: the `list-threads` renderer and the fixer finding builder.
  - `skills/sdw-spec/scripts/providers/ado.cjs`: only if it drops comment bodies, confirmed while implementing.
  - `skills/sdw-ship-pr/SKILL.md` and `skills/sdw-ship-pr/references/ship_protocol.md`: the full-thread output and the fixer evidence rule.
  - `tests/sdw_ship_pr.test.cjs`: the cases named in AC11.
- All helper scripts remain Node.js CommonJS (.cjs) using standard library modules only. No new runtime dependencies.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Changing the provider query or adding pagination beyond the existing first 50 threads and 50 comments | The query already returns complete bodies; pagination is a separate concern |
| Writing review findings to a file that survives the run | The delivery report already records convergence; this specification changes output fidelity only |
| Resolving threads automatically from their content | Resolution stays an explicit, evidence-cited action |
| Changing the fixer's findings schema | The evidence field carries the full text; the schema shape is unchanged |
| Summarizing long threads with a model | The writer and the CLI stay deterministic; no language model is invoked |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| The provider already fetches full bodies | Fix the consumers only | The GraphQL query requests every comment's body and the mapper copies it verbatim | y |
| Full bodies in the terminal | Print everything, with separators | A truncated review thread is what caused the defect being fixed | y |
| JSON mirrors the text output | Same fields, no hidden data | A script and a human must read one contract | y |
| Fixer evidence without a length cut | Whole text, chronological | A fixer that reads 500 characters cannot see the suggested correction | y |
| Resolution reply unchanged | Yes | Fidelity must not alter what resolving a thread means | y |
| Azure DevOps parity | Confirm while implementing | Only a real gap becomes an in-scope provider change | n |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|--------------|---------------------|
| EARS syntax | All 11 acceptance criteria conform to EARS patterns | Run `node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring .sdw/specs/00059-sdw-ship-pr-review-thread-fidelity.md` |
| Scope enclosure | The two narrowing sites plus documentation and tests | Inspect `## Description` plus `## Out of Scope` |
| Target inventory | The CLI renderer, the fixer builder, the protocol and skill docs, and the tests | Inspect `## Notes` target list |
| Dependency | Spec 00024 and spec 00050 are delivered, so `list-threads` and the fixer delegation exist | Check the registry rows |
| Baseline suite | Existing test suite passes with zero regressions | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `list-threads` on a thread whose first comment is a one-line title prints the title and the full body that follows it.
- A thread with four comments prints four blocks, each naming its author and timestamp.
- `list-threads --json` returns the same bodies as the text output, character for character.
- The fixer findings file built by the convergence loop carries every comment body of the thread.
- A body containing the sequence `Correção sugerida` or a fenced block prints it intact.

### Negative & Failing Test Scenarios

- A thread with no comments prints a placeholder and the command exits `0`.
- A body with embedded markdown and blank lines renders with its structure, not collapsed into one line.
- A long body of several thousand characters prints in full; no silent cut appears at 80 or 500 characters.
- `--json` with a resolved thread prints its comments and the resolved status.
- `resolve-thread` behaviour is unchanged, verified by the existing resolution tests.
- Budget: `skills/sdw-ship-pr/SKILL.md` stays within its Tier-1 line budget.
