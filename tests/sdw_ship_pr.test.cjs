const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

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

function writeRunState(tmpDir, runId, state) {
  const stateDir = path.join(tmpDir, '.sdw', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFilePath = path.join(stateDir, `${runId}.state.json`);
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  return stateFilePath;
}

function completedRunState(overrides = {}) {
  return {
    runId: 'run-00050',
    status: 'completed',
    score: 9,
    steps: {
      4: { step: 4, name: 'code_review', status: 'completed' },
      6: { step: 6, name: 'conformance_score', status: 'completed' },
      7: { step: 7, name: 'delegated_review', status: 'completed' },
      8: { step: 8, name: 'pr_preparation', status: 'in_progress' }
    },
    ...overrides
  };
}

function writePrepareSection(tmpDir, fileName = 'AGENTS.md') {
  fs.writeFileSync(
    path.join(tmpDir, fileName),
    '# Agent Instructions\n\n## Prepare before push\n\n- Run the packaging check.\n',
    'utf8'
  );
}

function writeIssueSpec(projectRoot, slug, { id = null, source = 'local', title = 'Issue linked specification' } = {}) {
  const specsDir = path.join(projectRoot, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const idLine = id === null ? 'null' : JSON.stringify(String(id));
  fs.writeFileSync(
    path.join(specsDir, `${slug}.md`),
    `---\nid: ${idLine}\nslug: ${slug}\ntitle: "${title}"\nsource: ${source}\nstatus: draft\n---\n\n# Specification — ${title}\n`,
    'utf8'
  );
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
    if (cmd.includes('pr checks --help')) {
      return '';
    }
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

test('sdw-ship-pr - waits for a queued check run to start before watching', async () => {
  const scripted = [
    [],
    [],
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
      pollIntervalMs: 1,
      checksStartTimeoutMs: 500,
      checksStartIntervalMs: 20
    }, fakeExecutor);

    assert.strictEqual(report.reviewConvergence.checksStart.detected, true, 'A queued run must be detected once it starts');
    assert.ok(report.reviewConvergence.checksStart.polls >= 2, 'Detection must poll until the provider reports a check');
    assert.strictEqual(report.reviewConvergence.converged, true, 'The loop converges on the run that started');
    assert.strictEqual(report.shipStatus, 'delivered');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - a pipeline that never starts is bounded by the start timeout', async () => {
  const { tmpDir, config, fakeExecutor } = setupPreemptionWorkspace(() => []);
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 2,
      pollIntervalMs: 1,
      checksStartTimeoutMs: 120,
      checksStartIntervalMs: 30
    }, fakeExecutor);

    assert.strictEqual(report.reviewConvergence.checksStart.detected, false, 'A pipeline that never starts must time out');
    assert.ok(report.reviewConvergence.checksStart.polls >= 2, 'Detection polls more than once before giving up');
    assert.ok(report.reviewConvergence.checksStart.waitedMs >= 20, 'The start wait must actually elapse before falling back');
    assert.strictEqual(report.reviewConvergence.converged, false);
    assert.strictEqual(report.shipStatus, 'review_pending');
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
      specSlug: '00026-ensure-hybrid-mode'
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.shipStatus, 'delivered');
    assert.ok(report.pullRequest);
    assert.strictEqual(report.pullRequest.reused, true);
    assert.strictEqual(report.pullRequest.number, '77');
    assert.ok(updatedBody, 'PR description must be updated');
    assert.match(updatedBody, /Initial PR Body/);
    assert.match(updatedBody, /### Amending Delivery: 00026-ensure-hybrid-mode/);
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
    score: 9,
    steps: {
      4: { step: 4, name: 'code_review', status: 'completed' },
      6: { step: 6, name: 'conformance_score', status: 'completed' },
      7: { step: 7, name: 'delegated_review', status: 'completed' },
      8: { step: 8, name: 'pr_preparation', status: 'in_progress' }
    }
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

test('sdw-ship-pr - native watch: providers expose the capability and the probe is cached', () => {
  let probes = 0;
  const gh = createScmProvider('github', {
    executor: (cmd) => {
      probes++;
      return cmd.includes('gh run watch --help') ? 'FLAGS\n      --exit-status   Exit with non-zero status if run fails' : '';
    }
  });
  assert.strictEqual(gh.supportsNativeWatch(), true);
  assert.strictEqual(gh.supportsNativeWatch(), true);
  assert.strictEqual(probes, 1, 'The capability probe is cached after the first call');

  const oldGh = createScmProvider('github', { executor: () => 'usage: gh run watch' });
  assert.strictEqual(oldGh.supportsNativeWatch(), false, 'Older gh CLIs without --watch fall back to polling');

  const ado = createScmProvider('ado', { executor: () => '' });
  assert.strictEqual(ado.supportsNativeWatch(), false, 'Azure DevOps has no native check watch');

  assert.strictEqual(sdwShipPr.parseArgs(['--no-native-watch']).nativeWatch, false);
  assert.strictEqual(sdwShipPr.parseArgs(['--native-watch']).nativeWatch, true);
  assert.strictEqual(sdwShipPr.parseArgs([]).nativeWatch, true);
});

test('sdw-ship-pr - native watch: the convergence loop blocks natively while checks are pending', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = true;
  config.runAllTests = false;
  const calls = [];
  let checkCalls = 0;
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('gh run watch --help')) return 'FLAGS\n      --exit-status   Exit with non-zero status if run fails';
    if (cmd.includes('gh run watch')) return '';
    if (cmd.includes('gh pr checks') && cmd.includes('--json name,state,link') && !cmd.includes('bucket')) {
      return JSON.stringify([{ name: 'ci/build', state: 'pending', link: 'https://github.com/fake-owner/fake-repo/actions/runs/123/job/456' }]);
    }
    if (cmd.includes('gh pr checks')) {
      checkCalls += 1;
      return JSON.stringify(checkCalls === 1
        ? [{ name: 'ci/build', state: 'pending', bucket: 'pending' }]
        : [{ name: 'ci/build', state: 'pass', bucket: 'pass' }]);
    }
    if (cmd.includes('reviewThreads')) {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 42, url: 'https://github.com/fake-owner/fake-repo/pull/42', headRefName: 'develop', baseRefName: 'master' }]);
    }
    return '';
  };
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 2,
      pollIntervalMs: 10000
    }, fakeExecutor);

    assert.ok(calls.some(c => c.includes('gh run watch') && c.includes('--exit-status')), 'The native Actions run watch is consumed while checks are pending');
    assert.strictEqual(report.reviewConvergence.converged, true, 'The loop re-polls after the native watch and converges');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - native watch: a watch failure falls back to the poll interval', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = true;
  config.runAllTests = false;
  let checkCalls = 0;
  const fakeExecutor = (cmd) => {
    if (cmd.includes('gh run watch --help')) return 'FLAGS --exit-status';
    if (cmd.includes('gh pr checks') && cmd.includes('--json name,state,link') && !cmd.includes('bucket')) return JSON.stringify([]);
    if (cmd.includes('gh pr checks')) {
      checkCalls += 1;
      return JSON.stringify(checkCalls === 1
        ? [{ name: 'ci/build', state: 'pending', bucket: 'pending' }]
        : [{ name: 'ci/build', state: 'pass', bucket: 'pass' }]);
    }
    if (cmd.includes('reviewThreads')) {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 42, url: 'https://github.com/fake-owner/fake-repo/pull/42', headRefName: 'develop', baseRefName: 'master' }]);
    }
    return '';
  };
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      maxIterations: 2,
      pollIntervalMs: 5
    }, fakeExecutor);

    assert.ok(checkCalls >= 2, 'The loop re-polls after the fallback interval');
    assert.strictEqual(report.reviewConvergence.converged, true, 'The fallback keeps the settle period and converges');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('sdw-ship-pr - dirty selection honors an approved list, run scope, and refuses unknowns', () => {
  const status = ' M a.js\n?? b.js\n M c.js\n';
  const approved = sdwShipPr.selectDirtyFiles(status, { approved: ['a.js', 'c.js'] });
  assert.strictEqual(approved.mode, 'approved-list');
  assert.deepStrictEqual(approved.selected.map(e => e.path), ['a.js', 'c.js']);
  assert.deepStrictEqual(approved.excluded.map(e => e.path), ['b.js']);

  const runScope = sdwShipPr.selectDirtyFiles(status, { runFiles: ['b.js'] });
  assert.strictEqual(runScope.mode, 'run-scope');
  assert.deepStrictEqual(runScope.selected.map(e => e.path), ['b.js']);
  assert.deepStrictEqual(runScope.excluded.map(e => e.path), ['a.js', 'c.js']);

  const none = sdwShipPr.selectDirtyFiles(status, {});
  assert.strictEqual(none.mode, 'none');
  assert.strictEqual(none.selected.length, 0);
});

