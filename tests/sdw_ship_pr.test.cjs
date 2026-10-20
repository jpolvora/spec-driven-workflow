const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwShipPr = require('../skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs');
const { createScmProvider } = require('../skills/sdw-spec/scripts/scm_provider_contract.cjs');

function setupTestWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ship-test-'));
  const sdwDir = path.join(tmpDir, '.sdw');
  fs.mkdirSync(sdwDir, { recursive: true });
  fs.mkdirSync(path.join(sdwDir, 'state'), { recursive: true });

  const config = {
    scmProvider: 'none',
    baseBranch: 'master',
    pushDelivery: false,
    scmCodeReviewEnabled: false,
    requiredBuild: false,
    runAllTests: false,
    securityChecksEnabled: false
  };
  fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  return { tmpDir, sdwDir, config };
}

test('sdw-ship-pr - AC8: scmProvider "none" skips remote PR creation cleanly', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master'
    });

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.shipStatus, 'delivered_local');
    assert.strictEqual(report.pullRequest, null);
    assert.strictEqual(report.pushed, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC11: dry-run mode simulates branch push and PR creation without mutations', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.pushDelivery = true;

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'feature/test-branch',
      base: 'master',
      dryRun: true
    });

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.pushed, true);
    assert.ok(report.pullRequest);
    assert.strictEqual(report.pullRequest.dryRun, true);
    assert.strictEqual(report.shipStatus, 'delivered');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC4, AC5: pre-PR gate failure halts execution', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.prePrCommand = 'node -e "process.exit(1)"';

  try {
    await assert.rejects(
      async () => {
        await sdwShipPr.runShipPr({
          projectRoot: tmpDir,
          config,
          head: 'develop'
        });
      },
      /prePrCommand failed/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC16, AC17: Review convergence loop fixes issues, adds summary comment, and resolves thread', async () => {
  const calls = [];
  let threadResolved = false;
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('--input')) {
      const match = cmd.match(/--input\s+"([^"]+)"/);
      if (match && fs.existsSync(match[1])) {
        const fileContent = fs.readFileSync(match[1], 'utf8');
        calls.push(fileContent);
        if (fileContent.includes('resolveReviewThread')) {
          threadResolved = true;
          return JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
        }
        if (fileContent.includes('reviewThreads')) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: 'PRRT_kwTEST123',
                        isResolved: threadResolved,
                        path: 'src/index.js',
                        line: 10,
                        comments: {
                          nodes: [
                            { id: 'PRRC_1', body: 'Missing null check on config object', author: { login: 'reviewer' } }
                          ]
                        }
                      }
                    ]
                  }
                }
              }
            }
          });
        }
      }
    }
    if (cmd.includes('pr checks')) {
      return JSON.stringify([
        { name: 'ci/build', state: 'pass', bucket: 'pass' }
      ]);
    }
    if (cmd.includes('gh repo view')) {
      return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
    }
    if (cmd.includes('gh api graphql') && cmd.includes('reviewThreads')) {
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: 'PRRT_kwTEST123',
                    isResolved: false,
                    path: 'src/index.js',
                    line: 10,
                    comments: {
                      nodes: [
                        { id: 'PRRC_1', body: 'Missing null check on config object', author: { login: 'reviewer' } }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      });
    }
    if (cmd.includes('resolveReviewThread')) {
      return JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
    }
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 42, url: 'https://github.com/fake-owner/fake-repo/pull/42', headRefName: 'develop', baseRefName: 'master' }]);
    }
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) {
      return '/usr/bin/gh';
    }
    if (cmd.includes('gh auth status')) {
      return 'Logged in';
    }
    return '';
  };

  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = true;

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      threadFixer: async () => ({ fixed: true, summary: 'Added the missing null check and verified tests' })
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.reviewConvergence.enabled, true);
    assert.strictEqual(report.reviewConvergence.resolvedThreads, 1);
    assert.strictEqual(report.reviewConvergence.issuesFixed.length, 1);
    assert.ok(report.reviewConvergence.issuesFixed[0].resolution.includes('Resolved review issue'));

    // Verify GraphQL mutation was invoked to reply with summary AND resolve the thread
    const resolveMutation = calls.find(c => c.includes('resolveReviewThread') && c.includes('addPullRequestReviewThreadReply'));
    assert.ok(resolveMutation, 'Should have executed GraphQL mutation to reply and resolve thread');
    assert.ok(resolveMutation.includes('<!-- resolution-reply -->'), 'Must include resolution-reply marker');
    assert.ok(resolveMutation.includes('Summary:'), 'Must include resolution summary describing how issue was solved');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AzureDevOpsProvider resolveReviewThread adds summary comment and patches status to fixed', async () => {
  const commands = [];
  const adoExecutor = (cmd) => {
    commands.push(cmd);
    if (cmd.includes('pullRequestThreads') && cmd.includes('GET')) {
      return JSON.stringify({
        value: [
          {
            id: 101,
            status: 'active',
            comments: [{ id: 1, content: 'Please handle undefined input', author: { displayName: 'Reviewer' } }]
          }
        ]
      });
    }
    return JSON.stringify({ id: 101, status: 'fixed' });
  };

  const provider = createScmProvider('ado', { executor: adoExecutor });
  const result = await provider.resolveReviewThread({
    prNumber: '500',
    threadId: '101',
    comment: 'Added undefined check to avoid TypeError',
    model: 'deepseek-chat'
  });

  assert.strictEqual(result.resolved, true);
  assert.strictEqual(result.threadId, '101');
  assert.ok(result.comment.includes('Added undefined check to avoid TypeError'));
  assert.ok(result.comment.includes('<!-- resolution-reply -->'));
  assert.ok(result.comment.includes('LLM model: deepseek-chat'));

  // Verify POST comment was called
  const commentCall = commands.find(c => c.includes('pullRequestThreadComments') && c.includes('POST'));
  assert.ok(commentCall, 'Must call POST pullRequestThreadComments');

  // Verify PATCH thread status was called
  const patchCall = commands.find(c => c.includes('pullRequestThreads') && c.includes('PATCH'));
  assert.ok(patchCall, 'Must call PATCH pullRequestThreads to set status to fixed');
});

