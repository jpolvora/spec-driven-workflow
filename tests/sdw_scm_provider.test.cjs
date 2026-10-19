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
    let jsonOutput = '';
    const origLog = console.log;
    console.log = (msg) => { jsonOutput += msg + '\n'; };
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
      console.log = origLog;
    }
    assert.ok(jsonOutput.includes('"scm_provider_status"'));
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
      command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(\'scm-task.txt\', \'done\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'scm-task.txt\'], summary: \'done\' }));"'
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

test('sdw-scm-provider - failed PR list does not create duplicate PR on GitHub or Azure DevOps', async () => {
  // GitHub failure on pr list
  const ghFailingListProvider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh pr list')) {
        throw new Error('network timeout on gh pr list');
      }
      return 'https://github.com/org/repo/pull/123';
    }
  });

  await assert.rejects(
    async () => {
      await ghFailingListProvider.createPullRequest({
        title: 'feat: test',
        head: 'feature/test',
        base: 'master'
      });
    },
    /Unable to verify existing pull request before creation: network timeout on gh pr list/
  );

  // Azure DevOps failure on pr list
  const adoFailingListProvider = createScmProvider('ado', {
    executor: (cmd) => {
      if (cmd.includes('az repos pr list')) {
        throw new Error('az repos pr list rate limited');
      }
      return JSON.stringify({ pullRequestId: 999 });
    }
  });

  await assert.rejects(
    async () => {
      await adoFailingListProvider.createPullRequest({
        title: 'feat: test ado',
        head: 'feature/test-ado',
        base: 'master'
      });
    },
    /Unable to verify existing pull request before creation: az repos pr list rate limited/
  );
});

