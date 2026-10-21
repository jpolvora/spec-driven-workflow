# Session Transcript Discovery

`retro.cjs` never discovers host files. The agent resolves the current session
transcript from host facts, verifies that the resolved path exists, and passes
it with `--transcript`. This document describes the supported layouts and the
capture fallback. Paths use environment variables and `~` so they stay portable.

## Rules

1. Resolve the path from a host fact (environment variable or documented layout)
   and verify it exists before passing it. Never pass a path you did not resolve:
   a guessed path that does not exist only produces `transcript_unreadable`.
2. Pass the resolved path with `--transcript <path>`. A host transcript keeps the
   default `--transcript-mode host`.
3. Treat a session file as read-only input. Never copy it into the project,
   quote its line bodies, or commit it.
4. When no supported transcript exists, or the resolved file cannot be decoded,
   write the capture file described under Fallback and pass it with
   `--transcript <file> --transcript-mode captured`.

## DeepSeek Harness

Environment facts: `DSH_HOME` (default host data directory) and
`DSH_SESSION_ID` (this session's id).

Layout:

```
%DSH_HOME%\sessions\--<project>--\session-<DSH_SESSION_ID>\session.v4.jsonl.zstd
```

The `<project>` segment is derived from the project root path and is not
reproducible by hand. List the sessions directory and pick the entry that
matches this project instead of computing the segment.

PowerShell:

```powershell
Test-Path "$env:DSH_HOME\sessions\--<project>--\session-$env:DSH_SESSION_ID\session.v4.jsonl.zstd"
Get-ChildItem "$env:DSH_HOME\sessions" -Directory | Select-Object Name
```

POSIX shell:

```bash
test -f "$DSH_HOME/sessions/--<project>--/session-$DSH_SESSION_ID/session.v4.jsonl.zstd"
ls "$DSH_HOME/sessions"
```

The file is zstd-compressed, often as thousands of concatenated frames.
`retro.cjs` decodes every frame in memory with the Node.js standard library, so
no external codec is needed. Pass the `.zstd` path unchanged.

## Claude Code

Environment fact: `CLAUDE_CONFIG_DIR` (defaults to `~/.claude`).

Layout:

```
~/.claude/projects/<slug>/<sessionId>.jsonl
```

`<slug>` is the absolute project path with its separators and drive colon
replaced by `-`. `<sessionId>` is the current session id. When the host does not
expose the id to the agent, take the most recently modified `.jsonl` in the
project directory only after confirming it was written by this session.

PowerShell:

```powershell
Get-ChildItem "$env:CLAUDE_CONFIG_DIR\projects" -Directory | Select-Object Name
Get-ChildItem "$env:CLAUDE_CONFIG_DIR\projects\<slug>" -Filter *.jsonl |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 FullName
```

POSIX shell:

```bash
ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
ls -t "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<slug>"/*.jsonl
```

## Codex

Environment fact: `CODEX_HOME` (defaults to `~/.codex`).

Layout:

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<sessionId>.jsonl
```

PowerShell:

```powershell
Get-ChildItem "$env:CODEX_HOME\sessions" -Recurse -Filter rollout-*.jsonl |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 FullName
```

POSIX shell:

```bash
find "${CODEX_HOME:-$HOME/.codex}/sessions" -name 'rollout-*.jsonl' -type f | sort | tail -n 1
```

Pick the rollout written after this session started. An older rollout belongs to
a different session and must not be passed.

## Fallback: Captured Context

Use the fallback when no layout applies, the resolved file cannot be decoded, or
the planner blocks access to host paths. Do not use it to escape a decoding
problem you can fix by passing the right path.

Write this session's messages to `.sdw/state/retro-session-{runId}.md`:

- One message per line, no other prose.
- Role prefix on every line: `user: `, `assistant: `, or `tool: `.
- Include only this session's messages. No secrets, tokens, or credentials.
- The state directory is git-ignored, so the file never enters a delivery commit.

Example:

```
user: implement spec 00047 task-1
assistant: dispatching task-1 to the implementation worker
tool: node skills/sdw-retro/scripts/retro.cjs run --run-id run-1792614056524
assistant: task-1 reported success
```

Pass the file:

```bash
node skills/sdw-retro/scripts/retro.cjs run --run-id <runId> \
  --transcript .sdw/state/retro-session-<runId>.md --transcript-mode captured
```

The report records the mode next to the input, so a later reader can tell a host
transcript (`host`) from an agent-captured one (`captured`).
