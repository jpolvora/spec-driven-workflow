'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const dagPlanner = require('../skills/sdw-orch/scripts/dag_planner.cjs');
const scoreEvaluator = require('../skills/sdw-orch/scripts/score_evaluator.cjs');
const deliveryReport = require('../skills/sdw-orch/scripts/delivery_report.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const { JUDGE_STUB, installJudgeEnv, clearJudgeEnv } = require('./fixtures/judge_env.cjs');

const ORCH_CLI = path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

const SPEC_BODY = `---
slug: score-spec
---
# Score Spec
## Acceptance Criteria
- AC1: The system shall record a run state file.
- AC2: The system shall resume from that file.
`;

function judgeConfig(mode = 'all') {
  return {
    scoring: {
      judgeCommand: `node "${JUDGE_STUB}" {promptFile} {verdictFile} ${mode}`
    }
  };
}

// Builds a git-backed temp repo: the judge context needs a real diff, and the
// corroboration rules need a tracked tree.
function setupRepo(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-score-test-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, 'score-spec.md'), options.specBody !== undefined ? options.specBody : SPEC_BODY);

  execSync('git init -q', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'app.cjs'), '// baseline\n');
  execSync('git add .sdw app.cjs', { cwd: root, stdio: 'ignore' });
  execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });
  return root;
}

// Command-mode implementer: appends to a tracked file (so the diff is real and
// the file is newer than the dispatch) and writes the evidence file.
function implementationOptions(slug = 'score-spec') {
  const script = [
    "const fs = require('fs');",
    "fs.appendFileSync('app.cjs', '// implemented\\n');",
    'fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({',
    "  taskId: process.env.SDW_TASK_ID,",
    "  status: 'success',",
    "  acIds: ['AC1', 'AC2'],",
    "  filesChanged: ['app.cjs'],",
    "  tests: [],",
    "  summary: 'implemented app.cjs'",
    '}));'
  ].join(' ');
  return {
    implementation: {
      mode: 'command',
      command: `node -e "${script.replace(/"/g, '\\"')}"`
    }
  };
}

function withJudgeEnv(previous) {
  if (previous) process.env.SDW_JUDGE_COMMAND = previous;
  else clearJudgeEnv();
}

test('AC1 & AC7: score derives from per-criterion verdicts and the evidence-count formula is gone', () => {
  assert.equal(typeof scoreEvaluator.evaluateScore, 'undefined', 'The static evidence-count evaluator is removed (AC1)');

  const acs = dagPlanner.parseAcceptanceCriteria(SPEC_BODY);
  assert.equal(acs.length, 2);

  const verdict = {
    score: 10,
    verdicts: [
      { id: 'AC1', verdict: 'verified', evidence: 'app.cjs:1' },
      { id: 'AC2', verdict: 'verified', evidence: 'app.cjs:2' }
    ],
    notes: 'both criteria implemented'
  };
  const validated = scoreEvaluator.validateVerdict(verdict, { acs });
  assert.equal(validated.valid, true);

  const report = scoreEvaluator.applyVerdict(validated.data, { acs, minScore: 8 });
  assert.equal(report.score, 10);
  assert.equal(report.verifiedCount, 2);
  assert.equal(report.passed, true);
  assert.equal(report.judge.reportedScore, 10);
  assert.equal(report.judge.scoreMismatch, false);

  // A judge that reports a divergent score is recorded, never trusted.
  const divergent = { ...verdict, score: 3 };
  const divergentReport = scoreEvaluator.applyVerdict(
    scoreEvaluator.validateVerdict(divergent, { acs }).data,
    { acs, minScore: 8 }
  );
  assert.equal(divergentReport.score, 10, 'Derived score wins over the reported one');
  assert.equal(divergentReport.judge.scoreMismatch, true);
});

