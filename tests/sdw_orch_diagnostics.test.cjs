'use strict';

// Spec 00033 (slice 1): `--diagnostic` flag, the zero-dependency recorder, step
// transitions with timestamps, and bounded stderr capture for failed tools.
// Diagnostics are off by default and never change a run without the flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const diagnostics = require('../skills/sdw-orch/scripts/diagnostics.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

const ORCH = path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

const SPEC = `---
slug: diag-demo
title: "Diagnostics Demo"
---

# Specification — Diagnostics Demo

## Description

Exercises diagnostic run mode.

## Acceptance Criteria

- AC1: The system shall record step transitions.
- AC2: The system shall record failed tool executions.
- AC3: The system shall keep delivery behavior unchanged.
`;

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdw', 'specs', 'diag-demo.md'), SPEC, 'utf8');
  return root;
}

test('AC1: --diagnostic is documented in --help', () => {
  const help = spawnSync(process.execPath, [ORCH, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--diagnostic\s+Record step transitions and tool failures for run, resume/);
});

test('AC1: --diagnostic is parsed for run and resume and is off by default', () => {
  const run = sdwOrch.parseArgs(['run', '.sdw/specs/demo.md', '--diagnostic']);
  assert.equal(run.subcommand, 'run');
  assert.equal(run.diagnostic, true);

  const resume = sdwOrch.parseArgs(['resume', '--run-id', 'run-1', '--diagnostic']);
  assert.equal(resume.subcommand, 'resume');
  assert.equal(resume.diagnostic, true);

  assert.equal(sdwOrch.parseArgs(['run', '.sdw/specs/demo.md']).diagnostic, false, 'diagnostics are off by default');
  assert.equal(sdwOrch.parseArgs(['resume', '--run-id', 'run-1']).diagnostic, false);
});

test('AC1: --diagnostic is ignored with a warning where it cannot wrap execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    const result = spawnSync(process.execPath, [ORCH, 'status', '--diagnostic', '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'status still reports that no run exists');
    assert.match(result.stderr, /--diagnostic applies to "run" and "resume" only; ignoring it for "status"\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: the recorder requires only Node.js built-in modules', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'diagnostics.cjs'), 'utf8');
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.ok(required.length > 0, 'the recorder loads its built-in dependencies explicitly');
  const builtins = new Set(require('module').builtinModules);
  for (const id of required) {
    const bare = id.replace(/^node:/, '');
    assert.ok(!bare.startsWith('.') && builtins.has(bare), `${id} must be a Node.js built-in, not a runtime dependency`);
  }
});

