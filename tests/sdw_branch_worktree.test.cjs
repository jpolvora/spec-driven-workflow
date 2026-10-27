'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');
const stateManager = require('../skills/sdw-run/scripts/state_manager.cjs');

// Spec 027: wire the deterministic judge stub for unattended runs past Step 4.
require('./fixtures/judge_env.cjs').installJudgeEnv();

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-bw-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });

  // Baseline SDW workspace
  sdwConfig.cmdInit({ root: tmpDir, force: true });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');

  // Configure command mode implementation so tasks execute and integrate
  const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.implementation = {
    mode: 'command',
    command: 'node -e "const fs = require(\'fs\'); const acs = process.env.SDW_AC_IDS ? process.env.SDW_AC_IDS.split(\',\').filter(Boolean) : [\'AC1\']; const ev = { taskId: process.env.SDW_TASK_ID, acIds: acs.length > 0 ? acs : [\'AC1\'], filesChanged: [\'README.md\'], summary: \'task done\' }; fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify(ev)); fs.appendFileSync(\'README.md\', \'\\n# update for \' + process.env.SDW_TASK_ID);"'
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

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

test('sdw-run branch & worktree - AC1..AC4: Configuration defaults, schema and validation', () => {
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

test('sdw-run branch & worktree - AC18: .gitignore and directory-structure.md documentation', () => {
  const rootGitignore = fs.readFileSync(path.resolve(__dirname, '../.gitignore'), 'utf8');
  assert.ok(rootGitignore.includes('.sdw/worktrees/'), '.gitignore must ignore .sdw/worktrees/');

  const dirDoc = fs.readFileSync(path.resolve(__dirname, '../.sdw/directory-structure.md'), 'utf8');
  assert.ok(dirDoc.includes('worktrees/'), 'directory-structure.md must document worktrees/');
});

test('sdw-run branch & worktree - AC5: Default execution stays on current branch', () => {
  const tmpDir = setupTestRepo();
  try {
    const specPath = createDummySpec(tmpDir, '00001-default-branch');
    const curBranchBefore = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    const code = sdwRun.cmdRun({
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

test('sdw-run branch & worktree - AC6, AC8, AC9, AC10: Feature branch creation, reuse, and state recording', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00002-feature-branch-test';
    const specPath = createDummySpec(tmpDir, slug);

    // Enable useFeatureBranches in config.json
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    execSync('git add -A && git commit -m "enable feature branches"', { cwd: tmpDir, stdio: 'ignore' });

    // Initial run - creates feature/{slug}
    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({
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
    const code2 = sdwRun.cmdRun(opts2);
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

test('sdw-run branch & worktree - AC7: Dirty tree never blocks; delivery commits only tracked spec files', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00003-dirty-tree-test';
    const specPath = createDummySpec(tmpDir, slug);

    // Unrelated dirty file must be left alone by scoped commits
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted changes', 'utf8');

    const code = sdwRun.cmdRun({
      specPath,
      root: tmpDir,
      featureBranch: true,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0, 'Dirty tree must not halt execution');

    const activeBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(activeBranch, `feature/${slug}`, 'Must checkout feature branch despite dirty tree');

    const committed = execSync('git log --oneline --name-only -3', { cwd: tmpDir, encoding: 'utf8' });
    assert.ok(!committed.split('\n').some(l => l.trim() === 'dirty.txt'), 'Unrelated dirty.txt must not be swept into delivery commits');
    assert.ok(fs.existsSync(path.join(tmpDir, 'dirty.txt')), 'Unrelated dirty.txt must remain uncommitted in worktree');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-run branch & worktree - AC13: Single low-complexity task skips worktree creation', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00004-single-low-skip';
    const specPath = createDummySpec(tmpDir, slug, 'simple', 1);

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({
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

test('sdw-run branch & worktree - AC12, AC14, AC15, AC17: Multi-task worktree lifecycle and cherry-pick integration', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00005-multi-worktree-test';
    // 8 ACs produces complex multi-task plan in DAG generator
    const specPath = createDummySpec(tmpDir, slug, 'complex', 8);
    execSync('git add -A && git commit -m "add multi-task spec"', { cwd: tmpDir, stdio: 'ignore' });

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      worktrees: true,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.strictEqual(state.score, 10, 'All acceptance criteria must be satisfied');
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

test('sdw-run branch & worktree - AC21: Runtime overrides (--no-worktrees, --no-feature-branch)', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00006-overrides-test';
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

    const code = sdwRun.cmdRun({
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

test('sdw-run branch & worktree - AC22: status subcommand displays branch and worktrees', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00007-status-test';
    const specPath = createDummySpec(tmpDir, slug, 'complex', 8);
    execSync('git add -A && git commit -m "add test spec"', { cwd: tmpDir, stdio: 'ignore' });

    const runId = `run-${Date.now()}-${slug}`;
    sdwRun.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      worktrees: true,
      featureBranch: true,
      skipReview: true,
      skipPr: true
    });

    let output = '';
    const origLog = console.log;
    console.log = (msg) => { output += msg + '\n'; };
    try {
      const statusCode = sdwRun.cmdStatus({ root: tmpDir, runId });
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

test('sdw-run branch & worktree - branching AC6: feature branch starts from the work branch', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00008-work-branch-start';
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    // The work lane carries a commit the checked-out branch does not have
    execSync('git switch -c develop', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'develop-only.txt'), 'work lane change\n', 'utf8');
    execSync('git add -A && git commit -m "develop work"', { cwd: tmpDir, stdio: 'ignore' });
    const workHead = execSync('git rev-parse develop', { cwd: tmpDir, encoding: 'utf8' }).trim();
    execSync(`git switch ${defaultBranch}`, { cwd: tmpDir, stdio: 'ignore' });
    const specPath = createDummySpec(tmpDir, slug);

    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.branching = {
      strategy: 'gitflow',
      featurePrefix: 'feature/',
      workBranch: 'develop',
      integrationBranch: defaultBranch,
      updateWorkBranch: false,
      syncWorkBranchAfterMerge: true,
      pushSyncedWorkBranch: false
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    const activeBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(activeBranch, `feature/${slug}`, 'Must checkout the feature branch');
    const featureBase = execSync(`git merge-base feature/${slug} develop`, { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(featureBase, workHead, 'Feature branch must start at the work branch commit');
    assert.ok(fs.existsSync(path.join(tmpDir, 'develop-only.txt')), 'Feature branch must contain the work branch content');

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.strictEqual(state.branch, `feature/${slug}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-run branch & worktree - branching AC7: updateWorkBranch fetches and fast-forwards the work branch', () => {
  const tmpDir = setupTestRepo();
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-bw-remote-'));
  try {
    const slug = '00009-work-branch-update';
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    // Publish the work lane, then rewind the local branch so only origin has the change
    execSync('git switch -c develop', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'develop-only.txt'), 'remote work lane change\n', 'utf8');
    execSync('git add -A && git commit -m "develop work"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });
    const remoteUrl = remoteDir.replace(/\\/g, '/');
    execSync(`git remote add origin "${remoteUrl}"`, { cwd: tmpDir, stdio: 'ignore' });
    execSync('git push -u origin develop', { cwd: tmpDir, stdio: 'ignore' });
    const remoteHead = execSync('git rev-parse origin/develop', { cwd: tmpDir, encoding: 'utf8' }).trim();
    execSync('git reset --hard HEAD~1', { cwd: tmpDir, stdio: 'ignore' });
    execSync(`git switch ${defaultBranch}`, { cwd: tmpDir, stdio: 'ignore' });
    const specPath = createDummySpec(tmpDir, slug);

    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.branching = { strategy: 'develop', workBranch: 'develop', updateWorkBranch: true, syncWorkBranchAfterMerge: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    const updatedWorkHead = execSync('git rev-parse develop', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(updatedWorkHead, remoteHead, 'Local work branch must fast-forward to origin');
    const featureBase = execSync(`git merge-base feature/${slug} develop`, { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(featureBase, remoteHead, 'Feature branch must start at the updated work branch');
    assert.ok(fs.existsSync(path.join(tmpDir, 'develop-only.txt')), 'Feature branch must contain the fetched work branch content');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test('sdw-run branch & worktree - branching AC7 gitflow: same-lane update fast-forwards the checked-out work branch', () => {
  const tmpDir = setupTestRepo();
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-bw-remote-'));
  try {
    const slug = '00011-same-lane-update';
    execSync('git switch -c develop', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'develop-only.txt'), 'remote work lane change\n', 'utf8');
    execSync('git add -A && git commit -m "develop work"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });
    const remoteUrl = remoteDir.replace(/\\/g, '/');
    execSync(`git remote add origin "${remoteUrl}"`, { cwd: tmpDir, stdio: 'ignore' });
    execSync('git push -u origin develop', { cwd: tmpDir, stdio: 'ignore' });
    const remoteHead = execSync('git rev-parse origin/develop', { cwd: tmpDir, encoding: 'utf8' }).trim();
    execSync('git reset --hard HEAD~1', { cwd: tmpDir, stdio: 'ignore' });
    // Stay on develop: gitflow keeps workBranch and integrationBranch on one lane.
    const specPath = createDummySpec(tmpDir, slug);

    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.branching = {
      strategy: 'gitflow',
      workBranch: 'develop',
      integrationBranch: 'develop',
      updateWorkBranch: true,
      syncWorkBranchAfterMerge: true
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    const updatedWorkHead = execSync('git rev-parse develop', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(updatedWorkHead, remoteHead, 'Same-lane work branch must fast-forward to origin');
    const featureBase = execSync(`git merge-base feature/${slug} develop`, { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(featureBase, remoteHead, 'Feature branch must start at the updated same-lane work branch');
    assert.ok(fs.existsSync(path.join(tmpDir, 'develop-only.txt')), 'Feature branch must contain the fetched work branch content');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test('sdw-run branch & worktree - branching auto: the github preset resolves origin/HEAD into both lanes', () => {
  const tmpDir = setupTestRepo();
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-bw-remote-'));
  try {
    const slug = '00012-github-auto';
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(tmpDir, 'remote-only.txt'), 'remote change\n', 'utf8');
    execSync('git add -A && git commit -m "remote change"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });
    const remoteUrl = remoteDir.replace(/\\/g, '/');
    execSync(`git remote add origin "${remoteUrl}"`, { cwd: tmpDir, stdio: 'ignore' });
    execSync(`git push -u origin ${defaultBranch}`, { cwd: tmpDir, stdio: 'ignore' });
    execSync(`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/${defaultBranch}`, { cwd: tmpDir, stdio: 'ignore' });
    const remoteHead = execSync(`git rev-parse origin/${defaultBranch}`, { cwd: tmpDir, encoding: 'utf8' }).trim();
    execSync('git reset --hard HEAD~1', { cwd: tmpDir, stdio: 'ignore' });
    const specPath = createDummySpec(tmpDir, slug);

    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.branching = { strategy: 'github' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({ specPath, root: tmpDir, runId, minScore: 0, skipReview: true, skipPr: true });
    assert.strictEqual(code, 0);

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.strictEqual(state.branching.integrationBranch, defaultBranch, 'Auto integration lane resolves to origin/HEAD');
    assert.strictEqual(state.branching.workBranch, defaultBranch, 'Mirror preset resolves the work lane too');
    assert.strictEqual(execSync(`git rev-parse ${defaultBranch}`, { cwd: tmpDir, encoding: 'utf8' }).trim(), remoteHead, 'Same-lane update fast-forwards the mirrored lane');
    assert.strictEqual(execSync(`git merge-base feature/${slug} ${defaultBranch}`, { cwd: tmpDir, encoding: 'utf8' }).trim(), remoteHead, 'Feature branch starts at the resolved lane');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test('sdw-run branch & worktree - branching AC7: a distinct work lane that is checked out updates in place', () => {
  const tmpDir = setupTestRepo();
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-bw-remote-'));
  try {
    const slug = '00014-checked-out-work-lane';
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    execSync('git switch -c develop', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'develop-only.txt'), 'remote work lane change\n', 'utf8');
    execSync('git add -A && git commit -m "develop work"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });
    const remoteUrl = remoteDir.replace(/\\/g, '/');
    execSync(`git remote add origin "${remoteUrl}"`, { cwd: tmpDir, stdio: 'ignore' });
    execSync('git push -u origin develop', { cwd: tmpDir, stdio: 'ignore' });
    execSync(`git push origin ${defaultBranch}`, { cwd: tmpDir, stdio: 'ignore' });
    const remoteHead = execSync('git rev-parse origin/develop', { cwd: tmpDir, encoding: 'utf8' }).trim();
    execSync('git reset --hard HEAD~1', { cwd: tmpDir, stdio: 'ignore' });
    // Stay on develop: a distinct work lane that is also the checked-out branch.
    const specPath = createDummySpec(tmpDir, slug);

    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.branching = {
      strategy: 'develop',
      workBranch: 'develop',
      integrationBranch: defaultBranch,
      updateWorkBranch: true
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({ specPath, root: tmpDir, runId, minScore: 0, skipReview: true, skipPr: true });
    assert.strictEqual(code, 0, 'A checked-out work lane must not block the fetch');

    const updatedWorkHead = execSync('git rev-parse develop', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(updatedWorkHead, remoteHead, 'Checked-out work lane fast-forwards in place');
    const featureBase = execSync(`git merge-base feature/${slug} develop`, { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(featureBase, remoteHead, 'Feature branch starts at the updated checked-out lane');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test('sdw-run branch & worktree - branching dirty tree: a conflicting work lane never blocks activation', () => {
  const tmpDir = setupTestRepo();
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-bw-remote-'));
  try {
    const slug = '00013-dirty-work-lane';
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    execSync('git switch -c develop', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'develop content\n', 'utf8');
    execSync('git add -A && git commit -m "develop readme"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git init --bare', { cwd: remoteDir, stdio: 'ignore' });
    const remoteUrl = remoteDir.replace(/\\/g, '/');
    execSync(`git remote add origin "${remoteUrl}"`, { cwd: tmpDir, stdio: 'ignore' });
    execSync('git push -u origin develop', { cwd: tmpDir, stdio: 'ignore' });
    execSync(`git push origin ${defaultBranch}`, { cwd: tmpDir, stdio: 'ignore' });
    execSync(`git switch ${defaultBranch}`, { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'dirty local edit\n', 'utf8');
    const startHead = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    const specPath = createDummySpec(tmpDir, slug);

    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.branching = { strategy: 'develop', workBranch: 'develop', integrationBranch: defaultBranch, updateWorkBranch: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwRun.cmdRun({ specPath, root: tmpDir, runId, minScore: 0, skipReview: true, skipPr: true });
    assert.strictEqual(code, 0, 'A dirty tree must never halt activation');

    const featureBase = execSync(`git merge-base feature/${slug} ${defaultBranch}`, { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(featureBase, startHead, 'Fallback starts the feature branch from the checked-out branch');
    assert.match(fs.readFileSync(path.join(tmpDir, 'README.md'), 'utf8'), /^dirty local edit/, 'The dirty edit survives');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test('sdw-run branch & worktree - branching AC8: work-branch update failure exits 1 before creating the feature branch', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00010-work-branch-update-failure';
    const specPath = createDummySpec(tmpDir, slug);
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    // A local work lane but no origin remote, so the pre-start update must fail
    execSync('git switch -c develop', { cwd: tmpDir, stdio: 'ignore' });
    execSync(`git switch ${defaultBranch}`, { cwd: tmpDir, stdio: 'ignore' });

    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.branching = { strategy: 'develop' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    execSync('git add -A && git commit -m "configure branching"', { cwd: tmpDir, stdio: 'ignore' });

    const statusBefore = execSync('git status --porcelain', { cwd: tmpDir, encoding: 'utf8' }).trim();
    const runId = `run-${Date.now()}-${slug}`;
    const opts = { specPath, root: tmpDir, runId, minScore: 0, skipReview: true, skipPr: true };
    const code = sdwRun.cmdRun(opts);
    assert.strictEqual(code, 1, 'Must fail when the work branch cannot be updated');

    let featureExists = true;
    try {
      execSync(`git rev-parse --verify --quiet "refs/heads/feature/${slug}"`, { cwd: tmpDir, stdio: 'ignore' });
    } catch (e) {
      featureExists = false;
    }
    assert.strictEqual(featureExists, false, 'Feature branch must not be created when the update fails');
    assert.strictEqual(execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim(), defaultBranch, 'Must stay on the original branch');
    assert.strictEqual(execSync('git status --porcelain', { cwd: tmpDir, encoding: 'utf8' }).trim(), statusBefore, 'Working tree must be unchanged');
    assert.ok(opts._runResult && opts._runResult.error.includes('Failed to update work branch "develop"'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-run branch & worktree - branching reuse: resuming on the feature branch never checks out, fetches, or fast-forwards', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '00011-reuse-safety';
    const specPath = createDummySpec(tmpDir, slug);

    // A preset that would fetch and update the work lane; without an origin remote
    // any update attempt would fail, proving the reuse path performs none.
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.useFeatureBranches = true;
    cfg.branching = { strategy: 'develop' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    execSync('git add -A && git commit -m "configure branching"', { cwd: tmpDir, stdio: 'ignore' });

    execSync(`git switch -c feature/${slug}`, { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'resume-dirty.txt'), 'uncommitted delivery changes', 'utf8');

    let output = '';
    const origLog = console.log;
    console.log = (msg) => { output += msg + '\n'; };
    const runId = `run-${Date.now()}-${slug}`;
    let code;
    try {
      code = sdwRun.cmdRun({ specPath, root: tmpDir, runId, minScore: 0, skipReview: true, skipPr: true });
    } finally {
      console.log = origLog;
    }
    assert.strictEqual(code, 0, 'Resuming on the feature branch must not touch the work lane');
    assert.ok(output.includes(`Already on feature branch "feature/${slug}"`), 'Must report branch reuse');
    assert.strictEqual(execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim(), `feature/${slug}`);
    assert.ok(fs.existsSync(path.join(tmpDir, 'resume-dirty.txt')), 'Uncommitted delivery changes must remain');

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.strictEqual(state.branchReused, true);
    assert.strictEqual(state.branch, `feature/${slug}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
