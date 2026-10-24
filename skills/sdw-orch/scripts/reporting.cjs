'use strict';

// Spec 00023 AC1-AC4: read-only delivery reporting. Every value is a projection
// of existing evidence (run state, run artifacts, telemetry, git history, and
// the specification index); nothing is inferred and nothing is written. The
// module never initializes the state directory, the acceptance ledger, or a
// telemetry stream. `now`, `git`, and `provider` are injectable so tests never
// depend on the wall clock, a real repository, or a network provider.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const telemetry = require('./telemetry.cjs');
const monitor = require('./monitor.cjs');

// Spec 00023 AC4: `report standup --hours 36` is the documented default window.
const DEFAULT_STANDUP_HOURS = 36;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizePath(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\\/g, '/');
}

function timestampMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoAt(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

// Same clock contract as the monitor: a Date, an ISO string, epoch
// milliseconds, a function returning one of those, or the wall clock.
function resolveNowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && timestampMs(value) !== null) return timestampMs(value);
  return Date.now();
}

// AC1: `--date` is a calendar day. Parsing is UTC-based so a report is
// deterministic across time zones; a non-existent day such as 2026-02-30 is
// rejected instead of being normalized into March.
function parseReportDate(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!DATE_PATTERN.test(text)) return null;
  const ms = timestampMs(`${text}T00:00:00.000Z`);
  if (ms === null) return null;
  return isoAt(ms).slice(0, 10) === text ? text : null;
}

function dateOfIso(value) {
  const ms = timestampMs(value);
  return ms === null ? null : isoAt(ms).slice(0, 10);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// AC3: the real git default. A test injects a function with the same
// `(args, cwd) => stdout` contract, so no test shells out to git.
function defaultGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? String(result.stderr).trim() : '';
    throw new Error(stderr || `git ${args.join(' ')} failed (exit ${result.status})`);
  }
  return result.stdout;
}

