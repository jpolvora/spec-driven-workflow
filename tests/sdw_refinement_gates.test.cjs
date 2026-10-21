'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const specGrilling = require('../skills/sdw-orch/scripts/spec_grilling.cjs');
const dagPlanner = require('../skills/sdw-orch/scripts/dag_planner.cjs');

// Spec 027: wire the deterministic judge stub for unattended runs past Step 4.
require('./fixtures/judge_env.cjs').installJudgeEnv();

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-refine-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });

  // Baseline SDW workspace
  sdwConfig.cmdInit({ root: tmpDir, force: true });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');

  // Configure command mode implementation so tasks execute and advance through pipeline
  const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.implementation = {
    mode: 'command',
    command: 'node -e "const fs = require(\'fs\'); const ev = { taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'package.json\'], summary: \'task done\' }; fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify(ev)); const pkg = JSON.parse(fs.readFileSync(\'package.json\', \'utf8\')); pkg.updated = true; fs.writeFileSync(\'package.json\', JSON.stringify(pkg, null, 2));"'
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  // Initial commit
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2), 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

  return tmpDir;
}

function createDummySpec(repoRoot, slug) {
  const specsDir = path.join(repoRoot, '.sdw', 'specs');
  if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });

  const specPath = path.join(specsDir, `${slug}.md`);
  const content = `---
id: null
slug: ${slug}
title: "Test Feature ${slug}"
source: local

status: draft
specDate: 2026-10-19
---

# Specification — Test Feature ${slug}

## Description
This is a test feature specification for verification testing.
Affects file: skills/${slug}/scripts/worker.cjs

### Design Intent
Architectural intent for test feature ${slug}.

## Acceptance Criteria
- AC1: The system shall execute primary verification logic.

## Notes
Implementation notes.

## Out of Scope
| Feature | Reason |
|---|---|
| None | None |

## Assumptions & Open Questions
| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| None | None | None | y |

## Definition of Ready (DoR)
| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Ready | Valid | Check |

## Validation & Observation Notes
### Telemetry & Observable Signals
Signals for ${slug}.

### Negative & Failing Test Scenarios
- Scenario 1: Fails when input is missing.
`;

  fs.writeFileSync(specPath, content, 'utf8');
  return specPath;
}

test('sdw-refinement-gates - AC1, AC2: Step 2 Refinement naming and structured blueprint output', () => {
  const repoRoot = setupTestRepo();
  try {
    const state = stateManager.createRunState({ root: repoRoot, slug: 'test-refine' });
    // AC1: Step 2 designated as 'refinement'
    assert.strictEqual(state.steps[2].name, 'refinement');

    const specPath = createDummySpec(repoRoot, 'test-refine');
    const specContent = fs.readFileSync(specPath, 'utf8');

    // Grilling produces blueprint
    const grilling = specGrilling.analyzeSpecificationGaps(specContent, { slug: 'test-refine' });
    assert.ok(grilling.blueprint);
    assert.ok(Array.isArray(grilling.blueprint.targetFiles));
    assert.ok(grilling.blueprint.architecturalApproach.includes('Architectural intent for test feature test-refine'));
    assert.ok(grilling.blueprint.testPlan.includes('Fails when input is missing'));

    // Execute run through orchestrator
    const runId = `run-${Date.now()}-test-refine`;
    const res = sdwOrch.cmdRun({
      specPath,
      root: repoRoot,
      runId,
      skipSecurity: true,
      skipReview: true,
      unattended: true,
      minScore: 0
    });
    assert.strictEqual(res, 0);

    const savedState = stateManager.loadRunState(repoRoot, runId);
    assert.strictEqual(savedState.steps[2].name, 'refinement');
    assert.strictEqual(savedState.steps[2].status, 'completed');
    assert.ok(savedState.steps[2].output.blueprint);
    assert.deepStrictEqual(savedState.steps[2].output.blueprint.targetFiles, grilling.blueprint.targetFiles);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-refinement-gates - AC3: Step 3 DAG generation ingests blueprint and warns on fallback', () => {
  const specContent = `---
slug: test-dag
---
- AC1: The system shall perform task one.
- AC2: The system shall perform task two.
`;

  // Blueprint provided
  const bp = {
    targetFiles: ['lib/alpha.cjs', 'lib/beta.cjs'],
    architecturalApproach: 'Custom architecture blueprint',
    testPlan: 'Unit test alpha and beta'
  };

  const dagWithBp = dagPlanner.generateDagPlan(specContent, { slug: 'test-dag', blueprint: bp });
  assert.strictEqual(dagWithBp.tasks[0].targetFiles[0], 'lib/alpha.cjs');
  assert.strictEqual(dagWithBp.tasks[0].architecturalApproach, 'Custom architecture blueprint');
  assert.strictEqual(dagWithBp.tasks[0].testPlan, 'Unit test alpha and beta');
  assert.ok(dagWithBp.tasks[0].contextPrompt.includes('Custom architecture blueprint'));
  assert.ok(dagWithBp.tasks[0].contextPrompt.includes('Unit test alpha and beta'));

  // Missing blueprint fallback with warning
  let warned = false;
  const originalWarn = console.warn;
  console.warn = (msg) => {
    if (msg.includes('Step 2 refinement blueprint missing')) warned = true;
  };
  try {
    const dagFallback = dagPlanner.generateDagPlan(specContent, { slug: 'test-dag' });
    assert.ok(warned);
    assert.ok(dagFallback.tasks.length > 0);
  } finally {
    console.warn = originalWarn;
  }
});

test('sdw-refinement-gates - AC4, AC13: requiredBuild and runAllTests config schema, defaults & validation', () => {
  // Schema and defaults
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.requiredBuild, false);
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.runAllTests, false);
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.buildCommand, 'npm run build');
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.testCommand, 'npm test');
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.prePrCommand, '');
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.prePrInstructions, '');

  const schema = sdwConfig.DEFAULT_SCHEMA;
  assert.ok(schema.properties.requiredBuild);
  assert.strictEqual(schema.properties.requiredBuild.type, 'boolean');
  assert.ok(schema.properties.runAllTests);
  assert.strictEqual(schema.properties.runAllTests.type, 'boolean');

  // Type validation
  const valid = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    requiredBuild: true,
    buildCommand: 'npm run custom-build',
    runAllTests: true,
    testCommand: 'npm run custom-test',
    prePrCommand: 'node scripts/bump.cjs',
    prePrInstructions: 'Bump version in package.json'
  });
  assert.strictEqual(valid.valid, true);

  const invalid = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    requiredBuild: 'yes',
    runAllTests: 123
  });
  assert.strictEqual(invalid.valid, false);
  assert.ok(invalid.errors.some(e => e.includes('requiredBuild')));
  assert.ok(invalid.errors.some(e => e.includes('runAllTests')));
});

