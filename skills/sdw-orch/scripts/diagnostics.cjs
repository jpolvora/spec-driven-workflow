'use strict';

// Spec 00033 AC2: the diagnostic recorder is zero-dependency. It loads only
// Node.js built-ins (`fs`, `path`), never a package and never the network,
// so diagnostics add no install surface to consumers.
const fs = require('fs');
const path = require('path');

// Spec 00033 AC4: one event holds at most 500 characters of stderr, so a
// noisy tool can never inflate the diagnostics log with unbounded output.
const MAX_SNIPPET_CHARS = 500;
// Spec 00033 AC11: the recorder stops at 200 events, so a long or looping run
// cannot grow the diagnostics file without bound. The cap spans reopens: a
// recorder created over an existing full file appends nothing.
const MAX_EVENTS = 200;
const DIAGNOSTICS_FILENAME = 'diagnostics.jsonl';
// Spec 00033 AC8: the report keeps one evidence cell readable, so an excerpt
// that is already bounded in the event stays bounded in the Markdown table.
const MAX_EVIDENCE_CHARS = 160;
// Spec 00033 AC8: issue severity per event kind. The mapping is fixed, so the
// same JSONL always renders the same table.
const ISSUE_SEVERITIES = {
  tool_failure: 'error',
  script_failure: 'error',
  retry: 'warning',
  fallback: 'warning',
  workaround: 'warning',
  score_mismatch: 'warning',
  gate_repair: 'warning',
  state_repair: 'warning'
};

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

// Bounds one stderr snippet to MAX_SNIPPET_CHARS characters. The snippet is
// capped on the raw text, so a crash report or a stack trace stays readable
// from the beginning of the failure.
function boundSnippet(text, maxChars) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_SNIPPET_CHARS;
  if (text === undefined || text === null) return '';
  const value = String(text).replace(/\r\n?/g, '\n').trim();
  return value.length > limit ? value.slice(0, limit) : value;
}

// Spec 00033 AC11: the report states the recorded bytes, so the run shows the
// disk footprint of diagnostics next to the event count. One line per event is
// the same shape the recorder appends to the JSONL file.
function eventsBytes(events) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  return Buffer.byteLength(events.map(event => `${JSON.stringify(event)}\n`).join(''), 'utf8');
}

// Spec 00033: `{runDir}/diagnostics.jsonl`, project-relative in the run state so
// the recorded path never depends on the machine that ran it.
function eventsPathFor(artifactsDir) {
  const dir = artifactsDir && String(artifactsDir).trim() ? artifactsDir : path.join('.sdw', 'state');
  return normalizePath(path.join(dir, DIAGNOSTICS_FILENAME));
}

/**
 * Spec 00033 AC1: the run-state record for diagnostic mode.
 * Disabled mode resolves to an inert record with no path and no timestamp.
 */
function buildRunDiagnostic(options = {}) {
  const enabled = options.enabled === true;
  if (!enabled) return { enabled: false, eventsPath: null, startedAt: null };
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const startedAt = options.startedAt || clock().toISOString();
  return {
    enabled: true,
    eventsPath: eventsPathFor(options.artifactsDir),
    startedAt
  };
}

/**
 * Spec 00033 AC2/AC3/AC4/AC10: an append-only event recorder.
 *
 * - Disabled: every method is a no-op, so a run without `--diagnostic` behaves
 *   exactly as before and never touches the filesystem.
 * - Enabled: events are kept in memory and appended as JSONL to `eventsPath`.
 * - Fail-open: a recording or write failure warns once and never throws, so
 *   diagnostics can never fail a delivery.
 */
