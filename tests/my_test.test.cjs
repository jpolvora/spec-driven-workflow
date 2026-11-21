'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const dagPlanner = require('../skills/sdw-run/scripts/dag_planner.cjs');
const implementationRunner = require('../skills/sdw-run/scripts/implementation_runner.cjs');
const evidenceValidator = require('../skills/sdw-run/scripts/evidence_validator.cjs');
const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');
const stateManager = require('../skills/sdw-run/scripts/state_manager.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

function buildSpec(slug, criteria = []) {
  const acs = criteria.length > 0 ? criteria : [
    '- AC1: The system shall parse inputs.',
    '- AC2: The system shall validate inputs.'
  ];
  return [
    '---',
    `slug: ${slug}`,
    `title: "${slug}"`,
    'source: local',
    'status: draft',
    'specDate: 2026-11-20',
    '---',
    `# Specification ${slug}`,
    '## Description',
    'Test specification for segregation.',
    '## Acceptance Criteria',
    ...acs,
    ''
  ].join('\n');
}

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-seg-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });

  sdwConfig.cmdInit({ root: tmpDir, force: true });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-seg-project', version: '1.0.0' }, null, 2), 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

  return tmpDir;
}

test('AC1: implementation.segregateTests in .sdw/config.json defaults to true', () => {
  const repoConfigPath = path.join(REPO_ROOT, '.sdw', 'config.json');
  const repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, 'utf8'));
  assert.equal(repoConfig.implementation.segregateTests, true);

  const loaded = sdwConfig.loadConfig(REPO_ROOT);
  assert.equal(loaded.implementation.segregateTests, true);

  assert.equal(sdwConfig.DEFAULT_CONFIG.implementation.segregateTests, true);
});

test('AC2: When implementation.segregateTests is enabled, DAG planner decomposes requirement units into sequential pairs', () => {
  const specContent = buildSpec('00099-test-feature');
  const plan = dagPlanner.generateDagPlan(specContent, {
    slug: '00099-test-feature',
    segregateTests: true
  });

  assert.equal(plan.totalTasks, 2);
  assert.equal(plan.tasks[0].id, 'task-1-test');
  assert.equal(plan.tasks[0].role, 'test_author');
  assert.deepStrictEqual(plan.tasks[0].dependencies, []);

  assert.equal(plan.tasks[1].id, 'task-1-impl');
  assert.equal(plan.tasks[1].role, 'implementation');
  assert.deepStrictEqual(plan.tasks[1].dependencies, ['task-1-test']);
});

test('AC2 (complex DAG): Decomposes multiple requirement units into paired sequential chain', () => {
  const complexAcs = [
    '- AC1: The system shall parse cli commands.',
    '- AC2: The system shall manage state files.',
    '- AC3: The system shall interact with git.',
    '- AC4: The system shall prepare pr payload.',
    '- AC5: The system shall handle ui events.',
    '- AC6: The system shall dispatch subagents.'
  ];
  const specContent = buildSpec('00099-complex-feature', complexAcs);
  const plan = dagPlanner.generateDagPlan(specContent, {
    slug: '00099-complex-feature',
    segregateTests: true
  });

  assert.equal(plan.totalTasks, 4);
  assert.equal(plan.tasks[0].id, 'task-1-test');
  assert.equal(plan.tasks[0].role, 'test_author');
  assert.deepStrictEqual(plan.tasks[0].dependencies, []);

  assert.equal(plan.tasks[1].id, 'task-1-impl');
  assert.equal(plan.tasks[1].role, 'implementation');
  assert.deepStrictEqual(plan.tasks[1].dependencies, ['task-1-test']);

  assert.equal(plan.tasks[2].id, 'task-2-test');
  assert.equal(plan.tasks[2].role, 'test_author');
  assert.deepStrictEqual(plan.tasks[2].dependencies, ['task-1-impl']);

  assert.equal(plan.tasks[3].id, 'task-2-impl');
  assert.equal(plan.tasks[3].role, 'implementation');
  assert.deepStrictEqual(plan.tasks[3].dependencies, ['task-2-test']);
});

test('AC3 & AC4: Scope fences separate test files from production code files', () => {
  const specContent = buildSpec('00099-fencing-test');
  const targetFiles = [
    'skills/my_feature/scripts/my_feature.cjs',
    'tests/my_feature.test.cjs'
  ];

  const plan = dagPlanner.generateDagPlan(specContent, {
    slug: '00099-fencing-test',
    targetFiles,
    segregateTests: true
  });

  const testTask = plan.tasks.find(t => t.role === 'test_author');
  const implTask = plan.tasks.find(t => t.role === 'implementation');

  // AC3: test authoring tasks only contain test files
  assert.deepStrictEqual(testTask.targetFiles, ['tests/my_feature.test.cjs']);

  // AC4: implementation tasks only contain production code files, excluding test files
  assert.deepStrictEqual(implTask.targetFiles, ['skills/my_feature/scripts/my_feature.cjs']);
});

