# Fixer Protocol (Tier-2)

Deterministic contract for `sdw-fixer`: intake validation, scoring, proactive
discovery, surgical scope, and result reporting. Stdlib only; no network calls.

## 1. Intake Schema (`findings.json`)

```json
{
  "batchId": "fix-0001",
  "findings": [
    { "file": "src/a.js", "line": 12, "rule": "no_debugger_statements",
      "evidence": "agentic-code-reviewers report CR-001", "severityHint": "high" }
  ]
}
```

A bare array of finding objects is also accepted. Field rules:

| Field | Required | Rule |
|---|---|---|
| `file` | yes | Project-relative path only. Reject absolute paths, drive letters, and any `..` segment. |
| `line` | no | Positive integer when present. Sibling sweep still runs when absent. |
| `rule` | yes | Non-empty defect-class identifier, `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Doubles as the grep token source. |
| `evidence` | yes | Non-empty reference (review report id, log excerpt, thread URL). |
| `severityHint` | no | `critical`, `high`, `medium`, or `low`. Missing or unknown scores as `medium`. |

Validation runs before any read beyond the findings file itself. The first
malformed entry halts the batch with exit `1` and zero mutations.

## 2. Severity Rubric (deterministic)

| `severityHint` | Score | Fix order |
|---|---|---|
| `critical` | 100 | first |
| `high` | 75 | second |
| `medium` (or missing/unknown) | 50 | third |
| `low` | 25 | last |

Ties keep input order (stable sort). Scores are printed as
`[sdw-fixer] Scoring N findings` and stored per finding; no model call or
timestamp may influence ordering.

## 3. Discovery Order (lean context budgets)

Per finding, consult backends in this order and record `sourcesConsulted`:

1. **Code grep first.** Search repo text files for the rule's defect token
   (see catalog below, else the literal rule id). Caps: 50 hits, one snippet
   line each (max 160 chars), files over 256 KB skipped, `.git`,
   `node_modules`, `.sdw/state`, `.sdw/sandbox` excluded.
2. **Filtered memory lookup second.** Scan `{projectRoot}/.sdw/traps.md` rows
   for the rule id or its keywords (rule split on non-alphanumerics, words
   longer than 2 chars); keep the top 5 as `{ slug, title, action }` hints.
   Missing or unreadable trap log records `memory-traps:consult-skipped`.
3. **Same-PR context third.** Reserved for orchestrator/ship callers that pass
   thread context; the helper records `pr-context:consult-skipped` unless the
   caller appends it.

## 4. Surgical Scope Gate

- Editable in this round: lines matching a catalog trivial pattern at the
  finding's `file:line` plus matching lines at verified sibling hits in the
  same file.
- Everything else (unknown rule, pattern mismatch at the cited line, missing
  file) becomes a `skipped` entry with `path + reason` for agent reasoning.
- Large refactor scope is never auto-fixed: record `path + reason` and leave
  the class open. Never close a defect class with an unfixed surgical sibling
  left unrecorded.
- `--dry-run` computes the exact line removals but writes nothing.

## 5. Trivial Patch Catalog

| `rule` | Grep tokens | Patch |
|---|---|---|
| `no_debugger_statements` | `debugger` | Delete lines matching `^\s*debugger\s*;?\s*$` at finding + sibling lines. |

Rules outside this catalog have no deterministic patch and route to
`skipped` with reason `non-trivial: requires agent reasoning`.

## 6. Report Schema (`result.json`)

```json
{
  "batchId": "fix-0001",
  "status": "completed",
  "fixed": [{ "file": "src/a.js", "line": 12, "defectClass": "no_debugger_statements" }],
  "skipped": [{ "file": "src/b.js", "reason": "non-trivial: requires agent reasoning" }],
  "wouldFix": [],
  "verification": { "exitCode": null, "status": "skipped", "reason": "no --verify command given" },
  "reportPath": "result.json"
}
```

- `status`: `completed`, `no-op` (empty findings, exit `0`), or
  `verify-failed` (exit `1`, partial report preserved).
- `wouldFix` is populated only under `--dry-run`; `fixed` stays empty there.
- `verification.status` is `passed`, `failed`, or `skipped`.

## 7. Exit Codes

- `0`: intake valid (report written; `no-op` when the list is empty).
- `1`: malformed findings JSON, missing `file`/`rule`/`evidence`, or
  `--verify` command failing (partial report still written first).
