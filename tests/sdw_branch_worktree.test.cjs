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

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-bw-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });

  // Baseline SDW workspace
  sdwConfig.cmdInit({ root: tmpDir, force: true });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');

  // Initial commit
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Project\n', 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

  return tmpDir;
}

function createDummySpec(repoDir, slug, complexity = 'simple', taskCount = 1) {
  const specPath = path.join(repoDir, '.sdw', 'specs', `${slug}.md`);
  let acs = '- AC1: The system shall pass standard execution.\n';
  if (taskCount > 1) {
    for (let i = 2; i <= taskCount; i++) {
      acs += `- AC${i}: When event ${i} triggers, the system shall handle task unit ${i}.\n`;
    }
  }

  const content = `---
slug: ${slug}
title: Dummy ${slug} Spec
---
# Dummy ${slug} Spec
## Description
Spec for testing branch and worktree workflows.
## Acceptance Criteria
${acs}
## Notes
None
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
| None | None | None |
## Validation & Observation Notes
### Telemetry & Observable Signals
None
### Negative & Failing Test Scenarios
None
`;
  fs.writeFileSync(specPath, content, 'utf8');
  return specPath;
}

test('sdw-orch branch & worktree - AC1..AC4: Configuration defaults, schema and validation', () => {
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.useWorktrees, false);
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.useFeatureBranches, false);

  // Valid boolean config
  const validRes = sdwConfig.validateConfigSchema({
    specsDir: '{projectRoot}/.sdw/specs',
    useWorktrees: true,
    useFeatureBranches: true
  });
  assert.strictEqual(validRes.valid, true);

  // Invalid non-boolean config must fail
  const invalidWorktrees = sdwConfig.validateConfigSchema({
    specsDir: '{projectRoot}/.sdw/specs',
    useWorktrees: 'yes'
  });
  assert.strictEqual(invalidWorktrees.valid, false);
  assert.ok(invalidWorktrees.errors.some(e => e.includes('useWorktrees') && e.includes('must be a boolean')));

  const invalidBranches = sdwConfig.validateConfigSchema({
    specsDir: '{projectRoot}/.sdw/specs',
    useFeatureBranches: 123
  });
  assert.strictEqual(invalidBranches.valid, false);
  assert.ok(invalidBranches.errors.some(e => e.includes('useFeatureBranches') && e.includes('must be a boolean')));
});

test('sdw-orch branch & worktree - AC18: .gitignore and directory-structure.md documentation', () => {
  const rootGitignore = fs.readFileSync(path.resolve(__dirname, '../.gitignore'), 'utf8');
  assert.ok(rootGitignore.includes('.sdw/worktrees/'), '.gitignore must ignore .sdw/worktrees/');

  const dirDoc = fs.readFileSync(path.resolve(__dirname, '../.sdw/directory-structure.md'), 'utf8');
  assert.ok(dirDoc.includes('worktrees/'), 'directory-structure.md must document worktrees/');
});