test('sdw-ship-pr - AC14: Router routes PR shipping and review convergence intents to sdw-ship-pr', () => {
  const sdwRouter = require('../skills/sdw-router/scripts/sdw_router.cjs');
  const routeExplicit = sdwRouter.routePrompt('Please run /sdw-ship-pr --dry-run');
  assert.strictEqual(routeExplicit.matched, true);
  assert.strictEqual(routeExplicit.targetSkill, 'sdw-ship-pr');

  const routeKeyword = sdwRouter.routePrompt('Check pre-PR requirements and ship a pull request for develop');
  assert.strictEqual(routeKeyword.matched, true);
  assert.strictEqual(routeKeyword.targetSkill, 'sdw-ship-pr');
});

test('sdw-ship-pr - CLI --json mode produces strictly machine-readable JSON on stdout', () => {
  const scriptPath = path.resolve(__dirname, '../skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs');
  const { execSync } = require('child_process');

  const stdout = execSync(`node "${scriptPath}" --dry-run --json`, {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Must parse as valid JSON directly without throwing
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(stdout);
  }, 'stdout must be strictly parseable JSON with no progress log contamination');

  assert.strictEqual(typeof parsed, 'object');
  assert.ok('success' in parsed);
  assert.ok('shipStatus' in parsed);
  assert.ok('prePrPassed' in parsed);
});



