'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwShipPr = require('../skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs');
const codeReview = require('../skills/sdw-code-review/scripts/sdw_code_review.cjs');

function git(dir, args) {
  return execSync(`git ${args}`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function realExecutor(repo) {
  return (cmd) => execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sync-repo-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sync-remote-'));
  git(repo, 'init');
  git(repo, 'config user.name "SDW Tester"');
  git(repo, 'config user.email "tester@sdw.org"');
  git(remote, 'init --bare');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.sdw/state/\n.sdw/worktrees/\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8');
  git(repo, 'add -A');
  git(repo, 'commit -m "initial commit"');
  const defaultBranch = git(repo, 'rev-parse --abbrev-ref HEAD');
  if (defaultBranch !== 'main') git(repo, `branch -m ${defaultBranch} main`);
  git(repo, `remote add origin "${remote.replace(/\\/g, '/')}"`);
  git(repo, 'push -u origin main');
  return { repo, remote };
}

function removeRepo(repo, remote) {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
}

function publishDevelopAhead(repo) {
  // Origin has a develop commit the local branch does not have yet.
  git(repo, 'switch -c develop');
  fs.writeFileSync(path.join(repo, 'develop.txt'), 'develop work\n', 'utf8');
  git(repo, 'add -A');
  git(repo, 'commit -m "develop work"');
  git(repo, 'push -u origin develop');
  const remoteDevelop = git(repo, 'rev-parse origin/develop');
  git(repo, 'reset --hard HEAD~1');
  return remoteDevelop;
}

test('sdw-branch-sync - AC11: code review base comes from branching.integrationBranch', () => {
  const { repo, remote } = setupRepo();
  try {
    git(repo, 'switch -c develop');
    git(repo, 'switch main');
    fs.mkdirSync(path.join(repo, '.sdw'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.sdw', 'config.json'), JSON.stringify({
      baseBranch: 'main',
      branching: { strategy: 'gitflow', workBranch: 'develop', integrationBranch: 'develop' }
    }, null, 2), 'utf8');

    const resolved = codeReview.resolveBaseRef({ projectRoot: repo });
    assert.strictEqual(resolved.base, 'develop');
    assert.strictEqual(resolved.source, 'branching');

    const explicit = codeReview.resolveBaseRef({ projectRoot: repo, base: 'main' });
    assert.strictEqual(explicit.base, 'main');
    assert.strictEqual(explicit.source, 'explicit');
  } finally {
    removeRepo(repo, remote);
  }
});

test('sdw-branch-sync - AC11: sdw-ship-pr pull request base comes from branching.integrationBranch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sync-base-'));
  try {
    const config = {
      scmProvider: 'none',
      pushDelivery: false,
      scmCodeReviewEnabled: false,
      branching: { strategy: 'gitflow', workBranch: 'develop', integrationBranch: 'develop' }
    };
    const report = await sdwShipPr.runShipPr({ projectRoot: tmpDir, config, head: 'feature/sync' });
    assert.strictEqual(report.base, 'develop', 'PR base must be the integration lane');
    assert.strictEqual(report.success, true);

    const explicit = await sdwShipPr.runShipPr({ projectRoot: tmpDir, config, head: 'feature/sync', base: 'release' });
    assert.strictEqual(explicit.base, 'release', '--base keeps priority');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-branch-sync - AC12: same-lane post-merge fast-forward advances the work branch', () => {
  const { repo, remote } = setupRepo();
  try {
    const remoteDevelop = publishDevelopAhead(repo);
    git(repo, 'switch -c feature/sync');

    const result = sdwShipPr.syncWorkBranchAfterMerge({
      executor: realExecutor(repo),
      branching: {
        strategy: 'gitflow',
        workBranch: 'develop',
        integrationBranch: 'develop',
        syncWorkBranchAfterMerge: true,
        pushSyncedWorkBranch: false
      },
      integrationBranch: 'develop'
    });

    assert.strictEqual(result.status, 'synced');
    assert.strictEqual(result.workBranch, 'develop');
    assert.strictEqual(result.integrationBranch, 'develop');
    assert.strictEqual(result.reason, null);
    assert.ok(result.at, 'Sync records a timestamp');
    assert.strictEqual(git(repo, 'rev-parse --abbrev-ref HEAD'), 'develop');
    assert.strictEqual(git(repo, 'rev-parse develop'), remoteDevelop);
  } finally {
    removeRepo(repo, remote);
  }
});

