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

// Spec 00017 AC13: AC2 declares a negative scenario (an invalid input is
// rejected) and needs an observed passing test before it can score 10.
const NEGATIVE_SPEC_REL = '.sdw/specs/ac-ledger-negative.md';
const NEGATIVE_SPEC = `---
slug: ac-ledger-negative
title: "AC Ledger Negative Scenario"
---

# Specification — AC Ledger Negative Scenario

## Description

Exercises the negative-scenario score cap.

## Acceptance Criteria

- AC1: The system shall record the first criterion.
- AC2: If the input is invalid, the system shall reject it.
- AC3: The system shall record the third criterion.
`;

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
  // File evidence must name a real file, so a CLI link in these fixtures
  // materializes the declared path inside the project root first.
  const pathIndex = args.indexOf('--path');
  if (pathIndex !== -1) {
    const rel = args[pathIndex + 1];
    if (rel && !path.isAbsolute(rel) && !rel.includes('..')) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (!fs.existsSync(abs)) fs.writeFileSync(abs, '// evidence fixture\n', 'utf8');
    }
  }
  return spawnSync(process.execPath, [ORCH, 'ledger', 'link', '--root', root, '--run-id', runId, ...args], {
    encoding: 'utf8'
  });
}

function readLedgerFile(ledgerPath) {
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}

// File evidence must point at a real file, so a programmatic link needs the
// fixture file to exist on disk.
function ensureEvidenceFile(root, rel = 'skills/demo.cjs') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '// evidence fixture\n', 'utf8');
  return rel;
}

// Runs an orchestrator command while collecting the lines it writes to stdout and
// stderr, so a failing initialization can be asserted without polluting the
// suite output. Warnings are captured too: a skipped test entry is reported
// through console.warn.
function captureConsole(run) {
  const stdout = [];
  const stderr = [];
  const warnings = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args) => { stdout.push(args.map(String).join(' ')); };
  console.error = (...args) => { stderr.push(args.map(String).join(' ')); };
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  let code;
  try {
    code = run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), warn: warnings.join('\n') };
}

