'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

const sandbox = require('../skills/sdw-orch/scripts/sandbox.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const implementationRunner = require('../skills/sdw-orch/scripts/implementation_runner.cjs');
const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');

function createRepo(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sandbox-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  fs.mkdirSync(path.join(dir, '.sdw', 'specs'), { recursive: true });
  if (options.spec !== false) {
    fs.writeFileSync(path.join(dir, '.sdw', 'specs', '001-demo.md'), '# Specification — Demo\n');
  }
  execSync('git add -A', { cwd: dir });
  execSync('git commit -qm "init"', { cwd: dir });
  return dir;
}

function removeRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {}
}

test('AC6-AC8: sandbox creates a local clone on a throwaway branch without origin', () => {
  const dir = createRepo();
  try {
    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-1', slug: 'demo' });
    assert.equal(meta.branch, 'sdw-sandbox/run-1');
    assert.equal(meta.root, '.sdw/sandbox/run-1/repo');
    assert.ok(fs.existsSync(meta.absoluteRoot), 'clone exists');
    assert.ok(fs.statSync(path.join(meta.absoluteRoot, '.git')).isDirectory(), 'clone has its own .git directory');
    assert.equal(execSync('git rev-parse --abbrev-ref HEAD', { cwd: meta.absoluteRoot, encoding: 'utf8' }).trim(), 'sdw-sandbox/run-1');
    assert.throws(() => execSync('git remote get-url origin', { cwd: meta.absoluteRoot, stdio: 'pipe' }), 'origin removed');
    assert.ok(fs.existsSync(path.join(meta.absoluteRoot, '.sdw', 'sandbox', '.sandbox-marker.json')), 'marker written');
    assert.ok(fs.existsSync(path.join(meta.absoluteRoot, '.git', 'shallow')), 'clone is shallow');
    assert.equal(execSync('git rev-list --count HEAD', { cwd: meta.absoluteRoot, encoding: 'utf8' }).trim(), '1', 'one commit in shallow clone');
    assert.equal(meta.clone.singleBranch, true);
    assert.equal(meta.clone.depth, 1);
    const stored = sandbox.readMetadata(dir, 'run-1');
    assert.equal(stored.branch, 'sdw-sandbox/run-1');
    assert.equal(stored.baseCommit.length >= 7, true);
  } finally {
    removeRepo(dir);
  }
});

test('AC34: only the source branch is cloned (single-branch)', () => {
  const dir = createRepo();
  try {
    const originalBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    execSync('git switch -qc feature', { cwd: dir });
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature\n');
    execSync('git add -A && git commit -qm "feature"', { cwd: dir });
    execSync(`git switch -q ${originalBranch}`, { cwd: dir });

    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-single' });
    const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: meta.absoluteRoot, encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.ok(!branches.includes('feature'), 'other branches are not cloned');
    assert.equal(meta.clone.sourceBranch, originalBranch);
    assert.equal(meta.clone.fallback, false);
  } finally {
    removeRepo(dir);
  }
});

test('AC35: detached HEAD is cloned at the exact commit', () => {
  const dir = createRepo();
  try {
    execSync('git checkout -q --detach', { cwd: dir });
    const sha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-detached' });
    assert.equal(execSync('git rev-parse HEAD', { cwd: meta.absoluteRoot, encoding: 'utf8' }).trim(), sha, 'clone head matches detached head');
    assert.equal(execSync('git rev-parse --abbrev-ref HEAD', { cwd: meta.absoluteRoot, encoding: 'utf8' }).trim(), meta.branch);
    assert.ok(fs.existsSync(path.join(meta.absoluteRoot, '.git', 'shallow')), 'detached clone is shallow');
  } finally {
    removeRepo(dir);
  }
});