function createRecorder(options = {}) {
  const enabled = options.enabled === true;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const eventsPath = options.eventsPath ? normalizePath(options.eventsPath) : null;
  const warn = typeof options.onWarn === 'function'
    ? options.onWarn
    : message => console.warn(`[sdw-orch diagnostics] ${message}`);

  const events = [];
  let degraded = false;
  let capped = false;
  let capWarned = false;

  // Spec 00033 AC11: an append-only file may already hold events from earlier
  // passes of this run, so the budget counts them before the first new event.
  // A read failure starts the budget from zero; the append already reports a
  // degraded recorder when it cannot write.
  let persistedEventCount = 0;
  if (enabled && eventsPath) {
    try {
      const absolutePath = path.resolve(targetRoot, eventsPath);
      if (fs.existsSync(absolutePath)) {
        persistedEventCount = fs.readFileSync(absolutePath, 'utf8')
          .split(/\r?\n/)
          .filter(line => line.trim() !== '')
          .length;
      }
    } catch (e) {
      // Best-effort budget accounting only.
    }
  }
  if (persistedEventCount >= MAX_EVENTS) capped = true;

  function warnOnce(message) {
    if (degraded) return;
    degraded = true;
    try {
      warn(message);
    } catch (e) {
      // A broken warning sink must not break delivery either.
    }
  }

  // Spec 00033 AC11: hitting the event cap warns exactly once, then the
  // recorder silently drops later events so a noisy run stops writing.
  function warnCapOnce() {
    if (capWarned) return;
    capWarned = true;
    try {
      warn(`diagnostics budget reached: stopped recording after ${MAX_EVENTS} events (${MAX_EVENTS}-event cap).`);
    } catch (e) {
      // A broken warning sink must not break delivery.
    }
  }

  function append(event) {
    if (!eventsPath) return;
    try {
      const absolutePath = path.resolve(targetRoot, eventsPath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.appendFileSync(absolutePath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      warnOnce(`diagnostics degraded: ${err.message}; the run continues without an event file.`);
    }
  }

  // Event schema (spec 00033): { ts, step, kind, command, exitCode, snippet,
  // attempt, note }. Fields that do not apply stay absent instead of null.
  function record(kind, fields = {}) {
    if (!enabled) return null;
    if (typeof kind !== 'string' || kind.trim() === '') return null;
    // Spec 00033 AC11: the budget is hard. Once the cap is reached every later
    // event is dropped, and the one warning explains why the file stops growing.
    if (persistedEventCount + events.length >= MAX_EVENTS) {
      capped = true;
      warnCapOnce();
      return null;
    }
    try {
      const event = { ts: clock().toISOString(), kind };
      if (fields.step !== undefined && fields.step !== null) event.step = fields.step;
      if (fields.command !== undefined && fields.command !== null) event.command = fields.command;
      if (fields.exitCode !== undefined && fields.exitCode !== null) event.exitCode = fields.exitCode;
      if (fields.snippet !== undefined) event.snippet = boundSnippet(fields.snippet);
      if (fields.attempt !== undefined && fields.attempt !== null) event.attempt = fields.attempt;
      if (fields.note !== undefined && fields.note !== null) event.note = fields.note;
      events.push(event);
      append(event);
      return event;
    } catch (err) {
      warnOnce(`diagnostics degraded: ${err.message}; the run continues without an event file.`);
      return null;
    }
  }

  // AC3: a step transition carries the step number and what changed ('enter',
  // 'done', or any later status) plus an ISO timestamp on every event.
  function recordStepTransition(fields = {}) {
    return record('step_transition', {
      step: fields.step,
      note: fields.transition !== undefined ? fields.transition : fields.note
    });
  }

  // AC4: a failed tool execution keeps its exit code and a bounded stderr
  // snippet. The bounding lives here so every caller gets the same cap.
  function recordToolFailure(fields = {}) {
    const stderr = fields.stderr !== undefined && fields.stderr !== null
      ? fields.stderr
      : (fields.snippet !== undefined ? fields.snippet : '');
    return record('tool_failure', {
      step: fields.step,
      command: fields.command,
      exitCode: fields.exitCode,
      snippet: stderr,
      note: fields.note
    });
  }

  // Spec 00033 AC5: a script that exits non-zero keeps the exact command and a
  // bounded excerpt of its combined output. The excerpt is taken from the
  // start, so the first failure line always survives the cap.
  function recordScriptFailure(fields = {}) {
    const output = fields.output !== undefined && fields.output !== null
      ? fields.output
      : (fields.snippet !== undefined ? fields.snippet : '');
    return record('script_failure', {
      step: fields.step,
      command: fields.command,
      exitCode: fields.exitCode,
      snippet: output,
      note: fields.note
    });
  }

  // Spec 00033 AC7: a retry loop counts its attempts on every event, so a run
  // report can tell a first failure from a repeated one.
  function recordRetry(fields = {}) {
    return record('retry', {
      step: fields.step,
      command: fields.command,
      attempt: fields.attempt,
      note: fields.note
    });
  }

  // Spec 00033 AC7: fallback usage is an event too, because a run that stops
  // retrying is where the upstream defect usually shows up.
  function recordFallback(fields = {}) {
    return record('fallback', {
      step: fields.step,
      command: fields.command,
      attempt: fields.attempt,
      note: fields.note
    });
  }

  return {
    enabled,
    eventsPath,
    maxEvents: MAX_EVENTS,
    record,
    recordStepTransition,
    recordToolFailure,
    recordScriptFailure,
    recordRetry,
    recordFallback,
    getEvents: () => events.slice(),
    isDegraded: () => degraded,
    isCapped: () => capped
  };
}

// Spec 00033 AC6/AC8: the event file is the report source. Unreadable files and
// torn lines are skipped, so one bad write never hides the rest of the run.
function readEvents(eventsPath, targetRoot) {
  const events = [];
  if (!eventsPath) return events;
  try {
    const absolutePath = path.resolve(targetRoot ? path.resolve(targetRoot) : process.cwd(), eventsPath);
    if (!fs.existsSync(absolutePath)) return events;
    const content = fs.readFileSync(absolutePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event && typeof event === 'object' && typeof event.kind === 'string') events.push(event);
      } catch (e) {
        // A torn or foreign line is skipped; the remaining events still render.
      }
    }
  } catch (e) {
    // A missing or unreadable file renders an empty report, never a throw.
  }
  return events;
}