test('sdw-refinement-gates - AC5, AC6: Step 8 executes buildCommand and testCommand when enabled', () => {
  const repoRoot = setupTestRepo();
  try {
    const buildMarker = path.join(repoRoot, 'build.marker').replace(/\\/g, '/');
    const testMarker = path.join(repoRoot, 'test.marker').replace(/\\/g, '/');

    // Update config to enable requiredBuild and runAllTests
    const configPath = path.join(repoRoot, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.requiredBuild = true;
    cfg.buildCommand = `node -e "require('fs').writeFileSync('${buildMarker}', 'built')"`;
    cfg.runAllTests = true;
    cfg.testCommand = `node -e "require('fs').writeFileSync('${testMarker}', 'tested')"`;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const specPath = createDummySpec(repoRoot, 'test-build-test');
    const runId = `run-${Date.now()}-test-build-test`;
    const res = sdwOrch.cmdRun({
      specPath,
      root: repoRoot,
      runId,
      skipSecurity: true,
      skipReview: true,
      unattended: true,
      minScore: 0
    });

    assert.strictEqual(res, 0);
    assert.ok(fs.existsSync(buildMarker), 'build marker must be created');
    assert.strictEqual(fs.readFileSync(buildMarker, 'utf8'), 'built');
    assert.ok(fs.existsSync(testMarker), 'test marker must be created');
    assert.strictEqual(fs.readFileSync(testMarker, 'utf8'), 'tested');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-refinement-gates - AC7, AC14: Step 8 skips build/test when false and evaluates without remote push', () => {
  const repoRoot = setupTestRepo();
  try {
    const configPath = path.join(repoRoot, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.requiredBuild = false;
    cfg.runAllTests = false;
    cfg.pushDelivery = false;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const specPath = createDummySpec(repoRoot, 'test-skip-gates');
    const runId = `run-${Date.now()}-test-skip-gates`;
    const res = sdwOrch.cmdRun({
      specPath,
      root: repoRoot,
      runId,
      skipSecurity: true,
      skipReview: true,
      unattended: true,
      minScore: 0
    });

    assert.strictEqual(res, 0);
    const savedState = stateManager.loadRunState(repoRoot, runId);
    assert.strictEqual(savedState.steps[8].status, 'completed');
    assert.strictEqual(savedState.pushedBranch, undefined);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-refinement-gates - AC8, AC10: Failed build/test triggers fix loop and halts after max attempts', () => {
  const repoRoot = setupTestRepo();
  try {
    // Failing build script
    const buildScript = path.join(repoRoot, 'build.cjs');
    fs.writeFileSync(buildScript, 'process.exit(1);\n', 'utf8');

    const configPath = path.join(repoRoot, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.requiredBuild = true;
    cfg.buildCommand = 'node build.cjs';
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const specPath = createDummySpec(repoRoot, 'test-build-fail');
    const runId = `run-${Date.now()}-test-build-fail`;
    const res = sdwOrch.cmdRun({
      specPath,
      root: repoRoot,
      runId,
      skipSecurity: true,
      skipReview: true,
      unattended: true,
      minScore: 0
    });

    // Halts with code 1
    assert.strictEqual(res, 1);
    const savedState = stateManager.loadRunState(repoRoot, runId);
    assert.strictEqual(savedState.status, 'failed');
    assert.ok(savedState.errors.some(e => e.error.includes('Build verification failed')));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-refinement-gates - AC8: Successful automated fix resolves test failure and records fix commit', () => {
  const repoRoot = setupTestRepo();
  try {
    // Test script initially fails
    const testScript = path.join(repoRoot, 'test.cjs');
    fs.writeFileSync(testScript, 'process.exit(1);\n', 'utf8');
    execSync('git add -A && git commit -m "add test.cjs"', { cwd: repoRoot, stdio: 'ignore' });

    const configPath = path.join(repoRoot, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.runAllTests = true;
    cfg.testCommand = 'node test.cjs';
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const specPath = createDummySpec(repoRoot, 'test-fix-success');
    const runId = `run-${Date.now()}-test-fix-success`;
    let fixerCalled = 0;

    const res = sdwOrch.cmdRun({
      specPath,
      root: repoRoot,
      runId,
      skipSecurity: true,
      skipReview: true,
      unattended: true,
      minScore: 0,
      testFixer: (root, attempt) => {
        fixerCalled++;
        // Fix test.cjs on attempt 1
        fs.writeFileSync(path.join(root, 'test.cjs'), 'process.exit(0);\n', 'utf8');
      }
    });

    assert.strictEqual(res, 0);
    assert.strictEqual(fixerCalled, 1);

    // Verify fix commit was created in git history
    const log = execSync('git log -n 3 --oneline', { cwd: repoRoot, encoding: 'utf8' });
    assert.ok(log.includes('fix(test-fix-success): resolve test failure (attempt 1)'));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-refinement-gates - AC9: Secret leak check rejects fix commit if automated fix introduces secret', () => {
  const repoRoot = setupTestRepo();
  try {
    const testScript = path.join(repoRoot, 'test.cjs');
    fs.writeFileSync(testScript, 'process.exit(1);\n', 'utf8');
    execSync('git add -A && git commit -m "add test.cjs"', { cwd: repoRoot, stdio: 'ignore' });

    const configPath = path.join(repoRoot, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.securityChecksEnabled = true;
    cfg.runAllTests = true;
    cfg.testCommand = 'node test.cjs';
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const specPath = createDummySpec(repoRoot, 'test-fix-leak');
    const runId = `run-${Date.now()}-test-fix-leak`;
    const res = sdwOrch.cmdRun({
      specPath,
      root: repoRoot,
      runId,
      skipSecurity: false,
      skipReview: true,
      unattended: true,
      minScore: 0,
      testFixer: (root, attempt) => {
        // Introduce a high-severity GitHub token leak
        const leakContent = 'const token = "ghp_' + '123456789012345678901234567890123456";\nprocess.exit(0);\n';
        fs.writeFileSync(path.join(root, 'test.cjs'), leakContent, 'utf8');
      }
    });

    assert.strictEqual(res, 1);
    const savedState = stateManager.loadRunState(repoRoot, runId);
    assert.strictEqual(savedState.status, 'failed');
    assert.ok(savedState.errors.some(e => e.error.includes('secret leak detected')));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-refinement-gates - AC11, AC12: Project pre-PR commands stage changes, verify leaks, and commit', () => {
  const repoRoot = setupTestRepo();
  try {
    const configPath = path.join(repoRoot, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.prePrInstructions = 'Bump package.json version to 1.1.0';
    cfg.prePrCommand = 'node -e "const p = JSON.parse(require(\'fs\').readFileSync(\'package.json\')); p.version = \'1.1.0\'; require(\'fs\').writeFileSync(\'package.json\', JSON.stringify(p, null, 2));"';
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const specPath = createDummySpec(repoRoot, 'test-pre-pr');
    const runId = `run-${Date.now()}-test-pre-pr`;
    const res = sdwOrch.cmdRun({
      specPath,
      root: repoRoot,
      runId,
      skipSecurity: true,
      skipReview: true,
      unattended: true,
      minScore: 0
    });

    assert.strictEqual(res, 0);

    // Verify package.json was updated
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.version, '1.1.0');

    // Verify commit in git log
    const log = execSync('git log -n 3 --oneline', { cwd: repoRoot, encoding: 'utf8' });
    assert.ok(log.includes('chore(test-pre-pr): apply pre-pr requirements'));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