// AC2: the earliest creation clock of the run. `createdAt` is the recorded
// creation time; the state-file and artifact mtimes are the filesystem clocks.
// Artifacts are the step reports, telemetry stream, ledger, and prompts under
// `{stateDir}/{slug}/{runId}/`.
function resolveArtifactsDirAbs(targetRoot, state, stateDir) {
  if (state && typeof state.artifactsDir === 'string' && state.artifactsDir.trim()) {
    return path.resolve(targetRoot, normalizePath(state.artifactsDir.trim()));
  }
  if (state && state.specSlug && state.runId) {
    return path.join(stateDir, String(state.specSlug), String(state.runId));
  }
  return null;
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

function earliestArtifactClock(options) {
  const candidates = [];
  const createdAtMs = timestampMs(options.state && options.state.createdAt);
  if (createdAtMs !== null) {
    candidates.push({ ms: createdAtMs, at: isoAt(createdAtMs), source: 'state.createdAt' });
  }
  if (Number.isFinite(options.stateMtimeMs)) {
    candidates.push({ ms: options.stateMtimeMs, at: isoAt(options.stateMtimeMs), source: 'state.mtime' });
  }
  const artifactsAbs = resolveArtifactsDirAbs(options.targetRoot, options.state, options.stateDir);
  if (artifactsAbs) {
    for (const file of listFilesRecursive(artifactsAbs)) {
      try {
        const stat = fs.statSync(file);
        candidates.push({
          ms: stat.mtimeMs,
          at: isoAt(stat.mtimeMs),
          source: `artifact:${normalizePath(path.relative(options.targetRoot, file))}`
        });
      } catch (e) {
        // A vanished artifact cannot be the earliest clock.
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.ms - b.ms) || a.source.localeCompare(b.source));
  return candidates[0];
}

// AC3: the delivery commit's committer timestamp. A missing commit, a missing
// git binary, or an unparsable value all resolve to "no timestamp", never to a
// guessed one.
function readCommitClock(git, sha, targetRoot) {
  const commit = String(sha === undefined || sha === null ? '' : sha).trim();
  if (!commit) return null;
  try {
    const output = String(git(['show', '-s', '--format=%cI', commit], targetRoot) || '').trim();
    const ms = timestampMs(output);
    if (ms === null) return null;
    return { ms, at: isoAt(ms), source: 'delivery-commit' };
  } catch (e) {
    return null;
  }
}

// The clock that decides which delivery day a run belongs to. The commit is the
// primary evidence; the recorded Step 6 completion (or a completed run's last
// update) is the fallback, and each is marked with its source.
function deliveryClockFor(state, commitClock) {
  if (commitClock) return commitClock;
  const step6 = state && state.steps ? state.steps[6] : null;
  const completedMs = timestampMs(step6 && step6.completedAt);
  if (completedMs !== null) {
    return { ms: completedMs, at: isoAt(completedMs), source: 'step-6-completed' };
  }
  if (String(state && state.status ? state.status : '').toLowerCase() === 'completed') {
    const updatedMs = timestampMs(state.updatedAt);
    if (updatedMs !== null) {
      return { ms: updatedMs, at: isoAt(updatedMs), source: 'state.updatedAt' };
    }
  }
  return null;
}

function pullRequestOf(state) {
  const candidates = [
    state && state.pullRequest,
    state && state.steps && state.steps[8] && state.steps[8].output && state.steps[8].output.pullRequest
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const hasUrl = typeof candidate.url === 'string' && candidate.url.trim() !== '';
    const hasNumber = candidate.number !== undefined && candidate.number !== null && candidate.number !== '';
    if (hasUrl || hasNumber) return candidate;
  }
  return null;
}

// AC3: the last PR thread comment is supplied by an injectable provider, so the
// reporter never performs a network call. `undefined`/`null` means no provider
// is configured; a provider that returns null means "queried, no comments"; a
// provider that throws means "cannot query", which makes the end value unknown.
function resolveThreadComment(provider, context) {
  if (provider === undefined || provider === null) {
    return { ok: false, reason: 'no PR provider can query thread comments' };
  }
  try {
    let value;
    if (typeof provider === 'function') {
      value = provider(context);
    } else if (typeof provider.lastThreadCommentAt === 'function') {
      value = provider.lastThreadCommentAt(context);
    } else {
      return { ok: false, reason: 'PR provider does not implement lastThreadCommentAt' };
    }
    if (value === undefined || value === null || value === '') return { ok: true, at: null, ms: null };
    const ms = timestampMs(value);
    if (ms === null) {
      return { ok: false, reason: `invalid PR thread timestamp "${String(value)}"` };
    }
    return { ok: true, at: isoAt(ms), ms };
  } catch (err) {
    return { ok: false, reason: `PR thread query failed: ${err.message}` };
  }
}

// AC3: end is the later of the last PR thread comment and the last delivery
// commit. When a PR exists but cannot be queried, the answer is unknown even if
// the commit time is known, because the later value cannot be established.
function resolveActivityEnd(options) {
  const commit = options.commitClock;
  const pr = options.pullRequest;
  if (!pr) {
    if (commit) return { ms: commit.ms, at: commit.at, source: commit.source };
    return { ms: null, at: null, source: null, reason: 'no PR and no delivery commit timestamp' };
  }
  const thread = resolveThreadComment(options.provider, {
    targetRoot: options.targetRoot,
    runId: options.state && options.state.runId ? String(options.state.runId) : null,
    specSlug: options.state && options.state.specSlug ? String(options.state.specSlug) : null,
    pullRequest: pr
  });
  if (!thread.ok) {
    return { ms: null, at: null, source: null, reason: thread.reason };
  }
  if (thread.ms === null) {
    if (commit) return { ms: commit.ms, at: commit.at, source: commit.source };
    return {
      ms: null,
      at: null,
      source: null,
      reason: 'no PR thread comment and no delivery commit timestamp'
    };
  }
  if (commit && commit.ms > thread.ms) {
    return { ms: commit.ms, at: commit.at, source: commit.source };
  }
  return { ms: thread.ms, at: thread.at, source: 'pr-thread' };
}

function readRunStates(targetRoot, stateDir, warnings) {
  const runs = [];
  let names = [];
  try {
    names = fs.readdirSync(stateDir).filter(name => name.endsWith('.state.json')).sort();
  } catch (e) {
    return runs;
  }
  for (const name of names) {
    const stateFileAbs = path.join(stateDir, name);
    try {
      const state = JSON.parse(fs.readFileSync(stateFileAbs, 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error('the file does not contain a run-state object');
      }
      const stat = fs.statSync(stateFileAbs);
      runs.push({ state, stateFileAbs, stateMtimeMs: stat.mtimeMs });
    } catch (err) {
      warnings.push({
        file: normalizePath(path.relative(targetRoot, stateFileAbs)),
        error: err.message
      });
    }
  }
  return runs;
}

function resolveStateDir(targetRoot) {
  return monitor.resolveStateDirReadOnly(targetRoot);
}

/**
 * Spec 00023 AC1-AC3: one timesheet entry per run delivered on `date`.
 *
 * A run belongs to a day when its delivery clock (commit, then Step 6
 * completion, then a completed run's update) falls on that UTC day. Start is the
 * earliest run-artifact clock; end is the later of the last PR thread comment
 * and the delivery commit, or the literal `unknown` with a reason.
 */
function collectActivity(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const date = parseReportDate(options.date);
  if (!date) {
    throw new Error(`Invalid --date "${String(options.date === undefined ? '' : options.date)}". Expected YYYY-MM-DD (for example 2026-10-23).`);
  }
  const nowMs = resolveNowMs(options.now);
  const stateDir = options.stateDir ? path.resolve(targetRoot, options.stateDir) : resolveStateDir(targetRoot);
  const git = typeof options.git === 'function' ? options.git : defaultGit;
  const warnings = [];
  const entries = [];

  for (const run of readRunStates(targetRoot, stateDir, warnings)) {
    const state = run.state;
    const commitClock = readCommitClock(git, state.deliveryCommit, targetRoot);
    const deliveryClock = deliveryClockFor(state, commitClock);
    if (!deliveryClock || dateOfIso(deliveryClock.at) !== date) continue;

    const start = earliestArtifactClock({
      targetRoot,
      state,
      stateDir,
      stateMtimeMs: run.stateMtimeMs
    });
    const pullRequest = pullRequestOf(state);
    const end = resolveActivityEnd({
      targetRoot,
      state,
      pullRequest,
      commitClock,
      provider: options.provider
    });

    let durationMs = null;
    let durationUnknownReason = null;
    if (!start) {
      durationUnknownReason = 'no artifact creation time';
    } else if (end.ms === null) {
      durationUnknownReason = end.reason;
    } else if (end.ms < start.ms) {
      durationUnknownReason = 'end precedes start';
    } else {
      durationMs = end.ms - start.ms;
    }

    entries.push({
      date,
      specSlug: state.specSlug ? String(state.specSlug) : null,
      runId: state.runId ? String(state.runId) : path.basename(run.stateFileAbs, '.state.json'),
      start: start ? start.at : 'unknown',
      startSource: start ? start.source : null,
      startUnknownReason: start ? null : 'no artifact creation time',
      end: end.ms === null ? 'unknown' : end.at,
      endSource: end.ms === null ? null : end.source,
      endUnknownReason: end.ms === null ? end.reason : null,
      durationMs,
      duration: durationMs === null ? 'unknown' : formatDuration(durationMs),
      durationUnknownReason,
      deliveryCommit: state.deliveryCommit ? String(state.deliveryCommit) : null,
      prUrl: pullRequest && pullRequest.url ? String(pullRequest.url) : null,
      status: state.status ? String(state.status) : null
    });
  }

  entries.sort((a, b) => {
    const aMs = timestampMs(a.start);
    const bMs = timestampMs(b.start);
    if (aMs === null && bMs !== null) return 1;
    if (aMs !== null && bMs === null) return -1;
    if (aMs !== null && bMs !== null && aMs !== bMs) return aMs - bMs;
    return String(a.specSlug).localeCompare(String(b.specSlug))
      || String(a.runId).localeCompare(String(b.runId));
  });

  return {
    command: 'activity',
    date,
    generatedAt: isoAt(nowMs),
    stateDir: normalizePath(path.relative(targetRoot, stateDir)) || '.',
    entries,
    warnings
  };
}

function newestTelemetryClock(targetRoot, artifactsAbs) {
  if (!artifactsAbs) return null;
  const events = telemetry.readEvents(telemetry.telemetryPathFor(normalizePath(artifactsAbs)), targetRoot);
  let newest = null;
  for (const event of events) {
    const ms = timestampMs(event && event.ts);
    if (ms === null) continue;
    if (newest === null || ms > newest.ms) {
      newest = { ms, at: isoAt(ms), source: 'telemetry' };
    }
  }
  return newest;
}

function lastActivityClock(options) {
  const candidates = [];
  const updatedMs = timestampMs(options.state && options.state.updatedAt);
  if (updatedMs !== null) {
    candidates.push({ ms: updatedMs, at: isoAt(updatedMs), source: 'state.updatedAt' });
  }
  if (Number.isFinite(options.stateMtimeMs)) {
    candidates.push({ ms: options.stateMtimeMs, at: isoAt(options.stateMtimeMs), source: 'state.mtime' });
  }
  const eventClock = newestTelemetryClock(options.targetRoot, options.artifactsAbs);
  if (eventClock) candidates.push(eventClock);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.ms - a.ms) || a.source.localeCompare(b.source));
  return candidates[0];
}

// AC4: a gate that is neither passed nor skipped is the blocking gate the
// standup item names. Names are sorted so the report is deterministic.
function blockingGateOf(state) {
  const gates = state && state.steps && state.steps[4] ? state.steps[4].gates : null;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) return null;
  for (const name of Object.keys(gates).sort()) {
    const gate = gates[name];
    const status = String(gate && gate.status ? gate.status : '').toLowerCase();
    if (status && status !== 'passed' && status !== 'skipped') {
      return { name, status };
    }
  }
  return null;
}

