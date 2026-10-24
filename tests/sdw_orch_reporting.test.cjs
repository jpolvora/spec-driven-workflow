'use strict';

// Spec 00023: the read-only delivery reporting suite.
// AC1 proves `report activity --date` produces timesheet entries for a delivery
// day; AC2 the earliest run-artifact start; AC3 the later of the last PR thread
// comment and the delivery commit (with `unknown` when the PR cannot be
// queried); AC4 the `report standup --hours` buckets. Empty days, invalid dates,
// argument wiring, and the read-only guarantee are covered as boundary cases.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const reporting = require('../skills/sdw-orch/scripts/reporting.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

const ORCH = path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function setMtime(file, iso) {
  const when = new Date(iso);
  fs.utimesSync(file, when, when);
}

function stateFilePath(root, runId) {
  return path.join(root, '.sdw', 'state', `${runId}.state.json`);
}

function writeRunState(root, state, options = {}) {
  const stateDir = path.join(root, '.sdw', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = stateFilePath(root, state.runId);
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (options.mtime) setMtime(file, options.mtime);
  return file;
}

function artifactsDirAbs(root, state) {
  return path.join(root, state.artifactsDir || path.join('.sdw', 'state', state.specSlug, state.runId));
}

function writeArtifact(root, state, name, iso) {
  const dir = artifactsDirAbs(root, state);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `artifact ${name}\n`, 'utf8');
  if (iso) setMtime(file, iso);
  return file;
}

function writeTelemetry(root, state, events) {
  const dir = artifactsDirAbs(root, state);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'telemetry.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}

function writeSpecIndex(root, rows) {
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const lines = [
    '# Specification Index',
    '',
    '| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.prefix} | ${row.slug} | ${row.title} | ${row.status} | local | 2026-10-19 | PASS | - |`)
  ];
  fs.writeFileSync(path.join(specsDir, 'index.specs.md'), `${lines.join('\n')}\n`, 'utf8');
}

function baseState(overrides = {}) {
  return {
    orchestrator: 'sdw-orch',
    runId: 'run-1',
    specSlug: 'demo-spec',
    status: 'completed',
    currentStep: 8,
    totalSteps: 8,
    createdAt: '2026-10-23T10:00:30.000Z',
    updatedAt: '2026-10-23T17:00:00.000Z',
    deliveryCommit: 'abc123',
    pullRequest: null,
    artifactsDir: '.sdw/state/demo-spec/run-1',
    steps: {
      6: { name: 'delivery_commit', status: 'completed', completedAt: '2026-10-23T16:50:00.000Z' },
      8: { name: 'pr_preparation', status: 'completed', output: { pullRequest: null } }
    },
    ...overrides
  };
}

// Every file under `root`, keyed by project-relative path with its exact bytes
// and mtime. A report that writes, creates, or touches anything changes this.
function snapshotTree(root) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else {
        const stat = fs.statSync(absolutePath);
        files[path.relative(root, absolutePath).replace(/\\/g, '/')] = {
          bytes: fs.readFileSync(absolutePath).toString('base64'),
          mtimeMs: stat.mtimeMs
        };
      }
    }
  };
  walk(root);
  return files;
}

test('AC1 & AC2: activity lists the delivery day and starts at the earliest run artifact', () => {
  const root = tempRoot('sdw-report-activity-start-');
  try {
    const state = baseState();
    writeRunState(root, state, { mtime: '2026-10-23T17:00:00.000Z' });
    // The first artifact predates the recorded createdAt, so it is the start.
    writeArtifact(root, state, 'step-1.md', '2026-10-23T09:15:00.000Z');
    writeArtifact(root, state, 'step-2.md', '2026-10-23T12:00:00.000Z');

    const report = reporting.collectActivity({
      targetRoot: root,
      date: '2026-10-23',
      now: '2026-10-23T20:00:00.000Z',
      git: () => '2026-10-23T16:00:00+00:00'
    });

    assert.equal(report.command, 'activity');
    assert.equal(report.date, '2026-10-23');
    assert.equal(report.generatedAt, '2026-10-23T20:00:00.000Z');
    assert.equal(report.entries.length, 1, 'AC1: one timesheet entry for the delivery day');

    const entry = report.entries[0];
    assert.equal(entry.specSlug, 'demo-spec');
    assert.equal(entry.runId, 'run-1');
    assert.equal(entry.deliveryCommit, 'abc123');
    assert.equal(entry.status, 'completed');
    assert.equal(entry.start, '2026-10-23T09:15:00.000Z', 'AC2: the earliest artifact wins');
    assert.equal(entry.startSource, 'artifact:.sdw/state/demo-spec/run-1/step-1.md');
    assert.equal(entry.end, '2026-10-23T16:00:00.000Z');
    assert.equal(entry.endSource, 'delivery-commit');
    assert.equal(entry.durationMs, 6 * 3600 * 1000 + 45 * 60 * 1000);
    assert.equal(entry.duration, '6h 45m');

    const rendered = reporting.renderActivity(report);
    assert.match(rendered, /SDW Activity Report/);
    assert.match(rendered, /\| demo-spec \| run-1 \|/);
    assert.match(rendered, /Entries: 1/);
  } finally {
    cleanup(root);
  }
});

