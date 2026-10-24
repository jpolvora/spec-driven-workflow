'use strict';

// Spec 00023 AC1-AC6: read-only delivery reporting. Every value is a projection
// of existing evidence (run state, run artifacts, telemetry, the AC ledger, git
// history, and the specification index); nothing is inferred and nothing is
// written. The module never initializes the state directory, the acceptance
// ledger, or a telemetry stream. `now`, `git`, and `provider` are injectable so
// tests never depend on the wall clock, a real repository, or a network provider.
//
// Spec 00023 AC7: `--json` serializes the same object the Markdown renderer
// reads, so the two cannot drift. The envelope is stable and pinned by
// tests/sdw_orch_reporting.test.cjs:
//   every report: command, generatedAt, warnings
//   activity:     date, stateDir, entries[]
//   standup:      hours, window, stateDir, delivered[], inProgress[],
//                 next[] | "unknown", nextUnknownReason
//   explain:      specSlug, title, status, specPath, lifecycle, deliveredFiles,
//                 verification, acceptanceCriteria, testsObserved,
//                 manualTestSteps, unknowns[]
//
// Spec 00023 AC8: a field that comes from evidence carries a `*Source` marker
// (startSource, endSource, deliverySource, lastEventSource, scoreSource,
// gatesSource, deliveredFilesSource, statusSource, acceptanceCriteriaSource,
// testsObservedSource, manualTestStepsSource) so a consumer can trace it to run
// state, telemetry, the AC ledger, git history, or the specification registry.
//
// Spec 00023 AC9: an unavailable fact is the literal string "unknown" plus a
// `*UnknownReason` sibling, never a default timestamp, a zero count, or an
// empty value that would read as evidence. A genuinely absent thing (for
// example, a pending specification with no run) stays `null`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const telemetry = require('./telemetry.cjs');
const monitor = require('./monitor.cjs');
const acLedger = require('./ac_ledger.cjs');

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

    const entryStatus = state.status ? String(state.status) : null;
    const entryCommit = state.deliveryCommit ? String(state.deliveryCommit) : null;
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
      // AC9: a missing delivery commit or status is literal `unknown` with its
      // reason, never null or "none" that would read as a recorded fact.
      deliveryCommit: entryCommit || 'unknown',
      deliveryCommitUnknownReason: entryCommit ? null : 'the run state records no delivery commit',
      prUrl: pullRequest && pullRequest.url ? String(pullRequest.url) : null,
      status: entryStatus || 'unknown',
      statusSource: entryStatus ? 'run-state' : null,
      statusUnknownReason: entryStatus ? null : 'the run state records no status'
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

// AC4/AC9: a gate that is neither passed nor skipped is the blocking gate the
// standup item names. Names are sorted so the report is deterministic. A run
// that records no gate map is unavailable evidence, never "none".
function blockingGateOf(state) {
  const gates = state && state.steps && state.steps[4] ? state.steps[4].gates : null;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
    return { gate: null, reason: 'the run records no gate results' };
  }
  for (const name of Object.keys(gates).sort()) {
    const gate = gates[name];
    const status = String(gate && gate.status ? gate.status : '').toLowerCase();
    if (status && status !== 'passed' && status !== 'skipped') {
      return { gate: { name, status }, reason: null };
    }
  }
  return { gate: null, reason: null };
}

function stepFields(state) {
  const currentStep = Number.isInteger(state && state.currentStep) ? state.currentStep : null;
  const totalSteps = Number.isInteger(state && state.totalSteps) ? state.totalSteps : null;
  const step = currentStep !== null && state.steps ? state.steps[currentStep] : null;
  return {
    currentStep,
    totalSteps,
    stepName: step && step.name ? String(step.name) : null,
    // AC9: a run with no recorded step is `unknown`, never "not started".
    stepUnknownReason: currentStep === null ? 'the run state records no current step' : null
  };
}