test('AC2, AC3 & AC5: Step 5 pauses awaiting judgment with a criteria-plus-diff prompt', () => {
  const previous = process.env.SDW_JUDGE_COMMAND;
  const tmpDir = setupRepo();
  try {
    clearJudgeEnv();
    const exitCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions()
    });

    assert.equal(exitCode, 5, 'Pauses with exit code 5 while awaiting the judge (AC5)');

    const state = stateManager.findLatestRunState(tmpDir);
    assert.equal(state.status, 'paused');
    assert.equal(state.steps[5].status, 'awaiting_judgment');
    assert.equal(state.steps[4].status, 'completed', 'Implementation completed before scoring paused');

    const promptPath = path.resolve(tmpDir, state.steps[5].output.judgePromptPath);
    assert.ok(fs.existsSync(promptPath), 'Judge prompt file is written (AC2)');

    const prompt = fs.readFileSync(promptPath, 'utf8');
    assert.ok(prompt.includes('- AC1: The system shall record a run state file.'), 'Criteria text is inlined');
    assert.ok(prompt.includes('- AC2: The system shall resume from that file.'), 'All criteria are inlined');
    assert.ok(prompt.includes('// implemented'), 'The generated diff is inlined (AC3)');
    assert.ok(!prompt.includes('implemented app.cjs'), 'Evidence summaries are excluded from the judge context (AC3)');
    assert.ok(!/transcript/i.test(prompt), 'No transcript content is included (AC3)');

    const manifestPrompt = state.steps[5].output.judgeVerdictPath;
    assert.ok(manifestPrompt.endsWith('step-5-judge.verdict.json'), 'The verdict destination is advertised');
  } finally {
    withJudgeEnv(previous);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC4 & AC6: a configured judge command runs with the requested criticity and its verdict is applied', () => {
  const tmpDir = setupRepo();
  try {
    const exitCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions(),
      scoring: { ...judgeConfig('all').scoring, judgeCriticity: 'perfectionist' }
    });

    assert.equal(exitCode, 0, 'A passing verdict lets the run continue (AC4)');

    const state = stateManager.findLatestRunState(tmpDir);
    assert.equal(state.steps[5].status, 'completed');
    assert.equal(state.score, 10);
    assert.equal(state.steps[5].output.judge.criticity, 'perfectionist', 'Criticity is configurable (AC6)');
    assert.equal(state.steps[5].output.judgeResolution, 'command');

    const prompt = fs.readFileSync(path.resolve(tmpDir, state.steps[5].output.judgePromptPath), 'utf8');
    assert.ok(prompt.includes('## Criticity: perfectionist'), 'The prompt carries the requested criticity');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC8: a specification without criteria scores 0 and never invokes the judge', () => {
  const tmpDir = setupRepo({ specBody: '# No criteria here\nOnly prose.\n' });
  try {
    // Enter at Step 5 so Step 1 derivation cannot manufacture criteria: the
    // guard under test is the scoring step's own fail-closed branch.
    const runState = stateManager.createRunState({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      slug: 'score-spec'
    });
    for (const step of [1, 2, 3, 4]) {
      stateManager.updateStepState(tmpDir, runState.runId, step, 'completed', {});
    }

    const marker = path.join(tmpDir, 'judge-was-invoked.txt');
    const command = `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'x')"`;

    const exitCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      runId: runState.runId,
      step: 5,
      skipReview: true,
      skipPr: true,
      scoring: { judgeCommand: command }
    });

    assert.equal(exitCode, 2, 'Fails closed when there is nothing to judge');
    assert.equal(fs.existsSync(marker), false, 'The judge command is never invoked (AC8)');

    const state = stateManager.loadRunState(tmpDir, runState.runId);
    assert.equal(state.score, 0);
    assert.equal(state.steps[5].status, 'reimplementation_needed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC9: a below-threshold verdict triggers the re-implementation loop', () => {
  const tmpDir = setupRepo();
  try {
    const exitCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions(),
      scoring: judgeConfig('none').scoring
    });

    assert.equal(exitCode, 2, 'Exit code 2 keeps the re-implementation loop');
    const state = stateManager.findLatestRunState(tmpDir);
    assert.equal(state.status, 'failed');
    assert.equal(state.steps[5].status, 'reimplementation_needed');
    assert.equal(state.score, 0);
    assert.ok(state.steps[5].output.feedback.includes('judged unmet'), 'Feedback names the unmet criteria');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC10: an unavailable or malformed judge fails closed with 0/10 and an actionable error', () => {
  const tmpDir = setupRepo();
  try {
    const exitCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions(),
      scoring: { judgeCommand: 'node -e "process.exit(3)"' }
    });

    assert.equal(exitCode, 2, 'An unavailable judge fails closed');
    const failedState = stateManager.findLatestRunState(tmpDir);
    assert.equal(failedState.score, 0);
    assert.ok(failedState.steps[5].output.feedback.includes('Judge command failed'), 'The error is actionable');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const malformedDir = setupRepo();
  try {
    const exitCode = sdwOrch.cmdRun({
      root: malformedDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions(),
      scoring: judgeConfig('invalid').scoring
    });

    assert.equal(exitCode, 2, 'A malformed verdict fails closed');
    const malformedState = stateManager.findLatestRunState(malformedDir);
    assert.equal(malformedState.score, 0);
    assert.ok(malformedState.steps[5].output.feedback.includes('malformed'), 'The failure names the verdict problem');
  } finally {
    fs.rmSync(malformedDir, { recursive: true, force: true });
  }
});

