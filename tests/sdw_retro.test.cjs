'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execSync, spawnSync } = require('child_process');

const retro = require('../skills/sdw-retro/scripts/retro.cjs');
const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');

// Spec 027: run the deterministic judge stub when an orchestration fixture
// completes past Step 4.
require('./fixtures/judge_env.cjs').installJudgeEnv();

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'skills', 'sdw-retro', 'scripts', 'retro.cjs');
const VALIDATOR = path.join(REPO_ROOT, 'skills', 'sdw-retro', 'scripts', 'validate_candidates.cjs');

function makeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-retro-'));
  fs.mkdirSync(path.join(dir, '.sdw', 'state'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stepPath(state, step) {
  return `${state.artifactsDir}/${state.specSlug}-step-${step}.md`;
}

function makeState(options) {
  const runId = options.runId;
  const slug = options.slug;
  const artifactsDir = `.sdw/state/${slug}/${runId}`;
  const state = {
    orchestrator: 'sdw-orch',
    runId,
    specSlug: slug,
    status: options.status || 'completed',
    createdAt: '2025-12-31T00:00:00.000Z',
    updatedAt: options.updatedAt || '2026-01-01T00:00:00.000Z',
    scoreIteration: 1,
    reviewIteration: 0,
    artifactsDir,
    steps: {
      '1': { name: 'derivation', status: 'skipped', artifact: null },
      '2': { name: 'refinement', status: 'completed', artifact: null },
      '3': { name: 'dag_generation', status: 'completed', artifact: null },
      '4': {
        name: 'implementation',
        status: 'completed',
        artifact: null,
        tasks: {},
        gates: { test: { status: 'passed', exitCode: 0, durationMs: 12 } },
        output: { gates: { test: { status: 'passed', exitCode: 0, durationMs: 12 } } },
        dispatch: {
          sequence: 1,
          abandonments: [
            { taskId: 'task-1', reason: 'worker stopped before reporting', at: '2026-01-01T01:00:00.000Z' }
          ]
        }
      },
      '5': {
        name: 'scoring',
        status: 'completed',
        artifact: null,
        output: { score: 9, minScore: 8, passed: true, judge: { reportedScore: 9 } }
      },
      '6': { name: 'delivery_commit', status: 'completed', artifact: null },
      '7': {
        name: 'code_review',
        status: 'completed',
        artifact: null,
        output: {
          findings: [{ id: 'CR-001', severity: 'warning', path: 'skills/x.cjs', line: 3, status: 'open' }],
          blockingCount: 0
        }
      },
      '8': {
        name: 'pr_preparation',
        status: 'completed',
        artifact: null,
        output: {
          reviewConvergence: {
            rounds: 1,
            activeThreads: 1,
            resolvedThreads: 2,
            pendingThreads: [{ threadId: 'PRRT_1', path: 'skills/x.cjs', line: 7 }]
          }
        }
      }
    }
  };
  state.steps['2'].artifact = stepPath(state, '2');
  state.steps['3'].artifact = stepPath(state, '3');
  state.steps['5'].artifact = stepPath(state, '5');
  state.steps['7'].artifact = stepPath(state, '7');
  return state;
}

function writeState(root, state) {
  fs.writeFileSync(
    path.join(root, '.sdw', 'state', `${state.runId}.state.json`),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8'
  );
}

function writeArtifact(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function writeBinaryArtifact(root, relative, buffer) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, buffer);
}

function writeDefaultArtifacts(root, state) {
  writeArtifact(root, stepPath(state, '2'), '# Step 2\n# Refinement\n');
  writeArtifact(root, stepPath(state, '3'), '# Step 3\n');
  writeArtifact(root, stepPath(state, '5'), '# Step 5\n');
  writeArtifact(root, stepPath(state, '7'), '# Step 7\n');
}

function runRetroCli(root, args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { cwd: root, encoding: 'utf8' });
}

