'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

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

// Spec 00017 AC7/AC8: four criteria prove round(3 / 4 * 10) = 8.
const FOUR_AC_SPEC = `---
slug: ac-ledger-score
title: "AC Ledger Score"
---

# Specification — AC Ledger Score

## Description

Exercises ledger-derived scoring.

## Acceptance Criteria

- AC1: The system shall record the first criterion.
- AC2: The system shall record the second criterion.
- AC3: The system shall record the third criterion.
- AC4: The system shall record the fourth criterion.
`;

const SCORE_SPEC_REL = '.sdw/specs/ac-ledger-score.md';

function setupProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ac-ledger-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(root, SPEC_REL), SPEC, 'utf8');
  return root;
}

// A git-backed project for the task-finish case: the checkpoint commit needs a
// real repository, and corroboration needs a tracked, changed file.
function setupGitProject() {
  const root = setupProject();
  execSync('git init -q', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'demo.cjs'), '// baseline\n', 'utf8');
  execSync('git add .sdw skills/demo.cjs', { cwd: root, stdio: 'ignore' });
  execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });
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

// Seeds a run paused at Step 5 awaiting a judge verdict, so the scoring cases do
// not pay for the earlier pipeline steps.
function seedScoringRun(root, options = {}) {
  const runId = options.runId || 'run-ac-ledger-score';
  const state = stateManager.createRunState({ root, specPath: SCORE_SPEC_REL, slug: 'ac-ledger-score', runId });
  for (const step of [1, 2, 3, 4]) {
    stateManager.updateStepState(root, state.runId, step, 'completed', {});
  }
  stateManager.updateStepState(root, state.runId, 5, 'awaiting_judgment', options.step5Output || null);
  return stateManager.loadRunState(root, state.runId);
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

test('AC5: ledger link rejects an unknown AC id without modifying the ledger', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);
    const before = fs.readFileSync(ledgerPath, 'utf8');

    const unknown = link(root, state.runId, ['--ac', 'AC9', '--type', 'test', '--name', 'nope', '--status', 'passed']);
    assert.notEqual(unknown.status, 0, 'an unknown AC id exits non-zero');
    assert.match(unknown.stderr, /Unknown acceptance criterion: AC9/);
    assert.match(unknown.stderr, /not modified/i);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before, 'the rejected link leaves the ledger byte-for-byte unchanged');

    // One unknown id refuses the whole payload: the known id is not linked either.
    const mixed = link(root, state.runId, ['--ac', 'AC1', 'AC9', '--type', 'commit', '--sha', 'abc1234']);
    assert.notEqual(mixed.status, 0, 'a mixed known/unknown payload is rejected');
    assert.match(mixed.stderr, /AC9/);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before, 'no criterion from the refused payload was written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC6: task finish links the accepted files and checkpoint commit to the claimed ACs', () => {
  const root = setupGitProject();
  try {
    const code = sdwOrch.cmdRun({ root, specPath: SPEC_REL, skipReview: true, skipPr: true });
    assert.equal(code, 4, 'the run pauses after dispatching its first Step 4 task');
    const state = stateManager.findLatestRunState(root);
    const taskId = state.steps[4].dispatch.activeTaskId;
    assert.ok(taskId, 'a task is dispatched');

    fs.appendFileSync(path.join(root, 'skills', 'demo.cjs'), '// task work\n');
    const evidencePath = path.join(root, `${taskId}.evidence.json`);
    fs.writeFileSync(evidencePath, JSON.stringify({
      taskId,
      status: 'success',
      acIds: ['AC1', 'AC2'],
      filesChanged: ['skills/demo.cjs'],
      tests: [],
      summary: `${taskId} linked its evidence`
    }), 'utf8');

    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath }), 0, 'the task is accepted');

    const accepted = stateManager.loadRunState(root, state.runId);
    const commitSha = accepted.steps[4].tasks[taskId].commitSha;
    assert.match(String(commitSha), /^[0-9a-f]{7,40}$/, 'the accepted task records its checkpoint commit');

    const ledger = readLedgerFile(path.join(root, accepted.artifactsDir, acLedger.LEDGER_FILENAME));
    for (const id of ['AC1', 'AC2']) {
      const record = ledger.criteria.find(criterion => criterion.id === id);
      assert.equal(record.status, 'verified', `${id} is verified by the accepted task`);
      assert.deepEqual(record.evidence, [
        { type: 'file', path: 'skills/demo.cjs', taskId },
        { type: 'commit', sha: commitSha, taskId }
      ], `${id} links the project-relative file and the checkpoint commit with its task`);
    }
    assert.equal(ledger.criteria.find(criterion => criterion.id === 'AC3').status, 'unverified',
      'an AC the evidence never claimed stays unverified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC7 & AC8: the score counts only evidenced records and rounds verified/total*10', () => {
  const ledger = acLedger.buildLedger({
    runId: 'run-score-demo',
    specSlug: 'ac-ledger-score',
    specContent: FOUR_AC_SPEC,
    generatedAt: '2026-10-19T12:00:00.000Z'
  });
  assert.equal(ledger.criteria.length, 4);
  for (const record of ledger.criteria.slice(0, 3)) {
    record.status = 'verified';
    record.evidence = [{ type: 'test', name: `covers ${record.id}`, status: 'passed' }];
  }

  const derived = acLedger.deriveScore(ledger);
  assert.equal(derived.totalAcs, 4);
  assert.equal(derived.evidencedCount, 3);
  assert.equal(derived.verifiedCount, 3);
  assert.equal(derived.score, 8, 'AC8: round(3 / 4 * 10) = 8');

  // AC7: a verified status without an evidence entry is not counted.
  ledger.criteria[3].status = 'verified';
  const withoutEvidence = acLedger.deriveScore(ledger);
  assert.equal(withoutEvidence.verifiedCount, 3);
  assert.equal(withoutEvidence.score, 8, 'only records with at least one evidence entry count');

  // AC8: the formula rounds the derived ratio.
  const thirds = {
    criteria: ['AC1', 'AC2', 'AC3'].map(id => ({
      id,
      text: `criterion ${id}`,
      status: 'verified',
      evidence: [{ type: 'test', name: id, status: 'passed' }]
    }))
  };
  thirds.criteria[1].status = 'unverified';
  thirds.criteria[1].evidence = [];
  thirds.criteria[2].status = 'unverified';
  thirds.criteria[2].evidence = [];
  assert.equal(acLedger.deriveScore(thirds).score, 3, 'round(1 / 3 * 10) = 3');
  thirds.criteria[1].status = 'verified';
  thirds.criteria[1].evidence = [{ type: 'test', name: 'AC2', status: 'passed' }];
  assert.equal(acLedger.deriveScore(thirds).score, 7, 'round(2 / 3 * 10) = 7');

  assert.equal(acLedger.deriveScore({ criteria: [] }).score, 0, 'a ledger with no criteria scores 0');
});