// Seeds a run paused at Step 5 awaiting a judge verdict, so the scoring cases do
// not pay for the earlier pipeline steps.
function seedScoringRun(root, options = {}) {
  const runId = options.runId || 'run-ac-ledger-score';
  const specRel = options.specRel || SCORE_SPEC_REL;
  const slug = options.slug || 'ac-ledger-score';
  const state = stateManager.createRunState({ root, specPath: specRel, slug, runId });
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
    ensureEvidenceFile(root, 'skills/sdw-orch/scripts/ac_ledger.cjs');
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

    const acceptedLedgerPath = path.join(root, accepted.artifactsDir, acLedger.LEDGER_FILENAME);
    assert.equal(accepted.acLedgerPath, path.relative(root, acceptedLedgerPath).replace(/\\/g, '/'),
      'AC9: the accepted task records the project-relative ledger path');
    assert.equal(accepted.acLedgerSha256, acLedger.hashLedgerFile(acceptedLedgerPath),
      'AC9: Step 4 acceptance records the ledger hash in run state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00067 AC1: task acceptance links the tests its evidence file names to
// every criterion the task claims, so the ledger holds the observed results.
test('00067 AC1: task finish links each named test entry to every claimed AC', () => {
  const root = setupGitProject();
  try {
    const code = sdwOrch.cmdRun({ root, specPath: SPEC_REL, skipReview: true, skipPr: true });
    assert.equal(code, 4, 'the run pauses after dispatching its first Step 4 task');
    const state = stateManager.findLatestRunState(root);
    const taskId = state.steps[4].dispatch.activeTaskId;

    fs.appendFileSync(path.join(root, 'skills', 'demo.cjs'), '// task work\n');
    const evidencePath = path.join(root, `${taskId}.evidence.json`);
    fs.writeFileSync(evidencePath, JSON.stringify({
      taskId,
      status: 'success',
      acIds: ['AC1', 'AC2'],
      filesChanged: ['skills/demo.cjs'],
      tests: [
        { name: 'focused ledger suite', status: 'passed', command: 'node --test tests/sdw_ac_ledger.test.cjs' },
        { name: 'flaky guard case', status: 'skipped' }
      ],
      summary: 'linked the tests it ran'
    }), 'utf8');

    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath }), 0,
      'the task is accepted');

    const accepted = stateManager.loadRunState(root, state.runId);
    const ledger = readLedgerFile(path.join(root, accepted.artifactsDir, acLedger.LEDGER_FILENAME));
    for (const id of ['AC1', 'AC2']) {
      const record = ledger.criteria.find(criterion => criterion.id === id);
      assert.equal(record.status, 'verified', `${id} stays verified`);
      assert.deepEqual(record.evidence.filter(entry => entry.type === 'test'), [
        { type: 'test', name: 'focused ledger suite', status: 'passed', taskId },
        { type: 'test', name: 'flaky guard case', status: 'skipped', taskId }
      ], `${id} carries the named test entries with their observed status`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00067 AC2: a test entry with no name or a status outside passed, failed,
// and skipped is skipped with a warning and never changes the acceptance.
test('00067 AC2: a malformed test entry is skipped with a warning and changes nothing', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);
    const before = fs.readFileSync(ledgerPath, 'utf8');

    const skipped = captureConsole(() => sdwOrch.linkAcceptedTaskEvidence({
      targetRoot: root,
      state,
      taskId: 'task-1',
      acIds: ['AC1'],
      files: [],
      tests: [
        { status: 'passed' },
        { name: '   ', status: 'passed' },
        { name: 'flaky case', status: 'flaky' }
      ],
      commitSha: null
    }));
    assert.equal(skipped.code, 0, 'no malformed entry is linked');
    assert.match(skipped.warn, /Skipped an unnamed test entry from the accepted evidence of "task-1"/);
    assert.match(skipped.warn,
      /Skipped test "flaky case" from the accepted evidence of "task-1": status "flaky" is not one of passed, failed, skipped/);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before,
      'the refused entries leave the ledger byte-for-byte unchanged');

    // A valid entry in the same acceptance still links, so a skipped entry never
    // blocks or rewrites the acceptance around it.
    const mixed = captureConsole(() => sdwOrch.linkAcceptedTaskEvidence({
      targetRoot: root,
      state,
      taskId: 'task-1',
      acIds: ['AC1'],
      files: [],
      tests: [
        { name: 'focused ledger suite', status: 'passed' },
        { name: 'flaky case', status: 'flaky' }
      ],
      commitSha: null
    }));
    assert.equal(mixed.code, 1, 'only the valid test entry links');
    const record = readLedgerFile(ledgerPath).criteria.find(criterion => criterion.id === 'AC1');
    assert.deepEqual(record.evidence, [
      { type: 'test', name: 'focused ledger suite', status: 'passed', taskId: 'task-1' }
    ], 'the ledger holds only the named, recognized test entry');
    assert.equal(record.status, 'verified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00067 AC3: replaying the same acceptance links no duplicate test entry.
test('00067 AC3: replaying the same acceptance adds no duplicate test evidence', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);
    const tests = [
      { name: 'focused ledger suite', status: 'passed' },
      { name: 'guard case', status: 'skipped' }
    ];
    const acceptance = () => captureConsole(() => sdwOrch.linkAcceptedTaskEvidence({
      targetRoot: root,
      state,
      taskId: 'task-1',
      acIds: ['AC1', 'AC2'],
      files: [],
      tests,
      commitSha: null
    }));

    const first = acceptance();
    assert.equal(first.code, 4, 'two tests linked to two criteria');
    const snapshot = fs.readFileSync(ledgerPath, 'utf8');

    const replay = acceptance();
    assert.equal(replay.code, 0, 'the replay links nothing new');
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), snapshot,
      'the replayed acceptance leaves the ledger byte-identical');

    let ledger = readLedgerFile(ledgerPath);
    for (const id of ['AC1', 'AC2']) {
      const links = ledger.criteria.find(criterion => criterion.id === id).evidence
        .filter(entry => entry.type === 'test');
      assert.deepEqual(links, [
        { type: 'test', name: 'focused ledger suite', status: 'passed', taskId: 'task-1' },
        { type: 'test', name: 'guard case', status: 'skipped', taskId: 'task-1' }
      ], `${id} keeps one entry per test name and status`);
    }

    // The status is the second identity field: a re-run that reports another
    // status updates the stored result instead of appending a second entry.
    const rerun = captureConsole(() => sdwOrch.linkAcceptedTaskEvidence({
      targetRoot: root,
      state,
      taskId: 'task-1',
      acIds: ['AC1'],
      files: [],
      tests: [{ name: 'guard case', status: 'failed' }],
      commitSha: null
    }));
    assert.equal(rerun.code, 1, 'the changed status updates the stored entry');
    ledger = readLedgerFile(ledgerPath);
    const guard = ledger.criteria.find(criterion => criterion.id === 'AC1').evidence
      .filter(entry => entry.name === 'guard case');
    assert.deepEqual(guard, [
      { type: 'test', name: 'guard case', status: 'failed', taskId: 'task-1' }
    ], 'the changed status replaces the stored result');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00067 AC4: the negative-scenario cap is bounded to the criterion that
// declares the scenario, and only an observed passing test lifts it.
test('00067 AC4: the cap fires only for a criterion that declares a negative scenario without a passing test', () => {
  const ledger = acLedger.buildLedger({
    runId: 'run-00067-cap',
    specSlug: 'ac-ledger-negative',
    specContent: NEGATIVE_SPEC,
    generatedAt: '2026-10-19T12:00:00.000Z'
  });
  // Every criterion is verified by a file entry; only AC2 declares a negative
  // scenario, and no criterion carries test evidence yet.
  for (const record of ledger.criteria) {
    record.status = 'verified';
    record.evidence = [{ type: 'file', path: `skills/${record.id}.cjs` }];
  }

  const fileOnly = acLedger.deriveScore(ledger);
  assert.equal(fileOnly.uncappedScore, 10, 'every criterion is verified');
  assert.equal(fileOnly.score, 8, 'AC2 declares the negative scenario');
  assert.equal(fileOnly.capLimit, 8);
  assert.deepEqual(fileOnly.capReasons, ['AC2 declares a negative scenario without an observed passing test.'],
    'only the declaring criterion is named as the cap source');

  // A skipped or a failed test is audit evidence, never proof: neither lifts the cap.
  ledger.criteria[1].evidence.push({ type: 'test', name: 'invalid input is rejected', status: 'skipped' });
  assert.equal(acLedger.deriveScore(ledger).score, 8, 'a skipped test never lifts the cap');
  ledger.criteria[1].evidence[1] = { type: 'test', name: 'invalid input is rejected', status: 'failed' };
  assert.equal(acLedger.deriveScore(ledger).score, 8, 'a failed test never lifts the cap');

  // A passing test lifts the cap for its own criterion.
  ledger.criteria[1].evidence[1] = { type: 'test', name: 'invalid input is rejected', status: 'passed' };
  const lifted = acLedger.deriveScore(ledger);
  assert.equal(lifted.score, 10);
  assert.equal(lifted.capLimit, null);
  assert.equal(lifted.capped, false);
  assert.deepEqual(lifted.capReasons, []);

  // A passing test recorded for another criterion never lifts AC2's cap.
  ledger.criteria[1].evidence.pop();
  ledger.criteria[0].evidence.push({ type: 'test', name: 'first criterion', status: 'passed' });
  const elsewhere = acLedger.deriveScore(ledger);
  assert.equal(elsewhere.score, 8, 'the cap follows the declaring criterion only');
  assert.deepEqual(elsewhere.capReasons, ['AC2 declares a negative scenario without an observed passing test.']);

  // A criterion that declares no negative scenario is never a cap source, even
  // when it carries no test evidence at all.
  const neutral = acLedger.deriveScore({
    criteria: [{
      id: 'AC1',
      text: 'The system shall record the first criterion.',
      status: 'verified',
      evidence: [{ type: 'file', path: 'skills/demo.cjs' }]
    }]
  });
  assert.equal(neutral.capLimit, null, 'no declared negative scenario means no cap');
  assert.equal(neutral.score, 10);
});

// Spec 00067 AC4 & AC5: the tests an accepted task recorded reach the ledger, so
// a passing one lifts the cap Step 5 derives while a skipped one does not.
test('00067 AC4 & AC5: an accepted passing test lifts the Step 5 negative-scenario cap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ac-ledger-00067-cap-'));
  try {
    fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, NEGATIVE_SPEC_REL), NEGATIVE_SPEC, 'utf8');
    const state = seedScoringRun(root, {
      runId: 'run-00067-cap-lift',
      specRel: NEGATIVE_SPEC_REL,
      slug: 'ac-ledger-negative'
    });
    const init = acLedger.initLedger({
      root,
      artifactsDir: state.artifactsDir,
      runId: state.runId,
      specSlug: state.specSlug,
      specContent: NEGATIVE_SPEC,
      generatedAt: '2026-10-19T12:00:00.000Z'
    });

    for (const id of ['AC1', 'AC2', 'AC3']) {
      assert.equal(link(root, state.runId, ['--ac', id, '--type', 'file', '--path', `skills/${id}.cjs`]).status, 0,
        `${id} is verified by its file evidence`);
    }
    const verdictPath = path.join(root, 'verdict.json');
    fs.writeFileSync(verdictPath, JSON.stringify({
      score: 10,
      verdicts: ['AC1', 'AC2', 'AC3'].map(id => ({ id, verdict: 'verified', evidence: `skills/${id}.cjs:1` }))
    }), 'utf8');

    assert.equal(sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath }), 0,
      'the capped score still meets the default threshold');
    let submitted = stateManager.loadRunState(root, state.runId);
    assert.equal(submitted.score, 8, 'AC4: AC2 declares a negative scenario without a passing test');
    assert.deepEqual(submitted.steps[5].output.scoreCap, {
      limit: 8,
      applied: true,
      uncappedScore: 10,
      reasons: ['AC2 declares a negative scenario without an observed passing test.']
    });

    // The accepted evidence recorded a skipped run of the negative case: it is
    // audit evidence, so the cap stays even though the entry is now in the ledger.
    const accept = tests => captureConsole(() => {
      const accepted = stateManager.loadRunState(root, state.runId);
      const linked = sdwOrch.linkAcceptedTaskEvidence({
        targetRoot: root,
        state: accepted,
        taskId: 'task-1',
        acIds: ['AC2'],
        files: [],
        tests,
        commitSha: null
      });
      stateManager.saveRunState(root, accepted);
      return linked;
    });

    assert.equal(accept([{ name: 'invalid input is rejected', status: 'skipped' }]).code, 1,
      'the skipped test entry is linked as audit evidence');
    assert.equal(sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath }), 0);
    submitted = stateManager.loadRunState(root, state.runId);
    assert.equal(submitted.score, 8, 'AC4: a skipped test never lifts the cap');
    let record = readLedgerFile(init.ledgerPath).criteria.find(criterion => criterion.id === 'AC2');
    assert.deepEqual(record.evidence.filter(entry => entry.type === 'test'), [
      { type: 'test', name: 'invalid input is rejected', status: 'skipped', taskId: 'task-1' }
    ]);

    // Re-accepting the same test with an observed passing status updates the one
    // entry and lifts the cap.
    assert.equal(accept([{ name: 'invalid input is rejected', status: 'passed' }]).code, 1,
      'the changed status updates the stored entry');
    assert.equal(sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath }), 0);
    submitted = stateManager.loadRunState(root, state.runId);
    assert.equal(submitted.score, 10, 'AC5: the accepted passing test lifts the cap');
    assert.equal(submitted.steps[5].output.scoreCap, null, 'no cap is reported once a passing test exists');
    record = readLedgerFile(init.ledgerPath).criteria.find(criterion => criterion.id === 'AC2');
    assert.deepEqual(record.evidence.filter(entry => entry.type === 'test'), [
      { type: 'test', name: 'invalid input is rejected', status: 'passed', taskId: 'task-1' }
    ], 'AC3: the replay keeps one entry per test name');
    assert.equal(acLedger.deriveScore(readLedgerFile(init.ledgerPath)).score, submitted.score,
      'the reported score equals the ledger-derived score');
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
    ensureEvidenceFile(root);
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