test('sdw-ship-pr - active threads are not resolved without a verified fixer', async () => {
  const calls = [];
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('--input')) {
      const match = cmd.match(/--input\s+"([^"]+)"/);
      if (match && fs.existsSync(match[1])) {
        const fileContent = fs.readFileSync(match[1], 'utf8');
        if (fileContent.includes('reviewThreads')) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: 'PRRT_kwTEST123',
                        isResolved: false,
                        path: 'src/index.js',
                        line: 10,
                        comments: {
                          nodes: [{ id: 'PRRC_1', body: 'Missing null check', author: { login: 'reviewer' } }]
                        }
                      }
                    ]
                  }
                }
              }
            }
          });
        }
      }
    }
    if (cmd.includes('pr checks')) {
      return JSON.stringify([{ name: 'ci/build', state: 'pass', bucket: 'pass' }]);
    }
    if (cmd.includes('gh repo view')) {
      return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
    }
    if (cmd.includes('gh api graphql') && cmd.includes('reviewThreads')) {
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: 'PRRT_kwTEST123',
                    isResolved: false,
                    path: 'src/index.js',
                    line: 10,
                    comments: {
                      nodes: [{ id: 'PRRC_1', body: 'Missing null check', author: { login: 'reviewer' } }]
                    }
                  }
                ]
              }
            }
          }
        }
      });
    }
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 42, url: 'https://github.com/fake-owner/fake-repo/pull/42', headRefName: 'develop', baseRefName: 'master' }]);
    }
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    return '';
  };

  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = true;

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      pollIntervalMs: 0
    }, fakeExecutor);

    assert.strictEqual(report.success, false);
    assert.strictEqual(report.shipStatus, 'review_pending');
    assert.strictEqual(report.reviewConvergence.resolvedThreads, 0);
    assert.strictEqual(report.reviewConvergence.pendingThreads.length, 1);
    assert.strictEqual(
      calls.some(c => c.includes('resolveReviewThread')),
      false,
      'No thread may be resolved without a verified fix'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function setupPreemptionWorkspace(checkScript) {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = true;
  const calls = [];
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('pr checks')) {
      return JSON.stringify(checkScript());
    }
    if (cmd.includes('reviewThreads')) {
      const fileMatch = cmd.match(/--input\s+"([^"]+)"/);
      if (fileMatch && fs.existsSync(fileMatch[1])) {
        const fileContent = fs.readFileSync(fileMatch[1], 'utf8');
        if (!fileContent.includes('reviewThreads')) return '';
      }
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    if (cmd.includes('gh repo view')) {
      return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
    }
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 42, url: 'https://github.com/fake-owner/fake-repo/pull/42', headRefName: 'develop', baseRefName: 'master' }]);
    }
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    return '';
  };
  return { tmpDir, config, calls, fakeExecutor };
}