test('sdw-ship-pr - the dirty commit never sweeps files staged outside the approved list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-dirty-commit-'));
  const exec = (cmd) => execSync(cmd, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    exec('git init');
    exec('git config user.name "SDW Tester"');
    exec('git config user.email "tester@sdw.org"');
    fs.writeFileSync(path.join(dir, 'approved.txt'), 'base\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'staged-elsewhere.txt'), 'base\n', 'utf8');
    exec('git add -A');
    exec('git commit -m "baseline"');

    fs.writeFileSync(path.join(dir, 'approved.txt'), 'session change\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'staged-elsewhere.txt'), 'outside change\n', 'utf8');
    exec('git add -- staged-elsewhere.txt');

    const result = sdwShipPr.commitDirtyWorktree(exec, dir, {
      approved: ['approved.txt']
    });

    assert.ok(result.sha, 'The approved file is committed');
    const committed = exec('git show --name-only --pretty=format: HEAD').split('\n').map(l => l.trim()).filter(Boolean);
    assert.deepStrictEqual(committed, ['approved.txt'], 'Only the approved path enters the delivery commit');
    const staged = exec('git diff --cached --name-only').split('\n').map(l => l.trim()).filter(Boolean);
    assert.deepStrictEqual(staged, ['staged-elsewhere.txt'], 'Unrelated staged work stays staged and uncommitted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - a failed dirty commit aborts before publishing the branch', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  const calls = [];
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('git status --porcelain')) return ' M feature.js\u0000';
    if (cmd.startsWith('git remote')) return 'origin';
    if (cmd.startsWith('git add')) return '';
    if (cmd.startsWith('git commit')) throw new Error('pre-commit hook rejected the change');
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'o' }, name: 'r' });
    if (cmd.includes('gh pr list')) return '[]';
    return '';
  };
  try {
    await assert.rejects(
      async () => sdwShipPr.runShipPr({
        projectRoot: tmpDir,
        config,
        head: 'develop',
        base: 'master',
        push: true,
        dirtyFilesPath: 'feature.js'
      }, fakeExecutor),
      /could not be committed before push/
    );
    assert.strictEqual(
      calls.some(c => c.startsWith('git push')),
      false,
      'No push may follow a failed delivery commit'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Spec 00050: discovery modes, acknowledgement, run-state gate, board, dry-run
// ---------------------------------------------------------------------------

test('sdw-ship-pr - 00050 AC2/AC3: default block discovery refuses unacknowledged prepare rows', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  writePrepareSection(tmpDir);
  const calls = [];
  const fakeExecutor = (cmd) => { calls.push(cmd); return ''; };

  try {
    let captured = null;
    await assert.rejects(
      () => sdwShipPr.runShipPr({
        projectRoot: tmpDir, config, head: 'develop', base: 'master', push: true
      }, fakeExecutor),
      (err) => { captured = err; return /prepare discovery gate failed/i.test(err.message); }
    );

    assert.ok(captured.report, 'the partial report is attached to the refusal');
    assert.strictEqual(captured.report.prepareDiscovery, 'blocked');
    assert.ok(captured.report.prepareObligations.length >= 1, 'the discovered row is recorded');
    assert.strictEqual(captured.report.prepareObligations[0].source, 'AGENTS.md');
    const row = captured.report.prePrBoard.find(r => r.check === 'discovery');
    assert.strictEqual(row.status, 'fail');
    assert.match(row.evidence, /unacknowledged/);
    assert.strictEqual(calls.some(c => c.startsWith('git push')), false, 'no push after a discovery refusal');
    assert.strictEqual(calls.some(c => c.includes('gh pr create')), false, 'no pull request after a discovery refusal');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC4: --ack-prepare records the note and allows the ship', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  writePrepareSection(tmpDir);
  const calls = [];
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.startsWith('git remote')) return 'origin';
    return '';
  };

  try {
    assert.strictEqual(sdwShipPr.parseArgs(['--ack-prepare', 'Ran the packaging check']).ackPrepare, 'Ran the packaging check');
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      push: true,
      ackPrepare: 'Ran the packaging check'
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.prepareAck.note, 'Ran the packaging check');
    assert.ok(!Number.isNaN(Date.parse(report.prepareAck.at)), 'the acknowledgement carries a UTC timestamp');
    const row = report.prePrBoard.find(r => r.check === 'discovery');
    assert.strictEqual(row.status, 'pass');
    assert.match(row.evidence, /acknowledged via --ack-prepare/);
    assert.ok(calls.some(c => c.startsWith('git push')), 'the push proceeds after acknowledgement');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC5: warn discovery prints rows and continues the ship', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.prePrDiscovery = 'warn';
  writePrepareSection(tmpDir);

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'develop', base: 'master'
    }, () => '');

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.prepareDiscovery, 'warn');
    assert.ok(report.prepareObligations.length >= 1);
    const row = report.prePrBoard.find(r => r.check === 'discovery');
    assert.strictEqual(row.status, 'pass');
    assert.match(row.evidence, /"warn": \d+ obligation\(s\) printed; ship continues/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC6: off discovery skips the scan and records the mode', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.prePrDiscovery = 'off';
  writePrepareSection(tmpDir);

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'develop', base: 'master'
    }, () => '');

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.prepareDiscovery, 'off');
    assert.deepStrictEqual(report.prepareObligations, [], 'the matching heading is not scanned when discovery is off');
    const row = report.prePrBoard.find(r => r.check === 'discovery');
    assert.strictEqual(row.status, 'skipped');
    assert.match(row.evidence, /"off"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC9: step 7 is required only when code review runs', () => {
  const { tmpDir, config } = setupTestWorkspace();
  const runId = 'run-step-7';
  writeRunState(tmpDir, runId, completedRunState({
    runId,
    steps: {
      4: { step: 4, name: 'code_review', status: 'completed' },
      6: { step: 6, name: 'conformance_score', status: 'completed' }
    }
  }));

  try {
    const withReview = sdwShipPr.evaluateRunStateGate(tmpDir, runId, null, config, { scmCodeReviewEnabled: true });
    assert.strictEqual(withReview.codeReviewRequired, true);
    assert.strictEqual(withReview.steps[7], null);
    assert.strictEqual(withReview.passed, false);
    assert.match(withReview.reason, /step 7 is "missing"/);

    const withoutReview = sdwShipPr.evaluateRunStateGate(tmpDir, runId, null, config, { scmCodeReviewEnabled: false });
    assert.strictEqual(withoutReview.codeReviewRequired, false);
    assert.strictEqual(withoutReview.passed, true, 'Step 7 is not part of the gate when review is disabled');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC9: a ship with code review refuses when Step 7 is not completed', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.scmCodeReviewEnabled = true;
  const runId = 'run-step-7-ship';
  writeRunState(tmpDir, runId, completedRunState({
    runId,
    steps: {
      4: { step: 4, name: 'code_review', status: 'completed' },
      6: { step: 6, name: 'conformance_score', status: 'completed' },
      8: { step: 8, name: 'pr_preparation', status: 'in_progress' }
    }
  }));

  try {
    let captured = null;
    await assert.rejects(
      () => sdwShipPr.runShipPr({
        projectRoot: tmpDir, config, head: 'develop', base: 'master', runId
      }, () => ''),
      (err) => { captured = err; return /step 7/.test(err.message); }
    );

    assert.strictEqual(captured.report.runStateGate.codeReviewRequired, true);
    assert.strictEqual(captured.report.runStateGate.steps[7], null);
    const row = captured.report.prePrBoard.find(r => r.check === 'runState');
    assert.strictEqual(row.status, 'fail');
    assert.match(row.evidence, /step 7/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC10: missing or unreadable run state fails closed before push and PR', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  const calls = [];
  const fakeExecutor = (cmd) => { calls.push(cmd); return ''; };

  try {
    let captured = null;
    await assert.rejects(
      () => sdwShipPr.runShipPr({
        projectRoot: tmpDir, config, head: 'develop', base: 'master', runId: 'run-missing', push: true
      }, fakeExecutor),
      (err) => { captured = err; return /was not found/.test(err.message); }
    );
    let row = captured.report.prePrBoard.find(r => r.check === 'runState');
    assert.strictEqual(row.status, 'fail');
    assert.match(row.evidence, /was not found/);
    assert.strictEqual(calls.some(c => c.startsWith('git push')), false, 'no push on a missing run state');
    assert.strictEqual(calls.some(c => c.includes('gh pr create')), false, 'no PR on a missing run state');

    calls.length = 0;
    const malformedRunId = 'run-malformed';
    fs.mkdirSync(path.join(tmpDir, '.sdw', 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'state', `${malformedRunId}.state.json`), '{not json', 'utf8');

    captured = null;
    await assert.rejects(
      () => sdwShipPr.runShipPr({
        projectRoot: tmpDir, config, head: 'develop', base: 'master', runId: malformedRunId, push: true
      }, fakeExecutor),
      (err) => { captured = err; return /is unreadable/.test(err.message); }
    );
    row = captured.report.prePrBoard.find(r => r.check === 'runState');
    assert.strictEqual(row.status, 'fail');
    assert.match(row.evidence, /is unreadable/);
    assert.strictEqual(calls.some(c => c.startsWith('git push')), false, 'no push on an unreadable run state');
    assert.strictEqual(calls.some(c => c.includes('gh pr create')), false, 'no PR on an unreadable run state');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC10: CLI exits 1 on a missing run state and reports the board', () => {
  const { tmpDir } = setupTestWorkspace();
  const scriptPath = path.resolve(__dirname, '../skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs');

  try {
    const result = spawnSync(process.execPath, [scriptPath, '--run-id', 'run-cli-missing', '--json'], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 60000
    });

    assert.strictEqual(result.status, 1, 'a missing run state must exit 1');
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.success, false);
    assert.match(parsed.error, /was not found/);
    const row = parsed.prePrBoard.find(r => r.check === 'runState');
    assert.strictEqual(row.status, 'fail');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC11: every evaluated check contributes one board row', async () => {
  const plain = setupTestWorkspace();
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: plain.tmpDir, config: plain.config, head: 'develop'
    }, () => '');

    assert.deepStrictEqual(
      report.prePrBoard.map(r => r.check),
      ['prePrCommand', 'build', 'tests', 'security', 'runState', 'discovery']
    );
    assert.deepStrictEqual(
      report.prePrBoard.map(r => r.status),
      ['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'pass']
    );
    for (const row of report.prePrBoard) {
      assert.ok(['pass', 'fail', 'skipped'].includes(row.status));
      assert.strictEqual(typeof row.evidence, 'string');
      assert.ok(row.evidence.length > 0, `${row.check} must carry evidence`);
    }
  } finally {
    fs.rmSync(plain.tmpDir, { recursive: true, force: true });
  }

  const enabled = setupTestWorkspace();
  enabled.config.prePrCommand = 'npm run lint';
  enabled.config.requiredBuild = true;
  enabled.config.runAllTests = true;
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: enabled.tmpDir, config: enabled.config, head: 'develop'
    }, () => '');

    assert.deepStrictEqual(
      report.prePrBoard.map(r => r.status),
      ['pass', 'pass', 'pass', 'skipped', 'skipped', 'pass']
    );
    assert.match(report.prePrBoard[0].evidence, /"npm run lint" exited 0/);
  } finally {
    fs.rmSync(enabled.tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC12: the board prints as a Markdown table before the push', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  const calls = [];
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.startsWith('git remote')) return 'origin';
    return '';
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'develop', base: 'master', push: true
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    const tableIndex = logs.findIndex(line => line.includes('| Check | Status | Evidence |'));
    const pushIndex = logs.findIndex(line => line.includes('Pushing branch'));
    assert.ok(tableIndex >= 0, 'the Markdown table is printed');
    assert.ok(pushIndex > tableIndex, 'the table is printed before the push');
    assert.ok(logs.some(line => line.includes('| prePrCommand | skipped |')));
    assert.ok(calls.some(c => c.startsWith('git push')));
  } finally {
    console.log = originalLog;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00050 AC13: --dry-run evaluates every check without push, PR, or state writes', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.pushDelivery = true;
  config.prePrCommand = 'npm run lint';
  config.requiredBuild = true;
  config.runAllTests = true;
  config.securityChecksEnabled = true;
  const runId = 'run-dry-run';
  const stateFilePath = writeRunState(tmpDir, runId, completedRunState({ runId }));
  const stateBefore = fs.readFileSync(stateFilePath, 'utf8');
  const calls = [];
  const fakeExecutor = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh pr list')) return '[]';
    if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'fake' }, name: 'repo' });
    if (cmd.includes('pr checks')) return '[]';
    if (cmd.includes('reviewThreads')) {
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    if (cmd.startsWith('git remote')) return 'origin';
    return '';
  };

  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir,
      config,
      head: 'develop',
      base: 'master',
      runId,
      dryRun: true,
      push: true,
      maxIterations: 1,
      pollIntervalMs: 0
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    assert.deepStrictEqual(
      report.prePrBoard.map(r => r.check),
      ['prePrCommand', 'build', 'tests', 'security', 'runState', 'discovery']
    );
    for (const check of ['prePrCommand', 'build', 'tests', 'security']) {
      const row = report.prePrBoard.find(r => r.check === check);
      assert.strictEqual(row.status, 'skipped', `${check} must be skipped in dry-run`);
      assert.match(row.evidence, /dry-run/);
    }
    assert.strictEqual(report.prePrBoard.find(r => r.check === 'runState').status, 'pass');
    assert.strictEqual(report.prePrBoard.find(r => r.check === 'discovery').status, 'pass');
    assert.ok(report.pullRequest && report.pullRequest.dryRun, 'PR creation is simulated');
    assert.strictEqual(fs.readFileSync(stateFilePath, 'utf8'), stateBefore, 'dry-run must not write run state');
    assert.strictEqual(calls.some(c => c.startsWith('git push')), false, 'dry-run must not push');
    assert.strictEqual(calls.some(c => c.includes('gh pr create')), false, 'dry-run must not create a PR');
    assert.strictEqual(calls.some(c => c.includes('npm run lint')), false, 'dry-run must not execute configured commands');
    assert.strictEqual(calls.some(c => c.includes('npm test')), false, 'dry-run must not execute configured tests');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function fakeGithubExecutor(overrides = {}) {
  const calls = [];
  const executor = (cmd) => {
    calls.push(cmd);
    if (overrides[cmd]) return overrides[cmd](cmd);
    if (cmd.startsWith('git log')) return 'abc1234def5678\x1fabc1234\x1ffeat(link): add keyword\x1fSDW Tester\x1f2026-01-01';
    if (cmd.startsWith('git diff')) return 'M\tsrc/link.cjs';
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'fake-owner' }, name: 'fake-repo' });
    if (cmd.includes('gh pr list')) return '[]';
    return '';
  };
  executor.calls = calls;
  return executor;
}