test('sdw-scm-provider - GitHubProvider.queryWorkItems maps issues to work items', async () => {
  const provider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh issue list')) {
        return JSON.stringify([
          {
            number: 42,
            title: 'Implement OAuth token refresh',
            body: 'Detailed spec.\n\n## Acceptance Criteria\n- AC1: The system shall refresh expired tokens.\n- AC2: When token invalid, the system shall logout.',
            url: 'https://github.com/org/repo/issues/42',
            state: 'OPEN',
            labels: [{ name: 'security' }, { name: 'auth' }]
          }
        ]);
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  const items = await provider.queryWorkItems({ state: 'open', limit: 10 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, '42');
  assert.strictEqual(items[0].title, 'Implement OAuth token refresh');
  assert.strictEqual(items[0].source, 'github');
  assert.strictEqual(items[0].state, 'open');
  assert.deepStrictEqual(items[0].tags, ['security', 'auth']);
  assert.strictEqual(items[0].acceptanceCriteria.length, 2);
  assert.ok(items[0].acceptanceCriteria[0].includes('refresh expired tokens'));
});

test('sdw-scm-provider - AzureDevOpsProvider.fetchWorkItem converts HTML and extracts ACs', async () => {
  const provider = createScmProvider('ado', {
    executor: (cmd) => {
      if (cmd.includes('az boards work-item show')) {
        return JSON.stringify({
          id: 555,
          fields: {
            'System.Title': 'Implement User Session Management',
            'System.Description': '<p>This is HTML formatted description with &amp; entity.</p>',
            'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>The system shall validate active session cookies.</li><li>When session expired, the system shall redirect to login.</li></ul>',
            'System.State': 'Active',
            'System.Tags': 'core; security'
          }
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  const item = await provider.fetchWorkItem('555');
  assert.strictEqual(item.id, '555');
  assert.strictEqual(item.source, 'azure-devops');
  assert.strictEqual(item.title, 'Implement User Session Management');
  assert.ok(item.description.includes('This is HTML formatted description with & entity.'));
  assert.strictEqual(item.state, 'active');
  assert.deepStrictEqual(item.tags, ['core', 'security']);
  assert.strictEqual(item.acceptanceCriteria.length, 2);
  assert.strictEqual(item.acceptanceCriteria[0], 'The system shall validate active session cookies.');
  assert.strictEqual(item.acceptanceCriteria[1], 'When session expired, the system shall redirect to login.');
});

test('sdw-scm-provider - AzureDevOpsProvider.queryWorkItems executes WIQL and maps items', async () => {
  const provider = createScmProvider('ado', {
    executor: (cmd) => {
      if (cmd.includes('az boards query')) {
        return JSON.stringify([{ id: 888 }]);
      }
      if (cmd.includes('az boards work-item show --id 888')) {
        return JSON.stringify({
          id: 888,
          fields: {
            'System.Title': 'Query Work Item Title',
            'System.Description': 'Simple text description',
            'Microsoft.VSTS.Common.AcceptanceCriteria': '- AC1: The system shall query work items.',
            'System.State': 'New',
            'System.Tags': 'backend'
          }
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  const items = await provider.queryWorkItems({ state: 'new' });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, '888');
  assert.strictEqual(items[0].source, 'azure-devops');
  assert.strictEqual(items[0].title, 'Query Work Item Title');
  assert.strictEqual(items[0].state, 'new');
  assert.deepStrictEqual(items[0].tags, ['backend']);
  assert.strictEqual(items[0].acceptanceCriteria.length, 1);
});

test('sdw-scm-provider - GitHubProvider.queryWorkItems maps issues and tags', async () => {
  const provider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh issue list')) {
        return JSON.stringify([{
          number: 77,
          title: 'Issue 77',
          body: '- AC1: The system shall work properly.',
          url: 'https://github.com/issues/77',
          state: 'OPEN',
          labels: [{ name: 'bug' }, { name: 'triage' }]
        }]);
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  const items = await provider.queryWorkItems({ state: 'open', limit: 5 });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, '77');
  assert.strictEqual(items[0].source, 'github');
  assert.deepStrictEqual(items[0].tags, ['bug', 'triage']);
  assert.strictEqual(items[0].acceptanceCriteria.length, 1);
});

test('sdw-scm-provider - createPullRequest aborts and throws on failed PR list (GitHub and ADO)', async () => {
  const ghProvider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh pr list')) {
        throw new Error('API rate limit exceeded');
      }
      return '';
    }
  });

  await assert.rejects(
    () => ghProvider.createPullRequest({ title: 'test', head: 'feat' }),
    /Unable to verify existing pull request before creation/
  );

  const adoProvider = createScmProvider('ado', {
    executor: (cmd) => {
      if (cmd.includes('az repos pr list')) {
        throw new Error('Connection timeout');
      }
      return '';
    }
  });

  await assert.rejects(
    () => adoProvider.createPullRequest({ title: 'test', head: 'feat' }),
    /Unable to verify existing pull request before creation/
  );
});

test('sdw-scm-provider - fetchWorkItem rejects non-numeric IDs for shell safety', async () => {
  const ghProvider = createScmProvider('github', { executor: () => '' });
  await assert.rejects(
    () => ghProvider.fetchWorkItem('123; rm -rf /'),
    /Item identifier must be a valid numeric ID/
  );

  const adoProvider = createScmProvider('ado', { executor: () => '' });
  await assert.rejects(
    () => adoProvider.fetchWorkItem('`malicious`'),
    /Item identifier must be a valid numeric ID/
  );
});




test('sdw-scm-provider - cancelled checks are not treated as passing', async () => {
  const provider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh pr checks')) {
        return JSON.stringify([
          { name: 'ci/build', state: 'SUCCESS', bucket: 'pass' },
          { name: 'ci/test', state: 'CANCELLED', bucket: 'cancel' }
        ]);
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  const status = await provider.checkPrStatus(42);
  assert.strictEqual(status.failedCount, 1, 'Cancelled check must count as failed');
  assert.strictEqual(status.allPassed, false, 'A cancelled check must not allow allPassed');
});

test('sdw-scm-provider - Azure createPullRequest passes description inline instead of @file', async () => {
  let createCommand = '';
  const provider = createScmProvider('ado', {
    executor: (cmd) => {
      if (cmd.includes('az repos pr list')) return JSON.stringify([]);
      if (cmd.includes('az repos pr create')) {
        createCommand = cmd;
        return JSON.stringify({ pullRequestId: 77, url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/77' });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  await provider.createPullRequest({
    title: 'feat: inline body',
    body: 'Line one\nLine two',
    head: 'feature/inline',
    base: 'master'
  });

  assert.ok(createCommand.includes('--description "Line one" "Line two"'), 'Body lines must be passed inline');
  assert.ok(!createCommand.includes('@'), 'Description must not use the unsupported @file form');
});

test('sdw-scm-provider - GitHub checkPrStatus treats no checks as not passed', async () => {
  const provider = createScmProvider('github', {
    executor: () => {
      const err = new Error('no checks reported on the develop branch');
      err.stderr = 'no checks reported on the develop branch';
      throw err;
    }
  });

  const status = await provider.checkPrStatus(42);
  assert.deepStrictEqual(status.checks, []);
  assert.strictEqual(status.allPassed, false);
  assert.strictEqual(status.completed, false);
});

test('sdw-scm-provider - GitHub REST fallback does not treat resolution markers as resolved', async () => {
  const provider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh repo view')) {
        return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
      }
      if (cmd.includes('gh api graphql')) {
        throw new Error('graphql unavailable');
      }
      if (cmd.includes('/comments')) {
        return JSON.stringify([
          {
            id: 1,
            in_reply_to_id: null,
            body: '<!-- resolution-reply -->\nResolved review issue',
            path: 'src/index.js',
            line: 10,
            user: { login: 'reviewer' },
            created_at: '2026-10-19T00:00:00Z'
          }
        ]);
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  const result = await provider.listReviewThreads(42);
  assert.strictEqual(result.activeCount, 1, 'A REST marker must not resolve a GitHub thread');
  assert.strictEqual(result.threads[0].isResolved, false);
});

test('sdw-scm-provider - GitHub REST resolveReviewThread reports unresolved', async () => {
  const provider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('/replies')) return '{}';
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  const result = await provider.resolveReviewThread({
    prNumber: 42,
    threadId: '123',
    comment: 'fixed'
  });

  assert.strictEqual(result.resolved, false);
  assert.match(result.reason, /PRRT_/);
});

test('sdw-scm-provider - ADO active thread with a resolution marker stays active', async () => {
  const provider = createScmProvider('ado', {
    executor: (cmd) => {
      if (cmd.includes('pullRequestThreads')) {
        return JSON.stringify({
          value: [
            {
              id: 101,
              status: 'active',
              comments: [
                { id: 1, content: '<!-- resolution-reply -->\nResolved review issue', author: { displayName: 'reviewer' } }
              ]
            }
          ]
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  const result = await provider.listReviewThreads(42);
  assert.strictEqual(result.activeCount, 1);
  assert.strictEqual(result.threads[0].isResolved, false);
});
