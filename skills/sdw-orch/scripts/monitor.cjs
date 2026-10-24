'use strict';

// Spec 00021 AC4: the read-only run monitor. It projects run state (and the
// telemetry clock when present) into snapshots; it never creates or mutates
// state, the ledger, or telemetry. Zero-dependency: Node.js built-ins only.
const fs = require('fs');
const path = require('path');
const telemetry = require('./telemetry.cjs');

// Spec 00021 AC5/AC6: a run in one of these statuses has nothing left to watch.
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

// Spec 00021 AC6/AC5: documented defaults for the configurable stall window and
// watch interval. `.sdw/config.json` overrides them per workspace.
const DEFAULT_STALL_WINDOW_SECONDS = 900;
const DEFAULT_INTERVAL_SECONDS = 60;

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(String(status === undefined || status === null ? '' : status).toLowerCase());
}

function positiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// Spec 00021 AC4/AC6: read `.sdw/config.json` without initializing the layout.
// A missing or unreadable file is the empty configuration.
function readConfigObject(targetRoot) {
  try {
    const configFile = path.join(path.resolve(targetRoot || process.cwd()), '.sdw', 'config.json');
    if (!fs.existsSync(configFile)) return {};
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    return {};
  }
}

// Spec 00021 AC6: `monitor.stallWindowSeconds` configures the stall window;
// AC5: `monitor.intervalSeconds` configures the watch refresh interval.
function readMonitorConfig(targetRoot) {
  const raw = readConfigObject(targetRoot);
  const monitorConfig = raw && raw.monitor && typeof raw.monitor === 'object' && !Array.isArray(raw.monitor)
    ? raw.monitor
    : {};
  return {
    stallWindowSeconds: positiveNumber(monitorConfig.stallWindowSeconds) ?? DEFAULT_STALL_WINDOW_SECONDS,
    intervalSeconds: positiveNumber(monitorConfig.intervalSeconds) ?? DEFAULT_INTERVAL_SECONDS
  };
}

function resolveStallWindowMs(options, config) {
  const explicitMs = positiveNumber(options.stallWindowMs);
  if (explicitMs !== null) return explicitMs;
  const seconds = positiveNumber(options.stallWindowSeconds);
  return (seconds !== null ? seconds : config.stallWindowSeconds) * 1000;
}