test('Score submit validates the verdict, records it, and unblocks resume', () => {
  const previous = process.env.SDW_JUDGE_COMMAND;
  const tmpDir = setupRepo();
  try {
    clearJudgeEnv();
    const runCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions()
    });
    assert.equal(runCode, 5, 'Run pauses awaiting a submitted verdict');

    const state = stateManager.findLatestRunState(tmpDir);
    const verdictFile = path.join(tmpDir, 'verdict.json');

    // The run's effective criteria come from the judge prompt the CLI wrote.
    const promptText = fs.readFileSync(path.resolve(tmpDir, state.steps[5].output.judgePromptPath), 'utf8');
    const acIds = [...new Set([...promptText.matchAll(/^- (AC[1-9][0-9]*):/gm)].map(match => match[1]))];
    assert.ok(acIds.length > 0, 'The judge prompt declares the criteria to cover');

    // Unknown criterion id is rejected.
    fs.writeFileSync(verdictFile, JSON.stringify({
      score: 5,
      verdicts: [{ id: 'AC99', verdict: 'verified', evidence: 'app.cjs:1' }]
    }));
    const badSubmit = sdwOrch.cmdScoreSubmit({ root: tmpDir, runId: state.runId, verdictPath: verdictFile });
    assert.equal(badSubmit, 1, 'Unknown AC ids are rejected');

    // Non-integer score is rejected.
    fs.writeFileSync(verdictFile, JSON.stringify({
      score: 9.5,
      verdicts: acIds.map(id => ({ id, verdict: 'verified', evidence: 'app.cjs:1' }))
    }));
    const badScore = sdwOrch.cmdScoreSubmit({ root: tmpDir, runId: state.runId, verdictPath: verdictFile });
    assert.equal(badScore, 1, 'A non-integer score is rejected');

    // A complete verdict is accepted and unblocks the workflow.
    fs.writeFileSync(verdictFile, JSON.stringify({
      score: 10,
      verdicts: acIds.map(id => ({ id, verdict: 'verified', evidence: 'app.cjs:1' }))
    }));
    const goodSubmit = sdwOrch.cmdScoreSubmit({ root: tmpDir, runId: state.runId, verdictPath: verdictFile });
    assert.equal(goodSubmit, 0, 'A valid verdict is accepted');

    const submitted = stateManager.loadRunState(tmpDir, state.runId);
    assert.equal(submitted.steps[5].status, 'judged');
    assert.equal(submitted.score, 10);
    assert.equal(submitted.steps[5].output.judgeResolution, 'submitted');

    const resumeCode = sdwOrch.cmdResume({
      root: tmpDir,
      runId: state.runId,
      skipReview: true,
      skipPr: true,
      scoring: { judgeCommand: null }
    });
    assert.equal(resumeCode, 0, 'Resume applies the submitted verdict and continues');

    const resumed = stateManager.loadRunState(tmpDir, state.runId);
    assert.equal(resumed.steps[5].status, 'completed', 'Step 5 completes from the submitted verdict');
  } finally {
    withJudgeEnv(previous);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Judge config validation rejects unknown criticity and non-string model fields', () => {
  const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');

  const badCriticity = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    scoring: { judgeCriticity: 'pedantic' }
  });
  assert.equal(badCriticity.valid, false);
  assert.ok(badCriticity.errors.some(e => e.includes('scoring.judgeCriticity')), 'Unknown criticity is rejected');

  const badType = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    scoring: { judgeModel: 42 }
  });
  assert.equal(badType.valid, false);
  assert.ok(badType.errors.some(e => e.includes('scoring.judgeModel')), 'Non-string judge model is rejected');

  const okConfig = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    scoring: { judgeCriticity: 'permissive', judgeModel: 'model-x', judgeCommand: 'node judge.cjs' }
  });
  assert.equal(okConfig.valid, true, 'A valid scoring block passes');

  const judge = scoreEvaluator.resolveJudgeConfig({ scoring: {} });
  assert.equal(judge.criticity, 'strict', 'Criticity defaults to strict');
  assert.equal(judge.mode, 'agent', 'Without a command the judge is the current agent model instance');
});

