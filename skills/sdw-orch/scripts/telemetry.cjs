'use strict';

// Spec 00021 AC1-AC3: the append-only telemetry stream. The module is
// zero-dependency (Node.js built-ins only) and every write failure is returned
// as a value, never thrown: observability must never fail a step.
const fs = require('fs');
const path = require('path');

// Spec 00021 AC2: one JSONL file per run, beside the run state and artifacts.
const TELEMETRY_FILENAME = 'telemetry.jsonl';

// Spec 00021: the event names the whole specification uses. One writer and one
// reader serve every kind, so a later dispatch, gate, checkpoint, or run-level
// event is a constructor call, not a new file format.
const EVENT_NAMES = {
  RUN_STARTED: 'run_started',
  STEP: 'step',
  DISPATCH: 'dispatch',
  GATE: 'gate',
  CHECKPOINT: 'checkpoint',
  TURN_PAUSED: 'turn_paused',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed'
};

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

// `{artifactsDir}/telemetry.jsonl`, project-relative so the recorded path never
// depends on the machine that ran it.
function telemetryPathFor(artifactsDir) {
  const dir = artifactsDir && String(artifactsDir).trim() ? String(artifactsDir) : path.join('.sdw', 'state');
  return normalizePath(path.join(dir, TELEMETRY_FILENAME));
}