test('sdw-branch-sync - AC12: cross-lane post-merge fast-forward and push', () => {
  const { repo, remote } = setupRepo();
  try {
    git(repo, 'switch -c develop');
    git(repo, 'push -u origin develop');
    git(repo, 'switch main');
    fs.writeFileSync(path.join(repo, 'main.txt'), 'production change\n', 'utf8');
    git(repo, 'add -A');
    git(repo, 'commit -m "main promotion"');
    git(repo, 'push origin main');
    const mainHead = git(repo, 'rev-parse main');
    git(repo, 'switch -c feature/sync');

    const result = sdwShipPr.syncWorkBranchAfterMerge({
      executor: realExecutor(repo),
      branching: {
        strategy: 'develop',
        workBranch: 'develop',
        integrationBranch: 'main',
        syncWorkBranchAfterMerge: true,
        pushSyncedWorkBranch: true
      },
      integrationBranch: 'main'
    });

    assert.strictEqual(result.status, 'synced');
    assert.strictEqual(git(repo, 'rev-parse --abbrev-ref HEAD'), 'develop');
    assert.strictEqual(git(repo, 'rev-parse develop'), mainHead);
    assert.strictEqual(git(repo, 'rev-parse origin/develop'), mainHead, 'Synced work branch is pushed');
  } finally {
    removeRepo(repo, remote);
  }
});

test('sdw-branch-sync - AC13: dirty working tree blocks without touching any branch', () => {
  const { repo, remote } = setupRepo();
  try {
    publishDevelopAhead(repo);
    git(repo, 'switch -c feature/sync');
    const featureHead = git(repo, 'rev-parse HEAD');
    const developHead = git(repo, 'rev-parse develop');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted\n', 'utf8');

    const result = sdwShipPr.syncWorkBranchAfterMerge({
      executor: realExecutor(repo),
      branching: { strategy: 'gitflow', workBranch: 'develop', integrationBranch: 'develop', syncWorkBranchAfterMerge: true },
      integrationBranch: 'develop'
    });

    assert.strictEqual(result.status, 'blocked');
    assert.match(result.reason, /dirty/);
    assert.strictEqual(git(repo, 'rev-parse --abbrev-ref HEAD'), 'feature/sync');
    assert.strictEqual(git(repo, 'rev-parse HEAD'), featureHead);
    assert.strictEqual(git(repo, 'rev-parse develop'), developHead, 'Work branch must not move');
  } finally {
    removeRepo(repo, remote);
  }
});

