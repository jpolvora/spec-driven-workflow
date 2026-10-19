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
const { resolveScmProvider, checkScmCapability, createScmProvider } = require('../skills/sdw-spec/scripts/scm_provider_contract.cjs');
const { importRemoteSpec } = require('../skills/sdw-spec/scripts/spec_creator.cjs');

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-scm-test-'));
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

test('sdw-scm-provider - AC1, AC2, AC18: scmProvider config schema, default, and validation', () => {
  // AC1: defaults to none
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.scmProvider, 'none');

  // AC18: registered in schema
  const schema = sdwConfig.DEFAULT_SCHEMA;
  assert.ok(schema.properties.scmProvider);
  assert.deepStrictEqual(schema.properties.scmProvider.enum, ['none', 'ado', 'github']);
  assert.strictEqual(schema.properties.scmProvider.default, 'none');

  // Valid values
  const v1 = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', scmProvider: 'none' });
  assert.strictEqual(v1.valid, true);

  const v2 = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', scmProvider: 'ado' });
  assert.strictEqual(v2.valid, true);

  const v3 = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', scmProvider: 'github' });
  assert.strictEqual(v3.valid, true);

  // AC2: Invalid values rejected
  const inv1 = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', scmProvider: 'gitlab' });
  assert.strictEqual(inv1.valid, false);
  assert.ok(inv1.errors.some(e => e.includes('scmProvider')));

  const inv2 = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', scmProvider: 'GitHub' }); // case-sensitive in config
  assert.strictEqual(inv2.valid, false);

  const inv3 = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', scmProvider: 123 });
  assert.strictEqual(inv3.valid, false);
});

test('sdw-scm-provider - AC7, AC8: Provider resolution precedence and explicit argument rejection', () => {
  // Default resolution
  const def = resolveScmProvider();
  assert.strictEqual(def.provider, 'none');
  assert.strictEqual(def.disabled, true);
  assert.strictEqual(def.resolvedFrom, 'default');

  // Config resolution
  const fromCfg = resolveScmProvider({ config: { scmProvider: 'github' } });
  assert.strictEqual(fromCfg.provider, 'github');
  assert.strictEqual(fromCfg.resolvedFrom, 'config');
  assert.strictEqual(fromCfg.disabled, false);

  const fromCfgAdo = resolveScmProvider({ config: { scmProvider: 'ado' } });
  assert.strictEqual(fromCfgAdo.provider, 'ado');

  // Explicit override takes precedence over config
  const explicit = resolveScmProvider({ config: { scmProvider: 'ado' }, explicit: 'github' });
  assert.strictEqual(explicit.provider, 'github');
  assert.strictEqual(explicit.resolvedFrom, 'explicit');

  // Explicit aliases
  assert.strictEqual(resolveScmProvider({ explicit: 'gh' }).provider, 'github');
  assert.strictEqual(resolveScmProvider({ explicit: 'az' }).provider, 'ado');
  assert.strictEqual(resolveScmProvider({ explicit: 'azure-devops' }).provider, 'ado');
  assert.strictEqual(resolveScmProvider({ explicit: 'none' }).provider, 'none');

  // AC8: Invalid explicit value throws actionable error
  assert.throws(() => {
    resolveScmProvider({ explicit: 'gitlab' });
  }, /Invalid SCM provider "gitlab"/);

  assert.throws(() => {
    resolveScmProvider({ explicit: 'bitbucket' });
  }, /Allowed values are 'none', 'ado', 'github'/);
});