test('AC3: activity end is the later of the PR thread comment and the delivery commit', () => {
  const root = tempRoot('sdw-report-activity-end-');
  try {
    const state = baseState({
      pullRequest: { number: 7, url: 'https://example.test/pr/7' }
    });
    writeRunState(root, state);
    writeArtifact(root, state, 'step-1.md', '2026-10-23T09:00:00.000Z');
    const git = () => '2026-10-23T16:00:00+00:00';

    let providerContext = null;
    const threadLater = reporting.collectActivity({
      targetRoot: root,
      date: '2026-10-23',
      git,
      provider: context => {
        providerContext = context;
        return '2026-10-23T18:30:00Z';
      }
    });
    assert.equal(threadLater.entries[0].end, '2026-10-23T18:30:00.000Z');
    assert.equal(threadLater.entries[0].endSource, 'pr-thread');
    assert.equal(providerContext.runId, 'run-1');
    assert.equal(providerContext.pullRequest.number, 7);

    const commitLater = reporting.collectActivity({
      targetRoot: root,
      date: '2026-10-23',
      git,
      provider: () => '2026-10-23T15:00:00Z'
    });
    assert.equal(commitLater.entries[0].end, '2026-10-23T16:00:00.000Z');
    assert.equal(commitLater.entries[0].endSource, 'delivery-commit');

    const noComments = reporting.collectActivity({
      targetRoot: root,
      date: '2026-10-23',
      git,
      provider: () => null
    });
    assert.equal(noComments.entries[0].end, '2026-10-23T16:00:00.000Z', 'a queried PR without comments falls back to the commit');

    const unqueryable = reporting.collectActivity({
      targetRoot: root,
      date: '2026-10-23',
      git
    });
    assert.equal(unqueryable.entries[0].end, 'unknown', 'AC3: a PR that cannot be queried is unknown, never a guess');
    assert.match(unqueryable.entries[0].endUnknownReason, /no PR provider/);
    assert.equal(unqueryable.entries[0].duration, 'unknown');
    assert.match(unqueryable.entries[0].durationUnknownReason, /no PR provider/);

    const failed = reporting.collectActivity({
      targetRoot: root,
      date: '2026-10-23',
      git,
      provider: () => {
        throw new Error('gh offline');
      }
    });
    assert.equal(failed.entries[0].end, 'unknown');
    assert.match(failed.entries[0].endUnknownReason, /gh offline/);
  } finally {
    cleanup(root);
  }
});

test('AC1: an empty delivery day returns an empty report with exit code 0', () => {
  const root = tempRoot('sdw-report-empty-');
  try {
    const state = baseState();
    writeRunState(root, state, { mtime: '2026-10-23T17:00:00.000Z' });
    writeArtifact(root, state, 'step-1.md', '2026-10-23T09:15:00.000Z');

    const report = reporting.collectActivity({ targetRoot: root, date: '2026-10-22' });
    assert.deepEqual(report.entries, []);
    assert.match(reporting.renderActivity(report), /Entries: 0/);
    assert.match(reporting.renderActivity(report), /No delivery activity for 2026-10-22/);

    const text = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-10-22', '--root', root], { encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Entries: 0/);

    const json = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-10-22', '--json', '--root', root], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.command, 'activity');
    assert.equal(parsed.date, '2026-10-22');
    assert.deepEqual(parsed.entries, []);
  } finally {
    cleanup(root);
  }
});

