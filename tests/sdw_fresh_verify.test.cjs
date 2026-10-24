'use strict';

// Spec 00018 AC1-AC4: fresh-context verification. The tests exercise the module
// boundary (scratch lifecycle, prompt fencing, verdict validation) and the CLI
// boundary (exit codes, run-state recording, opt-in Step 4 -> 5 transition)
// against temp git repositories only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const freshVerify = require('../skills/sdw-orch/scripts/fresh_verify.cjs');
const auditRunner = require('../skills/sdw-orch/scripts/audit_runner.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwRules = require('../skills/sdw-rules/scripts/sdw_rules.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');

// Spec 027: the resumed run must clear Step 5 without an interactive judge.
require('./fixtures/judge_env.cjs').installJudgeEnv();

const ORCH_CLI = path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');

const SPEC_BODY = `---
slug: fresh-spec
title: Fresh Verify Spec
---
# Fresh Verify Spec

## Acceptance Criteria

- AC1: The system shall write a run state file.
- AC2: The system shall resume from that file.
## New files
\`src/fresh_spec.cjs\` — created by this work.
`;

function git(root, command) {
  return execSync(`git ${command}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setupRepo(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fv-test-'));
  git(root, 'init -q');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "SDW Test"');
  fs.writeFileSync(path.join(root, 'app.cjs'), options.appFile || '// baseline\n', 'utf8');
  for (const [relPath, content] of Object.entries(options.files || {})) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }
  git(root, 'add -A');
  git(root, 'commit -qm baseline');
  return { root, baseCommit: git(root, 'rev-parse HEAD') };
}

// Builds an SDW workspace: .sdw scaffold, spec, git baseline, and a recorded
// delivery diff (the tracked app.cjs change after the base commit).
function setupWorkspace(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fv-ws-'));
  sdwConfig.cmdInit({ root, force: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.sdw/state/\n.sdw/worktrees/\n.sdw/sandbox/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'app.cjs'), '// baseline\n', 'utf8');
  fs.writeFileSync(path.join(root, '.sdw', 'specs', 'fresh-spec.md'), options.specBody || SPEC_BODY, 'utf8');
  for (const [relPath, content] of Object.entries(options.baselineFiles || {})) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }

  const configPath = path.join(root, '.sdw', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (options.freshVerifyEnabled) {
    config.verification = { ...(config.verification || {}), freshVerifyEnabled: true };
  }
  if (options.testCommand) {
    config.verification = { ...(config.verification || {}), testCommand: options.testCommand };
  }
  if (options.freshVerifyCommand) {
    config.verification = { ...(config.verification || {}), freshVerifyCommand: options.freshVerifyCommand };
  }
  if (options.implementation) {
    config.implementation = options.implementation;
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  git(root, 'init -q');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "SDW Test"');
  git(root, 'add -A');
  git(root, 'commit -qm baseline');
  const baseCommit = git(root, 'rev-parse HEAD');

  let runId = null;
  if (options.createState) {
    const state = stateManager.createRunState({
      root,
      specPath: '.sdw/specs/fresh-spec.md',
      slug: 'fresh-spec',
      baseCommit
    });
    runId = state.runId;
    // Context sources that must never reach the verifier prompt.
    state.dagTasks = [{ id: 'task-1', title: 'DAG-PROMPT-MARKER', coveredAcs: ['AC1', 'AC2'] }];
    state.freshVerifyTestMarkers = ['RUN-STATE-MARKER'];
    state.steps[4].status = 'completed';
    state.steps[4].tasks = {
      'task-1': {
        id: 'task-1',
        status: 'completed',
        summary: 'IMPLEMENTATION-TRANSCRIPT-MARKER',
        acIds: ['AC1', 'AC2']
      }
    };
    stateManager.saveRunState(root, state);
  }

  return { root, baseCommit, runId };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [ORCH_CLI, ...args, '--root', root], {
    cwd: root,
    encoding: 'utf8'
  });
}

function latestState(root) {
  return stateManager.findLatestRunState(root);
}

test('AC2: scratch worktree is created from the delivery diff and removed', () => {
  const { root, baseCommit } = setupRepo();
  const scratchDir = freshVerify.resolveScratchDir(root, 'run-fv-scratch');
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const diff = freshVerify.collectDeliveryDiff(root, baseCommit);
    assert.ok(diff.text.includes('+// implemented'), 'the delivery diff contains the working-tree change');
    assert.ok(diff.bytes > 0);

    const scratch = freshVerify.createScratchWorktree({
      projectRoot: root,
      baseCommit,
      diff: diff.text,
      scratchDir
    });
    assert.equal(scratch.rel, '.sdw/worktrees/run-fv-scratch/fresh-verify');
    assert.equal(scratch.baseCommit, baseCommit);
    assert.equal(scratch.diffApplied, true);
    assert.ok(fs.existsSync(scratch.path), 'scratch worktree exists');
    assert.ok(
      fs.readFileSync(path.join(scratch.path, 'app.cjs'), 'utf8').includes('// implemented'),
      'the delivery diff was applied inside the scratch worktree'
    );

    const cleanup = freshVerify.removeScratchWorktree({ projectRoot: root, worktreePath: scratch.path });
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.removed, true);
    assert.equal(fs.existsSync(scratch.path), false, 'scratch worktree removed');
    assert.ok(!git(root, 'worktree list').includes('fresh-verify'), 'git no longer tracks the scratch worktree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: an uncreatable scratch worktree fails closed and leaves nothing behind', () => {
  const { root } = setupRepo();
  const scratchDir = freshVerify.resolveScratchDir(root, 'run-fv-fail');
  try {
    assert.throws(
      () => freshVerify.createScratchWorktree({
        projectRoot: root,
        baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        diff: '',
        scratchDir
      }),
      err => err.name === 'FreshVerifyError' && err.code === 'scratch_worktree_failed'
    );
    assert.equal(fs.existsSync(scratchDir), false, 'no half-created worktree survives the failure');

    // A failure after creation (here: the prompt path cannot be written) must
    // remove the worktree before rethrowing.
    const artifactsDir = path.join(root, '.sdw', 'state', 'fresh-spec', 'run-fv-prompt');
    fs.mkdirSync(path.join(artifactsDir, freshVerify.PROMPT_FILE_NAME), { recursive: true });
    assert.throws(
      () => freshVerify.startVerification({
        projectRoot: root,
        runId: 'run-fv-prompt',
        criteria: [{ id: 'AC1', text: 'The system shall fail closed.' }],
        baseCommit: 'HEAD',
        artifactsDir,
        scratchDir: freshVerify.resolveScratchDir(root, 'run-fv-prompt')
      }),
      err => err.name === 'FreshVerifyError' && err.code === 'prompt_write_failed'
    );
    assert.equal(
      fs.existsSync(freshVerify.resolveScratchDir(root, 'run-fv-prompt')),
      false,
      'the scratch worktree is removed when the prompt cannot be written'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC17: an uncreatable scratch worktree fails closed without scoring', () => {
  // Module boundary: `git worktree add` must fail with the attempted path and
  // the git failure in the message, not an opaque status.
  const { root } = setupRepo();
  const scratchDir = freshVerify.resolveScratchDir(root, 'run-ac17-module');
  try {
    assert.throws(
      () => freshVerify.createScratchWorktree({
        projectRoot: root,
        baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        diff: '',
        scratchDir
      }),
      err => err.name === 'FreshVerifyError'
        && err.code === 'scratch_worktree_failed'
        && err.message.includes(freshVerify.normalizePath(scratchDir))
        && /fatal:|error:/i.test(err.message)
    );
    assert.equal(fs.existsSync(scratchDir), false, 'the failed attempt leaves no scratch worktree');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Run boundary: a tree-ish base commit passes `git diff` but cannot be
  // checked out, so creation fails inside the Step 4 -> 5 transition. The run
  // records the failure and Step 5 never scores.
  const workspace = setupWorkspace({ createState: true });
  try {
    fs.appendFileSync(path.join(workspace.root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(workspace.root).runId;
    const treeSha = git(workspace.root, 'rev-parse "HEAD^{tree}"');
    const state = latestState(workspace.root);
    state.baseCommit = treeSha;
    stateManager.saveRunState(workspace.root, state);

    const result = sdwOrch.runFreshVerifyTransition(workspace.root, latestState(workspace.root), {
      verification: { freshVerifyEnabled: true }
    }, {});
    assert.equal(result.code, 1, 'the run exits non-zero instead of scoring');

    const failed = latestState(workspace.root);
    const attempted = freshVerify.normalizePath(freshVerify.resolveScratchDir(workspace.root, runId));
    assert.equal(failed.status, 'failed', 'the run state records the failure');
    assert.equal(failed.freshVerify.status, 'failed');
    assert.equal(failed.freshVerify.errorCode, 'scratch_worktree_failed');
    assert.ok(failed.freshVerify.error.includes(attempted), 'the error names the attempted worktree path');
    assert.match(failed.freshVerify.error, /is a tree, not a commit|invalid reference|fatal:/i, 'the error names the git failure');
    assert.equal(failed.steps[5].status, 'pending', 'Step 5 scoring never enters');
    assert.equal(fs.existsSync(attempted), false, 'no scratch worktree survives the failure');

    const cli = runCli(workspace.root, ['fresh-verify', '--run-id', runId]);
    assert.equal(cli.status, 1, 'the fresh-verify exit code reflects the failure');
    assert.match(cli.stderr, /Scratch worktree creation failed/);
    assert.ok(cli.stderr.includes(attempted), 'the CLI error names the attempted path');
    assert.match(cli.stderr, /is a tree, not a commit|invalid reference|fatal:/i, 'the CLI error carries the git failure');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC3: the verifier prompt carries only the acceptance criteria and the diff', () => {
  const criteria = [
    { id: 'AC1', text: 'The system shall write a run state file.' },
    { id: 'AC2', text: 'The system shall resume from that file.' }
  ];
  const diff = 'diff --git a/app.cjs b/app.cjs\n+++ b/app.cjs\n+// implemented';
  const prompt = freshVerify.renderVerifierPrompt({ criteria, diff });

  assert.match(prompt, /## Acceptance Criteria \(2\)/);
  assert.match(prompt, /- AC1: The system shall write a run state file\./);
  assert.match(prompt, /- AC2: The system shall resume from that file\./);
  assert.match(prompt, /## Delivery Diff/);
  assert.ok(prompt.includes('+// implemented'), 'the diff is inlined');
  for (const marker of [
    'IMPLEMENTATION-TRANSCRIPT-MARKER',
    'WORKER-REASONING-MARKER',
    'DAG-PROMPT-MARKER',
    'JUDGE-VERDICT-MARKER',
    'RUN-STATE-MARKER'
  ]) {
    assert.ok(!prompt.includes(marker), `${marker} is excluded from the verifier context`);
  }

  // The fence refuses extra context instead of silently dropping it.
  for (const key of ['transcript', 'workerReasoning', 'dagPrompt', 'judgeVerdict', 'runState']) {
    assert.throws(
      () => freshVerify.renderVerifierPrompt({ criteria, diff, [key]: 'LEAK' }),
      err => err.name === 'FreshVerifyError'
        && err.code === 'context_fence_violation'
        && err.message.includes(key)
    );
  }
});

test('AC4: exactly one verdict per acceptance criterion with verified or unverified', () => {
  const criteria = [
    { id: 'AC1', text: 'one' },
    { id: 'AC2', text: 'two' },
    { id: 'AC3', text: 'three' }
  ];

  const valid = freshVerify.validateVerdict({
    criteria: [
      { id: 'AC1', verdict: 'verified' },
      { id: 'AC2', verdict: 'unverified' },
      { id: 'AC3', verdict: 'verified' }
    ],
    residualDefects: []
  }, criteria);
  assert.equal(valid.valid, true, valid.errors.join(' '));
  assert.equal(valid.verdicts.length, 3);

  const missing = freshVerify.validateVerdict({
    criteria: [{ id: 'AC1', verdict: 'verified' }, { id: 'AC2', verdict: 'verified' }]
  }, criteria);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(error => /Missing verdict for AC3/.test(error)), 'the missing AC is named');

  const duplicate = freshVerify.validateVerdict({
    criteria: [
      { id: 'AC1', verdict: 'verified' },
      { id: 'AC1', verdict: 'unverified' },
      { id: 'AC2', verdict: 'verified' },
      { id: 'AC3', verdict: 'verified' }
    ]
  }, criteria);
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some(error => /Duplicate verdict for AC1/.test(error)), 'the duplicate is named');

  const invalidValue = freshVerify.validateVerdict({
    criteria: [
      { id: 'AC1', verdict: 'verified' },
      { id: 'AC2', verdict: 'maybe' },
      { id: 'AC3', verdict: 'verified' }
    ]
  }, criteria);
  assert.equal(invalidValue.valid, false);
  assert.ok(
    invalidValue.errors.some(error => /Invalid verdict value for AC2/.test(error) && /maybe/.test(error)),
    'the invalid value and its AC are named'
  );

  const wrongCase = freshVerify.validateVerdict({
    criteria: [
      { id: 'AC1', verdict: 'Verified' },
      { id: 'AC2', verdict: 'unverified' },
      { id: 'AC3', verdict: 'verified' }
    ]
  }, criteria);
  assert.equal(wrongCase.valid, false, 'only the exact values verified and unverified are accepted');

  const unknown = freshVerify.validateVerdict({
    criteria: [
      { id: 'AC1', verdict: 'verified' },
      { id: 'AC2', verdict: 'verified' },
      { id: 'AC3', verdict: 'verified' },
      { id: 'AC9', verdict: 'verified' }
    ]
  }, criteria);
  assert.equal(unknown.valid, false);
  assert.ok(unknown.errors.some(error => /unknown acceptance criterion "AC9"/.test(error)));

  assert.equal(freshVerify.validateVerdict([], criteria).valid, false, 'a non-object verdict is rejected');
});

test('AC1: fresh verification is opt-in through verification.freshVerifyEnabled (default false)', () => {
  assert.equal(sdwConfig.DEFAULT_CONFIG.verification.freshVerifyEnabled, false);
  assert.equal(
    sdwConfig.DEFAULT_SCHEMA.properties.verification.properties.freshVerifyEnabled.default,
    false
  );

  const invalid = sdwConfig.validateConfigSchema({
    specsDir: '{projectRoot}/.sdw/specs',
    verification: { freshVerifyEnabled: 'yes' }
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => error.includes('freshVerifyEnabled') && error.includes('boolean')));

  const repoSchema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.sdw', 'config.schema.json'), 'utf8'));
  assert.equal(repoSchema.properties.verification.properties.freshVerifyEnabled.default, false);
  const repoConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.sdw', 'config.json'), 'utf8'));
  assert.equal(repoConfig.verification.freshVerifyEnabled, false);
  const reference = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-config', 'references', 'config_spec.md'), 'utf8');
  assert.match(reference, /\|\s*`verification\.freshVerifyEnabled`\s*\|/);
  assert.match(reference, /"freshVerifyEnabled": false/);

  const parsed = sdwOrch.parseArgs(['fresh-verify', '--run-id', 'run-x', '--verdict', 'verdict.json']);
  assert.equal(parsed.subcommand, 'fresh-verify');
  assert.equal(parsed.runId, 'run-x');
  assert.equal(parsed.verdictPath, 'verdict.json');

  // Disabled: the Step 4 -> 5 transition is a no-op that writes nothing.
  const { root, baseCommit } = setupWorkspace({ createState: true });
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const state = latestState(root);
    const statePath = stateManager.getStateFilePath(root, state.runId);
    const before = fs.readFileSync(statePath, 'utf8');
    const result = sdwOrch.runFreshVerifyTransition(root, state, { verification: { freshVerifyEnabled: false } }, {});
    assert.equal(result.code, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.state, state, 'the state object is not mutated');
    assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'no state write happens while disabled');
    assert.equal(fs.existsSync(freshVerify.resolveScratchDir(root, state.runId)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC1-AC4: fresh-verify CLI creates a fenced scratch, rejects bad verdicts, and cleans up', () => {
  const verifyFile = [
    "'use strict';",
    "const fs = require('fs');",
    "if (!fs.readFileSync('app.cjs', 'utf8').includes('// implemented')) process.exit(1);",
    ''
  ].join('\n');
  const { root } = setupWorkspace({
    createState: true,
    testCommand: 'node verify.cjs',
    baselineFiles: { 'verify.cjs': verifyFile }
  });
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(root).runId;
    const faultsFile = path.join(root, 'faults.json');
    fs.writeFileSync(faultsFile, JSON.stringify([
      { acId: 'AC1', file: 'app.cjs', find: '// implemented', replace: '// fault' },
      { acId: 'AC2', file: 'app.cjs', find: '// implemented', replace: '// fault' }
    ]), 'utf8');

    const started = runCli(root, ['fresh-verify', '--run-id', runId, '--faults', faultsFile]);
    assert.equal(started.status, 4, `expected the awaiting-verdict exit code; stderr: ${started.stderr}`);
    let state = latestState(root);
    assert.equal(state.freshVerify.status, 'awaiting_verdict');
    assert.equal(state.freshVerify.round, 1);
    assert.equal(state.status, 'paused');
    assert.ok(state.freshVerify.scratch.path.endsWith('/fresh-verify'));
    assert.ok(fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)), 'scratch worktree recorded on state exists');

    const prompt = fs.readFileSync(path.resolve(root, state.freshVerify.promptPath), 'utf8');
    assert.ok(prompt.includes('- AC1: The system shall write a run state file.'));
    assert.ok(prompt.includes('- AC2: The system shall resume from that file.'));
    assert.ok(prompt.includes('+// implemented'), 'the delivery diff is inlined');
    for (const marker of ['IMPLEMENTATION-TRANSCRIPT-MARKER', 'DAG-PROMPT-MARKER', 'RUN-STATE-MARKER']) {
      assert.ok(!prompt.includes(marker), `${marker} never reaches the verifier prompt`);
    }

    const badVerdict = path.join(root, 'bad-verdict.json');
    fs.writeFileSync(badVerdict, JSON.stringify({
      criteria: [
        { id: 'AC1', verdict: 'verified' },
        { id: 'AC1', verdict: 'unverified' }
      ]
    }), 'utf8');
    const rejected = runCli(root, ['fresh-verify', '--run-id', runId, '--verdict', badVerdict]);
    assert.equal(rejected.status, 1, 'a defective verdict is rejected');
    assert.match(rejected.stderr, /Duplicate verdict for AC1/);
    assert.match(rejected.stderr, /Missing verdict for AC2/);
    state = latestState(root);
    assert.equal(state.freshVerify.status, 'failed');
    assert.equal(
      fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)),
      false,
      'the scratch worktree is removed on verdict rejection'
    );

    const restarted = runCli(root, ['fresh-verify', '--run-id', runId, '--faults', faultsFile]);
    assert.equal(restarted.status, 4, 'a failed verification can start a new round');
    state = latestState(root);
    assert.equal(state.freshVerify.round, 2);
    assert.ok(fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)));

    const goodVerdict = path.join(root, 'good-verdict.json');
    fs.writeFileSync(goodVerdict, JSON.stringify({
      criteria: [
        { id: 'AC1', verdict: 'verified' },
        { id: 'AC2', verdict: 'verified' }
      ],
      residualDefects: []
    }), 'utf8');
    const accepted = runCli(root, ['fresh-verify', '--run-id', runId, '--verdict', goodVerdict]);
    assert.equal(accepted.status, 0, `expected acceptance; stderr: ${accepted.stderr}`);
    state = latestState(root);
    assert.equal(state.freshVerify.status, 'completed');
    assert.equal(state.freshVerify.verdicts.length, 2);
    assert.equal(state.freshVerify.cleanup.removed, true);
    assert.equal(fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)), false, 'cleanup on success');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: the opt-in transition fails closed when the scratch worktree cannot be created', () => {
  const { root } = setupWorkspace({ createState: true });
  const scratchDir = freshVerify.resolveScratchDir(root, latestState(root).runId);
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    // A path that cannot be used as a worktree: `git worktree add` must not run.
    fs.mkdirSync(scratchDir, { recursive: true });
    const state = latestState(root);
    const result = sdwOrch.runFreshVerifyTransition(root, state, { verification: { freshVerifyEnabled: true } }, {});
    assert.equal(result.code, 1, 'the transition returns a failing exit code');
    const failed = stateManager.loadRunState(root, state.runId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.freshVerify.status, 'failed');
    assert.equal(failed.steps[5].status, 'pending', 'Step 5 scoring never starts');
    assert.match(failed.freshVerify.error, /already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC1-AC4: the Step 4 -> 5 transition pauses on unverified verdicts and never scores', () => {
  const implementationScript = [
    "const fs = require('fs');",
    "fs.appendFileSync('app.cjs', '// implemented\\n');",
    'fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({',
    '  taskId: process.env.SDW_TASK_ID,',
    "  status: 'success',",
    "  acIds: ['AC1', 'AC2'],",
    "  filesChanged: ['app.cjs'],",
    '  tests: [],',
    "  summary: 'implemented app.cjs'",
    '}));'
  ].join(' ');
  const { root } = setupWorkspace({
    freshVerifyEnabled: true,
    implementation: {
      mode: 'command',
      command: `node -e "${implementationScript.replace(/"/g, '\\"')}"`
    }
  });
  try {
    const first = sdwOrch.cmdRun({
      root,
      specPath: '.sdw/specs/fresh-spec.md',
      skipReview: true,
      skipPr: true,
      minScore: 0
    });
    assert.equal(first, 4, 'the run pauses for the fresh-context verifier before scoring');

    let state = latestState(root);
    assert.equal(state.steps[4].status, 'completed', 'Step 4 evidence was accepted before the transition');
    assert.equal(state.steps[5].status, 'pending', 'Step 5 scoring has not started');
    assert.equal(state.freshVerify.status, 'awaiting_verdict');
    assert.ok(fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)));

    const prompt = fs.readFileSync(path.resolve(root, state.freshVerify.promptPath), 'utf8');
    assert.ok(prompt.includes('- AC1: The system shall write a run state file.'));
    assert.ok(prompt.includes('+// implemented'));
    assert.ok(!prompt.includes('implemented app.cjs'), 'the worker evidence summary is fenced out');

    const verdict = path.join(root, 'verdict.json');
    fs.writeFileSync(verdict, JSON.stringify({
      criteria: [
        { id: 'AC1', verdict: 'verified' },
        { id: 'AC2', verdict: 'verified' }
      ]
    }), 'utf8');
    const submitted = runCli(root, ['fresh-verify', '--run-id', state.runId, '--verdict', verdict]);
    assert.equal(submitted.status, 4, `unverified verdicts keep the run paused: ${submitted.stderr}`);
    assert.match(submitted.stdout, /remain unverified/);
    let afterSubmit = stateManager.loadRunState(root, state.runId);
    assert.equal(afterSubmit.freshVerify.status, 'awaiting_fix', 'the round is parked for a fix');
    assert.equal(afterSubmit.status, 'paused');
    assert.equal(afterSubmit.steps[5].status, 'pending', 'Step 5 never starts on unverified criteria');

    const resumed = sdwOrch.cmdResume({
      root,
      runId: state.runId,
      skipReview: true,
      skipPr: true,
      minScore: 0
    });
    assert.equal(resumed, 4, 'resume keeps the run paused instead of scoring');

    state = stateManager.loadRunState(root, state.runId);
    assert.equal(state.steps[5].status, 'pending', 'Step 5 scoring never starts');
    assert.equal(state.freshVerify.status, 'awaiting_fix');
    assert.equal(fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)), false, 'no scratch worktree survives');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC18: command mode substitutes and shell-quotes the four documented tokens', () => {
  const tokens = {
    promptFile: 'C:/tmp/fresh run/fresh-verify.prompt.md',
    evidenceFile: 'C:/tmp/fresh run/fresh-verify.verdict.json',
    cwd: 'C:/tmp/fresh run/fresh-verify',
    slug: 'fresh-spec'
  };
  const rendered = freshVerify.renderFreshVerifyCommand(
    'node verifier.cjs {promptFile} {evidenceFile} {cwd} {slug} {taskId}',
    tokens
  );
  assert.equal(freshVerify.COMMAND_TOKENS.join(','), 'promptFile,evidenceFile,cwd,slug');
  const quoted = value => (process.platform === 'win32' ? `"${value}"` : `'${value}'`);
  for (const token of freshVerify.COMMAND_TOKENS) {
    assert.ok(rendered.includes(quoted(tokens[token])), `${token} is substituted and shell-quoted`);
  }
  assert.ok(rendered.includes('{taskId}'), 'an unknown token is left untouched, never rewritten');
  assert.equal(
    freshVerify.renderFreshVerifyCommand('node verifier.cjs {slug}', {}),
    'node verifier.cjs {slug}',
    'a token without a value stays literal'
  );

  if (process.platform === 'win32') {
    assert.throws(
      () => freshVerify.quoteCommandValue('unsafe"value'),
      err => err.name === 'FreshVerifyError' && err.code === 'fresh_verify_command_invalid'
    );
  } else {
    assert.equal(freshVerify.quoteCommandValue("it's"), "'it'\\''s'", 'POSIX single quotes are escaped');
  }
});