test('sdw-scm-provider - AC10, AC11, AC12, AC13: Capability checks for installed and authenticated CLI', () => {
  // Mock executor simulating installed and authenticated gh
  const ghMockExecutor = (cmd) => {
    if (cmd.includes('gh auth status')) return '';
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return 'C:\\bin\\gh.exe';
    throw new Error(`Unexpected command: ${cmd}`);
  };

  const capGh = checkScmCapability('github', { executor: ghMockExecutor });
  assert.strictEqual(capGh.installed, true);
  assert.strictEqual(capGh.authenticated, true);
  assert.strictEqual(capGh.available, true);
  assert.strictEqual(capGh.bin, 'gh');

  // Mock executor simulating uninstalled CLI
  const missingExecutor = () => {
    throw new Error('not found');
  };
  const capMissing = checkScmCapability('github', { executor: missingExecutor });
  assert.strictEqual(capMissing.installed, false);
  assert.strictEqual(capMissing.available, false);
  assert.ok(capMissing.error.includes('not installed'));

  // Mock executor simulating unauthenticated CLI
  const unauthExecutor = (cmd) => {
    if (cmd.includes('where') || cmd.includes('command -v')) return '/usr/bin/az';
    if (cmd.includes('az account show')) throw new Error('Please run az login');
    throw new Error(`Unexpected command: ${cmd}`);
  };
  const capUnauth = checkScmCapability('ado', { executor: unauthExecutor });
  assert.strictEqual(capUnauth.installed, true);
  assert.strictEqual(capUnauth.authenticated, false);
  assert.strictEqual(capUnauth.available, false);
  assert.ok(capUnauth.error.includes('not authenticated'));

  // None provider capability
  const capNone = checkScmCapability('none');
  assert.strictEqual(capNone.provider, 'none');
  assert.strictEqual(capNone.available, false);
  assert.strictEqual(capNone.installed, false);
});