test('AC4: omitting --run-id selects the most recent completed run', (t) => {
  const root = makeProject(t);
  const older = makeState({ runId: 'run-1000-older', slug: '00100-older', updatedAt: '2026-01-01T00:00:00.000Z' });
  const newer = makeState({ runId: 'run-2000-newer', slug: '00101-newer', updatedAt: '2026-02-01T00:00:00.000Z' });
  const failed = makeState({ runId: 'run-3000-failed', slug: '00102-failed', status: 'failed', updatedAt: '2026-03-01T00:00:00.000Z' });
  for (const state of [older, newer, failed]) writeState(root, state);
  writeDefaultArtifacts(root, newer);
  writeArtifact(root, stepPath(older, '2'), '# older\n');
  writeArtifact(root, stepPath(failed, '2'), '# failed\n');

  const result = runRetroCli(root, ['run', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runId, 'run-2000-newer', 'newest completed run wins over older and failed runs');
  assert.equal(report.status, 'completed');
  assert.ok(fs.existsSync(path.join(root, report.artifactsDir, 'run-2000-newer.retro.md')));
  assert.equal(fs.existsSync(path.join(root, older.artifactsDir, 'run-1000-older.retro.md')), false);
  assert.equal(fs.existsSync(path.join(root, failed.artifactsDir, 'run-3000-failed.retro.json')), false);

  const human = runRetroCli(root, ['run']);
  assert.equal(human.status, 0, human.stderr);
  const selectionLine = human.stdout.indexOf('retro: run=run-2000-newer');
  const artifactsLine = human.stdout.indexOf('retro: artifacts=.sdw/state/00101-newer/run-2000-newer');
  const writeLine = human.stdout.indexOf('retro: wrote ');
  assert.ok(selectionLine >= 0, 'selection telemetry prints the run identifier');
  assert.ok(artifactsLine > selectionLine, 'artifact directory is printed after the run identifier');
  assert.ok(writeLine > artifactsLine, 'selection is printed before analysis and report writes');
});

test('AC2 & AC5: explicit run reads declared artifacts and writes both reports beside them', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-2100-explicit', slug: '00210-explicit' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runId, state.runId);
  assert.equal(report.statePath, `.sdw/state/${state.runId}.state.json`);
  assert.equal(report.artifactsDir, state.artifactsDir);
  assert.ok(report.inputs.includes(stepPath(state, '2')), 'declared step artifact is read');
  const stepTwo = report.artifacts.find((artifact) => artifact.path === stepPath(state, '2'));
  assert.ok(stepTwo && stepTwo.exists === true);
  assert.ok(stepTwo.bytes > 0, 'artifact bytes prove content was read');
  assert.ok(stepTwo.lines > 0, 'artifact lines prove content was read');
  assert.equal(report.signals.timestamps.steps.length, 8);
  assert.equal(report.signals.retries.dispatchAbandonments, 1);
  assert.equal(report.signals.abandonedDispatches[0].ref, '#steps.4.dispatch.abandonments[0]');
  assert.equal(report.signals.scoreIterations.score, 9);
  assert.equal(report.signals.reviewFindings.total, 1);
  assert.equal(report.signals.unresolvedThreads.pending[0].threadId, 'PRRT_1');

  const markdownPath = path.join(root, report.outputs.markdown);
  const jsonPath = path.join(root, report.outputs.json);
  assert.equal(report.outputs.markdown, `${state.artifactsDir}/${state.runId}.retro.md`);
  assert.equal(report.outputs.json, `${state.artifactsDir}/${state.runId}.retro.json`);
  assert.ok(fs.existsSync(markdownPath), 'markdown report exists');
  assert.ok(fs.existsSync(jsonPath), 'JSON report exists');
  assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), report);
  const markdown = fs.readFileSync(markdownPath, 'utf8');
  assert.match(markdown, new RegExp(`# Run Retrospective: ${state.runId}`));
  assert.match(markdown, /## Signals/);
  assert.match(markdown, /## Candidates/);
});

test('AC3: host transcripts and agent chat logs are excluded from inputs', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-2200-exclusion', slug: '00220-exclusion' });
  const transcript = `${state.artifactsDir}/transcripts/host-session.jsonl`;
  state.steps['7'].artifact = transcript;
  writeState(root, state);
  writeArtifact(root, stepPath(state, '2'), '# Step 2\n');
  writeArtifact(root, transcript, 'TRANSCRIPT-SECRET agent chat log\n');

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('TRANSCRIPT-SECRET'), false, 'excluded content never reaches stdout');
  const report = JSON.parse(result.stdout);
  assert.equal(report.inputs.includes(transcript), false, 'transcript is not read');
  assert.ok(report.excludedInputs.some((item) => item.path === transcript && item.reason === 'host-log'));
  assert.equal(JSON.stringify(report).includes('TRANSCRIPT-SECRET'), false);

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.equal(markdown.includes('TRANSCRIPT-SECRET'), false);
  assert.match(markdown, /## Excluded Inputs/);
  assert.ok(markdown.includes(transcript), 'excluded input is named in the report');
  assert.equal(retro.isHostLogPath(transcript), true);
  assert.equal(retro.isHostLogPath(stepPath(state, '7')), false);
});

test('AC6: a missing declared artifact is recorded as an absence without synthesized content', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-2300-missing', slug: '00230-missing' });
  state.steps['4'].tasks = {
    'task-1': {
      promptPath: `${state.artifactsDir}/task-task-1.prompt.md`,
      evidencePath: `${state.artifactsDir}/task-task-1.evidence.json`
    }
  };
  writeState(root, state);
  writeArtifact(root, stepPath(state, '2'), '# Step 2\n');
  writeArtifact(root, stepPath(state, '3'), '# Step 3\n');
  writeArtifact(root, stepPath(state, '7'), '# Step 7\n');
  // The declared step 5 artifact and the task prompt/evidence stay absent.

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const missingStep = report.signals.missingArtifacts.find((item) => item.expectedBy === 'steps.5.artifact');
  assert.deepEqual(missingStep, { path: stepPath(state, '5'), expectedBy: 'steps.5.artifact', present: false });
  const missingPrompt = report.signals.missingArtifacts.find((item) => item.expectedBy === 'steps.4.tasks.task-1.promptPath');
  assert.ok(missingPrompt, 'task prompt is an expected artifact');
  assert.equal(report.inputs.includes(stepPath(state, '5')), false);
  assert.equal('bytes' in missingStep, false, 'missing artifact carries no fabricated content metadata');

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.ok(markdown.includes(`\`${stepPath(state, '5')}\``));
  assert.match(markdown, /absent\. Content was not read or synthesized\./);
});