test('AC18: command execution captures the exit status and a bounded output excerpt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fv-command-'));
  try {
    const failed = freshVerify.runFreshVerifyCommand({
      command: 'node -e "console.error(\'VERIFIER-BOOM\');process.exit(7)"',
      cwd: dir,
      promptFile: path.join(dir, 'fresh-verify.prompt.md'),
      evidenceFile: path.join(dir, 'fresh-verify.verdict.json'),
      slug: 'fresh-spec'
    });
    assert.equal(failed.passed, false);
    assert.equal(failed.exitCode, 7);
    assert.match(failed.outputTail, /VERIFIER-BOOM/);
    assert.match(freshVerify.describeCommandObservation(failed), /exited 7: VERIFIER-BOOM/);

    const passed = freshVerify.runFreshVerifyCommand({
      command: 'node -e "process.exit(0)"',
      cwd: dir,
      promptFile: path.join(dir, 'fresh-verify.prompt.md'),
      evidenceFile: path.join(dir, 'fresh-verify.verdict.json'),
      slug: 'fresh-spec'
    });
    assert.equal(passed.passed, true);
    assert.equal(passed.exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC18: command mode runs the verifier inside the scratch worktree and consumes {evidenceFile}', () => {
  const verifierFile = [
    "'use strict';",
    "const fs = require('fs');",
    'const [promptFile, evidenceFile, commandCwd, slug, unknown] = process.argv.slice(2);',
    "if (!fs.readFileSync(promptFile, 'utf8').includes('- AC1: The system shall write a run state file.')) {",
    "  console.error('prompt is missing the acceptance criteria');",
    '  process.exit(9);',
    '}',
    "if (commandCwd !== process.cwd()) {",
    "  console.error('wrong cwd: ' + commandCwd);",
    '  process.exit(9);',
    '}',
    "if (!process.cwd().replace(/\\\\/g, '/').endsWith('/fresh-verify')) {",
    "  console.error('cwd is not the scratch worktree: ' + process.cwd());",
    '  process.exit(9);',
    '}',
    "if (slug !== 'fresh-spec') {",
    "  console.error('wrong slug: ' + slug);",
    '  process.exit(9);',
    '}',
    "if (unknown !== '{unknownToken}') {",
    "  console.error('unknown token was rewritten: ' + unknown);",
    '  process.exit(9);',
    '}',
    'fs.writeFileSync(evidenceFile, JSON.stringify({',
    '  criteria: [',
    "    { id: 'AC1', verdict: 'verified' },",
    "    { id: 'AC2', verdict: 'unverified' }",
    '  ],',
    '  residualDefects: []',
    '}));',
    ''
  ].join('\n');
  const command = 'node verifier.cjs {promptFile} {evidenceFile} {cwd} {slug} {unknownToken}';
  const { root } = setupWorkspace({
    createState: true,
    testCommand: 'node -e "process.exit(0)"',
    freshVerifyCommand: command,
    baselineFiles: { 'verifier.cjs': verifierFile }
  });
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(root).runId;
    const started = runCli(root, ['fresh-verify', '--run-id', runId]);
    assert.equal(started.status, 4, `unverified command-mode verdicts keep the run paused: ${started.stderr}`);
    assert.match(started.stdout, /remain unverified/);

    const state = latestState(root);
    assert.equal(state.freshVerify.status, 'awaiting_fix');
    assert.equal(state.freshVerify.command.exitCode, 0);
    assert.match(state.freshVerify.command.command, /verifier\.cjs/);
    assert.equal(state.freshVerify.verdicts.length, 2);
    assert.match(state.freshVerify.verdicts[0].unverifiedReason, /no-op mutation/, 'the absent fault plan still gates verified');
    assert.equal(state.steps[5].status, 'pending', 'the CLI stage alone never scores');
    assert.equal(state.freshVerify.cleanup.removed, true);
    assert.equal(fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)), false, 'cleanup after command mode');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // The Step 4 -> 5 transition drives the same command mode and returns 0, so
  // scoring may proceed after the verifier wrote the evidence file.
  const transitioned = setupWorkspace({
    createState: true,
    testCommand: 'node -e "process.exit(0)"',
    freshVerifyCommand: command,
    baselineFiles: { 'verifier.cjs': verifierFile }
  });
  try {
    fs.appendFileSync(path.join(transitioned.root, 'app.cjs'), '// implemented\n', 'utf8');
    const result = sdwOrch.runFreshVerifyTransition(transitioned.root, latestState(transitioned.root), {
      verification: {
        freshVerifyEnabled: true,
        testCommand: 'node -e "process.exit(0)"',
        freshVerifyCommand: command
      }
    }, {});
    assert.equal(result.code, 4, 'unverified command-mode verdicts keep Step 5 blocked');
    const state = latestState(transitioned.root);
    assert.equal(state.freshVerify.status, 'awaiting_fix');
    assert.equal(state.steps[5].status, 'pending');
    assert.equal(fs.existsSync(freshVerify.resolveScratchDir(transitioned.root, state.runId)), false);
  } finally {
    fs.rmSync(transitioned.root, { recursive: true, force: true });
  }
});

