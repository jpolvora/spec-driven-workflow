'use strict';

// Spec 00023: the read-only delivery reporting suite.
// AC1 proves `report activity --date` produces timesheet entries for a delivery
// day; AC2 the earliest run-artifact start; AC3 the later of the last PR thread
// comment and the delivery commit (with `unknown` when the PR cannot be
// queried); AC4 the `report standup --hours` buckets; AC5 `report explain`
// status, delivered files, verification, and manual test steps; AC6 the
// read-only guarantee across every reporting command; AC7 the stable `--json`
// shape of every command; AC8 that each value is traceable to run state,
// telemetry, the ledger, git, or the registry; AC9 that unavailable evidence is
// the literal `unknown` with a reason; AC10 pins the empty delivery day
// (sections present, zero counts, exit 0); AC11 documents the commands, sources,
// fields, and unknown semantics in `references/reporting.md`; AC12 proves each
// table prints the values its JSON carries. Invalid dates and argument wiring
// are covered as boundary cases.

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

function writeSpecFile(root, slug, content) {
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, `${slug}.md`), content, 'utf8');
}

function writeLedger(root, state, ledger) {
  const dir = artifactsDirAbs(root, state);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ac-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
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

test('AC1 & AC10: an empty delivery day returns an empty report with exit code 0', () => {
  const root = tempRoot('sdw-report-empty-');
  const bareRoot = tempRoot('sdw-report-empty-bare-');
  try {
    const state = baseState();
    writeRunState(root, state, { mtime: '2026-10-23T17:00:00.000Z' });
    writeArtifact(root, state, 'step-1.md', '2026-10-23T09:15:00.000Z');

    const report = reporting.collectActivity({ targetRoot: root, date: '2026-10-22' });
    assert.deepEqual(report.entries, []);
    const rendered = reporting.renderActivity(report);
    assert.match(rendered, /SDW Activity Report/, 'AC10: the sections are present');
    assert.match(rendered, /Date: 2026-10-22/);
    assert.match(rendered, /State: /);
    assert.match(rendered, /Entries: 0/, 'AC10: the count is zero');
    assert.match(rendered, /No delivery activity for 2026-10-22/);

    const text = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-10-22', '--root', root], { encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Entries: 0/);

    const json = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-10-22', '--json', '--root', root], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.command, 'activity');
    assert.equal(parsed.date, '2026-10-22');
    assert.deepEqual(parsed.entries, [], 'AC10: the empty list is present, not omitted');
    assert.deepEqual(parsed.warnings, []);

    // AC10: a workspace that never recorded a run is an empty report too, and
    // reporting must not create the state directory just to answer.
    const bareText = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-10-22', '--root', bareRoot], { encoding: 'utf8' });
    assert.equal(bareText.status, 0, bareText.stderr);
    assert.match(bareText.stdout, /Entries: 0/);
    assert.match(bareText.stdout, /No delivery activity for 2026-10-22/);
    const bareJson = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-10-22', '--json', '--root', bareRoot], { encoding: 'utf8' });
    assert.equal(bareJson.status, 0, bareJson.stderr);
    const bareParsed = JSON.parse(bareJson.stdout);
    assert.deepEqual(bareParsed.entries, []);
    assert.deepEqual(bareParsed.warnings, []);
    assert.equal(fs.existsSync(path.join(bareRoot, '.sdw', 'state')), false, 'AC10: an empty day never initializes the state directory');
  } finally {
    cleanup(root);
    cleanup(bareRoot);
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
    assert.equal(deliveredItem.blockingGate, 'unknown', 'AC9: a run with no gate evidence is unknown, not "none"');
    assert.match(deliveredItem.blockingGateUnknownReason, /records no gate results/);

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

test('AC5: explain shows status, delivered files, verification results, and manual test steps', () => {
  const root = tempRoot('sdw-report-explain-');
  try {
    const state = baseState({
      runId: 'run-explain',
      artifactsDir: '.sdw/state/demo-spec/run-explain',
      score: 9,
      steps: {
        4: {
          name: 'implementation',
          status: 'completed',
          gates: { test: { status: 'passed' }, security: { status: 'passed' } },
          tasks: {
            'task-1': { status: 'completed', filesChanged: ['skills/a.cjs', 'tests/a.test.cjs'] }
          }
        },
        5: { name: 'scoring', status: 'completed', output: { score: 9, minScore: 8, passed: true } },
        7: {
          name: 'code_review',
          status: 'completed',
          output: {
            passed: true,
            blockingCount: 0,
            findings: [{ severity: 'suggestion', file: 'skills/a.cjs', message: 'simplify the branch' }]
          }
        }
      }
    });
    writeRunState(root, state);
    writeSpecIndex(root, [
      { prefix: '00023', slug: 'demo-spec', title: 'Demo Spec', status: 'completed' }
    ]);
    writeSpecFile(
      root,
      'demo-spec',
      '---\nslug: demo-spec\ntitle: "Demo Spec"\n---\n'
        + '## Description\n\nDelivers the reporting suite.\n\n'
        + '## Out of Scope\n\n| Feature | Reason |\n|---|---|\n| Central telemetry upload | Stays local |\n'
    );
    writeLedger(root, state, {
      runId: 'run-explain',
      specSlug: 'demo-spec',
      generatedAt: '2026-10-23T16:00:00.000Z',
      criteria: [
        {
          id: 'AC1',
          text: 'first criterion',
          status: 'verified',
          evidence: [
            { type: 'file', path: 'skills/a.cjs' },
            { type: 'test', name: 'node --test tests/a.test.cjs', status: 'passed' }
          ]
        },
        { id: 'AC2', text: 'second criterion', status: 'unverified', evidence: [] }
      ]
    });
    writeTelemetry(root, state, [
      { ts: '2026-10-23T17:00:00.000Z', runId: 'run-explain', specSlug: 'demo-spec', event: 'step', step: 8, status: 'completed' }
    ]);

    const git = args => {
      if (args[0] === 'show' && args.includes('--name-only')) {
        return 'skills/a.cjs\ndocs/reporting.md\n';
      }
      return '2026-10-23T16:00:00+00:00';
    };
    const report = reporting.collectExplain({
      targetRoot: root,
      spec: 'demo-spec',
      now: '2026-10-23T20:00:00.000Z',
      git
    });

    assert.equal(report.command, 'explain');
    assert.equal(report.specSlug, 'demo-spec');
    assert.equal(report.title, 'Demo Spec');
    assert.equal(report.status, 'completed');
    assert.equal(report.specPath, '.sdw/specs/demo-spec.md');
    assert.equal(report.lifecycle.registryStatus, 'completed');
    assert.equal(report.lifecycle.runId, 'run-explain');
    assert.equal(report.lifecycle.runStatus, 'completed');
    assert.equal(report.lifecycle.currentStep, 8);
    assert.deepEqual(report.lifecycle.steps.map(step => step.step), [4, 5, 7], 'lifecycle lists the recorded steps');

    assert.deepEqual(
      report.deliveredFiles,
      ['docs/reporting.md', 'skills/a.cjs', 'tests/a.test.cjs'],
      'AC5: delivered files are the union of task state, ledger file evidence, and git history'
    );
    assert.deepEqual(report.deliveredFilesSource, ['run-state', 'ac-ledger', 'git']);
    assert.equal(report.deliveredFilesUnknownReason, null);

    assert.equal(report.verification.score, 9);
    assert.equal(report.verification.scoreSource, 'state.score');
    assert.equal(report.verification.minScore, 8);
    assert.equal(report.verification.scorePassed, true);
    assert.deepEqual(report.verification.gates, [
      { name: 'security', status: 'passed' },
      { name: 'test', status: 'passed' }
    ]);
    assert.equal(report.verification.review.outcome, 'passed');
    assert.equal(report.verification.review.stepStatus, 'completed');
    assert.equal(report.verification.review.blockingCount, 0);
    assert.equal(report.verification.review.findings.length, 1);
    assert.equal(report.verification.review.findings[0].severity, 'suggestion');
    assert.equal(report.verification.reviewUnknownReason, null);

    assert.equal(report.acceptanceCriteria.verified.length, 1);
    assert.equal(report.acceptanceCriteria.verified[0].id, 'AC1');
    assert.deepEqual(report.acceptanceCriteria.verified[0].evidence, [
      'file: skills/a.cjs',
      'test: node --test tests/a.test.cjs (passed)'
    ]);
    assert.equal(report.acceptanceCriteria.unverified.length, 1);
    assert.equal(report.acceptanceCriteria.unverified[0].id, 'AC2');

    assert.deepEqual(report.testsObserved, [
      { name: 'node --test tests/a.test.cjs', status: 'passed' }
    ]);
    assert.deepEqual(report.manualTestSteps, [
      'Run recorded test: node --test tests/a.test.cjs (observed: passed)',
      'Manually verify AC2: second criterion'
    ]);
    assert.deepEqual(report.unknowns, []);

    assert.equal(report.description, 'Delivers the reporting suite.', 'AC5: the description comes from the spec body');
    assert.equal(report.descriptionSource, 'spec-file');
    assert.equal(report.descriptionUnknownReason, null);
    assert.deepEqual(
      report.outOfScope,
      [{ item: 'Central telemetry upload', reason: 'Stays local' }],
      'AC5: the out-of-scope table comes from the spec body'
    );
    assert.equal(report.outOfScopeSource, 'spec-file');

    const rendered = reporting.renderExplain(report);
    assert.match(rendered, /SDW Explain Report/);
    assert.match(rendered, /What the feature does/);
    assert.match(rendered, /Delivers the reporting suite\./);
    assert.match(rendered, /Out of scope/);
    assert.match(rendered, /Central telemetry upload/);
    assert.match(rendered, /Status: completed/);
    assert.match(rendered, /Delivered files \(3\)/);
    assert.match(rendered, /- Score: 9\/10 \(minimum 8\) passed/);
    assert.match(rendered, /- Gates: security \(passed\); test \(passed\)/);
    assert.match(rendered, /- Review: passed \(step completed, 0 blocking, 1 finding\(s\)\)/);
    assert.match(rendered, /Verified \(1\)/);
    assert.match(rendered, /Unverified \(1\)/);
    assert.match(rendered, /Tests observed/);
    assert.match(rendered, /Manual test steps/);

    const json = spawnSync(
      process.execPath,
      [ORCH, 'report', 'explain', 'demo-spec', '--json', '--root', root],
      { encoding: 'utf8' }
    );
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.command, 'explain');
    assert.equal(parsed.verification.score, 9);
    assert.ok(parsed.deliveredFiles.includes('skills/a.cjs'));
  } finally {
    cleanup(root);
  }
});

test('AC5 & AC9: explain marks unavailable evidence unknown and rejects an unregistered spec', () => {
  const root = tempRoot('sdw-report-explain-unknown-');
  const runRoot = tempRoot('sdw-report-explain-no-ledger-');
  try {
    writeSpecIndex(root, [
      { prefix: '00024', slug: 'quiet-spec', title: 'Quiet Spec', status: 'pending' }
    ]);
    writeSpecFile(root, 'quiet-spec', '---\nslug: quiet-spec\ntitle: "Quiet Spec"\n---\n');
    const before = snapshotTree(root);

    const report = reporting.collectExplain({
      targetRoot: root,
      spec: 'quiet-spec',
      now: '2026-10-23T20:00:00.000Z',
      git: () => {
        throw new Error('no git');
      }
    });
    assert.equal(report.status, 'pending');
    assert.equal(report.lifecycle.runId, null);
    assert.equal(report.lifecycle.runStatus, 'unknown');
    assert.equal(report.lifecycle.steps, 'unknown');
    assert.equal(report.deliveredFiles, 'unknown');
    assert.match(report.deliveredFilesUnknownReason, /no run state/);
    assert.equal(report.verification.score, 'unknown');
    assert.match(report.verification.scoreUnknownReason, /no score/);
    assert.equal(report.verification.gates, 'unknown');
    assert.equal(report.verification.review.outcome, 'unknown');
    assert.equal(report.acceptanceCriteria.verified, 'unknown');
    assert.equal(report.acceptanceCriteria.unverified, 'unknown');
    assert.match(report.acceptanceCriteria.unknownReason, /no run state/);
    assert.equal(report.testsObserved, 'unknown');
    assert.equal(report.manualTestSteps, 'unknown');
    assert.equal(report.description, 'unknown', 'a spec with no Description section reports unknown');
    assert.match(report.descriptionUnknownReason, /no Description section/);
    assert.equal(report.outOfScope, 'unknown', 'a spec with no Out of Scope table reports unknown');
    assert.match(report.outOfScopeUnknownReason, /no Out of Scope table/);
    assert.ok(report.unknowns.length >= 8, 'every unavailable fact is listed with its reason');

    const rendered = reporting.renderExplain(report);
    assert.match(rendered, /Delivered files \(unknown\)/);
    assert.match(rendered, /unknown \(no run state\)/);
    assert.match(rendered, /Acceptance criteria[\s\S]*unknown/);
    assert.match(rendered, /Manual test steps[\s\S]*unknown/);
    assert.deepEqual(snapshotTree(root), before, 'explain writes nothing, even when every fact is unknown');
    assert.equal(fs.existsSync(path.join(root, '.sdw', 'state')), false, 'explain never initializes the state directory');

    const quietJson = spawnSync(
      process.execPath,
      [ORCH, 'report', 'explain', 'quiet-spec', '--json', '--root', root],
      { encoding: 'utf8' }
    );
    assert.equal(quietJson.status, 0, quietJson.stderr);
    assert.equal(JSON.parse(quietJson.stdout).deliveredFiles, 'unknown');

    // A run that records a score but no ledger: the score is known, every
    // ledger-derived fact is unknown.
    const state = baseState({
      runId: 'run-no-ledger',
      artifactsDir: '.sdw/state/demo-spec/run-no-ledger',
      score: 4
    });
    writeRunState(runRoot, state);
    writeSpecIndex(runRoot, [
      { prefix: '00023', slug: 'demo-spec', title: 'Demo Spec', status: 'pending' }
    ]);
    const noLedger = reporting.collectExplain({
      targetRoot: runRoot,
      spec: 'demo-spec',
      git: () => {
        throw new Error('no git');
      }
    });
    assert.equal(noLedger.verification.score, 4, 'the recorded score is still known');
    assert.equal(noLedger.verification.gates, 'unknown', 'no gate map is recorded');
    assert.match(noLedger.verification.gatesUnknownReason, /no gate results/);
    assert.equal(noLedger.verification.review.outcome, 'unknown');
    assert.equal(noLedger.acceptanceCriteria.verified, 'unknown');
    assert.match(noLedger.acceptanceCriteria.unknownReason, /no acceptance criteria ledger/);
    assert.equal(noLedger.testsObserved, 'unknown');
    assert.equal(noLedger.manualTestSteps, 'unknown');
    assert.equal(noLedger.deliveredFiles, 'unknown');

    const unknownSlug = spawnSync(
      process.execPath,
      [ORCH, 'report', 'explain', 'not-registered', '--root', root],
      { encoding: 'utf8' }
    );
    assert.equal(unknownSlug.status, 1);
    assert.match(unknownSlug.stderr, /Unknown specification "not-registered"/);
    assert.match(unknownSlug.stderr, /sdw_spec\.cjs list/);
    assert.deepEqual(snapshotTree(root), before, 'an unknown specification writes nothing');

    const missingSlug = spawnSync(
      process.execPath,
      [ORCH, 'report', 'explain', '--root', root],
      { encoding: 'utf8' }
    );
    assert.equal(missingSlug.status, 1);
    assert.match(missingSlug.stderr, /requires a specification slug/);
  } finally {
    cleanup(root);
    cleanup(runRoot);
  }
});


test('AC6: reporting commands are read-only and leave the workspace byte-identical', () => {
  const root = tempRoot('sdw-report-readonly-');
  const emptyRoot = tempRoot('sdw-report-readonly-empty-');
  const explainRoot = tempRoot('sdw-report-readonly-explain-');
  try {
    const state = baseState({
      runId: 'run-readonly',
      artifactsDir: '.sdw/state/demo-spec/run-readonly'
    });
    writeRunState(root, state, { mtime: '2026-10-23T17:00:00.000Z' });
    writeArtifact(root, state, 'step-1.md', '2026-10-23T09:15:00.000Z');
    writeLedger(root, state, {
      runId: 'run-readonly',
      specSlug: 'demo-spec',
      generatedAt: '2026-10-23T16:00:00.000Z',
      criteria: [{ id: 'AC1', text: 'first criterion', status: 'unverified', evidence: [] }]
    });
    writeTelemetry(root, state, [
      { ts: '2026-10-23T17:00:00.000Z', runId: 'run-readonly', specSlug: 'demo-spec', event: 'step', step: 8, status: 'completed' }
    ]);
    writeSpecIndex(root, [
      { prefix: '00002', slug: 'next-one', title: 'Next specification', status: 'pending' },
      { prefix: '00023', slug: 'demo-spec', title: 'Demo Spec', status: 'completed' }
    ]);
    writeSpecFile(root, 'demo-spec', '# Demo Spec\n');
    fs.writeFileSync(
      path.join(root, '.sdw', 'config.json'),
      `${JSON.stringify({ stateDir: '{projectRoot}/.sdw/state' }, null, 2)}\n`,
      'utf8'
    );
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
    reporting.collectExplain({
      targetRoot: root,
      spec: 'demo-spec',
      now: '2026-10-23T20:00:00.000Z',
      git: () => {
        throw new Error('offline');
      }
    });
    assert.deepEqual(snapshotTree(root), before, 'the module never writes, creates, or touches a file');

    const activity = spawnSync(process.execPath, [ORCH, 'report', 'activity', '--date', '2026-10-23', '--root', root], { encoding: 'utf8' });
    assert.equal(activity.status, 0, activity.stderr);
    const standup = spawnSync(process.execPath, [ORCH, 'report', 'standup', '--hours', '36', '--root', root], { encoding: 'utf8' });
    assert.equal(standup.status, 0, standup.stderr);
    const explain = spawnSync(process.execPath, [ORCH, 'report', 'explain', 'demo-spec', '--root', root], { encoding: 'utf8' });
    assert.equal(explain.status, 0, explain.stderr);
    assert.match(explain.stdout, /SDW Explain Report/);
    assert.deepEqual(snapshotTree(root), before, 'the CLI never writes a state file, ledger, telemetry event, or sandbox report');

    const emptyBefore = snapshotTree(emptyRoot);
    const emptyReport = spawnSync(process.execPath, [ORCH, 'report', 'standup', '--hours', '36', '--root', emptyRoot], { encoding: 'utf8' });
    assert.equal(emptyReport.status, 0, emptyReport.stderr);
    assert.equal(fs.existsSync(path.join(emptyRoot, '.sdw', 'state')), false, 'reporting never initializes the state directory');
    assert.deepEqual(snapshotTree(emptyRoot), emptyBefore, 'an empty workspace is unchanged');

    // The unknown path is read-only too: a registered spec with no run and no
    // ledger answers with `unknown` and still leaves every file byte-identical.
    writeSpecIndex(explainRoot, [
      { prefix: '00024', slug: 'quiet-spec', title: 'Quiet Spec', status: 'pending' }
    ]);
    const explainBefore = snapshotTree(explainRoot);
    const unknownReport = spawnSync(
      process.execPath,
      [ORCH, 'report', 'explain', 'quiet-spec', '--json', '--root', explainRoot],
      { encoding: 'utf8' }
    );
    assert.equal(unknownReport.status, 0, unknownReport.stderr);
    assert.equal(JSON.parse(unknownReport.stdout).deliveredFiles, 'unknown');
    assert.equal(fs.existsSync(path.join(explainRoot, '.sdw', 'state')), false, 'explain never initializes the state directory');
    assert.deepEqual(snapshotTree(explainRoot), explainBefore, 'the unknown explain path is unchanged');
  } finally {
    cleanup(root);
    cleanup(emptyRoot);
    cleanup(explainRoot);
  }
});

test('AC7: every reporting command emits a stable JSON shape and documents --json', () => {
  const root = tempRoot('sdw-report-json-');
  try {
    writeSpecIndex(root, [
      { prefix: '00024', slug: 'quiet-spec', title: 'Quiet Spec', status: 'pending' }
    ]);
    writeSpecFile(root, 'quiet-spec', '---\nslug: quiet-spec\ntitle: "Quiet Spec"\n---\n');

    const runJson = args => {
      const result = spawnSync(process.execPath, [ORCH, ...args, '--root', root], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const activity = runJson(['report', 'activity', '--date', '2026-10-23', '--json']);
    const standup = runJson(['report', 'standup', '--hours', '36', '--json']);
    const explain = runJson(['report', 'explain', 'quiet-spec', '--json']);

    // AC7: the envelope is pinned, so a field cannot be renamed or dropped
    // without updating this contract.
    assert.deepEqual(
      Object.keys(activity).sort(),
      ['command', 'date', 'entries', 'generatedAt', 'stateDir', 'warnings']
    );
    assert.deepEqual(
      Object.keys(standup).sort(),
      ['command', 'delivered', 'generatedAt', 'hours', 'inProgress', 'next', 'nextUnknownReason', 'stateDir', 'warnings', 'window']
    );
    assert.deepEqual(
      Object.keys(explain).sort(),
      [
        'acceptanceCriteria', 'acceptanceCriteriaSource', 'command', 'deliveredFiles', 'deliveredFilesSource',
        'deliveredFilesUnknownReason', 'description', 'descriptionSource', 'descriptionUnknownReason',
        'generatedAt', 'lifecycle', 'manualTestSteps', 'manualTestStepsSource',
        'manualTestStepsUnknownReason', 'outOfScope', 'outOfScopeSource', 'outOfScopeUnknownReason',
        'specPath', 'specSlug', 'status', 'statusSource', 'statusUnknownReason',
        'testsObserved', 'testsObservedSource', 'testsObservedUnknownReason', 'title', 'titleUnknownReason',
        'unknowns', 'verification', 'warnings'
      ]
    );

    // The same shape carries the values: an empty day is an empty list, and an
    // unavailable fact is literal `unknown`, never an omitted key.
    assert.deepEqual(activity.entries, []);
    assert.equal(standup.command, 'standup');
    assert.deepEqual(standup.next.map(item => item.specSlug), ['quiet-spec']);
    assert.equal(standup.next[0].notStarted, true);
    assert.equal(explain.deliveredFiles, 'unknown');
    assert.equal(explain.verification.score, 'unknown');
    assert.equal(explain.acceptanceCriteria.verified, 'unknown');

    const help = spawnSync(process.execPath, [ORCH, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    for (const command of ['report activity', 'report standup', 'report explain']) {
      assert.match(help.stdout, new RegExp(`${command}[^\\n]*--json`), `${command} documents --json`);
    }
  } finally {
    cleanup(root);
  }
});

test('AC8: every reported value names a traceable source', () => {
  const root = tempRoot('sdw-report-sources-');
  try {
    const now = '2026-10-23T20:00:00.000Z';
    const state = baseState({
      runId: 'run-sources',
      artifactsDir: '.sdw/state/demo-spec/run-sources',
      deliveryCommit: 'commit-sources',
      score: 6,
      updatedAt: '2026-10-23T17:00:00.000Z',
      steps: {
        4: {
          name: 'implementation',
          status: 'completed',
          gates: { test: { status: 'passed' }, security: { status: 'skipped' } },
          tasks: { 'task-1': { status: 'completed', filesChanged: ['skills/state.cjs'] } }
        },
        5: { name: 'scoring', status: 'completed', output: { score: 7, minScore: 8, passed: true } },
        6: { name: 'delivery_commit', status: 'completed', completedAt: '2026-10-23T16:00:00.000Z' },
        7: { name: 'code_review', status: 'completed', output: { passed: true, blockingCount: 0, findings: [] } },
        8: { name: 'pr_preparation', status: 'completed', output: { pullRequest: null } }
      }
    });
    writeRunState(root, state, { mtime: '2026-10-23T17:00:00.000Z' });
    writeArtifact(root, state, 'step-1.md', '2026-10-23T09:00:00.000Z');
    writeSpecIndex(root, [
      { prefix: '00023', slug: 'demo-spec', title: 'Demo Spec', status: 'pending' },
      { prefix: '00024', slug: 'next-spec', title: 'Next Spec', status: 'pending' }
    ]);
    writeSpecFile(
      root,
      'demo-spec',
      '---\nslug: demo-spec\ntitle: "Demo Spec"\n---\n'
        + '## Description\n\nDelivers the reporting suite.\n\n'
        + '## Out of Scope\n\n| Feature | Reason |\n|---|---|\n| Central telemetry upload | Stays local |\n'
    );
    writeLedger(root, state, {
      runId: 'run-sources',
      specSlug: 'demo-spec',
      generatedAt: '2026-10-23T16:00:00.000Z',
      criteria: [
        { id: 'AC1', text: 'ledger file criterion', status: 'verified', evidence: [{ type: 'file', path: 'skills/ledger.cjs' }] }
      ]
    });
    writeTelemetry(root, state, [
      {
        ts: '2026-10-23T18:00:00.000Z',
        runId: 'run-sources',
        specSlug: 'demo-spec',
        event: 'gate',
        step: 4,
        payload: { gates: [{ name: 'review', status: 'failed' }] }
      }
    ]);
    const git = args => {
      if (args.includes('--name-only')) return 'skills/git.cjs\n';
      return '2026-10-23T16:00:00+00:00';
    };

    const activity = reporting.collectActivity({ targetRoot: root, date: '2026-10-23', now, git });
    const entry = activity.entries[0];
    assert.equal(entry.startSource, 'artifact:.sdw/state/demo-spec/run-sources/step-1.md', 'activity start is an artifact clock');
    assert.equal(entry.endSource, 'delivery-commit', 'activity end is the git delivery commit');
    assert.equal(entry.deliveryCommit, 'commit-sources');
    assert.equal(entry.status, 'completed');
    assert.equal(entry.statusSource, 'run-state', 'activity status is run state');

    const standup = reporting.collectStandup({ targetRoot: root, hours: 36, now, git });
    const delivered = standup.delivered[0];
    assert.equal(delivered.deliverySource, 'delivery-commit');
    assert.equal(delivered.lastEventSource, 'telemetry', 'standup last event is the newest telemetry event');
    assert.equal(delivered.lastEventAt, '2026-10-23T18:00:00.000Z');
    assert.deepEqual(
      standup.next.map(item => item.specSlug),
      ['demo-spec', 'next-spec'],
      'standup next items are the pending registry rows'
    );

    const explain = reporting.collectExplain({ targetRoot: root, spec: 'demo-spec', now, git });
    assert.equal(explain.status, 'pending', 'AC8: status is the registry row, not the completed run state');
    assert.equal(explain.statusSource, 'registry');
    assert.equal(explain.lifecycle.runStatus, 'completed');
    assert.equal(explain.title, 'Demo Spec');
    assert.equal(explain.verification.score, 6, 'AC8: a recorded score wins over the Step 5 output');
    assert.equal(explain.verification.scoreSource, 'state.score');
    assert.deepEqual(
      explain.verification.gates,
      [{ name: 'security', status: 'skipped' }, { name: 'test', status: 'passed' }],
      'AC8: recorded gates win over telemetry'
    );
    assert.equal(explain.verification.gatesSource, 'run-state');
    assert.deepEqual(
      explain.deliveredFiles,
      ['skills/git.cjs', 'skills/ledger.cjs', 'skills/state.cjs'],
      'AC8: delivered files are the union of task state, ledger evidence, and git history'
    );
    assert.deepEqual(explain.deliveredFilesSource, ['run-state', 'ac-ledger', 'git']);
    assert.deepEqual(explain.testsObserved, []);
    assert.equal(explain.testsObservedSource, 'ac-ledger');
    assert.equal(explain.acceptanceCriteriaSource, 'ac-ledger');
    assert.equal(explain.manualTestStepsSource, 'ac-ledger');
    assert.deepEqual(explain.unknowns, [], 'every value above is backed by a source');

    // Remove the state-side values: each fallback keeps its own source marker.
    const fallbackState = {
      ...state,
      score: undefined,
      steps: { ...state.steps, 4: { name: 'implementation', status: 'completed' } }
    };
    writeRunState(root, fallbackState, { mtime: '2026-10-23T17:00:00.000Z' });
    const fallback = reporting.collectExplain({ targetRoot: root, spec: 'demo-spec', now, git });
    assert.equal(fallback.verification.score, 7);
    assert.equal(fallback.verification.scoreSource, 'step-5-output');
    assert.deepEqual(fallback.verification.gates, [{ name: 'review', status: 'failed' }]);
    assert.equal(fallback.verification.gatesSource, 'telemetry');
    assert.deepEqual(fallback.deliveredFilesSource, ['ac-ledger', 'git'], 'AC8: files fall back to ledger and git only');
    assert.deepEqual(fallback.deliveredFiles, ['skills/git.cjs', 'skills/ledger.cjs']);
  } finally {
    cleanup(root);
  }
});

test('AC9: missing evidence is literal unknown with a reason, never an inferred value', () => {
  const root = tempRoot('sdw-report-unknown-');
  const explainRoot = tempRoot('sdw-report-unknown-explain-');
  try {
    const now = '2026-10-23T20:00:00.000Z';
    const active = baseState({
      runId: 'run-active-unknown',
      specSlug: 'active-spec',
      status: 'in_progress',
      currentStep: undefined,
      deliveryCommit: null,
      updatedAt: '2026-10-23T18:00:00.000Z',
      artifactsDir: '.sdw/state/active-spec/run-active-unknown',
      steps: { 4: { name: 'implementation', status: 'in_progress' } }
    });
    writeRunState(root, active, { mtime: '2026-10-23T18:00:00.000Z' });

    const noStatus = baseState({
      runId: 'run-no-status',
      status: undefined,
      deliveryCommit: null,
      pullRequest: null,
      artifactsDir: '.sdw/state/demo-spec/run-no-status'
    });
    writeRunState(root, noStatus, { mtime: '2026-10-23T17:00:00.000Z' });
    writeArtifact(root, noStatus, 'step-1.md', '2026-10-23T09:00:00.000Z');

    // AC9: an unreadable registry is `unknown` + reason, not a zero count.
    fs.mkdirSync(path.join(root, '.sdw', 'specs', 'index.specs.md'), { recursive: true });
    const standup = reporting.collectStandup({ targetRoot: root, hours: 36, now, git: () => '2026-10-23T16:00:00+00:00' });
    assert.equal(standup.next, 'unknown');
    assert.match(standup.nextUnknownReason, /specification index could not be read/);
    assert.equal(standup.warnings.length, 1);
    assert.equal(standup.inProgress.length, 1);
    assert.equal(standup.inProgress[0].currentStep, null);
    assert.match(standup.inProgress[0].stepUnknownReason, /records no current step/);
    const standupRendered = reporting.renderStandup(standup);
    assert.match(standupRendered, /Next \(unknown\)/);
    assert.match(standupRendered, /unknown \(the specification index could not be read/);
    assert.match(standupRendered, /unknown \(the run state records no current step\)/);
    assert.doesNotMatch(standupRendered, /not started/, 'a run with no recorded step is unknown, not "not started"');

    // AC9: activity reports a missing status and commit as literal unknown.
    const activity = reporting.collectActivity({
      targetRoot: root,
      date: '2026-10-23',
      now,
      git: () => '2026-10-23T16:00:00+00:00'
    });
    assert.equal(activity.entries.length, 1);
    const entry = activity.entries[0];
    assert.equal(entry.status, 'unknown');
    assert.equal(entry.statusSource, null);
    assert.match(entry.statusUnknownReason, /records no status/);
    assert.equal(entry.deliveryCommit, 'unknown');
    assert.match(entry.deliveryCommitUnknownReason, /records no delivery commit/);
    const activityRendered = reporting.renderActivity(activity);
    assert.match(activityRendered, /unknown \(the run state records no status\)/);
    assert.match(activityRendered, /unknown \(the run state records no delivery commit\)/);

    // A readable registry restores the list, and a pending row still says
    // "not started" because it genuinely has no run.
    fs.rmSync(path.join(root, '.sdw', 'specs', 'index.specs.md'), { recursive: true, force: true });
    writeSpecIndex(root, [{ prefix: '00030', slug: 'next-spec', title: 'Next Spec', status: 'pending' }]);
    const readable = reporting.collectStandup({ targetRoot: root, hours: 36, now, git: () => '2026-10-23T16:00:00+00:00' });
    assert.deepEqual(readable.next.map(item => item.specSlug), ['next-spec']);
    assert.equal(readable.nextUnknownReason, null);
    assert.equal(readable.next[0].notStarted, true);
    assert.match(reporting.renderStandup(readable), /not started/);

    // AC9: explain marks a title and update time that the evidence lacks.
    writeSpecIndex(explainRoot, [{ prefix: '00031', slug: 'bare-spec', title: '', status: 'pending' }]);
    writeSpecFile(explainRoot, 'bare-spec', '# Bare Spec\n');
    const bareState = baseState({
      runId: 'run-bare',
      specSlug: 'bare-spec',
      updatedAt: undefined,
      artifactsDir: '.sdw/state/bare-spec/run-bare'
    });
    writeRunState(explainRoot, bareState, { mtime: '2026-10-23T17:00:00.000Z' });
    const explain = reporting.collectExplain({
      targetRoot: explainRoot,
      spec: 'bare-spec',
      now,
      git: () => {
        throw new Error('no git');
      }
    });
    assert.equal(explain.title, 'unknown');
    assert.match(explain.titleUnknownReason, /records a title/);
    assert.equal(explain.lifecycle.updatedAt, 'unknown');
    assert.match(explain.lifecycle.updatedAtUnknownReason, /records no update time/);
    assert.ok(explain.unknowns.some(item => item.field === 'title'));
    assert.ok(explain.unknowns.some(item => item.field === 'lifecycle.updatedAt'));
    const explainRendered = reporting.renderExplain(explain);
    assert.match(explainRendered, /Title: unknown \(neither the registry row/);
    assert.match(explainRendered, /Updated: unknown \(the run state records no update time\)/);
  } finally {
    cleanup(root);
    cleanup(explainRoot);
  }
});

test('AC12: the activity, standup, and explain tables print the values their JSON carries', () => {
  const runRoot = tempRoot('sdw-report-parity-run-');
  const standupRoot = tempRoot('sdw-report-parity-standup-');
  try {
    const state = baseState({
      runId: 'run-parity',
      artifactsDir: '.sdw/state/demo-spec/run-parity',
      deliveryCommit: 'abc123'
    });
    writeRunState(runRoot, state, { mtime: '2026-10-23T17:00:00.000Z' });
    writeArtifact(runRoot, state, 'step-1.md', '2026-10-23T09:15:00.000Z');
    writeLedger(runRoot, state, {
      runId: 'run-parity',
      specSlug: 'demo-spec',
      generatedAt: '2026-10-23T16:00:00.000Z',
      criteria: [
        {
          id: 'AC1',
          text: 'first criterion',
          status: 'verified',
          evidence: [
            { type: 'file', path: 'skills/demo.cjs' },
            { type: 'test', name: 'node --test tests/demo.test.cjs', status: 'passed' }
          ]
        },
        { id: 'AC2', text: 'second criterion', status: 'unverified', evidence: [] }
      ]
    });
    writeSpecIndex(runRoot, [{ prefix: '00023', slug: 'demo-spec', title: 'Demo Spec', status: 'pending' }]);
    writeSpecFile(runRoot, 'demo-spec', '---\nslug: demo-spec\ntitle: "Demo Spec"\n---\n');

    const activityArgs = ['report', 'activity', '--date', '2026-10-23'];
    const activityJson = spawnSync(process.execPath, [ORCH, ...activityArgs, '--json', '--root', runRoot], { encoding: 'utf8' });
    assert.equal(activityJson.status, 0, activityJson.stderr);
    const activity = JSON.parse(activityJson.stdout);
    assert.equal(activity.entries.length, 1);
    const entry = activity.entries[0];
    assert.equal(entry.specSlug, 'demo-spec');
    assert.equal(entry.runId, 'run-parity');
    assert.equal(entry.start, '2026-10-23T09:15:00.000Z');
    assert.equal(entry.startSource, 'artifact:.sdw/state/demo-spec/run-parity/step-1.md');
    assert.equal(entry.status, 'completed');
    assert.equal(entry.deliveryCommit, 'abc123');
    assert.equal(entry.end, 'unknown', 'AC3: the CLI has no PR provider and cannot read the fake commit');
    assert.match(entry.endUnknownReason, /no PR and no delivery commit timestamp/);
    assert.equal(entry.duration, 'unknown');

    const activityText = spawnSync(process.execPath, [ORCH, ...activityArgs, '--root', runRoot], { encoding: 'utf8' });
    assert.equal(activityText.status, 0, activityText.stderr);
    assert.match(activityText.stdout, /\| demo-spec \| run-parity \|/);
    for (const value of [
      entry.start,
      entry.status,
      entry.deliveryCommit,
      'unknown (no PR and no delivery commit timestamp)'
    ]) {
      assert.ok(activityText.stdout.includes(value), `the activity table prints ${value}`);
    }

    // A registry-only workspace has no clock-sensitive rows, so the standup
    // counts are deterministic: zero delivered, zero in progress, one pending.
    writeSpecIndex(standupRoot, [{ prefix: '00024', slug: 'next-spec', title: 'Next Spec', status: 'pending' }]);
    const standupText = spawnSync(process.execPath, [ORCH, 'report', 'standup', '--hours', '36', '--root', standupRoot], { encoding: 'utf8' });
    assert.equal(standupText.status, 0, standupText.stderr);
    assert.match(standupText.stdout, /Delivered \(0\)/);
    assert.match(standupText.stdout, /In progress \(0\)/);
    assert.match(standupText.stdout, /Next \(1\)/);
    assert.match(standupText.stdout, /\| next-spec \| Next Spec \| pending \| not started \| unknown \|/);

    const standupJson = spawnSync(process.execPath, [ORCH, 'report', 'standup', '--hours', '36', '--json', '--root', standupRoot], { encoding: 'utf8' });
    assert.equal(standupJson.status, 0, standupJson.stderr);
    const standup = JSON.parse(standupJson.stdout);
    assert.equal(standup.hours, 36);
    assert.deepEqual(standup.delivered, []);
    assert.deepEqual(standup.inProgress, []);
    assert.equal(standup.next.length, 1);
    const next = standup.next[0];
    assert.equal(next.specSlug, 'next-spec');
    assert.equal(next.title, 'Next Spec');
    assert.equal(next.status, 'pending');
    assert.equal(next.notStarted, true);
    assert.equal(next.currentStep, null);
    assert.equal(next.lastEventAt, 'unknown');

    const explainJson = spawnSync(process.execPath, [ORCH, 'report', 'explain', 'demo-spec', '--json', '--root', runRoot], { encoding: 'utf8' });
    assert.equal(explainJson.status, 0, explainJson.stderr);
    const explain = JSON.parse(explainJson.stdout);
    assert.equal(explain.command, 'explain');
    assert.equal(explain.status, 'pending');
    assert.equal(explain.statusSource, 'registry');
    assert.equal(explain.lifecycle.runId, 'run-parity');
    assert.deepEqual(explain.deliveredFiles, ['skills/demo.cjs']);
    assert.deepEqual(explain.deliveredFilesSource, ['ac-ledger']);
    assert.deepEqual(explain.testsObserved, [{ name: 'node --test tests/demo.test.cjs', status: 'passed' }]);
    assert.equal(explain.acceptanceCriteria.verified.length, 1);
    assert.equal(explain.acceptanceCriteria.unverified.length, 1);
    assert.deepEqual(explain.manualTestSteps, [
      'Run recorded test: node --test tests/demo.test.cjs (observed: passed)',
      'Manually verify AC2: second criterion'
    ]);

    const explainText = spawnSync(process.execPath, [ORCH, 'report', 'explain', 'demo-spec', '--root', runRoot], { encoding: 'utf8' });
    assert.equal(explainText.status, 0, explainText.stderr);
    for (const value of [
      'Status: pending',
      'Delivered files (1)',
      '- skills/demo.cjs',
      'Source: ac-ledger',
      'Verified (1)',
      'Unverified (1)',
      '- node --test tests/demo.test.cjs (passed)',
      '1. Run recorded test: node --test tests/demo.test.cjs (observed: passed)',
      '2. Manually verify AC2: second criterion'
    ]) {
      assert.ok(explainText.stdout.includes(value), `the explain table prints ${value}`);
    }
  } finally {
    cleanup(runRoot);
    cleanup(standupRoot);
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

test('AC1, AC4 & AC5: the CLI parses the report activity, standup, and explain subcommands', () => {
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

  const explain = sdwOrch.parseArgs(['report', 'explain', 'demo-spec']);
  assert.equal(explain.subcommand, 'report-explain');
  assert.equal(explain.reportSpec, 'demo-spec');
  assert.equal(explain.taskId, null);
  assert.deepEqual(explain.specPaths, [], 'the slug is a report target, never an execution path');
});