function stepFields(state) {
  const currentStep = Number.isInteger(state && state.currentStep) ? state.currentStep : null;
  const totalSteps = Number.isInteger(state && state.totalSteps) ? state.totalSteps : null;
  const step = currentStep !== null && state.steps ? state.steps[currentStep] : null;
  return {
    currentStep,
    totalSteps,
    stepName: step && step.name ? String(step.name) : null
  };
}

function buildStandupItem(fields) {
  const gate = fields.gate;
  return {
    specSlug: fields.state.specSlug ? String(fields.state.specSlug) : null,
    runId: fields.state.runId ? String(fields.state.runId) : null,
    status: fields.state.status ? String(fields.state.status) : null,
    ...stepFields(fields.state),
    deliveredAt: fields.deliveredClock ? fields.deliveredClock.at : 'unknown',
    deliverySource: fields.deliveredClock ? fields.deliveredClock.source : null,
    deliveryCommit: fields.state.deliveryCommit ? String(fields.state.deliveryCommit) : null,
    lastEventAt: fields.lastClock ? fields.lastClock.at : 'unknown',
    lastEventSource: fields.lastClock ? fields.lastClock.source : null,
    blockingGate: gate ? gate.name : null,
    blockingGateStatus: gate ? gate.status : null
  };
}