test('AC9: ledger link records the canonical ledger hash and path in run state', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);
    const first = link(root, state.runId, ['--ac', 'AC1', '--type', 'file', '--path', 'skills/demo.cjs']);
    assert.equal(first.status, 0, first.stderr);

    let anchored = stateManager.loadRunState(root, state.runId);
    assert.equal(anchored.acLedgerPath, path.relative(root, ledgerPath).replace(/\\/g, '/'),
      'AC9: the state records the project-relative ledger path');
    assert.match(anchored.acLedgerSha256, /^[0-9a-f]{64}$/, 'AC9: the state records a SHA-256 digest');
    assert.equal(anchored.acLedgerSha256, acLedger.hashLedgerFile(ledgerPath),
      'AC9: the digest covers the ledger as written');
    const firstHash = anchored.acLedgerSha256;

    const second = link(root, state.runId, ['--ac', 'AC2', '--type', 'test', '--name', 'ledger contract', '--status', 'passed']);
    assert.equal(second.status, 0, second.stderr);
    anchored = stateManager.loadRunState(root, state.runId);
    assert.notEqual(anchored.acLedgerSha256, firstHash, 'AC9: an accepted update re-anchors the new digest');
    assert.equal(anchored.acLedgerSha256, acLedger.hashLedgerFile(ledgerPath));

    // AC9: canonical JSON sorts object keys at every depth and keeps array order.
    assert.equal(
      acLedger.hashLedger({ b: 2, a: [{ y: 1, x: 2 }] }),
      acLedger.hashLedger({ a: [{ x: 2, y: 1 }], b: 2 }),
      'AC9: object key order never changes the digest'
    );
    assert.notEqual(
      acLedger.hashLedger({ a: [1, 2] }),
      acLedger.hashLedger({ a: [2, 1] }),
      'AC9: array order is part of the digest'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC10: a tampered ledger fails Step 5 verification and is never repaired', () => {
  const root = setupGitProject();
  try {
    fs.writeFileSync(path.join(root, SCORE_SPEC_REL), FOUR_AC_SPEC, 'utf8');
    const state = seedScoringRun(root);
    const init = acLedger.initLedger({
      root,
      artifactsDir: state.artifactsDir,
      runId: state.runId,
      specSlug: state.specSlug,
      specContent: FOUR_AC_SPEC,
      generatedAt: '2026-10-19T12:00:00.000Z'
    });
    const linked = link(root, state.runId, ['--ac', 'AC1', '--type', 'test', '--name', 'ledger contract', '--status', 'passed']);
    assert.equal(linked.status, 0, linked.stderr);

    const anchored = stateManager.loadRunState(root, state.runId);
    const anchoredHash = anchored.acLedgerSha256;
    assert.match(anchoredHash, /^[0-9a-f]{64}$/, 'AC9: the link anchored the ledger');

    const tampered = readLedgerFile(init.ledgerPath);
    tampered.criteria[1].status = 'verified';
    tampered.criteria[1].evidence.push({ type: 'file', path: 'skills/demo.cjs' });
    fs.writeFileSync(init.ledgerPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    const tamperedBytes = fs.readFileSync(init.ledgerPath, 'utf8');

    // AC10: a ledger command that reads the tampered file never re-anchors it.
    const report = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'report', '--root', root, '--run-id', state.runId, '--format', 'json'],
      { encoding: 'utf8' }
    );
    assert.equal(report.status, 0, report.stderr);
    assert.equal(JSON.parse(report.stdout).totals.verified, 2, 'the report reads the ledger as it is');
    assert.equal(stateManager.loadRunState(root, state.runId).acLedgerSha256, anchoredHash,
      'AC10: reading the ledger never repairs the hash');

    let errors = '';
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = (...args) => { errors += `${args.map(String).join(' ')}\n`; };
    let code;
    try {
      code = sdwOrch.cmdRun({
        root,
        specPath: SCORE_SPEC_REL,
        runId: state.runId,
        step: 5,
        skipReview: true,
        skipPr: true
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assert.equal(code, 2, 'AC10: Step 5 refuses to score');
    assert.match(errors, /ledger hash mismatch/i, 'AC10: the failure names the mismatch');
    assert.match(errors, new RegExp(anchoredHash), 'AC10: the failure names the recorded hash');
    assert.match(errors, /[0-9a-f]{64}/, 'AC10: the failure names the observed hash');

    const after = stateManager.loadRunState(root, state.runId);
    assert.equal(after.steps[5].status, 'reimplementation_needed', 'the fail-closed outcome is recorded');
    assert.equal(after.score, 0);
    assert.equal(after.acLedgerSha256, anchoredHash, 'AC10: verification never rewrites the anchor');
    assert.equal(fs.readFileSync(init.ledgerPath, 'utf8'), tamperedBytes, 'AC10: verification never rewrites the ledger');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC10: deleting an anchored ledger fails verification instead of skipping it', () => {
  const root = setupGitProject();
  try {
    fs.writeFileSync(path.join(root, SCORE_SPEC_REL), FOUR_AC_SPEC, 'utf8');
    const state = seedScoringRun(root);
    const init = acLedger.initLedger({
      root,
      artifactsDir: state.artifactsDir,
      runId: state.runId,
      specSlug: state.specSlug,
      specContent: FOUR_AC_SPEC,
      generatedAt: '2026-10-19T12:00:00.000Z'
    });
    const linked = link(root, state.runId, ['--ac', 'AC1', '--type', 'test', '--name', 'ledger contract', '--status', 'passed']);
    assert.equal(linked.status, 0, linked.stderr);
    const anchored = stateManager.loadRunState(root, state.runId);
    assert.match(anchored.acLedgerSha256, /^[0-9a-f]{64}$/, 'the ledger is anchored');

    fs.rmSync(init.ledgerPath, { force: true });

    const verification = acLedger.verifyLedgerHash({
      root,
      ledgerPath: init.ledgerPath,
      expectedSha256: anchored.acLedgerSha256
    });
    assert.equal(verification.ok, false, 'a recorded anchor with no file is a mismatch');
    assert.match(verification.error, /missing/, 'the failure states the ledger is missing');

    let errors = '';
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = (...args) => { errors += `${args.map(String).join(' ')}\n`; };
    let code;
    try {
      code = sdwOrch.cmdRun({
        root,
        specPath: SCORE_SPEC_REL,
        runId: state.runId,
        step: 5,
        skipReview: true,
        skipPr: true
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.equal(code, 2, 'Step 5 refuses to score a deleted ledger');
    assert.match(errors, /ledger hash mismatch/i, 'the failure names the mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC11: ledger report renders AC status and evidence as Markdown and JSON', () => {
  const root = setupProject();
  try {
    const { state } = seedRun(root);
    const fileLink = link(root, state.runId, ['--ac', 'AC1', '--type', 'file', '--path', 'skills/demo.cjs']);
    assert.equal(fileLink.status, 0, fileLink.stderr);
    const testLink = link(root, state.runId, ['--ac', 'AC2', '--type', 'test', '--name', 'ledger contract', '--status', 'passed']);
    assert.equal(testLink.status, 0, testLink.stderr);

    const markdown = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'report', '--root', root, '--run-id', state.runId, '--format', 'md'],
      { encoding: 'utf8' }
    );
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /^# Acceptance Criteria Ledger Report/);
    assert.match(markdown.stdout, /- Total: 3/);
    assert.match(markdown.stdout, /- Verified: 2/);
    assert.match(markdown.stdout, /- Unverified: 1/);
    assert.match(
      markdown.stdout,
      /\| AC1 \| verified \| The system shall initialize the ledger in the run artifact directory\. \| file: skills\/demo\.cjs \|/,
      'the Markdown row carries the AC id, status, criterion, and evidence type'
    );
    assert.match(markdown.stdout, /\| AC2 \| verified \| .* \| test: ledger contract \(passed\) \|/);
    assert.match(markdown.stdout, /\| AC3 \| unverified \| .* \| none \|/);

    const json = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'report', '--root', root, '--run-id', state.runId, '--format=json'],
      { encoding: 'utf8' }
    );
    assert.equal(json.status, 0, json.stderr);
    const summary = JSON.parse(json.stdout);
    assert.equal(summary.runId, state.runId);
    assert.equal(summary.specSlug, 'ac-ledger-demo');
    assert.deepEqual(summary.totals, { total: 3, verified: 2, unverified: 1 });
    assert.deepEqual(summary.criteria.map(record => record.id), ['AC1', 'AC2', 'AC3']);
    assert.equal(summary.criteria[0].status, 'verified');
    assert.match(summary.criteria[0].text, /shall initialize the ledger/);
    assert.deepEqual(summary.criteria[0].evidence, [{ type: 'file', path: 'skills/demo.cjs' }]);
    assert.deepEqual(summary.criteria[2].evidence, [], 'an unverified AC reports no evidence');

    const unknown = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'report', '--root', root, '--run-id', state.runId, '--format', 'yaml'],
      { encoding: 'utf8' }
    );
    assert.notEqual(unknown.status, 0, 'an unknown report format is refused');
    assert.match(unknown.stderr, /Unknown ledger report format "yaml"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC12: ledger audit lists criteria without evidence and exits non-zero while any remain', () => {
  const root = setupProject();
  try {
    const { state } = seedRun(root);
    assert.equal(link(root, state.runId, ['--ac', 'AC1', '--type', 'file', '--path', 'skills/demo.cjs']).status, 0);
    assert.equal(link(root, state.runId, ['--ac', 'AC2', '--type', 'test', '--name', 'ledger contract', '--status', 'passed']).status, 0);

    const markdown = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'audit', '--root', root, '--run-id', state.runId],
      { encoding: 'utf8' }
    );
    assert.equal(markdown.status, 1, 'AC12: a criterion without evidence exits non-zero');
    assert.match(markdown.stdout, /^# Acceptance Criteria Audit/);
    assert.match(markdown.stdout, /- Criteria without evidence: 1\/3/);
    assert.match(markdown.stdout, /\| AC3 \| The system shall link typed evidence to one or more criteria\. \|/);
    assert.doesNotMatch(markdown.stdout, /\| AC1 \|/);
    assert.match(markdown.stderr, /1 acceptance criterion without evidence remain/);

    const json = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'audit', '--root', root, '--run-id', state.runId, '--format', 'json'],
      { encoding: 'utf8' }
    );
    assert.equal(json.status, 1, 'AC12: the JSON form keeps the non-zero exit code');
    const summary = JSON.parse(json.stdout);
    assert.equal(summary.runId, state.runId);
    assert.equal(summary.specSlug, 'ac-ledger-demo');
    assert.equal(summary.total, 3);
    assert.equal(summary.missingCount, 1);
    assert.deepEqual(summary.criteria, [{
      id: 'AC3',
      text: 'The system shall link typed evidence to one or more criteria.'
    }]);

    assert.equal(link(root, state.runId, ['--ac', 'AC3', '--type', 'commit', '--sha', 'a1b2c3d']).status, 0);
    const clean = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'audit', '--root', root, '--run-id', state.runId, '--format=json'],
      { encoding: 'utf8' }
    );
    assert.equal(clean.status, 0, 'AC12: a fully evidenced ledger exits 0');
    const cleanSummary = JSON.parse(clean.stdout);
    assert.equal(cleanSummary.missingCount, 0);
    assert.deepEqual(cleanSummary.criteria, []);

    const cleanMarkdown = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'audit', '--root', root, '--run-id', state.runId, '--format', 'md'],
      { encoding: 'utf8' }
    );
    assert.equal(cleanMarkdown.status, 0);
    assert.match(cleanMarkdown.stdout, /All 3 acceptance criteria carry evidence\./);

    const unknown = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'audit', '--root', root, '--run-id', state.runId, '--format', 'yaml'],
      { encoding: 'utf8' }
    );
    assert.notEqual(unknown.status, 0, 'AC12: an unknown audit format is refused');
    assert.match(unknown.stderr, /Unknown ledger audit format "yaml"/);

    const noRunId = spawnSync(process.execPath, [ORCH, 'ledger', 'audit', '--root', root], { encoding: 'utf8' });
    assert.equal(noRunId.status, 1, 'AC12: --run-id is required');
    assert.match(noRunId.stderr, /--run-id is required for "ledger audit"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC13: a declared negative scenario caps the score at 8 until a passing test is observed', () => {
  const negative = acLedger.buildLedger({
    runId: 'run-negative-cap',
    specSlug: 'ac-ledger-negative',
    specContent: NEGATIVE_SPEC,
    generatedAt: '2026-10-19T12:00:00.000Z'
  });
  for (const record of negative.criteria) {
    record.status = 'verified';
    record.evidence = [{ type: 'review', id: 'step5-judge', status: 'passed' }];
  }
  // AC1 and AC3 carry an observed passing test; AC2 declares its negative
  // scenario in the criterion text and only has review evidence.
  negative.criteria[0].evidence.push({ type: 'test', name: 'first criterion', status: 'passed' });
  negative.criteria[2].evidence.push({ type: 'test', name: 'third criterion', status: 'passed' });

  const capped = acLedger.deriveScore(negative);
  assert.equal(capped.uncappedScore, 10, 'every criterion is evidenced and verified');
  assert.equal(capped.score, 8, 'AC13: the score is capped at 8');
  assert.equal(capped.capLimit, 8);
  assert.equal(capped.capped, true);
  assert.deepEqual(capped.capReasons, ['AC2 declares a negative scenario without an observed passing test.']);

  negative.criteria[1].evidence.push({ type: 'test', name: 'invalid input is rejected', status: 'passed' });
  const lifted = acLedger.deriveScore(negative);
  assert.equal(lifted.score, 10, 'AC13: an observed passing test lifts the cap');
  assert.equal(lifted.capLimit, null);
  assert.equal(lifted.capped, false);
  assert.deepEqual(lifted.capReasons, []);

  // A test evidence entry that names a failing/negative case declares the same
  // scenario, even when the criterion text itself is neutral.
  const declaredByTest = acLedger.deriveScore({
    criteria: [
      {
        id: 'AC1',
        text: 'The system shall record the first criterion.',
        status: 'verified',
        evidence: [{ type: 'test', name: 'unknown acceptance criterion is rejected', status: 'failed' }]
      },
      {
        id: 'AC2',
        text: 'The system shall record the second criterion.',
        status: 'verified',
        evidence: [{ type: 'test', name: 'second criterion', status: 'passed' }]
      }
    ]
  });
  assert.equal(declaredByTest.uncappedScore, 10);
  assert.equal(declaredByTest.score, 8, 'AC13: a failing test entry still declares the scenario');
  assert.deepEqual(declaredByTest.capReasons, ['AC1 declares a negative scenario without an observed passing test.']);

  // A ledger with no declared negative scenario is never capped.
  const positive = acLedger.deriveScore({
    criteria: [{
      id: 'AC1',
      text: 'The system shall record the first criterion.',
      status: 'verified',
      evidence: [{ type: 'test', name: 'first criterion', status: 'passed' }]
    }]
  });
  assert.equal(positive.capLimit, null);
  assert.equal(positive.score, 10);
});