// ==== Spec 00057 AC15: optional judge analysis fields ====

test('00057 AC15: the verdict schema accepts and normalizes the advisory analysis fields', () => {
  const acs = dagPlanner.parseAcceptanceCriteria(SPEC_BODY);
  const verdict = {
    score: 10,
    verdicts: acs.map(ac => ({ id: ac.id, verdict: 'verified', evidence: 'app.cjs:1' })),
    summary: '  Both criteria implemented.  ',
    risks: [{ severity: 'Medium', evidence: 'app.cjs:1', note: '  check edge case  ' }],
    followUps: [' add edge-case test ']
  };

  const validated = scoreEvaluator.validateVerdict(verdict, { acs });
  assert.equal(validated.valid, true, 'AC15: a verdict with summary, risks, and followUps is accepted');
  assert.equal(validated.data.summary, 'Both criteria implemented.');
  assert.deepEqual(validated.data.risks, [{ severity: 'medium', evidence: 'app.cjs:1', note: 'check edge case' }]);
  assert.deepEqual(validated.data.followUps, ['add edge-case test']);

  const report = scoreEvaluator.applyVerdict(validated.data, { acs, minScore: 8 });
  assert.equal(report.score, 10, 'AC15: the analysis never changes the score');
  assert.equal(report.analysis.summary, 'Both criteria implemented.');
  assert.equal(report.analysis.risks.length, 1);

  const malformed = scoreEvaluator.validateVerdict(
    { ...verdict, summary: 42, risks: 'none', followUps: [1] },
    { acs }
  );
  assert.equal(malformed.valid, false, 'AC15: malformed analysis fields fail closed');
  assert.ok(malformed.errors.some(error => error.includes('summary')));
  assert.ok(malformed.errors.some(error => error.includes('risks')));
  assert.ok(malformed.errors.some(error => error.includes('followUps')));

  const legacy = scoreEvaluator.validateVerdict({ score: 10, verdicts: verdict.verdicts }, { acs });
  assert.equal(legacy.valid, true, 'AC15: verdicts without the analysis fields stay valid');
  assert.equal(legacy.data.summary, null);
  assert.deepEqual(legacy.data.risks, []);
  assert.deepEqual(legacy.data.followUps, []);
});