test('sdw-scm-provider - AC3, AC9: Import rejected when scmProvider is none', async () => {
  const tmpDir = setupTestRepo();
  try {
    // Attempt import with none (default)
    await assert.rejects(
      async () => {
        await importRemoteSpec({ root: tmpDir, id: '101' });
      },
      (err) => {
        assert.ok(err.message.includes('SCM import disabled: set scmProvider to "github" or "ado"'));
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-scm-provider - AC4, AC5, AC6: Import routes to configured provider and never other CLI', async () => {
  const tmpDir = setupTestRepo();
  try {
    const executedCommands = [];
    const mockExecutor = (cmd) => {
      executedCommands.push(cmd);
      if (cmd.includes('where gh') || cmd.includes('command -v gh')) return 'gh.exe';
      if (cmd.includes('gh auth status')) return '';
      if (cmd.includes('gh issue view')) {
        return JSON.stringify({
          number: 42,
          title: 'Add OAuth Login',
          body: '## Acceptance Criteria\n- AC1: The system shall login with OAuth.',
          url: 'https://github.com/org/repo/issues/42',
          state: 'OPEN',
          labels: ['security']
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    // Configure github in config.json
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.scmProvider = 'github';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const result = await importRemoteSpec({
      root: tmpDir,
      id: '42',
      executor: mockExecutor,
      scmProvider: createScmProvider('github', { executor: mockExecutor })
    });

    assert.ok(result);
    assert.strictEqual(result.item.id, '42');
    assert.strictEqual(result.item.source, 'github');
    assert.ok(fs.existsSync(result.filePath));

    // AC6: gh was executed, az was NEVER executed
    assert.ok(executedCommands.some(c => c.includes('gh issue view')));
    assert.ok(!executedCommands.some(c => c.includes('az ')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-scm-provider - AC16: sdw-config check reports scmProvider and CLI capability', () => {
  const tmpDir = setupTestRepo();
  try {
    // Default none
    const resNone = sdwConfig.cmdCheck({ root: tmpDir, json: true });
    assert.strictEqual(resNone, 0);

    // Set invalid provider
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.scmProvider = 'invalid_scm';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const resInvalid = sdwConfig.cmdCheck({ root: tmpDir, json: true });
    assert.strictEqual(resInvalid, 1, 'Check must fail on invalid scmProvider');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-scm-provider - AC14, AC15, AC17, AC20: Orchestrator Step 8 skips polling when scmProvider is none and records in state', () => {
  const tmpDir = setupTestRepo();
  try {
    const slug = '001-scm-none-test';
    const specPath = path.join(tmpDir, '.sdw', 'specs', `${slug}.md`);
    fs.writeFileSync(specPath, `---
slug: ${slug}
title: SCM None Test
---
# SCM None Test
## Acceptance Criteria
- AC1: The system shall pass.
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
`, 'utf8');

    // Enable scmCodeReviewEnabled: true, but scmProvider: none
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.scmCodeReviewEnabled = true;
    cfg.scmProvider = 'none';
    cfg.implementation = {
      mode: 'command',
      command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/\' + process.env.SDW_SPEC_SLUG + \'.md\'], summary: \'done\' }));"'
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      runId,
      minScore: 0,
      skipReview: true,
      skipSecurity: true
    });

    assert.strictEqual(code, 0, 'Workflow must complete successfully even when polling skipped');

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.ok(state.scm, 'State must contain scm object');
    assert.strictEqual(state.scm.provider, 'none');
    assert.strictEqual(state.scm.skipped, true);
    assert.strictEqual(state.scm.skipReason, 'scmProvider is set to "none"');

    // Step 8 payload must not have pollEnabled = true
    assert.strictEqual(state.steps[8].output.pollEnabled, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-scm-provider - createPullRequest on GitHubProvider (creation, reuse, and dry-run)', async () => {
  const provider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh pr list')) {
        return JSON.stringify([]);
      }
      if (cmd.includes('gh pr create')) {
        return 'https://github.com/jpolvora/spec-driven-workflow/pull/99\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  // Creation
  const res = await provider.createPullRequest({
    title: 'feat: add new feature',
    body: '## Description\nNew feature details',
    head: 'feature/new-feature',
    base: 'master'
  });
  assert.strictEqual(res.number, '99');
  assert.strictEqual(res.url, 'https://github.com/jpolvora/spec-driven-workflow/pull/99');
  assert.strictEqual(res.reused, false);
  assert.strictEqual(res.dryRun, false);

  // Reuse when PR already exists
  const reuseProvider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh pr list')) {
        return JSON.stringify([{
          number: 101,
          url: 'https://github.com/jpolvora/spec-driven-workflow/pull/101',
          title: 'Existing PR',
          headRefName: 'feature/existing',
          baseRefName: 'master'
        }]);
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });
  const reuseRes = await reuseProvider.createPr({
    title: 'New PR title',
    head: 'feature/existing',
    base: 'master'
  });
  assert.strictEqual(reuseRes.number, '101');
  assert.strictEqual(reuseRes.reused, true);

  // Dry run
  const dryRunRes = await provider.createPullRequest({
    title: 'feat: dry run test',
    head: 'feature/dry-run',
    base: 'master',
    dryRun: true
  });
  assert.strictEqual(dryRunRes.dryRun, true);
  assert.strictEqual(dryRunRes.reused, false);
  assert.ok(dryRunRes.command.includes('gh pr create'));
});

test('sdw-scm-provider - createPullRequest on AzureDevOpsProvider (creation, reuse, and dry-run)', async () => {
  const provider = createScmProvider('ado', {
    executor: (cmd) => {
      if (cmd.includes('az repos pr list')) {
        return JSON.stringify([]);
      }
      if (cmd.includes('az repos pr create')) {
        return JSON.stringify({
          pullRequestId: 202,
          url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/202'
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  // Creation
  const res = await provider.createPullRequest({
    title: 'feat: add ado feature',
    body: 'Details',
    head: 'feature/ado-test',
    base: 'master'
  });
  assert.strictEqual(res.number, '202');
  assert.strictEqual(res.reused, false);
  assert.strictEqual(res.dryRun, false);

  // Reuse when PR exists
  const reuseProvider = createScmProvider('ado', {
    executor: (cmd) => {
      if (cmd.includes('az repos pr list')) {
        return JSON.stringify([{
          pullRequestId: 205,
          url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/205',
          title: 'Existing ADO PR',
          sourceRefName: 'refs/heads/feature/ado-test',
          targetRefName: 'refs/heads/master'
        }]);
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });
  const reuseRes = await reuseProvider.createPr({
    title: 'New title',
    head: 'feature/ado-test',
    base: 'master'
  });
  assert.strictEqual(reuseRes.number, '205');
  assert.strictEqual(reuseRes.reused, true);

  // Dry run
  const dryRunRes = await provider.createPullRequest({
    title: 'feat: ado dry run',
    head: 'feature/ado-test',
    base: 'master',
    dryRun: true
  });
  assert.strictEqual(dryRunRes.dryRun, true);
  assert.strictEqual(dryRunRes.reused, false);
  assert.ok(dryRunRes.command.includes('az repos pr create'));
});