function normalizeHours(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_STANDUP_HOURS;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`Invalid --hours "${String(value)}". Expected a positive number of hours.`);
  }
  return hours;
}

function readPendingSpecs(targetRoot, warnings) {
  try {
    const specIndex = require('../../sdw-spec/scripts/spec_index.cjs');
    const index = specIndex.readIndex({ root: targetRoot });
    if (!index || !index.exists || !Array.isArray(index.entries)) return [];
    return index.entries;
  } catch (err) {
    warnings.push({ file: '.sdw/specs/index.specs.md', error: err.message });
    return [];
  }
}

/**
 * Spec 00023 AC4: delivered, in-progress, and next items inside the window.
 *
 * Delivered runs are completed runs whose delivery clock is inside the window.
 * In-progress runs are active or paused runs whose newest activity clock is
 * inside the window. Next items are `pending` rows from the specification index
 * that are not already in progress. Every item names the spec, its step, its
 * last event, and its blocking gate when one exists.
 */
function collectStandup(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const hours = normalizeHours(options.hours);
  const nowMs = resolveNowMs(options.now);
  const windowStartMs = nowMs - (hours * 3600 * 1000);
  const stateDir = options.stateDir ? path.resolve(targetRoot, options.stateDir) : resolveStateDir(targetRoot);
  const git = typeof options.git === 'function' ? options.git : defaultGit;
  const warnings = [];
  const delivered = [];
  const inProgress = [];
  const activeSlugs = new Set();

  for (const run of readRunStates(targetRoot, stateDir, warnings)) {
    const state = run.state;
    const artifactsAbs = resolveArtifactsDirAbs(targetRoot, state, stateDir);
    const lastClock = lastActivityClock({
      targetRoot,
      state,
      stateMtimeMs: run.stateMtimeMs,
      artifactsAbs
    });
    const status = String(state.status ? state.status : '').toLowerCase();
    const gate = blockingGateOf(state);

    if (status === 'completed') {
      const commitClock = readCommitClock(git, state.deliveryCommit, targetRoot);
      const deliveredClock = deliveryClockFor(state, commitClock) || lastClock;
      if (!deliveredClock || deliveredClock.ms < windowStartMs || deliveredClock.ms > nowMs) continue;
      delivered.push(buildStandupItem({ state, deliveredClock, lastClock, gate }));
    } else if (status === 'in_progress' || status === 'paused') {
      if (!lastClock || lastClock.ms < windowStartMs || lastClock.ms > nowMs) continue;
      inProgress.push(buildStandupItem({ state, deliveredClock: null, lastClock, gate }));
      if (state.specSlug) activeSlugs.add(String(state.specSlug));
    }
  }

  const next = readPendingSpecs(targetRoot, warnings)
    .filter(entry => String(entry.status ? entry.status : '').toLowerCase() === 'pending')
    .filter(entry => entry.slug && !activeSlugs.has(String(entry.slug)))
    .map(entry => ({
      specSlug: String(entry.slug),
      title: entry.title ? String(entry.title) : null,
      status: 'pending',
      currentStep: null,
      totalSteps: null,
      stepName: null,
      deliveredAt: null,
      deliverySource: null,
      deliveryCommit: null,
      lastEventAt: 'unknown',
      lastEventSource: null,
      blockingGate: null,
      blockingGateStatus: null
    }));

  delivered.sort((a, b) => {
    const aMs = timestampMs(a.deliveredAt);
    const bMs = timestampMs(b.deliveredAt);
    if (aMs !== null && bMs !== null && aMs !== bMs) return bMs - aMs;
    return String(a.specSlug).localeCompare(String(b.specSlug))
      || String(a.runId).localeCompare(String(b.runId));
  });
  inProgress.sort((a, b) => {
    const aMs = timestampMs(a.lastEventAt);
    const bMs = timestampMs(b.lastEventAt);
    if (aMs !== null && bMs !== null && aMs !== bMs) return bMs - aMs;
    return String(a.specSlug).localeCompare(String(b.specSlug))
      || String(a.runId).localeCompare(String(b.runId));
  });

  return {
    command: 'standup',
    hours,
    generatedAt: isoAt(nowMs),
    window: { start: isoAt(windowStartMs), end: isoAt(nowMs) },
    stateDir: normalizePath(path.relative(targetRoot, stateDir)) || '.',
    delivered,
    inProgress,
    next,
    warnings
  };
}

