'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const { installJudgeEnv } = require('./fixtures/judge_env.cjs');

installJudgeEnv();

// Two DAG tasks: the planner decomposes on complexity (>5 criteria + cli/state/git touchpoints).
const COMPLEX_SPEC = `---
slug: dispatch-demo
---
# Dispatch Demo
## Description
Exercises the CLI, run state, and git integration.
## Acceptance Criteria
- AC1: The system shall record cli run state.
- AC2: The system shall persist state on disk.
- AC3: The system shall record git changes.
- AC4: The system shall report cli status.
- AC5: The system shall resume from state.
- AC6: The system shall finish the git workflow.
`;

function setupRepo(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-dispatch-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, 'dispatch-demo.md'), options.spec !== undefined ? options.spec : COMPLEX_SPEC);
  if (options.git !== false) {
    execSync('git init -q', { cwd: root, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
    execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'app.cjs'), '// baseline\n');
    execSync('git add .sdw app.cjs', { cwd: root, stdio: 'ignore' });
    execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });
  }
  return root;
}

function pauseAtDispatch(root) {
  return sdwOrch.cmdRun({
    root,
    specPath: '.sdw/specs/dispatch-demo.md',
    skipReview: true,
    skipPr: true
  });
}

function gitOut(root, args) {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim();
}