test('AC2: a disabled recorder is a no-op that writes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    const eventsPath = path.join('.sdw', 'state', 'demo', 'run-1', 'diagnostics.jsonl');
    const warnings = [];
    const recorder = diagnostics.createRecorder({
      enabled: false,
      eventsPath,
      targetRoot: root,
      onWarn: message => warnings.push(message)
    });

    assert.equal(recorder.enabled, false);
    assert.equal(recorder.recordStepTransition({ step: 1, transition: 'enter' }), null);
    assert.equal(recorder.recordToolFailure({ step: 4, command: 'npm test', exitCode: 1, stderr: 'boom' }), null);
    assert.deepEqual(recorder.getEvents(), []);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(root, eventsPath)), false, 'a disabled recorder creates no event file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: step transitions are recorded with ISO timestamps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    const eventsPath = path.join('.sdw', 'state', 'demo', 'run-1', 'diagnostics.jsonl');
    const recorder = diagnostics.createRecorder({
      enabled: true,
      eventsPath,
      targetRoot: root,
      now: () => new Date('2026-10-21T15:04:05.000Z')
    });

    assert.ok(recorder.recordStepTransition({ step: 1, transition: 'enter' }));
    assert.ok(recorder.recordStepTransition({ step: 1, transition: 'done' }));

    const events = recorder.getEvents();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.kind), ['step_transition', 'step_transition']);
    assert.deepEqual(events.map(event => event.step), [1, 1]);
    assert.deepEqual(events.map(event => event.note), ['enter', 'done']);
    for (const event of events) {
      assert.equal(event.ts, '2026-10-21T15:04:05.000Z', 'every event carries the ISO timestamp');
    }

    const lines = fs.readFileSync(path.join(root, eventsPath), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2, 'enabled events are appended as JSONL');
    assert.deepEqual(lines.map(event => event.note), ['enter', 'done']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4: a failed tool records its exit code and a bounded stderr snippet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    const recorder = diagnostics.createRecorder({
      enabled: true,
      eventsPath: path.join('.sdw', 'state', 'demo', 'run-1', 'diagnostics.jsonl'),
      targetRoot: root,
      now: () => new Date('2026-10-21T15:04:05.000Z')
    });

    const stderr = `first line of the failure\n${'E'.repeat(800)}`;
    const event = recorder.recordToolFailure({ step: 4, command: 'npm test', exitCode: 7, stderr });

    assert.equal(event.kind, 'tool_failure');
    assert.equal(event.step, 4);
    assert.equal(event.command, 'npm test');
    assert.equal(event.exitCode, 7, 'the exit code is captured');
    assert.equal(event.snippet.length, diagnostics.MAX_SNIPPET_CHARS, 'the stderr snippet is capped at 500 characters');
    assert.equal(diagnostics.MAX_SNIPPET_CHARS, 500);
    assert.ok(event.snippet.startsWith('first line of the failure'), 'the beginning of stderr is kept');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4: a failing verification gate is recorded at the tool boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    fs.writeFileSync(path.join(root, 'failing-tool.cjs'), 'process.stderr.write("tool blew up\\n"); process.exit(7);\n', 'utf8');
    const recorder = diagnostics.createRecorder({
      enabled: true,
      eventsPath: path.join('.sdw', 'state', 'demo', 'run-1', 'diagnostics.jsonl'),
      targetRoot: root
    });

    const result = sdwOrch.runVerificationGates(
      root,
      { verification: { buildCommand: `"${process.execPath}" failing-tool.cjs`, timeoutMs: 60000 } },
      { requiredBuild: true, runAllTests: false, diagnosticRecorder: recorder }
    );

    assert.equal(result.passed, false, 'the failing gate still fails the gate');
    assert.equal(result.gates.build.exitCode, 7);
    const failure = recorder.getEvents().find(event => event.kind === 'tool_failure');
    assert.ok(failure, 'the failed tool execution is recorded');
    assert.equal(failure.step, 4);
    assert.equal(failure.exitCode, 7);
    assert.match(failure.snippet, /tool blew up/);
    assert.ok(failure.snippet.length <= 500);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4 & AC10 design: a recorder write failure warns once and never throws', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    fs.writeFileSync(path.join(root, 'blocked'), 'this is a file, not a directory', 'utf8');
    const warnings = [];
    const recorder = diagnostics.createRecorder({
      enabled: true,
      eventsPath: path.join('blocked', 'diagnostics.jsonl'),
      targetRoot: root,
      onWarn: message => warnings.push(message)
    });

    assert.ok(recorder.recordStepTransition({ step: 2, transition: 'enter' }), 'the event is still recorded in memory');
    assert.ok(recorder.recordStepTransition({ step: 2, transition: 'done' }));
    assert.equal(recorder.isDegraded(), true);
    assert.equal(warnings.length, 1, 'the degradation warning is emitted once');
    assert.match(warnings[0], /diagnostics degraded/);
    assert.equal(recorder.getEvents().length, 2, 'fail-open recording keeps the in-memory event stream');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 & AC3: a diagnostic run records state and step transitions; a plain run does not', () => {
  const diagnosticRoot = makeProject();
  const plainRoot = makeProject();
  try {
    const code = sdwOrch.cmdRun({
      root: diagnosticRoot,
      specPath: '.sdw/specs/diag-demo.md',
      skipReview: true,
      skipPr: true,
      diagnostic: true
    });
    assert.equal(code, 4, 'the run pauses after dispatching its first Step 4 task');

    const state = stateManager.findLatestRunState(diagnosticRoot);
    assert.equal(state.diagnostic.enabled, true, 'AC1: diagnostic mode is recorded on the run state');
    assert.equal(typeof state.diagnostic.startedAt, 'string');
    assert.match(state.diagnostic.eventsPath, /diagnostics\.jsonl$/);

    const events = fs.readFileSync(path.join(diagnosticRoot, state.diagnostic.eventsPath), 'utf8')
      .trim().split('\n').map(JSON.parse);
    const transitions = events.filter(event => event.kind === 'step_transition');
    assert.ok(transitions.length > 0, 'AC3: step transitions are recorded');
    for (const step of [1, 2, 3]) {
      assert.ok(transitions.some(event => event.step === step && event.note === 'enter'), `step ${step} entry is recorded`);
      assert.ok(transitions.some(event => event.step === step && event.note === 'done'), `step ${step} completion is recorded`);
    }
    assert.ok(transitions.some(event => event.step === 4 && event.note === 'enter'), 'step 4 entry is recorded');
    for (const event of transitions) {
      assert.equal(typeof event.ts, 'string');
      assert.ok(!Number.isNaN(Date.parse(event.ts)), 'every transition timestamp is a valid ISO date');
    }

    // AC1: a diagnostic resume keeps the recorded state and start time, and the
    // in-flight Step 4 task is re-emitted rather than re-dispatched.
    const resumeCode = sdwOrch.cmdResume({ root: diagnosticRoot, runId: state.runId, diagnostic: true });
    assert.equal(resumeCode, 4);
    const resumedState = stateManager.loadRunState(diagnosticRoot, state.runId);
    assert.equal(resumedState.diagnostic.enabled, true, 'AC1: resume keeps diagnostic mode on the run state');
    assert.equal(resumedState.diagnostic.startedAt, state.diagnostic.startedAt, 'resume preserves the diagnostic start time');
    assert.equal(resumedState.diagnostic.eventsPath, state.diagnostic.eventsPath);

    const plainCode = sdwOrch.cmdRun({
      root: plainRoot,
      specPath: '.sdw/specs/diag-demo.md',
      skipReview: true,
      skipPr: true
    });
    assert.equal(plainCode, 4, 'the plain run keeps its delivery behavior');
    const plainState = stateManager.findLatestRunState(plainRoot);
    assert.equal(plainState.diagnostic, undefined, 'without the flag the run state is unchanged');
    assert.equal(
      fs.existsSync(path.join(plainRoot, plainState.artifactsDir, 'diagnostics.jsonl')),
      false,
      'without the flag no diagnostics file is written'
    );
  } finally {
    fs.rmSync(diagnosticRoot, { recursive: true, force: true });
    fs.rmSync(plainRoot, { recursive: true, force: true });
  }
});