function resolveIntervalMs(options, config) {
  const explicitMs = positiveNumber(options.intervalMs);
  if (explicitMs !== null) return explicitMs;
  const seconds = positiveNumber(options.intervalSeconds);
  return (seconds !== null ? seconds : config.intervalSeconds) * 1000;
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
 * `state_manager.resolveStateDir` mkdirs as a side effect, so the monitor uses
 * the same config loader for the path (so `{projectRoot}` and `{skillsRoot}` both
 * expand exactly as the writer expands them) and never initializes the layout.
 */
function resolveStateDirReadOnly(targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  let stateDir = path.join(root, '.sdw', 'state');
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    const config = sdwConfig.loadConfig(root);
    if (config && typeof config.stateDir === 'string' && config.stateDir.trim()) {
      stateDir = path.resolve(config.stateDir);
      return stateDir;
    }
  } catch (e) {
    // Fall through to the raw key: an unreadable configuration never breaks the
    // monitor, and the documented default layout stays the fallback.
  }
  try {
    const raw = readConfigObject(root);
    if (raw && typeof raw.stateDir === 'string' && raw.stateDir.trim()) {
      stateDir = path.resolve(root, raw.stateDir.trim().replace(/\{projectRoot\}/g, normalizePath(root)));
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
 * Spec 00021 AC6: the monitor classification. A non-terminal run whose newest
 * activity clock is older than the stall window is `stalled`; an explicit turn
 * pause is a handoff, not a hang, so it stays `paused`. A run exactly at the
 * window boundary is not yet stale because the rule is "older than".
 */
function classifyStatus(options) {
  if (isTerminalStatus(options.status)) return 'terminal';
  const stale = options.lastActivityMs === null || (options.nowMs - options.lastActivityMs) > options.stallWindowMs;
  if (!stale) return 'active';
  return String(options.status === undefined || options.status === null ? '' : options.status).toLowerCase() === 'paused'
    ? 'paused'
    : 'stalled';
}

/**
 * Spec 00021 AC4/AC6: one snapshot row. `ageSeconds` is the run age from
 * `createdAt` (falling back to `updatedAt` when a state file lacks it).
 * `lastActivityAt` is the newest of the state file mtime, `updatedAt`, and the
 * newest telemetry event; AC6 compares that clock with the stall window and
 * AC8 serializes the same fields the table shows.
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

  const lastEventMs = timestampMs(lastEventAt);
  const updatedAtMs = timestampMs(updatedAt);
  const stateMtimeMs = Number.isFinite(options.stateMtimeMs) ? options.stateMtimeMs : null;
  const activityClocks = [updatedAtMs, stateMtimeMs, lastEventMs].filter(ms => ms !== null);
  const lastActivityMs = activityClocks.length === 0 ? null : Math.max(...activityClocks);
  const stallWindowMs = positiveNumber(options.stallWindowMs) ?? (DEFAULT_STALL_WINDOW_SECONDS * 1000);

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
    lastActivityAt: lastActivityMs === null ? null : new Date(lastActivityMs).toISOString(),
    artifactsDir: state && state.artifactsDir ? normalizePath(state.artifactsDir) : null,
    stateFile: options.stateFile ? normalizePath(options.stateFile) : null,
    classification: classifyStatus({
      status: state && state.status ? String(state.status) : null,
      lastActivityMs,
      nowMs,
      stallWindowMs
    }),
    severity: null
  };
}

function listFilesRecursive(dir) {
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return files;
  }
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(absolutePath));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

/**
 * Spec 00021 AC7: an artifact directory that contains step files but has no
 * state file is still worth reporting. It is a warning while its newest
 * artifact (or telemetry event) is inside the stall window and info once older.
 */
function buildRunWithoutStateSnapshot(fields) {
  const ageMs = fields.lastActivityMs === null ? null : Math.max(0, fields.nowMs - fields.lastActivityMs);
  return {
    runId: fields.runId,
    specSlug: fields.specSlug,
    status: null,
    currentStep: null,
    totalSteps: null,
    stepName: null,
    stepStatus: null,
    createdAt: null,
    updatedAt: null,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    lastEventAt: fields.lastEventAt,
    lastActivityAt: fields.lastActivityMs === null ? null : new Date(fields.lastActivityMs).toISOString(),
    artifactsDir: fields.artifactsDir,
    stateFile: null,
    classification: 'run-without-state',
    severity: ageMs !== null && ageMs <= fields.stallWindowMs ? 'warning' : 'info'
  };
}

// Spec 00021 AC7: scan the documented `.sdw/state/{slug}/{runId}/` layout for
// artifact directories whose run has no `{runId}.state.json` beside them.
function discoverRunsWithoutState(stateDir, targetRoot, options) {
  const results = [];
  let slugEntries = [];
  try {
    slugEntries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const slugEntry of slugEntries) {
    if (!slugEntry.isDirectory()) continue;
    const slugDir = path.join(stateDir, slugEntry.name);
    let runEntries = [];
    try {
      runEntries = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory()) continue;
      if (options.runId && runEntry.name !== options.runId) continue;
      if (fs.existsSync(path.join(stateDir, `${runEntry.name}.state.json`))) continue;
      const artifactsAbs = path.join(slugDir, runEntry.name);
      const files = listFilesRecursive(artifactsAbs);
      if (files.length === 0) continue;

      let newestMtimeMs = null;
      for (const file of files) {
        try {
          const stat = fs.statSync(file);
          if (newestMtimeMs === null || stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
        } catch (e) {
          // A vanished artifact cannot be the newest clock.
        }
      }

      const artifactsRel = normalizePath(path.relative(targetRoot, artifactsAbs));
      const newestEventAt = newestEventTs(
        telemetry.readEvents(telemetry.telemetryPathFor(artifactsRel), targetRoot)
      );
      const eventMs = timestampMs(newestEventAt);
      const lastActivityMs = eventMs !== null && (newestMtimeMs === null || eventMs > newestMtimeMs)
        ? eventMs
        : newestMtimeMs;

      results.push(buildRunWithoutStateSnapshot({
        runId: runEntry.name,
        specSlug: slugEntry.name,
        artifactsDir: artifactsRel,
        lastEventAt: newestEventAt,
        lastActivityMs,
        nowMs: options.nowMs,
        stallWindowMs: options.stallWindowMs
      }));
    }
  }
  return results;
}

/**
 * Spec 00021 AC4/AC6/AC7: discover every run state under the configured state
 * directory plus artifact directories that have no state, and project each one.
 * Reads only; a corrupt state file is named in the error so the operator can
 * fix or discard it.
 */
function discoverRuns(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const stateDir = resolveStateDirReadOnly(targetRoot);
  const nowMs = resolveNowMs(options.now);
  const stallWindowMs = resolveStallWindowMs(options, readMonitorConfig(targetRoot));
  const runs = [];

  let names = [];
  if (fs.existsSync(stateDir)) {
    names = fs.readdirSync(stateDir).filter(name => name.endsWith('.state.json')).sort();
  }

  for (const name of names) {
    const stateFileAbs = path.join(stateDir, name);
    let state;
    let stateMtimeMs = null;
    try {
      state = JSON.parse(fs.readFileSync(stateFileAbs, 'utf8'));
      stateMtimeMs = fs.statSync(stateFileAbs).mtimeMs;
    } catch (err) {
      throw new Error(`cannot read run state "${normalizePath(path.relative(targetRoot, stateFileAbs))}": ${err.message}`);
    }
    if (options.runId && state.runId !== options.runId) continue;
    runs.push(buildSnapshot(state, {
      now: nowMs,
      targetRoot,
      stateFile: path.relative(targetRoot, stateFileAbs),
      stateMtimeMs,
      stallWindowMs
    }));
  }

  runs.sort((a, b) => {
    const aMs = timestampMs(a.updatedAt) || timestampMs(a.createdAt) || 0;
    const bMs = timestampMs(b.updatedAt) || timestampMs(b.createdAt) || 0;
    return (bMs - aMs) || String(a.runId).localeCompare(String(b.runId));
  });

  const withoutState = discoverRunsWithoutState(stateDir, targetRoot, {
    runId: options.runId || null,
    nowMs,
    stallWindowMs
  });

  return {
    stateDir: normalizePath(path.relative(targetRoot, stateDir)) || '.',
    stallWindowSeconds: Math.round(stallWindowMs / 1000),
    runs: [...runs, ...withoutState]
  };
}

// Spec 00021 AC4: the monitor lists active runs; terminal runs are history.
// Artifact-only entries are always listed because they have no status to resolve.
function listActiveRuns(options = {}) {
  const discovered = discoverRuns(options);
  return {
    stateDir: discovered.stateDir,
    stallWindowSeconds: discovered.stallWindowSeconds,
    runs: discovered.runs.filter(run => !isTerminalStatus(run.status))
  };
}

function cell(value) {
  const text = value === undefined || value === null ? '-' : String(value);
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '-';
}

/**
 * Spec 00021 AC4/AC6/AC7/AC8: the table. `--json` serializes the same snapshot
 * object, so the two outputs cannot drift. Only terminal runs are filtered out
 * before rendering; the classification cell carries `stalled`, `paused`, and
 * `run-without-state` signals.
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
  lines.push('| Run | Spec | Status | Step | Age | Classification |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const run of runs) {
    const step = run.currentStep === null
      ? '-'
      : `${run.currentStep}/${run.totalSteps === null ? '?' : run.totalSteps}${run.stepName ? ` ${run.stepName}` : ''}`;
    lines.push(`| ${cell(run.runId)} | ${cell(run.specSlug)} | ${cell(run.status)} | ${cell(step)} | ${formatAge(run.ageSeconds)} | ${cell(run.classification)} |`);
  }
  return lines.join('\n');
}

// Spec 00021 AC13: aggregate every run's append-only stream by event, step, and
// status. Discovery and reading reuse the monitor's read-only helpers, so a
// report can never create or rewrite state, telemetry, or the acceptance ledger.
function buildTelemetryReport(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const stateDir = resolveStateDirReadOnly(targetRoot);
  const groups = new Map();
  let runs = 0;
  let events = 0;

  const addRunDir = runDir => {
    const artifactsRel = normalizePath(path.relative(targetRoot, runDir));
    const stream = telemetry.readEvents(telemetry.telemetryPathFor(artifactsRel), targetRoot);
    let counted = 0;
    for (const event of stream) {
      if (!Number.isInteger(event.step)) continue;
      if (typeof event.status !== 'string' || event.status === '') continue;
      const eventName = String(event.event || '');
      const key = `${eventName}|${event.step}|${event.status}`;
      const group = groups.get(key) || {
        event: eventName,
        step: event.step,
        stepName: null,
        status: event.status,
        count: 0
      };
      if (!group.stepName && event.stepName) group.stepName = String(event.stepName);
      group.count++;
      groups.set(key, group);
      counted++;
    }
    if (counted > 0) {
      runs++;
      events += counted;
    }
  };

  let slugEntries = [];
  try {
    slugEntries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (e) {
    slugEntries = [];
  }
  for (const slugEntry of slugEntries) {
    if (!slugEntry.isDirectory()) continue;
    const slugDir = path.join(stateDir, slugEntry.name);
    let runEntries = [];
    try {
      runEntries = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory()) continue;
      if (options.runId && runEntry.name !== options.runId) continue;
      const runDir = path.join(slugDir, runEntry.name);
      if (!fs.existsSync(path.join(runDir, telemetry.TELEMETRY_FILENAME))) continue;
      addRunDir(runDir);
    }
  }

  const rows = [...groups.values()].sort((a, b) =>
    (a.step - b.step) || a.event.localeCompare(b.event) || a.status.localeCompare(b.status));
  return {
    stateDir: normalizePath(path.relative(targetRoot, stateDir)) || '.',
    runs,
    events,
    rows
  };
}

/**
 * Spec 00021 AC13/AC8: the report table. `--json` serializes the same aggregation
 * object, so the table and the machine-readable output cannot drift.
 */
function renderTelemetryReport(report = {}) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const lines = [
    'SDW Orchestrator Telemetry Report',
    '=================================',
    `State: ${report.stateDir ? String(report.stateDir) : path.join('.sdw', 'state')}`,
    `Runs: ${Number.isInteger(report.runs) ? report.runs : 0} | Events: ${Number.isInteger(report.events) ? report.events : 0}`
  ];
  if (rows.length === 0) {
    lines.push('', 'No telemetry events.');
    return lines.join('\n');
  }
  lines.push('', '| Step | Event | Status | Count |', '| --- | --- | --- | --- |');
  for (const row of rows) {
    const step = `${row.step}${row.stepName ? ` ${row.stepName}` : ''}`;
    lines.push(`| ${cell(step)} | ${cell(row.event)} | ${cell(row.status)} | ${row.count} |`);
  }
  return lines.join('\n');
}

// Spec 00021 AC5: block between refreshes. `Atomics.wait` keeps the watch loop
// synchronous for the CLI; tests inject a no-op or a state-advancing sleep.
function defaultSleep(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function watchComplete(snapshot, scoped) {
  if (!scoped) {
    return !snapshot.runs.some(run => run.status !== null && !isTerminalStatus(run.status));
  }
  if (snapshot.runs.length === 0) return true;
  return snapshot.runs.every(run => run.classification === 'run-without-state' || isTerminalStatus(run.status));
}

/**
 * Spec 00021 AC5: refresh the snapshot until the scoped run is terminal. The
 * sleep and the clock are injectable so tests run instantly; `onSnapshot` is
 * called once per refresh (the CLI prints it). Read-only: every refresh is a
 * fresh discovery, never a state, ledger, or telemetry write.
 */
function watchMonitor(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const scoped = Boolean(options.runId);
  const intervalMs = resolveIntervalMs(options, readMonitorConfig(targetRoot));
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const onSnapshot = typeof options.onSnapshot === 'function' ? options.onSnapshot : null;
  const readSnapshot = () => {
    const discovered = scoped
      ? discoverRuns({ ...options, targetRoot })
      : listActiveRuns({ ...options, targetRoot });
    return {
      stateDir: discovered.stateDir,
      stallWindowSeconds: discovered.stallWindowSeconds,
      runs: discovered.runs
    };
  };

  let snapshot = readSnapshot();
  let poll = 0;
  while (true) {
    poll += 1;
    if (onSnapshot) onSnapshot(snapshot, poll);
    if (watchComplete(snapshot, scoped)) return snapshot;
    sleep(intervalMs);
    snapshot = readSnapshot();
  }
}

module.exports = {
  TERMINAL_STATUSES,
  DEFAULT_STALL_WINDOW_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
  isTerminalStatus,
  readMonitorConfig,
  resolveStateDirReadOnly,
  formatAge,
  buildSnapshot,
  discoverRuns,
  listActiveRuns,
  buildTelemetryReport,
  renderTelemetryReport,
  renderMonitor,
  watchMonitor
};