test('00057 AC15: score submit persists the analysis as the Step 5 contribution', () => {
  const previous = process.env.SDW_JUDGE_COMMAND;
  const tmpDir = setupRepo();
  try {
    clearJudgeEnv();
    const runCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions()
    });
    assert.equal(runCode, 5, 'the run pauses awaiting a submitted verdict');

    const state = stateManager.findLatestRunState(tmpDir);
    const promptText = fs.readFileSync(path.resolve(tmpDir, state.steps[5].output.judgePromptPath), 'utf8');
    const acIds = [...new Set([...promptText.matchAll(/^- (AC[1-9][0-9]*):/gm)].map(match => match[1]))];
    assert.ok(acIds.length > 0, 'the judge prompt declares the criteria to cover');

    const verdictFile = path.join(tmpDir, 'verdict-analysis.json');
    fs.writeFileSync(verdictFile, JSON.stringify({
      score: 10,
      verdicts: acIds.map(id => ({ id, verdict: 'verified', evidence: 'app.cjs:1' })),
      summary: 'Delivery implements both criteria.',
      risks: [{ severity: 'low', evidence: 'app.cjs:1', note: 'single file change' }],
      followUps: ['cover the resume failure path']
    }));

    const submit = sdwOrch.cmdScoreSubmit({ root: tmpDir, runId: state.runId, verdictPath: verdictFile });
    assert.equal(submit, 0, 'AC15: the analysis-bearing verdict is accepted');

    const submitted = stateManager.loadRunState(tmpDir, state.runId);
    assert.equal(submitted.steps[5].output.verdict.summary, 'Delivery implements both criteria.');
    assert.deepEqual(submitted.steps[5].output.verdict.followUps, ['cover the resume failure path']);

    const judgment = submitted.reportContributions.find(entry => entry.step === 5 && entry.kind === 'judgment');
    assert.ok(judgment, 'AC15: score submit appends the judgment contribution');
    assert.equal(judgment.body.summary, 'Delivery implements both criteria.');
    assert.equal(judgment.body.risks[0].severity, 'low');
    assert.deepEqual(judgment.body.followUps, ['cover the resume failure path']);

    const verdictEntry = submitted.reportContributions.find(entry => entry.step === 5 && entry.kind === 'verdict');
    assert.ok(verdictEntry, 'AC15: score submit appends the verdict contribution');
    assert.equal(verdictEntry.body.score, 10);
    assert.equal(verdictEntry.body.minScore, 8);

    const reportPath = path.join(tmpDir, submitted.artifactsDir, 'report.md');
    assert.ok(fs.existsSync(reportPath), 'AC15: the in-progress report is refreshed on submit');
    const markdown = fs.readFileSync(reportPath, 'utf8');
    assert.match(markdown, /Judge analysis/, 'AC15: the analysis renders in the report');
    assert.match(markdown, /cover the resume failure path/);

    // Spec 00057 AC16, AC17: the persisted verdict and judgment render as their
    // own report sections, with the per-criterion rows and the advisory fence.
    const judgmentSection = markdown.slice(markdown.indexOf('## Conformance Judgment'), markdown.indexOf('## Judge Analysis'));
    assert.match(judgmentSection, /- Score: 10\/10 \(required minimum 8\/10\)/, 'AC16: the persisted score renders');
    assert.match(judgmentSection, /- Criteria: \d+ verified, 0 failed/, 'AC16: the persisted counts render');
    for (const id of acIds) {
      assert.match(judgmentSection, new RegExp(`\\| ${id} \\| verified \\| app\\.cjs:1 \\|`), `AC16: criterion ${id} renders with its verdict and evidence`);
    }
    const analysisSection = markdown.slice(markdown.indexOf('## Judge Analysis'), markdown.indexOf('## Learnings'));
    assert.match(analysisSection, /Source: Step 5 judge .*advisory/, 'AC17: the analysis is attributed and marked advisory');
    assert.match(analysisSection, /Summary: Delivery implements both criteria\./, 'AC17: the persisted summary renders');
    assert.match(analysisSection, /\| low \| app\.cjs:1 \| single file change \|/, 'AC17: the persisted risk renders');
    assert.match(analysisSection, /- cover the resume failure path/, 'AC17: the persisted follow-up renders');
  } finally {
    withJudgeEnv(previous);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ==== Spec 00065: the judge verdict contract forbids partial ====

test('00065 AC1 & AC2: the judge prompt enumerates the exact verdict values the validator accepts', () => {
  const acs = dagPlanner.parseAcceptanceCriteria(SPEC_BODY);
  const diff = { text: 'diff --git a/app.cjs b/app.cjs\n+// implemented', bytes: 44, truncated: false, files: ['app.cjs'] };
  const { prompt } = scoreEvaluator.buildJudgePrompt({ slug: 'score-spec', acs, diff, criticity: 'strict', judge: {} });

  assert.deepEqual(scoreEvaluator.VERDICT_VALUES, ['verified', 'failed'], 'AC2: one constant defines the accepted values');

  const contract = prompt.slice(prompt.indexOf('## Output contract'), prompt.indexOf('## Rules'));
  assert.ok(contract.length > 0, 'AC1: the output contract section exists');
  for (const value of scoreEvaluator.VERDICT_VALUES) {
    assert.ok(contract.includes(`\`${value}\``), `AC1: the output contract enumerates ${value}`);
  }
  assert.match(contract, /only partly met must be reported as `failed`/, 'AC1: a partly met criterion is reported as failed');
  assert.match(contract, /Any other value, including `partial`, is rejected/, 'AC1: values outside the contract are rejected, partial included');

  const rules = prompt.slice(prompt.indexOf('## Rules'));
  assert.ok(rules.includes('one of: `verified`, `failed`'), 'AC2: the rules repeat the same enumerated values');

  // AC2: the validator accepts exactly the two enumerated values and nothing else.
  const accepted = scoreEvaluator.validateVerdict({
    score: 5,
    verdicts: [
      { id: acs[0].id, verdict: 'verified', evidence: 'app.cjs:1' },
      { id: acs[1].id, verdict: 'failed', evidence: 'the resume behaviour is absent' }
    ]
  }, { acs });
  assert.equal(accepted.valid, true, 'AC2: verified and failed are accepted');

  for (const value of ['partial', 'maybe']) {
    const rejected = scoreEvaluator.validateVerdict({
      score: 0,
      verdicts: acs.map(ac => ({ id: ac.id, verdict: value, evidence: 'app.cjs:1' }))
    }, { acs });
    assert.equal(rejected.valid, false, `AC2: ${value} is outside the contract and is rejected`);
    assert.ok(rejected.errors.some(error => error.includes('verified, failed')), `AC2: the rejection of ${value} names the allowed values`);
    assert.ok(rejected.errors.some(error => error.includes('only partly met')), `AC2: the rejection of ${value} names the partly met rule`);
  }
});

test('00065 AC5: verified and failed verdicts submit, and only verified criteria score', () => {
  const previous = process.env.SDW_JUDGE_COMMAND;
  const tmpDir = setupRepo();
  try {
    clearJudgeEnv();
    const runCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions()
    });
    assert.equal(runCode, 5, 'the run pauses awaiting a submitted verdict');

    const state = stateManager.findLatestRunState(tmpDir);
    const promptText = fs.readFileSync(path.resolve(tmpDir, state.steps[5].output.judgePromptPath), 'utf8');
    assert.ok(promptText.includes('A criterion that is only partly met must be reported as `failed`'), 'AC1: the written judge prompt forbids partial');

    const acIds = [...new Set([...promptText.matchAll(/^- (AC[1-9][0-9]*):/gm)].map(match => match[1]))];
    assert.equal(acIds.length, 2, 'both specification criteria reach the judge');

    const verdictFile = path.join(tmpDir, 'verdict-mixed.json');
    fs.writeFileSync(verdictFile, JSON.stringify({
      score: 5,
      verdicts: [
        { id: acIds[0], verdict: 'verified', evidence: 'app.cjs:1' },
        { id: acIds[1], verdict: 'failed', evidence: 'The resume behaviour is absent.' }
      ]
    }));

    const submitCode = sdwOrch.cmdScoreSubmit({ root: tmpDir, runId: state.runId, verdictPath: verdictFile, minScore: 5 });
    assert.equal(submitCode, 0, 'AC5: a verified/failed verdict is accepted and scores above the threshold');

    const submitted = stateManager.loadRunState(tmpDir, state.runId);
    assert.equal(submitted.steps[5].status, 'judged', 'AC5: the accepted verdict completes Step 5 scoring');
    assert.equal(submitted.score, 5, 'AC5: the single verified criterion scores 5/10');
    assert.equal(submitted.steps[5].output.verifiedCount, 1);
    assert.equal(submitted.steps[5].output.failingCount, 1);
    assert.deepEqual(submitted.steps[5].output.failingAcs.map(entry => entry.id), [acIds[1]], 'AC5: the failed criterion is reported as unmet');
    assert.deepEqual(submitted.steps[5].output.verdict.verdicts, [
      { id: acIds[0], verdict: 'verified', evidence: 'app.cjs:1' },
      { id: acIds[1], verdict: 'failed', evidence: 'The resume behaviour is absent.' }
    ], 'AC5: the submitted verdict is persisted as judged, not rewritten');
  } finally {
    withJudgeEnv(previous);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('00065 AC4 & AC5: score submit rejects partial, names the allowed values, and persists nothing', () => {
  const previous = process.env.SDW_JUDGE_COMMAND;
  const tmpDir = setupRepo();
  try {
    clearJudgeEnv();
    const runCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/score-spec.md',
      skipReview: true,
      skipPr: true,
      ...implementationOptions()
    });
    assert.equal(runCode, 5, 'the run pauses awaiting a submitted verdict');

    const state = stateManager.findLatestRunState(tmpDir);
    const promptText = fs.readFileSync(path.resolve(tmpDir, state.steps[5].output.judgePromptPath), 'utf8');
    const acIds = [...new Set([...promptText.matchAll(/^- (AC[1-9][0-9]*):/gm)].map(match => match[1]))];

    const verdictFile = path.join(tmpDir, 'verdict-partial.json');
    fs.writeFileSync(verdictFile, JSON.stringify({
      score: 5,
      verdicts: acIds.map(id => ({ id, verdict: 'partial', evidence: 'app.cjs:1' }))
    }));

    const messages = [];
    const originalError = console.error;
    console.error = (...args) => messages.push(args.map(String).join(' '));
    let submitCode;
    try {
      submitCode = sdwOrch.cmdScoreSubmit({ root: tmpDir, runId: state.runId, verdictPath: verdictFile });
    } finally {
      console.error = originalError;
    }
    const output = messages.join('\n');
    assert.equal(submitCode, 1, 'AC4: a partial verdict is rejected with a non-zero exit');
    assert.match(output, /must be one of: verified, failed/, 'AC4: the rejection names the allowed values');
    assert.match(output, /only partly met/, 'AC4: the rejection says to use failed for a partly met criterion');
    assert.match(output, /"failed"/, 'AC4: the rejection names the replacement verdict');

    const afterReject = stateManager.loadRunState(tmpDir, state.runId);
    assert.equal(afterReject.steps[5].status, 'awaiting_judgment', 'AC5: nothing is persisted after a rejected verdict');
    assert.equal(afterReject.score, state.score, 'AC5: the rejected verdict never changes the score');
    assert.equal(afterReject.steps[5].output.judgedAt, undefined, 'AC5: no judgment timestamp is written');

    // AC4: the same contract holds at the CLI boundary, not only in-process.
    const cli = spawnSync(process.execPath, [ORCH_CLI, 'score', 'submit', '--root', tmpDir, '--run-id', state.runId, '--verdict', verdictFile], { encoding: 'utf8' });
    assert.equal(cli.status, 1, 'AC4: the CLI exits non-zero for a partial verdict');
    assert.match(cli.stderr, /verified, failed/, 'AC4: the CLI stderr names the allowed values');
    assert.match(cli.stderr, /only partly met/, 'AC4: the CLI stderr tells the caller to use failed');

    const afterCli = stateManager.loadRunState(tmpDir, state.runId);
    assert.equal(afterCli.steps[5].status, 'awaiting_judgment', 'AC5: the CLI rejection persists nothing either');
  } finally {
    withJudgeEnv(previous);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