function cell(value) {
  const text = value === undefined || value === null || value === '' ? '-' : String(value);
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '-';
}

function timeCell(value, reason) {
  if (value && value !== 'unknown') return String(value);
  return reason ? `unknown (${reason})` : 'unknown';
}

function stepCell(item) {
  if (item.currentStep === null || item.currentStep === undefined) return 'not started';
  const total = item.totalSteps === null || item.totalSteps === undefined ? '?' : item.totalSteps;
  return `${item.currentStep}/${total}${item.stepName ? ` ${item.stepName}` : ''}`;
}

function gateCell(item) {
  return item.blockingGate ? `${item.blockingGate} (${item.blockingGateStatus || 'unknown'})` : 'none';
}

// AC1: the human-readable timesheet. `--json` serializes `collectActivity`
// directly, so the table and the machine-readable output cannot drift.
function renderActivity(report = {}) {
  const entries = Array.isArray(report.entries) ? report.entries : [];
  const date = report.date ? String(report.date) : 'unknown';
  const lines = [
    'SDW Activity Report',
    '===================',
    `Date: ${date}`,
    `State: ${report.stateDir ? String(report.stateDir) : path.join('.sdw', 'state')}`
  ];
  if (entries.length === 0) {
    lines.push('', 'Entries: 0', '', `No delivery activity for ${date}.`);
    return lines.join('\n');
  }
  lines.push('');
  lines.push('| Spec | Run | Start | End | Duration | Commit | PR | Status |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const entry of entries) {
    lines.push([
      `| ${cell(entry.specSlug)}`,
      cell(entry.runId),
      cell(timeCell(entry.start, entry.startUnknownReason)),
      cell(timeCell(entry.end, entry.endUnknownReason)),
      cell(entry.duration === 'unknown'
        ? timeCell('unknown', entry.durationUnknownReason)
        : entry.duration),
      cell(entry.deliveryCommit || 'none'),
      cell(entry.prUrl || 'none'),
      `${cell(entry.status)} |`
    ].join(' | '));
  }
  lines.push('', `Entries: ${entries.length}`);
  return lines.join('\n');
}