test('sdw-ship-pr - AC3, AC8, AC11: a GitHub specification appends Closes #<id>', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  writeIssueSpec(tmpDir, '00060-github-link', { id: '123', source: 'github' });
  try {
    const link = sdwShipPr.resolveIssueLink(tmpDir, '00060-github-link');
    assert.deepStrictEqual(link, { id: '123', provider: 'github', keyword: 'Closes #123', present: true });

    const body = sdwShipPr.buildPrBody({
      specSlug: '00060-github-link', head: 'feature/gh', base: 'master', commits: [], files: [], config, issueLink: link
    });
    assert.match(body, /^Closes #123$/m, 'The GitHub keyword is appended to the body');

    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'feature/gh', base: 'master', specSlug: '00060-github-link'
    });
    assert.strictEqual(report.success, true);
    assert.deepStrictEqual(report.issueLink, link, 'The success report records the resolved issueLink');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00062 AC18: a scmSpecId-only specification still appends its closing keyword', () => {
  const { tmpDir } = setupTestWorkspace();
  const slug = '00063-scm-spec-id-link';
  const specsDir = path.join(tmpDir, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(
    path.join(specsDir, `${slug}.md`),
    `---\nid: null\nscmSpecId: "789"\nslug: ${slug}\ntitle: "Scm Spec Id Link"\nsource: github\nstatus: draft\n---\n\n# Specification — Scm Spec Id Link\n`,
    'utf8'
  );
  try {
    const link = sdwShipPr.resolveIssueLink(tmpDir, slug);
    assert.deepStrictEqual(link, { id: '789', provider: 'github', keyword: 'Closes #789', present: true },
      'the canonical scmSpecId drives the closing keyword even when the legacy id stays null');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC4, AC8, AC11: an Azure DevOps specification appends Fixes AB#<id>', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  writeIssueSpec(tmpDir, '00061-ado-link', { id: '456', source: 'azure-devops' });
  try {
    const link = sdwShipPr.resolveIssueLink(tmpDir, '00061-ado-link');
    assert.deepStrictEqual(link, { id: '456', provider: 'azure-devops', keyword: 'Fixes AB#456', present: true });

    const body = sdwShipPr.buildPrBody({
      specSlug: '00061-ado-link', head: 'feature/ado', base: 'master', commits: [], files: [], config, issueLink: link
    });
    assert.match(body, /^Fixes AB#456$/m, 'The Azure DevOps keyword is appended to the body');
    assert.doesNotMatch(body, /\bCloses\b/, 'The GitHub keyword is not emitted for Azure DevOps');

    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'feature/ado', base: 'master', specSlug: '00061-ado-link'
    });
    assert.strictEqual(report.success, true);
    assert.deepStrictEqual(report.issueLink, link);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - 00060 AC7 & AC14: slug resolution ignores a report companion', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-ship-pr-report-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    // The companion sorts first, so it shadows the specification unless the scan excludes it.
    fs.writeFileSync(
      path.join(specsDir, '00038-aaa-report.md'),
      '---\nid: 999\ntitle: "Delivery Report — Legacy"\nsource: azure-devops\n---\n\n# Delivery Report — Legacy\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(specsDir, '00038-zzz-spec.md'),
      '---\nid: 38\ntitle: "Spec Drift Repair"\nsource: azure-devops\n---\n\n# Specification — Spec Drift Repair\n',
      'utf8'
    );

    assert.equal(sdwShipPr.getSpecTitle(tmpDir, '00038-zzz-spec'), 'Spec Drift Repair', 'the title comes from the specification');
    const link = sdwShipPr.resolveIssueLink(tmpDir, '00038-zzz-spec');
    assert.equal(link.id, '38', 'the issue link comes from the specification, never the report');
    assert.equal(link.keyword, 'Fixes AB#38');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC5, AC8, AC11: a local specification omits the closing keyword', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  writeIssueSpec(tmpDir, '00062-local-link', { id: null, source: 'local' });
  try {
    const link = sdwShipPr.resolveIssueLink(tmpDir, '00062-local-link');
    assert.deepStrictEqual(link, { id: null, provider: 'local', keyword: null, present: false });

    const body = sdwShipPr.buildPrBody({
      specSlug: '00062-local-link', head: 'feature/local', base: 'master', commits: [], files: [], config, issueLink: link
    });
    assert.doesNotMatch(body, /(Closes|Fixes|Resolves)\s+(AB)?#\d+/, 'No closing keyword or placeholder is emitted');

    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'feature/local', base: 'master', specSlug: '00062-local-link'
    });
    assert.strictEqual(report.success, true);
    assert.deepStrictEqual(report.issueLink, link);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC6, AC11: a reused pull request body carries the closing keyword exactly once', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  writeIssueSpec(tmpDir, '00063-reuse-link', { id: '12', source: 'github' });
  let updatedBody = null;
  const fakeExecutor = (cmd) => {
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 77, url: 'https://example.test/pull/77', headRefName: 'feature/reuse', baseRefName: 'master', title: 'Existing PR' }]);
    }
    if (cmd.includes('gh pr view 77 --json body')) {
      return JSON.stringify({ body: 'Initial PR Body\n\nCloses #12\n\nResolves #3\n' });
    }
    if (cmd.includes('gh pr edit 77')) {
      const match = cmd.match(/--body-file "([^"]+)"/);
      if (match && fs.existsSync(match[1])) updatedBody = fs.readFileSync(match[1], 'utf8');
      return '';
    }
    return '';
  };
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'feature/reuse', base: 'master', specSlug: '00063-reuse-link'
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.pullRequest.reused, true);
    assert.deepStrictEqual(report.issueLink, { id: '12', provider: 'github', keyword: 'Closes #12', present: true });
    assert.ok(updatedBody, 'The reused PR body must be rewritten');
    assert.match(updatedBody, /Initial PR Body/, 'Existing content is preserved');
    assert.strictEqual((updatedBody.match(/^Closes #12$/gim) || []).length, 1, 'The keyword appears exactly once');
    assert.doesNotMatch(updatedBody, /Resolves #3/, 'Stale closing keywords are dropped');
    assert.doesNotMatch(updatedBody, /AB#/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC7, AC8, AC11: dry-run prints the assembled body and never creates or edits a PR', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  config.pushDelivery = true;
  writeIssueSpec(tmpDir, '00064-dry-link', { id: '99', source: 'github' });
  const fakeExecutor = fakeGithubExecutor();

  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  let report;
  try {
    report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'feature/dry', base: 'master', specSlug: '00064-dry-link', dryRun: true
    }, fakeExecutor);
  } finally {
    console.log = originalLog;
  }

  try {
    assert.strictEqual(report.success, true);
    assert.strictEqual(report.pullRequest.dryRun, true);
    assert.deepStrictEqual(report.issueLink, { id: '99', provider: 'github', keyword: 'Closes #99', present: true });
    const printed = lines.join('\n');
    assert.match(printed, /## Summary/, 'The dry-run output contains the assembled body');
    assert.match(printed, /Closes #99/, 'The printed body includes the closing keyword');
    assert.strictEqual(fakeExecutor.calls.some(c => c.includes('gh pr create')), false, 'Dry-run must not create a pull request');
    assert.strictEqual(fakeExecutor.calls.some(c => c.includes('gh pr edit')), false, 'Dry-run must not edit a pull request');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC9, AC11: missing, unreadable, or unsupported specifications skip the link and still ship', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  const empty = { id: null, provider: null, keyword: null, present: false };
  try {
    const missing = sdwShipPr.resolveIssueLink(tmpDir, '00065-missing-link');
    assert.deepStrictEqual(missing, empty);
    const missingReport = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'develop', base: 'master', specSlug: '00065-missing-link'
    });
    assert.strictEqual(missingReport.success, true, 'A missing specification never fails the ship');
    assert.deepStrictEqual(missingReport.issueLink, missing);

    writeIssueSpec(tmpDir, '00066-gitlab-link', { id: '9', source: 'gitlab' });
    const unsupported = sdwShipPr.resolveIssueLink(tmpDir, '00066-gitlab-link');
    assert.deepStrictEqual(unsupported, { id: '9', provider: 'gitlab', keyword: null, present: false });
    const unsupportedReport = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'develop', base: 'master', specSlug: '00066-gitlab-link'
    });
    assert.strictEqual(unsupportedReport.success, true, 'An unsupported provider never fails the ship');
    assert.strictEqual(unsupportedReport.issueLink.present, false);

    fs.mkdirSync(path.join(tmpDir, '.sdw', 'specs', '00067-unreadable-link.md'));
    const unreadable = sdwShipPr.resolveIssueLink(tmpDir, '00067-unreadable-link');
    assert.deepStrictEqual(unreadable, empty);
    const unreadableReport = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'develop', base: 'master', specSlug: '00067-unreadable-link'
    });
    assert.strictEqual(unreadableReport.success, true, 'An unreadable specification never fails the ship');
    assert.strictEqual(unreadableReport.issueLink.present, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC6, AC9, AC11: an unreadable reused PR body still appends exactly one keyword', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.scmProvider = 'github';
  writeIssueSpec(tmpDir, '00068-fallback-link', { id: '12', source: 'github' });
  let bodyReads = 0;
  let updatedBody = null;
  const fakeExecutor = (cmd) => {
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return '/usr/bin/gh';
    if (cmd.includes('gh auth status')) return 'Logged in';
    if (cmd.includes('gh pr list')) {
      return JSON.stringify([{ number: 88, url: 'https://example.test/pull/88', headRefName: 'feature/fallback', baseRefName: 'master' }]);
    }
    if (cmd.includes('gh pr view 88 --json body')) {
      bodyReads += 1;
      if (bodyReads === 1) throw new Error('body read failed');
      return JSON.stringify({ body: 'Existing description' });
    }
    if (cmd.includes('gh pr edit 88')) {
      const match = cmd.match(/--body-file "([^"]+)"/);
      if (match && fs.existsSync(match[1])) updatedBody = fs.readFileSync(match[1], 'utf8');
      return '';
    }
    return '';
  };
  try {
    const report = await sdwShipPr.runShipPr({
      projectRoot: tmpDir, config, head: 'feature/fallback', base: 'master', specSlug: '00068-fallback-link'
    }, fakeExecutor);

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.pullRequest.reused, true);
    assert.strictEqual(bodyReads, 2, 'The fallback re-reads the body through the provider append path');
    assert.ok(updatedBody, 'The amendment reaches the provider');
    assert.match(updatedBody, /Existing description/);
    assert.strictEqual((updatedBody.match(/^Closes #12$/gim) || []).length, 1, 'The fallback appends exactly one keyword');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC8, AC9, AC11: a failing ship reports issueLink in its failure JSON', async () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.prePrCommand = 'node -e "process.exit(1)"';
  writeIssueSpec(tmpDir, '00069-failure-link', { id: '321', source: 'github' });
  try {
    let captured = null;
    await assert.rejects(
      () => sdwShipPr.runShipPr({
        projectRoot: tmpDir, config, head: 'develop', base: 'master', specSlug: '00069-failure-link'
      }),
      (err) => { captured = err; return /prePrCommand failed/.test(err.message); }
    );
    assert.ok(captured.report, 'The partial report is attached to the error');
    assert.deepStrictEqual(captured.report.issueLink, { id: '321', provider: 'github', keyword: 'Closes #321', present: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-ship-pr - AC8, AC11: CLI failure JSON includes issueLink', () => {
  const { tmpDir, config } = setupTestWorkspace();
  config.prePrCommand = 'node -e "process.exit(1)"';
  writeIssueSpec(tmpDir, '00070-cli-failure', { id: '654', source: 'azure-devops' });
  fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  const scriptPath = path.resolve(__dirname, '../skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs');
  try {
    let stdout = '';
    try {
      execSync(`node "${scriptPath}" --spec 00070-cli-failure --json`, {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      stdout = err.stdout || '';
    }
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.success, false);
    assert.match(parsed.error, /prePrCommand failed/);
    assert.deepStrictEqual(parsed.issueLink, { id: '654', provider: 'azure-devops', keyword: 'Fixes AB#654', present: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const LONG_REVIEW_COMMENT_BODY = [
  'Missing null check in the response parser.',
  '',
  '```js',
  'const value = payload.items[0].id;',
  '```',
  '',
  'Suggested correction: guard `payload.items` before indexing.',
  '',
  'The reviewer explained the scenario, the missing protection, and the suggested fix in the same comment; cutting this text would remove the reasoning the fixer needs to repair the defect instead of only its title.',
  'This final paragraph exists so the body runs past the eighty-character line the old renderer printed and past any fixed-length cut applied to a single comment.'
].join('\n');

const SHORT_REVIEW_COMMENTS = [
  {
    body: 'Applied the null guard in abc1234.\n\nRegression test added in tests/parser.test.js.',
    author: 'author-two',
    createdAt: '2026-01-03T04:05:06Z'
  },
  {
    body: 'Confirmed on the latest run.',
    author: 'reviewer-one',
    createdAt: '2026-01-04T05:06:07Z'
  }
];

function listThreadsGraphQlNodes() {
  return [
    {
      id: 'PRRT_full',
      isResolved: false,
      path: 'src/parser.js',
      line: 42,
      comments: {
        nodes: [
          {
            id: 'PRRC_1',
            databaseId: 101,
            body: LONG_REVIEW_COMMENT_BODY,
            author: { login: 'reviewer-one' },
            createdAt: '2026-01-02T03:04:05Z'
          },
          {
            id: 'PRRC_2',
            databaseId: 102,
            body: SHORT_REVIEW_COMMENTS[0].body,
            author: { login: SHORT_REVIEW_COMMENTS[0].author },
            createdAt: SHORT_REVIEW_COMMENTS[0].createdAt
          },
          {
            id: 'PRRC_3',
            databaseId: 103,
            body: SHORT_REVIEW_COMMENTS[1].body,
            author: { login: SHORT_REVIEW_COMMENTS[1].author },
            createdAt: SHORT_REVIEW_COMMENTS[1].createdAt
          }
        ]
      }
    },
    {
      id: 'PRRT_empty',
      isResolved: true,
      path: 'src/empty.js',
      line: 7,
      comments: { nodes: [] }
    }
  ];
}

/**
 * Runs the real CLI `list-threads` command with a preloaded `gh` stub, so the
 * test proves stdout, exit code, and the provider-to-renderer path together.
 */
function runListThreadsCli(threadNodes, extraArgs = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-list-threads-'));
  fs.mkdirSync(path.join(tmpDir, '.sdw'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.sdw', 'config.json'),
    JSON.stringify({ scmProvider: 'github' }, null, 2),
    'utf8'
  );
  const preloadPath = path.join(tmpDir, 'stub-gh.cjs');
  const graphQlPayload = JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { nodes: threadNodes } } } }
  });
  fs.writeFileSync(preloadPath, [
    "'use strict';",
    "const childProcess = require('child_process');",
    'const realExecSync = childProcess.execSync;',
    `const graphQlPayload = ${JSON.stringify(graphQlPayload)};`,
    'childProcess.execSync = function (command, options) {',
    '  const cmd = String(command);',
    "  if (cmd.includes('gh repo view')) return JSON.stringify({ owner: { login: 'owner' }, name: 'repo' });",
    "  if (cmd.includes('gh api graphql')) return graphQlPayload;",
    '  return realExecSync.call(childProcess, command, options);',
    '};',
    ''
  ].join('\n'), 'utf8');

  const scriptPath = path.resolve(__dirname, '../skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs');
  try {
    return spawnSync(process.execPath, [
      '--require', preloadPath, scriptPath, 'list-threads', '--pr', '42', ...extraArgs
    ], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 60000
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('sdw-ship-pr - 00059 AC1, AC2, AC4: list-threads prints every comment with its full body, author, and timestamp', () => {
  assert.ok(LONG_REVIEW_COMMENT_BODY.length > 300, 'the fixture body is long enough to expose a truncating renderer');
  const run = runListThreadsCli(listThreadsGraphQlNodes());

  assert.strictEqual(run.status, 0, run.stderr);
  const stdout = run.stdout;
  const comments = [
    { body: LONG_REVIEW_COMMENT_BODY, author: 'reviewer-one', createdAt: '2026-01-02T03:04:05Z' },
    ...SHORT_REVIEW_COMMENTS
  ];

  for (const comment of comments) {
    assert.ok(stdout.includes(comment.body), `comment body prints in full: ${comment.body.slice(0, 48)}`);
    const metaLine = stdout.split('\n').find(line => line.includes(comment.author) && line.includes(comment.createdAt));
    assert.ok(metaLine, `author ${comment.author} and timestamp ${comment.createdAt} print for their comment`);
  }

  const positions = comments.map(comment => stdout.indexOf(comment.body));
  assert.deepStrictEqual([...positions].sort((a, b) => a - b), positions, 'comments print in chronological order');
});

test('sdw-ship-pr - 00059 AC3, AC4: list-threads --json emits every comment body, author, and timestamp', () => {
  const run = runListThreadsCli(listThreadsGraphQlNodes(), ['--json']);

  assert.strictEqual(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.strictEqual(payload.threads.length, 2);
  assert.strictEqual(payload.threads[0].comments.length, 3);
  assert.strictEqual(payload.threads[0].comments[0].body, LONG_REVIEW_COMMENT_BODY, 'the JSON body is byte-for-byte complete');
  assert.deepStrictEqual(
    payload.threads[0].comments.slice(1).map(comment => ({ body: comment.body, author: comment.author, createdAt: comment.createdAt })),
    SHORT_REVIEW_COMMENTS
  );
  assert.deepStrictEqual(payload.threads[1].comments, []);
});

test('sdw-ship-pr - 00059 AC5: a thread without comments prints a placeholder and still exits 0', () => {
  const run = runListThreadsCli([listThreadsGraphQlNodes()[1]]);

  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(run.stdout, /\[RESOLVED\] Thread PRRT_empty \[src\/empty\.js:7\] · 0 comment\(s\)\n +\(no comments\)/);
});

test('sdw-ship-pr - 00059 AC6: consecutive comments and consecutive threads are separated so long threads stay readable', () => {
  const text = sdwShipPr.formatThreadsReport({
    activeCount: 1,
    threads: [
      {
        id: 'T1',
        path: 'a.js',
        line: 2,
        isResolved: false,
        comments: [
          { body: 'first body', author: 'r1', createdAt: '2026-01-01T00:00:00Z' },
          { body: 'second body\nwith a second line', author: 'r2', createdAt: '2026-01-02T00:00:00Z' }
        ]
      },
      {
        id: 'T2',
        path: 'b.js',
        line: 3,
        isResolved: true,
        comments: [{ body: 'resolved body', author: 'r3', createdAt: '2026-01-03T00:00:00Z' }]
      }
    ]
  }, '42');

  assert.ok(text.includes('Thread T1 [a.js:2] · 2 comment(s)\n\n    comment 1/2'), 'a blank line separates the thread header from its first comment');
  assert.ok(text.includes('first body\n\n    comment 2/2 · r2 · 2026-01-02T00:00:00Z'), 'a blank line separates consecutive comments');
  assert.ok(text.includes('with a second line\n\n  - [RESOLVED] Thread T2'), 'a blank line separates consecutive threads');
  assert.strictEqual(text.includes('undefined'), false, 'the header renders real counts');
});

test('sdw-ship-pr - 00059 AC8: each thread header prints resolution status, id, path, line, and comment count', () => {
  const run = runListThreadsCli(listThreadsGraphQlNodes());

  assert.strictEqual(run.status, 0, run.stderr);
  assert.ok(
    run.stdout.includes('[ACTIVE] Thread PRRT_full [src/parser.js:42] · 3 comment(s)'),
    `the active thread header carries every field: ${run.stdout}`
  );
  assert.ok(
    run.stdout.includes('[RESOLVED] Thread PRRT_empty [src/empty.js:7] · 0 comment(s)'),
    `the resolved empty thread header carries every field: ${run.stdout}`
  );
});

test('sdw-ship-pr - 00059 AC7, AC11: the default fixer finding carries every comment body verbatim in chronological order', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fixer-findings-'));
  try {
    const fixerScript = path.join(tmpDir, 'skills', 'sdw-fixer', 'scripts', 'sdw_fixer.cjs');
    fs.mkdirSync(path.dirname(fixerScript), { recursive: true });
    fs.writeFileSync(fixerScript, '// stub fixer entrypoint\n', 'utf8');

    const comments = [
      { body: LONG_REVIEW_COMMENT_BODY, author: 'reviewer-one', createdAt: '2026-01-02T03:04:05Z' },
      ...SHORT_REVIEW_COMMENTS
    ];
    const built = sdwShipPr.buildDefaultFixerCommand(tmpDir, [
      {
        id: 'PRRT_full',
        isResolved: false,
        path: 'src/parser.js',
        line: 42,
        comments
      },
      {
        id: 'PRRT_empty',
        isResolved: false,
        path: 'src/empty.js',
        line: 7,
        comments: []
      }
    ]);

    assert.ok(built, 'the fixer command is built for active threads');
    const findings = JSON.parse(fs.readFileSync(built.findingsPath, 'utf8'));
    const full = findings.findings.find(finding => finding.threadId === 'PRRT_full');
    assert.ok(full, 'one finding is built per active thread');
    assert.strictEqual(
      full.evidence,
      comments.map(comment => comment.body).join('\n\n'),
      'the evidence is every comment body in chronological order, with nothing cut'
    );
    assert.ok(
      full.evidence.length > 500,
      'the evidence runs past the 500-character cut the old builder applied'
    );
    assert.ok(
      full.evidence.includes('Suggested correction: guard `payload.items` before indexing.'),
      'text past 80 characters survives into the finding'
    );
    assert.strictEqual(
      findings.findings.find(finding => finding.threadId === 'PRRT_empty').evidence,
      'Review feedback',
      'a thread without comment text keeps the fallback evidence'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

