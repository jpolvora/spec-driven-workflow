'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');

const CLI_PATH = path.resolve(__dirname, '../skills/sdw-orch/scripts/sdw_orch.cjs');
const RUN_ID = 'run-checkpoint-demo';

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
    const second = completed.stepCheckpoints['4'];
    assert.equal(second.status, 'completed');
    assert.equal(second.revision, completed.revision);
    assert.equal(completed.revision, 2, 'the second transition advanced the revision again');
    assert.ok(second.recordedAt >= first.recordedAt, 'the checkpoint timestamp is monotonic');

    const nextStep = stateManager.updateStepState(root, RUN_ID, 5, 'in_progress');
    assert.equal(nextStep.stepCheckpoints['4'].status, 'completed', 'the resolved step keeps its last transition record');
    assert.deepEqual(
      Object.keys(nextStep.stepCheckpoints).sort(),
      ['4', '5'],
      'each transitioned step has its own checkpoint'
    );
    assert.equal(nextStep.stepCheckpoints['5'].revision, nextStep.revision, 'the newest checkpoint states the newest revision');
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