// An explicit timestamp is normalized to ISO; an absent or invalid one falls
// back to the clock so every event still carries a parseable `ts`.
function normalizeTs(value, fallback) {
  if (value !== undefined && value !== null && value !== '') {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback;
}

/**
 * Spec 00021 AC3: one JSONL event.
 *
 * Field order mirrors the documented schema: `ts`, `runId`, `specSlug`,
 * `event`, then the optional `step`, `stepName`, `status`, and `durationMs`.
 * A step event always carries `durationMs`; it is null while the step is
 * running, which is exactly how a reader distinguishes an open step from a
 * finished one.
 */
function buildEvent(fields = {}) {
  const event = {
    ts: normalizeTs(fields.ts, new Date().toISOString()),
    runId: fields.runId === undefined || fields.runId === null ? null : String(fields.runId),
    specSlug: fields.specSlug === undefined || fields.specSlug === null ? null : String(fields.specSlug),
    event: fields.event === undefined || fields.event === null ? '' : String(fields.event)
  };
  if (fields.step !== undefined && fields.step !== null && fields.step !== '') {
    const step = Number(fields.step);
    if (Number.isFinite(step)) event.step = step;
  }
  if (fields.stepName !== undefined && fields.stepName !== null) event.stepName = String(fields.stepName);
  if (fields.status !== undefined && fields.status !== null) event.status = String(fields.status);
  if (fields.durationMs !== undefined) {
    const durationMs = fields.durationMs === null ? null : Number(fields.durationMs);
    event.durationMs = durationMs !== null && Number.isFinite(durationMs) && durationMs >= 0
      ? Math.round(durationMs)
      : null;
  }
  return event;
}

// Spec 00021 AC3: a step duration comes from the step's own startedAt and
// completedAt. A step that has not completed yet has no duration, so it is null.
function durationBetween(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(String(startedAt));
  const end = Date.parse(String(completedAt));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function timestampMs(value) {
  const parsed = Date.parse(String(value === undefined || value === null ? '' : value));
  return Number.isFinite(parsed) ? parsed : null;
}

// Spec 00021 AC3: the newest entry event for this step in the append-only
// stream. It is the start time a resumed run or a step whose state never
// recorded `startedAt` (a skipped step, or a command-mode step) still has.
function latestStepEnterMs(telemetryPath, targetRoot, step) {
  let latest = null;
  for (const event of readEvents(telemetryPath, targetRoot)) {
    if (event.event !== EVENT_NAMES.STEP) continue;
    if (Number(event.step) !== Number(step)) continue;
    if (event.status !== 'in_progress') continue;
    const ms = timestampMs(event.ts);
    if (ms === null) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

/**
 * Spec 00021 AC3: the duration of a finished step transition.
 *
 * `startedAt`/`completedAt` on the run state are the source of truth. When a
 * step never recorded a start, the entry event already appended for this run
 * supplies it, so a resumed or skipped transition still reports a real number
 * instead of a misleading null. A step with no completion timestamp is still
 * running, so its duration stays null.
 */
function stepDuration(options = {}) {
  const stepState = options.stepState || null;
  const fromState = durationBetween(stepState && stepState.startedAt, stepState && stepState.completedAt);
  if (fromState !== null) return fromState;
  const completedMs = timestampMs(stepState && stepState.completedAt);
  if (completedMs === null) return null;
  const startedMs = latestStepEnterMs(options.telemetryPath, options.targetRoot, options.step);
  if (startedMs === null || completedMs < startedMs) return null;
  return completedMs - startedMs;
}

function buildStepEvent(fields = {}) {
  return buildEvent({
    ...fields,
    event: EVENT_NAMES.STEP,
    durationMs: fields.durationMs === undefined ? null : fields.durationMs
  });
}

// Spec 00021 AC10: a step transition's identity is (runId, step, status).
function stepStatusKey(runId, step, status) {
  return `${String(runId)}|${Number(step)}|${String(status)}`;
}

/**
 * Spec 00021 AC1-AC2: the append-only writer.
 *
 * `record` and `recordStep` build one event and append one line, in that order.
 * Nothing is ever truncated or rewritten, so a resumed run keeps every prior
 * event. A failed append returns null and turns the writer degraded; it never
 * throws and never fails the calling step (AC12 owns the operator-facing
 * warning, so the default sink is silent).
 *
 * Spec 00021 AC10: a step event whose (runId, step, status) identity already
 * exists in the append-only stream is a replay of a transition the stream
 * already holds. It appends nothing and returns null without degrading the
 * writer.
 */
function createWriter(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const runId = options.runId === undefined || options.runId === null ? null : String(options.runId);
  const specSlug = options.specSlug === undefined || options.specSlug === null ? null : String(options.specSlug);
  const telemetryPath = options.telemetryPath ? normalizePath(options.telemetryPath) : null;
  const warn = typeof options.onWarn === 'function' ? options.onWarn : null;

  let degraded = false;
  let lastError = null;
  // AC10: the step-transition identities already in the stream, seeded lazily
  // from the existing file so a resumed run recognizes its prior transitions.
  const recordedStepStatuses = new Set();
  let recordedStepStatusesLoaded = false;

  function loadRecordedStepStatuses() {
    if (recordedStepStatusesLoaded) return;
    recordedStepStatusesLoaded = true;
    for (const existing of readEvents(telemetryPath, targetRoot)) {
      if (!existing || existing.event !== EVENT_NAMES.STEP) continue;
      if (existing.runId === undefined || existing.runId === null) continue;
      if (existing.step === undefined || existing.step === null) continue;
      recordedStepStatuses.add(stepStatusKey(existing.runId, existing.step, existing.status));
    }
  }

  // AC10: replaying a recorded transition is a no-op, while a status the stream
  // does not hold yet (for example completed after in_progress) is new.
  function isRecordedStep(event) {
    if (event.event !== EVENT_NAMES.STEP) return false;
    if (event.runId === null || event.step === undefined) return false;
    loadRecordedStepStatuses();
    return recordedStepStatuses.has(stepStatusKey(event.runId, event.step, event.status));
  }

  function degrade(message) {
    lastError = message;
    if (degraded) return;
    degraded = true;
    if (!warn) return;
    try {
      warn(message);
    } catch (e) {
      // A broken warning sink must not fail a step either.
    }
  }

  function record(fields = {}) {
    if (!telemetryPath) {
      degrade('telemetry path is not configured; the run continues without an event file.');
      return null;
    }
    try {
      const event = buildEvent({
        ...fields,
        ts: fields.ts === undefined ? clock().toISOString() : fields.ts,
        runId: fields.runId === undefined ? runId : fields.runId,
        specSlug: fields.specSlug === undefined ? specSlug : fields.specSlug
      });
      if (isRecordedStep(event)) return null;
      const absolutePath = path.resolve(targetRoot, telemetryPath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.appendFileSync(absolutePath, `${JSON.stringify(event)}\n`, 'utf8');
      if (event.event === EVENT_NAMES.STEP) {
        recordedStepStatuses.add(stepStatusKey(event.runId, event.step, event.status));
      }
      return event;
    } catch (err) {
      degrade(`telemetry append failed: ${err.message}; the run continues without an event.`);
      return null;
    }
  }

  // Spec 00021 AC1/AC3: one call per step transition. The caller supplies the
  // step, its name, the transition status, and the duration it derived from
  // state; the writer owns the JSONL shape and the failure policy.
  function recordStep(fields = {}) {
    if (!fields || fields.step === undefined || fields.step === null) return null;
    return record({
      event: EVENT_NAMES.STEP,
      step: fields.step,
      stepName: fields.stepName,
      status: fields.status,
      durationMs: fields.durationMs === undefined ? null : fields.durationMs
    });
  }

  return {
    telemetryPath,
    record,
    recordStep,
    isDegraded: () => degraded,
    lastError: () => lastError
  };
}

/**
 * Spec 00021: the reader used by the monitor and by later aggregation. Torn or
 * foreign lines are skipped, so one interrupted write never hides the rest of
 * the stream. A missing or unreadable file reads as zero events.
 */
function readEvents(telemetryPath, targetRoot) {
  const events = [];
  if (!telemetryPath) return events;
  try {
    const absolutePath = path.resolve(targetRoot ? path.resolve(targetRoot) : process.cwd(), telemetryPath);
    if (!fs.existsSync(absolutePath)) return events;
    for (const line of fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
      } catch (e) {
        // A torn or foreign line is skipped; the remaining events still read.
      }
    }
  } catch (e) {
    // A missing or unreadable file reads as no events, never a throw.
  }
  return events;
}

module.exports = {
  TELEMETRY_FILENAME,
  EVENT_NAMES,
  telemetryPathFor,
  buildEvent,
  buildStepEvent,
  durationBetween,
  stepDuration,
  createWriter,
  readEvents
};
