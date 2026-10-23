'use strict';

// Spec 00063 AC1-AC4: the per-task checkpoint commit must land on the run feature
// branch. A matching branch commits, a mismatched branch and a detached HEAD are
// refused without writing a commit, and the refusal is recorded on the task.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

require('./fixtures/judge_env.cjs').installJudgeEnv();

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

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-branch-guard-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, 'dispatch-demo.md'), COMPLEX_SPEC);
  execSync('git init -q', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'app.cjs'), '// baseline\n');
  execSync('git add .sdw app.cjs', { cwd: root, stdio: 'ignore' });
  execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });
  return root;
}

// A run that records a feature branch, paused with one task dispatched and the
// checkout already switched onto that run feature branch.
function setupFeatureBranchRun() {
  const root = setupRepo();
  fs.writeFileSync(
    path.join(root, '.sdw', 'config.json'),
    JSON.stringify({ useFeatureBranches: true }, null, 2),
    'utf8'
  );
  assert.equal(sdwOrch.cmdRun({
    root,
    specPath: '.sdw/specs/dispatch-demo.md',
    skipReview: true,
    skipPr: true
  }), 4, 'Step 4 dispatches one task and pauses');
  const state = stateManager.findLatestRunState(root);
  return {
    root,
    state,
    taskId: state.steps[4].dispatch.activeTaskId,
    featureBranch: state.branching && state.branching.featureBranch
  };
}

function gitOut(root, args) {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim();
}

// Touches a declared file and writes success evidence for the task.
function submitEvidence(root, taskId) {
  const state = stateManager.findLatestRunState(root);
  fs.appendFileSync(path.join(root, 'app.cjs'), `// ${taskId} work\n`);
  const evidence = {
    taskId,
    status: 'success',
    acIds: [state.dagTasks.find(task => task.id === taskId).coveredAcs[0]],
    filesChanged: ['app.cjs'],
    tests: [],
    summary: `${taskId} implemented`
  };
  const evidencePath = path.join(root, `${taskId}.evidence.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  return evidencePath;
}

// Runs task finish while capturing its stderr lines (the refusal contract is printed).
function finishCapturingErrors(options) {
  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  try {
    return { code: sdwOrch.cmdTaskFinish(options), output: messages.join('\n') };
  } finally {
    console.error = originalError;
  }
}

test('00063 AC1 & AC4: task finish checkpoints on the run feature branch', () => {
  const { root, state, taskId, featureBranch } = setupFeatureBranchRun();
  try {
    assert.equal(featureBranch, `feature/${state.specSlug}`, 'the run records its feature branch');
    assert.equal(gitOut(root, 'rev-parse --abbrev-ref HEAD'), featureBranch,
      'the checkout is on the run feature branch');

    const evidencePath = submitEvidence(root, taskId);
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath }), 0,
      'a matching branch accepts the task and commits the checkpoint');

    const record = stateManager.loadRunState(root, state.runId).steps[4].tasks[taskId];
    assert.equal(record.status, 'completed');
    assert.equal(record.branchGuard, undefined, 'an accepted task records no branch refusal');
    assert.equal(gitOut(root, 'log -1 --format=%s'), `task(${state.specSlug}): ${taskId}`,
      'the checkpoint commit landed on the run feature branch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00063 AC1-AC3 & AC4: task finish refuses a checkpoint on another branch and names the remedy', () => {
  const { root, state, taskId, featureBranch } = setupFeatureBranchRun();
  try {
    execSync('git switch -q -c other-lane', { cwd: root, stdio: 'ignore' });
    const head = gitOut(root, 'rev-parse HEAD');
    const evidencePath = submitEvidence(root, taskId);

    const { code, output } = finishCapturingErrors({ root, runId: state.runId, taskId, evidencePath });

    assert.equal(code, 1, 'a mismatched branch exits non-zero');
    assert.ok(output.includes('other-lane'), 'the refusal names the checked-out branch');
    assert.ok(output.includes(featureBranch), 'the refusal names the run feature branch');
    assert.match(output, /git switch /, 'the refusal names the resume remedy');

    assert.equal(gitOut(root, 'rev-parse HEAD'), head, 'no commit is created');
    assert.equal(gitOut(root, 'tag --list'), '', 'no checkpoint tag is created');

    const refused = stateManager.loadRunState(root, state.runId);
    assert.equal(refused.steps[4].dispatch.activeTaskId, taskId, 'the task stays dispatched');
    const record = refused.steps[4].tasks[taskId];
    assert.notEqual(record.status, 'completed', 'the task is not accepted');
    assert.equal(record.branchGuard.observedBranch, 'other-lane', 'the observed branch is recorded');
    assert.equal(record.branchGuard.expectedBranch, featureBranch, 'the expected branch is recorded');
    assert.ok(record.branchGuard.reason.includes('other-lane') && record.branchGuard.reason.includes(featureBranch),
      'the refusal reason names both branches');
    assert.ok(record.branchGuard.refusedAt, 'the refusal is timestamped');

    // The remedy: back on the run branch the same submission is accepted.
    execSync(`git switch -q ${featureBranch}`, { cwd: root, stdio: 'ignore' });
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath }), 0,
      'retrying on the run feature branch accepts the task');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00063 AC2-AC4: task finish refuses a checkpoint on a detached HEAD', () => {
  const { root, state, taskId, featureBranch } = setupFeatureBranchRun();
  try {
    execSync('git checkout -q --detach HEAD', { cwd: root, stdio: 'ignore' });
    const head = gitOut(root, 'rev-parse HEAD');
    const evidencePath = submitEvidence(root, taskId);

    const { code, output } = finishCapturingErrors({ root, runId: state.runId, taskId, evidencePath });

    assert.equal(code, 1, 'a detached HEAD exits non-zero');
    assert.ok(output.includes('detached'), 'the refusal names the detached HEAD');
    assert.ok(output.includes(featureBranch), 'the refusal names the run feature branch');
    assert.equal(gitOut(root, 'rev-parse HEAD'), head, 'no commit is created');
    assert.equal(gitOut(root, 'tag --list'), '', 'no checkpoint tag is created');

    const refused = stateManager.loadRunState(root, state.runId);
    assert.equal(refused.steps[4].dispatch.activeTaskId, taskId, 'the task stays dispatched');
    const record = refused.steps[4].tasks[taskId];
    assert.notEqual(record.status, 'completed', 'the task is not accepted');
    assert.equal(record.branchGuard.observedBranch, null, 'a detached HEAD has no observed branch');
    assert.equal(record.branchGuard.detached, true, 'the detached state is recorded');
    assert.equal(record.branchGuard.expectedBranch, featureBranch, 'the expected branch is recorded');
    assert.ok(record.branchGuard.reason.includes(featureBranch), 'the refusal reason names the run branch');

    execSync(`git switch -q ${featureBranch}`, { cwd: root, stdio: 'ignore' });
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath }), 0,
      'the task is accepted once the run branch is checked out');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
