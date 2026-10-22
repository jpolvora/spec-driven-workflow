---
name: sdw-code-review
description: Deep working-tree code review, actionable fix planning, and orchestrator delegation.
version: 0.1.0
invocation_names:
  - sdw-code-review
  - sdw-code-review run
  - sdw-code-review fix
  - sdw-code-review doctor
  - code-review
---

# sdw-code-review

> When this skill is loaded, output "sdw-code-review loaded."

Lean standalone code reviewer for Spec-Driven Workflow. Analyzes committed and
uncommitted working-tree changes against an auto-detected base branch, applying
`sdw-rules` simplicity first (YAGNI, surgical scope, syntax hygiene).

## Fresh-Session Mandate

An orchestrated invocation (`sdw-orch` Step 7) executes only in a context-fresh
reviewer subagent session. Its brief carries target root, base reference, report
path, and scope fence, never the implementation transcript, prior worker reasoning,
DAG prompts, or judge verdicts. Same-session CLI review in the orchestrator session
is not a verdict; standalone `doctor` plus `--dry-run` stay valid.

When a standalone caller authored the diff under review, this skill recommends
fresh-session execution too; the recommendation stays non-blocking so quick
self-checks remain practical.

## Subcommands

- `run [--base <ref>] [--target <path>] [--report <path>] [--fix] [--dry-run] [--json]`: Review working tree and HEAD diffs, write Markdown fix plan, emit JSON.
- `fix [--base <ref>] [--target <path>] [--report <path>] [--max-iterations <n>] [--json]`: Run review with surgical auto-fixes up to ceiling (default 3).
- `doctor`: Validate skill integrity, git availability, and config readability.

## Steps

1. **Resolve Base & Scope**
   Resolve base via explicit `--base`, config `baseBranch`, tracking remote
   `origin/main|master`, local `main|master`, or merge-base fallback. Collect
   committed (`base..HEAD`) plus uncommitted (staged, unstaged, untracked) files.
   - Run: `node skills/sdw-code-review/scripts/sdw_code_review.cjs run --target <path> [--base <ref>] [--json]`
   - Done when: Base source logged and changed-file inventory is established.

2. **Execute Deterministic Review**
   Scan diffs for debugger statements, unresolved TODOs, secret leaks, Python in
   `skills/`, unrequested markers, and oversized diffs.
   Assign stable IDs (`CR-001`), severity, `file:line`, rule citation, and fix plan.
   - Run: `node skills/sdw-code-review/scripts/sdw_code_review.cjs run --target <path> --report <reportPath> [--fix] [--dry-run] [--json]`
   - Done when: Helper exits `0` (no `critical`/`warning`) or `1` (blocking or invalid input).

3. **Triage Report in a Fresh Session**
   Read Markdown report as executable fix plan. For an orchestrated Step 7 verdict,
   triage runs only in a context-fresh reviewer subagent session; never run this CLI
   in the orchestrator session. Inspect JSON (`passed`, `errorCount`,
   `warningCount`, `suggestionCount`, `findings`) to advance, fix, or pause.
   - Done when: Blocking findings are `0` or fix ceiling reached with residual recorded.

## References

- Rule catalog, hygiene invariants, and report schema: [`references/code_review_rules.md`](references/code_review_rules.md)
- Deterministic helper: `scripts/sdw_code_review.cjs`
