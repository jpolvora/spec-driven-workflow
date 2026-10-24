'use strict';

// Spec 00018 AC11/AC12: adversarial audit. The tests exercise the report-level
// boundary (the `audit` CLI and its run-state record) against temp git
// repositories only: claimed work is compared with the delivery diff, verified
// again in an audit-owned scratch worktree, and classified as confirmed,
// refuted, or caveats.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const auditRunner = require('../skills/sdw-orch/scripts/audit_runner.cjs');
const acLedger = require('../skills/sdw-orch/scripts/ac_ledger.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');

const ORCH = path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

const SPEC_BODY = `---
slug: audit-spec
title: Audit Spec
---
# Audit Spec

## Acceptance Criteria

- AC1: The system shall append the implemented marker to app.cjs.
`;

const VERIFY_PASS = [
  "'use strict';",
  "const fs = require('fs');",
  "if (!fs.readFileSync('app.cjs', 'utf8').includes('// implemented')) process.exit(1);",
  ''
].join('\n');
const VERIFY_FAIL = "'use strict';\nprocess.exit(1);\n";

function git(root, command) {
  return execSync(`git ${command}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Builds an SDW workspace whose delivery commit changes app.cjs. The run state,
// ledger, and worktrees live under .sdw/, which is gitignored, so the delivery
// diff is exactly the claimed implementation.
function setupAuditWorkspace(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-audit-'));
  sdwConfig.cmdInit({ root, force: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.sdw/state/\n.sdw/worktrees/\n.sdw/sandbox/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'app.cjs'), '// baseline\n', 'utf8');
  fs.writeFileSync(path.join(root, 'verify.cjs'), options.verifyFile || VERIFY_PASS, 'utf8');
  fs.writeFileSync(path.join(root, '.sdw', 'specs', 'audit-spec.md'), SPEC_BODY, 'utf8');

  const configPath = path.join(root, '.sdw', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.verification = { ...(config.verification || {}) };
  config.verification.testCommand = options.testCommand || null;
  if (options.noTestCommand) config.testCommand = '';
  if (options.policy) config.verification.auditVerdictsBlockShip = options.policy;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  git(root, 'init -q');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "SDW Test"');
  git(root, 'add -A');
  git(root, 'commit -qm baseline');
  const baseCommit = git(root, 'rev-parse HEAD');

  // The delivered implementation, committed so the delivery range is explicit.
  fs.writeFileSync(path.join(root, 'app.cjs'), '// baseline\n// implemented\n', 'utf8');
  git(root, 'add app.cjs');
  git(root, 'commit -qm "implement app.cjs"');
  const deliveryCommit = git(root, 'rev-parse HEAD');

  const state = stateManager.createRunState({
    root,
    specPath: '.sdw/specs/audit-spec.md',
    slug: 'audit-spec',
    baseCommit
  });
  const init = acLedger.initLedger({
    root,
    artifactsDir: state.artifactsDir,
    runId: state.runId,
    specSlug: state.specSlug,
    specContent: SPEC_BODY
  });

  state.steps[4].status = 'completed';
  state.steps[4].tasks = {
    'task-1': {
      id: 'task-1',
      status: 'completed',
      filesChanged: options.claimedFiles || ['app.cjs'],
      acIds: options.claimedAcs || ['AC1']
    }
  };
  state.deliveryCommit = deliveryCommit;
  if (options.freshVerifyVerdict) {
    state.freshVerify = {
      status: 'completed',
      round: 1,
      maxRounds: 3,
      verdicts: [{ id: 'AC1', verdict: options.freshVerifyVerdict }]
    };
  }
  stateManager.saveRunState(root, state);

  if (options.ledgerEvidence !== false) {
    const linked = acLedger.linkEvidence({
      root,
      ledgerPath: init.ledgerPath,
      acIds: ['AC1'],
      evidence: { type: 'file', path: 'app.cjs', taskId: 'task-1' }
    });
    assert.equal(linked.ok, true, linked.errors ? linked.errors.join(' ') : '');
  }

  return { root, baseCommit, deliveryCommit, runId: state.runId };
}

function runAuditCli(root, runId) {
  return spawnSync(process.execPath, [ORCH, 'audit', '--root', root, '--run-id', runId], {
    cwd: root,
    encoding: 'utf8'
  });
}

test('AC11 & AC12: audit confirms a claim whose files and verification match the delivery diff', () => {
  const workspace = setupAuditWorkspace({ testCommand: 'node verify.cjs', freshVerifyVerdict: 'verified' });
  try {
    const parsed = sdwOrch.parseArgs(['audit', '--run-id', 'run-x', '--json']);
    assert.equal(parsed.subcommand, 'audit');
    assert.equal(parsed.runId, 'run-x');
    assert.equal(parsed.specPath, null, 'audit takes the run, never a spec path');

    const result = runAuditCli(workspace.root, workspace.runId);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AC1: confirmed/);
    assert.match(result.stdout, /Overall: confirmed/);
    assert.match(result.stdout, /Re-verification: passed/);

    const state = stateManager.loadRunState(workspace.root, workspace.runId);
    assert.equal(state.audit.status, 'completed');
    assert.equal(state.audit.overall, 'confirmed');
    assert.equal(state.audit.verdicts.length, 1);
    assert.equal(state.audit.verdicts[0].verdict, 'confirmed');
    assert.equal(state.audit.verdicts[0].reVerification, 'passed');
    assert.equal(state.audit.verdicts[0].claimedFiles.includes('app.cjs'), true);
    assert.deepEqual(state.audit.verdicts[0].missingFiles, []);
    assert.equal(state.audit.summary.confirmed, 1);
    assert.equal(state.audit.blocking.blocked, false);
    assert.equal(state.audit.diff.deliveryCommit, workspace.deliveryCommit);
    assert.deepEqual(state.audit.diff.files, ['app.cjs']);
    assert.equal(
      fs.existsSync(auditRunner.resolveAuditScratchDir(workspace.root, workspace.runId)),
      false,
      'the audit scratch worktree is removed'
    );
    assert.ok(!git(workspace.root, 'worktree list').includes('/.sdw/worktrees/'), 'git tracks no audit worktree');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC12: audit refutes a claim whose file is absent from the delivery diff', () => {
  const workspace = setupAuditWorkspace({
    testCommand: 'node verify.cjs',
    claimedFiles: ['app.cjs', 'missing.cjs']
  });
  try {
    const result = runAuditCli(workspace.root, workspace.runId);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AC1: refuted/);
    assert.match(result.stdout, /missing\.cjs/);
    assert.match(result.stdout, /Overall: refuted/);

    const state = stateManager.loadRunState(workspace.root, workspace.runId);
    assert.equal(state.audit.verdicts[0].verdict, 'refuted');
    assert.deepEqual(state.audit.verdicts[0].missingFiles, ['missing.cjs']);
    assert.equal(state.audit.blocking.policy, 'refuted', 'the default safety floor always blocks refuted verdicts');
    assert.equal(state.audit.blocking.blocked, true);
    assert.deepEqual(state.audit.blocking.acIds, ['AC1']);
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC12: audit refutes a claim when re-verification fails', () => {
  const workspace = setupAuditWorkspace({ testCommand: 'node verify.cjs', verifyFile: VERIFY_FAIL });
  try {
    const result = runAuditCli(workspace.root, workspace.runId);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AC1: refuted/);
    assert.match(result.stdout, /re-verification failed/i);
    assert.match(result.stdout, /Overall: refuted/);

    const state = stateManager.loadRunState(workspace.root, workspace.runId);
    assert.equal(state.audit.reVerification.status, 'failed');
    assert.equal(state.audit.verdicts[0].verdict, 'refuted');
    assert.match(state.audit.verdicts[0].reasons.join(' '), /re-verification failed/);
    assert.equal(state.audit.blocking.blocked, true);
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC12: audit reports caveats when the evidence is present but incomplete', () => {
  // No test command means verification cannot be rerun; no linked evidence and
  // an unverified ledger record leave the claim present but unproven.
  const workspace = setupAuditWorkspace({ ledgerEvidence: false, freshVerifyVerdict: 'unverified', noTestCommand: true });
  try {
    const result = runAuditCli(workspace.root, workspace.runId);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AC1: caveats/);
    assert.match(result.stdout, /Overall: caveats/);

    const state = stateManager.loadRunState(workspace.root, workspace.runId);
    assert.equal(state.audit.verdicts[0].verdict, 'caveats');
    const reasons = state.audit.verdicts[0].reasons.join(' ');
    assert.match(reasons, /re-verification is unavailable/i);
    assert.match(reasons, /records this criterion as unverified/);
    assert.match(reasons, /no proof-bearing evidence/);
    assert.match(reasons, /fresh verification marked this criterion unverified/);
    assert.equal(state.audit.blocking.policy, 'refuted');
    assert.equal(state.audit.blocking.blocked, false, 'caveats alone does not block under the default policy');

    // The recorded verdicts are sufficient for the later ship-block rules: the
    // caveats policy reuses the same record instead of rerunning the audit.
    const caveatsPolicy = auditRunner.resolveAuditBlocking({
      verdicts: state.audit.verdicts,
      policy: 'caveats'
    });
    assert.equal(caveatsPolicy.blocked, true);
    assert.deepEqual(caveatsPolicy.acIds, ['AC1']);
    assert.equal(caveatsPolicy.policy, 'caveats');
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC11: audit never modifies tracked files', () => {
  const workspace = setupAuditWorkspace({ testCommand: 'node verify.cjs' });
  try {
    const headBefore = git(workspace.root, 'rev-parse HEAD');
    const statusBefore = git(workspace.root, 'status --porcelain');
    const appBefore = fs.readFileSync(path.join(workspace.root, 'app.cjs'));

    const result = runAuditCli(workspace.root, workspace.runId);
    assert.equal(result.status, 0, result.stderr);

    assert.equal(git(workspace.root, 'rev-parse HEAD'), headBefore, 'no commit is created');
    assert.equal(git(workspace.root, 'status --porcelain'), statusBefore, 'tracked files keep their state');
    assert.equal(git(workspace.root, 'diff --stat'), '', 'no tracked file is modified');
    assert.ok(fs.readFileSync(path.join(workspace.root, 'app.cjs')).equals(appBefore), 'app.cjs is byte-identical');
    assert.equal(
      fs.existsSync(auditRunner.resolveAuditScratchDir(workspace.root, workspace.runId)),
      false,
      'the read-only guarantee does not leave a scratch worktree behind'
    );
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});

test('AC11: audit fails closed when the run has no base commit to compare against', () => {
  const workspace = setupAuditWorkspace({ testCommand: 'node verify.cjs' });
  try {
    const state = stateManager.loadRunState(workspace.root, workspace.runId);
    state.baseCommit = null;
    stateManager.saveRunState(workspace.root, state);

    const result = runAuditCli(workspace.root, workspace.runId);
    assert.equal(result.status, 1, 'an uncomparable run is not audited');
    assert.match(result.stderr, /no baseCommit/i);
    assert.equal(
      fs.existsSync(auditRunner.resolveAuditScratchDir(workspace.root, workspace.runId)),
      false,
      'a refused audit creates no scratch worktree'
    );
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }
});
