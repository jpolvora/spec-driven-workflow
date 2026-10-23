'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const runLock = require('../skills/sdw-orch/scripts/run_lock.cjs');

const CLI_PATH = path.resolve(__dirname, '../skills/sdw-orch/scripts/sdw_orch.cjs');
const STATE_MANAGER_PATH = path.resolve(__dirname, '../skills/sdw-orch/scripts/state_manager.cjs');
const RUN_LOCK_PATH = path.resolve(__dirname, '../skills/sdw-orch/scripts/run_lock.cjs');
const RUN_ID = 'run-checkpoint-demo';

// A pid the operating system cannot have assigned, so the owner is provably absent.
const DEAD_PID = 2147483647;

function writeLockRecord(stateFile, record) {
  const lockFile = `${stateFile}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return lockFile;
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-state-checkpoint-'));
  stateManager.createRunState({ root, slug: 'checkpoint-demo', runId: RUN_ID });
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function runOrch(args, root) {
  return spawnSync(process.execPath, [CLI_PATH, ...args, '--root', root], {
    encoding: 'utf8'
  });
}

// Spec 00019 AC1.
test('AC1: every step transition records step number, revision, status, and timestamp', () => {
  const root = makeRoot();
  try {
    const initial = stateManager.loadRunState(root, RUN_ID);
    assert.equal(initial.revision, 0, 'a new run starts at revision 0');
    assert.deepEqual(initial.stepCheckpoints, {}, 'a new run has no step checkpoints');

    const inProgress = stateManager.updateStepState(root, RUN_ID, 4, 'in_progress');
    const first = inProgress.stepCheckpoints['4'];
    assert.equal(first.step, 4, 'the checkpoint names its step');
    assert.equal(first.status, 'in_progress', 'the checkpoint names the transition status');
    assert.equal(first.revision, inProgress.revision, 'the checkpoint carries the revision the transition produced');
    assert.equal(inProgress.revision, 1, 'the transition advanced the monotonic revision');
    assert.ok(!Number.isNaN(Date.parse(first.recordedAt)), 'the checkpoint carries a parseable timestamp');

    const completed = stateManager.updateStepState(root, RUN_ID, 4, 'completed', { done: true });
    assert.equal(completed.revision, 2, 'the second transition advanced the revision again');
    // AC5 consumes the record of a finished step; the other assertions of AC1
    // stay observable on the transitions that leave a step open.
    assert.equal(completed.stepCheckpoints['4'], undefined, 'AC5: a completed step leaves no checkpoint');

    const nextStep = stateManager.updateStepState(root, RUN_ID, 5, 'in_progress');
    assert.deepEqual(
      Object.keys(nextStep.stepCheckpoints),
      ['5'],
      'each open step has its own checkpoint'
    );
    assert.equal(nextStep.stepCheckpoints['5'].revision, nextStep.revision, 'the newest checkpoint states the newest revision');
    assert.ok(nextStep.stepCheckpoints['5'].recordedAt >= first.recordedAt, 'the checkpoint timestamp is monotonic');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC2.
test('AC2: checkpoint stores arbitrary progress JSON for a step', () => {
  const root = makeRoot();
  try {
    const progress = { completedTasks: ['task-1'], note: 'halfway' };
    const inline = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', JSON.stringify(progress)], root);
    assert.equal(inline.status, 0, `checkpoint exits 0: ${inline.stderr}`);
    assert.match(inline.stdout, /\[Checkpoint\] step 4 revision 1 saved/);

    const afterInline = stateManager.loadRunState(root, RUN_ID);
    assert.equal(afterInline.revision, 1);
    assert.equal(afterInline.stepCheckpoints['4'].step, 4);
    assert.equal(afterInline.stepCheckpoints['4'].status, 'pending', 'the checkpoint snapshots the step status');
    assert.equal(afterInline.stepCheckpoints['4'].revision, 1);
    assert.deepEqual(afterInline.stepCheckpoints['4'].progress, progress, 'the arbitrary progress JSON round-trips');

    fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify({ completedTasks: ['task-1', 'task-2'] }), 'utf8');
    const fromFile = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress-file', 'progress.json'], root);
    assert.equal(fromFile.status, 0, `checkpoint --progress-file exits 0: ${fromFile.stderr}`);
    assert.match(fromFile.stdout, /\[Checkpoint\] step 4 revision 2 saved/);

    const afterFile = stateManager.loadRunState(root, RUN_ID);
    assert.equal(afterFile.revision, 2);
    assert.deepEqual(afterFile.stepCheckpoints['4'].progress, { completedTasks: ['task-1', 'task-2'] });
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC2, negative path.
test('AC2: checkpoint rejects malformed progress JSON without mutating state', () => {
  const root = makeRoot();
  try {
    const result = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{oops'], root);
    assert.equal(result.status, 1, 'malformed progress JSON exits non-zero');
    assert.match(result.stderr, /cannot read checkpoint progress/);

    const state = stateManager.loadRunState(root, RUN_ID);
    assert.equal(state.revision, 0, 'a rejected checkpoint does not mutate the revision');
    assert.deepEqual(state.stepCheckpoints, {}, 'a rejected checkpoint stores nothing');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC3.
test('AC3: pause-turn stores the pause reason and next action', () => {
  const root = makeRoot();
  try {
    const result = runOrch(
      ['pause-turn', '--run-id', RUN_ID, '--step', '4', '--reason', 'host turn ended', '--next-action', 'resume task-2 implementation'],
      root
    );
    assert.equal(result.status, 0, `pause-turn exits 0: ${result.stderr}`);
    assert.match(result.stdout, /\[pause-turn\] step 4 paused: host turn ended/);
    assert.match(result.stdout, /\[pause-turn\] Next action: resume task-2 implementation/);

    const reloaded = stateManager.loadRunState(root, RUN_ID);
    assert.equal(reloaded.turnPause.step, 4, 'the pause names its step');
    assert.equal(reloaded.turnPause.reason, 'host turn ended');
    assert.equal(reloaded.turnPause.nextAction, 'resume task-2 implementation');
    assert.ok(!Number.isNaN(Date.parse(reloaded.turnPause.recordedAt)), 'the pause carries a parseable timestamp');
    assert.equal(reloaded.revision, 1, 'recording the pause mutates the state revision');

    const missingAction = runOrch(['pause-turn', '--run-id', RUN_ID, '--step', '4', '--reason', 'host turn ended'], root);
    assert.equal(missingAction.status, 1, 'a pause without a next action is rejected');
    assert.match(missingAction.stderr, /next action/);
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC4.
test('AC4: resume announces turnPause.nextAction and continues from the paused step', () => {
  const root = makeRoot();
  try {
    stateManager.updateStepState(root, RUN_ID, 1, 'completed', {});
    stateManager.updateStepState(root, RUN_ID, 2, 'completed', {});
    stateManager.updateStepState(root, RUN_ID, 3, 'completed', {
      tasks: [
        { id: 'task-1', title: 'Task 1', dependencies: [] },
        { id: 'task-2', title: 'Task 2', dependencies: ['task-1'] }
      ]
    });
    stateManager.updateStepState(root, RUN_ID, 4, 'in_progress');
    stateManager.updateTaskState(root, RUN_ID, 'task-1', { status: 'completed' });

    const pause = runOrch(
      ['pause-turn', '--run-id', RUN_ID, '--step', '4', '--reason', 'host turn ended', '--next-action', 'resume task-2 implementation'],
      root
    );
    assert.equal(pause.status, 0, `pause-turn exits 0: ${pause.stderr}`);
    const beforeResume = stateManager.loadRunState(root, RUN_ID);

    const resumed = runOrch(['resume', '--run-id', RUN_ID], root);
    assert.equal(resumed.status, 4, `resume waits for the pending DAG task instead of stalling: ${resumed.stderr}`);
    assert.match(resumed.stdout, /\[sdw-orch resume\] Turn pause at step 4: host turn ended/);
    assert.match(resumed.stdout, /\[sdw-orch resume\] Next action: resume task-2 implementation/);
    assert.match(resumed.stdout, /\[PENDING\] task-2: Task 2/, 'resume follows the paused step into the pending task');

    const afterResume = stateManager.loadRunState(root, RUN_ID);
    assert.equal(afterResume.revision, beforeResume.revision, 'an unchanged revision is not treated as a stall');
    assert.equal(afterResume.turnPause.nextAction, 'resume task-2 implementation', 'resume leaves the pause for the finishing task to clear');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC5.
test('AC5: finishing a step clears its checkpoint and its turn pause', () => {
  const root = makeRoot();
  try {
    stateManager.recordCheckpoint(root, RUN_ID, 4, { completedTasks: ['task-1'] });
    stateManager.recordTurnPause(root, RUN_ID, 4, 'host turn ended', 'resume task-2 implementation');
    assert.ok(stateManager.loadRunState(root, RUN_ID).stepCheckpoints['4'], 'precondition: the step checkpoint exists');

    const completed = stateManager.updateStepState(root, RUN_ID, 4, 'completed', { done: true });
    assert.equal(completed.stepCheckpoints['4'], undefined, 'a completed step leaves no checkpoint');
    assert.equal(completed.turnPause, null, 'a completed step leaves no turn pause');
    assert.equal(completed.revision, 3, 'the finish itself is still one mutation');

    stateManager.recordTurnPause(root, RUN_ID, 5, 'review pending', 'resume review');
    stateManager.recordCheckpoint(root, RUN_ID, 6, { note: 'still running' });
    const skipped = stateManager.updateStepState(root, RUN_ID, 6, 'skipped');
    assert.equal(skipped.stepCheckpoints['6'], undefined, 'a skipped step also clears its checkpoint');
    assert.equal(skipped.turnPause.step, 5, 'only the finished step loses its pause');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC6.
test('AC6: state is written through a temp file and renamed over the target', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const validBefore = fs.readFileSync(stateFile, 'utf8');

    // Prove the new state is complete before it can replace the target: a crash
    // at the rename (simulated by a throwing stub) leaves the previous file intact.
    const realRenameSync = fs.renameSync;
    let tempPath = null;
    let renameTarget = null;
    fs.renameSync = (from, to) => {
      tempPath = from;
      renameTarget = to;
      throw new Error('simulated crash before rename');
    };
    try {
      assert.throws(
        () => stateManager.recordWarning(root, RUN_ID, 4, 'interrupted write'),
        /simulated crash before rename/
      );
    } finally {
      fs.renameSync = realRenameSync;
    }

    assert.equal(renameTarget, stateFile, 'the rename targets the state file');
    assert.equal(tempPath, `${stateFile}.tmp-${process.pid}`, 'the write stages a sibling temp file');
    assert.ok(fs.existsSync(tempPath), 'the complete temp file survives the interrupted write');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), validBefore, 'the last valid state is untouched by an interrupted write');
    assert.doesNotThrow(() => stateManager.loadRunState(root, RUN_ID), 'the last valid state still parses');

    // The next successful write replaces the target and leaves no temp behind.
    const saved = stateManager.recordWarning(root, RUN_ID, 4, 'retry');
    assert.equal(saved.revision, 1);
    assert.deepEqual(
      fs.readdirSync(path.dirname(stateFile)).filter(name => name.includes('.tmp-')),
      [],
      'a successful write cleans up its temp file'
    );
    assert.equal(stateManager.loadRunState(root, RUN_ID).errors.length, 1, 'the retried write landed');

    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-state-atomic-create-'));
    try {
      stateManager.createRunState({ root: freshRoot, slug: 'atomic-create', runId: 'run-atomic-create' });
      assert.deepEqual(
        fs.readdirSync(path.dirname(stateManager.getStateFilePath(freshRoot, 'run-atomic-create'))).filter(name => name.includes('.tmp-')),
        [],
        'creating a run state also writes atomically and leaves no temp file'
      );
    } finally {
      cleanup(freshRoot);
    }
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC7.
test('AC7: every state mutation increments the monotonic revision once', () => {
  const root = makeRoot();
  try {
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 0, 'creation is the baseline, not a mutation');

    const revisions = [
      stateManager.updateStepState(root, RUN_ID, 1, 'in_progress').revision,
      stateManager.updateStepState(root, RUN_ID, 1, 'completed').revision,
      stateManager.recordWarning(root, RUN_ID, 1, 'heads up').revision,
      stateManager.recordStepArtifact(root, RUN_ID, 1, '.sdw/steps/1.md').revision,
      stateManager.updateTaskState(root, RUN_ID, 'task-1', { status: 'pending' }).revision,
      stateManager.updateGateState(root, RUN_ID, 'build', { status: 'passed' }).revision,
      stateManager.recordCheckpoint(root, RUN_ID, 2, { note: 'progress' }).state.revision,
      stateManager.recordTurnPause(root, RUN_ID, 2, 'turn ended', 'resume step 2').state.revision
    ];
    assert.deepEqual(revisions, [1, 2, 3, 4, 5, 6, 7, 8], 'each mutation advances exactly one revision');
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 8, 'the revision is persisted, not only held in memory');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC8, partial-write path.
test('AC8: resume refuses a partial state file and names it with remediation', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    fs.writeFileSync(stateFile, '{"orchestrator": "sdw-orch", "runId": "run-checkpoint-demo", "revis', 'utf8');

    const result = runOrch(['resume', '--run-id', RUN_ID], root);
    assert.equal(result.status, 1, `a partial state file refuses resume: ${result.stderr}`);
    assert.match(result.stderr, /Refusing to resume/);
    assert.ok(result.stderr.includes(stateManager.normalizePath(stateFile)), 'the refusal names the state file');
    assert.match(result.stderr, /Remediation:/, 'the refusal states the remediation');
    assert.doesNotMatch(result.stderr, /at Object\./, 'the refusal is not an unhandled stack trace');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC8, unsupported-revision path.
test('AC8: resume refuses a state file whose revision is missing or not a non-negative integer', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const cases = [
      ['missing', state => { delete state.revision; }],
      ['negative', state => { state.revision = -1; }],
      ['fractional', state => { state.revision = 1.5; }],
      ['non-integer string', state => { state.revision = '2'; }]
    ];

    for (const [label, mutate] of cases) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      mutate(state);
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');

      const result = runOrch(['resume', '--run-id', RUN_ID], root);
      assert.equal(result.status, 1, `${label} revision refuses resume: ${result.stderr}`);
      assert.match(result.stderr, /not resumable/);
      assert.match(result.stderr, /revision is/, `${label}: the refusal names the revision defect`);
      assert.ok(result.stderr.includes(stateManager.normalizePath(stateFile)), `${label}: the refusal names the state file`);
      assert.match(result.stderr, /Remediation:/, `${label}: the refusal states the remediation`);
    }

    assert.deepEqual(
      stateManager.validateResumableState({ revision: 0 }),
      { ok: true },
      'a non-negative integer revision, including a fresh run, stays resumable'
    );
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC9.
test('AC9: a mutation takes the exclusive run lock and releases it afterwards', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const lockFile = `${stateFile}.lock`;
    assert.equal(fs.existsSync(lockFile), false, 'a fresh run holds no lock');

    const saved = stateManager.recordWarning(root, RUN_ID, 4, 'lock probe');
    assert.equal(saved.revision, 1, 'the mutation landed');
    assert.equal(fs.existsSync(lockFile), false, 'the lock is released after a successful mutation');

    const handle = runLock.acquire(stateFile, { staleMs: 60000 });
    const record = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(record.pid, process.pid, 'the lock names the owner pid');
    assert.equal(record.host, os.hostname(), 'the lock names the owner host');
    assert.ok(!Number.isNaN(Date.parse(record.acquiredAt)), 'the lock carries a parseable acquisition timestamp');
    assert.throws(
      () => runLock.acquire(stateFile, { staleMs: 60000 }),
      err => err.code === 'RUN_LOCKED' && err.message.includes(`pid ${process.pid}`),
      'a second acquisition is refused while the lock is live'
    );
    assert.equal(runLock.release(handle), true, 'release removes the owned lock');
    assert.equal(fs.existsSync(lockFile), false, 'releasing leaves no lock file behind');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC9: the lock must survive a nesting mutation and never outlive a throw.
test('AC9: the lock is reentrant for one process and released when the mutation throws', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const lockFile = `${stateFile}.lock`;

    // updateStepState calls saveRunState while holding the lock: a non-reentrant
    // lock would block or throw here.
    const completed = stateManager.updateStepState(root, RUN_ID, 4, 'completed', { done: true });
    assert.equal(completed.revision, 1, 'a nested mutation acquires the lock once and advances one revision');
    assert.equal(fs.existsSync(lockFile), false, 'the outermost mutation releases the lock');

    const realRenameSync = fs.renameSync;
    fs.renameSync = () => {
      throw new Error('simulated write failure');
    };
    try {
      assert.throws(() => stateManager.recordWarning(root, RUN_ID, 4, 'fails'), /simulated write failure/);
    } finally {
      fs.renameSync = realRenameSync;
    }
    assert.equal(fs.existsSync(lockFile), false, 'the lock is released even when the write throws');
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 1, 'the failed mutation did not advance the revision');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC9 & AC10.
test('AC9: a stale lock is reclaimed only after lockStaleMs and only when the owner is gone', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(
      path.join(root, '.sdw', 'config.json'),
      JSON.stringify({ specsDir: '{projectRoot}/.sdw/specs', lockStaleMs: 60000 }, null, 2) + '\n',
      'utf8'
    );
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const lockFile = `${stateFile}.lock`;

    writeLockRecord(stateFile, {
      pid: DEAD_PID,
      host: os.hostname(),
      acquiredAt: new Date(Date.now() - 120000).toISOString()
    });
    const reclaimed = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{}'], root);
    assert.equal(reclaimed.status, 0, `the configured 60000 ms threshold reclaims the stale lock: ${reclaimed.stderr}`);
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 1, 'the reclaimed mutation landed');
    assert.equal(fs.existsSync(lockFile), false, 'the reclaimed lock is released after the write');

    // The same shape at 30 s stays: it is younger than the configured threshold.
    writeLockRecord(stateFile, {
      pid: DEAD_PID,
      host: os.hostname(),
      acquiredAt: new Date(Date.now() - 30000).toISOString()
    });
    const young = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{}'], root);
    assert.equal(young.status, 1, 'a lock younger than the threshold is never reclaimed');
    assert.match(young.stderr, /younger than lockStaleMs=60000/);
    assert.ok(fs.existsSync(lockFile), 'the young lock stays in place');
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 1, 'the refused mutation did not advance the revision');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC9 & AC10: absence of the owner cannot be proven across hosts.
test('AC9: a stale lock from another host is never reclaimed automatically', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const lockFile = writeLockRecord(stateFile, {
      pid: DEAD_PID,
      host: 'sdw-foreign-host',
      acquiredAt: new Date(Date.now() - 600000).toISOString()
    });

    const result = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{}'], root);
    assert.equal(result.status, 1, 'a foreign-host lock is not reclaimed');
    assert.match(result.stderr, /another host/, 'the refusal explains that the owner cannot be verified here');
    assert.match(result.stderr, /delete the lock file manually/i, 'the refusal states the manual remediation');
    assert.ok(fs.existsSync(lockFile), 'the foreign lock stays in place');
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 0, 'the refused mutation did not advance the revision');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC10.
test('AC10: a live run lock blocks mutation with an actionable owner message', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const owner = { pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() };
    const lockFile = writeLockRecord(stateFile, owner);

    const result = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{}'], root);
    assert.equal(result.status, 1, `a held lock fails the mutation: ${result.stderr}`);
    assert.ok(result.stderr.includes(`pid ${owner.pid}`), 'the message names the owner pid');
    assert.ok(result.stderr.includes(owner.host), 'the message names the owner host');
    assert.ok(result.stderr.includes(stateManager.normalizePath(lockFile)), 'the message names the lock file');
    assert.match(result.stderr, /delete the lock file manually/, 'the message states the manual remediation');
    assert.doesNotMatch(result.stderr, /at Object\./, 'the refusal is not an unhandled stack trace');

    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 0, 'the blocked mutation leaves the state untouched');
    assert.throws(
      () => stateManager.recordWarning(root, RUN_ID, 4, 'blocked'),
      err => err.code === 'RUN_LOCKED',
      'the helper refuses a direct mutation while the lock is held'
    );
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC10: a younger lock is not reclaimed even after the owner disappears.
test('AC10: a lock younger than lockStaleMs is not reclaimed even when its owner is gone', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const lockFile = writeLockRecord(stateFile, {
      pid: DEAD_PID,
      host: os.hostname(),
      acquiredAt: new Date().toISOString()
    });

    const result = runOrch(['pause-turn', '--run-id', RUN_ID, '--step', '4', '--reason', 'host turn ended', '--next-action', 'resume'], root);
    assert.equal(result.status, 1, 'a young lock blocks mutation until it is stale');
    assert.match(result.stderr, /younger than lockStaleMs=300000/, 'the refusal names the default threshold');
    assert.match(result.stderr, /delete the lock file manually/, 'the refusal states the manual remediation');
    assert.ok(fs.existsSync(lockFile), 'the young lock stays in place');
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 0, 'the refused mutation did not advance the revision');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC11: a finished run refreshes reports but re-executes no step.
test('AC11: resume of a run whose steps are all resolved re-executes no step', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-state-complete-'));
  try {
    fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.sdw', 'specs', 'complete-demo.md'),
      '# Complete Demo\n\n## Acceptance Criteria\n\n- AC1: The system shall stay complete.\n',
      'utf8'
    );
    stateManager.createRunState({ root, specPath: '.sdw/specs/complete-demo.md', slug: 'complete-demo', runId: RUN_ID });
    for (let step = 1; step <= 8; step++) {
      stateManager.updateStepState(root, RUN_ID, step, step === 2 ? 'skipped' : 'completed', { step });
    }
    const before = stateManager.loadRunState(root, RUN_ID);
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);

    const result = runOrch(['resume', '--run-id', RUN_ID], root);
    assert.equal(result.status, 0, `resuming a resolved run exits 0: ${result.stderr}`);
    assert.match(result.stdout, /already complete \(all 8 steps resolved\); refreshing reports without re-executing completed steps/);

    const after = stateManager.loadRunState(root, RUN_ID);
    assert.deepEqual(after.steps, before.steps, 'no resolved step is re-executed or rewritten');
    assert.equal(after.status, 'completed', 'the run stays completed');
    assert.equal(fs.existsSync(`${stateFile}.lock`), false, 'the resume leaves no lock behind');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC11: repeated resume of an open run touches no completed step.
test('AC11: repeated resume leaves completed steps untouched and reports the pending task', () => {
  const root = makeRoot();
  try {
    stateManager.updateStepState(root, RUN_ID, 1, 'completed', { derivationNeeded: false });
    stateManager.updateStepState(root, RUN_ID, 2, 'completed', { mode: 'refine' });
    stateManager.updateStepState(root, RUN_ID, 3, 'completed', {
      tasks: [
        { id: 'task-1', title: 'Task 1', dependencies: [] },
        { id: 'task-2', title: 'Task 2', dependencies: ['task-1'] }
      ]
    });
    stateManager.updateStepState(root, RUN_ID, 4, 'in_progress');
    const before = stateManager.loadRunState(root, RUN_ID);

    const first = runOrch(['resume', '--run-id', RUN_ID], root);
    assert.equal(first.status, 4, `resume waits for the pending task: ${first.stderr}`);
    assert.match(first.stdout, /\[PENDING\] task-1: Task 1/);
    const second = runOrch(['resume', '--run-id', RUN_ID], root);
    assert.equal(second.status, 4, `a second resume reaches the same point: ${second.stderr}`);

    const after = stateManager.loadRunState(root, RUN_ID);
    assert.equal(after.revision, before.revision, 'resume of an unresolved run does not mutate state');
    assert.deepEqual(after.steps[1], before.steps[1], 'step 1 is not re-executed');
    assert.deepEqual(after.steps[2], before.steps[2], 'step 2 is not re-executed');
    assert.deepEqual(after.steps[3], before.steps[3], 'step 3 is not re-executed');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC12.
test('AC12: an interrupted write leaves the last valid state and the next successful write clears stale temp files', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const stateDir = path.dirname(stateFile);
    const tempPrefix = `${path.basename(stateFile)}.tmp-`;
    const validBefore = fs.readFileSync(stateFile, 'utf8');

    // Two leftovers: a partial write (invalid JSON) and a complete-looking newer
    // state from a pid that no longer exists. Neither may replace the last valid
    // state, and neither may fail the load.
    fs.writeFileSync(`${stateFile}.tmp-${DEAD_PID}`, '{"orchestrator": "sdw-orch", "revis', 'utf8');
    const rogue = JSON.parse(validBefore);
    rogue.currentStep = 8;
    rogue.revision = 99;
    fs.writeFileSync(`${stateFile}.tmp-${DEAD_PID + 1}`, JSON.stringify(rogue, null, 2) + '\n', 'utf8');

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let recovered;
    try {
      recovered = stateManager.loadRunState(root, RUN_ID);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(recovered.revision, 0, 'the last valid state is recovered');
    assert.equal(recovered.currentStep, 1, 'a newer temp file never replaces the last valid state');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), validBefore, 'loading never rewrites the state file');
    assert.ok(
      warnings.some((line) => /Warning: stale state temp file/.test(line)),
      'a stale temp file is a warning, not a failure'
    );

    // The next successful write lands and deletes every stale temp file, while
    // the warning alone never fails the command.
    const saved = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{"note":"retry"}'], root);
    assert.equal(saved.status, 0, `a stale temp file does not fail the write: ${saved.stderr}`);
    assert.match(saved.stderr, /Warning: stale state temp file/);
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 1, 'the write landed on the recovered state');
    assert.deepEqual(
      fs.readdirSync(stateDir).filter((name) => name.startsWith(tempPrefix)),
      [],
      'the next successful write deletes stale temp files'
    );
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC13.
test('AC13: checkpoint and pause-turn record telemetry events in run state', () => {
  const root = makeRoot();
  try {
    const checkpointResult = runOrch(
      ['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{"completedTasks":["task-1"]}'],
      root
    );
    assert.equal(checkpointResult.status, 0, `checkpoint exits 0: ${checkpointResult.stderr}`);
    const pauseResult = runOrch(
      ['pause-turn', '--run-id', RUN_ID, '--step', '4', '--reason', 'host turn ended', '--next-action', 'resume task-2 implementation'],
      root
    );
    assert.equal(pauseResult.status, 0, `pause-turn exits 0: ${pauseResult.stderr}`);

    const state = stateManager.loadRunState(root, RUN_ID);
    const events = state.reportContributions.filter((entry) => entry.kind === 'checkpoint' || entry.kind === 'turn_paused');
    assert.equal(events.length, 2, 'one event is recorded per checkpoint and turn pause');

    const checkpointEvent = events.find((entry) => entry.kind === 'checkpoint');
    assert.equal(checkpointEvent.step, 4, 'the checkpoint event names its step');
    assert.equal(checkpointEvent.stepName, 'implementation', 'the checkpoint event names the step kind');
    assert.equal(checkpointEvent.body.revision, 1, 'the checkpoint event carries the revision it produced');
    assert.deepEqual(checkpointEvent.body.progress, { completedTasks: ['task-1'] }, 'the event carries the progress payload');
    assert.ok(!Number.isNaN(Date.parse(checkpointEvent.at)), 'the event carries a parseable timestamp');

    const pauseEvent = events.find((entry) => entry.kind === 'turn_paused');
    assert.equal(pauseEvent.step, 4, 'the pause event names its step');
    assert.equal(pauseEvent.body.reason, 'host turn ended', 'the pause event carries the reason');
    assert.equal(pauseEvent.body.nextAction, 'resume task-2 implementation', 'the pause event carries the next action');
    assert.equal(pauseEvent.body.revision, 2, 'the pause event carries the revision it produced');
    assert.equal(state.revision, 2, 'both mutations are persisted');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC14.
test('AC14: the orchestrator protocol documents the state schema, revision, lock, recovery, and pause rules', () => {
  const protocol = fs.readFileSync(
    path.resolve(__dirname, '../skills/sdw-orch/references/orchestrator_protocol.md'),
    'utf8'
  );
  assert.match(protocol, /"revision":/, 'the state schema documents the revision field');
  assert.match(protocol, /"stepCheckpoints":/, 'the state schema documents stepCheckpoints');
  assert.match(protocol, /"turnPause":/, 'the state schema documents turnPause');
  assert.match(protocol, /every persisted mutation .*advances it by exactly one/i, 'the revision rule is documented');
  assert.match(protocol, /lockStaleMs/, 'the lock threshold key is documented');
  assert.match(protocol, /\{stateFile\}\.lock/, 'the lock file location is documented');
  assert.match(protocol, /\{stateFile\}\.tmp-\{pid\}/, 'the atomic write temp file is documented');
  assert.match(protocol, /stale temp file is a warning, not a failure/i, 'the recovery failure policy is documented');
  assert.match(protocol, /turn pause is a handoff marker, not a failure/i, 'the turn pause semantics are documented');
});

// Spec 00019 AC15: unknown checkpoint step.
test('AC15: a checkpoint for a step outside 1..totalSteps is refused and writes nothing', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const before = fs.readFileSync(stateFile, 'utf8');

    const refused = runOrch(
      ['checkpoint', '--run-id', RUN_ID, '--step', '99', '--progress', '{"note":"unknown step"}'],
      root
    );
    assert.equal(refused.status, 1, `an unknown step exits non-zero: ${refused.stderr}`);
    assert.match(refused.stderr, /Invalid checkpoint step 99/, 'the refusal names the unknown step');
    assert.match(refused.stderr, /the valid range is 1\.\.8/, 'the refusal names the valid range');
    assert.doesNotMatch(refused.stderr, /at Object\./, 'the refusal is not an unhandled stack trace');

    const state = stateManager.loadRunState(root, RUN_ID);
    assert.equal(state.revision, 0, 'a rejected checkpoint does not advance the revision');
    assert.deepEqual(state.stepCheckpoints, {}, 'a rejected checkpoint stores no checkpoint record');
    assert.deepEqual(state.reportContributions || [], [], 'a rejected checkpoint emits no telemetry');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'the rejected checkpoint leaves the state file untouched');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC15: unknown turn-pause step.
test('AC15: a pause-turn for a step outside 1..totalSteps is refused and writes nothing', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const before = fs.readFileSync(stateFile, 'utf8');

    const refused = runOrch(
      ['pause-turn', '--run-id', RUN_ID, '--step', '99', '--reason', 'host turn ended', '--next-action', 'resume'],
      root
    );
    assert.equal(refused.status, 1, `an unknown step exits non-zero: ${refused.stderr}`);
    assert.match(refused.stderr, /Invalid turn-pause step 99/, 'the refusal names the unknown step');
    assert.match(refused.stderr, /the valid range is 1\.\.8/, 'the refusal names the valid range');

    const state = stateManager.loadRunState(root, RUN_ID);
    assert.equal(state.revision, 0, 'a rejected pause does not advance the revision');
    assert.equal(state.turnPause, null, 'a rejected pause stores no turn-pause record');
    assert.deepEqual(state.reportContributions || [], [], 'a rejected pause emits no telemetry');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'the rejected pause leaves the state file untouched');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC15: the upper bound is state.totalSteps, never a fixed 8.
test('AC15: the accepted step range follows state.totalSteps', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.totalSteps = 3;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');

    const above = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{}'], root);
    assert.equal(above.status, 1, 'a step above a non-default total is refused');
    assert.match(above.stderr, /step 4/, 'the refusal names the step');
    assert.match(above.stderr, /the valid range is 1\.\.3/, 'the refusal uses state.totalSteps');

    const zero = runOrch(
      ['pause-turn', '--run-id', RUN_ID, '--step', '0', '--reason', 'host turn ended', '--next-action', 'resume'],
      root
    );
    assert.equal(zero.status, 1, 'a step below the range is refused');
    assert.match(zero.stderr, /step 0/, 'the refusal names the step');
    assert.match(zero.stderr, /the valid range is 1\.\.3/, 'the refusal uses state.totalSteps');

    const inside = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '3', '--progress', '{}'], root);
    assert.equal(inside.status, 0, `a step inside the range is accepted: ${inside.stderr}`);
    assert.match(inside.stdout, /\[Checkpoint\] step 3 revision 1 saved/);
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC16 & AC17: pause persistence and pause resume.
test('AC16 & AC17: a turn pause survives a process restart and resume honours its next action', () => {
  const root = makeRoot();
  try {
    stateManager.updateStepState(root, RUN_ID, 1, 'completed', {});
    stateManager.updateStepState(root, RUN_ID, 2, 'completed', {});
    stateManager.updateStepState(root, RUN_ID, 3, 'completed', {
      tasks: [
        { id: 'task-1', title: 'Task 1', dependencies: [] },
        { id: 'task-2', title: 'Task 2', dependencies: ['task-1'] }
      ]
    });
    stateManager.updateStepState(root, RUN_ID, 4, 'in_progress');
    stateManager.updateTaskState(root, RUN_ID, 'task-1', { status: 'completed' });

    const pause = runOrch(
      ['pause-turn', '--run-id', RUN_ID, '--step', '4', '--reason', 'host turn ended', '--next-action', 'resume task-2 implementation'],
      root
    );
    assert.equal(pause.status, 0, `pause-turn exits 0: ${pause.stderr}`);

    // Read the pause from disk in a fresh process: nothing is shared in memory.
    const readScript = [
      `const stateManager = require(${JSON.stringify(STATE_MANAGER_PATH)});`,
      `const state = stateManager.loadRunState(${JSON.stringify(root)}, ${JSON.stringify(RUN_ID)});`,
      'process.stdout.write(JSON.stringify(state.turnPause));'
    ].join('\n');
    const fresh = spawnSync(process.execPath, ['-e', readScript], { encoding: 'utf8' });
    assert.equal(fresh.status, 0, `a fresh process reads the run state: ${fresh.stderr}`);
    const pauseFromDisk = JSON.parse(fresh.stdout);
    assert.equal(pauseFromDisk.step, 4, 'the fresh process finds the paused step');
    assert.equal(pauseFromDisk.reason, 'host turn ended', 'the fresh process finds the pause reason');
    assert.equal(pauseFromDisk.nextAction, 'resume task-2 implementation', 'the fresh process finds the recorded next action');

    const resumed = runOrch(['resume', '--run-id', RUN_ID], root);
    assert.equal(resumed.status, 4, `resume continues from the paused step into the pending task: ${resumed.stderr}`);
    assert.match(resumed.stdout, /\[sdw-orch resume\] Turn pause at step 4: host turn ended/);
    assert.match(resumed.stdout, /\[sdw-orch resume\] Next action: resume task-2 implementation/);
    assert.match(resumed.stdout, /\[PENDING\] task-2: Task 2/, 'resume follows the recorded next action');

    assert.equal(
      stateManager.loadRunState(root, RUN_ID).turnPause.nextAction,
      'resume task-2 implementation',
      'the pause stays persisted until the paused step finishes'
    );
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC17: concurrent writers.
test('AC17: concurrent writers contend on the run lock and the loser names the owner', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const lockFile = `${stateFile}.lock`;
    const handle = runLock.acquire(stateFile, { staleMs: 60000 });
    try {
      const loser = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{}'], root);
      assert.equal(loser.status, 1, `the second writer is refused: ${loser.stderr}`);
      assert.ok(loser.stderr.includes(`pid ${process.pid}`), 'the refusal names the lock owner pid');
      assert.ok(loser.stderr.includes(os.hostname()), 'the refusal names the owner host');
      assert.ok(loser.stderr.includes(stateManager.normalizePath(lockFile)), 'the refusal names the lock file');
      assert.match(loser.stderr, /Another sdw-orch process is mutating this run state/, 'the refusal names the contention');

      const blockedState = stateManager.loadRunState(root, RUN_ID);
      assert.equal(blockedState.revision, 0, 'the losing writer changes no state');
      assert.deepEqual(blockedState.stepCheckpoints, {}, 'the losing writer stores no checkpoint');
    } finally {
      runLock.release(handle);
    }
    assert.equal(fs.existsSync(lockFile), false, 'the owner releases the lock after the critical section');

    const winner = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{}'], root);
    assert.equal(winner.status, 0, `the writer proceeds once the lock is released: ${winner.stderr}`);
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 1, 'only the lock-holding writer lands');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC17: interrupted writes.
test('AC17: a fresh process ignores interrupted-write temp files and keeps the last valid state', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const stateDir = path.dirname(stateFile);
    const validBefore = fs.readFileSync(stateFile, 'utf8');

    // A partial temp file and a complete-looking newer temp file from a dead
    // writer: neither may replace the last valid state.
    fs.writeFileSync(`${stateFile}.tmp-${DEAD_PID}`, '{"orchestrator": "sdw-orch", "revis', 'utf8');
    const rogue = JSON.parse(validBefore);
    rogue.revision = 99;
    rogue.currentStep = 8;
    fs.writeFileSync(`${stateFile}.tmp-${DEAD_PID + 1}`, JSON.stringify(rogue, null, 2) + '\n', 'utf8');

    const written = runOrch(['checkpoint', '--run-id', RUN_ID, '--step', '4', '--progress', '{"note":"after crash"}'], root);
    assert.equal(written.status, 0, `the write recovers from the temp files: ${written.stderr}`);
    assert.match(written.stderr, /Warning: stale state temp file/, 'the stale temp files are reported');

    const state = stateManager.loadRunState(root, RUN_ID);
    assert.equal(state.revision, 1, 'the write starts from the last valid revision, not the rogue revision');
    assert.equal(state.currentStep, 1, 'the rogue temp state never replaced the last valid state');
    assert.equal(state.stepCheckpoints['4'].revision, 1, 'the checkpoint uses the recovered revision');
    assert.equal(fs.readFileSync(stateFile, 'utf8').includes('"currentStep": 8'), false, 'the rogue content is absent from the state file');
    assert.deepEqual(
      fs.readdirSync(stateDir).filter((name) => name.includes('.tmp-')),
      [],
      'the successful write removes every stale temp file'
    );
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC17: revision mismatch.
test('AC17: a missing or unsupported revision is refused by resume without mutating state', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const base = fs.readFileSync(stateFile, 'utf8');
    const cases = [
      ['missing', (state) => { delete state.revision; }, /revision is missing/],
      ['unsupported', (state) => { state.revision = '3'; }, /revision is "3"/]
    ];

    for (const [label, mutate, revisionPattern] of cases) {
      const state = JSON.parse(base);
      mutate(state);
      const written = JSON.stringify(state, null, 2) + '\n';
      fs.writeFileSync(stateFile, written, 'utf8');

      const refused = runOrch(['resume', '--run-id', RUN_ID], root);
      assert.equal(refused.status, 1, `${label} revision refuses resume: ${refused.stderr}`);
      assert.match(refused.stderr, /not resumable/, `${label}: the refusal names the state`);
      assert.match(refused.stderr, revisionPattern, `${label}: the refusal names the revision defect`);
      assert.ok(refused.stderr.includes(stateManager.normalizePath(stateFile)), `${label}: the refusal names the state file`);
      assert.match(refused.stderr, /Remediation:/, `${label}: the refusal states the remediation`);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), written, `${label}: the refused resume leaves the file untouched`);
    }
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC17: idempotent completed steps.
test('AC17: resuming an open run leaves its completed steps untouched', () => {
  const root = makeRoot();
  try {
    stateManager.updateStepState(root, RUN_ID, 1, 'completed', { derivationNeeded: false });
    stateManager.updateStepState(root, RUN_ID, 2, 'completed', { mode: 'refine' });
    stateManager.updateStepState(root, RUN_ID, 3, 'completed', {
      tasks: [
        { id: 'task-1', title: 'Task 1', dependencies: [] },
        { id: 'task-2', title: 'Task 2', dependencies: ['task-1'] }
      ]
    });
    stateManager.updateStepState(root, RUN_ID, 4, 'in_progress');
    const before = stateManager.loadRunState(root, RUN_ID);

    const first = runOrch(['resume', '--run-id', RUN_ID], root);
    assert.equal(first.status, 4, `the first resume waits for the pending task: ${first.stderr}`);
    const second = runOrch(['resume', '--run-id', RUN_ID], root);
    assert.equal(second.status, 4, `the second resume reaches the same point: ${second.stderr}`);

    const after = stateManager.loadRunState(root, RUN_ID);
    assert.equal(after.revision, before.revision, 'resume of an open run mutates no state');
    for (const step of [1, 2, 3, 4]) {
      assert.deepEqual(after.steps[step], before.steps[step], `step ${step} is not re-executed or rewritten`);
    }
    assert.equal(after.stepCheckpoints['1'], undefined, 'a completed step keeps no checkpoint');
    assert.equal(after.stepCheckpoints['2'], undefined, 'a completed step keeps no checkpoint');
    assert.equal(after.stepCheckpoints['3'], undefined, 'a completed step keeps no checkpoint');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 revision protocol (AC7 & AC17): a stale in-memory writer fails
// closed instead of erasing a newer checkpoint or pause written by another
// process after the stale object was loaded.
test('AC7 & AC17: a stale in-memory state is refused and the newer pause survives', () => {
  const root = makeRoot();
  try {
    const stale = stateManager.loadRunState(root, RUN_ID);
    stateManager.recordTurnPause(root, RUN_ID, 4, 'host turn ended', 'resume task-2 implementation');
    const paused = stateManager.loadRunState(root, RUN_ID);
    assert.equal(paused.revision, 1, 'the concurrent writer advanced the revision');
    assert.equal(paused.turnPause.step, 4, 'the concurrent writer stored the pause');

    assert.throws(
      () => stateManager.saveRunState(root, stale),
      /Stale run state write refused .*revision 1 .*in-memory state is at 0/,
      'the stale writer cannot overwrite the newer revision'
    );

    const afterRefusal = stateManager.loadRunState(root, RUN_ID);
    assert.equal(afterRefusal.revision, 1, 'the refused write did not advance the revision');
    assert.equal(afterRefusal.turnPause.nextAction, 'resume task-2 implementation', 'the newer pause survives the refused write');

    const reloaded = stateManager.loadRunState(root, RUN_ID);
    stateManager.saveRunState(root, reloaded);
    assert.equal(stateManager.loadRunState(root, RUN_ID).revision, 2, 'a reloaded writer still lands');
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC10 & AC17: a lock file left empty by a crash between creation and
// its record write is reclaimed once it is older than lockStaleMs, and refused
// while it is young (there is no owner pid to prove absent).
test('AC10 & AC17: an unreadable lock is reclaimed only once it is older than lockStaleMs', () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const lockFile = `${stateFile}.lock`;

    fs.writeFileSync(lockFile, '', 'utf8');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
    const reclaimed = runLock.acquire(stateFile, { staleMs: 60000 });
    assert.equal(reclaimed.reclaimed, true, 'an old unreadable lock is reclaimed');
    runLock.release(reclaimed);
    assert.equal(fs.existsSync(lockFile), false, 'the reclaimed lock is released');

    fs.writeFileSync(lockFile, '', 'utf8');
    assert.throws(
      () => runLock.acquire(stateFile, { staleMs: 60000 }),
      (err) => err.code === 'RUN_LOCKED' && /does not contain a readable pid/.test(err.message),
      'a young unreadable lock is refused with the manual-removal message'
    );
    fs.unlinkSync(lockFile);
  } finally {
    cleanup(root);
  }
});

// Spec 00019 AC9 & AC17: reclaim is serialized, so two processes that both see
// the same abandoned lock cannot both acquire it by unlinking each other's lock.
test('AC9 & AC17: two concurrent reclaimers of one stale lock never both acquire it', async () => {
  const root = makeRoot();
  try {
    const stateFile = stateManager.getStateFilePath(root, RUN_ID);
    const startFile = path.join(root, 'start.reclaim');
    fs.writeFileSync(
      `${stateFile}.lock`,
      JSON.stringify({ pid: DEAD_PID, host: os.hostname(), acquiredAt: new Date(Date.now() - 600000).toISOString() }, null, 2) + '\n',
      'utf8'
    );

    // Both children wait for the same start file, so their acquire attempts begin
    // within the winner's holding window instead of one after the other.
    const script = [
      "const fs = require('fs');",
      `const runLock = require(${JSON.stringify(RUN_LOCK_PATH)});`,
      `while (!fs.existsSync(${JSON.stringify(startFile)})) {`,
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
      '}',
      'try {',
      `  const handle = runLock.acquire(${JSON.stringify(stateFile)}, { staleMs: 60000 });`,
      "  process.stdout.write('acquired');",
      '  setTimeout(() => { runLock.release(handle); }, 3000);',
      '} catch (err) {',
      "  process.stdout.write('refused:' + (err.code || 'ERROR'));",
      '}'
    ].join('\n');

    const attempt = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', () => resolve(out.trim()));
    });

    const attempts = Promise.all([attempt(), attempt()]);
    // Give both children time to reach the wait loop before releasing them.
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.writeFileSync(startFile, 'go\n', 'utf8');
    const results = await attempts;

    const acquired = results.filter((result) => result === 'acquired');
    assert.equal(acquired.length, 1, `exactly one reclaimer acquires the lock: ${JSON.stringify(results)}`);
    assert.match(results.find((result) => result !== 'acquired') || '', /^refused:RUN_LOCKED$/, 'the loser reports contention');
    assert.equal(fs.existsSync(`${stateFile}.lock`), false, 'the winner releases the reclaimed lock');
    assert.equal(fs.existsSync(`${stateFile}.lock.reclaim`), false, 'the reclaim guard is cleaned up');
  } finally {
    cleanup(root);
  }
});