test('AC36-AC38: sandboxDir config is token-resolved and honored everywhere', () => {
  const dir = createRepo();
  const unique = `sdw-sbx-${process.pid}-${Date.now()}`;
  const expectedRoot = path.join(os.tmpdir(), unique);
  try {
    fs.mkdirSync(path.join(dir, '.sdw'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sdw', 'config.json'), JSON.stringify({
      specsDir: '{projectRoot}/.sdw/specs',
      sandboxDir: `{temp}/${unique}`
    }, null, 2));

    const config = sdwConfig.loadConfig(dir);
    assert.equal(sandbox.normalizePath(config.sandboxDir), sandbox.normalizePath(expectedRoot), '{temp} token resolved');
    assert.equal(
      sandbox.normalizePath(sdwConfig.resolveSandboxPath(dir, `{temp}/${unique}`)),
      sandbox.normalizePath(expectedRoot),
      'resolver expands {temp}'
    );

    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-custom', sandboxDir: config.sandboxDir });
    assert.equal(sandbox.normalizePath(meta.absoluteRoot), sandbox.normalizePath(path.join(expectedRoot, 'run-custom', 'repo')));
    assert.equal(sandbox.normalizePath(meta.sandboxDir), sandbox.normalizePath(expectedRoot));
    assert.ok(fs.existsSync(meta.absoluteRoot), 'clone created under the configured root');

    const listed = sandbox.listSandboxes(dir, config.sandboxDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].runId, 'run-custom');

    const report = sandbox.writeReport(dir, 'run-custom', config.sandboxDir);
    assert.ok(fs.existsSync(report.reportPath), 'report written under the configured root');

    sandbox.cleanSandbox(dir, 'run-custom', config.sandboxDir);
    assert.equal(fs.existsSync(meta.absoluteRoot), false, 'clone removed from the configured root');
    assert.ok(fs.existsSync(report.reportPath), 'report kept under the configured root');
  } finally {
    removeRepo(dir);
    removeRepo(expectedRoot);
  }
});

test('AC39: a custom sandboxDir inside the project root is rejected', () => {
  const dir = createRepo();
  try {
    const inside = path.join(dir, 'build', 'sbx');
    assert.throws(() => sdwConfig.resolveSandboxPath(dir, '{projectRoot}/build/sbx'), /outside the project root/);
    assert.throws(() => sdwConfig.resolveSandboxPath(dir, '{projectRoot}'), /outside the project root/);
    assert.throws(() => sandbox.createSandbox({ sourceRoot: dir, runId: 'run-inside', sandboxDir: inside }), /outside the project root/);
    assert.equal(fs.existsSync(path.join(dir, 'build')), false, 'no in-project sandbox tree created');
    assert.equal(
      sandbox.normalizePath(sdwConfig.resolveSandboxPath(dir, undefined)),
      sandbox.normalizePath(path.join(dir, '.sdw', 'sandbox')),
      'default location stays inside the project'
    );
  } finally {
    removeRepo(dir);
  }
});

test('AC40: an existing sandbox target halts creation with the cleanup command', () => {
  const dir = createRepo();
  try {
    sandbox.createSandbox({ sourceRoot: dir, runId: 'run-dup' });
    assert.throws(
      () => sandbox.createSandbox({ sourceRoot: dir, runId: 'run-dup' }),
      (err) => /already exists/.test(err.message) && /sandbox clean --run-id run-dup/.test(err.message)
    );
  } finally {
    removeRepo(dir);
  }
});

test('AC41: clean removes an orphaned sandbox directory without metadata', () => {
  const dir = createRepo();
  try {
    const orphan = sandbox.getSandboxDir(dir, 'run-orphan');
    fs.mkdirSync(path.join(orphan, 'repo'), { recursive: true });
    fs.writeFileSync(path.join(orphan, 'repo', 'leftover.txt'), 'x');
    const result = sandbox.cleanSandbox(dir, 'run-orphan');
    assert.equal(result.orphan, true);
    assert.equal(fs.existsSync(orphan), false, 'orphan directory removed');
  } finally {
    removeRepo(dir);
  }
});