test('AC7: every candidate record carries id, title, severity, category, evidence, and proposedChange', () => {
  assert.deepEqual([...retro.CANDIDATE_FIELDS], ['id', 'title', 'severity', 'category', 'evidence', 'proposedChange']);
  assert.deepEqual([...retro.candidateContract().fields], [...retro.CANDIDATE_FIELDS]);

  const candidate = {
    id: 'RETRO-001',
    title: 'Record the retro command',
    severity: 'high',
    category: 'automated-check',
    evidence: { artifact: '.sdw/state/run-1.state.json', ref: '#steps.8.output' },
    proposedChange: { target: 'skills/sdw-orch/scripts/sdw_orch.cjs' }
  };
  assert.equal(retro.validateCandidate(candidate).valid, true);

  for (const field of retro.CANDIDATE_FIELDS) {
    const incomplete = { ...candidate };
    delete incomplete[field];
    const result = retro.validateCandidate(incomplete);
    assert.equal(result.valid, false, `missing ${field} is rejected`);
    assert.ok(result.errors.some((error) => error.code === 'missing-field' && error.field === field));
  }

  const report = retro.buildReport({
    state: { runId: 'run-1', specSlug: '00001-fixture', status: 'completed' },
    runIdFallback: 'run-1',
    statePath: '.sdw/state/run-1.state.json',
    artifactsDir: '.sdw/state/00001-fixture/run-1',
    inspection: { inputs: [], excludedInputs: [], artifacts: [], missingArtifacts: [] },
    signals: {},
    candidates: [candidate]
  });
  assert.deepEqual(report.candidates, [candidate]);
  assert.deepEqual(report.candidateContract.fields, [...retro.CANDIDATE_FIELDS]);
});

test('AC8: severity and category are restricted to the allowed values', () => {
  assert.deepEqual([...retro.SEVERITIES], ['critical', 'high', 'medium', 'low']);
  assert.deepEqual([...retro.CATEGORIES], [
    'memory',
    'harness-directive',
    'reviewer-standard',
    'automated-check',
    'navigation-pointer',
    'no-op-deletion'
  ]);

  const base = {
    id: 'RETRO-002',
    title: 'Tighten the check',
    severity: 'medium',
    category: 'reviewer-standard',
    evidence: { artifact: '.sdw/state/run-1.state.json', ref: '#steps.7.output' },
    proposedChange: { target: 'skills/sdw-orch/SKILL.md' }
  };
  for (const severity of retro.SEVERITIES) {
    assert.equal(retro.validateCandidate({ ...base, severity }).valid, true, `${severity} is accepted`);
  }
  for (const category of retro.CATEGORIES) {
    assert.equal(retro.validateCandidate({ ...base, category }).valid, true, `${category} is accepted`);
  }

  const badSeverity = retro.validateCandidate({ ...base, severity: 'urgent' });
  assert.equal(badSeverity.valid, false);
  assert.ok(badSeverity.errors.some((error) => error.code === 'invalid-severity'));
  const badCategory = retro.validateCandidate({ ...base, category: 'docs' });
  assert.equal(badCategory.valid, false);
  assert.ok(badCategory.errors.some((error) => error.code === 'invalid-category'));

  assert.throws(() => retro.buildReport({
    state: { runId: 'run-1' },
    statePath: '.sdw/state/run-1.state.json',
    artifactsDir: '.sdw/state/x/run-1',
    inspection: { inputs: [], excludedInputs: [], artifacts: [] },
    signals: {},
    candidates: [{ ...base, severity: 'urgent' }]
  }), /invalid candidate: invalid-severity/);
});

test('unknown --run-id and absent completed runs fail with exit 1 and a named cause', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-2400-status', slug: '00240-status', status: 'failed' });
  writeState(root, state);

  const unknown = runRetroCli(root, ['run', '--run-id', 'run-does-not-exist', '--json']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /run not found: run-does-not-exist/);
  assert.equal(unknown.stdout, '');

  const noneCompleted = runRetroCli(root, ['run']);
  assert.equal(noneCompleted.status, 1);
  assert.match(noneCompleted.stderr, /no completed run found under \.sdw\/state/);
});

test('AC1: the sdw-retro skill references sdw-rules and follows the Tier 1 layout', () => {
  const skillPath = path.join(REPO_ROOT, 'skills', 'sdw-retro', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'skills/sdw-retro/SKILL.md exists');
  const content = fs.readFileSync(skillPath, 'utf8');
  assert.match(content, /^---\nname: sdw-retro\n/);
  assert.match(content, /sdw-rules/i, 'SKILL.md references sdw-rules');
  assert.match(content, />\s*When this skill is loaded,\s*output "sdw-retro loaded\."/i);
  assert.ok(content.split(/\r?\n/).length <= 120, 'Tier 1 line budget');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'skills', 'sdw-retro', 'references')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'skills', 'sdw-retro', 'scripts')));
});

// ---------------------------------------------------------------------------
// Spec 00037 AC9-AC15: candidate validation, working-tree preservation, and
// the sdw-orch completion hook.
// ---------------------------------------------------------------------------

function writeCandidatesFile(root, payload, name = 'candidates.json') {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

function runValidator(root, args) {
  return spawnSync(process.execPath, [VALIDATOR, '--root', root, ...args], { cwd: root, encoding: 'utf8' });
}

function candidateFixture(overrides = {}) {
  return {
    id: 'RETRO-001',
    title: 'Tighten the completion check',
    severity: 'high',
    category: 'automated-check',
    evidence: {
      artifact: '.sdw/state/run-3000-candidates.state.json',
      ref: '#steps.8.output'
    },
    proposedChange: { target: '.sdw/specs/00100-retro-follow-up.md' },
    ...overrides
  };
}

function candidateProject(t) {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-3000-candidates', slug: '00300-candidates' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  return { root, state };
}

function snapshotTree(root) {
  const snapshot = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      snapshot[relative] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
  };
  walk(root);
  return snapshot;
}

