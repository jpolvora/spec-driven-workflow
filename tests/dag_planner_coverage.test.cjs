'use strict';

// Spec 00064 AC1-AC4: every assigned acceptance criterion must prove a
// supporting file in its task slice or record an explicit no-file reason. An
// uncovered criterion fails the plan with a non-zero exit that names the
// criterion and the task. The coverage report reaches the Step 3 output and
// `dag preview --json`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const dagPlanner = require('../skills/sdw-orch/scripts/dag_planner.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

const TARGET_FILES = [
  'skills/demo/a.cjs',
  'skills/demo/b.cjs',
  'skills/demo/c.cjs',
  'skills/demo/d.cjs',
  'skills/demo/e.cjs',
  'skills/demo/f.cjs'
];

// Eleven criteria keep the plan complex, so the blueprint files slice into
// three tasks and a criterion can land on a slice that cannot prove it.
function buildCriteria(overrides = {}) {
  return Array.from({ length: 11 }, (_, index) => {
    const id = `AC${index + 1}`;
    return `- ${id}: ${overrides[id] || `The system shall satisfy criterion ${index + 1}.`}`;
  });
}

function buildSpec(slug, criteria) {
  return [
    '---',
    `slug: ${slug}`,
    `title: "${slug}"`,
    '---',
    '# Specification',
    '## Description',
    'Exercises acceptance-criterion file coverage in the DAG planner.',
    '## Acceptance Criteria',
    ...criteria,
    '## Implementation Surfaces',
    ...TARGET_FILES.map(file => `- \`${file}\``),
    '## Definition of Ready (DoR)',
    '| Readiness Item | Requirement | Verification Method |',
    '|---|---|---|',
    '| Specification | Agent-ready | Inspection |'
  ].join('\n');
}

function makeRepo(slug, criteria, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-coverage-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, `${slug}.md`), buildSpec(slug, criteria), 'utf8');
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

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
}

// AC1: criteria that name a blueprint path are covered by the task that owns
// the matching slice file.
const FULL_CRITERIA = buildCriteria({
  AC1: 'The system shall handle skills/demo/a.cjs for criterion 1.',
  AC5: 'The system shall handle skills/demo/c.cjs for criterion 5.',
  AC9: 'The system shall handle skills/demo/e.cjs for criterion 9.'
});

// AC2: AC1 names a file that lands on task-3's slice, so task-1 cannot prove it.
const MISSING_CRITERIA = buildCriteria({
  AC1: 'The system shall handle skills/demo/f.cjs for criterion 1.'
});

// AC1's no-file branch: none of these criteria names a path.
const NO_PATH_CRITERIA = buildCriteria();

test('AC1 & AC3: full coverage maps each criterion to its task and supporting slice file', () => {
  const plan = dagPlanner.generateDagPlan(buildSpec('coverage-full', FULL_CRITERIA), {
    slug: 'coverage-full',
    targetFiles: TARGET_FILES
  });

  assert.ok(!plan.refused, 'a criterion whose file is in its slice plans');
  assert.equal(plan.coverage.complete, true, 'the coverage report is complete');
  assert.equal(plan.coverage.criteria.length, 11, 'every criterion has one coverage entry');

  const byAc = new Map(plan.coverage.criteria.map(entry => [entry.acId, entry]));
  for (const task of plan.tasks) {
    for (const acId of task.coveredAcs) {
      const entry = byAc.get(acId);
      assert.equal(entry.taskId, task.id, `${acId} maps to its owning task`);
      for (const file of entry.files) {
        assert.ok(task.targetFiles.includes(file), `${acId} names a file from its task slice`);
      }
    }
  }
  assert.deepEqual(byAc.get('AC1').files, ['skills/demo/a.cjs']);
  assert.deepEqual(byAc.get('AC5').files, ['skills/demo/c.cjs']);
  assert.deepEqual(byAc.get('AC9').files, ['skills/demo/e.cjs']);
  assert.equal(byAc.get('AC1').noFileReason, null, 'a covered criterion records no reason');
});

test('AC1: a criterion that names no path records an explicit no-file reason instead of failing', () => {
  const plan = dagPlanner.generateDagPlan(buildSpec('coverage-reason', NO_PATH_CRITERIA), {
    slug: 'coverage-reason',
    targetFiles: []
  });

  assert.ok(!plan.refused, 'criteria that name no path never fail the plan');
  assert.equal(plan.coverage.complete, true);
  for (const entry of plan.coverage.criteria) {
    assert.deepEqual(entry.files, [], 'a no-path criterion claims no supporting file');
    assert.match(entry.noFileReason, /names no path/, 'the entry records why it needs no file');
  }
});

