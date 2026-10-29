'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');
const stateManager = require('../skills/sdw-run/scripts/state_manager.cjs');
const specIndex = require('../skills/sdw-spec/scripts/spec_index.cjs');
const specSync = require('../skills/sdw-spec/scripts/spec_sync.cjs');

const SPEC_CHECK = path.join(__dirname, '..', 'skills', 'sdw-spec', 'scripts', 'spec_check.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-00071-t2-'));
}

function writeSpec(root, slug, status) {
  const dir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.md`);
  fs.writeFileSync(file, `---\nslug: ${slug}\ntitle: T ${slug}\nstatus: ${status}\n---\n# T\n`, 'utf8');
  return file;
}

function seedRunState(root, runId, slug) {
  const state = {
    orchestrator: 'sdw-run',
    runId,
    specSlug: slug,
    status: 'failed',
    errors: [{ step: 8, timestamp: '2026-01-01T00:00:00.000Z', error: 'prior error' }],
    steps: {},
    currentStep: 8,
    totalSteps: 8
  };
  stateManager.saveRunState(root, state);
  return state;
}

// AC4: failedDeliveryGates names exactly the failed gates.
test('00071 AC4: failedDeliveryGates reports only non-passed gates', () => {
  assert.deepEqual(sdwRun.failedDeliveryGates(null), []);
  assert.deepEqual(sdwRun.failedDeliveryGates({}), []);
  assert.deepEqual(
    sdwRun.failedDeliveryGates({ tests: { status: 'passed' }, build: { status: 'passed' }}),
    []
  );
  assert.deepEqual(
    sdwRun.failedDeliveryGates({ tests: { status: 'failed' }, build: { status: 'passed' }, security: { status: 'failed' } }),
    ['tests', 'security']
  );
});