test('sdw-branch-sync - AC13: a diverged work branch blocks, switches back, and reports remediation', () => {
  const { repo, remote } = setupRepo();
  try {
    git(repo, 'switch -c develop');
    fs.writeFileSync(path.join(repo, 'remote.txt'), 'remote work\n', 'utf8');
    git(repo, 'add -A');
    git(repo, 'commit -m "remote develop work"');
    git(repo, 'push -u origin develop');
    git(repo, 'reset --hard HEAD~1');
    fs.writeFileSync(path.join(repo, 'local.txt'), 'local work\n', 'utf8');
    git(repo, 'add -A');
    git(repo, 'commit -m "local develop work"');
    git(repo, 'switch -c feature/sync');
    const featureHead = git(repo, 'rev-parse HEAD');
    const developHead = git(repo, 'rev-parse develop');

    const result = sdwShipPr.syncWorkBranchAfterMerge({
      executor: realExecutor(repo),
      branching: { strategy: 'gitflow', workBranch: 'develop', integrationBranch: 'develop', syncWorkBranchAfterMerge: true },
      integrationBranch: 'develop'
    });

    assert.strictEqual(result.status, 'blocked');
    assert.match(result.reason, /fast-forward/);
    assert.match(result.reason, /git switch develop/);
    assert.strictEqual(git(repo, 'rev-parse --abbrev-ref HEAD'), 'feature/sync', 'Returns to the original branch');
    assert.strictEqual(git(repo, 'rev-parse HEAD'), featureHead);
    assert.strictEqual(git(repo, 'rev-parse develop'), developHead, 'Diverged work branch is never rewritten');
  } finally {
    removeRepo(repo, remote);
  }
});

test('sdw-branch-sync - AC12/AC14: sdw-ship-pr records the sync outcome in run state after MERGED', async () => {
  const { repo, remote } = setupRepo();
  const stateFile = path.join(repo, '.sdw', 'state', 'run-sync.state.json');
  try {
    const remoteDevelop = publishDevelopAhead(repo);
    git(repo, 'switch -c feature/sync');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ runId: 'run-sync', steps: {} }, null, 2), 'utf8');

    const executor = (cmd) => {
      if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
      if (cmd.includes('gh auth status')) return 'Logged in';
      if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'fake' }, name: 'repo' });
      if (cmd.includes('gh pr list')) {
        return JSON.stringify([{ number: 42, url: 'https://example.test/pull/42', headRefName: 'feature/sync', baseRefName: 'develop' }]);
      }
      if (cmd.includes('gh pr view') && cmd.includes('--json state')) return 'MERGED';
      if (cmd.includes('gh pr view')) return JSON.stringify({ body: '' });
      if (cmd.includes('pr checks')) return JSON.stringify([{ name: 'ci/build', state: 'pass', bucket: 'pass' }]);
      if (cmd.includes('--input')) {
        const match = cmd.match(/--input\s+"([^"]+)"/);
        if (match && fs.existsSync(match[1])) {
          const payload = fs.readFileSync(match[1], 'utf8');
          if (payload.includes('reviewThreads')) {
            return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
          }
        }
        return '{}';
      }
      if (cmd.includes('gh pr merge')) return '';
      if (/^(gh|az)\b/.test(cmd)) return '';
      return execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    };

    const config = {
      scmProvider: 'github',
      scmCodeReviewEnabled: true,
      pushDelivery: false,
      branching: {
        strategy: 'gitflow',
        workBranch: 'develop',
        integrationBranch: 'develop',
        updateWorkBranch: true,
        syncWorkBranchAfterMerge: true,
        pushSyncedWorkBranch: false
      }
    };

    const report = await sdwShipPr.runShipPr({
      projectRoot: repo,
      config,
      head: 'feature/sync',
      runId: 'run-sync',
      merge: true,
      maxIterations: 1,
      pollIntervalMs: 0
    }, executor);

    assert.strictEqual(report.base, 'develop');
    assert.strictEqual(report.merge.ok, true);
    assert.strictEqual(report.success, true, 'Delivery remains successful');
    assert.strictEqual(report.branchingSync.status, 'synced');
    assert.strictEqual(git(repo, 'rev-parse --abbrev-ref HEAD'), 'develop');
    assert.strictEqual(git(repo, 'rev-parse develop'), remoteDevelop);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(state.branchingSync.status, 'synced');
    assert.strictEqual(state.branchingSync.workBranch, 'develop');
    assert.strictEqual(state.branchingSync.integrationBranch, 'develop');
    assert.ok(state.branchingSync.at);
    assert.strictEqual(state.steps[8].output.branchingSync.status, 'synced');
  } finally {
    removeRepo(repo, remote);
  }
});