test('sdw-ship-pr - superseded checks are not treated as failures', async () => {
  const { tmpDir, config, fakeExecutor } = setupPreemptionWorkspace(() => [
    { name: 'review', state: 'cancelled', bucket: 'fail' },
    { name: 'ci/build', state: 'pending', bucket: 'pending' }
  ]);
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      pollIntervalMs: 0
    }, fakeExecutor);

    assert.strictEqual(report.shipStatus, 'review_pending');
    assert.deepStrictEqual(report.reviewConvergence.failingChecks, [], 'cancelled checks must not be reported as failing');
    assert.strictEqual(report.reviewConvergence.supersededChecks.length, 1, 'cancelled check must be reported as superseded');
    assert.strictEqual(report.reviewConvergence.preemptions, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - terminal CI states are treated as failing checks, not superseded', async () => {
  const { tmpDir, config, fakeExecutor } = setupPreemptionWorkspace(() => [
    { name: 'review', state: 'timed_out', bucket: 'fail' },
    { name: 'ci/build', state: 'startup_failure', bucket: 'fail' }
  ]);
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      pollIntervalMs: 0
    }, fakeExecutor);

    assert.strictEqual(report.shipStatus, 'review_pending');
    assert.deepStrictEqual(report.reviewConvergence.supersededChecks, [], 'terminal CI states must not be reported as superseded');
    assert.strictEqual(report.reviewConvergence.failingChecks.length, 2, 'timed_out and startup_failure must feed the blocker path');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - concurrent push preemption resets the convergence window instead of halting', async () => {
  const scripted = [
    [{ name: 'review', state: 'cancelled', bucket: 'fail' }],
    [{ name: 'review', state: 'pending', bucket: 'pending' }],
    [{ name: 'review', state: 'pending', bucket: 'pending' }],
    [{ name: 'review', state: 'pass', bucket: 'pass' }]
  ];
  let call = 0;
  const { tmpDir, config, fakeExecutor } = setupPreemptionWorkspace(() => scripted[Math.min(call++, scripted.length - 1)]);
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 2,
      pollIntervalMs: 0
    }, fakeExecutor);

    assert.strictEqual(report.reviewConvergence.preemptions, 1, 'superseded run must trigger one adaptation');
    assert.strictEqual(report.reviewConvergence.converged, true, 'replacement run must be followed to convergence');
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.shipStatus, 'delivered');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - preemption budget cap falls back to review_pending', async () => {
  const scripted = [
    [{ name: 'review', state: 'cancelled', bucket: 'fail' }],
    [{ name: 'review', state: 'pending', bucket: 'pending' }],
    [{ name: 'review', state: 'pass', bucket: 'pass' }]
  ];
  let call = 0;
  const { tmpDir, config, fakeExecutor } = setupPreemptionWorkspace(() => scripted[Math.min(call++, scripted.length - 1)]);
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 2,
      pollIntervalMs: 0,
      maxPreemptions: 0
    }, fakeExecutor);

    assert.strictEqual(report.reviewConvergence.preemptions, 0, 'no adaptation allowed when budget is zero');
    assert.strictEqual(report.shipStatus, 'review_pending');
    assert.strictEqual(report.success, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - locateStateFile honors the configured stateDir token', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-state-dir-'));
  try {
    const stateDir = path.join(tmpDir, 'build', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, 'run-123.state.json');
    fs.writeFileSync(stateFile, '{}', 'utf8');

    const located = sdwShipPr.locateStateFile(tmpDir, 'run-123', null, {
      stateDir: '{projectRoot}/build/state'
    });
    assert.strictEqual(located, stateFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - resolveReviewThread rejects GraphQL application errors', async () => {
  const provider = createScmProvider('github', {
    executor: (cmd) => {
      if (cmd.includes('gh api graphql')) {
        return JSON.stringify({ errors: [{ message: 'permission denied' }] });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    }
  });

  await assert.rejects(
    () => provider.resolveReviewThread({ prNumber: 42, threadId: 'PRRT_kwTEST', comment: 'fixed' }),
    /GraphQL mutation failed: permission denied/
  );
});

test('sdw-ship-pr - subcommands cmdListThreads, cmdResolveThread, cmdCheckStatus operate correctly', async () => {
  const fakeExecutor = (cmd) => {
    if (cmd.includes('--input')) {
      const match = cmd.match(/--input\s+"([^"]+)"/);
      if (match && fs.existsSync(match[1])) {
        const fileContent = fs.readFileSync(match[1], 'utf8');
        if (fileContent.includes('resolveReviewThread')) {
          return JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
        }
        if (fileContent.includes('reviewThreads')) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: 'PRRT_kw101',
                        isResolved: false,
                        path: 'src/app.js',
                        line: 12,
                        comments: { nodes: [{ id: 'PRRC_1', body: 'Missing check' }] }
                      }
                    ]
                  }
                }
              }
            }
          });
        }
      }
    }
    if (cmd.includes('resolveReviewThread')) {
      return JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
    }
    if (cmd.includes('pr checks')) {
      return JSON.stringify([{ name: 'test', state: 'pass', bucket: 'pass' }]);
    }
    if (cmd.includes('gh repo view')) {
      return JSON.stringify({ owner: { login: 'owner' }, name: 'repo' });
    }
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) {
      return '/usr/bin/gh';
    }
    if (cmd.includes('gh auth status')) {
      return 'Logged in';
    }
    return '';
  };

  const listRes = await sdwShipPr.cmdListThreads({ pr: '42', provider: 'github' }, fakeExecutor);
  assert.strictEqual(listRes.activeCount, 1);
  assert.strictEqual(listRes.threads[0].id, 'PRRT_kw101');

  const resolveRes = await sdwShipPr.cmdResolveThread({
    pr: '42',
    threadId: 'PRRT_kw101',
    comment: 'Applied fix in commit abc1234',
    provider: 'github'
  }, fakeExecutor);
  assert.strictEqual(resolveRes.resolved, true);

  const statusRes = await sdwShipPr.cmdCheckStatus({ pr: '42', provider: 'github' }, fakeExecutor);
  assert.strictEqual(statusRes.allPassed, true);
});


test('sdw-ship-pr - pre-PR test gate receives verification.timeoutMs', async () => {
  const calls = [];
  const fakeExecutor = (cmd, opts) => {
    calls.push({ cmd, opts });
    return '';
  };
  const { tmpDir, config } = setupTestWorkspace();
  config.runAllTests = true;
  config.testCommand = 'npm test';
  config.verification = { ...(config.verification || {}), timeoutMs: 1234 };

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master'
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    const testCall = calls.find(call => call.cmd === 'npm test');
    assert.ok(testCall, 'Test command must be executed');
    assert.strictEqual(testCall.opts && testCall.opts.timeout, 1234);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - resolveReviewThread does not duplicate the resolution marker', async () => {
  const executor = (cmd) => {
    if (cmd.includes('gh api graphql')) {
      return JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
    }
    return '';
  };
  const provider = createScmProvider('github', { executor });
  const result = await provider.resolveReviewThread({
    prNumber: 3,
    threadId: 'PRRT_fake',
    comment: '<!-- resolution-reply -->\nFixed in the current tree.',
    model: 'sdw-ship-pr'
  });
  assert.strictEqual(result.resolved, true);
  const count = (result.comment.match(/<!-- resolution-reply -->/g) || []).length;
  assert.strictEqual(count, 1, 'marker must appear exactly once even when the caller pre-prefixes it');
});

