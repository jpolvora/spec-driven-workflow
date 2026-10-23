'use strict';

// Spec 00033 AC2: the diagnostic recorder is zero-dependency. It loads only
// Node.js built-ins (`fs`, `path`), never a package and never the network,
// so diagnostics add no install surface to consumers.
const fs = require('fs');
const path = require('path');

// Spec 00033 AC4: one event holds at most 500 characters of stderr, so a
// noisy tool can never inflate the diagnostics log with unbounded output.
const MAX_SNIPPET_CHARS = 500;
const DIAGNOSTICS_FILENAME = 'diagnostics.jsonl';

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

  function warnOnce(message) {
    if (degraded) return;
    degraded = true;
    try {
      warn(message);
    } catch (e) {
      // A broken warning sink must not break delivery either.
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

  return {
    enabled,
    eventsPath,
    record,
    recordStepTransition,
    recordToolFailure,
    getEvents: () => events.slice(),
    isDegraded: () => degraded
  };
}

module.exports = {
  MAX_SNIPPET_CHARS,
  DIAGNOSTICS_FILENAME,
  boundSnippet,
  eventsPathFor,
  buildRunDiagnostic,
  createRecorder
};