test('AC5: Dispatch prompt for test authoring tasks includes instructions to write failing tests without modifying production code', () => {
  const tmpDir = setupTestRepo();
  const testTask = {
    id: 'task-1-test',
    role: 'test_author',
    title: 'Author Tests for 00099-prompt-test',
    coveredAcs: ['AC1'],
    dependencies: [],
    targetFiles: ['tests/my_test.test.cjs']
  };

  const rendered = implementationRunner.renderTaskPrompt({
    targetRoot: tmpDir,
    specSlug: '00099-prompt-test',
    runId: 'run-test-prompt-1',
    task: testTask,
    specAcs: [{ id: 'AC1', text: 'Condition 1' }]
  });

  const promptContent = fs.readFileSync(rendered.promptFileAbs, 'utf8');

  // AC5 instructions
  assert.ok(promptContent.includes('Write failing tests strictly asserting assigned acceptance criteria without modifying production code'));
  assert.ok(promptContent.includes('Modifying production code files is strictly prohibited'));

  // AC3 fence in prompt
  assert.ok(promptContent.includes('Permitted:** only test files matching configured test file patterns'));
  assert.ok(promptContent.includes('Forbidden:** modifying production code files. All non-test files are strictly prohibited'));
});

test('AC6: Dispatch prompt for implementation tasks includes instructions to satisfy test suite and forbids test modifications', () => {
  const tmpDir = setupTestRepo();
  const implTask = {
    id: 'task-1-impl',
    role: 'implementation',
    title: 'Implement 00099-prompt-test',
    coveredAcs: ['AC1'],
    dependencies: ['task-1-test'],
    targetFiles: ['lib/my_lib.cjs']
  };

  const rendered = implementationRunner.renderTaskPrompt({
    targetRoot: tmpDir,
    specSlug: '00099-prompt-test',
    runId: 'run-test-prompt-2',
    task: implTask,
    specAcs: [{ id: 'AC1', text: 'Condition 1' }]
  });

  const promptContent = fs.readFileSync(rendered.promptFileAbs, 'utf8');

  // AC6 instructions
  assert.ok(promptContent.includes('Satisfy the existing test suite. Modifying test files is strictly prohibited'));
  assert.ok(promptContent.includes('Modifying test files is strictly prohibited. Test suite assertions must not be weakened or altered'));

  // AC4 fence in prompt
  assert.ok(promptContent.includes('All test files are explicitly excluded'));
  assert.ok(promptContent.includes('modifying test files matching configured test file patterns'));
});

test('AC7 & AC8: Implementation task submitting modified test file is rejected with actionable error and exit code 1', () => {
  const tmpDir = setupTestRepo();
  const testFileRel = 'tests/my_test.test.cjs';
  const prodFileRel = 'lib/widget.cjs';

  fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, testFileRel), '// test file\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, prodFileRel), '// prod file\n', 'utf8');

  // 1. Direct evidence validator check
  const evidenceWithTest = {
    taskId: 'task-1-impl',
    status: 'success',
    acIds: ['AC1'],
    filesChanged: [prodFileRel, testFileRel],
    summary: 'Modified prod and test files.'
  };

  const validation = evidenceValidator.validateEvidence(evidenceWithTest, {
    expectedTaskId: 'task-1-impl',
    specAcs: ['AC1'],
    projectRoot: tmpDir,
    taskRole: 'implementation'
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(e => e === `Rejecting task: implementation worker modified test file ${testFileRel}`));

  // 2. Full sdw-run task finish CLI check
  const specContent = buildSpec('00099-cli-rejection');
  const specPath = path.join(tmpDir, '.sdw', 'specs', '00099-cli-rejection.md');
  fs.writeFileSync(specPath, specContent, 'utf8');

  const runState = stateManager.createRunState({
    root: tmpDir,
    specPath: '.sdw/specs/00099-cli-rejection.md',
    slug: '00099-cli-rejection'
  });

  runState.dagTasks = [
    {
      id: 'task-1-impl',
      role: 'implementation',
      title: 'Task 1 Impl',
      coveredAcs: ['AC1'],
      dependencies: [],
      targetFiles: [prodFileRel]
    }
  ];
  runState.steps[4] = {
    status: 'in_progress',
    tasks: {
      'task-1-impl': {
        id: 'task-1-impl',
        role: 'implementation',
        status: 'dispatched'
      }
    },
    dispatch: {
      activeTaskId: 'task-1-impl',
      sequence: 1,
      baseline: { dirty: [], hashes: {} }
    }
  };
  stateManager.saveRunState(tmpDir, runState);

  const evidenceFilePath = path.join(tmpDir, '.sdw', 'state', '00099-cli-rejection', runState.runId, 'task-task-1-impl.evidence.json');
  fs.mkdirSync(path.dirname(evidenceFilePath), { recursive: true });
  fs.writeFileSync(evidenceFilePath, JSON.stringify(evidenceWithTest, null, 2), 'utf8');

  // Capture console.error output
  const originalError = console.error;
  let loggedErrors = [];
  console.error = (...args) => {
    loggedErrors.push(args.join(' '));
  };

  let exitCode = 0;
  try {
    exitCode = sdwRun.cmdTaskFinish({
      root: tmpDir,
      runId: runState.runId,
      taskId: 'task-1-impl',
      evidencePath: evidenceFilePath
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(exitCode, 1, 'task finish must exit with code 1 when implementation task modifies test files');
  assert.ok(
    loggedErrors.some(msg => msg.includes(`Rejecting task: implementation worker modified test file ${testFileRel}`)),
    `Expected rejection message in console.error. Got:\n${loggedErrors.join('\n')}`
  );
});