// Writes evidence for a task and touches a declared file so corroboration passes.
function submitEvidence(root, taskId, options = {}) {
  const state = stateManager.findLatestRunState(root);
  const record = state.steps[4].tasks[taskId];
  const targetFile = options.file || 'app.cjs';
  fs.appendFileSync(path.join(root, targetFile), `// ${taskId} work\n`);
  const evidence = {
    taskId,
    status: options.status || 'success',
    acIds: options.acIds || [state.dagTasks[0].coveredAcs[0]],
    filesChanged: [targetFile],
    tests: options.tests || [],
    summary: options.summary || `${taskId} implemented`
  };
  const evidencePath = path.join(root, `${taskId}.evidence.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  return { evidencePath, runId: state.runId, record };
}

test('AC4-AC8: task next dispatches one ready task, refuses a concurrent dispatch, and reports exhaustion', () => {
  const root = setupRepo();
  try {
    assert.equal(pauseAtDispatch(root), 4);
    const state = stateManager.findLatestRunState(root);
    assert.equal(state.steps[4].dispatch.sequence, 1, 'Step 4 dispatches the first task');
    const firstTask = state.steps[4].dispatch.activeTaskId;
    assert.ok(firstTask);

    // A second dispatch while one is in flight is refused and names the active task.
    const second = sdwOrch.cmdTaskNext({ root, runId: state.runId });
    assert.equal(second, 1, 'A second dispatch is rejected');

    // Finish the first task, then the next dispatch works and increments the sequence.
    const { evidencePath } = submitEvidence(root, firstTask);
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId: firstTask, evidencePath }), 0);

    const afterFirst = stateManager.loadRunState(root, state.runId);
    assert.equal(afterFirst.steps[4].dispatch.activeTaskId, null, 'Accepting a task clears the dispatch');

    const nextCode = sdwOrch.cmdTaskNext({ root, runId: state.runId });
    assert.equal(nextCode, 0, 'The next ready task dispatches once the previous one is accepted');

    const afterSecond = stateManager.loadRunState(root, state.runId);
    assert.equal(afterSecond.steps[4].dispatch.sequence, 2, 'The dispatch sequence increments');

    const nextTask = afterSecond.steps[4].dispatch.activeTaskId;
    const secondEvidence = submitEvidence(root, nextTask);
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId: nextTask, evidencePath: secondEvidence.evidencePath }), 0);

    // Every task is accepted: dispatching again reports exhaustion, not an error.
    const exhausted = sdwOrch.cmdTaskNext({ root, runId: state.runId });
    assert.equal(exhausted, 0, 'Exhaustion is not an error');
    const finished = stateManager.loadRunState(root, state.runId);
    assert.equal(finished.steps[4].status, 'completed', 'Accepting the final task completes Step 4');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: each accepted task is saved by one scoped commit plus one checkpoint tag, and the tag recovers lost content', () => {
  const root = setupRepo();
  try {
    assert.equal(pauseAtDispatch(root), 4);
    const state = stateManager.findLatestRunState(root);
    const baseline = gitOut(root, 'rev-parse HEAD');
    const firstTask = state.steps[4].dispatch.activeTaskId;

    const firstEvidence = submitEvidence(root, firstTask);
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId: firstTask, evidencePath: firstEvidence.evidencePath }), 0);

    const afterFirst = stateManager.loadRunState(root, state.runId);
    const firstCommit = afterFirst.steps[4].tasks[firstTask].commitSha;
    const firstTag = `sdw-checkpoint-${state.runId}-${firstTask}`;
    assert.equal(gitOut(root, `rev-parse ${firstTag}`), firstCommit, 'the checkpoint tag points at the accepted commit');
    assert.equal(gitOut(root, 'log -1 --format=%s'), `task(dispatch-demo): ${firstTask}`, 'the checkpoint commit uses the task message');
    assert.match(gitOut(root, `show ${firstTag}:app.cjs`), new RegExp(`// ${firstTask} work`), 'the tag holds the accepted file content');

    // Kill between tasks: a later process resumes from disk state and dispenses the next task.
    assert.equal(sdwOrch.cmdResume({ root, runId: state.runId, skipReview: true, skipPr: true }), 4, 'resume re-enters Step 4 between tasks');
    assert.equal(sdwOrch.cmdTaskNext({ root, runId: state.runId }), 0, 'the next task dispatches after the checkpoint');
    const secondTask = stateManager.loadRunState(root, state.runId).steps[4].dispatch.activeTaskId;

    // A reset loses the working tree content; the checkpoint tag restores it.
    execSync(`git reset --hard ${baseline}`, { cwd: root, stdio: 'ignore' });
    assert.ok(!fs.readFileSync(path.join(root, 'app.cjs'), 'utf8').includes(`// ${firstTask} work`), 'the reset lost the file content');
    execSync(`git reset --hard ${firstTag}`, { cwd: root, stdio: 'ignore' });
    assert.match(fs.readFileSync(path.join(root, 'app.cjs'), 'utf8'), new RegExp(`// ${firstTask} work`), 'the tag recovers the file content');

    const secondEvidence = submitEvidence(root, secondTask);
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId: secondTask, evidencePath: secondEvidence.evidencePath }), 0);

    const afterSecond = stateManager.loadRunState(root, state.runId);
    assert.equal(gitOut(root, `rev-parse sdw-checkpoint-${state.runId}-${secondTask}`), afterSecond.steps[4].tasks[secondTask].commitSha);
    assert.equal(gitOut(root, `rev-list --count ${baseline}..HEAD`), '2', 'one commit per accepted task');
    assert.deepEqual(
      gitOut(root, `log --format=%s ${baseline}..HEAD`).split(/\r?\n/).sort(),
      [`task(dispatch-demo): ${firstTask}`, `task(dispatch-demo): ${secondTask}`].sort()
    );

    // Final delivery state stays authoritative: Step 6 records the accepted history.
    assert.equal(sdwOrch.cmdResume({ root, runId: state.runId, skipReview: true, skipPr: true }), 0, 'the run completes after the last checkpoint');
    const completed = stateManager.loadRunState(root, state.runId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.steps[6].status, 'completed', 'Step 6 remains the delivery state');
    assert.equal(completed.deliveryCommit, afterSecond.steps[4].tasks[secondTask].commitSha, 'the delivery state points at the accepted commit when no scoped files remain');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: --no-task-checkpoint leaves the accepted task uncommitted and untagged', () => {
  const root = setupRepo();
  try {
    assert.equal(pauseAtDispatch(root), 4);
    const state = stateManager.findLatestRunState(root);
    const taskId = state.steps[4].dispatch.activeTaskId;
    const head = gitOut(root, 'rev-parse HEAD');

    const { evidencePath } = submitEvidence(root, taskId);
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath, noTaskCheckpoint: true }), 0);

    const after = stateManager.loadRunState(root, state.runId);
    assert.equal(after.steps[4].tasks[taskId].commitSha, head, 'no checkpoint commit is created');
    assert.equal(gitOut(root, 'rev-parse HEAD'), head);
    assert.equal(gitOut(root, 'tag --list'), '', 'no checkpoint tag is created');
    assert.ok(fs.readFileSync(path.join(root, 'app.cjs'), 'utf8').includes(`// ${taskId} work`), 'the work stays in the working tree for Step 6');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC9-AC10: task finish rejects a non-dispatched task and names the active one', () => {
  const root = setupRepo();
  try {
    assert.equal(pauseAtDispatch(root), 4);
    const state = stateManager.findLatestRunState(root);
    const activeTask = state.steps[4].dispatch.activeTaskId;
    const otherTask = state.dagTasks.map(task => task.id).find(id => id !== activeTask);

    const { evidencePath } = submitEvidence(root, otherTask);
    const code = sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId: otherTask, evidencePath });
    assert.equal(code, 1, 'Out-of-order completion is rejected');

    const unchanged = stateManager.loadRunState(root, state.runId);
    assert.equal(unchanged.steps[4].dispatch.activeTaskId, activeTask, 'The active dispatch is untouched');
    assert.notEqual((unchanged.steps[4].tasks[otherTask] || {}).status, 'completed', 'The rejected task stays incomplete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC11-AC13, AC24: task abandon returns the task to pending and the re-dispatch carries partial progress', () => {
  const root = setupRepo();
  try {
    assert.equal(pauseAtDispatch(root), 4);
    const state = stateManager.findLatestRunState(root);
    const taskId = state.steps[4].dispatch.activeTaskId;

    // Abandoning with no reason is rejected.
    assert.equal(sdwOrch.cmdTaskAbandon({ root, runId: state.runId, taskId }), 1, 'A reason is required');

    // Abandoning a task that is not dispatched is rejected.
    const otherTask = state.dagTasks.map(task => task.id).find(id => id !== taskId);
    assert.equal(sdwOrch.cmdTaskAbandon({ root, runId: state.runId, taskId: otherTask, reason: 'nope' }), 1);

    // Leave partial work in the tree, then abandon properly.
    fs.appendFileSync(path.join(root, 'app.cjs'), '// partial work\n');
    assert.equal(sdwOrch.cmdTaskAbandon({ root, runId: state.runId, taskId, reason: 'worker context lost' }), 0);

    const abandoned = stateManager.loadRunState(root, state.runId);
    assert.equal(abandoned.steps[4].tasks[taskId].status, 'pending', 'The task returns to the queue');
    assert.equal(abandoned.steps[4].dispatch.activeTaskId, null, 'The dispatch is cleared');
    assert.equal(abandoned.steps[4].dispatch.abandonments.length, 1);
    assert.equal(abandoned.steps[4].dispatch.abandonments[0].reason, 'worker context lost');

    // Re-dispatch carries the partial progress context.
    assert.equal(sdwOrch.cmdTaskNext({ root, runId: state.runId }), 0);
    const redispatched = stateManager.loadRunState(root, state.runId);
    assert.equal(redispatched.steps[4].dispatch.sequence, 2, 'The sequence increments on re-dispatch');
    const promptPath = path.resolve(root, redispatched.steps[4].tasks[taskId].promptPath);
    const prompt = fs.readFileSync(promptPath, 'utf8');
    assert.ok(prompt.includes('## Prior Partial Progress'), 'The re-dispatch prompt carries prior progress (AC24)');
    assert.ok(prompt.includes('worker context lost'), 'The abandonment reason is surfaced');
    assert.ok(prompt.includes('app.cjs'), 'Modified paths are listed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC25-AC26: evidence status is required and only success is accepted', () => {
  const root = setupRepo();
  try {
    assert.equal(pauseAtDispatch(root), 4);
    const state = stateManager.findLatestRunState(root);
    const taskId = state.steps[4].dispatch.activeTaskId;

    // Missing status is rejected by the evidence validator.
    fs.appendFileSync(path.join(root, 'app.cjs'), '// work\n');
    const noStatus = path.join(root, 'no-status.json');
    fs.writeFileSync(noStatus, JSON.stringify({
      taskId,
      acIds: [state.dagTasks[0].coveredAcs[0]],
      filesChanged: ['app.cjs'],
      tests: [],
      summary: 'no status field'
    }), 'utf8');
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath: noStatus }), 1, 'Missing status is rejected (AC25)');

    // A non-success status is rejected and quoted.
    const { evidencePath } = submitEvidence(root, taskId, { status: 'partial' });
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath }), 1, 'Only success is accepted (AC26)');

    const stillDispatched = stateManager.loadRunState(root, state.runId);
    assert.equal(stillDispatched.steps[4].dispatch.activeTaskId, taskId, 'The task stays in flight');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC27: evidence claiming only pre-dispatch edits is rejected', () => {
  const root = setupRepo();
  try {
    // Dirty the tree BEFORE the dispatch: those edits must never corroborate a task.
    fs.appendFileSync(path.join(root, 'app.cjs'), '// pre-existing dirt\n');
    assert.equal(pauseAtDispatch(root), 4);

    const state = stateManager.findLatestRunState(root);
    const taskId = state.steps[4].dispatch.activeTaskId;
    const evidencePath = path.join(root, 'stale.json');
    fs.writeFileSync(evidencePath, JSON.stringify({
      taskId,
      status: 'success',
      acIds: [state.dagTasks[0].coveredAcs[0]],
      filesChanged: ['app.cjs'],
      tests: [],
      summary: 'claims inherited edits'
    }), 'utf8');

    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath }), 1, 'Stale edits never corroborate a task (AC27)');

    // Touching the file after dispatch makes it acceptable.
    const fresh = submitEvidence(root, taskId);
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath: fresh.evidencePath }), 0, 'Post-dispatch edits corroborate (AC27)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC28: a non-git workspace corroborates changes by existence only', () => {
  const root = setupRepo({ git: false });
  try {
    assert.equal(pauseAtDispatch(root), 4);
    const state = stateManager.findLatestRunState(root);
    const taskId = state.steps[4].dispatch.activeTaskId;

    const evidencePath = path.join(root, 'non-git.json');
    fs.appendFileSync(path.join(root, 'app.cjs'), '// work\n');
    fs.writeFileSync(evidencePath, JSON.stringify({
      taskId,
      status: 'success',
      acIds: [state.dagTasks[0].coveredAcs[0]],
      filesChanged: ['app.cjs'],
      tests: [],
      summary: 'non-git workspace'
    }), 'utf8');

    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath }), 0, 'Existence is enough without git (AC28)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC31-AC32, AC37: resume re-emits the in-flight envelope, otherwise points at task next', () => {
  const root = setupRepo();
  try {
    assert.equal(pauseAtDispatch(root), 4);
    const state = stateManager.findLatestRunState(root);
    const taskId = state.steps[4].dispatch.activeTaskId;

    // AC31: resume with an active dispatch re-emits the envelope and pauses again.
    assert.equal(sdwOrch.cmdResume({ root, runId: state.runId, skipReview: true, skipPr: true }), 4, 'Resume pauses while a task is in flight');
    const afterResume = stateManager.loadRunState(root, state.runId);
    assert.equal(afterResume.steps[4].dispatch.activeTaskId, taskId, 'The in-flight task is unchanged');

    // AC32: after abandoning, resume refuses the gates and points at task next.
    assert.equal(sdwOrch.cmdTaskAbandon({ root, runId: state.runId, taskId, reason: 'test' }), 0);
    assert.equal(sdwOrch.cmdResume({ root, runId: state.runId, skipReview: true, skipPr: true }), 4, 'Resume refuses to advance with incomplete tasks');
    const notAdvanced = stateManager.loadRunState(root, state.runId);
    assert.equal(notAdvanced.steps[4].status, 'awaiting_implementation', 'Step 4 stays incomplete');
    assert.equal(notAdvanced.steps[4].gates.build, undefined, 'No build gate ran');

    // AC37: status exposes the dispatch state.
    assert.equal(sdwOrch.cmdStatus({ root, runId: state.runId }), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC1-AC3, AC40: handoff is removed and rejected with remediation', () => {
  const removed = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', implementation: { mode: 'handoff' } });
  assert.equal(removed.valid, false, 'handoff is no longer a valid mode (AC1, AC40)');
  assert.ok(removed.errors.some(e => e.includes('subagent')), 'The error names the replacement mode (AC3)');

  const defaults = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs' });
  assert.equal(defaults.valid, true);
  assert.equal(sdwConfig.DEFAULT_CONFIG.implementation.mode, 'subagent', 'subagent is the default (AC2)');

  const schemaMode = sdwConfig.DEFAULT_SCHEMA.properties.implementation.properties.mode;
  assert.deepEqual(schemaMode.enum, ['subagent', 'command'], 'The schema enum drops handoff (AC40)');
  assert.equal(schemaMode.default, 'subagent');
});

test('AC38: command mode creates no dispatch state', () => {
  const root = setupRepo({ git: true });
  try {
    const script = [
      "const fs = require('fs');",
      "fs.appendFileSync('app.cjs', '// command mode\\n');",
      'fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({',
      "  taskId: process.env.SDW_TASK_ID, status: 'success',",
      "  acIds: ['AC1','AC2','AC3','AC4','AC5','AC6'], filesChanged: ['app.cjs'], tests: [], summary: 'command mode'",
      '}));'
    ].join(' ');
    const code = sdwOrch.cmdRun({
      root,
      specPath: '.sdw/specs/dispatch-demo.md',
      skipReview: true,
      skipPr: true,
      implementation: { mode: 'command', command: `node -e "${script.replace(/"/g, '\\"')}"` }
    });
    assert.equal(code, 0, 'Command mode runs unattended');

    const state = stateManager.findLatestRunState(root);
    assert.equal(state.steps[4].status, 'completed');
    assert.equal(state.steps[4].dispatch.activeTaskId, null, 'Command mode never dispatches (AC38)');
    assert.equal(state.steps[4].dispatch.sequence, 0, 'No dispatch sequence is consumed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
