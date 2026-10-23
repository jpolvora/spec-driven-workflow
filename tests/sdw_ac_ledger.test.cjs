'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const acLedger = require('../skills/sdw-orch/scripts/ac_ledger.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

const ORCH = path.join(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');
const SPEC_REL = '.sdw/specs/ac-ledger-demo.md';

// Spec 00017 AC2: the four fields every ledger record carries.
const RECORD_FIELDS = ['id', 'text', 'status', 'evidence'];

const SPEC = `---
slug: ac-ledger-demo
title: "AC Ledger Demo"
---

# Specification — AC Ledger Demo

## Description

Exercises the acceptance criteria ledger.

## Acceptance Criteria

- AC1: The system shall initialize the ledger in the run artifact directory.
- AC2: The system shall record one ledger record per acceptance criterion.
- AC3: The system shall link typed evidence to one or more criteria.

## Definition of Ready

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Ledger | Available | Inspect the run artifact directory |
`;

function setupProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ac-ledger-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(root, SPEC_REL), SPEC, 'utf8');
  return root;
}

// Seeds a run state and its ledger without running the pipeline, so the link
// cases stay focused on the `ledger link` contract.
function seedRun(root, runId = 'run-ac-ledger-test') {
  const state = stateManager.createRunState({
    root,
    specPath: SPEC_REL,
    slug: 'ac-ledger-demo',
    runId
  });
  const init = acLedger.initLedger({
    root,
    artifactsDir: state.artifactsDir,
    runId: state.runId,
    specSlug: state.specSlug,
    specContent: fs.readFileSync(path.join(root, SPEC_REL), 'utf8'),
    generatedAt: '2026-10-19T12:00:00.000Z'
  });
  return { state, ledgerPath: init.ledgerPath };
}

function link(root, runId, args) {
  return spawnSync(process.execPath, [ORCH, 'ledger', 'link', '--root', root, '--run-id', runId, ...args], {
    encoding: 'utf8'
  });
}

function readLedgerFile(ledgerPath) {
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}

test('AC1 & AC2: a run initializes the ledger with one record per acceptance criterion', () => {
  const root = setupProject();
  try {
    const code = sdwOrch.cmdRun({ root, specPath: SPEC_REL, skipReview: true, skipPr: true });
    assert.equal(code, 4, 'the run pauses after dispatching its first Step 4 task');

    const state = stateManager.findLatestRunState(root);
    const ledgerPath = path.join(root, state.artifactsDir, acLedger.LEDGER_FILENAME);
    assert.ok(fs.existsSync(ledgerPath), 'AC1: ac-ledger.json exists in the run artifact directory');

    const ledger = readLedgerFile(ledgerPath);
    assert.equal(ledger.runId, state.runId, 'the ledger identifies its run');
    assert.equal(ledger.specSlug, 'ac-ledger-demo');
    assert.equal(typeof ledger.generatedAt, 'string');
    assert.deepEqual(
      ledger.criteria.map(record => record.id),
      ['AC1', 'AC2', 'AC3'],
      'AC2: one ledger record per declared criterion, in declaration order'
    );
    for (const record of ledger.criteria) {
      assert.deepEqual(Object.keys(record), RECORD_FIELDS, 'AC2: every record carries id, text, status, and evidence');
      assert.match(record.text, /shall/, 'AC2: the record keeps the criterion text');
      assert.equal(record.status, 'unverified', 'AC2: a criterion starts unverified');
      assert.deepEqual(record.evidence, [], 'AC2: a new record has no evidence yet');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: ledger link accepts one and several AC ids for one evidence payload', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);

    const single = link(root, state.runId, ['--ac', 'AC1', '--type', 'test', '--name', 'ledger contract', '--status', 'passed']);
    assert.equal(single.status, 0, single.stderr);
    let ledger = readLedgerFile(ledgerPath);
    assert.equal(ledger.criteria[0].status, 'verified');
    assert.deepEqual(ledger.criteria[0].evidence, [{ type: 'test', name: 'ledger contract', status: 'passed' }]);
    assert.equal(ledger.criteria[1].status, 'unverified', 'an unlinked criterion stays unverified');

    // The path is given absolute; the stored identity is project-relative with
    // forward slashes so the ledger never depends on the machine.
    const absolutePath = path.join(root, 'skills', 'sdw-orch', 'scripts', 'ac_ledger.cjs');
    const several = link(root, state.runId, ['--ac', 'AC2', 'AC3', '--type', 'file', '--path', absolutePath]);
    assert.equal(several.status, 0, several.stderr);
    ledger = readLedgerFile(ledgerPath);
    for (const id of ['AC2', 'AC3']) {
      const record = ledger.criteria.find(criterion => criterion.id === id);
      assert.equal(record.status, 'verified', `${id} is verified by the shared payload`);
      assert.deepEqual(record.evidence, [{ type: 'file', path: 'skills/sdw-orch/scripts/ac_ledger.cjs' }]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4: ledger link accepts each of the five allowed evidence types', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);
    const cases = [
      ['--type', 'file', '--path', 'skills/sdw-orch/scripts/sdw_orch.cjs'],
      ['--type', 'test', '--name', 'ledger contract', '--status', 'passed'],
      ['--type', 'commit', '--sha', 'a1b2c3d'],
      ['--type', 'review', '--id', 'review-7'],
      ['--type', 'sabotage', '--id', 'sabotage-2']
    ];
    for (const args of cases) {
      const result = link(root, state.runId, ['--ac', 'AC1', ...args]);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    }

    const ledger = readLedgerFile(ledgerPath);
    assert.deepEqual(ledger.criteria[0].evidence, [
      { type: 'file', path: 'skills/sdw-orch/scripts/sdw_orch.cjs' },
      { type: 'test', name: 'ledger contract', status: 'passed' },
      { type: 'commit', sha: 'a1b2c3d' },
      { type: 'review', id: 'review-7' },
      { type: 'sabotage', id: 'sabotage-2' }
    ]);
    assert.equal(ledger.criteria[0].status, 'verified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4: an unknown evidence type is refused without modifying the ledger', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);
    const before = fs.readFileSync(ledgerPath, 'utf8');

    const result = link(root, state.runId, ['--ac', 'AC1', '--type', 'screenshot', '--name', 'proof']);
    assert.notEqual(result.status, 0, 'an unknown evidence type exits non-zero');
    assert.match(result.stderr, /Unknown evidence type "screenshot"/);
    assert.match(result.stderr, /Allowed types: file, test, commit, review, sabotage/);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before, 'the refused link leaves the ledger byte-for-byte unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: the status command never initializes a ledger', () => {
  const root = setupProject();
  try {
    const state = stateManager.createRunState({ root, specPath: SPEC_REL, slug: 'ac-ledger-demo', runId: 'run-status-only' });
    const ledgerPath = path.join(root, state.artifactsDir, acLedger.LEDGER_FILENAME);

    const result = spawnSync(process.execPath, [ORCH, 'status', '--root', root, '--run-id', state.runId], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(ledgerPath), false, 'only a run start initializes the ledger');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
