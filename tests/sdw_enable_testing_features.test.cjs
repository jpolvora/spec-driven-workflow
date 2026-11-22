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
const sdwCodeReview = require('../skills/sdw-code-review/scripts/sdw_code_review.cjs');
const specGrilling = require('../skills/sdw-run/scripts/spec_grilling.cjs');

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

// ---------------------------------------------------------------------------
// AC9: While enableTestingFeatures is false, sdw-ship-pr review fix convergence
//      loops skip testCommand execution.
// ---------------------------------------------------------------------------
test('AC9: While enableTestingFeatures is false, sdw-ship-pr review fix convergence loops skip testCommand execution', async () => {
  const tmpDir = setupTestRepo();
  try {
    const sdwDir = path.join(tmpDir, '.sdw');
    const configDisabled = {
      scmProvider: 'github',
      baseBranch: 'master',
      pushDelivery: false,
      scmCodeReviewEnabled: true,
      requiredBuild: false,
      runAllTests: true,
      enableTestingFeatures: false,
      securityChecksEnabled: false,
      verification: {
        testCommand: 'npm test'
      }
    };
    fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify(configDisabled, null, 2), 'utf8');

    const executedCommandsDisabled = [];
    const fakeExecutorDisabled = (cmd) => {
      executedCommandsDisabled.push(cmd);
      if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
      if (cmd.includes('gh auth status')) return 'Logged in';
      if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
      if (cmd.includes('gh pr list')) {
        return JSON.stringify([{ number: 42, url: 'https://github.com/fake-owner/fake-repo/pull/42', headRefName: 'develop', baseRefName: 'master' }]);
      }
      if (cmd.includes('pr checks')) {
        // Failing check triggers reviewFixCommand
        return JSON.stringify([{ name: 'ci/test', state: 'fail', bucket: 'fail' }]);
      }
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git diff --name-only')) return '';
      return '';
    };

    await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config: configDisabled,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      reviewFixCommand: 'node fix_script.cjs'
    }, fakeExecutorDisabled);

    // reviewFixCommand should be executed
    assert.strictEqual(
      executedCommandsDisabled.includes('node fix_script.cjs'),
      true,
      'reviewFixCommand must be executed when failing check is detected'
    );
    // But testCommand (npm test) must NOT be executed because enableTestingFeatures is false
    assert.strictEqual(
      executedCommandsDisabled.includes('npm test'),
      false,
      'sdw-ship-pr review fix convergence loop must skip testCommand when enableTestingFeatures is false'
    );

    // Opt-in symmetry: when enableTestingFeatures is true, testCommand IS executed in convergence loop
    const configEnabled = { ...configDisabled, enableTestingFeatures: true };
    const executedCommandsEnabled = [];
    const fakeExecutorEnabled = (cmd) => {
      executedCommandsEnabled.push(cmd);
      if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
      if (cmd.includes('gh auth status')) return 'Logged in';
      if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
      if (cmd.includes('gh pr list')) {
        return JSON.stringify([{ number: 42, url: 'https://github.com/fake-owner/fake-repo/pull/42', headRefName: 'develop', baseRefName: 'master' }]);
      }
      if (cmd.includes('pr checks')) {
        return JSON.stringify([{ name: 'ci/test', state: 'fail', bucket: 'fail' }]);
      }
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git diff --name-only')) return '';
      return '';
    };

    await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config: configEnabled,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      reviewFixCommand: 'node fix_script.cjs'
    }, fakeExecutorEnabled);

    assert.strictEqual(
      executedCommandsEnabled.includes('node fix_script.cjs'),
      true,
      'reviewFixCommand must be executed'
    );
    assert.strictEqual(
      executedCommandsEnabled.includes('npm test'),
      true,
      'sdw-ship-pr review fix convergence loop must execute testCommand when enableTestingFeatures is true'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC10: While enableTestingFeatures is false, sdw-code-review omits instructions
//       to re-run test suites from review finding fix prescriptions.
// ---------------------------------------------------------------------------
test('AC10: While enableTestingFeatures is false, sdw-code-review omits instructions to re-run test suites from fix prescriptions', () => {
  const tmpDir = setupTestRepo();
  try {
    const sdwDir = path.join(tmpDir, '.sdw');
    fs.writeFileSync(
      path.join(sdwDir, 'config.json'),
      JSON.stringify({ enableTestingFeatures: false }, null, 2),
      'utf8'
    );

    // Create an uncommitted file with a debugger statement (triggers no_debugger_statements finding)
    fs.writeFileSync(
      path.join(tmpDir, 'service.cjs'),
      'function compute() {\n  debugger;\n  return 42;\n}\nmodule.exports = { compute };\n',
      'utf8'
    );

    const reportPath = path.join(tmpDir, '.sdw', 'state', 'code-review.report.md');
    const report = sdwCodeReview.runCodeReview({
      projectRoot: tmpDir,
      base: 'HEAD',
      report: reportPath,
      fix: false,
      dryRun: false,
      maxIterations: 1
    });

    assert.ok(report.findings.length > 0, 'Code review must generate findings for debugger statement');
    const debuggerFinding = report.findings.find(f => f.rule === 'no_debugger_statements');
    assert.ok(debuggerFinding, 'Must report no_debugger_statements finding');

    // Finding fix prescription must omit re-running test instructions
    assert.doesNotMatch(
      debuggerFinding.fix,
      /re-run .*test/i,
      'Fix prescription must omit instructions to re-run tests when enableTestingFeatures is false'
    );

    // Markdown report must also omit instructions to re-run tests
    assert.ok(fs.existsSync(reportPath), 'Markdown report must be generated');
    const md = fs.readFileSync(reportPath, 'utf8');
    assert.doesNotMatch(
      md,
      /re-run .*test/i,
      'Markdown report must not instruct worker to re-run tests when enableTestingFeatures is false'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC11: While enableTestingFeatures is false, the refinement runner (Step 2)
//       omits test plan requirements and test target files from the generated blueprint.
// ---------------------------------------------------------------------------
test('AC11: While enableTestingFeatures is false, refinement runner omits test plan requirements and test target files from blueprint', () => {
  const specContent = `---
slug: 00074-blueprint-test
title: "00074-blueprint-test"
status: ready-to-implement
---
# Specification — Blueprint Test

## Description
Affects files: \`src/handler.cjs\`, \`tests/handler.test.cjs\`

## Acceptance Criteria
- AC1: The handler shall process events.

### Negative & Failing Test Scenarios
- When payload is malformed, handler rejects with HTTP 400.
`;

  // 1. When enableTestingFeatures is false
  const blueprintDisabled = specGrilling.generateRefinementBlueprint(specContent, {
    enableTestingFeatures: false,
    config: { enableTestingFeatures: false }
  });

  // Test target files must be omitted
  assert.ok(
    blueprintDisabled.targetFiles.includes('src/handler.cjs'),
    'Blueprint targetFiles must retain production target files'
  );
  assert.strictEqual(
    blueprintDisabled.targetFiles.some(f => f.includes('test') || f.startsWith('tests/')),
    false,
    'Blueprint targetFiles must omit test files when enableTestingFeatures is false'
  );

  // Test plan must be omitted or empty
  assert.ok(
    !blueprintDisabled.testPlan || blueprintDisabled.testPlan === null || !blueprintDisabled.testPlan.match(/test/i),
    'Blueprint testPlan must omit automated test requirements when enableTestingFeatures is false'
  );

  // 2. Opt-in symmetry: when enableTestingFeatures is true
  const blueprintEnabled = specGrilling.generateRefinementBlueprint(specContent, {
    enableTestingFeatures: true,
    config: { enableTestingFeatures: true }
  });

  assert.ok(
    blueprintEnabled.targetFiles.includes('tests/handler.test.cjs'),
    'Blueprint targetFiles must include test files when enableTestingFeatures is true'
  );
  assert.ok(
    blueprintEnabled.testPlan && blueprintEnabled.testPlan.length > 0,
    'Blueprint testPlan must be populated when enableTestingFeatures is true'
  );
});

// ---------------------------------------------------------------------------
// AC12: While enableTestingFeatures is false, config validation passes without
//       verification.testCommand even if runAllTests is true.
// ---------------------------------------------------------------------------
test('AC12: Config validation passes without verification.testCommand even if runAllTests is true when enableTestingFeatures is false', () => {
  // When enableTestingFeatures is false, runAllTests: true does NOT require verification.testCommand
  const validConfig = {
    specsDir: '.sdw/specs',
    enableTestingFeatures: false,
    runAllTests: true
  };
  const res = sdwConfig.validateConfigSchema(validConfig);
  const testCmdError = res.errors.find(e => e.includes('Missing required test command'));
  assert.strictEqual(
    testCmdError,
    undefined,
    'validateConfigSchema must pass without verification.testCommand when enableTestingFeatures is false'
  );

  // Opt-in symmetry: when enableTestingFeatures is true, runAllTests: true requires verification.testCommand
  const invalidConfig = {
    specsDir: '.sdw/specs',
    enableTestingFeatures: true,
    runAllTests: true
  };
  const resEnabled = sdwConfig.validateConfigSchema(invalidConfig);
  assert.ok(
    resEnabled.errors.some(e => e.includes('Missing required test command: "runAllTests" is true but "verification.testCommand" is not specified.')),
    'validateConfigSchema must require verification.testCommand when enableTestingFeatures is true and runAllTests is true'
  );
});

// ---------------------------------------------------------------------------
// AC13: Where enableTestingFeatures is set to true, the system executes test author
//       task generation, paired test segregation, and test suite execution gates.
// ---------------------------------------------------------------------------
test('AC13: Where enableTestingFeatures is true, system executes test author task generation, paired segregation, and test suite gates', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00074-opt-in-symmetry';
    const specContent = buildSpecContent(slug, 4);

    // 1. DAG planner generates test_author tasks and paired segregation
    const plan = dagPlanner.generateDagPlan(specContent, {
      slug,
      targetRoot: tmpDir,
      segregateTests: true,
      config: {
        enableTestingFeatures: true,
        implementation: { segregateTests: true }
      }
    });

    assert.ok(plan.totalTasks > 0, 'Plan must generate tasks');
    const testTasks = plan.tasks.filter(t => t.role === 'test_author');
    assert.ok(
      testTasks.length > 0,
      'DAG plan must generate tasks with role: "test_author" when enableTestingFeatures is true'
    );
    assert.ok(
      plan.tasks.some(t => t.id.includes('-test')),
      'DAG plan must include tasks with "-test" IDs'
    );

    // Paired test segregation: implementation task depends on test author task
    const implTasks = plan.tasks.filter(t => t.role === 'implementation');
    assert.ok(
      implTasks.some(impl => impl.dependencies.some(dep => dep.includes('-test'))),
      'Implementation tasks must depend on segregated test author tasks when enableTestingFeatures is true'
    );

    // 2. Step 4 test execution gates execute testCommand
    const failingConfig = {
      enableTestingFeatures: true,
      runAllTests: true,
      verification: { testCommand: 'node -e "process.exit(1)"' }
    };
    const gateFail = sdwRun.runVerificationGates(tmpDir, failingConfig, { runAllTests: true });
    assert.strictEqual(
      gateFail.passed,
      false,
      'Verification gate must fail when testCommand fails and enableTestingFeatures is true'
    );
    assert.strictEqual(gateFail.gates.test.status, 'failed');

    const passingConfig = {
      enableTestingFeatures: true,
      runAllTests: true,
      verification: { testCommand: 'node -e "process.exit(0)"' }
    };
    const gatePass = sdwRun.runVerificationGates(tmpDir, passingConfig, { runAllTests: true });
    assert.strictEqual(
      gatePass.passed,
      true,
      'Verification gate must pass when testCommand passes and enableTestingFeatures is true'
    );
    assert.strictEqual(gatePass.gates.test.status, 'passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC14: The system registers enableTestingFeatures as a boolean property in
//       .sdw/config.schema.json and validates its type in sdw-config.
// ---------------------------------------------------------------------------
test('AC14: enableTestingFeatures is registered as boolean property in schema and validated in sdw-config', () => {
  // 1. Schema check in .sdw/config.schema.json
  const schemaPath = path.join(__dirname, '..', '.sdw', 'config.schema.json');
  assert.ok(fs.existsSync(schemaPath), '.sdw/config.schema.json must exist');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.ok(
    schema.properties && schema.properties.enableTestingFeatures,
    'Schema must declare property "enableTestingFeatures"'
  );
  assert.strictEqual(
    schema.properties.enableTestingFeatures.type,
    'boolean',
    'Schema property "enableTestingFeatures" must be of type boolean'
  );
  assert.strictEqual(
    schema.properties.enableTestingFeatures.default,
    false,
    'Schema property "enableTestingFeatures" default must be false'
  );

  // 2. Schema check in skills/sdw-config/references/config.schema.json
  const refSchemaPath = path.join(__dirname, '..', 'skills', 'sdw-config', 'references', 'config.schema.json');
  assert.ok(fs.existsSync(refSchemaPath), 'skills/sdw-config/references/config.schema.json must exist');
  const refSchema = JSON.parse(fs.readFileSync(refSchemaPath, 'utf8'));
  assert.ok(
    refSchema.properties && refSchema.properties.enableTestingFeatures,
    'Reference schema must declare property "enableTestingFeatures"'
  );
  assert.strictEqual(
    refSchema.properties.enableTestingFeatures.type,
    'boolean'
  );

  // 3. Type validation in sdw_config.validateConfigSchema
  const invalidValues = ['false', 'true', 'yes', 'no', 0, 1, null, {}, []];
  for (const invalid of invalidValues) {
    const res = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', enableTestingFeatures: invalid });
    assert.ok(
      res.errors.some(e => e.includes('Property "enableTestingFeatures" must be a boolean.')),
      `validateConfigSchema must reject non-boolean enableTestingFeatures: ${JSON.stringify(invalid)}`
    );
  }

  // Valid boolean values pass type validation
  const resFalse = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', enableTestingFeatures: false });
  assert.strictEqual(
    resFalse.errors.filter(e => e.includes('enableTestingFeatures')).length,
    0,
    'validateConfigSchema must accept enableTestingFeatures: false'
  );

  const resTrue = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    enableTestingFeatures: true,
    runAllTests: true,
    verification: { testCommand: 'npm test' }
  });
  assert.strictEqual(
    resTrue.errors.filter(e => e.includes('enableTestingFeatures')).length,
    0,
    'validateConfigSchema must accept enableTestingFeatures: true'
  );
});

// ---------------------------------------------------------------------------
// AC15: Documentation across sdw-run, sdw-ship-pr, sdw-code-review, sdw-config,
//       and sdw-rules documents enableTestingFeatures.
// ---------------------------------------------------------------------------
test('AC15: Documentation across sdw-run, sdw-ship-pr, sdw-code-review, sdw-config, and sdw-rules documents enableTestingFeatures', () => {
  const rootDir = path.resolve(__dirname, '..');
  const requiredSkills = [
    'sdw-run',
    'sdw-ship-pr',
    'sdw-code-review',
    'sdw-config',
    'sdw-rules'
  ];

  function collectMarkdownFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        results.push(...collectMarkdownFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
    return results;
  }

  for (const skillName of requiredSkills) {
    const skillDir = path.join(rootDir, 'skills', skillName);
    assert.ok(fs.existsSync(skillDir), `Skill directory must exist: ${skillName}`);
    const mdFiles = collectMarkdownFiles(skillDir);
    assert.ok(mdFiles.length > 0, `Skill ${skillName} must contain markdown documentation files`);

    const hasMention = mdFiles.some(file => {
      const content = fs.readFileSync(file, 'utf8');
      return content.includes('enableTestingFeatures');
    });

    assert.strictEqual(
      hasMention,
      true,
      `Skill ${skillName} documentation (SKILL.md or references/*.md) must document "enableTestingFeatures"`
    );
  }
});

// ---------------------------------------------------------------------------
// AC16: General unit test assertions for DAG generation, gate suppression,
//       pre-PR board skipping, and configuration validation when enableTestingFeatures is false.
// ---------------------------------------------------------------------------
test('AC16: Automated unit tests verify DAG generation, gate suppression, pre-PR board skipping, and config validation when enableTestingFeatures is false', async () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00074-ac16-meta-verification';
    const specContent = buildSpecContent(slug, 3);
    const config = {
      enableTestingFeatures: false,
      runAllTests: true,
      scmProvider: 'none',
      baseBranch: 'master',
      pushDelivery: false,
      scmCodeReviewEnabled: false,
      requiredBuild: false,
      securityChecksEnabled: false,
      verification: {
        testCommand: 'node -e "process.exit(1)"'
      }
    };

    // 1. DAG generation: no test_author tasks
    const plan = dagPlanner.generateDagPlan(specContent, {
      slug,
      targetRoot: tmpDir,
      config
    });
    assert.strictEqual(
      plan.tasks.some(t => t.role === 'test_author'),
      false,
      'AC16: DAG planner must not generate test_author tasks when enableTestingFeatures is false'
    );

    // 2. Step 4 gate suppression: skipped
    const gateResults = sdwRun.runVerificationGates(tmpDir, config, { runAllTests: true });
    assert.strictEqual(
      gateResults.passed,
      true,
      'AC16: Step 4 verification gate must pass by suppressing failing testCommand'
    );
    assert.strictEqual(
      gateResults.gates.test.status,
      'skipped',
      'AC16: Step 4 test gate status must be "skipped"'
    );

    // 3. Pre-PR board skipping: tests check skipped with evidence
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master'
    }, () => '');
    const testRow = report.prePrBoard.find(r => r.check === 'tests');
    assert.ok(testRow, 'AC16: prePrBoard must contain "tests" check');
    assert.strictEqual(testRow.status, 'skipped', 'AC16: tests check must be skipped');
    assert.strictEqual(testRow.evidence, 'enableTestingFeatures is false', 'AC16: tests check evidence must record reason');

    // 4. Configuration validation: passes without testCommand when enableTestingFeatures is false
    const cfgWithoutTestCmd = {
      specsDir: '.sdw/specs',
      enableTestingFeatures: false,
      runAllTests: true
    };
    const res = sdwConfig.validateConfigSchema(cfgWithoutTestCmd);
    assert.strictEqual(
      res.errors.filter(e => e.includes('Missing required test command')).length,
      0,
      'AC16: validateConfigSchema must allow omitting testCommand when enableTestingFeatures is false'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
