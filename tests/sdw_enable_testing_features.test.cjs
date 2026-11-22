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
const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');
const stateManager = require('../skills/sdw-run/scripts/state_manager.cjs');
const sdwShipPr = require('../skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs');

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-testing-toggle-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });

  const sdwDir = path.join(tmpDir, '.sdw');
  fs.mkdirSync(sdwDir, { recursive: true });
  fs.mkdirSync(path.join(sdwDir, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(sdwDir, 'state'), { recursive: true });

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-toggle-project', version: '1.0.0' }, null, 2), 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

  return tmpDir;
}

function buildSpecContent(slug, acCount = 4) {
  let acsText = '';
  for (let i = 1; i <= acCount; i++) {
    acsText += `- AC${i}: The system shall satisfy acceptance condition ${i} for ${slug}.\n`;
  }

  return `---
slug: ${slug}
title: "${slug}"
status: ready-to-implement
---
# Specification — ${slug}

## Description
Feature description for ${slug}.
Affects file: src/${slug}.cjs

## Acceptance Criteria
${acsText}
## Notes
- Implementation surfaces: src/${slug}.cjs
`;
}

// ---------------------------------------------------------------------------
// AC1: enableTestingFeatures in config defaults to false
// ---------------------------------------------------------------------------
test('AC1: enableTestingFeatures in .sdw/config.json defaults to false and is configurable', () => {
  const tmpDir = setupTestRepo();
  try {
    // 1. Default when omitted from config.json
    const sdwDir = path.join(tmpDir, '.sdw');
    const cfgPath = path.join(sdwDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({}, null, 2), 'utf8');

    const defaultConfig = sdwConfig.loadConfig(tmpDir);
    assert.strictEqual(
      defaultConfig.enableTestingFeatures,
      false,
      'enableTestingFeatures must default to false when omitted'
    );

    // 2. Explicitly configured as true
    fs.writeFileSync(cfgPath, JSON.stringify({ enableTestingFeatures: true }, null, 2), 'utf8');
    const enabledConfig = sdwConfig.loadConfig(tmpDir);
    assert.strictEqual(
      enabledConfig.enableTestingFeatures,
      true,
      'enableTestingFeatures must be true when explicitly set to true'
    );

    // 3. Explicitly configured as false
    fs.writeFileSync(cfgPath, JSON.stringify({ enableTestingFeatures: false }, null, 2), 'utf8');
    const disabledConfig = sdwConfig.loadConfig(tmpDir);
    assert.strictEqual(
      disabledConfig.enableTestingFeatures,
      false,
      'enableTestingFeatures must be false when explicitly set to false'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC2: When enableTestingFeatures is false, dag_planner.generateDagPlan generates
//      direct implementation tasks and NO test_author tasks.
// ---------------------------------------------------------------------------
test('AC2: When enableTestingFeatures is false, dag_planner.generateDagPlan omits test_author tasks and generates direct implementation tasks', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00074-feature-toggle';
    const specContent = buildSpecContent(slug, 4);

    const plan = dagPlanner.generateDagPlan(specContent, {
      slug,
      targetRoot: tmpDir,
      config: { enableTestingFeatures: false }
    });

    assert.ok(plan.totalTasks > 0, 'Plan must generate tasks');
    assert.strictEqual(
      plan.tasks.some(t => t.role === 'test_author'),
      false,
      'Plan must not contain any task with role: "test_author"'
    );
    assert.strictEqual(
      plan.tasks.some(t => t.id.includes('-test')),
      false,
      'Plan must not contain any test authoring task IDs'
    );

    // All tasks should be direct implementation tasks
    for (const task of plan.tasks) {
      assert.notStrictEqual(task.role, 'test_author');
      assert.ok(task.coveredAcs && task.coveredAcs.length > 0, 'Task must cover acceptance criteria');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC3: When enableTestingFeatures is false, test segregation is bypassed even
//      if implementation.segregateTests is true.
// ---------------------------------------------------------------------------
test('AC3: When enableTestingFeatures is false, test segregation is bypassed even if implementation.segregateTests is true', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00074-segregation-bypass';
    const specContent = buildSpecContent(slug, 4);

    const plan = dagPlanner.generateDagPlan(specContent, {
      slug,
      targetRoot: tmpDir,
      segregateTests: true,
      config: {
        enableTestingFeatures: false,
        implementation: { segregateTests: true }
      }
    });

    assert.ok(plan.totalTasks > 0, 'Plan must generate tasks');
    assert.strictEqual(
      plan.tasks.some(t => t.role === 'test_author'),
      false,
      'Test segregation must be bypassed: no test_author tasks even if segregateTests is true'
    );

    // Tasks should not depend on test tasks
    for (const task of plan.tasks) {
      for (const dep of task.dependencies) {
        assert.strictEqual(
          dep.includes('-test'),
          false,
          `Task ${task.id} must not depend on a test author task ${dep}`
        );
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC4: When enableTestingFeatures is false, implementation prompt instructs direct
//      implementation and references sdw-rules without test suite satisfaction
//      instructions or test file prohibitions.
// ---------------------------------------------------------------------------
test('AC4: When enableTestingFeatures is false, implementation prompt instructs direct implementation without test suite references or prohibitions', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00074-direct-prompt';
    const task = {
      id: 'task-1',
      role: 'implementation',
      title: 'Implement 00074-direct-prompt',
      coveredAcs: ['AC1', 'AC2'],
      dependencies: [],
      targetFiles: ['src/app.cjs']
    };

    const rendered = implementationRunner.renderTaskPrompt({
      targetRoot: tmpDir,
      specSlug: slug,
      runId: 'run-00074-prompt',
      task,
      specAcs: [
        { id: 'AC1', text: 'First core requirement' },
        { id: 'AC2', text: 'Second core requirement' }
      ],
      enableTestingFeatures: false,
      config: { enableTestingFeatures: false }
    });

    const promptContent = fs.readFileSync(rendered.promptFileAbs, 'utf8');

    // Must reference sdw-rules
    assert.match(promptContent, /sdw-rules/, 'Prompt must reference sdw-rules');

    // Must include assigned criteria
    assert.match(promptContent, /AC1: First core requirement/);
    assert.match(promptContent, /AC2: Second core requirement/);

    // Must NOT contain test suite satisfaction instructions
    assert.doesNotMatch(
      promptContent,
      /Satisfy the existing test suite/i,
      'Prompt must not instruct workers to satisfy existing test suite'
    );

    // Must NOT contain test file modification prohibitions
    assert.doesNotMatch(
      promptContent,
      /Modifying test files is strictly prohibited/i,
      'Prompt must not prohibit modifying test files'
    );
    assert.doesNotMatch(
      promptContent,
      /All test files are explicitly excluded/i,
      'Prompt must not explicitly exclude all test files'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC5 & AC6: When enableTestingFeatures is false, Step 4 verification gate skips
//            testCommand and records test gate as skipped.
// ---------------------------------------------------------------------------
test('AC5 & AC6: Step 4 verification gate skips testCommand and records test gate as skipped when enableTestingFeatures is false', () => {
  assert.equal(
    typeof sdwRun.runVerificationGates,
    'function',
    'sdwRun must export runVerificationGates'
  );

  const tmpDir = setupTestRepo();
  try {
    const config = {
      enableTestingFeatures: false,
      runAllTests: true,
      verification: {
        testCommand: 'node -e "process.exit(1)"'
      }
    };

    // Even if testCommand would fail (exit 1), verification gate skips it
    const gateResults = sdwRun.runVerificationGates(tmpDir, config, { runAllTests: true });

    // AC5: gate passes because testCommand execution is skipped
    assert.strictEqual(
      gateResults.passed,
      true,
      'Step 4 verification gate must pass because testCommand is skipped'
    );

    // AC6: test gate status recorded as skipped
    assert.ok(gateResults.gates && gateResults.gates.test, 'gates.test record must exist');
    assert.strictEqual(
      gateResults.gates.test.status,
      'skipped',
      'gates.test.status must be "skipped"'
    );

    // Verify run state persistence of skipped test gate
    const state = stateManager.createRunState({
      root: tmpDir,
      specPath: '.sdw/specs/00074-gate.md',
      slug: '00074-gate'
    });
    state.steps[4].gates = gateResults.gates;
    stateManager.updateStepState(tmpDir, state.runId, 4, 'completed', {
      tasks: {},
      gates: state.steps[4].gates
    });

    const loadedState = stateManager.loadRunState(tmpDir, state.runId);
    assert.strictEqual(
      loadedState.steps[4].gates.test.status,
      'skipped',
      'Run state must record test gate status as skipped'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC7 & AC8: When enableTestingFeatures is false, sdw-ship-pr pre-PR board skips
//            tests with 'enableTestingFeatures is false'.
// ---------------------------------------------------------------------------
test('AC7 & AC8: sdw-ship-pr pre-PR board skips tests with "enableTestingFeatures is false"', async () => {
  const tmpDir = setupTestRepo();
  try {
    const sdwDir = path.join(tmpDir, '.sdw');
    const config = {
      scmProvider: 'none',
      baseBranch: 'master',
      pushDelivery: false,
      scmCodeReviewEnabled: false,
      requiredBuild: false,
      runAllTests: true,
      enableTestingFeatures: false,
      securityChecksEnabled: false,
      verification: {
        testCommand: 'npm test'
      }
    };
    fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

    const executedCommands = [];
    const fakeExecutor = (cmd) => {
      executedCommands.push(cmd);
      return '';
    };

    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master'
    }, fakeExecutor);

    // AC7: test suite execution is skipped (fakeExecutor is never called for testCommand)
    assert.strictEqual(
      executedCommands.includes('npm test'),
      false,
      'sdw-ship-pr must not execute testCommand when enableTestingFeatures is false'
    );

    // AC8: pre-PR board records tests as skipped with evidence "enableTestingFeatures is false"
    assert.ok(Array.isArray(report.prePrBoard), 'prePrBoard must be an array');
    const testRow = report.prePrBoard.find(row => row.check === 'tests');
    assert.ok(testRow, 'prePrBoard must contain a row for check: "tests"');
    assert.strictEqual(
      testRow.status,
      'skipped',
      'prePrBoard tests check status must be "skipped"'
    );
    assert.strictEqual(
      testRow.evidence,
      'enableTestingFeatures is false',
      'prePrBoard tests check evidence must be "enableTestingFeatures is false"'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