test('sdw-ship-pr - prePrCommand commit stages only files it created', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(tmpDir, 'baseline.txt'), 'baseline', 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "baseline"', { cwd: tmpDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'keep me uncommitted', 'utf8');

  config.prePrCommand = 'node -e "require(\'fs\').writeFileSync(\'generated.txt\',\'x\')"';

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master'
    });

    assert.strictEqual(report.success, true);
    const committed = execSync('git show --name-only --format= HEAD', { cwd: tmpDir, encoding: 'utf8' });
    assert.match(committed, /generated\.txt/);
    assert.doesNotMatch(committed, /unrelated\.txt/);
    const status = execSync('git status --porcelain', { cwd: tmpDir, encoding: 'utf8' });
    assert.match(status, /unrelated\.txt/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - active PR reuse complements PR description with amending delivery info', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = false;

  const calls = [];
  let updatedBody = null;
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 77, url: 'https://github.com/fake-owner/fake-repo/pull/77', headRefName: 'develop', baseRefName: 'master', title: 'Existing PR' }]);
    }
    if (cmd.includes('gh pr view 77 --json body')) {
      return JSON.stringify({ body: 'Initial PR Body' });
    }
    if (cmd.includes('gh pr edit 77')) {
      const match = cmd.match(/--body-file "([^"]+)"/);
      if (match && fs.existsSync(match[1])) {
        updatedBody = fs.readFileSync(match[1], 'utf8');
      }
      return '';
    }
    if (cmd.includes('git rev-parse --short HEAD')) return 'abc1234';
    return '';
  };

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      specSlug: '026-ensure-hybrid-mode'
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.shipStatus, 'delivered');
    assert.ok(report.pullRequest);
    assert.strictEqual(report.pullRequest.reused, true);
    assert.strictEqual(report.pullRequest.number, '77');
    assert.ok(updatedBody, 'PR description must be updated');
    assert.match(updatedBody, /Initial PR Body/);
    assert.match(updatedBody, /### Amending Delivery: 026-ensure-hybrid-mode/);
    assert.match(updatedBody, /Commit: `abc1234`/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - active PR with review_pending adapts as non-blocking and records completed state step', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = true;

  const stateDir = path.join(tmpDir, '.sdw', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const runId = 'run-test-active-pr-nonblocking';
  const stateFilePath = path.join(stateDir, `${runId}.state.json`);
  fs.writeFileSync(stateFilePath, JSON.stringify({
    runId,
    status: 'in_progress',
    steps: { 8: { step: 8, name: 'pr_preparation', status: 'in_progress' } }
  }, null, 2), 'utf8');

  const fakeExecutor = (cmd) => {
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 88, url: 'https://github.com/fake-owner/fake-repo/pull/88', headRefName: 'develop', baseRefName: 'master' }]);
    }
    if (cmd.includes('pr checks')) {
      return JSON.stringify([{ name: 'review', state: 'pending', bucket: 'pending' }]);
    }
    if (cmd.includes('reviewThreads')) {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    if (cmd.includes('gh repo view')) {
      return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
    }
    return '';
  };

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      runId,
      maxIterations: 1,
      pollIntervalMs: 0
    }, fakeExecutor);

    assert.strictEqual(report.shipStatus, 'review_pending');
    assert.strictEqual(report.nonBlocking, true);
    assert.strictEqual(report.adaptedActivePr, true);

    // Verify state file marks step 8 as completed
    const stateContent = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    assert.strictEqual(stateContent.steps[8].status, 'completed', 'Step 8 must be marked completed for non-blocking active PR adaptation');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Optional merge (--merge / --allow-merge): fire and forget after convergence
// ---------------------------------------------------------------------------