test('AC4: standup lists delivered, in-progress, and next items inside the window', () => {
  const root = tempRoot('sdw-report-standup-');
  try {
    const delivered = baseState({
      runId: 'run-delivered',
      specSlug: 'delivered-spec',
      deliveryCommit: 'commit-new',
      updatedAt: '2026-10-23T10:05:00.000Z',
      artifactsDir: '.sdw/state/delivered-spec/run-delivered',
      steps: {
        6: { name: 'delivery_commit', status: 'completed', completedAt: '2026-10-23T10:00:00.000Z' },
        8: { name: 'pr_preparation', status: 'completed', output: {} }
      }
    });
    writeRunState(root, delivered, { mtime: '2026-10-23T10:04:00.000Z' });
    writeArtifact(root, delivered, 'step-1.md', '2026-10-23T09:00:00.000Z');

    const active = baseState({
      runId: 'run-active',
      specSlug: 'active-spec',
      status: 'in_progress',
      currentStep: 4,
      deliveryCommit: null,
      updatedAt: '2026-10-23T11:00:00.000Z',
      artifactsDir: '.sdw/state/active-spec/run-active',
      steps: {
        4: {
          name: 'implementation',
          status: 'in_progress',
          gates: { test: { status: 'failed' } }
        }
      }
    });
    writeRunState(root, active, { mtime: '2026-10-23T11:00:00.000Z' });
    writeTelemetry(root, active, [
      { ts: '2026-10-23T11:30:00.000Z', runId: 'run-active', specSlug: 'active-spec', event: 'step', step: 4, status: 'in_progress' }
    ]);

    const oldDelivered = baseState({
      runId: 'run-old',
      specSlug: 'old-spec',
      deliveryCommit: 'commit-old',
      updatedAt: '2026-10-20T10:00:00.000Z',
      artifactsDir: '.sdw/state/old-spec/run-old',
      steps: {
        6: { name: 'delivery_commit', status: 'completed', completedAt: '2026-10-20T10:00:00.000Z' }
      }
    });
    writeRunState(root, oldDelivered, { mtime: '2026-10-20T10:00:00.000Z' });

    const oldPaused = baseState({
      runId: 'run-paused-old',
      specSlug: 'paused-old-spec',
      status: 'paused',
      currentStep: 2,
      deliveryCommit: null,
      updatedAt: '2026-10-21T10:00:00.000Z',
      artifactsDir: '.sdw/state/paused-old-spec/run-paused-old',
      steps: { 2: { name: 'refinement', status: 'in_progress' } }
    });
    writeRunState(root, oldPaused, { mtime: '2026-10-21T10:00:00.000Z' });

    writeSpecIndex(root, [
      { prefix: '00001', slug: 'active-spec', title: 'Already running', status: 'pending' },
      { prefix: '00002', slug: 'next-one', title: 'Next specification', status: 'pending' },
      { prefix: '00003', slug: 'done-one', title: 'Already completed', status: 'completed' }
    ]);

    const git = args => (args[3] === 'commit-old' ? '2026-10-20T10:00:00+00:00' : '2026-10-23T10:00:00+00:00');
    const report = reporting.collectStandup({
      targetRoot: root,
      hours: 36,
      now: '2026-10-23T12:00:00.000Z',
      git
    });

    assert.equal(report.command, 'standup');
    assert.equal(report.hours, 36);
    assert.equal(report.window.start, '2026-10-22T00:00:00.000Z');
    assert.equal(report.window.end, '2026-10-23T12:00:00.000Z');

    assert.equal(report.delivered.length, 1, 'only the in-window completed run is delivered');
    const deliveredItem = report.delivered[0];
    assert.equal(deliveredItem.specSlug, 'delivered-spec');
    assert.equal(deliveredItem.runId, 'run-delivered');
    assert.equal(deliveredItem.currentStep, 8);
    assert.equal(deliveredItem.stepName, 'pr_preparation');
    assert.equal(deliveredItem.deliveredAt, '2026-10-23T10:00:00.000Z');
    assert.equal(deliveredItem.deliverySource, 'delivery-commit');
    assert.equal(deliveredItem.lastEventAt, '2026-10-23T10:05:00.000Z');
    assert.equal(deliveredItem.blockingGate, null);

    assert.equal(report.inProgress.length, 1, 'only the in-window active run is in progress');
    const activeItem = report.inProgress[0];
    assert.equal(activeItem.specSlug, 'active-spec');
    assert.equal(activeItem.runId, 'run-active');
    assert.equal(activeItem.currentStep, 4);
    assert.equal(activeItem.lastEventAt, '2026-10-23T11:30:00.000Z', 'telemetry is the newest activity clock');
    assert.equal(activeItem.lastEventSource, 'telemetry');
    assert.equal(activeItem.blockingGate, 'test');
    assert.equal(activeItem.blockingGateStatus, 'failed');

    assert.deepEqual(report.next.map(item => item.specSlug), ['next-one'], 'pending rows exclude the in-progress spec');
    assert.equal(report.next[0].title, 'Next specification');
    assert.equal(report.next[0].status, 'pending');
    assert.equal(report.next[0].currentStep, null);
    assert.equal(report.next[0].lastEventAt, 'unknown');

    const rendered = reporting.renderStandup(report);
    assert.match(rendered, /Delivered \(1\)/);
    assert.match(rendered, /In progress \(1\)/);
    assert.match(rendered, /Next \(1\)/);
    assert.match(rendered, /active-spec/);
    assert.match(rendered, /next-one/);
  } finally {
    cleanup(root);
  }
});