test('AC5: a script that exits non-zero keeps its command and a bounded output excerpt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    fs.writeFileSync(path.join(root, 'failing-script.cjs'), [
      "'use strict';",
      "process.stdout.write('partial progress\\n');",
      "process.stderr.write('script exploded\\n' + 'X'.repeat(900));",
      'process.exit(3);'
    ].join('\n'), 'utf8');
    const eventsPath = path.join('.sdw', 'state', 'diag-demo', 'run-1', 'diagnostics.jsonl');
    const recorder = diagnostics.createRecorder({ enabled: true, eventsPath, targetRoot: root });

    const result = sdwOrch.runScriptWithDiagnostics(recorder, {
      step: 7,
      script: path.join(root, 'failing-script.cjs'),
      cwd: root
    });

    assert.equal(result.status, 3, 'the spawn result is unchanged for the caller');
    const failure = recorder.getEvents().find(event => event.kind === 'script_failure');
    assert.ok(failure, 'the failing script is recorded');
    assert.equal(failure.step, 7);
    assert.equal(failure.exitCode, 3);
    assert.match(failure.command, /failing-script\.cjs/, 'the failing command is preserved');
    assert.match(failure.snippet, /partial progress/, 'the stdout excerpt is kept');
    assert.match(failure.snippet, /script exploded/, 'the stderr excerpt is kept');
    assert.ok(failure.snippet.length <= diagnostics.MAX_SNIPPET_CHARS, 'the output excerpt is bounded');

    const persisted = fs.readFileSync(path.join(root, eventsPath), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(persisted.find(event => event.kind === 'script_failure').exitCode, 3, 'the failure persists in the JSONL');

    fs.writeFileSync(path.join(root, 'ok-script.cjs'), "process.stdout.write('fine\\n');", 'utf8');
    const quietRecorder = diagnostics.createRecorder({
      enabled: true,
      eventsPath: path.join('.sdw', 'state', 'diag-demo', 'run-2', 'diagnostics.jsonl'),
      targetRoot: root
    });
    const ok = sdwOrch.runScriptWithDiagnostics(quietRecorder, {
      step: 7,
      script: path.join(root, 'ok-script.cjs'),
      cwd: root
    });
    assert.equal(ok.status, 0);
    assert.deepEqual(quietRecorder.getEvents(), [], 'a successful script records nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC6: reopening a run appends JSONL events without rewriting earlier lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    const eventsPath = path.join('.sdw', 'state', 'diag-demo', 'run-1', 'diagnostics.jsonl');
    const absolutePath = path.join(root, eventsPath);
    const first = diagnostics.createRecorder({
      enabled: true,
      eventsPath,
      targetRoot: root,
      now: () => new Date('2026-10-21T15:04:05.000Z')
    });
    first.recordStepTransition({ step: 2, transition: 'enter' });
    first.recordToolFailure({ step: 4, command: 'npm test', exitCode: 1, stderr: 'first failure' });
    const firstLines = fs.readFileSync(absolutePath, 'utf8').trim().split('\n');
    assert.equal(firstLines.length, 2);

    // Reopening the same run (a resume) creates a new recorder on the same file.
    const second = diagnostics.createRecorder({
      enabled: true,
      eventsPath,
      targetRoot: root,
      now: () => new Date('2026-10-21T15:05:05.000Z')
    });
    second.recordStepTransition({ step: 2, transition: 'done' });
    second.recordStepTransition({ step: 3, transition: 'enter' });

    const secondLines = fs.readFileSync(absolutePath, 'utf8').trim().split('\n');
    assert.equal(secondLines.length, 4, 'a reopened run appends instead of truncating');
    assert.deepEqual(secondLines.slice(0, 2), firstLines, 'earlier lines are byte-identical after reopening');
    for (const line of secondLines) {
      assert.doesNotThrow(() => JSON.parse(line), 'every line stays valid JSON');
    }

    const disabled = diagnostics.createRecorder({ enabled: false, eventsPath, targetRoot: root });
    disabled.recordStepTransition({ step: 3, transition: 'done' });
    assert.deepEqual(fs.readFileSync(absolutePath, 'utf8').trim().split('\n'), secondLines, 'a disabled recorder writes nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC6: a resumed diagnostic run appends to the same JSONL file', () => {
  const root = makeProject();
  try {
    assert.equal(sdwOrch.cmdRun({
      root,
      specPath: '.sdw/specs/diag-demo.md',
      skipReview: true,
      skipPr: true,
      diagnostic: true
    }), 4);
    const state = stateManager.findLatestRunState(root);
    const eventsAbsolutePath = path.join(root, state.diagnostic.eventsPath);
    const beforeResume = fs.readFileSync(eventsAbsolutePath, 'utf8').trim().split('\n');
    assert.ok(beforeResume.length > 0);

    assert.equal(sdwOrch.cmdResume({ root, runId: state.runId, diagnostic: true }), 4);

    const afterResume = fs.readFileSync(eventsAbsolutePath, 'utf8').trim().split('\n');
    assert.ok(afterResume.length > beforeResume.length, 'the resume appends new events');
    assert.deepEqual(afterResume.slice(0, beforeResume.length), beforeResume, 'the earlier run is never rewritten');
    for (const line of afterResume) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC7: a failing gate retry loop counts attempts and records the fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    fs.writeFileSync(
      path.join(root, 'gate-tool.cjs'),
      "process.stderr.write('gate exploded\\n'); process.exit(9);\n",
      'utf8'
    );
    const eventsPath = path.join('.sdw', 'state', 'diag-demo', 'run-1', 'diagnostics.jsonl');
    const recorder = diagnostics.createRecorder({ enabled: true, eventsPath, targetRoot: root });
    const fixerCalls = [];

    const result = sdwOrch.runVerificationGates(
      root,
      { verification: { buildCommand: `"${process.execPath}" gate-tool.cjs`, timeoutMs: 60000 } },
      {
        requiredBuild: true,
        runAllTests: false,
        diagnosticRecorder: recorder,
        buildFixer: (targetRoot, attempt) => fixerCalls.push(attempt)
      }
    );

    assert.equal(result.passed, false, 'the exhausted loop still fails the gate');
    assert.deepEqual(fixerCalls, [1, 2, 3], 'the existing repair loop ran its full retry budget');

    const retries = recorder.getEvents().filter(event => event.kind === 'retry');
    assert.deepEqual(retries.map(event => event.attempt), [1, 2, 3], 'every repair attempt is counted');
    for (const retry of retries) {
      assert.equal(retry.step, 4);
      assert.match(retry.command, /gate-tool\.cjs/);
      assert.match(retry.note, /build repair attempt/);
    }

    const fallbacks = recorder.getEvents().filter(event => event.kind === 'fallback');
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].step, 4);
    assert.equal(fallbacks[0].attempt, 4, 'the fallback carries the attempt that exhausted the budget');
    assert.match(fallbacks[0].note, /no retry budget remains/);

    // Without a repair hook the first failure is already the fallback path.
    const noFixerRecorder = diagnostics.createRecorder({
      enabled: true,
      eventsPath: path.join('.sdw', 'state', 'diag-demo', 'run-2', 'diagnostics.jsonl'),
      targetRoot: root
    });
    const noFixer = sdwOrch.runVerificationGates(
      root,
      { verification: { buildCommand: `"${process.execPath}" gate-tool.cjs`, timeoutMs: 60000 } },
      { requiredBuild: true, runAllTests: false, diagnosticRecorder: noFixerRecorder }
    );
    assert.equal(noFixer.passed, false);
    assert.deepEqual(noFixerRecorder.getEvents().filter(event => event.kind === 'retry'), []);
    const noFixerFallback = noFixerRecorder.getEvents().find(event => event.kind === 'fallback');
    assert.equal(noFixerFallback.attempt, 1, 'a gate with no retry budget records its fallback on the first attempt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC8: the report renders deterministically from JSONL with a run summary and issue table', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-diag-'));
  try {
    const eventsPath = path.join('.sdw', 'state', 'diag-demo', 'run-1', 'diagnostics.jsonl');
    const events = [
      { ts: '2026-10-21T15:04:05.000Z', kind: 'step_transition', step: 1, note: 'enter' },
      { ts: '2026-10-21T15:04:06.000Z', kind: 'script_failure', step: 7, command: 'node "review.cjs" run', exitCode: 3, snippet: 'review exploded' },
      { ts: '2026-10-21T15:04:07.000Z', kind: 'retry', step: 7, command: 'node "review.cjs" run --fix', attempt: 1, note: 'review convergence iteration 1/3' },
      { ts: '2026-10-21T15:04:08.000Z', kind: 'fallback', step: 7, command: 'node "review.cjs" run --fix', attempt: 3, note: 'review convergence stopped: no fixable findings were reported' }
    ];
    fs.mkdirSync(path.dirname(path.join(root, eventsPath)), { recursive: true });
    fs.writeFileSync(path.join(root, eventsPath), events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');

    const first = diagnostics.renderReport({
      slug: 'diag-demo',
      runId: 'run-1',
      status: 'failed',
      events,
      eventsPath
    });
    const second = diagnostics.renderReport({
      slug: 'diag-demo',
      runId: 'run-1',
      status: 'failed',
      events,
      eventsPath
    });
    assert.equal(first, second, 'the same JSONL renders byte-identical Markdown');

    assert.match(first, /^# Diagnostics report: diag-demo/);
    assert.match(first, /## Run summary/);
    assert.match(first, /\| Status \| failed \|/);
    assert.match(first, /\| Events \| 4 \|/);
    assert.match(first, /## Issues/);
    assert.match(first, /^\| Severity \| Step \| Evidence \|$/m);
    assert.match(first, /^\| error \| 7 \| script_failure;/m, 'a failing script appears as an error issue');
    assert.match(first, /exit 3/, 'the evidence keeps the exit code');
    assert.match(first, /^\| warning \| 7 \| retry;/m, 'a retry appears as a warning issue');
    assert.match(first, /attempt 1/);
    assert.match(first, /^\| warning \| 7 \| fallback;/m, 'a fallback appears as a warning issue');
    assert.match(first, /review convergence stopped/);
    assert.equal(/^\| \w+ \| 1 \| step_transition/m.test(first), false, 'step transitions are summarized, not listed as issues');

    const written = diagnostics.writeReport({
      targetRoot: root,
      artifactsDir: path.join('.sdw', 'state', 'diag-demo', 'run-1'),
      slug: 'diag-demo',
      runId: 'run-1',
      status: 'failed',
      eventsPath
    });
    assert.equal(written.ok, true);
    assert.equal(written.path, '.sdw/state/diag-demo/run-1/diag-demo-diagnostics.md');
    assert.equal(written.eventCount, 4);
    assert.equal(fs.readFileSync(path.join(root, written.path), 'utf8'), first, 'the written report is the rendered report');

    // AC8 fail-open: an unwritable report path returns a failure, never a throw.
    fs.writeFileSync(path.join(root, 'blocked'), 'this is a file, not a directory', 'utf8');
    const failedWrite = diagnostics.writeReport({
      targetRoot: root,
      artifactsDir: path.join('blocked', 'nested'),
      slug: 'diag-demo',
      runId: 'run-1',
      status: 'failed',
      eventsPath
    });
    assert.equal(failedWrite.ok, false);
    assert.equal(typeof failedWrite.error, 'string');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC8: a terminal run emits the diagnostics report and an intermediate pause does not', () => {
  const root = makeProject();
  try {
    assert.equal(sdwOrch.cmdRun({
      root,
      specPath: '.sdw/specs/diag-demo.md',
      skipReview: true,
      skipPr: true,
      diagnostic: true
    }), 4);
    const state = stateManager.findLatestRunState(root);
    const reportRelPath = `${state.artifactsDir}/diag-demo-diagnostics.md`;
    assert.equal(fs.existsSync(path.join(root, reportRelPath)), false, 'a paused dispatch writes no report');

    // A terminal failure that only reached the command result (for example when
    // the state write itself failed) still emits the report.
    const resultOnly = sdwOrch.finalizeDiagnosticRun({
      root,
      _runResult: { status: 'failed' },
      _diagnosticRun: {
        runId: 'run-missing',
        specSlug: state.specSlug,
        artifactsDir: state.artifactsDir,
        eventsPath: state.diagnostic.eventsPath
      }
    });
    assert.ok(resultOnly && resultOnly.ok, 'a terminal failure carried by the result emits the report');

    state.status = 'completed';
    stateManager.saveRunState(root, state);
    const result = sdwOrch.finalizeDiagnosticRun({
      root,
      _diagnosticRun: {
        runId: state.runId,
        specSlug: state.specSlug,
        artifactsDir: state.artifactsDir,
        eventsPath: state.diagnostic.eventsPath
      }
    });

    assert.ok(result && result.ok, 'a terminal run writes the report');
    assert.equal(result.path, reportRelPath);
    const markdown = fs.readFileSync(path.join(root, reportRelPath), 'utf8');
    assert.match(markdown, /^# Diagnostics report: diag-demo/);
    assert.match(markdown, /## Run summary/);
    assert.match(markdown, /## Issues/);
    assert.match(markdown, /^\| Severity \| Step \| Evidence \|$/m);

    // A write failure is reported, never thrown, so delivery is unaffected.
    fs.writeFileSync(path.join(root, 'blocked-report'), 'file', 'utf8');
    const degraded = sdwOrch.finalizeDiagnosticRun({
      root,
      _diagnosticRun: {
        runId: state.runId,
        specSlug: state.specSlug,
        artifactsDir: path.join('blocked-report', 'nested'),
        eventsPath: state.diagnostic.eventsPath
      }
    });
    assert.equal(degraded.ok, false, 'an unwritable report is reported as degraded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
