'use strict';

// Second pass (--second-pass / --refine): refine an already delivered spec,
// report in both outcomes, commit only on a real change, ship only for a commit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const { installJudgeEnv } = require('./fixtures/judge_env.cjs');

installJudgeEnv();

const SPEC = `---
slug: refine-demo
---
# Refine Demo
## Description
A specification that has already been delivered.
## Acceptance Criteria
- AC1: The system shall read the input.
- AC2: The system shall report the result.
`;

const CONFIG = {
  scmProvider: 'none',
  useFeatureBranches: false,
  useWorktrees: false,
  runAllTests: false,
  requiredBuild: false,
  securityChecksEnabled: false,
  pushDelivery: false,
  reputation: undefined
};

function writeRegistry(root, status) {
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const rows = [
    '# Specification Index',
    '',
    '| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |',
    '|---|---|---|---|---|---|---|---|',
    `| 00040 | refine-demo | Refine Demo | ${status} | local | 2026-10-21 | PASS | - |`,
    ''
  ];
  fs.writeFileSync(path.join(specsDir, 'index.specs.md'), rows.join('\n'), 'utf8');
}

function setupRepo(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-refine-'));
  const sdwDir = path.join(root, '.sdw');
  fs.mkdirSync(path.join(sdwDir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(sdwDir, 'specs', 'refine-demo.md'), SPEC, 'utf8');
  fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify(CONFIG, null, 2) + '\n', 'utf8');
  writeRegistry(root, options.registryStatus || 'completed');
  execSync('git init -q', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'app.cjs'), '// delivered implementation\n');
  execSync('git add .sdw app.cjs', { cwd: root, stdio: 'ignore' });
  execSync('git commit -qm "feat(refine-demo): implement refine-demo"', { cwd: root, stdio: 'ignore' });
  return root;
}

function startSecondPass(root) {
  return sdwOrch.cmdRun({
    root,
    specPath: '.sdw/specs/refine-demo.md',
    refineMode: true,
    skipReview: true
  });
}

function finishRefineTask(root, filesChanged, summary) {
  const state = stateManager.findLatestRunState(root);
  const taskId = state.steps[4].dispatch.activeTaskId;
  const task = state.steps[4].tasks[taskId];
  const evidence = {
    taskId,
    status: 'success',
    acIds: task.coveredAcs.slice(0, 1),
    filesChanged,
    tests: [],
    summary
  };
  const evidencePath = path.join(root, `${taskId}.evidence.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  const code = sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath });
  return { code, state, taskId };
}

function headSubject(root) {
  return execSync('git log -1 --format=%s', { cwd: root, encoding: 'utf8' }).trim();
}

function headSha(root) {
  return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
}

test('refine: refuses a specification that was never implemented', () => {
  const root = setupRepo({ registryStatus: 'pending' });
  try {
    const code = sdwOrch.cmdRun({
      root,
      specPath: '.sdw/specs/refine-demo.md',
      refineMode: true,
      skipReview: true
    });
    assert.equal(code, 1, 'an unimplemented spec cannot be refined');
    assert.equal(fs.existsSync(path.join(root, '.sdw', 'state')), false, 'no run state is written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refine: skipped grilling, one refine task, and a no-change pass ships nothing', () => {
  const root = setupRepo();
  try {
    assert.equal(startSecondPass(root), 4, 'Step 4 pauses for the refinement task');

    let state = stateManager.findLatestRunState(root);
    assert.equal(state.refineMode, true, 'the mode is persisted for resume');
    assert.equal(state.steps[2].status, 'skipped', 'decision-gap grilling is skipped');
    assert.equal(state.steps[3].status, 'completed');
    assert.deepEqual(state.dagTasks.map(task => task.id), ['task-refine']);
    assert.equal(state.steps[4].dispatch.activeTaskId, 'task-refine');

    const before = headSha(root);
    const { code } = finishRefineTask(root, [], 'No change: considered the duplicated guard and skipped it; behaviour already minimal.');
    assert.equal(code, 0, 'task finish accepts an empty filesChanged in second-pass mode');

    const resumeCode = sdwOrch.cmdResume({ root, runId: state.runId, skipReview: true });
    assert.equal(resumeCode, 0, 'a no-change refinement completes successfully');

    state = stateManager.loadRunState(root, state.runId);
    assert.equal(state.status, 'completed');
    assert.equal(state.deliveryCommitCreated, false, 'no delivery commit is recorded');
    assert.equal(state.steps[5].status, 'skipped', 'scoring is skipped when nothing changed');
    assert.equal(state.steps[8].status, 'skipped', 'shipping is skipped when nothing changed');
    assert.equal(headSha(root), before, 'the repository gained no commit');

    const report = path.join(root, state.refineReport);
    assert.ok(fs.existsSync(report), 'the refinement report exists');
    const markdown = fs.readFileSync(report, 'utf8');
    assert.match(markdown, /Outcome:\*\* no change/);
    assert.match(markdown, /considered the duplicated guard/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refine: a real change is scored, committed as refine(...), and shipped', () => {
  const root = setupRepo();
  try {
    assert.equal(startSecondPass(root), 4);
    const state = stateManager.findLatestRunState(root);

    fs.appendFileSync(path.join(root, 'app.cjs'), '\n// simplified guard\n');
    const { code } = finishRefineTask(root, ['app.cjs'], 'Applied simplification: collapsed two guards into one; skipped renaming the helper.');
    assert.equal(code, 0, 'a changed refinement is accepted');

    const resumeCode = sdwOrch.cmdResume({ root, runId: state.runId, skipReview: true });
    assert.equal(resumeCode, 0, 'the changed refinement completes');

    const after = stateManager.loadRunState(root, state.runId);
    assert.equal(after.deliveryCommitCreated, true, 'a commit was created');
    assert.equal(headSubject(root), 'refine(refine-demo): second pass refinement');
    assert.equal(after.steps[6].status, 'completed');
    assert.notEqual(after.steps[8].status, 'failed', 'Step 8 runs because a commit exists');

    const report = fs.readFileSync(path.join(root, after.refineReport), 'utf8');
    assert.match(report, /Outcome:\*\* changed/);
    assert.match(report, /app\.cjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refine: resume keeps second-pass mode after the dispatch pause', () => {
  const root = setupRepo();
  try {
    assert.equal(startSecondPass(root), 4);
    const state = stateManager.findLatestRunState(root);

    const resumeCode = sdwOrch.cmdResume({ root, runId: state.runId, skipReview: true });
    assert.equal(resumeCode, 4, 'an in-flight refinement re-emits the dispatch pause');
    const reloaded = stateManager.loadRunState(root, state.runId);
    assert.equal(reloaded.refineMode, true, 'resume never downgrades the run to a normal implementation');
    assert.equal(reloaded.steps[4].dispatch.activeTaskId, 'task-refine');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
