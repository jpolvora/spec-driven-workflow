'use strict';

// Spec 00021 (slice 1): append-only JSONL telemetry emitted from the existing
// step-entry/completion points, and the read-only `monitor` projection.
// AC1-AC4 are this slice; watch, stall classification, JSON output, report
// aggregation, and dispatch/gate events belong to the remaining slices.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const telemetry = require('../skills/sdw-orch/scripts/telemetry.cjs');
const monitor = require('../skills/sdw-orch/scripts/monitor.cjs');

// Spec 027: step 5 delegates scoring to a judge; the deterministic stub keeps
// the run unattended instead of pausing with exit code 5.
require('./fixtures/judge_env.cjs').installJudgeEnv();

const ORCH = path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

// One implementation command for every task: it writes a real change and a
// valid evidence file, exactly like the other end-to-end suites.
const IMPLEMENTATION_COMMAND = 'node -e "const fs = require(\'fs\'); fs.writeFileSync(\'artifact-task.txt\', \'done\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\', \'AC2\'], filesChanged: [\'artifact-task.txt\'], summary: \'telemetry slice task\' }));"';

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-telemetry-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });
  sdwConfig.cmdInit({ root: tmpDir, force: true });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-telemetry', version: '1.0.0' }, null, 2), 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
  return tmpDir;
}