test('AC18: a non-zero verifier command fails closed with the output excerpt', () => {
  const { root } = setupWorkspace({
    createState: true,
    testCommand: 'node -e "process.exit(0)"',
    freshVerifyCommand: 'node -e "console.error(\'VERIFIER-BOOM\');process.exit(7)"'
  });
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(root).runId;
    const result = runCli(root, ['fresh-verify', '--run-id', runId]);
    assert.equal(result.status, 1, 'a non-zero verifier fails the stage');
    assert.match(result.stderr, /Command-mode verification failed closed/);
    assert.match(result.stderr, /exited 7/);
    assert.match(result.stderr, /VERIFIER-BOOM/);

    const state = latestState(root);
    assert.equal(state.freshVerify.status, 'failed');
    assert.equal(state.freshVerify.errorCode, 'fresh_verify_command_failed');
    assert.match(state.freshVerify.error, /VERIFIER-BOOM/, 'the recorded error carries the output excerpt');
    assert.equal(state.freshVerify.command.exitCode, 7);
    assert.equal(state.steps[5].status, 'pending', 'Step 5 never scores a failed verifier');
    assert.equal(fs.existsSync(freshVerify.resolveScratchDir(root, runId)), false, 'cleanup after command failure');

    // The Step 4 -> 5 transition also refuses to score.
    state.steps[4].status = 'completed';
    stateManager.saveRunState(root, state);
    const transition = sdwOrch.runFreshVerifyTransition(root, latestState(root), {
      verification: {
        freshVerifyEnabled: true,
        testCommand: 'node -e "process.exit(0)"',
        freshVerifyCommand: 'node -e "console.error(\'VERIFIER-BOOM\');process.exit(7)"'
      }
    }, {});
    assert.equal(transition.code, 1);
    assert.equal(latestState(root).steps[5].status, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC5 & AC6: one fault per AC is isolated and a fault that leaves the suite green is not detection', () => {
  const appFile = "'use strict';\nfunction total() { return 2; }\nmodule.exports = total;\n";
  const verifyFile = [
    "'use strict';",
    "const assert = require('assert');",
    "assert.equal(require('./app.cjs')(), 2);",
    "console.log('ok');",
    ''
  ].join('\n');
  const { root, baseCommit } = setupRepo({ appFile, files: { 'verify.cjs': verifyFile } });
  const scratchDir = freshVerify.resolveScratchDir(root, 'run-faults');
  try {
    const scratch = freshVerify.createScratchWorktree({ projectRoot: root, baseCommit, diff: '', scratchDir });
    const originalApp = fs.readFileSync(path.join(scratch.path, 'app.cjs'));
    const criteria = [
      { id: 'AC1', text: 'The system shall return the documented total.' },
      { id: 'AC2', text: 'The system shall expose the total to callers.' },
      { id: 'AC3', text: 'The system shall document the total.' }
    ];

    const evidence = freshVerify.runFaultInjection({
      scratchPath: scratch.path,
      criteria,
      faults: [
        { acId: 'AC1', file: 'app.cjs', find: 'return 2;', replace: 'return 3;' },
        // AC2 targets the same text as AC1: it only resolves when AC1's fault
        // was reverted before AC2 was applied.
        { acId: 'AC2', file: 'app.cjs', find: 'return 2;', replace: 'return 2; /* inert */' },
        { acId: 'AC3', noOp: true, reason: 'documentation-only criterion with no executable surface' }
      ],
      testCommand: 'node verify.cjs'
    });

    assert.equal(evidence.baseline.passed, true, `baseline must pass: ${evidence.baseline.outputTail}`);
    assert.equal(evidence.faults.length, 3, 'one fault per acceptance criterion');
    const byId = new Map(evidence.faults.map(item => [item.id, item]));
    assert.equal(byId.get('AC1').faultObserved, true, 'the deliberate defect is detected by the suite');
    assert.equal(byId.get('AC1').reverted, true);
    assert.equal(byId.get('AC2').faultObserved, false, 'an inert mutation leaves the suite green');
    assert.match(byId.get('AC2').reason, /not detected/);
    assert.match(byId.get('AC2').reason, /return 2; \/\* inert \*\//);
    assert.equal(byId.get('AC3').applied, false);
    assert.match(byId.get('AC3').reason, /No-op mutation/);

    assert.ok(
      fs.readFileSync(path.join(scratch.path, 'app.cjs')).equals(originalApp),
      'every injected fault is reverted before verification continues'
    );
    assert.equal(git(scratch.path, 'status --porcelain'), '', 'the scratch worktree is clean after the fault run');

    const gated = freshVerify.applyFaultEvidence([
      { id: 'AC1', verdict: 'verified' },
      { id: 'AC2', verdict: 'verified' },
      { id: 'AC3', verdict: 'verified' }
    ], evidence);
    assert.equal(gated.verdicts[0].verdict, 'verified');
    assert.equal(gated.verdicts[0].faultObserved, true);
    assert.match(gated.verdicts[0].passingEvidence, /node verify\.cjs exited 0/);
    assert.equal(gated.verdicts[1].verdict, 'unverified', 'an undetected fault can never verify its AC');
    assert.equal(gated.verdicts[1].claimedVerdict, 'verified');
    assert.match(gated.verdicts[1].unverifiedReason, /not detected/);
    assert.match(gated.verdicts[1].unverifiedReason, /inert/, 'the unverified reason names the fault');
    assert.match(gated.verdicts[1].unverifiedReason, /exited 0 \(passed\)/, 'the unverified reason names the observed result');
    assert.equal(gated.verdicts[2].verdict, 'unverified');
    assert.match(gated.verdicts[2].unverifiedReason, /no-op mutation/);

    // A supplied plan must cover every AC, name known ids, and match the diff.
    assert.throws(
      () => freshVerify.runFaultInjection({
        scratchPath: scratch.path,
        criteria,
        faults: [{ acId: 'AC1', file: 'app.cjs', find: 'return 2;', replace: 'return 3;' }],
        testCommand: 'node verify.cjs'
      }),
      err => err.name === 'FreshVerifyError' && err.code === 'fault_plan_missing_criterion' && /AC2, AC3/.test(err.message)
    );
    assert.throws(
      () => freshVerify.runFaultInjection({
        scratchPath: scratch.path,
        criteria,
        faults: [
          { acId: 'AC1', file: 'app.cjs', find: 'return 2;', replace: 'return 3;' },
          { acId: 'AC2', file: 'app.cjs', find: 'return 2;', replace: 'return 2;' },
          { acId: 'AC9', noOp: true, reason: 'unknown criterion' }
        ],
        testCommand: 'node verify.cjs'
      }),
      err => err.code === 'fault_plan_invalid' && /AC9/.test(err.message)
    );
    assert.throws(
      () => freshVerify.runFaultInjection({
        scratchPath: scratch.path,
        criteria,
        faults: [
          { acId: 'AC1', file: 'app.cjs', find: 'not-present-anywhere', replace: 'x' },
          { acId: 'AC2', file: 'app.cjs', find: 'return 2;', replace: 'return 2;' },
          { acId: 'AC3', noOp: true, reason: 'documentation-only' }
        ],
        testCommand: 'node verify.cjs'
      }),
      err => err.code === 'fault_target_mismatch'
    );
    assert.equal(git(scratch.path, 'status --porcelain'), '', 'rejected plans never leave the scratch worktree dirty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC7: verified requires an observed passing test run in the scratch worktree', () => {
  const verdicts = [
    { id: 'AC1', verdict: 'verified', passingEvidence: 'claimed by the verifier' },
    { id: 'AC2', verdict: 'unverified' }
  ];
  const detected = { id: 'AC1', faultInjected: 'app.cjs: replace "return 2;" with "return 3;"', faultObserved: true };

  const noCommand = freshVerify.applyFaultEvidence(verdicts, { baseline: null, faults: [detected] });
  assert.equal(noCommand.verdicts[0].verdict, 'unverified', 'no observation means no verified verdict');
  assert.match(noCommand.verdicts[0].unverifiedReason, /no observed passing test evidence/);
  assert.equal(noCommand.verdicts[0].evidenceClaim, 'claimed by the verifier');

  const failingBaseline = freshVerify.applyFaultEvidence(verdicts, {
    baseline: { command: 'node verify.cjs', passed: false, exitCode: 1 },
    faults: [detected]
  });
  assert.equal(failingBaseline.verdicts[0].verdict, 'unverified', 'a non-passing observation blocks verified');
  assert.match(failingBaseline.verdicts[0].unverifiedReason, /exited 1/);

  const passingBaseline = freshVerify.applyFaultEvidence(verdicts, {
    baseline: { command: 'node verify.cjs', passed: true, exitCode: 0 },
    faults: [detected]
  });
  assert.equal(passingBaseline.verdicts[0].verdict, 'verified', 'passing observation plus detected fault verifies');
  assert.match(passingBaseline.verdicts[0].passingEvidence, /node verify\.cjs exited 0/);
  assert.equal(passingBaseline.verdicts[1].verdict, 'unverified', 'an unverified claim is never promoted');

  const undetected = freshVerify.applyFaultEvidence(verdicts, {
    baseline: { command: 'node verify.cjs', passed: true, exitCode: 0 },
    faults: [{ ...detected, faultObserved: false }]
  });
  assert.equal(undetected.verdicts[0].verdict, 'unverified');
  assert.match(undetected.verdicts[0].unverifiedReason, /not detected/);
});

test('AC5-AC7: the fresh-verify CLI records fault evidence and gates verified verdicts', () => {
  const verifyFile = [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const app = fs.readFileSync(path.join(__dirname, 'app.cjs'), 'utf8');",
    "if (!app.includes('// implemented')) { console.error('missing implemented marker'); process.exit(1); }",
    "console.log('ok');",
    ''
  ].join('\n');
  const { root } = setupWorkspace({
    createState: true,
    testCommand: 'node verify.cjs',
    baselineFiles: { 'verify.cjs': verifyFile }
  });
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(root).runId;
    const faultsFile = path.join(root, 'faults.json');
    fs.writeFileSync(faultsFile, JSON.stringify({
      faults: [
        { acId: 'AC1', file: 'app.cjs', find: '// implemented', replace: '// fault' },
        { acId: 'AC2', file: 'app.cjs', find: '// implemented', replace: '// implemented // inert' }
      ]
    }), 'utf8');

    const started = runCli(root, ['fresh-verify', '--run-id', runId, '--faults', faultsFile]);
    assert.equal(started.status, 4, `expected the awaiting-verdict handoff; stderr: ${started.stderr}`);
    let state = latestState(root);
    assert.equal(state.freshVerify.round, 1);
    assert.equal(state.freshVerify.maxRounds, 3);
    assert.equal(state.freshVerify.faultBaseline.passed, true, state.freshVerify.faultBaseline.outputTail);
    assert.equal(state.freshVerify.faults.length, 2);
    assert.equal(state.freshVerify.faults[0].faultObserved, true);
    assert.equal(state.freshVerify.faults[1].faultObserved, false);
    const scratchApp = fs.readFileSync(path.resolve(root, state.freshVerify.scratch.path, 'app.cjs'), 'utf8');
    assert.ok(scratchApp.includes('// implemented'), 'the delivery diff is present in the scratch worktree');
    assert.ok(!scratchApp.includes('// fault'), 'the injected fault is reverted before the verifier handoff');

    const verdictFile = path.join(root, 'verdict.json');
    fs.writeFileSync(verdictFile, JSON.stringify({
      criteria: [
        { id: 'AC1', verdict: 'verified' },
        { id: 'AC2', verdict: 'verified' }
      ]
    }), 'utf8');
    const submitted = runCli(root, ['fresh-verify', '--run-id', runId, '--verdict', verdictFile]);
    assert.equal(submitted.status, 4, `the undetected fault keeps the run paused: ${submitted.stderr}`);
    assert.match(submitted.stdout, /1\/2 AC\(s\) verified/);
    assert.match(submitted.stdout, /remain unverified/);

    state = latestState(root);
    const [ac1, ac2] = state.freshVerify.verdicts;
    assert.equal(ac1.verdict, 'verified');
    assert.equal(ac2.verdict, 'unverified');
    assert.equal(ac2.claimedVerdict, 'verified');
    assert.match(ac2.unverifiedReason, /not detected/);
    assert.match(ac2.unverifiedReason, /inert/);
    assert.equal(state.freshVerify.status, 'awaiting_fix', 'round one with a defect parks the run for a fix');
    assert.equal(state.freshVerify.cleanup.removed, true);
    assert.equal(fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC8: a fourth fix and re-verify round is refused', () => {
  const { root } = setupWorkspace({ createState: true, testCommand: 'node -e "process.exit(0)"' });
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(root).runId;
    const badVerdict = path.join(root, 'bad-verdict.json');
    fs.writeFileSync(badVerdict, JSON.stringify({
      criteria: [{ id: 'AC1', verdict: 'verified' }]
    }), 'utf8');

    for (let round = 1; round <= 3; round++) {
      const started = runCli(root, ['fresh-verify', '--run-id', runId]);
      assert.equal(started.status, 4, `round ${round} must start; stderr: ${started.stderr}`);
      assert.equal(latestState(root).freshVerify.round, round, `round ${round} is recorded on run state`);
      const rejected = runCli(root, ['fresh-verify', '--run-id', runId, '--verdict', badVerdict]);
      assert.equal(rejected.status, 1, `round ${round} verdict is rejected`);
      assert.match(rejected.stderr, /Missing verdict for AC2/);
    }

    const refused = runCli(root, ['fresh-verify', '--run-id', runId]);
    assert.equal(refused.status, 1, 'the fourth attempt is refused');
    assert.match(refused.stderr, /round limit reached/i);
    assert.match(refused.stderr, /fourth round is refused/i);

    const state = latestState(root);
    assert.equal(state.freshVerify.round, 3, 'no fourth round is recorded');
    assert.equal(state.freshVerify.maxRounds, 3);
    assert.equal(state.freshVerify.status, 'failed');
    assert.equal(
      fs.existsSync(freshVerify.resolveScratchDir(root, runId)),
      false,
      'a refused round creates no scratch worktree'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC9 & AC10: residual defects after the third round pause the run with the defect list', () => {
  const { root } = setupWorkspace({ createState: true, testCommand: 'node -e "process.exit(0)"' });
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(root).runId;
    const badVerdict = path.join(root, 'bad-verdict.json');
    fs.writeFileSync(badVerdict, JSON.stringify({
      criteria: [{ id: 'AC1', verdict: 'verified' }]
    }), 'utf8');

    // Rounds 1 and 2 are consumed by rejected verdicts; round 3 will be valid.
    for (let round = 1; round <= 2; round++) {
      assert.equal(runCli(root, ['fresh-verify', '--run-id', runId]).status, 4, `round ${round} must start`);
      assert.equal(runCli(root, ['fresh-verify', '--run-id', runId, '--verdict', badVerdict]).status, 1);
    }

    assert.equal(runCli(root, ['fresh-verify', '--run-id', runId]).status, 4, 'round 3 must start');
    const residualVerdict = path.join(root, 'residual-verdict.json');
    fs.writeFileSync(residualVerdict, JSON.stringify({
      criteria: [
        { id: 'AC1', verdict: 'unverified' },
        { id: 'AC2', verdict: 'unverified' }
      ],
      residualDefects: [
        { acId: 'AC1', reason: 'the run state file is never written' },
        { acId: 'AC2', reason: 'the resume path has no test' }
      ]
    }), 'utf8');

    const paused = runCli(root, ['fresh-verify', '--run-id', runId, '--verdict', residualVerdict]);
    assert.equal(paused.status, 4, `a residual third round pauses instead of scoring: ${paused.stderr}`);
    assert.match(paused.stdout, /paused after round 3\/3/i);
    assert.match(paused.stdout, /AC1: the run state file is never written/);
    assert.match(paused.stdout, /AC2: the resume path has no test/);

    let state = latestState(root);
    assert.equal(state.status, 'paused', 'the run is paused, not completed');
    assert.equal(state.freshVerify.status, 'paused_residual_defects');
    assert.equal(state.freshVerify.round, 3);
    assert.equal(state.freshVerify.maxRounds, 3);
    assert.deepEqual(state.freshVerify.residualDefects.map(item => item.acId), ['AC1', 'AC2']);
    assert.match(state.freshVerify.residualDefects[0].reason, /run state file is never written/);
    assert.equal(state.steps[5].status, 'pending', 'Step 5 never starts while residual defects remain');
    assert.equal(
      fs.existsSync(path.resolve(root, state.freshVerify.scratch.path)),
      false,
      'the scratch worktree is removed when the run pauses'
    );

    // The pause is sticky: another fresh-verify call re-reports it, starts no
    // fourth round, and the Step 4 -> 5 transition still refuses to score.
    const again = runCli(root, ['fresh-verify', '--run-id', runId]);
    assert.equal(again.status, 4, 'a paused residual run stays paused');
    assert.match(again.stdout, /residual defect/);
    assert.match(again.stdout, /AC2: the resume path has no test/);

    const transition = sdwOrch.runFreshVerifyTransition(root, latestState(root), {
      verification: { freshVerifyEnabled: true, testCommand: 'node -e "process.exit(0)"' }
    }, {});
    assert.equal(transition.code, 4, 'the transition pauses instead of scoring');
    state = latestState(root);
    assert.equal(state.status, 'paused');
    assert.equal(state.steps[5].status, 'pending');
    assert.equal(state.freshVerify.round, 3, 'no fourth round is started');
    assert.equal(fs.existsSync(freshVerify.resolveScratchDir(root, runId)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC10: the scratch worktree is removed on accepted, rejected, and fault-failed verification', () => {
  // Accepted path: the injected faults are detected, so the verdict is accepted.
  const verifyFile = [
    "'use strict';",
    "const fs = require('fs');",
    "if (!fs.readFileSync('app.cjs', 'utf8').includes('// implemented')) process.exit(1);",
    ''
  ].join('\n');
  const acceptedWorkspace = setupWorkspace({
    createState: true,
    testCommand: 'node verify.cjs',
    baselineFiles: { 'verify.cjs': verifyFile }
  });
  try {
    fs.appendFileSync(path.join(acceptedWorkspace.root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(acceptedWorkspace.root).runId;
    const faultsFile = path.join(acceptedWorkspace.root, 'faults.json');
    fs.writeFileSync(faultsFile, JSON.stringify([
      { acId: 'AC1', file: 'app.cjs', find: '// implemented', replace: '// fault' },
      { acId: 'AC2', file: 'app.cjs', find: '// implemented', replace: '// fault' }
    ]), 'utf8');
    assert.equal(runCli(acceptedWorkspace.root, ['fresh-verify', '--run-id', runId, '--faults', faultsFile]).status, 4);
    const goodVerdict = path.join(acceptedWorkspace.root, 'good-verdict.json');
    fs.writeFileSync(goodVerdict, JSON.stringify({
      criteria: [
        { id: 'AC1', verdict: 'verified' },
        { id: 'AC2', verdict: 'verified' }
      ]
    }), 'utf8');
    const accepted = runCli(acceptedWorkspace.root, ['fresh-verify', '--run-id', runId, '--verdict', goodVerdict]);
    assert.equal(accepted.status, 0, `expected acceptance; stderr: ${accepted.stderr}`);
    const acceptedState = latestState(acceptedWorkspace.root);
    assert.equal(acceptedState.freshVerify.status, 'completed');
    assert.equal(fs.existsSync(path.resolve(acceptedWorkspace.root, acceptedState.freshVerify.scratch.path)), false, 'cleanup after acceptance');
    assert.ok(!git(acceptedWorkspace.root, 'worktree list').includes('fresh-verify'), 'git no longer tracks the accepted scratch worktree');
  } finally {
    fs.rmSync(acceptedWorkspace.root, { recursive: true, force: true });
  }

  // Rejected path: an invalid verdict is refused and the worktree is removed.
  const rejectedWorkspace = setupWorkspace({ createState: true, testCommand: 'node -e "process.exit(0)"' });
  try {
    fs.appendFileSync(path.join(rejectedWorkspace.root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(rejectedWorkspace.root).runId;
    assert.equal(runCli(rejectedWorkspace.root, ['fresh-verify', '--run-id', runId]).status, 4);
    const badVerdict = path.join(rejectedWorkspace.root, 'bad-verdict.json');
    fs.writeFileSync(badVerdict, JSON.stringify({ criteria: [{ id: 'AC1', verdict: 'verified' }] }), 'utf8');
    assert.equal(runCli(rejectedWorkspace.root, ['fresh-verify', '--run-id', runId, '--verdict', badVerdict]).status, 1);
    const rejectedState = latestState(rejectedWorkspace.root);
    assert.equal(rejectedState.freshVerify.status, 'failed');
    assert.equal(fs.existsSync(path.resolve(rejectedWorkspace.root, rejectedState.freshVerify.scratch.path)), false, 'cleanup after rejection');
    assert.ok(!git(rejectedWorkspace.root, 'worktree list').includes('fresh-verify'), 'git no longer tracks the rejected scratch worktree');
  } finally {
    fs.rmSync(rejectedWorkspace.root, { recursive: true, force: true });
  }

  // Fault-failed path: an inapplicable fault plan fails closed and cleans up.
  const faultWorkspace = setupWorkspace({ createState: true, testCommand: 'node -e "process.exit(0)"' });
  try {
    fs.appendFileSync(path.join(faultWorkspace.root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(faultWorkspace.root).runId;
    const badFaults = path.join(faultWorkspace.root, 'bad-faults.json');
    fs.writeFileSync(badFaults, JSON.stringify([
      { acId: 'AC1', file: 'app.cjs', find: 'not-present-in-the-diff', replace: 'x' },
      { acId: 'AC2', noOp: true, reason: 'documentation-only criterion' }
    ]), 'utf8');
    const failed = runCli(faultWorkspace.root, ['fresh-verify', '--run-id', runId, '--faults', badFaults]);
    assert.equal(failed.status, 1, 'an inapplicable fault fails closed');
    assert.match(failed.stderr, /must contain the injected text exactly once/);
    const faultState = latestState(faultWorkspace.root);
    assert.equal(faultState.freshVerify.status, 'failed');
    assert.equal(fs.existsSync(path.resolve(faultWorkspace.root, faultState.freshVerify.scratch.path)), false, 'cleanup after a fault failure');
    assert.ok(!git(faultWorkspace.root, 'worktree list').includes('fresh-verify'), 'git no longer tracks the failed scratch worktree');
  } finally {
    fs.rmSync(faultWorkspace.root, { recursive: true, force: true });
  }
});

// Spec 00018 AC19: the suite covers fresh verification, fault injection,
// residual defects, audit verdicts, and scratch cleanup. Each concern names the
// executed case that proves it, and the behavioral checks below keep this from
// being satisfied by strings alone.
test('AC19: the suite covers fresh verification, fault injection, residual defects, audit verdicts, and scratch cleanup', () => {
  const freshSuite = fs.readFileSync(path.join(__dirname, 'sdw_fresh_verify.test.cjs'), 'utf8');
  const auditSuite = fs.readFileSync(path.join(__dirname, 'sdw_audit.test.cjs'), 'utf8');
  const coverage = [
    { concern: 'fresh verification', source: freshSuite, title: "test('AC1-AC4: fresh-verify CLI creates a fenced scratch" },
    { concern: 'fault injection', source: freshSuite, title: "test('AC5 & AC6: one fault per AC is isolated" },
    { concern: 'residual defects', source: freshSuite, title: "test('AC9 & AC10: residual defects after the third round" },
    { concern: 'audit verdicts', source: auditSuite, title: "test('AC12: audit refutes a claim whose file is absent" },
    { concern: 'scratch cleanup', source: freshSuite, title: "test('AC10: the scratch worktree is removed on accepted" }
  ];
  for (const item of coverage) {
    assert.ok(item.source.includes(item.title), `the suite has a case for ${item.concern}: ${item.title}`);
  }

  // Fresh verification: one verdict per acceptance criterion is enforced.
  const missingVerdict = freshVerify.validateVerdict(
    { criteria: [{ id: 'AC1', verdict: 'verified' }] },
    [{ id: 'AC1', text: 'one' }, { id: 'AC2', text: 'two' }]
  );
  assert.equal(missingVerdict.valid, false);

  // Fault injection: an undetected fault can never verify its criterion.
  const gated = freshVerify.applyFaultEvidence([{ id: 'AC1', verdict: 'verified' }], {
    baseline: { command: 'node verify.cjs', passed: true, exitCode: 0 },
    faults: [{ id: 'AC1', faultInjected: 'app.cjs: replace x with y', faultObserved: false }]
  });
  assert.equal(gated.verdicts[0].verdict, 'unverified');

  // Residual defects: a recorded pause keeps the run paused and Step 5 pending.
  const { root } = setupWorkspace({ createState: true });
  try {
    const state = latestState(root);
    state.freshVerify = {
      status: 'paused_residual_defects',
      round: 3,
      maxRounds: 3,
      residualDefects: [{ acId: 'AC1', reason: 'still broken' }],
      scratch: null
    };
    state.status = 'paused';
    stateManager.saveRunState(root, state);
    const transition = sdwOrch.runFreshVerifyTransition(root, latestState(root), {
      verification: { freshVerifyEnabled: true }
    }, {});
    assert.equal(transition.code, 4, 'a residual pause blocks Step 5');
    const paused = latestState(root);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.steps[5].status, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Audit verdicts: `refuted` blocks ship under the default policy.
  const blocking = auditRunner.resolveAuditBlocking({
    verdicts: [{ acId: 'AC1', verdict: 'refuted', reasons: ['claimed file absent'] }],
    policy: 'refuted'
  });
  assert.equal(blocking.blocked, true);
  assert.deepEqual(blocking.acIds, ['AC1']);

  // Scratch cleanup: a created worktree is removed and git no longer tracks it.
  const repo = setupRepo();
  try {
    const scratch = freshVerify.createScratchWorktree({
      projectRoot: repo.root,
      baseCommit: repo.baseCommit,
      diff: '',
      scratchDir: freshVerify.resolveScratchDir(repo.root, 'run-ac19')
    });
    const cleanup = freshVerify.removeScratchWorktree({ projectRoot: repo.root, worktreePath: scratch.path });
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.removed, true);
    assert.equal(fs.existsSync(scratch.path), false);
    assert.ok(!git(repo.root, 'worktree list').includes('fresh-verify'));
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

// Spec 00018 AC16: the Tier-2 reference is the contract for the verifier,
// fault injection, and audit verdicts, linked from the Tier-1 skill within the
// 120-line budget.
test('AC16: the fresh-verify and audit contract is documented in the Tier-2 reference', () => {
  const reference = fs.readFileSync(
    path.join(REPO_ROOT, 'skills', 'sdw-orch', 'references', 'fresh_verify.md'),
    'utf8'
  );
  for (const anchor of [
    '## Verifier contract',
    '### Fault injection rules',
    '### Round policy',
    '## Audit verdict semantics',
    '## Ship gate and reporting',
    '`verification.auditVerdictsBlockShip`',
    '`fresh-verify --run-id',
    '`audit --run-id',
    'faultObserved',
    '`blocked_audit`'
  ]) {
    assert.ok(reference.includes(anchor), `the reference documents ${anchor}`);
  }
  for (const verdict of ['confirmed', 'refuted', 'caveats']) {
    assert.match(reference, new RegExp(`\\| \`${verdict}\` \\|`), `the verdict table documents ${verdict}`);
  }
  assert.match(reference, /one deterministic, reversible mutation per criterion/i, 'the fault rule is documented');
  assert.match(reference, /leaves the suite green/i, 'the undetected-fault rule is documented');
  assert.match(reference, /three fix-and-re-verify rounds/i, 'the round cap is documented');

  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-orch', 'SKILL.md'), 'utf8');
  assert.match(
    skill,
    /\[`references\/fresh_verify\.md`\]\(references\/fresh_verify\.md\)/,
    'the Tier-1 skill links the reference'
  );
  assert.ok(skill.split(/\r?\n/).length <= 120, 'the Tier-1 skill stays within the 120-line budget');
  const doctor = sdwRules.cmdDoctor({ root: REPO_ROOT });
  assert.equal(doctor.passed, true, doctor.violations.map(item => item.message).join('; '));
});

// Spec 00018 AC5: the mutation applied must be the mutation reported. A plan whose
// replacement text contains replacement patterns (`$&`, `$'`, `$$`) is inserted
// literally, so the tested fault never differs from the described one.
test('AC5: fault replacement text is inserted literally, including $ patterns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fault-literal-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.cjs'), "const label = 'RUNNING';\n", 'utf8');
    execSync('git init -q', { cwd: root, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
    execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
    execSync('git add src/app.cjs', { cwd: root, stdio: 'ignore' });
    execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });

    const applied = freshVerify.applyFault(root, {
      acId: 'AC1',
      file: 'src/app.cjs',
      find: 'RUNNING',
      replace: "RUNNING-$&-$'-$$"
    });
    const written = fs.readFileSync(path.join(root, 'src', 'app.cjs'), 'utf8');
    assert.equal(written, "const label = 'RUNNING-$&-$'-$$';\n", 'the replacement text is inserted verbatim');
    assert.ok(!written.includes("'RUNNING-RUNNING"), 'no replacement pattern was expanded');

    freshVerify.revertFault(root, applied);
    assert.equal(
      fs.readFileSync(path.join(root, 'src', 'app.cjs'), 'utf8'),
      "const label = 'RUNNING';\n",
      'the revert restores the original bytes'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00018 AC9: a submitted verdict file can never reopen a parked run.
test('AC9: a submitted verdict cannot move a paused round out of its pause', () => {
  const { root } = setupWorkspace({ createState: true });
  try {
    fs.appendFileSync(path.join(root, 'app.cjs'), '// implemented\n', 'utf8');
    const runId = latestState(root).runId;
    const verifiedVerdict = path.join(root, 'verified-verdict.json');
    fs.writeFileSync(verifiedVerdict, JSON.stringify({
      criteria: [
        { id: 'AC1', verdict: 'verified' },
        { id: 'AC2', verdict: 'verified' }
      ]
    }), 'utf8');

    const patch = (status, round) => {
      const state = stateManager.loadRunState(root, runId);
      state.status = 'paused';
      state.freshVerify = {
        status,
        round,
        maxRounds: 3,
        verdicts: [
          { id: 'AC1', verdict: 'unverified', unverifiedReason: 'still missing' },
          { id: 'AC2', verdict: 'unverified', unverifiedReason: 'still missing' }
        ],
        residualDefects: [{ acId: 'AC1', reason: 'still missing' }, { acId: 'AC2', reason: 'still missing' }]
      };
      stateManager.saveRunState(root, state);
    };

    patch('paused_residual_defects', 3);
    const paused = runCli(root, ['fresh-verify', '--run-id', runId, '--verdict', verifiedVerdict]);
    assert.equal(paused.status, 4, `the final pause is final: ${paused.stderr}`);
    assert.match(paused.stderr, /cannot reopen it/);
    assert.equal(latestState(root).freshVerify.status, 'paused_residual_defects', 'the pause record is unchanged');
    assert.equal(latestState(root).status, 'paused');

    patch('awaiting_fix', 1);
    const parked = runCli(root, ['fresh-verify', '--run-id', runId, '--verdict', verifiedVerdict]);
    assert.equal(parked.status, 4, `an awaiting-fix round is closed: ${parked.stderr}`);
    assert.match(parked.stderr, /start round 2/);
    assert.equal(latestState(root).freshVerify.status, 'awaiting_fix', 'the parked round is unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