// AC4: the three standup sections, each with its count. An empty section says
// so explicitly instead of disappearing.
function renderStandup(report = {}) {
  const delivered = Array.isArray(report.delivered) ? report.delivered : [];
  const inProgress = Array.isArray(report.inProgress) ? report.inProgress : [];
  const next = Array.isArray(report.next) ? report.next : [];
  const window = report.window || {};
  const lines = [
    'SDW Standup Report',
    '==================',
    `Window: last ${report.hours === undefined ? DEFAULT_STANDUP_HOURS : report.hours}h (${window.start || 'unknown'} -> ${window.end || 'unknown'})`,
    `State: ${report.stateDir ? String(report.stateDir) : path.join('.sdw', 'state')}`,
    '',
    `Delivered (${delivered.length})`
  ];
  if (delivered.length === 0) {
    lines.push('- none');
  } else {
    lines.push('| Spec | Run | Step | Delivered | Last event | Blocking gate |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const item of delivered) {
      lines.push(`| ${cell(item.specSlug)} | ${cell(item.runId)} | ${cell(stepCell(item))} | ${cell(item.deliveredAt)} | ${cell(item.lastEventAt)} | ${cell(gateCell(item))} |`);
    }
  }
  lines.push('', `In progress (${inProgress.length})`);
  if (inProgress.length === 0) {
    lines.push('- none');
  } else {
    lines.push('| Spec | Run | Step | Last event | Blocking gate |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of inProgress) {
      lines.push(`| ${cell(item.specSlug)} | ${cell(item.runId)} | ${cell(stepCell(item))} | ${cell(item.lastEventAt)} | ${cell(gateCell(item))} |`);
    }
  }
  lines.push('', `Next (${next.length})`);
  if (next.length === 0) {
    lines.push('- none');
  } else {
    lines.push('| Spec | Title | Status | Step | Last event |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of next) {
      lines.push(`| ${cell(item.specSlug)} | ${cell(item.title)} | ${cell(item.status)} | ${cell(stepCell(item))} | ${cell(item.lastEventAt)} |`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_STANDUP_HOURS,
  parseReportDate,
  resolveNowMs,
  formatDuration,
  resolveStateDir,
  collectActivity,
  collectStandup,
  renderActivity,
  renderStandup
};
