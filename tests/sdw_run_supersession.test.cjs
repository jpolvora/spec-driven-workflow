'use strict';

// Spec 00071: a superseded run is terminal. These cases prove the recorded
// supersession (AC1), the monitor's terminal classification (AC2), and the
// refusal that names the replacing run in both paths that can continue a run:
// `resume --run-id` (AC3) and `run --run-id` (AC2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const monitor = require('../skills/sdw-orch/scripts/monitor.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ORCH = path.join(REPO_ROOT, 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-supersession-'));
  fs.mkdirSync(path.join(root, '.sdw', 'state'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeState(root, state) {
  fs.writeFileSync(
    path.join(root, '.sdw', 'state', `${state.runId}.state.json`),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8'
  );
}

function readStateFile(root, runId) {
  return JSON.parse(fs.readFileSync(stateManager.getStateFilePath(root, runId), 'utf8'));
}

test('00071 AC1: superseding a run records the status, the replacing run id, and the timestamp', (t) => {
  const root = makeProject(t);
  const created = stateManager.createRunState({ root, slug: '00071-fixture', runId: 'run-00071-replaced' });
  assert.equal(created.status, 'in_progress', 'a fresh run starts open');

  const marked = stateManager.markRunSuperseded(root, 'run-00071-replaced', 'run-00071-replacement');
  assert.equal(marked.status, 'superseded');
  assert.equal(marked.supersededBy, 'run-00071-replacement');
  assert.ok(Number.isFinite(Date.parse(marked.supersededAt)), 'the supersession timestamp is a parseable ISO date');

  const onDisk = readStateFile(root, 'run-00071-replaced');
  assert.equal(onDisk.status, 'superseded', 'the terminal status is persisted');
  assert.equal(onDisk.supersededBy, 'run-00071-replacement', 'the replacing run id is persisted');
  assert.equal(onDisk.supersededAt, marked.supersededAt, 'the timestamp is persisted');
  assert.ok(onDisk.revision > created.revision, 'the durable write advances the revision');
  assert.equal(onDisk.steps[1].status, 'pending', 'the replaced run state is otherwise left intact as audit evidence');
});

test('00071 AC1: superseding without a replacing run id is refused and leaves the state untouched', (t) => {
  const root = makeProject(t);
  stateManager.createRunState({ root, slug: '00071-fixture', runId: 'run-00071-unmarked' });

  assert.throws(
    () => stateManager.markRunSuperseded(root, 'run-00071-unmarked', '   '),
    /replacing run id/,
    'an empty replacing run id is not a supersession record'
  );

  const onDisk = readStateFile(root, 'run-00071-unmarked');
  assert.equal(onDisk.status, 'in_progress', 'the refused write did not supersede the run');
  assert.equal(onDisk.supersededBy, undefined);
  assert.equal(onDisk.supersededAt, undefined);
});

test('00071 AC2: the monitor classifies a superseded run as terminal and never lists it active', (t) => {
  const root = makeProject(t);
  const now = '2026-01-02T00:00:00.000Z';
  writeState(root, {
    runId: 'run-00071-monitor-replaced',
    specSlug: '00071-fixture',
    status: 'superseded',
    supersededBy: 'run-00071-monitor-replacement',
    supersededAt: '2026-01-01T12:00:00.000Z',
    currentStep: 3,
    totalSteps: 8,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    artifactsDir: '.sdw/state/00071-fixture/run-00071-monitor-replaced',
    steps: { 3: { name: 'dag_generation', status: 'in_progress' } }
  });
  writeState(root, {
    runId: 'run-00071-monitor-open',
    specSlug: '00071-fixture',
    status: 'in_progress',
    currentStep: 4,
    totalSteps: 8,
    createdAt: '2026-01-01T23:00:00.000Z',
    updatedAt: '2026-01-01T23:30:00.000Z',
    artifactsDir: '.sdw/state/00071-fixture/run-00071-monitor-open',
    steps: { 4: { name: 'implementation', status: 'in_progress' } }
  });

  assert.equal(monitor.isTerminalStatus('superseded'), true, 'superseded is a terminal status');

  const discovered = monitor.discoverRuns({ targetRoot: root, now });
  const replaced = discovered.runs.find(run => run.runId === 'run-00071-monitor-replaced');
  assert.ok(replaced, 'the superseded run is still discoverable');
  assert.equal(replaced.classification, 'terminal', 'AC2: the monitor classifies it as terminal, not stalled or active');

  const active = monitor.listActiveRuns({ targetRoot: root, now }).runs.map(run => run.runId);
  assert.ok(!active.includes('run-00071-monitor-replaced'), 'AC2: a superseded run is history, never an active run');
  assert.ok(active.includes('run-00071-monitor-open'), 'the genuinely open run is still watched');
});

test('00071 AC3: resuming a superseded run is refused and names the replacing run', (t) => {
  const root = makeProject(t);
  stateManager.createRunState({ root, slug: '00071-fixture', runId: 'run-00071-resume-replaced' });
  stateManager.markRunSuperseded(root, 'run-00071-resume-replaced', 'run-00071-resume-replacement');
  const before = readStateFile(root, 'run-00071-resume-replaced');

  const result = spawnSync(process.execPath, [ORCH, 'resume', '--run-id', 'run-00071-resume-replaced', '--root', root], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1, 'a superseded run never resumes');
  const stderr = String(result.stderr || '');
  assert.match(stderr, /Refusing to resume run "run-00071-resume-replaced"/, 'the refusal names the superseded run');
  assert.match(stderr, /superseded/, 'the refusal says the run was superseded');
  assert.ok(stderr.includes('run-00071-resume-replacement'), 'AC3: the refusal names the replacing run');
  assert.match(stderr, /resume --run-id run-00071-resume-replacement/, 'the remediation points at the replacing run');
  assert.doesNotMatch(String(result.stdout || ''), /Resuming from step/, 'no work started');

  const after = readStateFile(root, 'run-00071-resume-replaced');
  assert.equal(after.status, 'superseded', 'the refusal does not resurrect the run');
  assert.equal(after.revision, before.revision, 'the refusal writes nothing');
});

// The run path restores an explicit --run-id instead of creating a run, so it
// needs the same terminal check: without it the replaced run silently continues.
test('00071 AC2: running a superseded run is refused before any work and names the replacing run', (t) => {
  const root = makeProject(t);
  stateManager.createRunState({ root, slug: '00071-fixture', runId: 'run-00071-run-replaced' });
  stateManager.markRunSuperseded(root, 'run-00071-run-replaced', 'run-00071-run-replacement');
  const before = readStateFile(root, 'run-00071-run-replaced');

  const result = spawnSync(process.execPath, [ORCH, 'run', '--run-id', 'run-00071-run-replaced', '--root', root], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1, 'the run path never continues a superseded run');
  const stderr = String(result.stderr || '');
  assert.match(stderr, /Refusing to run "run-00071-run-replaced"/, 'the refusal names the superseded run');
  assert.match(stderr, /superseded/, 'the refusal says the run was superseded');
  assert.ok(stderr.includes('run-00071-run-replacement'), 'AC2: the refusal names the replacing run');
  assert.match(stderr, /resume --run-id run-00071-run-replacement/, 'the remediation points at the replacing run');
  assert.doesNotMatch(stderr, /Specification file not found/, 'the refusal precedes specification, configuration, and branch work');

  const after = readStateFile(root, 'run-00071-run-replaced');
  assert.equal(after.status, 'superseded', 'the refusal does not resurrect the run');
  assert.equal(after.revision, before.revision, 'the refusal writes nothing');
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.sdw', 'state')).filter((name) => name.endsWith('.state.json')),
    ['run-00071-run-replaced.state.json'],
    'no run state was created for the refused run'
  );
});

test('00071 AC2: a superseded run without a recorded replacer is refused naming "unknown"', (t) => {
  const root = makeProject(t);
  writeState(root, {
    runId: 'run-00071-run-orphan',
    specSlug: '00071-fixture',
    status: 'superseded',
    currentStep: 2,
    totalSteps: 8,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    artifactsDir: '.sdw/state/00071-fixture/run-00071-run-orphan'
  });

  const result = spawnSync(process.execPath, [ORCH, 'run', '--run-id', 'run-00071-run-orphan', '--root', root], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1, 'a superseded run is terminal even without a replacer');
  const stderr = String(result.stderr || '');
  assert.match(stderr, /Refusing to run "run-00071-run-orphan"/, 'the refusal names the superseded run');
  assert.match(stderr, /by run "unknown"/, 'the refusal never invents a replacing run');
});