test('AC13: Step 5 reports the cap and its reason, and lifts it when a passing test is linked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ac-ledger-cap-'));
  try {
    fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, NEGATIVE_SPEC_REL), NEGATIVE_SPEC, 'utf8');
    const state = seedScoringRun(root, { runId: 'run-negative-step5', specRel: NEGATIVE_SPEC_REL, slug: 'ac-ledger-negative' });
    const init = acLedger.initLedger({
      root,
      artifactsDir: state.artifactsDir,
      runId: state.runId,
      specSlug: state.specSlug,
      specContent: NEGATIVE_SPEC,
      generatedAt: '2026-10-19T12:00:00.000Z'
    });

    assert.equal(link(root, state.runId, ['--ac', 'AC1', '--type', 'file', '--path', 'skills/demo.cjs']).status, 0);
    assert.equal(link(root, state.runId, ['--ac', 'AC2', '--type', 'review', '--id', 'review-1']).status, 0);
    assert.equal(link(root, state.runId, ['--ac', 'AC3', '--type', 'file', '--path', 'skills/demo3.cjs']).status, 0);

    const verdictPath = path.join(root, 'verdict.json');
    fs.writeFileSync(verdictPath, JSON.stringify({
      score: 10,
      verdicts: ['AC1', 'AC2', 'AC3'].map(id => ({ id, verdict: 'verified', evidence: 'skills/demo.cjs:1' }))
    }), 'utf8');

    const originalWarn = console.warn;
    let warnings = '';
    console.warn = (...args) => { warnings += `${args.map(String).join(' ')}\n`; };
    let code;
    try {
      code = sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(code, 0, 'AC13: the capped score still meets the default threshold of 8');
    const submitted = stateManager.loadRunState(root, state.runId);
    assert.equal(submitted.score, 8, 'AC13: Step 5 records the capped score');
    assert.deepEqual(submitted.steps[5].output.scoreCap, {
      limit: 8,
      applied: true,
      uncappedScore: 10,
      reasons: ['AC2 declares a negative scenario without an observed passing test.']
    });
    assert.match(warnings, /Score capped at 8\/10 \(uncapped 10\/10\)/, 'AC13: Step 5 reports the cap');
    assert.match(warnings, /AC2 declares a negative scenario without an observed passing test/,
      'AC13: Step 5 reports the cap reason');
    assert.match(submitted.steps[5].output.feedback, /Score capped at 8\/10 \(uncapped 10\/10\)/,
      'AC13: the persisted feedback carries the cap and its reason');
    assert.equal(acLedger.deriveScore(readLedgerFile(init.ledgerPath)).score, submitted.score,
      'the reported score equals the ledger-derived score');

    const passingTest = link(root, state.runId, [
      '--ac', 'AC2', '--type', 'test', '--name', 'invalid input is rejected', '--status', 'passed'
    ]);
    assert.equal(passingTest.status, 0, passingTest.stderr);
    assert.equal(sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath }), 0);

    const rescored = stateManager.loadRunState(root, state.runId);
    assert.equal(rescored.score, 10, 'AC13: the linked passing test lifts the cap');
    assert.equal(rescored.steps[5].output.scoreCap, null);
    assert.equal(acLedger.deriveScore(readLedgerFile(init.ledgerPath)).score, rescored.score);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC14: ledger evidence paths are project-relative with forward slashes, and outside-root paths are refused', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);
    ensureEvidenceFile(root, 'skills/sdw-orch/scripts/ac_ledger.cjs');
    ensureEvidenceFile(root, 'skills/sdw-orch/scripts/sdw_orch.cjs');
    const absolute = path.join(root, 'skills', 'sdw-orch', 'scripts', 'ac_ledger.cjs');

    const fromAbsolute = link(root, state.runId, ['--ac', 'AC1', '--type', 'file', '--path', absolute]);
    assert.equal(fromAbsolute.status, 0, fromAbsolute.stderr);
    const fromBackslashes = link(root, state.runId, [
      '--ac', 'AC2', '--type', 'file', '--path', 'skills\\sdw-orch\\scripts\\sdw_orch.cjs'
    ]);
    assert.equal(fromBackslashes.status, 0, fromBackslashes.stderr);

    const ledger = readLedgerFile(ledgerPath);
    const stored = [ledger.criteria[0].evidence[0].path, ledger.criteria[1].evidence[0].path];
    assert.deepEqual(stored, [
      'skills/sdw-orch/scripts/ac_ledger.cjs',
      'skills/sdw-orch/scripts/sdw_orch.cjs'
    ], 'AC14: absolute and backslashed input is stored project-relative');
    for (const evidencePath of stored) {
      assert.ok(!evidencePath.includes('\\'), 'AC14: no stored path keeps a backslash');
      assert.equal(path.isAbsolute(evidencePath), false, 'AC14: no stored path is absolute');
    }
    assert.equal(
      acLedger.normalizeProjectPath(absolute, root),
      'skills/sdw-orch/scripts/ac_ledger.cjs',
      'AC14: the normalizer resolves an absolute path against the project root'
    );
    assert.equal(
      acLedger.normalizeProjectPath('skills\\demo.cjs', root),
      'skills/demo.cjs',
      'AC14: the normalizer converts a relative backslashed path'
    );

    const before = fs.readFileSync(ledgerPath, 'utf8');
    const outside = path.join(root, '..', 'outside-evidence.cjs');
    const refused = link(root, state.runId, ['--ac', 'AC3', '--type', 'file', '--path', outside]);
    assert.notEqual(refused.status, 0, 'AC14: an absolute path outside the root is refused');
    assert.match(refused.stderr, /outside the project root/);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before, 'AC14: the refused path leaves the ledger unchanged');

    const escape = link(root, state.runId, ['--ac', 'AC3', '--type', 'file', '--path', '..\\outside-evidence.cjs']);
    assert.notEqual(escape.status, 0, 'AC14: a relative path that escapes the root is refused');
    assert.match(escape.stderr, /outside the project root/);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before);
    assert.equal(acLedger.normalizeProjectPath('../outside-evidence.cjs', root), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC15: resume loads the ledger a run already owns and never re-seeds its records', () => {
  const root = setupProject();
  try {
    const state = stateManager.createRunState({
      root,
      specPath: SPEC_REL,
      slug: 'ac-ledger-demo',
      runId: 'run-ledger-resume'
    });
    const init = acLedger.initLedger({
      root,
      artifactsDir: state.artifactsDir,
      runId: state.runId,
      specSlug: state.specSlug,
      specContent: SPEC,
      generatedAt: '2026-10-19T12:00:00.000Z'
    });
    assert.equal(init.created, true);
    assert.equal(link(root, state.runId, ['--ac', 'AC1', '--type', 'file', '--path', 'skills/demo.cjs']).status, 0);
    assert.equal(link(root, state.runId, ['--ac', 'AC2', '--type', 'test', '--name', 'ledger contract', '--status', 'passed']).status, 0);
    const before = fs.readFileSync(init.ledgerPath, 'utf8');
    const anchored = stateManager.loadRunState(root, state.runId);
    assert.match(anchored.acLedgerSha256, /^[0-9a-f]{64}$/, 'AC9: the linked ledger is anchored');

    // Re-initializing against a different specification still reads the run's
    // ledger: resume must never re-seed the criteria or drop accepted evidence.
    const reinit = acLedger.initLedger({
      root,
      artifactsDir: state.artifactsDir,
      runId: state.runId,
      specSlug: state.specSlug,
      specContent: '## Acceptance Criteria\n\n- AC1: The system shall be the only criterion now.\n',
      generatedAt: '2026-10-20T12:00:00.000Z'
    });
    assert.equal(reinit.created, false, 'AC15: an existing ledger is read, never re-created');
    assert.deepEqual(
      reinit.ledger.criteria.map(record => record.id),
      ['AC1', 'AC2', 'AC3'],
      'AC15: the original criteria records survive'
    );
    assert.equal(fs.readFileSync(init.ledgerPath, 'utf8'), before, 'AC15: re-initializing never rewrites the ledger');

    // A real resume passes through run start: Steps 1-2 are resolved, so it
    // resumes at Step 3 and must load that same ledger before doing any work.
    stateManager.updateStepState(root, state.runId, 1, 'skipped', { derivationNeeded: false });
    stateManager.updateStepState(root, state.runId, 2, 'completed', { hasGaps: false });
    const resumed = captureConsole(() => sdwOrch.cmdResume({ root, runId: state.runId }));
    assert.equal(resumed.code, 4, `AC15: resume dispatches the first task: ${resumed.stderr}`);
    assert.match(resumed.stdout, /\[Ledger\] Loaded .*ac-ledger\.json/, 'AC15: resume reads the ledger');
    assert.doesNotMatch(resumed.stdout, /\[Ledger\] Initialized/, 'AC15: resume never re-seeds the ledger');
    assert.equal(
      fs.readFileSync(init.ledgerPath, 'utf8'),
      before,
      'AC15: resume preserves every record and evidence entry'
    );

    const after = stateManager.loadRunState(root, state.runId);
    assert.equal(after.acLedgerSha256, anchored.acLedgerSha256, 'AC15: resume keeps the ledger anchor');
    assert.match(fs.readFileSync(init.ledgerPath, 'utf8'), /"name": "ledger contract"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC15: re-linking the same evidence adds no duplicate entry and rewrites nothing', () => {
  const root = setupProject();
  try {
    const { state, ledgerPath } = seedRun(root);
    const payloads = [
      ['--type', 'file', '--path', 'skills/demo.cjs'],
      ['--type', 'test', '--name', 'ledger contract', '--status', 'passed'],
      ['--type', 'commit', '--sha', 'a1b2c3d'],
      ['--type', 'review', '--id', 'review-7'],
      ['--type', 'sabotage', '--id', 'sabotage-2']
    ];
    for (const args of payloads) {
      const first = link(root, state.runId, ['--ac', 'AC1', ...args]);
      assert.equal(first.status, 0, `${args.join(' ')}: ${first.stderr}`);
    }
    const snapshot = fs.readFileSync(ledgerPath, 'utf8');
    const anchored = stateManager.loadRunState(root, state.runId);
    assert.equal(acLedger.hashLedgerFile(ledgerPath), anchored.acLedgerSha256);

    for (const args of payloads) {
      const duplicate = link(root, state.runId, ['--ac', 'AC1', ...args]);
      assert.equal(duplicate.status, 0, `AC15: a duplicate link is a no-op, not an error: ${duplicate.stderr}`);
      assert.match(duplicate.stdout, /Already linked for AC1/, 'AC15: the duplicate is reported');
    }

    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), snapshot, 'AC15: duplicate links leave the ledger byte-for-byte unchanged');
    const record = readLedgerFile(ledgerPath).criteria[0];
    assert.deepEqual(
      record.evidence.map(entry => entry.type),
      ['file', 'test', 'commit', 'review', 'sabotage'],
      'AC15: each fact exists exactly once'
    );
    assert.equal(stateManager.loadRunState(root, state.runId).acLedgerSha256, anchored.acLedgerSha256,
      'AC15: a duplicate link does not re-anchor run state');

    // Step 4 acceptance replay: the same accepted file and task id stay one entry.
    ensureEvidenceFile(root);
    const step4Link = {
      root,
      ledgerPath,
      acIds: ['AC2'],
      evidence: { type: 'file', path: 'skills/demo.cjs', taskId: 'task-1' }
    };
    const firstAcceptance = acLedger.linkEvidence(step4Link);
    assert.deepEqual(firstAcceptance.linked, ['AC2']);
    const replay = acLedger.linkEvidence(step4Link);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.linked, [], 'AC15: replaying the acceptance links no duplicate');
    assert.deepEqual(replay.duplicates, ['AC2']);
    assert.deepEqual(
      readLedgerFile(ledgerPath).criteria[1].evidence,
      [{ type: 'file', path: 'skills/demo.cjs', taskId: 'task-1' }],
      'AC15: the replayed Step 4 evidence remains a single entry'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC16: the orchestrator protocol documents the ledger schema, commands, hash, and score derivation', () => {
  const protocolPath = path.join(__dirname, '..', 'skills', 'sdw-orch', 'references', 'orchestrator_protocol.md');
  const protocol = fs.readFileSync(protocolPath, 'utf8');

  assert.match(protocol, /## \d+\. Acceptance Criteria Ledger/, 'the protocol carries a dedicated ledger section');
  const schemaAnchors = ['"runId"', '"specSlug"', '"generatedAt"', '"criteria"', '"id"', '"text"', '"status"', '"evidence"'];
  for (const anchor of schemaAnchors) {
    assert.ok(protocol.includes(anchor), `AC16: the schema documents ${anchor}`);
  }
  for (const command of ['ledger link', 'ledger report', 'ledger audit']) {
    assert.ok(protocol.includes(command), `AC16: the protocol documents ${command}`);
  }
  assert.match(protocol, /SHA-256/, 'AC16: the hash anchor rule is documented');
  assert.match(protocol, /canonical JSON/, 'AC16: the canonical hash input is documented');
  assert.match(protocol, /acLedgerSha256/, 'AC16: the run-state anchor field is documented');
  assert.match(protocol, /round\(verifiedCount \/ totalAcs \* 10\)/, 'AC16: the score formula is documented');
  assert.match(protocol, /capped at 8/, 'AC16: the negative-scenario cap is documented');
  assert.match(protocol, /Remediation:/, 'AC16: the fail-closed initialization remediation is documented');
});

test('AC17: ledger initialization failure fails the run before Step 1 completes', () => {
  const root = setupProject();
  try {
    // A file where the run artifact directory must go makes the ledger write fail
    // with a real filesystem error on every platform: no mock, no weakened check.
    const stateDir = path.join(root, '.sdw', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const blockedArtifacts = path.join(stateDir, 'ac-ledger-demo');
    fs.writeFileSync(blockedArtifacts, 'this file blocks the run artifact directory\n', 'utf8');

    const failed = captureConsole(() => sdwOrch.cmdRun({ root, specPath: SPEC_REL, skipReview: true, skipPr: true }));
    assert.equal(failed.code, 1, 'AC17: the run fails instead of continuing without a ledger');
    assert.match(failed.stderr, /\[Ledger\] Initialization failed/, 'AC17: the failure is named');
    assert.ok(failed.stderr.includes('.sdw/state/ac-ledger-demo'), `AC17: the artifacts directory is named: ${failed.stderr}`);
    assert.ok(failed.stderr.includes('ac-ledger.json'), 'AC17: the ledger path is named');
    assert.match(failed.stderr, /Remediation: create the run artifact directory/, 'AC17: the remediation is actionable');
    assert.match(failed.stderr, /Step 1 has not completed/, 'AC17: the failure precedes Step 1');
    assert.doesNotMatch(failed.stdout, /\[Step 1/, 'AC17: no Step 1 header is printed');

    const state = stateManager.findLatestRunState(root);
    assert.equal(state.status, 'failed', 'AC17: the run state records the failure');
    assert.equal(state.steps[1].status, 'pending', 'AC17: Step 1 never completed');
    assert.ok(
      state.errors.some(entry => /Acceptance criteria ledger initialization failed/.test(entry.error || '')),
      'AC17: the run state keeps the error'
    );
    assert.equal(fs.statSync(blockedArtifacts).isFile(), true, 'AC17: the injected failure is still the filesystem state');
    assert.equal(fs.existsSync(path.join(blockedArtifacts, 'ac-ledger.json')), false);

    // The CLI maps the same failure to a non-zero process exit.
    const cli = spawnSync(
      process.execPath,
      [ORCH, 'run', SPEC_REL, '--root', root, '--skip-review', '--skip-pr'],
      { cwd: root, encoding: 'utf8' }
    );
    assert.notEqual(cli.status, 0, 'AC17: the CLI exits non-zero');
    assert.match(cli.stderr, /\[Ledger\] Initialization failed/);
    assert.match(cli.stderr, /Remediation:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00017 AC7 & AC8: a refused proof is not proof. A failed test entry never
// verifies a criterion, and a criterion the judge failed is never promoted by a
// later file, commit, or passing test link.
test('AC7 & AC8: failed test evidence never verifies a criterion', () => {
  const root = setupProject();
  try {
    const { ledgerPath } = seedRun(root);

    const failedLink = link(root, 'run-ac-ledger-test', [
      '--ac', 'AC1', '--type', 'test', '--name', 'invalid input is rejected', '--status', 'failed'
    ]);
    assert.equal(failedLink.status, 0, failedLink.stderr);

    let ledger = readLedgerFile(ledgerPath);
    let record = ledger.criteria.find(criterion => criterion.id === 'AC1');
    assert.equal(record.evidence.length, 1, 'the failed test entry is kept for audit');
    assert.equal(record.status, 'unverified', 'failed test evidence does not verify the criterion');
    assert.equal(acLedger.deriveScore(ledger).verifiedCount, 0, 'the refused proof is not counted');

    const passedLink = link(root, 'run-ac-ledger-test', [
      '--ac', 'AC1', '--type', 'test', '--name', 'invalid input is rejected', '--status', 'passed'
    ]);
    assert.equal(passedLink.status, 0, passedLink.stderr);
    ledger = readLedgerFile(ledgerPath);
    record = ledger.criteria.find(criterion => criterion.id === 'AC1');
    assert.equal(record.status, 'verified', 'the observed passing test verifies the criterion');
    assert.equal(acLedger.deriveScore(ledger).verifiedCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC7 & AC8: a failed judge verdict is never promoted by later evidence', () => {
  const root = setupProject();
  try {
    const { ledgerPath } = seedRun(root);
    const recorded = acLedger.recordReviewVerdicts({
      root,
      ledgerPath,
      reviewId: 'step5-judge',
      verdicts: [{ id: 'AC1', verdict: 'failed', evidence: 'the behaviour is missing from the diff' }]
    });
    assert.equal(recorded.ok, true);

    const fileLink = link(root, 'run-ac-ledger-test', [
      '--ac', 'AC1', '--type', 'file', '--path', 'skills/sdw-orch/scripts/ac_ledger.cjs'
    ]);
    assert.equal(fileLink.status, 0, fileLink.stderr);
    const testLink = link(root, 'run-ac-ledger-test', [
      '--ac', 'AC1', '--type', 'test', '--name', 'a passing test', '--status', 'passed'
    ]);
    assert.equal(testLink.status, 0, testLink.stderr);

    const ledger = readLedgerFile(ledgerPath);
    const record = ledger.criteria.find(criterion => criterion.id === 'AC1');
    assert.equal(record.status, 'failed', 'the failed verdict stays authoritative');
    assert.ok(record.evidence.length >= 3, 'the later evidence is recorded for audit');
    assert.equal(acLedger.deriveScore(ledger).verifiedCount, 0, 'a failed criterion never counts');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00017 AC7 & AC8: a review or sabotage finding with an explicit failing
// outcome is audit evidence, not proof; an unqualified or passing finding counts.
test('AC7 & AC8: a failing review finding never verifies a criterion', () => {
  const root = setupProject();
  try {
    const { ledgerPath } = seedRun(root);

    const failedFinding = link(root, 'run-ac-ledger-test', [
      '--ac', 'AC2', '--type', 'review', '--id', 'thread-9', '--status', 'failed'
    ]);
    assert.equal(failedFinding.status, 0, failedFinding.stderr);
    let ledger = readLedgerFile(ledgerPath);
    let record = ledger.criteria.find(criterion => criterion.id === 'AC2');
    assert.equal(record.status, 'unverified', 'a failing review finding is not proof');
    assert.equal(record.evidence[0].status, 'failed', 'the failing outcome is preserved for audit');
    assert.equal(acLedger.deriveScore(ledger).verifiedCount, 0);

    const failedSabotage = link(root, 'run-ac-ledger-test', [
      '--ac', 'AC2', '--type', 'sabotage', '--id', 'sabotage-1', '--status', 'failed'
    ]);
    assert.equal(failedSabotage.status, 0, failedSabotage.stderr);
    ledger = readLedgerFile(ledgerPath);
    record = ledger.criteria.find(criterion => criterion.id === 'AC2');
    assert.equal(record.status, 'unverified', 'a failing sabotage outcome is not proof');

    const passedFinding = link(root, 'run-ac-ledger-test', [
      '--ac', 'AC2', '--type', 'review', '--id', 'thread-9', '--status', 'passed'
    ]);
    assert.equal(passedFinding.status, 0, passedFinding.stderr);
    ledger = readLedgerFile(ledgerPath);
    record = ledger.criteria.find(criterion => criterion.id === 'AC2');
    assert.equal(record.status, 'verified', 'a passing review finding verifies the criterion');
    const reviewEntry = record.evidence.find(entry => entry.type === 'review');
    assert.equal(reviewEntry.status, 'passed', 'the re-review updates the same finding');
    assert.equal(record.evidence.filter(entry => entry.type === 'review').length, 1, 'no duplicate review entry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00017 AC7 & AC8: when the ledger exists, a ledger that cannot record the
// verdicts must not fall back to the judge-authored score.
test('AC7 & AC8: a ledger that cannot record verdicts fails Step 5 closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ac-ledger-failclosed-'));
  try {
    fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, SCORE_SPEC_REL), FOUR_AC_SPEC, 'utf8');

    const state = seedScoringRun(root, { step5Output: { judgeAcIds: ['AC1', 'AC2', 'AC3', 'AC4'] } });
    const init = acLedger.initLedger({
      root,
      artifactsDir: state.artifactsDir,
      runId: state.runId,
      specSlug: state.specSlug,
      specContent: FOUR_AC_SPEC,
      generatedAt: '2026-10-19T12:00:00.000Z'
    });

    // A criterion missing from the ledger (for example one added to the spec
    // after the ledger was created) makes the verdict recording refuse.
    const ledger = readLedgerFile(init.ledgerPath);
    ledger.criteria = ledger.criteria.filter(criterion => criterion.id !== 'AC4');
    fs.writeFileSync(init.ledgerPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');

    const verdictPath = path.join(root, 'verdict.json');
    fs.writeFileSync(verdictPath, JSON.stringify({
      score: 10,
      verdicts: ['AC1', 'AC2', 'AC3', 'AC4'].map(id => ({ id, verdict: 'verified', evidence: 'skills/demo.cjs:1' }))
    }), 'utf8');

    const captured = captureConsole(() => sdwOrch.cmdScoreSubmit({ root, runId: state.runId, verdictPath }));
    assert.equal(captured.code, 2, 'the submit fails closed instead of accepting the judge score');
    assert.match(captured.stderr, /could not be recorded/, 'the failure names the ledger problem');
    assert.match(captured.stderr, /fails closed/, 'the failure states the policy');

    const after = stateManager.loadRunState(root, state.runId);
    assert.equal(after.score, null, 'no judge-authored score is accepted');
    assert.notEqual(after.steps[5].status, 'judged', 'Step 5 is not marked as judged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00017 AC7 & AC8: a re-linked result that now fails demotes the criterion,
// so a verified status never survives on failing evidence alone.
test('AC7 & AC8: a re-linked failing result unverifies a previously proven criterion', () => {
  const root = setupProject();
  try {
    const { ledgerPath } = seedRun(root);
    assert.equal(link(root, 'run-ac-ledger-test', [
      '--ac', 'AC1', '--type', 'test', '--name', 'guard test', '--status', 'passed'
    ]).status, 0);
    let record = readLedgerFile(ledgerPath).criteria[0];
    assert.equal(record.status, 'verified');

    assert.equal(link(root, 'run-ac-ledger-test', [
      '--ac', 'AC1', '--type', 'test', '--name', 'guard test', '--status', 'failed'
    ]).status, 0);
    record = readLedgerFile(ledgerPath).criteria[0];
    assert.equal(record.evidence.length, 1, 'the result is updated in place');
    assert.equal(record.evidence[0].status, 'failed');
    assert.equal(record.status, 'unverified', 'a failing result unverifies the criterion');
    assert.equal(acLedger.deriveScore(readLedgerFile(ledgerPath)).verifiedCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00017 AC14: file evidence must name an existing file inside the project.
test('AC14: file evidence refuses the project root, directories, and missing files', () => {
  const root = setupGitProject();
  try {
    const { ledgerPath } = seedRun(root);
    const snapshot = fs.readFileSync(ledgerPath, 'utf8');

    for (const bad of ['.', 'skills', 'skills/missing.cjs']) {
      const refused = spawnSync(
        process.execPath,
        [ORCH, 'ledger', 'link', '--root', root, '--run-id', 'run-ac-ledger-test', '--ac', 'AC1', '--type', 'file', '--path', bad],
        { encoding: 'utf8' }
      );
      assert.equal(refused.status, 1, `"${bad}" is refused: ${refused.stderr}`);
      assert.match(refused.stderr, /not a file inside the project root/, `"${bad}" names the defect`);
    }
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), snapshot, 'refused links leave the ledger byte-identical');

    const good = ensureEvidenceFile(root, 'skills/real.cjs');
    const accepted = link(root, 'run-ac-ledger-test', ['--ac', 'AC1', '--type', 'file', '--path', good]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readLedgerFile(ledgerPath).criteria[0].status, 'verified', 'a real file verifies the criterion');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00017 AC3: a mistyped ledger action is refused instead of becoming `link`.
test('AC3: an unknown ledger action is refused and never links evidence', () => {
  const root = setupProject();
  try {
    const { ledgerPath } = seedRun(root);
    const evidenceFile = ensureEvidenceFile(root, 'skills/real.cjs');
    const snapshot = fs.readFileSync(ledgerPath, 'utf8');

    const refused = spawnSync(
      process.execPath,
      [ORCH, 'ledger', 'reprot', '--root', root, '--run-id', 'run-ac-ledger-test', '--ac', 'AC1', '--type', 'file', '--path', evidenceFile],
      { encoding: 'utf8' }
    );
    assert.equal(refused.status, 1, `a mistyped action is refused: ${refused.stderr}`);
    assert.match(refused.stderr, /Unknown ledger action "reprot"/, 'the refusal names the action');
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), snapshot, 'the ledger is unchanged');
    assert.equal(readLedgerFile(ledgerPath).criteria[0].status, 'unverified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
