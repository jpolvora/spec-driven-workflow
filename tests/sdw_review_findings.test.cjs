'use strict';

// Spec 00068 AC4/AC5: every Step 7 review finding must be adjudicated before a
// run ships. The tests exercise the two public boundaries: the
// `review dispose` CLI, which writes the disposition to run state, and the
// Step 8 ship gate, which refuses a delivery whose ledger still has
// undisposed findings and names every one of them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');

const ORCH = path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');
const SPEC_SLUG = '00068-review-findings';
const SPEC_BODY = `---
slug: ${SPEC_SLUG}
title: Review Findings Must Be Adjudicated
---
# Review Findings Must Be Adjudicated

## Acceptance Criteria

- AC4: An undisposed Step 7 finding blocks the ship.
- AC5: \`review dispose\` records a disposition.

## New files

\`skills/sdw-orch/scripts/review_findings.cjs\` — the Step 7 review ledger.
`;

function finding(id, file, line, severity, message) {
  return {
    id,
    severity,
    path: `${file}:${line}`,
    file,
    line,
    message,
    status: 'open',
    disposition: null,
    at: null,
    commit: null,
    reason: null
  };
}

const FINDINGS = [
  finding('CR-001', 'skills/sdw-orch/scripts/sdw_orch.cjs', 12, 'warning', 'guard the branch'),
  finding('CR-002', 'skills/sdw-retro/scripts/retro.cjs', 1, 'suggestion', 'split the diff')
];

// A run whose Step 7 ledger is already recorded, so `review dispose` and the
// Step 8 gate read the same shape a real run persists.
function setupReviewRun(findings = FINDINGS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-review-findings-'));
  fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdw', 'specs', `${SPEC_SLUG}.md`), SPEC_BODY, 'utf8');
  const created = stateManager.createRunState({
    root,
    specPath: `.sdw/specs/${SPEC_SLUG}.md`,
    slug: SPEC_SLUG
  });
  const state = stateManager.loadRunState(root, created.runId);
  state.steps[7] = {
    ...state.steps[7],
    name: 'code_review',
    status: 'completed',
    completedAt: '2026-10-24T10:00:00.000Z',
    output: { passed: true, blockingCount: 0, findings: findings.map((entry) => ({ ...entry })) }
  };
  stateManager.saveRunState(root, state);
  return {
    root,
    runId: created.runId,
    specPath: path.join(root, '.sdw', 'specs', `${SPEC_SLUG}.md`),
    statePath: stateManager.getStateFilePath(root, created.runId)
  };
}

function disposeCli(workspace, args) {
  return spawnSync(process.execPath, [
    ORCH, 'review', 'dispose',
    '--root', workspace.root,
    '--run-id', workspace.runId,
    ...args
  ], { cwd: workspace.root, encoding: 'utf8' });
}

function readFindings(workspace) {
  const state = stateManager.loadRunState(workspace.root, workspace.runId);
  return state.steps[7].output.findings;
}