test('AC1 & AC4: reporting commands are read-only and leave the workspace byte-identical', () => {
  const root = tempRoot('sdw-report-readonly-');
  const emptyRoot = tempRoot('sdw-report-readonly-empty-');
  try {
    const state = baseState();
    writeRunState(root, state, { mtime: '2026-10-23T17:00:00.000Z' });
    writeArtifact(root, state, 'step-1.md', '2026-10-23T09:15:00.000Z');
    writeArtifact(root, state, 'ac-ledger.json', '2026-10-23T09:20:00.000Z');
    writeSpecIndex(root, [
      { prefix: '00002', slug: 'next-one', title: 'Next specification', status: 'pending' }
    ]);
    const before = snapshotTree(root);

    reporting.collectActivity({
      targetRoot: root,
      date: '2026-10-23',
      now: '2026-10-23T20:00:00.000Z',
      git: () => '2026-10-23T16:00:00+00:00'
    });
    reporting.collectStandup({
      targetRoot: root,
      hours: 36,
      now: '2026-10-23T20:00:00.000Z',
      git: () => '2026-10-23T16:00:00+00:00'
    });
    assert.deepEqual(snapshotTree(root), before, 'the module never writes, creates, or touches a file');

    const activity = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-10-23', '--root', root], { encoding: 'utf8' });
    assert.equal(activity.status, 0, activity.stderr);
    const standup = spawnSync(process.execPath, [ORCH, 'report', 'standup', '--hours', '36', '--root', root], { encoding: 'utf8' });
    assert.equal(standup.status, 0, standup.stderr);
    assert.deepEqual(snapshotTree(root), before, 'the CLI never writes a state file, ledger, telemetry event, or sandbox report');

    const emptyBefore = snapshotTree(emptyRoot);
    const emptyReport = spawnSync(process.execPath, [ORCH, 'report', 'standup', '--hours', '36', '--root', emptyRoot], { encoding: 'utf8' });
    assert.equal(emptyReport.status, 0, emptyReport.stderr);
    assert.equal(fs.existsSync(path.join(emptyRoot, '.sdw', 'state')), false, 'reporting never initializes the state directory');
    assert.deepEqual(snapshotTree(emptyRoot), emptyBefore, 'an empty workspace is unchanged');
  } finally {
    cleanup(root);
    cleanup(emptyRoot);
  }
});

test('AC1: report activity rejects a missing or malformed date', () => {
  const root = tempRoot('sdw-report-bad-date-');
  try {
    const missing = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--root', root], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--date/);

    const malformed = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-02-30', '--root', root], { encoding: 'utf8' });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /YYYY-MM-DD/);

    assert.throws(
      () => reporting.collectActivity({ targetRoot: root, date: '23-10-2026' }),
      /Expected YYYY-MM-DD/
    );
  } finally {
    cleanup(root);
  }
});

test('AC1 & AC4: the CLI parses the report activity and report standup subcommands', () => {
  const activity = sdwOrch.parseArgs(['report', 'activity', '--date', '2026-10-23', '--json']);
  assert.equal(activity.subcommand, 'report-activity');
  assert.equal(activity.reportDate, '2026-10-23');
  assert.equal(activity.json, true);
  assert.equal(activity.taskId, null);

  const standup = sdwOrch.parseArgs(['report', 'standup', '--hours', '36']);
  assert.equal(standup.subcommand, 'report-standup');
  assert.equal(standup.reportHours, 36);
  assert.equal(standup.taskId, null);

  const defaultHours = sdwOrch.parseArgs(['report', 'standup']);
  assert.equal(defaultHours.reportHours, null, 'the documented 36h default is applied by the module');
  assert.equal(reporting.DEFAULT_STANDUP_HOURS, 36);
});