test('AC9 & AC10: complete candidates ordered critical -> low are accepted', (t) => {
  const { root, state } = candidateProject(t);
  const payload = [
    candidateFixture({ id: 'RETRO-003', severity: 'critical' }),
    candidateFixture({ id: 'RETRO-001', severity: 'high' }),
    candidateFixture({
      id: 'RETRO-002',
      severity: 'low',
      category: 'navigation-pointer',
      evidence: { artifact: stepPath(state, '7'), ref: '#L1' }
    })
  ];
  const file = writeCandidatesFile(root, payload);

  const json = runValidator(root, ['--input', file, '--json']);
  assert.equal(json.status, 0, json.stderr || json.stdout);
  const result = JSON.parse(json.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.total, 3);
  assert.deepEqual(result.accepted.map((entry) => entry.id), ['RETRO-003', 'RETRO-001', 'RETRO-002']);
  assert.deepEqual(result.order.actual, ['critical', 'high', 'low']);
  assert.equal(result.order.ordered, true);
  assert.deepEqual(result.reasonCodes, []);
  assert.deepEqual(result.memoryDrafts, []);

  const human = runValidator(root, ['--input', file]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /ACCEPTED RETRO-003 \(critical, automated-check\)/);
  assert.match(human.stdout, /order: critical -> low/);

  const empty = runValidator(root, ['--input', writeCandidatesFile(root, [], 'empty.json'), '--json']);
  assert.equal(empty.status, 0, 'a report with no candidates is valid for a smooth run');
  assert.equal(JSON.parse(empty.stdout).valid, true);
});