function setupMergeWorkspace(options = {}) {
  const calls = [];
  const failCommand = options.failCommand || null;
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (failCommand && cmd.includes(failCommand)) {
      const err = new Error(`${failCommand} exited 1`);
      err.stderr = `${failCommand} exited 1`;
      throw err;
    }
    if (cmd.includes('--input')) {
      const match = cmd.match(/--input\s+"([^"]+)"/);
      if (match && fs.existsSync(match[1])) {
        const payload = fs.readFileSync(match[1], 'utf8');
        if (payload.includes('reviewThreads')) {
          const nodes = options.activeThread
            ? [{
                id: 'PRRT_kwTEST123',
                isResolved: false,
                path: 'src/index.js',
                line: 10,
                comments: { nodes: [{ id: 'PRRC_1', body: 'Missing null check', author: { login: 'reviewer' } }] }
              }]
            : [];
          return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
        }
      }
    }
    if (cmd.includes('pr checks')) return JSON.stringify([{ name: 'ci/build', state: 'pass', bucket: 'pass' }]);
    if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 42, url: 'https://github.com/fake-owner/fake-repo/pull/42', headRefName: 'develop', baseRefName: 'master' }]);
    }
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh pr merge')) {
      if (options.mergeFailure) {
        const err = new Error(options.mergeFailure);
        err.stderr = options.mergeFailure;
        throw err;
      }
      return '';
    }
    return '';
  };

  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = true;
  return { tmpDir, config, calls, fakeExecutor };
}

test('sdw-ship-pr - CLI --merge / --allow-merge flags are parsed and default to false', () => {
  assert.strictEqual(sdwShipPr.parseArgs(['--merge']).merge, true, '--merge enables the merge intent');
  assert.strictEqual(sdwShipPr.parseArgs(['--allow-merge']).merge, true, '--allow-merge is the same intent');
  assert.strictEqual(sdwShipPr.parseArgs(['--poll-pr']).merge, undefined, 'Merge is off unless requested');
  assert.strictEqual(sdwShipPr.parseArgs([]).merge, undefined, 'Default is no merge');
});

test('sdw-ship-pr - mergePullRequest builds the GitHub CLI command and surfaces failures', async () => {
  const issued = [];
  const provider = createScmProvider('github', { executor: (cmd) => { issued.push(cmd); return ''; } });

  const result = await provider.mergePullRequest({ prNumber: 42 });
  assert.strictEqual(result.merged, true);
  assert.strictEqual(issued[0], 'gh pr merge 42 --merge', 'Merges with the GitHub CLI');

  const squashProvider = createScmProvider('github', { executor: (cmd) => { issued.push(cmd); return ''; } });
  await squashProvider.mergePullRequest({ prNumber: 7, method: 'squash' });
  assert.strictEqual(issued[issued.length - 1], 'gh pr merge 7 --squash', 'Honours the merge method');

  const dryProvider = createScmProvider('github', { executor: () => { throw new Error('must not run'); } });
  const dryResult = await dryProvider.mergePullRequest({ prNumber: 42, dryRun: true });
  assert.strictEqual(dryResult.dryRun, true, 'Dry-run never invokes the CLI');

  const failingProvider = createScmProvider('github', {
    executor: () => { const err = new Error('Resource not accessible by integration'); err.stderr = 'Resource not accessible by integration'; throw err; }
  });
  await assert.rejects(
    () => failingProvider.mergePullRequest({ prNumber: 42 }),
    /GitHub mergePullRequest failed: Resource not accessible by integration/,
    'CLI failures are reported, not swallowed, by the contract'
  );

  await assert.rejects(
    () => createScmProvider('github', { executor: () => '' }).mergePullRequest({}),
    /prNumber is required/,
    'A missing PR number is rejected'
  );
});

test('sdw-ship-pr - mergePullRequest completes the pull request through the Azure DevOps CLI', async () => {
  const issued = [];
  const provider = createScmProvider('ado', { executor: (cmd) => { issued.push(cmd); return ''; } });

  const result = await provider.mergePullRequest({ prNumber: 512 });
  assert.strictEqual(result.merged, true);
  assert.strictEqual(issued[0], 'az repos pr update --id 512 --status completed', 'Completes the PR with the Azure CLI');

  const dryResult = await createScmProvider('ado', { executor: () => { throw new Error('must not run'); } })
    .mergePullRequest({ prNumber: 512, dryRun: true });
  assert.strictEqual(dryResult.dryRun, true);
});