test('AC9: dirty source is warned and recorded in metadata', () => {
  const dir = createRepo();
  try {
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted');
    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-dirty' });
    assert.equal(meta.baselineDirty, true);
    assert.equal(sandbox.readMetadata(dir, 'run-dirty').baselineDirty, true);
  } finally {
    removeRepo(dir);
  }
});

test('AC33: an uncommitted specification is copied into the clone', () => {
  const dir = createRepo();
  try {
    fs.writeFileSync(path.join(dir, '.sdw', 'specs', '002-untracked.md'), '# Specification — Untracked\n');
    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-spec', specPath: '.sdw/specs/002-untracked.md' });
    assert.equal(meta.specCopied, true);
    assert.ok(fs.existsSync(path.join(meta.absoluteRoot, '.sdw', 'specs', '002-untracked.md')), 'spec copied into clone');
  } finally {
    removeRepo(dir);
  }
});

test('AC15: node_modules is linked into the clone when present', () => {
  const dir = createRepo();
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-modules' });
    assert.equal(meta.nodeModulesLinked, true);
    assert.ok(fs.existsSync(path.join(meta.absoluteRoot, 'node_modules', 'pkg', 'index.js')), 'linked module readable');
  } finally {
    removeRepo(dir);
  }
});

test('AC10: nested sandbox execution is rejected', () => {
  const dir = createRepo();
  try {
    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-nested' });
    assert.throws(() => sandbox.createSandbox({ sourceRoot: meta.absoluteRoot, runId: 'run-nested-2' }), /Nested sandbox/);
  } finally {
    removeRepo(dir);
  }
});

test('AC5: sandbox requires a git repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sandbox-nogit-'));
  try {
    assert.throws(() => sandbox.createSandbox({ sourceRoot: dir, runId: 'run-nogit' }), /requires a git repository/);
  } finally {
    removeRepo(dir);
  }
});

test('AC19-AC20: report captures steps, tasks, errors, and git facts', () => {
  const dir = createRepo();
  try {
    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-report' });
    const stateDir = path.join(meta.absoluteRoot, '.sdw', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'run-report.state.json'), JSON.stringify({
      runId: 'run-report',
      status: 'paused',
      totalSteps: 8,
      steps: {
        1: { name: 'derivation', status: 'completed', startedAt: 'a', completedAt: 'b', artifact: 'step-1.md' },
        4: {
          name: 'implementation',
          status: 'awaiting_implementation',
          tasks: { 'task-1': { title: 'Core', status: 'dispatched', acIds: ['AC1'], filesChanged: ['a.js'] } },
          gates: { tests: { status: 'pending' } }
        }
      },
      errors: [{ step: 3, error: 'dag exploded' }]
    }, null, 2));
    fs.writeFileSync(path.join(meta.absoluteRoot, 'a.js'), 'console.log(1);\n');
    execSync('git add -A', { cwd: meta.absoluteRoot });
    execSync('git commit -qm "delivery"', { cwd: meta.absoluteRoot });

    const result = sandbox.writeReport(dir, 'run-report');
    const report = fs.readFileSync(result.reportPath, 'utf8');
    assert.match(report, /Sandbox Run Report — run-report/);
    assert.match(report, /## Steps/);
    assert.match(report, /derivation \| completed/);
    assert.match(report, /## Tasks/);
    assert.match(report, /task-1 \| Core \| dispatched/);
    assert.match(report, /dag exploded/);
    assert.match(report, /delivery/);
    assert.match(report, /sandbox clean --run-id run-report/);
  } finally {
    removeRepo(dir);
  }
});

test('AC21-AC24: list, clean, and unknown ids', () => {
  const dir = createRepo();
  try {
    const meta = sandbox.createSandbox({ sourceRoot: dir, runId: 'run-clean' });
    assert.equal(sandbox.listSandboxes(dir).length, 1);
    assert.equal(sandbox.listSandboxes(dir)[0].runId, 'run-clean');

    const cleaned = sandbox.cleanSandbox(dir, 'run-clean');
    assert.equal(cleaned.status, 'cleaned');
    assert.equal(fs.existsSync(meta.absoluteRoot), false, 'clone removed');
    assert.ok(fs.existsSync(sandbox.getReportPath(dir, 'run-clean')), 'report kept');
    assert.throws(() => sandbox.cleanSandbox(dir, 'missing'), /Unknown sandbox run id/);
    assert.throws(() => sandbox.writeReport(dir, 'missing'), /Unknown sandbox run id/);
  } finally {
    removeRepo(dir);
  }
});

test('AC4/AC32: conflicting --dry-run/--sandbox and --sandbox/--push are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-conflict-'));
  try {
    const dry = sdwOrch.cmdRun({ subcommand: 'run', specPath: 'x.md', root: dir, dryRun: true, sandbox: true });
    assert.equal(dry, 1);
    const push = sdwOrch.cmdRun({ subcommand: 'run', specPath: 'x.md', root: dir, sandbox: true, push: true });
    assert.equal(push, 1);
    assert.equal(fs.existsSync(path.join(dir, '.sdw', 'sandbox')), false, 'no sandbox created on conflict');
  } finally {
    removeRepo(dir);
  }
});