test('AC9 & AC11: missing fields, unresolvable artifacts, and skills/ edits carry stable reason codes', (t) => {
  const { root, state } = candidateProject(t);
  const stateArtifact = `.sdw/state/${state.runId}.state.json`;

  const noRef = candidateFixture({ id: 'RETRO-REF' });
  delete noRef.evidence.ref;
  const noArtifact = candidateFixture({ id: 'RETRO-ART' });
  delete noArtifact.evidence.artifact;
  const noTarget = candidateFixture({ id: 'RETRO-TARGET', proposedChange: {} });
  const unresolvable = candidateFixture({
    id: 'RETRO-MISSING',
    evidence: { artifact: '.sdw/state/does-not-exist.state.json', ref: '#steps.1' }
  });
  const skillsEdit = candidateFixture({
    id: 'RETRO-SKILLS',
    proposedChange: { target: 'skills/sdw-orch/scripts/sdw_orch.cjs' }
  });
  const badRef = candidateFixture({
    id: 'RETRO-BADREF',
    evidence: { artifact: stateArtifact, ref: 'steps.8.output' }
  });

  const file = writeCandidatesFile(root, [noRef, noArtifact, noTarget, unresolvable, skillsEdit, badRef]);
  const json = runValidator(root, ['--input', file, '--json']);
  assert.equal(json.status, 1);
  const result = JSON.parse(json.stdout);
  assert.equal(result.valid, false);
  assert.equal(result.accepted.length, 0);
  const rejectedById = new Map(result.rejected.map((entry) => [entry.id, entry]));
  assert.ok(rejectedById.get('RETRO-REF').reasonCodes.includes('missing-evidence-ref'));
  assert.ok(rejectedById.get('RETRO-ART').reasonCodes.includes('missing-evidence-artifact'));
  assert.ok(rejectedById.get('RETRO-TARGET').reasonCodes.includes('missing-proposed-change-target'));
  assert.ok(rejectedById.get('RETRO-MISSING').reasonCodes.includes('unresolvable-artifact'));
  assert.ok(rejectedById.get('RETRO-SKILLS').reasonCodes.includes('skills-requires-spec'));
  assert.ok(rejectedById.get('RETRO-BADREF').reasonCodes.includes('invalid-evidence-ref'));
  assert.ok(
    rejectedById.get('RETRO-SKILLS').errors.some((error) => /\.sdw\/specs\//.test(error.specificationRoute || '')),
    'skills/ rejection names the specification route'
  );
  assert.match(result.specificationRoute, /\.sdw\/specs\//);

  const human = runValidator(root, ['--input', file]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /REJECTED RETRO-REF: missing-evidence-ref/);
  assert.match(human.stdout, /REJECTED RETRO-SKILLS: .*skills-requires-spec/);
  assert.match(human.stdout, /specification route: .*\.sdw\/specs\//);
});

test('AC10: candidates must be ordered from critical to low', (t) => {
  const { root } = candidateProject(t);
  const file = writeCandidatesFile(root, [
    candidateFixture({ id: 'RETRO-LOW', severity: 'low' }),
    candidateFixture({ id: 'RETRO-CRITICAL', severity: 'critical' })
  ]);

  const result = runValidator(root, ['--input', file, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.order.ordered, false);
  const outOfOrder = parsed.rejected.find((entry) => entry.id === 'RETRO-CRITICAL');
  assert.ok(outOfOrder.reasonCodes.includes('candidate-order'));
  assert.equal(parsed.accepted.length, 1, 'only the first ordered candidate is accepted');
});

test('AC12: memory candidates emit an sdw-memory record draft instead of a repository edit', (t) => {
  const { root, state } = candidateProject(t);
  const record = {
    kind: 'trap',
    slug: 'retry-without-abandon',
    title: 'Retry without abandoning the active dispatch',
    avoid: 'Dispatching a second task while one is in flight.',
    action: 'Abandon the active task with a reason before dispatching again.'
  };
  const memory = candidateFixture({
    id: 'RETRO-MEM',
    severity: 'medium',
    category: 'memory',
    evidence: { artifact: stepPath(state, '7'), ref: '#L1' },
    proposedChange: { target: 'sdw-memory', memoryRecord: record }
  });

  const accepted = runValidator(root, ['--input', writeCandidatesFile(root, [memory]), '--json']);
  assert.equal(accepted.status, 0, accepted.stderr);
  const acceptedResult = JSON.parse(accepted.stdout);
  assert.equal(acceptedResult.accepted[0].memoryDraft.kind, 'trap');
  assert.deepEqual(acceptedResult.memoryDrafts, [{ candidateId: 'RETRO-MEM', ...record }]);
  const human = runValidator(root, ['--input', writeCandidatesFile(root, [memory])]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /MEMORY DRAFT RETRO-MEM: sdw-memory record --kind trap/);

  const noDraft = candidateFixture({
    id: 'RETRO-NODRAFT',
    category: 'memory',
    proposedChange: { target: 'sdw-memory' }
  });
  const missing = runValidator(root, ['--input', writeCandidatesFile(root, [noDraft], 'no-draft.json'), '--json']);
  assert.equal(missing.status, 1);
  assert.ok(JSON.parse(missing.stdout).rejected[0].reasonCodes.includes('missing-memory-draft'));

  const repoEdit = candidateFixture({
    id: 'RETRO-MEMREPO',
    category: 'memory',
    proposedChange: { target: '.sdw/specs/00100-retro-follow-up.md', memoryRecord: record }
  });
  const rejected = runValidator(root, ['--input', writeCandidatesFile(root, [repoEdit], 'memory-repo.json'), '--json']);
  assert.equal(rejected.status, 1);
  const rejectedResult = JSON.parse(rejected.stdout);
  assert.ok(rejectedResult.rejected[0].reasonCodes.includes('memory-target-not-route'));
  assert.deepEqual(rejectedResult.memoryDrafts, [], 'rejected memory candidates emit no draft');
});

test('AC13: a retro run leaves every pre-existing file unchanged', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-3100-preserve', slug: '00310-preserve' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);

  const before = snapshotTree(root);
  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  const after = snapshotTree(root);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 2, 'only the two report files are added');
  for (const reportPath of [report.outputs.markdown, report.outputs.json]) {
    assert.ok(after[reportPath], `${reportPath} is written`);
    delete after[reportPath];
  }
  assert.deepEqual(after, before, 'no pre-existing file changed');
});

test('AC5: a paused sibling run appears as leftover_run in both reports', (t) => {
  const root = makeProject(t);
  const selected = makeState({ runId: 'run-4000-completed', slug: '00400-leftover' });
  const paused = makeState({
    runId: 'run-4100-paused',
    slug: '00400-leftover',
    status: 'paused',
    updatedAt: '2020-01-01T00:00:00.000Z'
  });
  writeState(root, selected);
  writeState(root, paused);
  writeDefaultArtifacts(root, selected);

  const result = runRetroCli(root, ['run', '--run-id', selected.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.signals.leftover_run.length, 1);
  const leftover = report.signals.leftover_run[0];
  assert.equal(leftover.runId, paused.runId, 'the signal names the sibling run id');
  assert.equal(leftover.status, 'paused', 'the signal names its status');
  assert.ok(Number.isFinite(leftover.ageMs) && leftover.ageMs > 0, 'the signal reports its age');

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.match(markdown, /### Leftover Runs/);
  assert.ok(markdown.includes(paused.runId), 'the markdown report names the leftover run');
  assert.match(markdown, /status paused/);
});

test('AC5: no leftover_run when every sibling run is terminal', (t) => {
  const root = makeProject(t);
  const selected = makeState({ runId: 'run-4200-completed', slug: '00420-terminal' });
  const failed = makeState({ runId: 'run-4210-failed', slug: '00420-terminal', status: 'failed' });
  const older = makeState({ runId: 'run-4190-completed', slug: '00420-terminal' });
  for (const state of [selected, failed, older]) writeState(root, state);
  writeDefaultArtifacts(root, selected);

  const result = runRetroCli(root, ['run', '--run-id', selected.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.leftover_run, []);

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.match(markdown, /No sibling run is open for this specification\./);
});

function writeRetroConfig(root, retro) {
  fs.writeFileSync(
    path.join(root, '.sdw', 'config.json'),
    `${JSON.stringify({ specsDir: '.sdw/specs', retro }, null, 2)}\n`,
    'utf8'
  );
}

test('AC6: a configured transcript is read, listed with its line count, and scanned', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5000-transcript', slug: '00500-transcript' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00500.txt';
  writeArtifact(root, transcriptPath, [
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00500-transcript.md',
    'assistant: dispatched task-1',
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs resume --run-id run-5000-transcript'
  ].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.inputs.includes(transcriptPath), 'transcript is listed under report inputs');
  assert.deepEqual(report.transcripts, [{ path: transcriptPath, lines: 3, mode: 'host' }]);
  assert.equal(report.transcriptMode, 'host', 'the mode defaults to host');
  assert.deepEqual(report.signals.repeated_run_invocation, [], 'run followed by resume is not a repeat');

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.ok(markdown.includes(`- \`${transcriptPath}\` (transcript, 3 lines, host)`));

  // The repeatable CLI flag feeds the same input list.
  const cliTranscript = 'notes/cli-session.txt';
  writeArtifact(root, cliTranscript, 'one\ntwo');
  const cli = runRetroCli(root, ['run', '--run-id', state.runId, '--transcript', cliTranscript, '--json']);
  assert.equal(cli.status, 0, cli.stderr);
  const cliReport = JSON.parse(cli.stdout);
  assert.deepEqual(cliReport.transcripts, [
    { path: transcriptPath, lines: 3, mode: 'host' },
    { path: cliTranscript, lines: 2, mode: 'host' }
  ]);
  assert.ok(cliReport.inputs.includes(cliTranscript));
});

test('AC7: repeated run invocations with no resume cite file and line numbers only', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5100-repeated', slug: '00510-repeated' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00510.txt';
  writeArtifact(root, transcriptPath, [
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00510-repeated.md # BODY-MARKER-A',
    'assistant: task-1 accepted',
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00510-repeated.md # BODY-MARKER-B'
  ].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.repeated_run_invocation, [
    { path: transcriptPath, specification: '00510-repeated', lines: [1, 3] }
  ]);
  assert.equal(JSON.stringify(report).includes('BODY-MARKER'), false, 'transcript bodies never enter the JSON report');
  assert.equal(
    JSON.stringify(report.signals.repeated_run_invocation).includes('sdw-orch'),
    false,
    'the signal cites no command text'
  );

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.equal(markdown.includes('BODY-MARKER'), false, 'transcript bodies never enter the Markdown report');
  assert.ok(markdown.includes(`\`${transcriptPath}\` lines 1 and 3`));
  assert.match(markdown, /two `sdw-orch run` invocations for `00510-repeated` with no `resume` between them/);
});

test('AC7: a resume between run invocations prevents the signal', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5200-resumed', slug: '00520-resumed' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00520.txt';
  writeArtifact(root, transcriptPath, [
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00520-resumed.md',
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs resume --run-id run-5200-resumed',
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00520-resumed.md'
  ].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.repeated_run_invocation, []);

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.match(markdown, /No repeated run invocation or unreadable transcript was found\./);
});

test('AC8: a missing configured transcript produces transcript_unreadable and exit 0', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5300-unreadable', slug: '00530-unreadable' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const missing = 'transcripts/missing-00530.jsonl';
  writeRetroConfig(root, { enabled: false, transcripts: [missing] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.transcript_unreadable, [{ path: missing, reason: 'not-found' }]);
  assert.deepEqual(report.transcripts, []);
  assert.equal(report.inputs.includes(missing), false, 'an unreadable transcript is not a read input');
  assert.ok(fs.existsSync(path.join(root, report.outputs.markdown)), 'report still renders');
  assert.ok(fs.existsSync(path.join(root, report.outputs.json)));

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.ok(markdown.includes(`\`${missing}\`: transcript unreadable (not-found)`));
});

test('00047 AC2: a zstd transcript is decoded frame by frame, not only its first frame', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5400-zstd', slug: '00540-zstd' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00540.jsonl.zstd';
  const runLine = 'node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00540-zstd.md';
  const frameOne = zlib.zstdCompressSync(Buffer.from([
    `operator: ${runLine}`,
    'assistant: task-2 dispatched',
    ''
  ].join('\n'), 'utf8'));
  const frameTwo = zlib.zstdCompressSync(Buffer.from([
    `operator: ${runLine}`,
    'assistant: task-2 accepted',
    ''
  ].join('\n'), 'utf8'));
  const fileBytes = Buffer.concat([frameOne, frameTwo]);
  writeBinaryArtifact(root, transcriptPath, fileBytes);
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.transcripts, [{ path: transcriptPath, lines: 5, mode: 'host' }]);
  assert.deepEqual(report.signals.repeated_run_invocation, [
    { path: transcriptPath, specification: '00540-zstd', lines: [1, 3] }
  ], 'both frames are scanned, so both run invocations are found');

  const firstFrameOnly = zlib.zstdDecompressSync(fileBytes).toString('utf8').split(/\r?\n/).length;
  assert.ok(
    report.transcripts[0].lines > firstFrameOnly,
    'the reported line count covers every concatenated frame, not just the first'
  );

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.ok(markdown.includes(`- \`${transcriptPath}\` (transcript, 5 lines, host)`));
});

