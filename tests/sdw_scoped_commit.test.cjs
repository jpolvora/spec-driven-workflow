'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');
const evidenceValidator = require('../skills/sdw-run/scripts/evidence_validator.cjs');

// Spec 027: wire the deterministic judge stub for unattended runs past Step 4.
require('./fixtures/judge_env.cjs').installJudgeEnv();

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-scoped-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });

  sdwConfig.cmdInit({ root: tmpDir, force: true });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');

  const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.implementation = {
    mode: 'command',
    command: 'node -e "const fs = require(\'fs\'); const ev = { taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'tracked.txt\'], summary: \'task done\' }; fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify(ev)); fs.appendFileSync(\'tracked.txt\', \'\\n# update for \' + process.env.SDW_TASK_ID);"'
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  fs.writeFileSync(path.join(tmpDir, 'tracked.txt'), '# tracked\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test Project\n', 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

  return tmpDir;
}

function createDummySpec(repoDir, slug) {
  const specPath = path.join(repoDir, '.sdw', 'specs', `${slug}.md`);
  const content = `---
slug: ${slug}
title: Dummy ${slug} Spec
---
# Dummy ${slug} Spec
## Description
Scoped commit test spec.
## Acceptance Criteria
- AC1: The system shall pass standard execution.
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

test('scoped commits: dirty tree never blocks execution', () => {
  const tmpDir = setupTestRepo();
  try {
    const specPath = createDummySpec(tmpDir, 'scoped-dirty-run');
    fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'do not touch', 'utf8');
    fs.appendFileSync(path.join(tmpDir, 'README.md'), '\n# unrelated local edit\n');

    const code = sdwRun.cmdRun({
      specPath,
      root: tmpDir,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0, 'Run must succeed despite dirty tree');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoped commits: delivery stages only evidence files, leaves unrelated dirt', () => {
  const tmpDir = setupTestRepo();
  try {
    const specPath = createDummySpec(tmpDir, 'scoped-delivery');
    fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'do not commit', 'utf8');
    fs.appendFileSync(path.join(tmpDir, 'README.md'), '\n# unrelated edit\n');

    const code = sdwRun.cmdRun({
      specPath,
      root: tmpDir,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(code, 0);

    const status = execSync('git status --porcelain', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.ok(status.includes('unrelated.txt'), 'Unrelated untracked file must remain uncommitted');
    assert.ok(status.includes('README.md'), 'Unrelated README edit must remain uncommitted');

    const headNames = execSync('git show --name-only --pretty=format: HEAD', { cwd: tmpDir, encoding: 'utf8' });
    const headFiles = headNames.split('\n').map(l => l.trim()).filter(Boolean);
    assert.ok(!headFiles.includes('unrelated.txt'), 'Delivery must not sweep unrelated.txt');
    assert.ok(!headFiles.includes('README.md'), 'Delivery must not sweep unrelated README.md edit');
    assert.ok(headFiles.includes('tracked.txt'), 'Delivery must include evidence file tracked.txt');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoped commits: collectDeliveryFiles tracks evidence plus index only', () => {
  const tmpDir = setupTestRepo();
  try {
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'specs', 'index.specs.md'), '# Specification Index\n', 'utf8');
    const fakeState = {
      steps: {
        4: {
          tasks: {
            'task-1': { status: 'completed', filesChanged: ['tracked.txt', 'unrelated.txt'] },
            'task-2': { status: 'pending', filesChanged: ['should-ignore.txt'] }
          }
        }
      }
    };
    const files = sdwRun.collectDeliveryFiles(tmpDir, 'scoped-spec', fakeState);
    assert.ok(files.includes('tracked.txt'), 'Includes completed evidence files');
    assert.ok(files.includes('unrelated.txt'), 'Includes all completed evidence entries verbatim');
    assert.ok(!files.includes('should-ignore.txt'), 'Excludes pending task files');
    assert.ok(files.includes('.sdw/specs/index.specs.md'), 'Always includes spec index');
    assert.ok(!files.some(f => f.startsWith('.sdw/state/')), 'Never includes run state');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoped commits: stageAndCommitOnly leaves unrelated changes behind', () => {
  const tmpDir = setupTestRepo();
  try {
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'keep me dirty', 'utf8');
    fs.appendFileSync(path.join(tmpDir, 'tracked.txt'), '\n# scoped change\n');
    const res = sdwRun.stageAndCommitOnly(tmpDir, ['tracked.txt'], 'feat(scoped): scoped commit');
    assert.strictEqual(res.committed, true);
    const status = execSync('git status --porcelain', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.ok(status.includes('keep.txt'), 'Unrelated file left uncommitted');
    assert.ok(!status.includes('tracked.txt'), 'Scoped file committed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scoped commits: evidence accepts git-tracked deletions', () => {
  const tmpDir = setupTestRepo();
  try {
    const doomed = path.join(tmpDir, 'doomed.txt');
    fs.writeFileSync(doomed, 'to be deleted', 'utf8');
    execSync('git add -A && git commit -m "add doomed"', { cwd: tmpDir, stdio: 'ignore' });
    fs.rmSync(doomed);

    const validation = evidenceValidator.validateEvidence({
      taskId: 'task-1',
      acIds: ['AC1'],
      filesChanged: ['doomed.txt'],
      summary: 'deleted file'
    }, { expectedTaskId: 'task-1', specAcs: ['AC1'], projectRoot: tmpDir });
    assert.strictEqual(validation.valid, true, 'Git-tracked deletion must validate');

    const res = sdwRun.stageAndCommitOnly(tmpDir, ['doomed.txt'], 'feat(scoped): delete doomed');
    assert.strictEqual(res.committed, true, 'Deletion must commit');
    assert.strictEqual(fs.existsSync(doomed), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