test('AC3: the coverage report reaches the Step 3 output and dag preview --json', () => {
  const root = makeRepo('coverage-step3', FULL_CRITERIA, { git: true });
  try {
    const preview = runCli(root, ['dag', 'preview', '--json', '--spec', '.sdw/specs/coverage-step3.md']);
    assert.equal(preview.status, 0, preview.stderr);
    const previewPlan = JSON.parse(preview.stdout);
    assert.equal(previewPlan.coverage.complete, true);
    const previewAc1 = previewPlan.coverage.criteria.find(entry => entry.acId === 'AC1');
    assert.equal(previewAc1.taskId, 'task-1');
    assert.deepEqual(previewAc1.files, ['skills/demo/a.cjs']);
    assert.match(previewPlan.coverage.criteria.find(entry => entry.acId === 'AC2').noFileReason, /names no path/);

    const runCode = sdwOrch.cmdRun({
      root,
      specPath: '.sdw/specs/coverage-step3.md',
      skipReview: true,
      skipPr: true
    });
    assert.equal(runCode, 4, 'a covered plan dispatches the first task');

    const state = stateManager.findLatestRunState(root);
    assert.equal(state.steps[3].status, 'completed');
    assert.equal(state.steps[3].output.coverage.complete, true, 'Step 3 output carries the coverage report');
    assert.equal(state.steps[3].output.coverage.criteria.length, 11);
    const step3Ac1 = state.steps[3].output.coverage.criteria.find(entry => entry.acId === 'AC1');
    assert.equal(step3Ac1.taskId, 'task-1');
    assert.deepEqual(step3Ac1.files, ['skills/demo/a.cjs']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2 & AC4: an uncovered criterion fails the plan and names the criterion and the task', () => {
  const plan = dagPlanner.generateDagPlan(buildSpec('coverage-missing', MISSING_CRITERIA), {
    slug: 'coverage-missing',
    targetFiles: TARGET_FILES
  });

  assert.equal(plan.refused, true, 'a path-naming criterion absent from its slice refuses the plan');
  assert.equal(plan.reason, 'criteria-uncovered');
  assert.equal(plan.taskCount, 0);
  assert.deepEqual(plan.tasks, [], 'a refused plan carries no tasks');
  assert.equal(plan.coverage.complete, false);
  assert.deepEqual(plan.uncovered.map(entry => [entry.acId, entry.taskId]), [['AC1', 'task-1']]);
  assert.deepEqual(plan.uncovered[0].requiredFiles, ['skills/demo/f.cjs']);
  assert.deepEqual(plan.uncovered[0].taskFiles, ['skills/demo/a.cjs', 'skills/demo/b.cjs']);

  const root = makeRepo('coverage-missing', MISSING_CRITERIA);
  try {
    const preview = runCli(root, ['dag', 'preview', '--json', '--spec', '.sdw/specs/coverage-missing.md']);
    assert.equal(preview.status, 1, 'the refusal exit code is non-zero');
    assert.match(preview.stderr, /criteria-uncovered/);
    assert.match(preview.stderr, /AC1/);
    assert.match(preview.stderr, /task-1/);
    const previewPlan = JSON.parse(preview.stdout);
    assert.equal(previewPlan.refused, true);
    assert.equal(previewPlan.reason, 'criteria-uncovered');
    assert.deepEqual(previewPlan.uncovered.map(entry => [entry.acId, entry.taskId]), [['AC1', 'task-1']]);

    const runCode = sdwOrch.cmdRun({
      root,
      specPath: '.sdw/specs/coverage-missing.md',
      skipReview: true,
      skipPr: true
    });
    assert.equal(runCode, 1, 'the run refuses with a non-zero exit');
    const state = stateManager.findLatestRunState(root);
    assert.equal(state.steps[3].status, 'failed');
    assert.match(String(state.steps[3].error || ''), /criteria-uncovered/);
    assert.match(String(state.steps[3].error || ''), /AC1/);
    assert.match(String(state.steps[3].error || ''), /task-1/);
    assert.equal(state.steps[3].output.reason, 'criteria-uncovered');
    assert.deepEqual(state.dagTasks || [], [], 'no DAG task is planned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