test('00047 AC4: --transcript-mode is recorded next to each transcript input and defaults to host', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5500-mode', slug: '00550-mode' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00550.txt';
  writeArtifact(root, transcriptPath, 'user: run the retro\nassistant: retro dispatched');
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const defaulted = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(defaulted.status, 0, defaulted.stderr);
  const defaultReport = JSON.parse(defaulted.stdout);
  assert.equal(defaultReport.transcriptMode, 'host', 'the mode defaults to host when omitted');
  assert.deepEqual(defaultReport.transcripts, [{ path: transcriptPath, lines: 2, mode: 'host' }]);
  const defaultMarkdown = fs.readFileSync(path.join(root, defaultReport.outputs.markdown), 'utf8');
  assert.ok(defaultMarkdown.includes(`- \`${transcriptPath}\` (transcript, 2 lines, host)`));

  const captured = runRetroCli(root, [
    'run', '--run-id', state.runId, '--transcript-mode', 'captured', '--json'
  ]);
  assert.equal(captured.status, 0, captured.stderr);
  const capturedReport = JSON.parse(captured.stdout);
  assert.equal(capturedReport.transcriptMode, 'captured');
  assert.deepEqual(capturedReport.transcripts, [{ path: transcriptPath, lines: 2, mode: 'captured' }]);
  const capturedMarkdown = fs.readFileSync(path.join(root, capturedReport.outputs.markdown), 'utf8');
  assert.ok(capturedMarkdown.includes(`- \`${transcriptPath}\` (transcript, 2 lines, captured)`));
  assert.equal(capturedMarkdown.includes('(transcript, 2 lines, host)'), false);

  const invalid = runRetroCli(root, ['run', '--run-id', state.runId, '--transcript-mode', 'log']);
  assert.equal(invalid.status, 1, 'an unsupported mode is rejected');
  assert.match(invalid.stderr, /invalid --transcript-mode: log; expected host\|captured/);
});