function createDummySpec(repoRoot, slug) {
  const specsDir = path.join(repoRoot, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const specPath = path.join(specsDir, `${slug}.md`);
  fs.writeFileSync(specPath, `---
id: null
slug: ${slug}
title: "Telemetry Test ${slug}"
source: local

status: draft
specDate: 2026-10-19
---

# Specification — Telemetry Test ${slug}

## Description
Specification for telemetry verification.
Affects file: skills/${slug}/scripts/worker.cjs

### Design Intent
Prove the append-only event stream and the read-only monitor.

## Acceptance Criteria
- AC1: The system shall emit one append-only telemetry event per step transition.
- AC2: The system shall store telemetry as JSONL under the run artifact directory.

## Notes
Implementation notes.

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
| Ready | Valid | Check |

## Validation & Observation Notes
### Telemetry & Observable Signals
telemetry.jsonl grows by one line per event.

### Negative & Failing Test Scenarios
- Scenario 1: a torn telemetry line is skipped.
`, 'utf8');
  return specPath;
}

function readTelemetry(repoRoot, artifactsDir) {
  const absolutePath = path.join(repoRoot, artifactsDir, telemetry.TELEMETRY_FILENAME);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  return {
    raw,
    lines: raw.split('\n').filter(line => line.trim() !== ''),
    events: raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  };
}

function writeStateFile(root, state) {
  const stateDir = path.join(root, '.sdw', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${state.runId}.state.json`), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// Every file under `root`, keyed by project-relative path with its exact bytes.
function snapshotTree(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      const rel = path.relative(root, absolutePath).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolutePath);
      else files[rel] = fs.readFileSync(absolutePath).toString('base64');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

test('AC1, AC2, AC3: every step transition appends one JSONL event with run id, step, name, status, timestamp, and duration', () => {
  const repoRoot = setupTestRepo();
  try {
    const slug = '021-telemetry-demo';
    const specPath = createDummySpec(repoRoot, slug);
    const runId = `run-${Date.now()}-telemetry`;

    const code = sdwOrch.cmdRun({
      root: repoRoot,
      specPath,
      runId,
      skipSecurity: true,
      skipReview: true,
      skipPr: true,
      unattended: true,
      implementation: { mode: 'command', command: IMPLEMENTATION_COMMAND }
    });
    assert.equal(code, 0, 'the command-mode run completes');

    const state = stateManager.loadRunState(repoRoot, runId);
    const artifactsDir = state.artifactsDir;
    assert.equal(artifactsDir, `.sdw/state/${slug}/${runId}`);

    // AC2: the event stream is JSONL beside the run state and artifacts.
    const telemetryRel = telemetry.telemetryPathFor(artifactsDir);
    assert.equal(telemetryRel, `${artifactsDir}/${telemetry.TELEMETRY_FILENAME}`);
    const recorded = readTelemetry(repoRoot, artifactsDir);
    assert.ok(recorded.lines.length > 0, 'the run wrote a telemetry stream');

    // AC1: exactly one entry event and one completion event per step, in order.
    assert.equal(recorded.events.length, 16, 'eight steps produce one entry and one completion event each');
    const byStep = new Map();
    for (const event of recorded.events) {
      if (!byStep.has(event.step)) byStep.set(event.step, []);
      byStep.get(event.step).push(event);
    }
    assert.deepEqual([...byStep.keys()], [1, 2, 3, 4, 5, 6, 7, 8], 'every step transition is recorded exactly once per phase');

    for (const [step, events] of byStep) {
      assert.equal(events.length, 2, `step ${step} records exactly one transition pair`);
      const [enter, done] = events;
      for (const event of events) {
        // AC3: every step event carries the six required fields.
        assert.equal(event.event, 'step');
        assert.equal(event.runId, runId);
        assert.equal(event.specSlug, slug);
        assert.ok(Number.isInteger(event.step) && event.step === step);
        assert.equal(event.stepName, state.steps[step].name, 'the step name matches the run state');
        assert.ok(typeof event.status === 'string' && event.status.length > 0);
        assert.ok(Number.isFinite(Date.parse(event.ts)), 'the timestamp is an ISO instant');
        assert.ok(Object.prototype.hasOwnProperty.call(event, 'durationMs'), 'duration is always present');
      }
      assert.equal(enter.status, 'in_progress', 'the entry event records the running status');
      assert.equal(enter.durationMs, null, 'AC3: duration is null while the step is running');
      assert.ok(['completed', 'skipped'].includes(done.status), 'the completion event records the resolved status');
      assert.ok(Number.isInteger(done.durationMs) && done.durationMs >= 0, 'AC3: a finished step carries its duration in ms');
      const startedAt = Date.parse(String(state.steps[step].startedAt || ''));
      const completedAt = Date.parse(String(state.steps[step].completedAt || ''));
      if (Number.isFinite(startedAt) && Number.isFinite(completedAt)) {
        assert.equal(done.durationMs, completedAt - startedAt, 'the duration matches the step startedAt/completedAt');
      }
      assert.ok(Date.parse(done.ts) >= Date.parse(enter.ts), 'the completion follows its entry');
    }

    // The event order follows the step order, so a reader can stream it.
    assert.deepEqual(
      recorded.events.map(event => `${event.step}:${event.status}`),
      [1, 2, 3, 4, 5, 6, 7, 8].flatMap(step => [`${step}:in_progress`, `${step}:${state.steps[step].status}`])
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('AC1, AC2: a resumed run appends to the existing stream and never rewrites prior events', () => {
  const repoRoot = setupTestRepo();
  try {
    const slug = '021-telemetry-resume';
    const specPath = createDummySpec(repoRoot, slug);
    const runId = `run-${Date.now()}-telemetry-resume`;

    // First invocation pauses at the Step 4 dispatch, leaving the run active.
    const firstCode = sdwOrch.cmdRun({
      root: repoRoot,
      specPath,
      runId,
      skipSecurity: true,
      skipReview: true,
      skipPr: true,
      unattended: true
    });
    assert.equal(firstCode, 4, 'subagent mode pauses with the dispatched task');

    const state = stateManager.loadRunState(repoRoot, runId);
    const before = readTelemetry(repoRoot, state.artifactsDir);
    assert.ok(before.events.length > 0, 'the first invocation recorded transitions');
    assert.ok(before.events.some(event => event.step === 4 && event.status === 'in_progress'));

    // Resume the same run in command mode, so it continues to a terminal state.
    const secondCode = sdwOrch.cmdResume({
      root: repoRoot,
      runId,
      skipSecurity: true,
      skipReview: true,
      skipPr: true,
      unattended: true,
      implementationMode: 'command',
      implementation: { mode: 'command', command: IMPLEMENTATION_COMMAND }
    });
    assert.equal(secondCode, 0, 'the resumed run completes');

    const after = readTelemetry(repoRoot, state.artifactsDir);
    assert.ok(after.raw.startsWith(before.raw), 'AC1: the resumed run appends; prior bytes are untouched');
    assert.deepEqual(
      after.events.slice(0, before.events.length),
      before.events,
      'AC1: appended events never rewrite the earlier stream'
    );
    assert.ok(after.events.length > before.events.length, 'the resume recorded new transitions');
    const appended = after.events.slice(before.events.length);
    assert.ok(
      appended.some(event => event.event === 'step' && event.step === 4 && event.status === 'completed'),
      'the resume recorded the Step 4 completion through the existing completion point'
    );
    const resumed = stateManager.loadRunState(repoRoot, runId);
    assert.equal(resumed.status, 'completed', 'the run reached a terminal state');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('AC4: monitor lists an active run with status, current step, and age from the run state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-monitor-'));
  try {
    const now = '2026-10-23T19:30:00.000Z';
    writeStateFile(root, {
      orchestrator: 'sdw-orch',
      runId: 'run-monitor-active',
      specSlug: '021-monitor-demo',
      status: 'in_progress',
      currentStep: 2,
      totalSteps: 8,
      createdAt: '2026-10-23T19:20:00.000Z',
      updatedAt: '2026-10-23T19:29:00.000Z',
      artifactsDir: '.sdw/state/021-monitor-demo/run-monitor-active',
      steps: {
        1: { name: 'derivation', status: 'completed', startedAt: '2026-10-23T19:20:01.000Z', completedAt: '2026-10-23T19:20:02.000Z' },
        2: { name: 'refinement', status: 'in_progress', startedAt: '2026-10-23T19:25:00.000Z', completedAt: null }
      }
    });
    writeStateFile(root, {
      orchestrator: 'sdw-orch',
      runId: 'run-monitor-finished',
      specSlug: '021-monitor-demo',
      status: 'completed',
      currentStep: 8,
      totalSteps: 8,
      createdAt: '2026-10-23T18:00:00.000Z',
      updatedAt: '2026-10-23T18:30:00.000Z',
      artifactsDir: '.sdw/state/021-monitor-demo/run-monitor-finished',
      steps: { 8: { name: 'pr_preparation', status: 'completed' } }
    });

    // The telemetry stream is the second clock the monitor projects; a torn line
    // is skipped instead of hiding the newest real event.
    const telemetryDir = path.join(root, '.sdw', 'state', '021-monitor-demo', 'run-monitor-active');
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(path.join(telemetryDir, telemetry.TELEMETRY_FILENAME), [
      JSON.stringify({ ts: '2026-10-23T19:25:00.000Z', runId: 'run-monitor-active', event: 'step', step: 2, status: 'in_progress' }),
      '{"ts":"torn',
      JSON.stringify({ ts: '2026-10-23T19:27:00.000Z', runId: 'run-monitor-active', event: 'step', step: 2, status: 'in_progress' }),
      ''
    ].join('\n'), 'utf8');

    const active = monitor.listActiveRuns({ targetRoot: root, now });
    assert.equal(active.runs.length, 1, 'only the active run is listed');
    const [run] = active.runs;
    assert.equal(run.runId, 'run-monitor-active');
    assert.equal(run.status, 'in_progress');
    assert.equal(run.currentStep, 2);
    assert.equal(run.stepName, 'refinement', 'the current step is named');
    assert.equal(run.stepStatus, 'in_progress');
    assert.equal(run.ageSeconds, 600, 'AC4: age is derived from the createdAt timestamp');
    assert.equal(monitor.formatAge(run.ageSeconds), '10m');
    assert.equal(run.lastEventAt, '2026-10-23T19:27:00.000Z', 'the newest valid telemetry timestamp is projected');

    const rendered = monitor.renderMonitor(active);
    assert.match(rendered, /^SDW Orchestrator Monitor$/m);
    assert.match(rendered, /^\| Run \| Spec \| Status \| Step \| Age \|$/m);
    assert.match(rendered, /^\| run-monitor-active \| 021-monitor-demo \| in_progress \| 2\/8 refinement \| 10m \|$/m);
    assert.equal(rendered.includes('run-monitor-finished'), false, 'terminal runs are history, not active work');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4: the monitor command is read-only, reporting an active run without touching state, telemetry, or the ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-monitor-cli-'));
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-monitor-empty-'));
  try {
    const slug = '021-monitor-cli';
    const runId = 'run-monitor-cli';
    const artifactsRel = `.sdw/state/${slug}/${runId}`;
    const artifactsAbs = path.join(root, artifactsRel);
    fs.mkdirSync(artifactsAbs, { recursive: true });
    const createdAt = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
    writeStateFile(root, {
      orchestrator: 'sdw-orch',
      runId,
      specSlug: slug,
      status: 'paused',
      currentStep: 4,
      totalSteps: 8,
      createdAt,
      updatedAt: new Date().toISOString(),
      artifactsDir: artifactsRel,
      steps: { 4: { name: 'implementation', status: 'awaiting_implementation', startedAt: createdAt, completedAt: null } }
    });
    fs.writeFileSync(path.join(artifactsAbs, telemetry.TELEMETRY_FILENAME), [
      JSON.stringify({ ts: new Date().toISOString(), runId, specSlug: slug, event: 'step', step: 4, stepName: 'implementation', status: 'in_progress', durationMs: null }),
      ''
    ].join('\n'), 'utf8');

    const before = snapshotTree(root);
    const result = spawnSync(process.execPath, [ORCH, 'monitor', '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\| ${runId} \\| ${slug} \\| paused \\| 4/8 implementation \\|`));
    assert.match(result.stdout, /Active runs: 1/);

    // Read-only guarantee: every byte under the workspace is unchanged and no
    // ledger was created beside the state it read.
    const after = snapshotTree(root);
    assert.deepEqual(after, before, 'the monitor leaves the workspace byte-identical');
    assert.equal(fs.existsSync(path.join(artifactsAbs, 'ac-ledger.json')), false, 'the monitor creates no acceptance ledger');

    // A workspace with no state directory is reported, never initialized.
    const empty = spawnSync(process.execPath, [ORCH, 'monitor', '--root', emptyRoot], { encoding: 'utf8' });
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /No active runs\./);
    assert.equal(fs.existsSync(path.join(emptyRoot, '.sdw')), false, 'the monitor never initializes the state layout');
    assert.deepEqual(fs.readdirSync(emptyRoot), [], 'the empty workspace stays empty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('AC1: `monitor` is wired as a subcommand and a telemetry append failure stays non-fatal', () => {
  const parsed = sdwOrch.parseArgs(['monitor', '--run-id', 'run-1']);
  assert.equal(parsed.subcommand, 'monitor');
  assert.equal(parsed.runId, 'run-1');
  assert.equal(parsed.specPath, null, 'monitor takes no spec path');

  const help = spawnSync(process.execPath, [ORCH, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /monitor\s+List active runs with status, current step, and age/);

  // AC12 owns the operator-facing warning; this slice guarantees the step
  // survives. `blocked` is a file, so the writer can never create its directory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-telemetry-fail-'));
  try {
    fs.writeFileSync(path.join(root, 'blocked'), 'this is a file, not a directory', 'utf8');
    const warnings = [];
    const writer = telemetry.createWriter({
      targetRoot: root,
      telemetryPath: path.join('blocked', telemetry.TELEMETRY_FILENAME),
      runId: 'run-1',
      specSlug: 'demo',
      now: () => new Date('2026-10-23T19:20:00.000Z'),
      onWarn: message => warnings.push(message)
    });

    const event = writer.recordStep({ step: 1, stepName: 'derivation', status: 'in_progress', durationMs: null });
    assert.equal(event, null, 'a failed append returns null instead of throwing');
    assert.equal(writer.isDegraded(), true);
    assert.equal(warnings.length, 1, 'the writer warns once');
    assert.match(warnings[0], /telemetry append failed/);
    assert.equal(fs.existsSync(path.join(root, 'blocked', telemetry.TELEMETRY_FILENAME)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