// AC4: recordBlockedGate persists a parent-readable blockedGate without losing prior errors.
test('00071 AC4: recordBlockedGate records the blocking gate in run state', () => {
  const root = makeRoot();
  try {
    seedRunState(root, 'run-ac4', '00071-ac4-gate');
    const loaded = stateManager.loadRunState(root, 'run-ac4');
    const returned = sdwRun.recordBlockedGate(root, loaded, 'tests', { step: 4, detail: 'Step 4 verification gates failed' });
    assert.equal(returned.blockedGate.gate, 'tests');
    assert.equal(returned.blockedGate.step, 4);
    assert.ok(returned.blockedGate.at);
    const reloaded = stateManager.loadRunState(root, 'run-ac4');
    assert.equal(reloaded.blockedGate.gate, 'tests');
    assert.equal(reloaded.blockedGate.step, 4);
    assert.equal(reloaded.blockedGate.detail, 'Step 4 verification gates failed');
    // The earlier recordError entry survives: no clobber of fresh disk state.
    assert.ok(reloaded.errors.some(e => e.error === 'prior error'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Input rejection: empty gate names are refused with a descriptive error.
test('00071 AC4: recordBlockedGate rejects invalid gate names', () => {
  const root = makeRoot();
  try {
    seedRunState(root, 'run-ac4rej', '00071-ac4-reject');
    assert.throws(() => sdwRun.recordBlockedGate(root, { runId: 'run-ac4rej' }, ''), /non-empty gate name/);
    assert.throws(() => sdwRun.recordBlockedGate(root, { runId: 'run-ac4rej' }, null), /non-empty gate name/);
    assert.throws(() => sdwRun.recordBlockedGate(root, { runId: 'run-ac4rej' }, 42), /non-empty gate name/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC5: the registry writer preserves foreign trailing sections byte-for-byte.
test('00071 AC5: writeIndex preserves a foreign trailing section', () => {
  const root = makeRoot();
  try {
    const specsDir = path.join(root, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const seed = [
      { prefix: '00071', slug: '00071-ac5-keep', title: 'Keep', status: 'pending', source: 'local', specDate: '2026-10-26', validation: 'PASS', archivalDate: null }
    ];
    specIndex.writeIndex(seed, { root });
    const indexPath = path.join(specsDir, 'index.specs.md');
    const trailing = '\n## Lean-Core Cut (2026-10-25)\n\n- `00071-old`: retired\n- `00070-old`: retired\n';
    fs.appendFileSync(indexPath, trailing, 'utf8');
    const before = fs.readFileSync(indexPath, 'utf8');
    assert.ok(before.endsWith(trailing));

    const updated = [
      { prefix: '00071', slug: '00071-ac5-keep', title: 'Keep', status: 'completed', source: 'local', specDate: '2026-10-26', validation: 'PASS', archivalDate: null }
    ];
    specIndex.writeIndex(updated, { root });
    const after = fs.readFileSync(indexPath, 'utf8');
    assert.ok(after.endsWith(trailing), 'foreign trailing section must survive the rewrite byte-for-byte');
    assert.match(after, /\| 00071 \| 00071-ac5-keep \| Keep \| completed \|/);

    // Idempotent: a second rewrite changes nothing.
    specIndex.writeIndex(updated, { root });
    assert.equal(fs.readFileSync(indexPath, 'utf8'), after);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC5: no trailing content means no extra bytes are added.
test('00071 AC5: writeIndex without trailing content writes a clean table', () => {
  const root = makeRoot();
  try {
    const entries = [
      { prefix: '00072', slug: '00072-clean', title: 'Clean', status: 'pending', source: 'local', specDate: '2026-10-26', validation: 'PASS', archivalDate: null }
    ];
    specIndex.writeIndex(entries, { root });
    const content = fs.readFileSync(path.join(root, '.sdw', 'specs', 'index.specs.md'), 'utf8');
    assert.equal(specIndex.readTrailingBlock(path.join(root, '.sdw', 'specs', 'index.specs.md')), '');
    assert.ok(content.trimEnd().endsWith('|'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC6: divergence between header and registry is reported without mutation.
test('00071 AC6: checkHeaderRegistryDivergence reports drift read-only', () => {
  const root = makeRoot();
  try {
    const slug = '00071-ac6-divergence-check';
    const specFile = writeSpec(root, slug, 'implemented');
    specIndex.writeIndex(
      [{ prefix: '00071', slug, title: 'T', status: 'pending', source: 'local', specDate: '2026-10-26', validation: 'PASS', archivalDate: null }],
      { root }
    );
    const indexPath = path.join(root, '.sdw', 'specs', 'index.specs.md');
    const specBefore = fs.readFileSync(specFile, 'utf8');
    const indexBefore = fs.readFileSync(indexPath, 'utf8');

    const report = specSync.checkHeaderRegistryDivergence(slug, { root });
    assert.equal(report.diverged, true);
    assert.equal(report.headerStatus, 'implemented');
    assert.equal(report.registryStatus, 'pending');
    assert.match(report.message, /Divergence/);

    assert.equal(fs.readFileSync(specFile, 'utf8'), specBefore, 'spec header must be untouched');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBefore, 'registry must be untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC6: matching delivered states are in sync; invalid input is rejected.
test('00071 AC6: in-sync states and input rejection', () => {
  const root = makeRoot();
  try {
    const slug = '00071-ac6-in-sync';
    writeSpec(root, slug, 'implemented');
    specIndex.writeIndex(
      [{ prefix: '00071', slug, title: 'T', status: 'completed', source: 'local', specDate: '2026-10-26', validation: 'PASS', archivalDate: null }],
      { root }
    );
    const inSync = specSync.checkHeaderRegistryDivergence(slug, { root });
    assert.equal(inSync.diverged, false);
    assert.match(inSync.message, /In sync/);

    assert.throws(() => specSync.checkHeaderRegistryDivergence('', { root }), /non-empty specification slug/);
    assert.throws(() => specSync.checkHeaderRegistryDivergence('00071-no-such-spec', { root }), /not found on disk/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC6: the CLI surface prints the divergence and exits non-zero without writing.
test('00071 AC6: spec_check CLI exits 2 on divergence, 0 in sync, 1 on bad input', () => {
  const root = makeRoot();
  try {
    const slug = '00071-ac6-cli-check';
    const specFile = writeSpec(root, slug, 'implemented');
    specIndex.writeIndex(
      [{ prefix: '00071', slug, title: 'T', status: 'pending', source: 'local', specDate: '2026-10-26', validation: 'PASS', archivalDate: null }],
      { root }
    );
    const indexPath = path.join(root, '.sdw', 'specs', 'index.specs.md');
    const specBefore = fs.readFileSync(specFile, 'utf8');
    const indexBefore = fs.readFileSync(indexPath, 'utf8');

    const diverged = spawnSync(process.execPath, [SPEC_CHECK, slug, '--root', root], { encoding: 'utf8' });
    assert.equal(diverged.status, 2);
    assert.match(diverged.stdout, /Divergence/);

    // Repair the registry row in the fixture only, then the CLI must exit 0.
    specIndex.updateSpecStatus(slug, 'completed', { root });
    const synced = spawnSync(process.execPath, [SPEC_CHECK, slug, '--root', root], { encoding: 'utf8' });
    assert.equal(synced.status, 0);
    assert.match(synced.stdout, /In sync/);

    const badInput = spawnSync(process.execPath, [SPEC_CHECK, '--root', root], { encoding: 'utf8' });
    assert.equal(badInput.status, 1);
    assert.match(badInput.stderr, /slug or prefix is required/);

    // The diverged-then-synced fixture proves reporting; the original drifted
    // pair was never auto-repaired by the checker (only the explicit test-side
    // updateSpecStatus call changed it).
    assert.equal(fs.readFileSync(specFile, 'utf8'), specBefore, 'spec header must be untouched by the checker');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00071 AC4: a delivered run clears the stale blockedGate marker', () => {
  const root = makeRoot();
  const runId = 'run-clear-blocked-gate';
  const slug = '00099-gate-clear';
  try {
    let state = seedRunState(root, runId, slug);
    state = sdwRun.recordBlockedGate(root, state, 'convergence', { step: 8, detail: 'did not converge' });
    assert.equal(state.blockedGate.gate, 'convergence');

    const cleared = sdwRun.clearBlockedGate(root, state);
    assert.equal(cleared.blockedGate, undefined, 'blockedGate must be removed on success');

    const onDisk = stateManager.loadRunState(root, runId);
    assert.equal(onDisk.blockedGate, undefined, 'the cleared marker must be persisted');

    // Idempotent: a clean state is returned untouched, without throwing.
    assert.equal(sdwRun.clearBlockedGate(root, onDisk).blockedGate, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