test('00047 AC5: non-text transcripts report transcript_unreadable and exit 0', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5600-binary', slug: '00560-binary' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00560.bin';
  writeBinaryArtifact(root, transcriptPath, Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28]));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.transcript_unreadable, [{ path: transcriptPath, reason: 'not-text' }]);
  assert.deepEqual(report.transcripts, [], 'a non-text file is not a read transcript input');
  assert.equal(report.inputs.includes(transcriptPath), false);
  assert.ok(fs.existsSync(path.join(root, report.outputs.markdown)), 'the report still renders');

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.ok(markdown.includes(`\`${transcriptPath}\`: transcript unreadable (not-text)`));

  // A decodable zstd frame whose payload is not UTF-8 text is not a transcript
  // either: the frame decodes, the text decoding fails, and the reason is `not-text`.
  const binaryZstd = 'transcripts/session-00560-text.zstd';
  writeBinaryArtifact(root, binaryZstd, zlib.zstdCompressSync(Buffer.from([0xff, 0xfe, 0x80])));
  const zstdResult = runRetroCli(root, [
    'run', '--run-id', state.runId, '--transcript', binaryZstd, '--json'
  ]);
  assert.equal(zstdResult.status, 0, zstdResult.stderr);
  const zstdReport = JSON.parse(zstdResult.stdout);
  assert.deepEqual(zstdReport.signals.transcript_unreadable, [
    { path: transcriptPath, reason: 'not-text' },
    { path: binaryZstd, reason: 'not-text' }
  ]);
  assert.deepEqual(zstdReport.transcripts, [], 'a non-text payload is not a read transcript input');
  const zstdMarkdown = fs.readFileSync(path.join(root, zstdReport.outputs.markdown), 'utf8');
  assert.ok(zstdMarkdown.includes(`\`${binaryZstd}\`: transcript unreadable (not-text)`));
});

test('00048 AC1 & AC2: a quoted command inside a JSON message and prose naming both tokens are not invocations', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5700-precision', slug: '00570-precision' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00570.txt';
  const quoted = 'task-2 complete: the scan (`sdw-orch`/`sdw_orch.cjs` + `run`/`resume` command word) ran on two `run --spec .sdw/specs/00570-precision.md` lines; never run git commit.';
  writeArtifact(root, transcriptPath, [
    `{"type":"agent/inbox/spliced","data":{"inserted":[{"type":"text","text":${JSON.stringify(quoted)}}]}}`,
    'assistant: before you run the suite, read skills/sdw-orch/scripts/sdw_orch.cjs and the --spec .sdw/specs/00570-precision.md` note.',
    `{"type":"user/message","data":{"content":[{"type":"text","text":${JSON.stringify(quoted)}}]}}`
  ].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.repeated_run_invocation, [], 'quoted commands and prose mentions are not invocations');

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.match(markdown, /No repeated run invocation or unreadable transcript was found\./);
});

test('00048 AC1 & AC2: escaped-quote tool calls are detected, and a separated duplicate reports both lines', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5710-escaping', slug: '00571-escaping' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00571.jsonl';
  const commandLine = '{"command":"node \\"L:/x/skills/sdw-orch/scripts/sdw_orch.cjs\\" run --spec .sdw/specs/00571-escaping.md --root ."}';
  writeArtifact(root, transcriptPath, [
    commandLine,
    '{"type":"tool/result","data":"exit 0"}',
    'operator: sdw-orch run --spec .sdw/specs/00571-escaping.md'
  ].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.repeated_run_invocation, [
    { path: transcriptPath, specification: '00571-escaping', lines: [1, 3] }
  ], 'the escaped JSON quotes do not break the executable-followed-by-command-word shape');

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.ok(markdown.includes(`\`${transcriptPath}\` lines 1 and 3`));
});