test('AC7 & AC8: score submit records the judge verdicts and derives the score from the ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ac-ledger-score-'));
  try {
    fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, SCORE_SPEC_REL), FOUR_AC_SPEC, 'utf8');

    const state = seedScoringRun(root, { step5Output: { judgeAcIds: ['AC1', 'AC2', 'AC3'] } });
    const init = acLedger.initLedger({
      root,
      artifactsDir: state.artifactsDir,
      runId: state.runId,
      specSlug: state.specSlug,
      specContent: FOUR_AC_SPEC,
      generatedAt: '2026-10-19T12:00:00.000Z'
    });
    const seeded = acLedger.linkEvidence({
      root,
      ledgerPath: init.ledgerPath,
      acIds: ['AC1', 'AC2', 'AC3'],
      evidence: { type: 'file', path: 'skills/demo.cjs' }
    });
    assert.equal(seeded.ok, true, JSON.stringify(seeded.errors));

    const verdictPath = path.join(root, 'verdict.json');
    fs.writeFileSync(verdictPath, JSON.stringify({
      score: 10,
      verdicts: ['AC1', 'AC2', 'AC3'].map(id => ({ id, verdict: 'verified', evidence: 'skills/demo.cjs:1' }))
    }), 'utf8');

    assert.equal(sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath }), 0);
    const submitted = stateManager.loadRunState(root, state.runId);
    assert.equal(submitted.score, 8, '3 of 4 verified scores 8, not the 3-of-3 verdict score');
    assert.equal(submitted.steps[5].output.totalAcs, 4);
    assert.equal(submitted.steps[5].output.verifiedCount, 3);
    assert.deepEqual(submitted.steps[5].output.failingAcs.map(item => item.id), ['AC4']);

    let ledger = readLedgerFile(init.ledgerPath);
    assert.equal(acLedger.deriveScore(ledger).score, submitted.score, 'the reported score equals the ledger-derived score');
    for (const id of ['AC1', 'AC2', 'AC3']) {
      const record = ledger.criteria.find(criterion => criterion.id === id);
      assert.equal(record.status, 'verified');
      assert.ok(
        record.evidence.some(entry => entry.type === 'review' && entry.status === 'passed' && entry.id === 'step5-submitted'),
        `${id} carries the passed Step 5 review evidence`
      );
    }
    assert.equal(ledger.criteria.find(criterion => criterion.id === 'AC4').status, 'unverified');

    // AC7: a failed verdict clears a verified criterion and is never promoted.
    fs.writeFileSync(verdictPath, JSON.stringify({
      score: 5,
      verdicts: [
        { id: 'AC1', verdict: 'failed', evidence: 'the behaviour is missing' },
        { id: 'AC2', verdict: 'verified', evidence: 'skills/demo.cjs:1' },
        { id: 'AC3', verdict: 'verified', evidence: 'skills/demo.cjs:1' },
        { id: 'AC4', verdict: 'failed', evidence: 'the behaviour is missing' }
      ]
    }), 'utf8');
    assert.equal(sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath }), 2, '2 of 4 verified is below the threshold');

    const rescored = stateManager.loadRunState(root, state.runId);
    assert.equal(rescored.score, 5);
    ledger = readLedgerFile(init.ledgerPath);
    const ac1 = ledger.criteria.find(criterion => criterion.id === 'AC1');
    assert.equal(ac1.status, 'failed', 'AC7: a failed verdict never leaves the criterion verified');
    const reviewEntries = ac1.evidence.filter(entry => entry.type === 'review');
    assert.equal(reviewEntries.length, 1, 'a re-judge updates the same review entry');
    assert.equal(reviewEntries[0].status, 'failed');
    assert.equal(acLedger.deriveScore(ledger).score, rescored.score);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC7 & AC8: a run without a ledger keeps the verdict-based score', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ac-ledger-noledger-'));
  try {
    fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, SCORE_SPEC_REL), FOUR_AC_SPEC, 'utf8');

    const state = seedScoringRun(root, { runId: 'run-no-ledger' });
    const ledgerPath = path.join(root, state.artifactsDir, acLedger.LEDGER_FILENAME);
    assert.equal(fs.existsSync(ledgerPath), false);

    const verdictPath = path.join(root, 'verdict.json');
    fs.writeFileSync(verdictPath, JSON.stringify({
      score: 10,
      verdicts: ['AC1', 'AC2', 'AC3', 'AC4'].map(id => ({ id, verdict: 'verified', evidence: 'app.cjs:1' }))
    }), 'utf8');

    assert.equal(sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath }), 0);
    const submitted = stateManager.loadRunState(root, state.runId);
    assert.equal(submitted.score, 10, 'without a ledger the per-criterion verdicts still score');
    assert.equal(submitted.steps[5].status, 'judged');
    assert.equal(fs.existsSync(ledgerPath), false, 'scoring never invents a ledger');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
