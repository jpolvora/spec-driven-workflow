'use strict';

// Spec 00021 AC4: the read-only run monitor. It projects run state (and the
// telemetry clock when present) into snapshots; it never creates or mutates
// state, the ledger, or telemetry. Zero-dependency: Node.js built-ins only.
const fs = require('fs');
const path = require('path');
const telemetry = require('./telemetry.cjs');

// Spec 00021 AC5/AC6: a run in one of these statuses has nothing left to watch.
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(String(status === undefined || status === null ? '' : status).toLowerCase());
}

function timestampMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// `now` accepts a Date, an ISO string, an epoch millisecond number, a function
// returning one of those, or nothing (the wall clock). Tests inject it so an
// age is exact instead of timing-dependent.
function resolveNowMs(now) {
  let value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && timestampMs(value) !== null) return timestampMs(value);
  return Date.now();
}

/**
 * Spec 00021 AC4: resolve the state directory without creating it.
 *
 * `state_manager.resolveStateDir` mkdirs as a side effect, so the monitor reads
 * the configured `stateDir` key itself and never initializes the layout.
 */
function resolveStateDirReadOnly(targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  let stateDir = path.join(root, '.sdw', 'state');
  try {
    const configFile = path.join(root, '.sdw', 'config.json');
    if (fs.existsSync(configFile)) {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (raw && typeof raw.stateDir === 'string' && raw.stateDir.trim()) {
        stateDir = path.resolve(root, raw.stateDir.trim().replace(/\{projectRoot\}/g, normalizePath(root)));
      }
    }
  } catch (e) {
    // An unreadable configuration keeps the documented default layout.
  }
  return stateDir;
}

// Spec 00021 AC4: a human age from the run's created timestamp. Minutes,
// hours, and days stay compact so one snapshot row fits on one line.
function formatAge(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  const total = Math.floor(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return '-';
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 === 0 ? `${minutes}m` : `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

function newestEventTs(events) {
  let newest = null;
  for (const event of events) {
    const ms = timestampMs(event && event.ts);
    if (ms === null) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

/**
 * Spec 00021 AC4: one snapshot row. `ageSeconds` is the run age from
 * `createdAt` (falling back to `updatedAt` when a state file lacks it); the raw
 * timestamps stay in the snapshot so `--json` and stall classification can be
 * added later without changing this projection.
 */
function buildSnapshot(state, options = {}) {
  const nowMs = resolveNowMs(options.now);
  const currentStep = Number.isInteger(state && state.currentStep) ? state.currentStep : null;
  const stepState = currentStep !== null && state.steps ? state.steps[currentStep] : null;
  const createdAt = state && state.createdAt ? String(state.createdAt) : null;
  const updatedAt = state && state.updatedAt ? String(state.updatedAt) : null;
  const ageFrom = timestampMs(createdAt) !== null ? createdAt : updatedAt;
  const ageStart = timestampMs(ageFrom);

  let lastEventAt = null;
  try {
    const artifactsDir = state && state.artifactsDir
      ? String(state.artifactsDir)
      : (state && state.specSlug && state.runId
        ? path.join('.sdw', 'state', state.specSlug, state.runId)
        : null);
    if (artifactsDir) {
      lastEventAt = newestEventTs(
        telemetry.readEvents(telemetry.telemetryPathFor(artifactsDir), options.targetRoot)
      );
    }
  } catch (e) {
    // Telemetry is a clock hint only; its absence never hides the run.
  }

  return {
    runId: state && state.runId ? String(state.runId) : null,
    specSlug: state && state.specSlug ? String(state.specSlug) : null,
    status: state && state.status ? String(state.status) : null,
    currentStep,
    totalSteps: Number.isInteger(state && state.totalSteps) ? state.totalSteps : null,
    stepName: stepState && stepState.name ? String(stepState.name) : null,
    stepStatus: stepState && stepState.status ? String(stepState.status) : null,
    createdAt,
    updatedAt,
    ageSeconds: ageStart === null ? null : Math.max(0, Math.round((nowMs - ageStart) / 1000)),
    lastEventAt,
    artifactsDir: state && state.artifactsDir ? normalizePath(state.artifactsDir) : null,
    stateFile: options.stateFile ? normalizePath(options.stateFile) : null
  };
}

/**
 * Spec 00021 AC4: discover every run state under the configured state
 * directory and project each one. Reads only; a corrupt state file is named in
 * the error so the operator can fix or discard it.
 */
function discoverRuns(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const stateDir = resolveStateDirReadOnly(targetRoot);
  const nowMs = resolveNowMs(options.now);
  const runs = [];

  let names = [];
  if (fs.existsSync(stateDir)) {
    names = fs.readdirSync(stateDir).filter(name => name.endsWith('.state.json')).sort();
  }

  for (const name of names) {
    const stateFileAbs = path.join(stateDir, name);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFileAbs, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read run state "${normalizePath(path.relative(targetRoot, stateFileAbs))}": ${err.message}`);
    }
    if (options.runId && state.runId !== options.runId) continue;
    runs.push(buildSnapshot(state, {
      now: nowMs,
      targetRoot,
      stateFile: path.relative(targetRoot, stateFileAbs)
    }));
  }

  runs.sort((a, b) => {
    const aMs = timestampMs(a.updatedAt) || timestampMs(a.createdAt) || 0;
    const bMs = timestampMs(b.updatedAt) || timestampMs(b.createdAt) || 0;
    return (bMs - aMs) || String(a.runId).localeCompare(String(b.runId));
  });

  return {
    stateDir: normalizePath(path.relative(targetRoot, stateDir)) || '.',
    runs
  };
}

// Spec 00021 AC4: the monitor lists active runs; terminal runs are history.
function listActiveRuns(options = {}) {
  const discovered = discoverRuns(options);
  return {
    stateDir: discovered.stateDir,
    runs: discovered.runs.filter(run => !isTerminalStatus(run.status))
  };
}

function cell(value) {
  const text = value === undefined || value === null ? '-' : String(value);
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '-';
}

/**
 * Spec 00021 AC4: the table. `--json` (AC8) can reuse `listActiveRuns` and
 * serialize the same fields, so the two outputs cannot drift.
 */
function renderMonitor(snapshot = {}) {
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const stateDir = snapshot.stateDir ? String(snapshot.stateDir) : path.join('.sdw', 'state');
  const lines = [
    'SDW Orchestrator Monitor',
    '========================',
    `State: ${stateDir}`
  ];
  if (runs.length === 0) {
    lines.push('Active runs: 0', '', 'No active runs.');
    return lines.join('\n');
  }
  lines.push(`Active runs: ${runs.length}`, '');
  lines.push('| Run | Spec | Status | Step | Age |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const run of runs) {
    const step = run.currentStep === null
      ? '-'
      : `${run.currentStep}/${run.totalSteps === null ? '?' : run.totalSteps}${run.stepName ? ` ${run.stepName}` : ''}`;
    lines.push(`| ${cell(run.runId)} | ${cell(run.specSlug)} | ${cell(run.status)} | ${cell(step)} | ${formatAge(run.ageSeconds)} |`);
  }
  return lines.join('\n');
}

module.exports = {
  TERMINAL_STATUSES,
  isTerminalStatus,
  resolveStateDirReadOnly,
  formatAge,
  buildSnapshot,
  discoverRuns,
  listActiveRuns,
  renderMonitor
};