test('00048 AC3: quotes, backticks, and trailing punctuation are stripped from the --spec value', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5720-spec', slug: '00572-spec' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00572.txt';
  writeArtifact(root, transcriptPath, [
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00572-spec.md`,',
    'assistant: task-1 accepted',
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec "00572-spec.md"'
  ].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.repeated_run_invocation, [
    { path: transcriptPath, specification: '00572-spec', lines: [1, 3] }
  ], 'both captured values normalize to the same specification stem');
  assert.equal(JSON.stringify(report).includes('00572-spec.md`'), false, 'the raw backticked value never reaches the report');
  assert.equal(JSON.stringify(report).includes('00572-spec.md"'), false);
});

test('00048 AC4: a call echoed by its result in another envelope is one invocation', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5730-echo', slug: '00573-echo' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00573.jsonl';
  const callId = 'call_fixture_00573';
  const command = 'node "L:/x/skills/sdw-orch/scripts/sdw_orch.cjs" run --spec .sdw/specs/00573-echo.md';
  const issued = JSON.stringify({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, arguments: { command } }] }
    }
  });
  const echoed = JSON.stringify({
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: 'pwsh', arguments: { command } }
  });
  assert.notEqual(issued, echoed, 'the two lines differ in their host envelope');
  writeArtifact(root, transcriptPath, [issued, echoed].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.signals.repeated_run_invocation,
    [],
    'the call and the record that echoes it carry the same command excerpt'
  );

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.match(markdown, /No repeated run invocation or unreadable transcript was found\./);
});

test('00048 AC4: a command recorded three times in a row is still one invocation', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5760-chain', slug: '00576-chain' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00576.txt';
  const commandLine = 'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00576-chain.md';
  writeArtifact(root, transcriptPath, [commandLine, commandLine, commandLine].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.signals.repeated_run_invocation,
    [],
    'the chain collapses as one echoed record instead of reporting lines 1 and 3'
  );
});

test('00048 AC4: identical commands separated by another event still report both lines', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5740-separated', slug: '00574-separated' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00574.txt';
  const commandLine = 'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00574-separated.md';
  writeArtifact(root, transcriptPath, [commandLine, 'assistant: task-1 accepted', commandLine].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.repeated_run_invocation, [
    { path: transcriptPath, specification: '00574-separated', lines: [1, 3] }
  ], 'one intervening event keeps the two invocations apart');

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.ok(markdown.includes(`\`${transcriptPath}\` lines 1 and 3`));
});

test('00048 AC4: adjacent matching lines with different text still report both lines', (t) => {
  const root = makeProject(t);
  const state = makeState({ runId: 'run-5750-adjacent', slug: '00575-adjacent' });
  writeState(root, state);
  writeDefaultArtifacts(root, state);
  const transcriptPath = 'transcripts/session-00575.txt';
  writeArtifact(root, transcriptPath, [
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec .sdw/specs/00575-adjacent.md',
    'operator: node skills/sdw-orch/scripts/sdw_orch.cjs run --spec specs/00575-adjacent.md --new-run'
  ].join('\n'));
  writeRetroConfig(root, { enabled: false, transcripts: [transcriptPath] });

  const result = runRetroCli(root, ['run', '--run-id', state.runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.signals.repeated_run_invocation, [
    { path: transcriptPath, specification: '00575-adjacent', lines: [1, 2] }
  ], 'adjacent lines that name the specification differently are two invocations');

  const markdown = fs.readFileSync(path.join(root, report.outputs.markdown), 'utf8');
  assert.ok(markdown.includes(`\`${transcriptPath}\` lines 1 and 2`));
});

function makeOrchProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-retro-orch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "SDW Retro Tester"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "retro@sdw.org"', { cwd: dir, stdio: 'ignore' });
  sdwConfig.cmdInit({ root: dir, force: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'retro-orch-fixture', version: '1.0.0' }, null, 2), 'utf8');
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function writeOrchSpec(root, slug) {
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
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
Retro completion-hook fixture.

### Design Intent
Verify the advisory retro command.

## Acceptance Criteria
- AC1: The system shall satisfy acceptance condition 1 for ${slug}.

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
  fs.writeFileSync(path.join(specsDir, `${slug}.md`), content, 'utf8');
}

test('AC14 & AC15: a successful sdw-orch run records the exact retro command without running it', (t) => {
  const root = makeOrchProject(t);
  const slug = 'retro-hook-fixture';
  writeOrchSpec(root, slug);

  const command = `node -e "const fs = require('fs'); const ev = { taskId: process.env.SDW_TASK_ID, acIds: ['AC1'], filesChanged: ['package.json'], summary: 'retro command fixture' }; fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify(ev)); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); p.retroHook = true; fs.writeFileSync('package.json', JSON.stringify(p, null, 2));"`;

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  let exitCode;
  try {
    exitCode = sdwOrch.cmdRun({
      root,
      specPath: `.sdw/specs/${slug}.md`,
      skipReview: true,
      skipPr: true,
      minScore: 0,
      implementation: { mode: 'command', command }
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(exitCode, 0, logs.join('\n'));

  const state = stateManager.findLatestRunState(root);
  assert.equal(state.status, 'completed');
  assert.equal(typeof state.retroCommand, 'string');
  assert.ok(state.retroCommand.includes(`run --run-id ${state.runId}`), 'state names the run');
  assert.ok(state.retroCommand.includes(`--root "${root.replace(/\\/g, '/')}"`), 'state names the project root');
  assert.match(state.retroCommand, /retro\.cjs" run --run-id /);

  const summary = logs.join('\n');
  assert.ok(summary.includes(state.retroCommand), 'completion summary names the exact command');

  const markdownPath = path.join(root, state.artifactsDir, `${state.runId}.retro.md`);
  const jsonPath = path.join(root, state.artifactsDir, `${state.runId}.retro.json`);
  assert.equal(fs.existsSync(markdownPath), false, 'delivery never starts a retro (AC14)');
  assert.equal(fs.existsSync(jsonPath), false, 'delivery never starts a retro (AC14)');
});
