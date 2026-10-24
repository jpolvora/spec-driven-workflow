'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');

// Spec 027: wire the deterministic judge stub for runs past Step 4.
require('./fixtures/judge_env.cjs').installJudgeEnv();

const REPO_ROOT = path.resolve(__dirname, '..');
const ORCH = path.join(REPO_ROOT, 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

const IMPLEMENTATION = `node -e "const fs = require('fs'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: ['AC1'], filesChanged: ['package.json'], summary: 'retro hook fixture' })); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); p.retroHook = true; fs.writeFileSync('package.json', JSON.stringify(p, null, 2));"`;

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-orch-retro-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "SDW Retro Hook Tester"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "retro-hook@sdw.org"', { cwd: root, stdio: 'ignore' });
  sdwConfig.cmdInit({ root, force: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'retro-hook-fixture', version: '1.0.0' }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.sdw', 'state', '.gitkeep'), '', 'utf8');
  execSync('git add -A', { cwd: root, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: root, stdio: 'ignore' });
  return root;
}

function writeSpec(root, slug) {
  const content = `---
id: null
slug: ${slug}
title: "Feature ${slug}"
source: local
status: draft
specDate: 2026-10-21
---

# Feature ${slug}

## Description
Retrospective hook fixture.

### Design Intent
Verify the automatic retrospective and the start guard.

## Acceptance Criteria
- AC1: The system shall satisfy acceptance condition 1 for ${slug}.

## New files
- \`src/${slug}.cjs\` — created by this work.

## Notes
Fixture notes.

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
None.

### Negative & Failing Test Scenarios
- AC1-ERR: If invalid, then fail.
`;
  const file = path.join(root, '.sdw', 'specs', `${slug}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function patchConfig(root, patch) {
  const file = path.join(root, '.sdw', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(config, patch);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function runCompletion(root, slug) {
  return sdwOrch.cmdRun({
    root,
    specPath: `.sdw/specs/${slug}.md`,
    skipReview: true,
    skipPr: true,
    minScore: 0,
    implementation: { mode: 'command', command: IMPLEMENTATION }
  });
}

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    return { code: fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function stateFiles(root) {
  return fs.readdirSync(stateManager.resolveStateDir(root))
    .filter((name) => name.endsWith('.state.json'))
    .sort();
}

function writeOpenState(root, runId, slug, status = 'paused') {
  const state = {
    orchestrator: 'sdw-orch',
    runId,
    specSlug: slug,
    specPath: `.sdw/specs/${slug}.md`,
    status,
    currentStep: 4,
    totalSteps: 8,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:05:00.000Z',
    steps: {}
  };
  fs.writeFileSync(stateManager.getStateFilePath(root, runId), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

test('AC1: retro.enabled executes sdw-retro and records state.retro with the report paths', (t) => {
  const root = makeProject(t);
  const slug = 'retro-enabled-fixture';
  writeSpec(root, slug);
  patchConfig(root, { retro: { enabled: true } });

  const { code, logs } = captureConsole(() => runCompletion(root, slug));
  assert.equal(code, 0, logs.join('\n'));

  const state = stateManager.findLatestRunState(root);
  assert.equal(state.status, 'completed');
  assert.equal(state.retro.status, 'passed');
  assert.equal(state.retro.error, null);
  assert.equal(typeof state.retro.ranAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(state.retro.ranAt)), 'ranAt is an ISO timestamp');
  assert.equal(state.retro.reportMd, `${state.artifactsDir}/${state.runId}.retro.md`);
  assert.equal(state.retro.reportJson, `${state.artifactsDir}/${state.runId}.retro.json`);

  const markdownPath = path.join(root, state.retro.reportMd);
  const jsonPath = path.join(root, state.retro.reportJson);
  assert.ok(fs.existsSync(markdownPath), 'markdown report exists');
  assert.ok(fs.existsSync(jsonPath), 'JSON report exists');
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(report.runId, state.runId);
  assert.ok(logs.join('\n').includes(state.retro.reportMd), 'completion output names the report location');
});

test('AC2: a failing retrospective is recorded and the completed run still exits 0', (t) => {
  const root = makeProject(t);
  const slug = 'retro-failing-fixture';
  writeSpec(root, slug);
  // The alternate state directory is invisible to sdw-retro, which reads
  // .sdw/state: its lookup fails and the hook must record a non-fatal failure.
  patchConfig(root, { retro: { enabled: true }, stateDir: '{projectRoot}/.sdw/alt-state' });

  const { code, logs } = captureConsole(() => runCompletion(root, slug));
  assert.equal(code, 0, 'a failing retrospective never fails the delivery');
  assert.match(logs.join('\n'), /Retrospective failed/);

  const state = stateManager.findLatestRunState(root);
  assert.equal(state.status, 'completed');
  assert.equal(state.retro.status, 'failed');
  assert.equal(state.retro.reportMd, null);
  assert.equal(state.retro.reportJson, null);
  assert.match(state.retro.error, /run not found|state directory not found/);
});

test('AC3: retro.enabled false keeps the advisory print and runs no retrospective', (t) => {
  const root = makeProject(t);
  const slug = 'retro-disabled-fixture';
  writeSpec(root, slug);
  patchConfig(root, { retro: { enabled: false } });

  const { code, logs } = captureConsole(() => runCompletion(root, slug));
  assert.equal(code, 0, logs.join('\n'));

  const state = stateManager.findLatestRunState(root);
  assert.equal(state.status, 'completed');
  assert.equal(state.retro, undefined, 'no retrospective was executed');
  assert.equal(typeof state.retroCommand, 'string');
  assert.ok(state.retroCommand.includes(`run --run-id ${state.runId}`));
  assert.ok(logs.join('\n').includes(state.retroCommand), 'the advisory command is printed');
  assert.equal(fs.existsSync(path.join(root, `${state.artifactsDir}/${state.runId}.retro.md`)), false);
  assert.equal(fs.existsSync(path.join(root, `${state.artifactsDir}/${state.runId}.retro.json`)), false);
});

test('AC4: run refuses an open run for the same specification and writes no state', (t) => {
  const root = makeProject(t);
  const slug = 'guard-fixture';
  writeSpec(root, slug);
  writeOpenState(root, 'run-open-guard', slug);
  const before = stateFiles(root);

  const result = spawnSync(process.execPath, [ORCH, 'run', `.sdw/specs/${slug}.md`, '--root', root], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /run-open-guard/, 'the refusal names the existing run id');
  assert.match(output, /paused/, 'the refusal names its status');
  assert.match(output, /resume --run-id run-open-guard/, 'the refusal prints the exact resume command');
  assert.deepEqual(stateFiles(root), before, 'no new state file was created');
});

test('AC4: --new-run bypasses the start guard intentionally', (t) => {
  const root = makeProject(t);
  const slug = 'guard-new-run-fixture';
  writeSpec(root, slug);
  writeOpenState(root, 'run-open-guard', slug);

  const result = spawnSync(process.execPath, [
    ORCH, 'run', `.sdw/specs/${slug}.md`, '--root', root, '--new-run', '--unattended'
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 4, `${result.stdout}\n${result.stderr}`);
  const files = stateFiles(root);
  assert.equal(files.length, 2, 'the intentional second run was created');
  const created = files
    .filter((name) => name !== 'run-open-guard.state.json')
    .map((name) => JSON.parse(fs.readFileSync(path.join(stateManager.resolveStateDir(root), name), 'utf8')));
  assert.equal(created.length, 1);
  assert.equal(created[0].specSlug, slug);
  assert.equal(created[0].status, 'paused');
  assert.notEqual(created[0].runId, 'run-open-guard');
});
