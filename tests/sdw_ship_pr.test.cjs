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
      maxIterations: 1
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


