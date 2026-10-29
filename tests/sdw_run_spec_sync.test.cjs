'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');

function makeRoot() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-00071-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });
  return tmpDir;
}

function writeSpec(root, slug, status) {
  const dir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.md`);
  fs.writeFileSync(file, `---\nslug: ${slug}\ntitle: T ${slug}\nstatus: ${status}\n---\n# T\n`, 'utf8');
  return file;
}

// AC3: automation gating defaults to off and never rejects absent keys.
test('00071 AC3: isAutonomousDelivery defaults false, true only when both flags set', () => {
  assert.equal(sdwRun.isAutonomousDelivery(undefined), false);
  assert.equal(sdwRun.isAutonomousDelivery(null), false);
  assert.equal(sdwRun.isAutonomousDelivery({}), false);
  assert.equal(sdwRun.isAutonomousDelivery({ automation: undefined }), false);
  assert.equal(sdwRun.isAutonomousDelivery({ automation: { autoShip: true } }), false);
  assert.equal(sdwRun.isAutonomousDelivery({ automation: { autoMerge: true } }), false);
  assert.equal(sdwRun.isAutonomousDelivery({ automation: { autoShip: true, autoMerge: false } }), false);
  assert.equal(sdwRun.isAutonomousDelivery({ automation: { autoShip: true, autoMerge: true } }), true);
});

// AC1: header sync reuses sdw-spec status machinery (ready-to-implement -> implemented).
test('00071 AC1: syncSpecHeaderImplemented writes implemented via spec machinery', () => {
  const root = makeRoot();
  try {
    const slug = '00071-ac1-sync-check';
    writeSpec(root, slug, 'ready-to-implement');
    execSync('git add -A && git commit -m init', { cwd: root, stdio: 'ignore' });
    const ok = sdwRun.syncSpecHeaderImplemented(root, slug, {});
    assert.equal(ok, true, 'header sync must confirm implemented');
    const content = fs.readFileSync(path.join(root, '.sdw', 'specs', `${slug}.md`), 'utf8');
    assert.match(content, /^status:\s*implemented$/m, 'header must read implemented');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC1 force path: a draft header still lands on implemented (delivery is authoritative).
test('00071 AC1: syncSpecHeaderImplemented forces draft to implemented', () => {
  const root = makeRoot();
  try {
    const slug = '00071-ac1-force-check';
    writeSpec(root, slug, 'draft');
    execSync('git add -A && git commit -m init', { cwd: root, stdio: 'ignore' });
    const ok = sdwRun.syncSpecHeaderImplemented(root, slug, {});
    assert.equal(ok, true);
    const content = fs.readFileSync(path.join(root, '.sdw', 'specs', `${slug}.md`), 'utf8');
    assert.match(content, /^status:\s*implemented$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AC2: delivery file set carries spec file + registry row + evidence together.
test('00071 AC2: collectDeliveryFiles includes spec header file and index with evidence', () => {
  const root = makeRoot();
  try {
    const slug = '00071-ac2-delivery-check';
    const specAbs = writeSpec(root, slug, 'ready-to-implement');
    const specsDir = path.join(root, '.sdw', 'specs');
    fs.writeFileSync(path.join(specsDir, 'index.specs.md'), '# Specification Index\n', 'utf8');
    execSync('git add -A && git commit -m init', { cwd: root, stdio: 'ignore' });
    const relSpec = path.relative(root, specAbs).replace(/\\/g, '/');
    const fakeState = {
      specPath: specAbs,
      steps: { 4: { tasks: { 'task-1': { status: 'completed', filesChanged: ['tracked.txt'] } } } }
    };
    const files = sdwRun.collectDeliveryFiles(root, slug, fakeState);
    assert.ok(files.includes('tracked.txt'), 'evidence file present');
    assert.ok(files.includes('.sdw/specs/index.specs.md'), 'registry present');
    assert.ok(files.includes(relSpec), 'spec header file present in same set');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