function buildStandupItem(fields) {
  const gate = fields.gate;
  return {
    specSlug: fields.state.specSlug ? String(fields.state.specSlug) : null,
    runId: fields.state.runId ? String(fields.state.runId) : null,
    status: fields.state.status ? String(fields.state.status) : null,
    ...stepFields(fields.state),
    notStarted: false,
    deliveredAt: fields.deliveredClock ? fields.deliveredClock.at : 'unknown',
    deliverySource: fields.deliveredClock ? fields.deliveredClock.source : null,
    deliveryCommit: fields.state.deliveryCommit ? String(fields.state.deliveryCommit) : null,
    lastEventAt: fields.lastClock ? fields.lastClock.at : 'unknown',
    lastEventSource: fields.lastClock ? fields.lastClock.source : null,
    blockingGate: gate ? gate.name : (fields.gateUnknownReason ? 'unknown' : null),
    blockingGateStatus: gate ? gate.status : null,
    blockingGateUnknownReason: gate ? null : (fields.gateUnknownReason || null)
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

// AC9: an unreadable registry is unavailable evidence, not "zero pending
// specifications". A missing registry file is a fact (nothing is registered).
function readPendingSpecs(targetRoot, warnings) {
  try {
    const specIndex = require('../../sdw-spec/scripts/spec_index.cjs');
    const index = specIndex.readIndex({ root: targetRoot });
    if (!index || !index.exists) return { available: true, entries: [] };
    if (!Array.isArray(index.entries)) {
      return {
        available: false,
        entries: [],
        reason: 'the specification index records no readable row list'
      };
    }
    return { available: true, entries: index.entries };
  } catch (err) {
    warnings.push({ file: '.sdw/specs/index.specs.md', error: err.message });
    return {
      available: false,
      entries: [],
      reason: `the specification index could not be read: ${err.message}`
    };
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
      delivered.push(buildStandupItem({
        state,
        deliveredClock,
        lastClock,
        gate: gate.gate,
        gateUnknownReason: gate.reason
      }));
    } else if (status === 'in_progress' || status === 'paused') {
      if (!lastClock || lastClock.ms < windowStartMs || lastClock.ms > nowMs) continue;
      inProgress.push(buildStandupItem({
        state,
        deliveredClock: null,
        lastClock,
        gate: gate.gate,
        gateUnknownReason: gate.reason
      }));
      if (state.specSlug) activeSlugs.add(String(state.specSlug));
    }
  }

  const pending = readPendingSpecs(targetRoot, warnings);
  // AC9: when the registry cannot be read, the pending list is `unknown` with
  // its reason; an empty array would claim there is nothing queued.
  const next = pending.available
    ? pending.entries
      .filter(entry => String(entry.status ? entry.status : '').toLowerCase() === 'pending')
      .filter(entry => entry.slug && !activeSlugs.has(String(entry.slug)))
      .map(entry => ({
        specSlug: String(entry.slug),
        title: entry.title ? String(entry.title) : 'unknown',
        runId: null,
        status: 'pending',
        currentStep: null,
        totalSteps: null,
        stepName: null,
        stepUnknownReason: null,
        notStarted: true,
        deliveredAt: 'unknown',
        deliverySource: null,
        deliveryCommit: null,
        lastEventAt: 'unknown',
        lastEventSource: null,
        blockingGate: null,
        blockingGateStatus: null,
        blockingGateUnknownReason: null
      }))
    : 'unknown';

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
    nextUnknownReason: pending.available ? null : pending.reason,
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
  if (Number.isInteger(item.currentStep)) {
    const total = item.totalSteps === null || item.totalSteps === undefined ? '?' : item.totalSteps;
    return `${item.currentStep}/${total}${item.stepName ? ` ${item.stepName}` : ''}`;
  }
  // AC9: only a specification that has not started can say "not started"; a
  // run whose state lacks the step is `unknown` with its reason.
  if (item.notStarted) return 'not started';
  return timeCell('unknown', item.stepUnknownReason);
}

function gateCell(item) {
  if (item.blockingGate === 'unknown') return timeCell('unknown', item.blockingGateUnknownReason);
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
      cell(entry.deliveryCommit === 'unknown'
        ? timeCell('unknown', entry.deliveryCommitUnknownReason)
        : (entry.deliveryCommit || 'none')),
      cell(entry.prUrl || 'none'),
      `${cell(timeCell(entry.status, entry.statusUnknownReason))} |`
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
  // AC9: `unknown` next means the registry could not be read; it is not "none".
  const next = Array.isArray(report.next) ? report.next : null;
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
  if (next === null) {
    lines.push('', 'Next (unknown)', `- ${timeCell('unknown', report.nextUnknownReason)}`);
  } else {
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
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Spec 00023 AC5: `report explain <spec>`
// ---------------------------------------------------------------------------

// AC5/AC9: the registry row is the only proof that a specification exists. An
// unregistered slug is a caller error that names the discovery command, never a
// report assembled from a guess.
function resolveRegisteredSpec(targetRoot, slug, warnings) {
  const specIndex = require('../../sdw-spec/scripts/spec_index.cjs');
  let index = null;
  try {
    index = specIndex.readIndex({ root: targetRoot });
  } catch (err) {
    warnings.push({ file: '.sdw/specs/index.specs.md', error: err.message });
  }
  const entries = index && Array.isArray(index.entries) ? index.entries : [];
  const entry = entries.find(item => String(item && item.slug ? item.slug : '') === slug) || null;
  if (!entry) {
    throw new Error(
      `Unknown specification "${slug}"${index && index.exists ? '' : ' (no specification index found)'}. `
      + 'Run "node skills/sdw-spec/scripts/sdw_spec.cjs list" to see registered specifications.'
    );
  }
  const paths = specIndex.resolvePaths(targetRoot);
  const specFileAbs = specIndex.specFileForSlug(paths.specsDir, slug);
  let content = null;
  if (specFileAbs) {
    try {
      content = fs.readFileSync(specFileAbs, 'utf8');
    } catch (err) {
      warnings.push({
        file: normalizePath(path.relative(targetRoot, specFileAbs)),
        error: err.message
      });
    }
  }
  return { entry, specFileAbs, content, specIndex };
}

function newestRunForSpec(runs, slug) {
  let newest = null;
  let newestMs = -Infinity;
  for (const run of runs) {
    const state = run && run.state ? run.state : null;
    if (!state || String(state.specSlug || '') !== slug) continue;
    const updatedMs = timestampMs(state.updatedAt);
    const ms = updatedMs !== null ? updatedMs : (Number.isFinite(run.stateMtimeMs) ? run.stateMtimeMs : -Infinity);
    const currentId = String(state.runId || '');
    const previousId = newest ? String(newest.state.runId || '') : '';
    if (newest === null || ms > newestMs || (ms === newestMs && currentId > previousId)) {
      newest = run;
      newestMs = ms;
    }
  }
  return newest;
}

// AC5: only project-relative, in-tree paths are reportable delivered files.
function projectRelativeFile(value) {
  const normalized = normalizePath(String(value === undefined || value === null ? '' : value).trim())
    .replace(/^\.\//, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }
  return normalized;
}

// AC5: completed tasks record the files they changed; the fallback list is the
// pre-filesChanged task shape, never an inference.
function filesFromCompletedTasks(state) {
  const step4 = state && state.steps ? state.steps[4] : null;
  const tasks = step4 && step4.tasks && typeof step4.tasks === 'object' && !Array.isArray(step4.tasks)
    ? step4.tasks
    : null;
  if (!tasks) return null;
  const files = new Set();
  for (const task of Object.values(tasks)) {
    if (!task || task.status !== 'completed') continue;
    const list = Array.isArray(task.filesChanged)
      ? task.filesChanged
      : (Array.isArray(task.files) ? task.files : []);
    for (const value of list) {
      const file = projectRelativeFile(value);
      if (file) files.add(file);
    }
  }
  return [...files];
}

function filesFromLedger(ledger) {
  const files = new Set();
  for (const record of ledger && Array.isArray(ledger.criteria) ? ledger.criteria : []) {
    for (const entry of Array.isArray(record.evidence) ? record.evidence : []) {
      if (!entry || entry.type !== 'file') continue;
      const file = projectRelativeFile(entry.path);
      if (file) files.add(file);
    }
  }
  return [...files];
}

// AC5: git history is a delivered-files source only when it can answer. A
// missing commit, an unreadable repository, or a git failure is unavailable
// evidence, never an empty delivery.
function filesFromCommit(git, sha, targetRoot) {
  const commit = String(sha === undefined || sha === null ? '' : sha).trim();
  if (!commit) return { ok: false, reason: 'the run records no delivery commit' };
  try {
    const output = String(git(['show', '--name-only', '--format=', commit], targetRoot) || '');
    const files = output
      .split(/\r?\n/)
      .map(line => projectRelativeFile(line))
      .filter(Boolean);
    return { ok: true, files };
  } catch (err) {
    return { ok: false, reason: `git could not read commit ${commit}: ${err.message}` };
  }
}

// AC5/AC9: a missing, unreadable, or malformed ledger is unavailable evidence
// with a reason, so explain reports `unknown` instead of an invented verdict.
function readRunLedger(targetRoot, state, stateDir, warnings) {
  if (!state) return { available: false, reason: 'no run state' };
  const artifactsAbs = resolveArtifactsDirAbs(targetRoot, state, stateDir);
  if (!artifactsAbs) return { available: false, reason: 'the run records no artifact directory' };
  const artifactsRel = projectRelativeFile(path.relative(targetRoot, artifactsAbs));
  if (!artifactsRel) return { available: false, reason: 'the run artifact directory is outside the project root' };
  let ledgerPath;
  try {
    ledgerPath = acLedger.resolveLedgerPath({ root: targetRoot, artifactsDir: artifactsRel });
  } catch (err) {
    return { available: false, reason: err.message };
  }
  const ledgerRel = normalizePath(path.relative(targetRoot, ledgerPath));
  if (!fs.existsSync(ledgerPath)) {
    return { available: false, path: ledgerRel, reason: `no acceptance criteria ledger at ${ledgerRel}` };
  }
  try {
    return { available: true, path: ledgerRel, ledger: acLedger.readLedger(ledgerPath) };
  } catch (err) {
    if (Array.isArray(warnings)) warnings.push({ file: ledgerRel, error: err.message });
    return { available: false, path: ledgerRel, reason: err.message };
  }
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeGates(list) {
  return list
    .filter(gate => gate && gate.name !== undefined && gate.name !== null && String(gate.name).trim() !== '')
    .map(gate => ({
      name: String(gate.name),
      status: gate.status === undefined || gate.status === null || gate.status === ''
        ? 'unknown'
        : String(gate.status)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// AC5: the newest Step 4 gate event is the telemetry fallback when run state
// predates the gates map.
function currentTelemetryGates(targetRoot, state, stateDir) {
  const artifactsAbs = resolveArtifactsDirAbs(targetRoot, state, stateDir);
  if (!artifactsAbs) return null;
  const telemetryRel = telemetry.telemetryPathFor(normalizePath(path.relative(targetRoot, artifactsAbs)));
  let newest = null;
  for (const event of telemetry.readEvents(telemetryRel, targetRoot)) {
    if (!event || event.event !== 'gate') continue;
    const gates = event.payload && Array.isArray(event.payload.gates) ? event.payload.gates : null;
    if (!gates) continue;
    const ms = timestampMs(event.ts);
    if (newest === null
      || (newest.ms === null && ms !== null)
      || (newest.ms !== null && ms !== null && ms > newest.ms)) {
      newest = { ms, gates };
    }
  }
  return newest ? newest.gates : null;
}

// AC5: score, gates, and the code-review outcome, each with its source and an
// explicit unknown reason when the run records none.
function buildVerification(state, telemetryGates) {
  const steps = state && state.steps && typeof state.steps === 'object' ? state.steps : null;
  const step4 = steps ? steps[4] : null;
  const step5 = steps ? steps[5] : null;
  const step7 = steps ? steps[7] : null;
  const scoreOutput = step5 && step5.output && typeof step5.output === 'object' ? step5.output : {};

  const stateScore = finiteNumber(state ? state.score : null);
  const outputScore = finiteNumber(scoreOutput.score);
  const score = stateScore !== null ? stateScore : outputScore;
  const scoreSource = stateScore !== null ? 'state.score' : (outputScore !== null ? 'step-5-output' : null);
  const minScore = finiteNumber(scoreOutput.minScore);
  const scorePassed = typeof scoreOutput.passed === 'boolean' ? scoreOutput.passed : 'unknown';

  let gates = 'unknown';
  let gatesSource = null;
  let gatesUnknownReason = null;
  const stateGates = step4 && step4.gates && typeof step4.gates === 'object' && !Array.isArray(step4.gates)
    ? step4.gates
    : null;
  const recordedGateNames = stateGates ? Object.keys(stateGates) : [];
  if (recordedGateNames.length > 0) {
    gates = normalizeGates(recordedGateNames.map(name => ({
      name,
      status: stateGates[name] && stateGates[name].status
    })));
    gatesSource = 'run-state';
  } else if (Array.isArray(telemetryGates)) {
    gates = normalizeGates(telemetryGates);
    gatesSource = 'telemetry';
  } else {
    gatesUnknownReason = state
      ? 'no gate results recorded for the run'
      : 'no run state';
  }

  const review = { stepStatus: 'unknown', outcome: 'unknown', blockingCount: null, findings: [] };
  let reviewUnknownReason = state ? 'the code review step has not run' : 'no run state';
  if (step7 && step7.status && step7.status !== 'pending') {
    review.stepStatus = String(step7.status);
    const output = step7.output && typeof step7.output === 'object' ? step7.output : {};
    if (typeof output.passed === 'boolean') review.outcome = output.passed ? 'passed' : 'failed';
    else if (review.stepStatus === 'skipped') review.outcome = 'skipped';
    else if (review.stepStatus === 'review_failed' || review.stepStatus === 'failed') review.outcome = 'failed';
    review.blockingCount = finiteNumber(output.blockingCount);
    review.findings = Array.isArray(output.findings)
      ? output.findings
        .filter(item => item && typeof item === 'object')
        .map(item => ({
          severity: item.severity ? String(item.severity) : 'unknown',
          file: item.file ? String(item.file) : null,
          message: item.message ? String(item.message) : null
        }))
      : [];
    reviewUnknownReason = review.outcome === 'unknown'
      ? `the code review step status "${review.stepStatus}" records no verdict`
      : null;
  }

  return {
    score: score === null ? 'unknown' : score,
    scoreSource,
    scoreUnknownReason: score === null ? 'no score recorded in run state' : null,
    minScore: minScore === null ? 'unknown' : minScore,
    scorePassed,
    gates,
    gatesSource,
    gatesUnknownReason,
    review,
    reviewUnknownReason
  };
}

function describeLedgerEvidence(entry) {
  if (!entry || typeof entry !== 'object') return 'unknown';
  const identity = entry.type === 'file'
    ? entry.path
    : entry.type === 'test'
      ? entry.name
      : entry.type === 'commit'
        ? entry.sha
        : entry.id;
  const status = entry.status ? ` (${entry.status})` : '';
  return `${entry.type || 'unknown'}: ${identity || 'unknown'}${status}`;
}

// AC5/AC9: the ledger decides which criteria are verified. Without a ledger the
// verified and unverified sets are `unknown` instead of inferred from the AC text.
function buildCriteria(ledgerInfo) {
  if (!ledgerInfo.available) {
    return { verified: 'unknown', unverified: 'unknown', unknownReason: ledgerInfo.reason };
  }
  const summary = acLedger.summarizeLedger(ledgerInfo.ledger);
  const describe = record => ({
    id: record.id,
    status: record.status,
    text: record.text,
    evidence: (Array.isArray(record.evidence) ? record.evidence : []).map(describeLedgerEvidence)
  });
  return {
    verified: summary.criteria.filter(record => record.status === acLedger.STATUS_VERIFIED).map(describe),
    unverified: summary.criteria.filter(record => record.status !== acLedger.STATUS_VERIFIED).map(describe),
    unknownReason: null
  };
}

function collectTestsObserved(ledgerInfo) {
  if (!ledgerInfo.available) {
    return { tests: 'unknown', reason: ledgerInfo.reason };
  }
  const byName = new Map();
  for (const record of ledgerInfo.ledger.criteria) {
    for (const entry of Array.isArray(record.evidence) ? record.evidence : []) {
      if (!entry || entry.type !== 'test') continue;
      const name = String(entry.name || '').trim();
      if (!name) continue;
      const status = entry.status ? String(entry.status) : 'unknown';
      if (!byName.has(name)) byName.set(name, { name, status });
    }
  }
  return {
    tests: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    reason: null
  };
}

// AC5: a manual step is a recorded test to re-run or a ledger criterion that
// carries no test evidence to confirm by hand. Both come from the ledger, so a
// missing ledger makes the whole list `unknown`.
function buildManualTestSteps(ledgerInfo, testsObserved) {
  if (!ledgerInfo.available) {
    return { steps: 'unknown', reason: ledgerInfo.reason };
  }
  const steps = testsObserved.map(test => `Run recorded test: ${test.name} (observed: ${test.status})`);
  for (const record of ledgerInfo.ledger.criteria) {
    const evidence = Array.isArray(record.evidence) ? record.evidence : [];
    const hasTest = evidence.some(entry => entry && entry.type === 'test');
    if (!hasTest) steps.push(`Manually verify ${record.id}: ${record.text}`);
  }
  return { steps, reason: null };
}

function lifecycleSteps(state) {
  const steps = state && state.steps && typeof state.steps === 'object' ? state.steps : null;
  if (!steps) return 'unknown';
  return Object.keys(steps)
    .map(Number)
    .filter(step => Number.isInteger(step))
    .sort((a, b) => a - b)
    .map(step => ({
      step,
      name: steps[step] && steps[step].name ? String(steps[step].name) : 'unknown',
      status: steps[step] && steps[step].status ? String(steps[step].status) : 'unknown',
      completedAt: steps[step] && steps[step].completedAt ? String(steps[step].completedAt) : null
    }));
}

/**
 * Spec 00023 AC5: status, delivered files, verification results, and manual test
 * steps for one registered specification.
 *
 * Every value is a projection of the registry row, the specification file, the
 * newest run state for the slug, the acceptance criteria ledger, telemetry, and
 * the delivery commit. A fact that no source answers is the literal `unknown`
 * with its reason, never an inference. Like the other reporting commands this
 * reader never initializes or writes anything.
 */
// AC5: the explain report includes what the feature does and what it excludes,
// both read from the specification body. A missing or empty section is `unknown`
// with its reason, never an empty string that looks authored.
function extractSpecSection(content, heading) {
  if (!content) return null;
  const normalized = String(content).replace(/\r\n?/g, '\n');
  const pattern = new RegExp(`(?:^|\\n)## ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = normalized.match(pattern);
  if (!match) return null;
  const body = match[1].trim();
  return body || null;
}

function extractSectionTableRows(content, heading) {
  const section = extractSpecSection(content, heading);
  if (!section) return null;
  const rows = section
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(cells => cells.length >= 2 && !cells.every(cell => /^-+$/.test(cell)))
    .filter(cells => !/^(feature|item)$/i.test(cells[0]));
  if (rows.length === 0) return null;
  return rows.map(cells => ({ item: cells[0], reason: cells[1] }));
}

function collectExplain(options = {}) {
  const targetRoot = options.targetRoot ? path.resolve(options.targetRoot) : process.cwd();
  const specSlug = String(options.spec === undefined || options.spec === null ? '' : options.spec).trim();
  if (!specSlug) {
    throw new Error('report explain requires a specification slug. Usage: report explain <spec>.');
  }
  const nowMs = resolveNowMs(options.now);
  const stateDir = options.stateDir ? path.resolve(targetRoot, options.stateDir) : resolveStateDir(targetRoot);
  const git = typeof options.git === 'function' ? options.git : defaultGit;
  const warnings = [];

  const { entry, specFileAbs, content, specIndex } = resolveRegisteredSpec(targetRoot, specSlug, warnings);
  const frontmatter = content ? specIndex.parseFrontmatter(content.replace(/\r\n?/g, '\n')) : {};
  // AC8/AC9: the registry row is the status source; the specification file is
  // the title fallback. A missing title is literal `unknown` with its reason.
  const registryTitle = entry.title ? String(entry.title) : null;
  const fileTitle = frontmatter.title ? String(frontmatter.title) : null;
  const title = registryTitle || fileTitle;
  const titleUnknownReason = title ? null : 'neither the registry row nor the specification file records a title';
  const registryStatus = entry.status ? String(entry.status) : null;
  const statusUnknownReason = registryStatus ? null : 'the registry row records no status';

  const newest = newestRunForSpec(readRunStates(targetRoot, stateDir, warnings), specSlug);
  const state = newest ? newest.state : null;

  const taskFiles = filesFromCompletedTasks(state);
  const ledgerInfo = readRunLedger(targetRoot, state, stateDir, warnings);
  const ledgerFiles = ledgerInfo.available ? filesFromLedger(ledgerInfo.ledger) : null;
  const commit = state && state.deliveryCommit ? String(state.deliveryCommit) : null;
  const commitFiles = filesFromCommit(git, commit, targetRoot);

  const deliveredSources = [];
  const delivered = new Set();
  if (taskFiles !== null) {
    deliveredSources.push('run-state');
    for (const file of taskFiles) delivered.add(file);
  }
  if (ledgerFiles !== null) {
    deliveredSources.push('ac-ledger');
    for (const file of ledgerFiles) delivered.add(file);
  }
  if (commitFiles.ok) {
    deliveredSources.push('git');
    for (const file of commitFiles.files) delivered.add(file);
  }
  const deliveredFiles = deliveredSources.length > 0 ? [...delivered].sort() : 'unknown';
  const deliveredFilesUnknownReason = deliveredSources.length > 0
    ? null
    : (state
      ? [
        taskFiles === null ? 'run state records no implementation tasks' : null,
        ledgerFiles === null ? ledgerInfo.reason : null,
        commitFiles.reason
      ].filter(Boolean).join('; ')
      : 'no run state');

  const telemetryGates = currentTelemetryGates(targetRoot, state, stateDir);
  const verification = buildVerification(state, telemetryGates);
  const acceptanceCriteria = buildCriteria(ledgerInfo);
  const observed = collectTestsObserved(ledgerInfo);
  const manual = buildManualTestSteps(ledgerInfo, observed.tests === 'unknown' ? [] : observed.tests);
  const steps = lifecycleSteps(state);
  const description = extractSpecSection(content, 'Description');
  const descriptionUnknownReason = description ? null : 'the specification declares no Description section';
  const outOfScopeRows = extractSectionTableRows(content, 'Out of Scope');
  const outOfScope = outOfScopeRows || 'unknown';
  const outOfScopeUnknownReason = outOfScopeRows
    ? null
    : 'the specification declares no Out of Scope table';
  // AC9: a run whose state records no update time is `unknown`; a pending
  // specification with no run at all has no update time to report (null).
  const updatedAt = state && state.updatedAt ? String(state.updatedAt) : null;
  const updatedAtUnknownReason = state && !updatedAt ? 'the run state records no update time' : null;

  const unknowns = [];
  const noteUnknown = (field, reason) => {
    if (reason) unknowns.push({ field, reason });
  };
  noteUnknown('title', titleUnknownReason);
  noteUnknown('status', statusUnknownReason);
  noteUnknown('description', descriptionUnknownReason);
  noteUnknown('outOfScope', outOfScopeUnknownReason);
  noteUnknown('deliveredFiles', deliveredFilesUnknownReason);
  noteUnknown('lifecycle.updatedAt', updatedAtUnknownReason);
  noteUnknown('verification.score', verification.scoreUnknownReason);
  noteUnknown('verification.gates', verification.gatesUnknownReason);
  noteUnknown('verification.review', verification.reviewUnknownReason);
  noteUnknown('acceptanceCriteria', acceptanceCriteria.unknownReason);
  noteUnknown('testsObserved', observed.reason);
  noteUnknown('manualTestSteps', manual.reason);

  return {
    command: 'explain',
    specSlug,
    generatedAt: isoAt(nowMs),
    title: title || 'unknown',
    titleUnknownReason,
    status: registryStatus || 'unknown',
    // AC8: the lifecycle status is the registry row, never the run state.
    statusSource: registryStatus ? 'registry' : null,
    statusUnknownReason,
    specPath: specFileAbs ? normalizePath(path.relative(targetRoot, specFileAbs)) : null,
    description: description || 'unknown',
    descriptionSource: description ? 'spec-file' : null,
    descriptionUnknownReason,
    outOfScope,
    outOfScopeSource: outOfScopeRows ? 'spec-file' : null,
    outOfScopeUnknownReason,
    lifecycle: {
      registryStatus: registryStatus || 'unknown',
      runId: state && state.runId ? String(state.runId) : null,
      runStatus: state && state.status ? String(state.status) : 'unknown',
      currentStep: state && Number.isInteger(state.currentStep) ? state.currentStep : null,
      totalSteps: state && Number.isInteger(state.totalSteps) ? state.totalSteps : null,
      stepUnknownReason: state
        ? (Number.isInteger(state.currentStep) ? null : 'the run state records no current step')
        : 'no run state',
      updatedAt: updatedAt || (state ? 'unknown' : null),
      updatedAtUnknownReason,
      steps,
      stepsUnknownReason: state ? (steps === 'unknown' ? 'the run state records no steps' : null) : 'no run state'
    },
    deliveredFiles,
    deliveredFilesSource: deliveredSources,
    deliveredFilesUnknownReason,
    verification,
    acceptanceCriteria,
    acceptanceCriteriaSource: ledgerInfo.available ? 'ac-ledger' : null,
    testsObserved: observed.tests,
    testsObservedSource: ledgerInfo.available ? 'ac-ledger' : null,
    testsObservedUnknownReason: observed.reason,
    manualTestSteps: manual.steps,
    manualTestStepsSource: ledgerInfo.available ? 'ac-ledger' : null,
    manualTestStepsUnknownReason: manual.reason,
    unknowns,
    warnings
  };
}

// AC5: one human-readable explanation. Unknown values carry their reason inline;
// `--json` serializes `collectExplain` directly so the two cannot drift.
function renderExplain(report = {}) {
  const lifecycle = report.lifecycle || {};
  const verification = report.verification || {};
  const criteria = report.acceptanceCriteria || {};
  const lines = [
    'SDW Explain Report',
    '==================',
    `Spec: ${report.specSlug || 'unknown'}`,
    `Title: ${report.title === 'unknown' ? timeCell('unknown', report.titleUnknownReason) : (report.title || 'unknown')}`,
    `Status: ${report.status || 'unknown'}`,
    `Spec file: ${report.specPath || 'unknown'}`,
    `Generated: ${report.generatedAt || 'unknown'}`,
    '',
    'Lifecycle',
    '---------',
    `Run: ${lifecycle.runId || 'unknown'} (${lifecycle.runStatus || 'unknown'})`,
    `Step: ${stepCell(lifecycle)}`,
    `Updated: ${lifecycle.updatedAt === 'unknown' ? timeCell('unknown', lifecycle.updatedAtUnknownReason) : (lifecycle.updatedAt || 'unknown')}`
  ];
  if (Array.isArray(lifecycle.steps)) {
    lines.push('', '| Step | Name | Status | Completed |', '| --- | --- | --- | --- |');
    for (const step of lifecycle.steps) {
      lines.push(`| ${cell(step.step)} | ${cell(step.name)} | ${cell(step.status)} | ${cell(step.completedAt)} |`);
    }
  } else {
    lines.push(`Steps: ${timeCell('unknown', lifecycle.stepsUnknownReason)}`);
  }

  const deliveredFiles = report.deliveredFiles;
  lines.push('', 'What the feature does', '---------------------');
  if (report.description === 'unknown' || !report.description) {
    lines.push(timeCell('unknown', report.descriptionUnknownReason));
  } else {
    for (const paragraph of String(report.description).split('\n').filter(line => line.trim() !== '')) {
      lines.push(paragraph.trim());
    }
  }
  if (deliveredFiles === 'unknown') {
    lines.push(
      '',
      'Delivered files (unknown)',
      '-------------------------',
      `- ${timeCell('unknown', report.deliveredFilesUnknownReason)}`
    );
  } else {
    const files = Array.isArray(deliveredFiles) ? deliveredFiles : [];
    lines.push('', `Delivered files (${files.length})`, '---------------------');
    if (files.length === 0) lines.push('- none');
    else for (const file of files) lines.push(`- ${file}`);
    if (Array.isArray(report.deliveredFilesSource) && report.deliveredFilesSource.length > 0) {
      lines.push(`Source: ${report.deliveredFilesSource.join(', ')}`);
    }
  }

  let scoreLine;
  if (verification.score === 'unknown') {
    scoreLine = timeCell('unknown', verification.scoreUnknownReason);
  } else {
    scoreLine = `${verification.score}/10`;
    if (verification.minScore !== 'unknown' && verification.minScore !== undefined) {
      scoreLine += ` (minimum ${verification.minScore})`;
    }
    if (verification.scorePassed === true) scoreLine += ' passed';
    else if (verification.scorePassed === false) scoreLine += ' failed';
  }
  let gatesLine;
  if (verification.gates === 'unknown') {
    gatesLine = timeCell('unknown', verification.gatesUnknownReason);
  } else {
    const gates = Array.isArray(verification.gates) ? verification.gates : [];
    gatesLine = gates.length === 0 ? 'none' : gates.map(gate => `${gate.name} (${gate.status})`).join('; ');
  }
  const review = verification.review || {};
  const reviewDetails = [];
  if (review.stepStatus && review.stepStatus !== 'unknown') reviewDetails.push(`step ${review.stepStatus}`);
  if (review.blockingCount !== null && review.blockingCount !== undefined) {
    reviewDetails.push(`${review.blockingCount} blocking`);
  }
  if (Array.isArray(review.findings) && review.findings.length > 0) {
    reviewDetails.push(`${review.findings.length} finding(s)`);
  }
  const reviewLine = review.outcome === 'unknown'
    ? timeCell('unknown', verification.reviewUnknownReason)
    : `${review.outcome}${reviewDetails.length > 0 ? ` (${reviewDetails.join(', ')})` : ''}`;
  lines.push('', 'Verification', '------------', `- Score: ${scoreLine}`, `- Gates: ${gatesLine}`, `- Review: ${reviewLine}`);
  for (const finding of Array.isArray(review.findings) ? review.findings : []) {
    lines.push(`  - [${finding.severity}] ${finding.file || 'unknown'}: ${finding.message || 'unknown'}`);
  }

  lines.push('', 'Acceptance criteria', '-------------------');
  if (criteria.verified === 'unknown') {
    lines.push(`- ${timeCell('unknown', criteria.unknownReason || 'no acceptance criteria ledger')}`);
  } else {
    const verified = Array.isArray(criteria.verified) ? criteria.verified : [];
    const unverified = Array.isArray(criteria.unverified) ? criteria.unverified : [];
    lines.push(`Verified (${verified.length})`);
    if (verified.length === 0) {
      lines.push('- none');
    } else {
      lines.push('| AC | Criterion | Evidence |', '| --- | --- | --- |');
      for (const record of verified) {
        lines.push(`| ${cell(record.id)} | ${cell(record.text)} | ${cell(record.evidence.join('; ') || 'none')} |`);
      }
    }
    lines.push('', `Unverified (${unverified.length})`);
    if (unverified.length === 0) {
      lines.push('- none');
    } else {
      lines.push('| AC | Status | Criterion |', '| --- | --- | --- |');
      for (const record of unverified) {
        lines.push(`| ${cell(record.id)} | ${cell(record.status)} | ${cell(record.text)} |`);
      }
    }
  }

  lines.push('', 'Tests observed', '--------------');
  if (report.testsObserved === 'unknown') {
    lines.push(`- ${timeCell('unknown', report.testsObservedUnknownReason)}`);
  } else {
    const tests = Array.isArray(report.testsObserved) ? report.testsObserved : [];
    if (tests.length === 0) lines.push('- none');
    else for (const test of tests) lines.push(`- ${test.name} (${test.status})`);
  }

  lines.push('', 'Manual test steps', '-----------------');
  if (report.manualTestSteps === 'unknown') {
    lines.push(`1. ${timeCell('unknown', report.manualTestStepsUnknownReason)}`);
  } else {
    const manualSteps = Array.isArray(report.manualTestSteps) ? report.manualTestSteps : [];
    if (manualSteps.length === 0) lines.push('- none');
    else manualSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }

  lines.push('', 'Out of scope', '------------');
  if (report.outOfScope === 'unknown') {
    lines.push(`- ${timeCell('unknown', report.outOfScopeUnknownReason)}`);
  } else {
    const exclusions = Array.isArray(report.outOfScope) ? report.outOfScope : [];
    if (exclusions.length === 0) {
      lines.push('- none');
    } else {
      lines.push('| Item | Reason |', '| --- | --- |');
      for (const exclusion of exclusions) {
        lines.push(`| ${cell(exclusion.item)} | ${cell(exclusion.reason)} |`);
      }
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
  collectExplain,
  renderActivity,
  renderStandup,
  renderExplain
};