test('AC5: review dispose records a fixed finding with its sha and timestamp', () => {
  const workspace = setupReviewRun();
  try {
    const result = disposeCli(workspace, ['--finding', 'CR-001', '--fixed', 'abc1234def']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[Review\] CR-001 fixed in abc1234def/);

    const findings = readFindings(workspace);
    const disposed = findings.find((entry) => entry.id === 'CR-001');
    assert.equal(disposed.disposition, 'fixed');
    assert.equal(disposed.commit, 'abc1234def', 'AC2: the fixing sha is recorded');
    assert.equal(disposed.reason, null);
    assert.match(disposed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'AC2: the disposition is timestamped');
    assert.equal(findings.find((entry) => entry.id === 'CR-002').disposition, null, 'only the named finding is adjudicated');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC5: review dispose records a waived finding with its rationale and timestamp', () => {
  const workspace = setupReviewRun();
  try {
    const result = disposeCli(workspace, ['--finding', 'CR-002', '--waived', 'accepted: the split is scheduled with spec 00069']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[Review\] CR-002 waived: accepted: the split is scheduled with spec 00069/);

    const findings = readFindings(workspace);
    const disposed = findings.find((entry) => entry.id === 'CR-002');
    assert.equal(disposed.disposition, 'waived');
    assert.equal(disposed.reason, 'accepted: the split is scheduled with spec 00069', 'AC3: the rationale is recorded');
    assert.equal(disposed.commit, null);
    assert.match(disposed.at, /^\d{4}-\d{2}-\d{2}T/, 'AC3: the disposition is timestamped');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC5: review dispose refuses an unknown finding id without writing run state', () => {
  const workspace = setupReviewRun();
  try {
    const before = fs.readFileSync(workspace.statePath, 'utf8');
    const result = disposeCli(workspace, ['--finding', 'CR-999', '--fixed', 'abc1234def']);
    assert.equal(result.status, 1, 'an unknown finding id is refused');
    assert.match(result.stderr, /Unknown finding id "CR-999"/);
    assert.equal(fs.readFileSync(workspace.statePath, 'utf8'), before, 'a refusal writes nothing');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC5: review dispose refuses a missing sha and an empty rationale', () => {
  const workspace = setupReviewRun();
  try {
    const before = fs.readFileSync(workspace.statePath, 'utf8');

    const missingSha = disposeCli(workspace, ['--finding', 'CR-001', '--fixed', '']);
    assert.equal(missingSha.status, 1, 'an empty sha is refused');
    assert.match(missingSha.stderr, /cannot be disposed fixed without a commit sha/);

    const emptyRationale = disposeCli(workspace, ['--finding', 'CR-001', '--waived', '']);
    assert.equal(emptyRationale.status, 1, 'an empty rationale is refused');
    assert.match(emptyRationale.stderr, /cannot be disposed waived without a non-empty rationale/);

    const noDisposition = disposeCli(workspace, ['--finding', 'CR-001']);
    assert.equal(noDisposition.status, 1, 'a bare finding id is refused');
    assert.match(noDisposition.stderr, /needs a disposition/);

    assert.equal(fs.readFileSync(workspace.statePath, 'utf8'), before, 'every refusal writes nothing');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC4: the disposition gate applies to any Step 7 ledger with findings', () => {
  const bothOpen = sdwOrch.evaluateReviewDispositionGate({
    runId: 'run-gate',
    steps: { 7: { status: 'completed', output: { findings: FINDINGS.map((entry) => ({ ...entry })) } } }
  });
  assert.equal(bothOpen.applies, true);
  assert.equal(bothOpen.blocked, true);
  assert.deepEqual(bothOpen.findings, [
    { id: 'CR-001', path: 'skills/sdw-orch/scripts/sdw_orch.cjs:12' },
    { id: 'CR-002', path: 'skills/sdw-retro/scripts/retro.cjs:1' }
  ], 'every undisposed finding is reported with its path');
  assert.match(bothOpen.message, /CR-001 \(skills\/sdw-orch\/scripts\/sdw_orch\.cjs:12\)/);
  assert.match(bothOpen.message, /CR-002 \(skills\/sdw-retro\/scripts\/retro\.cjs:1\)/);
  assert.match(bothOpen.message, /review dispose --run-id run-gate --finding/, 'the message names the remedy');

  const disposed = FINDINGS.map((entry, index) => ({
    ...entry,
    disposition: index === 0 ? 'fixed' : 'waived',
    at: '2026-10-24T10:00:00.000Z',
    commit: index === 0 ? 'abc1234def' : null,
    reason: index === 0 ? null : 'accepted'
  }));
  const allDisposed = sdwOrch.evaluateReviewDispositionGate({
    runId: 'run-gate',
    steps: { 7: { status: 'completed', output: { findings: disposed } } }
  });
  assert.equal(allDisposed.applies, true, 'a completed review ledger reaches the gate');
  assert.equal(allDisposed.blocked, false, 'an adjudicated ledger does not block');
  assert.equal(allDisposed.message, null);

  const skipped = sdwOrch.evaluateReviewDispositionGate({
    runId: 'run-gate',
    steps: { 7: { status: 'skipped', output: { reason: 'Skipped via --skip-review' } } }
  });
  assert.equal(skipped.applies, false, 'a skipped review has no ledger to enforce');

  const empty = sdwOrch.evaluateReviewDispositionGate({
    runId: 'run-gate',
    steps: { 7: { status: 'completed', output: { findings: [] } } }
  });
  assert.equal(empty.applies, false, 'a review with no findings does not block');

  const failedReview = sdwOrch.evaluateReviewDispositionGate({
    runId: 'run-gate',
    steps: { 7: { status: 'review_failed', output: { error: 'unresolved findings', findings: FINDINGS.map((entry) => ({ ...entry })) } } }
  });
  assert.equal(failedReview.blocked, true, 'a failed review that left findings still blocks the ship');
});

function git(root, command) {
  return execSync(`git ${command}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A workspace whose steps before Step 8 are accepted, so `run --step 8`
// exercises only the ship gates against the recorded Step 7 ledger.
function setupShipWorkspace(options = {}) {
  const workspace = setupReviewRun(options.findings || FINDINGS);
  sdwConfig.cmdInit({ root: workspace.root, force: true });
  fs.writeFileSync(path.join(workspace.root, '.gitignore'), '.sdw/state/\n.sdw/worktrees/\n.sdw/sandbox/\n', 'utf8');
  fs.writeFileSync(path.join(workspace.root, 'app.cjs'), '// baseline\n', 'utf8');
  fs.writeFileSync(path.join(workspace.root, '.sdw', 'specs', `${SPEC_SLUG}.md`), SPEC_BODY, 'utf8');

  git(workspace.root, 'init -q');
  git(workspace.root, 'config user.email "test@example.com"');
  git(workspace.root, 'config user.name "SDW Test"');
  git(workspace.root, 'add -A');
  git(workspace.root, 'commit -qm baseline');

  const state = stateManager.loadRunState(workspace.root, workspace.runId);
  for (const step of [1, 2, 3, 4, 5, 6]) {
    state.steps[step].status = 'completed';
    state.steps[step].completedAt = '2026-10-24T09:00:00.000Z';
  }
  state.status = 'in_progress';
  state.score = 9;
  stateManager.saveRunState(workspace.root, state);
  return workspace;
}

function runShipStep(workspace) {
  return spawnSync(process.execPath, [
    ORCH, 'run', workspace.specPath,
    '--root', workspace.root,
    '--run-id', workspace.runId,
    '--step', '8',
    '--min-score', '0',
    '--skip-review',
    '--skip-security'
  ], { cwd: workspace.root, encoding: 'utf8' });
}

test('AC4: Step 8 blocks the ship and names every disposition-missing finding id and path', () => {
  const workspace = setupShipWorkspace();
  try {
    const result = runShipStep(workspace);
    assert.equal(result.status, 1, 'an undisposed ledger blocks the ship with a non-zero exit');
    assert.match(result.stderr, /\[Step 8: Review Gate\] Ship blocked: 2 Step 7 review finding\(s\) have no disposition/);
    assert.match(result.stderr, /CR-001 \(skills\/sdw-orch\/scripts\/sdw_orch\.cjs:12\)/, 'the message names the first finding and its path');
    assert.match(result.stderr, /CR-002 \(skills\/sdw-retro\/scripts\/retro\.cjs:1\)/, 'the message names the second finding and its path');
    assert.doesNotMatch(result.stdout, /Delegating delivery to sdw-ship-pr/, 'ship is never delegated');

    const state = stateManager.loadRunState(workspace.root, workspace.runId);
    assert.equal(state.status, 'failed');
    assert.equal(state.steps[8].status, 'blocked_review');
    assert.match(state.steps[8].error, /Ship blocked: 2 Step 7 review finding/);
    assert.equal(state.reviewDispositionGate.blocked, true);
    assert.deepEqual(state.reviewDispositionGate.findings, [
      { id: 'CR-001', path: 'skills/sdw-orch/scripts/sdw_orch.cjs:12' },
      { id: 'CR-002', path: 'skills/sdw-retro/scripts/retro.cjs:1' }
    ], 'the gate record carries every missing finding');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC4 & AC5: a disposed finding no longer blocks Step 8, and the open one is still named', () => {
  const disposed = FINDINGS.map((entry) => (entry.id === 'CR-001'
    ? { ...entry, disposition: 'fixed', at: '2026-10-24T10:00:00.000Z', commit: 'abc1234def', reason: null }
    : { ...entry }));
  const workspace = setupShipWorkspace({ findings: disposed });
  try {
    const result = runShipStep(workspace);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Ship blocked: 1 Step 7 review finding\(s\) have no disposition: CR-002 \(skills\/sdw-retro\/scripts\/retro\.cjs:1\)/);
    assert.doesNotMatch(result.stderr, /CR-001/, 'a disposed finding is never reported as missing');

    const state = stateManager.loadRunState(workspace.root, workspace.runId);
    assert.equal(state.steps[8].status, 'blocked_review');
    assert.deepEqual(state.reviewDispositionGate.findings, [
      { id: 'CR-002', path: 'skills/sdw-retro/scripts/retro.cjs:1' }
    ]);
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});