function escapeTableCell(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

function describeEvidence(event) {
  const parts = [String(event.kind)];
  if (event.command) parts.push(escapeTableCell(event.command));
  if (event.exitCode !== undefined && event.exitCode !== null) parts.push(`exit ${event.exitCode}`);
  if (event.attempt !== undefined && event.attempt !== null) parts.push(`attempt ${event.attempt}`);
  if (event.note) parts.push(escapeTableCell(event.note));
  const snippet = escapeTableCell(boundSnippet(event.snippet, MAX_EVIDENCE_CHARS));
  if (snippet) parts.push(snippet);
  return parts.join('; ');
}

/**
 * Spec 00033 AC9: where the event stream shows follow-up work, the report
 * proposes one issue spec draft with a title and a rationale.
 *
 * The proposal is report content only. Nothing here writes a file, so a spec is
 * created under `.sdw/specs/` only after an explicit `sdw-spec new` order.
 * Returns null when the run recorded no issue event.
 */
function buildFollowUpProposal(options = {}) {
  const events = Array.isArray(options.events) ? options.events : [];
  const issues = events.filter(event => ISSUE_SEVERITIES[event.kind]);
  if (issues.length === 0) return null;
  const slug = options.slug ? String(options.slug) : 'run';
  const errorCount = issues.filter(event => ISSUE_SEVERITIES[event.kind] === 'error').length;
  const warningCount = issues.length - errorCount;
  const issueKinds = [...new Set(issues.map(event => event.kind))].sort();
  const steps = [...new Set(issues
    .map(event => event.step)
    .filter(step => step !== undefined && step !== null)
    .map(step => String(step)))]
    .sort((a, b) => Number(a) - Number(b));
  return {
    title: `Fix upstream defects found by diagnostic run ${slug}`,
    rationale: `${issues.length} issue event(s) across step(s) ${steps.length > 0 ? steps.join(', ') : 'unknown'} `
      + `(${errorCount} error(s), ${warningCount} warning(s); kinds: ${issueKinds.join(', ')}). `
      + 'Delivery continued, so the defects are contained; this draft proposes an explicit follow-up spec to fix them.',
    proposedOnly: 'Proposed only: no file was created under `.sdw/specs/`. Create it with `sdw-spec new` after an explicit order.'
  };
}

/**
 * Spec 00033 AC8: the Markdown run report.
 *
 * The renderer reads only the event list plus the run metadata passed in, so
 * the same `diagnostics.jsonl` always produces byte-identical Markdown. The
 * issue table maps every failure, retry, fallback, and repair event to a fixed
 * severity with its step and evidence.
 */
function renderReport(options = {}) {
  const events = Array.isArray(options.events) ? options.events : [];
  const slug = options.slug ? String(options.slug) : 'run';
  const runId = options.runId ? String(options.runId) : '(unknown)';
  const status = options.status ? String(options.status) : 'unknown';
  const eventBytes = Number.isInteger(options.eventBytes) ? options.eventBytes : eventsBytes(events);
  const capped = options.capped === true;

  const counts = new Map();
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) || 0) + 1);
  }
  const kinds = [...counts.keys()].sort();
  const lastTs = events.reduce(
    (latest, event) => (typeof event.ts === 'string' && event.ts > latest ? event.ts : latest),
    ''
  );
  const issues = events.filter(event => ISSUE_SEVERITIES[event.kind]);

  const lines = [];
  lines.push(`# Diagnostics report: ${slug}`, '');
  lines.push('## Run summary', '');
  lines.push('| Field | Value |');
  lines.push('| ----- | ----- |');
  lines.push(`| Run | ${escapeTableCell(runId)} |`);
  lines.push(`| Specification | ${escapeTableCell(slug)} |`);
  lines.push(`| Status | ${escapeTableCell(status)} |`);
  lines.push(`| Started | ${escapeTableCell(options.startedAt || (events.length > 0 ? events[0].ts : null) || '-')} |`);
  lines.push(`| Completed | ${escapeTableCell(lastTs || '-')} |`);
  lines.push(`| Events | ${events.length} |`);
  lines.push(`| Event bytes | ${eventBytes} |`);
  // Spec 00033 AC11: the report states the overhead budget it stayed under, so
  // a reader can tell a short run from a capped one without opening the JSONL.
  lines.push(`| Overhead budget | max ${MAX_EVENTS} events, max ${MAX_SNIPPET_CHARS} chars per snippet |`);
  lines.push(`| Budget status | ${capped ? `cap reached; recording stopped at ${MAX_EVENTS} events` : 'within budget'} |`);
  if (options.eventsPath) {
    lines.push(`| Event file | ${escapeTableCell(options.eventsPath)} |`);
  }
  lines.push('', '### Events by kind', '');
  lines.push('| Kind | Count |');
  lines.push('| ---- | ----- |');
  if (kinds.length === 0) {
    lines.push('| - | 0 |');
  } else {
    for (const kind of kinds) {
      lines.push(`| ${escapeTableCell(kind)} | ${counts.get(kind)} |`);
    }
  }
  lines.push('', '## Issues', '');
  lines.push('| Severity | Step | Evidence |');
  lines.push('| -------- | ---- | -------- |');
  if (issues.length === 0) {
    lines.push('| - | - | No upstream issues detected. |');
  } else {
    for (const event of issues) {
      const step = event.step === undefined || event.step === null ? '-' : String(event.step);
      lines.push(`| ${ISSUE_SEVERITIES[event.kind]} | ${escapeTableCell(step)} | ${describeEvidence(event)} |`);
    }
  }
  // Spec 00033 AC9: follow-up work becomes one proposed issue spec draft. The
  // report only proposes it; creating the spec stays an explicit order.
  lines.push('', '## Suggested follow-up spec', '');
  const proposal = buildFollowUpProposal({ events, slug });
  if (!proposal) {
    lines.push('No follow-up spec proposed: no upstream issues detected.');
  } else {
    lines.push(proposal.proposedOnly, '');
    lines.push('| Field | Value |');
    lines.push('| ----- | ----- |');
    lines.push(`| Title | ${escapeTableCell(proposal.title)} |`);
    lines.push(`| Rationale | ${escapeTableCell(proposal.rationale)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Spec 00033 AC8: writes `{artifactsDir}/{slug}-diagnostics.md`.
 *
 * The write never throws: a missing directory or an unwritable path is
 * returned as `{ ok: false, error }`, so diagnostics can never fail delivery.
 * When `events` is not supplied, the report is rendered from the JSONL file.
 */
function writeReport(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const artifactsDir = options.artifactsDir && String(options.artifactsDir).trim()
    ? String(options.artifactsDir)
    : path.join('.sdw', 'state');
  const slug = options.slug ? String(options.slug) : 'run';
  const relPath = normalizePath(path.join(artifactsDir, `${slug}-diagnostics.md`));
  const absolutePath = path.resolve(targetRoot, relPath);
  const events = Array.isArray(options.events)
    ? options.events
    : readEvents(options.eventsPath, targetRoot);
  const markdown = renderReport({ ...options, slug, events });
  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, markdown, 'utf8');
    return { ok: true, path: relPath, eventCount: events.length, bytes: Buffer.byteLength(markdown, 'utf8') };
  } catch (err) {
    return { ok: false, path: relPath, error: err.message, eventCount: events.length };
  }
}

module.exports = {
  MAX_SNIPPET_CHARS,
  MAX_EVENTS,
  MAX_EVIDENCE_CHARS,
  DIAGNOSTICS_FILENAME,
  ISSUE_SEVERITIES,
  boundSnippet,
  eventsBytes,
  eventsPathFor,
  buildRunDiagnostic,
  createRecorder,
  readEvents,
  buildFollowUpProposal,
  renderReport,
  writeReport
};