test('AC31: batch execution rejects --sandbox', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-'));
  try {
    const code = sdwOrch.cmdBatchRun({ subcommand: 'run', specPaths: ['a.md'], root: dir, sandbox: true });
    assert.equal(code, 1);
  } finally {
    removeRepo(dir);
  }
});

test('AC1-AC3: plan-only dry run prints the plan and returns 0', () => {
  const root = path.resolve(__dirname, '..');
  const spec = path.join(root, '.sdw', 'specs', '029-sdw-orch-sandboxed-execution.md');
  const code = sdwOrch.printRunDryRunPlan({
    targetRoot: root,
    resolvedSpec: spec,
    specSlug: '029-sdw-orch-sandboxed-execution',
    config: { scoreMin: 8, pushDelivery: true, scmProvider: 'github' },
    options: {}
  });
  assert.equal(code, 0);
});

test('AC42: dry run fails closed when the validator cannot run', () => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-plan-'));
  try {
    const missing = path.join(dir, 'missing-spec.md');
    const code = sdwOrch.printRunDryRunPlan({
      targetRoot: root,
      resolvedSpec: missing,
      specSlug: 'missing',
      config: {},
      options: {}
    });
    assert.equal(code, 1);
  } finally {
    removeRepo(dir);
  }
});

test('AC16: sandbox prompts carry absolute working directory and evidence path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-prompt-'));
  try {
    const rendered = implementationRunner.renderTaskPrompt({
      targetRoot: dir,
      specSlug: 'demo',
      runId: 'run-prompt',
      task: { id: 'task-1', title: 'Core', coveredAcs: ['AC1'] },
      specAcs: [{ id: 'AC1', text: 'The system shall work.' }],
      absolutePaths: true
    });
    const prompt = fs.readFileSync(rendered.promptFileAbs, 'utf8');
    assert.ok(prompt.includes(`**Working Directory:** \`${sandbox.normalizePath(dir)}\``), 'absolute working directory');
    assert.ok(prompt.includes(`--evidence "${sandbox.normalizePath(rendered.evidenceFileAbs)}"`), 'quoted absolute evidence');
    assert.ok(prompt.includes(`--root "${sandbox.normalizePath(dir)}"`), 'root flag present');

    const relative = implementationRunner.renderTaskPrompt({
      targetRoot: dir,
      specSlug: 'demo',
      runId: 'run-prompt-rel',
      task: { id: 'task-2', title: 'Core', coveredAcs: ['AC1'] },
      specAcs: [{ id: 'AC1', text: 'The system shall work.' }]
    });
    const relPrompt = fs.readFileSync(relative.promptFileAbs, 'utf8');
    assert.ok(relPrompt.includes('**Working Directory:** `.`'), 'relative mode unchanged');
    assert.ok(!relPrompt.includes('--root "'), 'no root flag outside sandbox');
  } finally {
    removeRepo(dir);
  }
});