test('sdw-orch branch & worktree - AC5: Default execution stays on current branch', () => {
  const tmpDir = setupTestRepo();
  try {
    const specPath = createDummySpec(tmpDir, '001-default-branch');
    const curBranchBefore = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    const code = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    const curBranchAfter = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(curBranchAfter, curBranchBefore, 'Must remain on current branch when useFeatureBranches is false');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-orch branch & worktree - AC6, AC8, AC9, AC10: Feature branch creation, reuse, and state recording', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '002-feature-branch-test';
    const specPath = createDummySpec(tmpDir, slug);

    // Enable useFeatureBranches in config.json
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    execSync('git add -A && git commit -m "enable feature branches"', { cwd: tmpDir, stdio: 'ignore' });

    // Initial run - creates feature/{slug}
    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      minScore: 0,
      skipReview: true
    });
    assert.strictEqual(code, 0);

    const activeBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(activeBranch, `feature/${slug}`, 'Must checkout feature branch');

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.strictEqual(state.branch, `feature/${slug}`);
    assert.ok(state.baseBranch);
    assert.strictEqual(state.branchReused, false);

    // Verify Step 8 PR payload contains head and base (AC10)
    assert.ok(state.steps[8] && state.steps[8].output);
    assert.strictEqual(state.steps[8].output.head, `feature/${slug}`);
    assert.strictEqual(state.steps[8].output.base, state.baseBranch);

    // Second run with existing branch: reuses feature branch (AC8)
    const runId2 = `run-${Date.now()}-2-${slug}`;
    const opts2 = {
      specPath,
      root: tmpDir,
      runId: runId2,
      minScore: 0,
      skipReview: true,
      skipPr: true
    };
    const code2 = sdwOrch.cmdRun(opts2);
    if (code2 !== 0) {
      console.error('Test 4 Run 2 failed with runResult:', opts2._runResult);
    }
    assert.strictEqual(code2, 0);
    const state2 = stateManager.loadRunState(tmpDir, runId2);
    assert.strictEqual(state2.branchReused, true, 'Branch must be recorded as reused');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-orch branch & worktree - AC7: Refuses feature branch activation on dirty working tree', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '003-dirty-tree-test';
    const specPath = createDummySpec(tmpDir, slug);

    // Make tree dirty
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted changes', 'utf8');

    const code = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      featureBranch: true,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 1, 'Must halt with exit code 1 when tree is dirty');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-orch branch & worktree - AC13: Single low-complexity task skips worktree creation', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '004-single-low-skip';
    const specPath = createDummySpec(tmpDir, slug, 'simple', 1);

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      worktrees: true,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.strictEqual(state.worktreeSkipReason, 'single low-complexity task');
    assert.strictEqual(state.worktrees.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-orch branch & worktree - AC12, AC14, AC15, AC17: Multi-task worktree lifecycle and cherry-pick integration', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '005-multi-worktree-test';
    // 8 ACs produces complex multi-task plan in DAG generator
    const specPath = createDummySpec(tmpDir, slug, 'complex', 8);
    execSync('git add -A && git commit -m "add multi-task spec"', { cwd: tmpDir, stdio: 'ignore' });

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      worktrees: true,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.ok(state.worktrees.length > 0, 'Must record worktrees for multi-task plan');

    for (const wt of state.worktrees) {
      assert.ok(wt.taskId);
      assert.ok(wt.path);
      assert.ok(wt.branch);
      assert.strictEqual(wt.status, 'integrated');
      // Verify worktree directory was safely removed (AC17)
      const absPath = path.resolve(tmpDir, wt.path);
      assert.strictEqual(fs.existsSync(absPath), false, 'Integrated worktree must be removed');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-orch branch & worktree - AC21: Runtime overrides (--no-worktrees, --no-feature-branch)', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '006-overrides-test';
    const specPath = createDummySpec(tmpDir, slug);

    // Enable both in config.json
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.useWorktrees = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    execSync('git add -A && git commit -m "enable worktrees and branches"', { cwd: tmpDir, stdio: 'ignore' });

    const curBranchBefore = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    const runId = `run-${Date.now()}-${slug}`;

    const code = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      noWorktrees: true,
      noFeatureBranch: true,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    // Branch should remain unchanged due to --no-feature-branch
    const curBranchAfter = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(curBranchAfter, curBranchBefore);

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.ok(state.runtimeOverrides);
    assert.strictEqual(state.runtimeOverrides.useFeatureBranches, false);
    assert.strictEqual(state.runtimeOverrides.useWorktrees, false);
    assert.strictEqual(state.worktrees.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-orch branch & worktree - AC22: status subcommand displays branch and worktrees', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '007-status-test';
    const specPath = createDummySpec(tmpDir, slug, 'complex', 8);
    execSync('git add -A && git commit -m "add test spec"', { cwd: tmpDir, stdio: 'ignore' });

    const runId = `run-${Date.now()}-${slug}`;
    sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      worktrees: true,
      featureBranch: true,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });

    let output = '';
    const origLog = console.log;
    console.log = (msg) => { output += msg + '\n'; };
    try {
      const statusCode = sdwOrch.cmdStatus({ root: tmpDir, runId });
      assert.strictEqual(statusCode, 0);
    } finally {
      console.log = origLog;
    }

    assert.ok(output.includes(`Branch:       feature/${slug}`), 'Status must show feature branch');
    assert.ok(output.includes('Base Branch:'), 'Status must show base branch');
    assert.ok(output.includes('Worktrees:'), 'Status must list worktrees');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