test('sdw-ship-pr - --merge merges the PR after convergence and records the outcome', async () => {
  const { tmpDir, config, calls, fakeExecutor } = setupMergeWorkspace();
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      pollIntervalMs: 0,
      merge: true
    }, fakeExecutor);

    assert.strictEqual(report.reviewConvergence.converged, true, 'Review converged first');
    assert.strictEqual(report.merge.requested, true);
    assert.strictEqual(report.merge.attempted, true, 'Merge is attempted once converged');
    assert.strictEqual(report.merge.ok, true);
    assert.strictEqual(report.merge.reason, null);
    assert.ok(calls.some(c => c === 'gh pr merge 42 --merge'), 'The SCM merge command was issued');
    assert.strictEqual(report.success, true, 'Delivery stays successful');
    assert.strictEqual(report.shipStatus, 'delivered');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - a failing merge is recorded but never fails the delivery', async () => {
  const { tmpDir, config, calls, fakeExecutor } = setupMergeWorkspace({ mergeFailure: 'Pull request is not mergeable: required status check pending' });
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      pollIntervalMs: 0,
      merge: true
    }, fakeExecutor);

    assert.strictEqual(report.merge.attempted, true);
    assert.strictEqual(report.merge.ok, false, 'The failure is recorded');
    assert.match(report.merge.error, /not mergeable/, 'The CLI message is preserved for audit');
    assert.strictEqual(report.success, true, 'Fire and forget: delivery still succeeds');
    assert.strictEqual(report.shipStatus, 'delivered');
    assert.ok(calls.some(c => c.startsWith('gh pr merge')), 'The merge was still attempted');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - merge waits for convergence and is skipped when review did not converge', async () => {
  const { tmpDir, config, calls, fakeExecutor } = setupMergeWorkspace({ activeThread: true });
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      pollIntervalMs: 0,
      merge: true
    }, fakeExecutor);

    assert.strictEqual(report.reviewConvergence.converged, false);
    assert.strictEqual(report.merge.attempted, false, 'No merge without convergence');
    assert.strictEqual(report.merge.reason, 'review did not converge');
    assert.strictEqual(calls.some(c => c.startsWith('gh pr merge')), false, 'The merge command is never issued');
    assert.strictEqual(report.success, false, 'The PR stays pending review');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - merge is opt-in only', async () => {
  const { tmpDir, config, calls, fakeExecutor } = setupMergeWorkspace();
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 1,
      pollIntervalMs: 0
    }, fakeExecutor);

    assert.strictEqual(report.merge, null, 'No merge state unless requested');
    assert.strictEqual(calls.some(c => c.startsWith('gh pr merge')), false, 'The merge command is never issued by default');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - merge records a skip reason when convergence is disabled', async () => {
  const { tmpDir, config, calls, fakeExecutor } = setupMergeWorkspace();
  config.scmCodeReviewEnabled = false;
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      merge: true
    }, fakeExecutor);

    assert.strictEqual(report.reviewConvergence.enabled, false, 'Convergence was not enabled');
    assert.strictEqual(report.merge.attempted, false);
    assert.strictEqual(report.merge.reason, 'review convergence disabled', 'The reason names the real cause, not "did not converge"');
    assert.strictEqual(calls.some(c => c.startsWith('gh pr merge')), false);
    assert.strictEqual(report.success, true, 'Delivery still succeeds without merge');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - merge keeps an audit record when the delivery fails before the merge step', async () => {
  const { tmpDir, config, fakeExecutor } = setupMergeWorkspace({ failCommand: 'failing-pre-pr' });
  config.prePrCommand = 'failing-pre-pr';
  try {
    let captured = null;
    await assert.rejects(
      () => sdwShipPr.runShipPr({
        projectRoot: tmpDir,
        config,
        head: 'develop',
        base: 'master',
        merge: true
      }, fakeExecutor),
      (err) => { captured = err; return /prePrCommand failed/.test(err.message); }
    );

    assert.ok(captured, 'The delivery failed at the pre-PR gate');
    assert.ok(captured.report, 'The partial report is attached to the error');
    assert.strictEqual(captured.report.merge.requested, true, 'Merge request is still audited');
    assert.strictEqual(captured.report.merge.attempted, false);
    assert.strictEqual(captured.report.merge.reason, 'delivery did not reach merge step');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
