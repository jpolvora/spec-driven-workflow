'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const stateManager = require('../skills/sdw-run/scripts/state_manager.cjs');
const specDerivation = require('../skills/sdw-run/scripts/spec_derivation.cjs');
const specGrilling = require('../skills/sdw-run/scripts/spec_grilling.cjs');
const dagPlanner = require('../skills/sdw-run/scripts/dag_planner.cjs');
const scoreEvaluator = require('../skills/sdw-run/scripts/score_evaluator.cjs');
const reviewRunner = require('../skills/sdw-run/scripts/review_runner.cjs');
const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');

// Spec 027: wire the deterministic judge stub for unattended runs past Step 4.
require('./fixtures/judge_env.cjs').installJudgeEnv();

const JUDGE_STUB = path.resolve(__dirname, 'fixtures', 'judge_stub.cjs');

// Spec 027: Step 5 delegates scoring to a judge. Unattended tests wire the stub
// through `scoring.judgeCommand`; without it Step 5 pauses with exit code 5.
function judgeScoring(mode = 'all') {
  return { judgeCommand: `node "${JUDGE_STUB}" {promptFile} {verdictFile} ${mode}` };
}

test('AC1 & AC2: Run State Isolation & Resumption Lifecycle', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-test-'));
  try {
    const runState = stateManager.createRunState({
      root: tmpDir,
      specPath: '.sdw/specs/test.md',
      slug: 'test-feature',
      baseCommit: 'commit-123'
    });

    assert.ok(runState.runId.startsWith('run-'), 'Run ID should be generated');
    assert.equal(runState.orchestrator, 'sdw-run', 'Run state must record sdw-run orchestrator');
    const statePath = stateManager.getStateFilePath(tmpDir, runState.runId);
    assert.ok(fs.existsSync(statePath), 'State file must exist on disk (AC1)');

    // Simulate completion of steps 1, 2, 3
    stateManager.updateStepState(tmpDir, runState.runId, 1, 'completed', { derivationNeeded: false });
    stateManager.updateStepState(tmpDir, runState.runId, 2, 'completed', { hasGaps: false });
    stateManager.updateStepState(tmpDir, runState.runId, 3, 'completed', { tasks: [] });

    // Step 4 is in_progress / paused
    stateManager.updateStepState(tmpDir, runState.runId, 4, 'in_progress');

    const loaded = stateManager.loadRunState(tmpDir, runState.runId);
    assert.equal(loaded.currentStep, 4);
    assert.equal(stateManager.getResumptionStep(loaded), 4, 'Resumption must identify step 4 (AC2)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC3 & AC4: Specification Derivation & Pre-formatted Detection', () => {
  const humanSpec = `# User Authentication
- The user can log in with email and password
- If password is wrong, show error`;

  const derived = specDerivation.deriveAgentSpec(humanSpec, { slug: 'auth' });
  assert.equal(derived.derivationNeeded, true, 'Human spec requires derivation (AC3)');
  assert.ok(derived.specContent.includes('## Acceptance Criteria'), 'Derived spec contains AC section');
  assert.ok(derived.specContent.includes('- AC1: The system shall'), 'Converts bullet to EARS format');

  const agentReadySpec = `---
slug: agent-ready
title: Ready
---
# Specification
## Acceptance Criteria
- AC1: The system shall validate login credentials.
## Definition of Ready
| Item | Requirement | Verification Method |
|---|---|---|
| Ready | Valid | Check |
`;

  const checkReady = specDerivation.deriveAgentSpec(agentReadySpec);
  assert.equal(checkReady.derivationNeeded, false, 'Agent ready spec skips derivation (AC4)');
});

test('AC5 & AC6: Grilling Decision Tree Walk & User Gap Handling', () => {
  const bareSpec = `# Minimal Feature
## Description
Simple feature without error handling or concurrency specs.`;

  const result = specGrilling.analyzeSpecificationGaps(bareSpec);
  assert.ok(result.hasGaps, 'Identifies decision gaps (AC5)');
  assert.ok(result.gaps.length > 0, 'Detects uncovered decision dimensions');

  const gap = result.gaps[0];
  assert.ok(gap.options.length >= 2, 'Provides multiple choice options (AC6)');
  assert.ok(gap.defaultChoice.startsWith('(Recommended)'), 'Includes pre-selected recommended default (AC6)');

  const applied = specGrilling.applyDecision(bareSpec, gap.dimension, gap.defaultChoice);
  assert.ok(applied.includes(gap.dimension), 'Applies grilling resolution to spec');
});

test('AC7 & AC8: DAG Complexity Decomposition & Context Fencing', () => {
  const complexSpec = `---
slug: multi-step
---
# Specification
## Acceptance Criteria
- AC1: The orchestrator shall parse cli commands.
- AC2: The orchestrator shall manage state files.
- AC3: The orchestrator shall interact with git.
- AC4: The orchestrator shall prepare pr payload.
- AC5: The orchestrator shall handle ui events.
- AC6: The orchestrator shall dispatch subagents.
`;

  const plan = dagPlanner.generateDagPlan(complexSpec, { slug: 'multi-step' });
  assert.equal(plan.complexity.level, 'complex', 'Identifies complex spec (AC7)');
  assert.ok(plan.tasks.length >= 2, 'Decomposes complex spec into multiple tasks (AC7)');

  // Context fencing verification (AC8)
  for (const task of plan.tasks) {
    assert.ok(task.contextPrompt, 'Task must provide a context prompt');
    assert.ok(task.coveredAcs.length > 0, 'Task specifies covered ACs');
    assert.ok(!task.contextPrompt.includes('conversation transcripts'), 'Prompt is context-fenced');
  }
});

test('AC9 & AC10: Conformance Scoring & Re-implementation Loop Gating', () => {
  const spec = `## Acceptance Criteria
- AC1: The orchestrator shall maintain an isolated state JSON file for each execution run.
- AC2: When a paused execution run resumes, the orchestrator shall restore session state from the state file.
`;
  const acs = dagPlanner.parseAcceptanceCriteria(spec);
  const diff = { text: 'diff --git a/state.cjs b/state.cjs\n+state', bytes: 44, truncated: false, files: ['state.cjs'] };

  // AC3: the judge context holds the criteria and the diff and nothing else.
  const bundle = scoreEvaluator.buildJudgePrompt({ slug: 'demo', acs, diff, criticity: 'strict', judge: {} });
  assert.ok(bundle.prompt.includes('- AC1: The orchestrator shall maintain an isolated state JSON file'), 'Criteria text is inlined');
  assert.ok(bundle.prompt.includes('diff --git a/state.cjs b/state.cjs'), 'Diff is inlined');
  assert.ok(bundle.prompt.includes('## Criticity: strict'), 'Criticity is stated');
  assert.ok(!/transcript/i.test(bundle.prompt), 'No transcript content is included');

  // AC7: per-criterion verdicts are required, and only they drive the score.
  const passingVerdict = {
    score: 10,
    verdicts: acs.map(ac => ({ id: ac.id, verdict: 'verified', evidence: 'state.cjs:1' }))
  };
  const passingValidation = scoreEvaluator.validateVerdict(passingVerdict, { acs });
  assert.equal(passingValidation.valid, true, 'A complete verdict is accepted');

  const passingReport = scoreEvaluator.applyVerdict(passingValidation.data, { acs, minScore: 8 });
  assert.equal(passingReport.score, 10);
  assert.equal(passingReport.verifiedCount, 2);
  assert.equal(passingReport.passed, true);

  // AC9: below threshold keeps the re-implementation loop.
  const partialVerdict = {
    score: 5,
    verdicts: [
      { id: 'AC1', verdict: 'verified', evidence: 'state.cjs:1' },
      { id: 'AC2', verdict: 'failed', evidence: 'Resume restoration is absent.' }
    ]
  };
  const partialReport = scoreEvaluator.applyVerdict(
    scoreEvaluator.validateVerdict(partialVerdict, { acs }).data,
    { acs, minScore: 8 }
  );
  assert.equal(partialReport.score, 5, 'Score derives from the per-criterion verdicts');
  assert.equal(partialReport.passed, false, 'Below threshold does not pass');
  assert.equal(partialReport.failingAcs.length, 1);

  // AC10: malformed verdicts fail closed instead of scoring.
  const malformed = scoreEvaluator.validateVerdict({ score: 42, verdicts: [{ id: 'AC9', verdict: 'maybe' }] }, { acs });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.some(e => e.includes('score')), 'Rejects an out-of-range score');
  assert.ok(malformed.errors.some(e => e.includes('AC9')), 'Rejects an unknown criterion id');
  assert.ok(malformed.errors.some(e => e.includes('Missing verdict')), 'Rejects incomplete coverage');
});

test('AC12 & AC13: Code Review Detection & Automated Fix Application', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-review-test-'));
  try {
    const dirtyFile = path.join(tmpDir, 'dirty.cjs');
    fs.writeFileSync(dirtyFile, `function test() {\n  debugger;\n  return true;\n}\n`);

    const findings = [
      {
        file: 'dirty.cjs',
        severity: 'error',
        rule: 'no_debugger_statements',
        fixable: true
      }
    ];

    const fixed = reviewRunner.applyAutoFixes(findings, tmpDir);
    assert.deepEqual(fixed, ['dirty.cjs'], 'Applies automated fix (AC13)');
    const cleaned = fs.readFileSync(dirtyFile, 'utf8');
    assert.ok(!cleaned.includes('debugger;'), 'Debugger statement removed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('review_runner.runAutomatedReview fails closed when review cannot run', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-review-fail-'));
  try {
    const result = reviewRunner.runAutomatedReview({ projectRoot: empty });
    assert.equal(result.passed, false, 'unrunnable review must not pass');
    assert.equal(result.errorCount, 1);
    assert.ok(result.error, 'error must describe the review failure');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('AC16: Unrecoverable Failure State Persistence & Halting', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fail-test-'));
  try {
    const runState = stateManager.createRunState({
      root: tmpDir,
      specPath: '.sdw/specs/fail.md',
      slug: 'fail-feature'
    });

    stateManager.recordError(tmpDir, runState.runId, 4, 'Simulated unrecoverable failure');
    const loaded = stateManager.loadRunState(tmpDir, runState.runId);

    assert.equal(loaded.status, 'failed', 'State is marked failed (AC16)');
    assert.equal(loaded.steps[4].status, 'failed');
    assert.ok(loaded.errors.length > 0, 'Error is recorded');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Negative Scenario 1: Re-implementation Loop Trigger on Low Score', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-lowscore-test-'));
  try {
    const specDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const specPath = path.join(specDir, 'low-score.md');
    fs.writeFileSync(specPath, `---
slug: low-score
---
# Low Score Feature
## Acceptance Criteria
- AC1: The orchestrator shall satisfy nonexistent quantum encryption feature alpha beta.
- AC2: The orchestrator shall satisfy nonexistent interplanetary telemetry gamma delta.
`);

    // Running with minScore 8 against partial implementation (covering only 1 of 2 ACs = score 5) should exit with code 2 (loop trigger)
    const exitCode = sdwRun.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/low-score.md',
      minScore: 8,
      skipReview: true,
      skipPr: true,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/low-score.md\'], summary: \'partial\' }));"'
      },
      scoring: judgeScoring('none')
    });

    assert.equal(exitCode, 2, 'Must exit with code 2 when conformance score fails threshold');
    const latestState = stateManager.findLatestRunState(tmpDir);
    assert.equal(latestState.status, 'failed', 'State is marked failed / reimplementation needed');
    assert.equal(latestState.steps[5].status, 'reimplementation_needed');
    assert.ok(latestState.score < 8, 'Recorded score is below threshold');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Negative Scenario 2: Interrupted Session Recovery from Step 4', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-recovery-test-'));
  try {
    const specDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const specPath = path.join(specDir, 'recovery.md');
    fs.writeFileSync(specPath, `---
slug: recovery
---
# Recovery Feature
## Acceptance Criteria
- AC1: The orchestrator shall maintain state.
`);

    const runState = stateManager.createRunState({
      root: tmpDir,
      specPath: '.sdw/specs/recovery.md',
      slug: 'recovery'
    });

    // Mark steps 1, 2, 3 as completed with fixed timestamps
    const t1 = '2026-10-01T00:00:00.000Z';
    stateManager.updateStepState(tmpDir, runState.runId, 1, 'completed', { derivationNeeded: false });
    stateManager.updateStepState(tmpDir, runState.runId, 2, 'completed', { hasGaps: false });
    stateManager.updateStepState(tmpDir, runState.runId, 3, 'completed', { tasks: [] });

    let state = stateManager.loadRunState(tmpDir, runState.runId);
    state.steps[1].completedAt = t1;
    state.steps[2].completedAt = t1;
    state.steps[3].completedAt = t1;
    stateManager.saveRunState(tmpDir, state);

    // Resume from step 4
    const resumptionStep = stateManager.getResumptionStep(state);
    assert.equal(resumptionStep, 4, 'Resumption starts at step 4');

    // Run resume
    sdwRun.cmdResume({
      root: tmpDir,
      runId: runState.runId,
      skipReview: true,
      skipPr: true
    });

    const resumedState = stateManager.loadRunState(tmpDir, runState.runId);
    assert.equal(resumedState.steps[1].completedAt, t1, 'Step 1 was NOT re-run');
    assert.equal(resumedState.steps[2].completedAt, t1, 'Step 2 was NOT re-run');
    assert.equal(resumedState.steps[3].completedAt, t1, 'Step 3 was NOT re-run');
    assert.equal(resumedState.steps[4].status, 'completed', 'Step 4 was executed on resume');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Negative Scenario 3: User Cancellation at Grilling Gate', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-grill-abort-'));
  try {
    const specDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const specPath = path.join(specDir, 'grill-abort.md');
    fs.writeFileSync(specPath, `# Bare Specification without Dimensions
Simple text without bounds, concurrency, or persistence notes.`);

    const exitCode = sdwRun.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/grill-abort.md',
      abortOnGaps: true
    });

    assert.equal(exitCode, 3, 'Cleanly aborts with code 3 on grilling gate cancellation');
    const latestState = stateManager.findLatestRunState(tmpDir);
    assert.equal(latestState.status, 'paused', 'Run is paused at grilling gate');
    assert.equal(latestState.steps[2].status, 'paused_grilling_gate');
    assert.equal(latestState.steps[4].status, 'pending', 'Implementation agents were NOT dispatched');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Negative Scenario 4: Removed Legacy Path Invocation Fails Loudly (AC8)', () => {
  assert.throws(() => {
    require('../skills/sdw-implement/scripts/sdw_implement.cjs');
  }, {
    code: 'MODULE_NOT_FOUND'
  }, 'Invoking removed skills/sdw-implement path must throw MODULE_NOT_FOUND');
});

test('Negative Scenario 5: Obsolete State File Rejection on Resume', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-obsolete-test-'));
  try {
    const specDir = path.join(tmpDir, '.sdw', 'specs');
    const stateDir = path.join(tmpDir, '.sdw', 'state');
    fs.mkdirSync(specDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const specPath = path.join(specDir, 'legacy-feature.md');
    fs.writeFileSync(specPath, `---
slug: legacy-feature
---
# Legacy Feature
## Acceptance Criteria
- AC1: The orchestrator shall test legacy state rejection.
`);

    // Create a legacy state file with obsolete orchestrator identifier
    const legacyRunId = 'run-1700000000000-legacy-feature';
    const legacyStateFile = path.join(stateDir, `${legacyRunId}.state.json`);
    fs.writeFileSync(legacyStateFile, JSON.stringify({
      orchestrator: 'sdw-implement',
      runId: legacyRunId,
      specSlug: 'legacy-feature',
      specPath: '.sdw/specs/legacy-feature.md',
      projectRoot: tmpDir.replace(/\\/g, '/'),
      status: 'in_progress',
      currentStep: 3,
      totalSteps: 8,
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:05:00.000Z',
      baseCommit: null,
      deliveryCommit: null,
      score: null,
      dagTasks: [],
      steps: {
        1: { name: 'derivation', status: 'completed' },
        2: { name: 'grilling', status: 'completed' },
        3: { name: 'dag_generation', status: 'completed' },
        4: { name: 'implementation', status: 'pending' },
        5: { name: 'scoring', status: 'pending' },
        6: { name: 'delivery_commit', status: 'pending' },
        7: { name: 'code_review', status: 'pending' },
        8: { name: 'pr_preparation', status: 'pending' }
      },
      handoffs: {},
      errors: []
    }, null, 2), 'utf8');

    const exitCode = sdwRun.cmdResume({
      root: tmpDir,
      runId: legacyRunId
    });

    assert.equal(exitCode, 1, 'Must reject resumption of obsolete/legacy state file with exit code 1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Remote Push & Branch Publishing Lifecycle (--push)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-push-test-'));
  try {
    const specDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const specPath = path.join(specDir, 'push-feature.md');
    fs.writeFileSync(specPath, `---
slug: push-feature
---
# Push Feature
## Acceptance Criteria
- AC1: The orchestrator shall test remote branch push execution.
`);

    // Execute run with --push when no remote is configured (handles local safely)
    const exitCode = sdwRun.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/push-feature.md',
      push: true,
      skipReview: true,
      skipPr: false,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/push-feature.md\'], summary: \'push feature done\' }));"'
      },
      scoring: judgeScoring()
    });

    assert.equal(exitCode, 0, 'Cleanly finishes run with --push flag without unhandled exceptions');
    const state = stateManager.findLatestRunState(tmpDir);
    assert.equal(state.status, 'completed', 'Run marked completed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC13: Multi-spec run is rejected and names sdw-batch', () => {
  const cliPath = path.resolve(__dirname, '../skills/sdw-run/scripts/sdw_run.cjs');
  let failure = null;
  try {
    execSync(`node "${cliPath}" run a.md b.md`, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    failure = err;
  }

  assert.ok(failure, 'Multi-spec run must exit non-zero (AC13)');
  assert.equal(failure.status, 1, 'Multi-spec run exits with code 1 (AC13)');
  assert.match(String(failure.stderr), /sdw-batch/, 'Error must name sdw-batch (AC13)');
});

test('AC15: dry run prints the resolved branch plan without executing git', () => {
  const root = path.resolve(__dirname, '..');
  const spec = path.join(root, '.sdw', 'specs', '00040-sdw-branching-strategy.md');
  let output = '';
  const origLog = console.log;
  console.log = (msg) => { output += String(msg) + '\n'; };
  let code;
  try {
    code = sdwRun.printRunDryRunPlan({
      targetRoot: root,
      resolvedSpec: spec,
      specSlug: '00040-sdw-branching-strategy',
      config: {
        useFeatureBranches: true,
        branching: {
          strategy: 'develop',
          featurePrefix: 'feature/',
          workBranch: 'develop',
          integrationBranch: 'main',
          updateWorkBranch: true,
          syncWorkBranchAfterMerge: true,
          pushSyncedWorkBranch: false
        }
      },
      options: {}
    });
  } finally {
    console.log = origLog;
  }

  assert.equal(code, 0);
  assert.match(output, /Strategy: develop/);
  assert.match(output, /Start lane: develop \(update: yes\)/);
  assert.match(output, /Feature branch: feature\/00040-sdw-branching-strategy/);
  assert.match(output, /Pull request target: main/);
  assert.match(output, /After merge: fast-forward develop to main/);
  assert.match(output, /branching=develop/);
  assert.match(output, /No steps executed \(--dry-run\)/);

  // AC10/AC15: a work lane equal to the integration lane plans the trunk fallback.
  let sameLaneOutput = '';
  console.log = (msg) => { sameLaneOutput += String(msg) + '\n'; };
  try {
    code = sdwRun.printRunDryRunPlan({
      targetRoot: root,
      resolvedSpec: spec,
      specSlug: '00040-sdw-branching-strategy',
      config: {
        branching: {
          strategy: 'gitflow',
          workBranch: 'develop',
          integrationBranch: 'develop',
          updateWorkBranch: true,
          syncWorkBranchAfterMerge: true
        }
      },
      options: {}
    });
  } finally {
    console.log = origLog;
  }
  assert.equal(code, 0);
  assert.match(sameLaneOutput, /Start lane: develop \(update: yes\)/);
  assert.match(sameLaneOutput, /After merge: fetch origin and fast-forward develop to origin\/develop/);
});

test('AC9, AC10, AC14: feature prefix names the branch and run state records the resolved lanes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-branching-state-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmpDir, '.sdw', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# repo\n', 'utf8');
    execSync('git add -A && git commit -m "initial"', { cwd: tmpDir, stdio: 'ignore' });
    const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.json'), JSON.stringify({
      useFeatureBranches: true,
      useWorktrees: false,
      pushDelivery: false,
      scmProvider: 'none',
      branching: {
        strategy: 'trunk',
        featurePrefix: 'feat/',
        workBranch: null,
        integrationBranch: defaultBranch,
        updateWorkBranch: false,
        syncWorkBranchAfterMerge: false,
        pushSyncedWorkBranch: false
      }
    }, null, 2), 'utf8');

    const slug = 'branch-state';
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'specs', `${slug}.md`), `---
slug: ${slug}
title: Branch State
---
# Branch State
## Acceptance Criteria
- AC1: The system shall record branch state.
`, 'utf8');
    execSync('git add -A && git commit -m "baseline"', { cwd: tmpDir, stdio: 'ignore' });
    const baseHead = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    const runId = `run-${Date.now()}-${slug}`;
    let output = '';
    const origLog = console.log;
    console.log = (msg) => { output += String(msg) + '\n'; };
    let code;
    try {
      code = sdwRun.cmdRun({
        root: tmpDir,
        specPath: `.sdw/specs/${slug}.md`,
        runId,
        minScore: 0,
        skipReview: true,
        skipPr: true,
        implementation: {
          mode: 'command',
          command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'README.md\'], summary: \'task done\' })); fs.appendFileSync(\'README.md\', \'\\n# update for \' + process.env.SDW_TASK_ID);"'
        },
        scoring: judgeScoring()
      });
    } finally {
      console.log = origLog;
    }
    assert.equal(code, 0);

    const activeBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.equal(activeBranch, `feat/${slug}`, 'AC9: feature prefix names the branch');
    assert.equal(
      execSync(`git merge-base feat/${slug} ${baseHead}`, { cwd: tmpDir, encoding: 'utf8' }).trim(),
      baseHead,
      'AC10: a null work lane starts the feature branch from the checked-out branch'
    );
    assert.match(output, new RegExp(`trunk: created feat/${slug} from ${defaultBranch} at [0-9a-f]+`), 'Activation names the strategy and the real start point');

    const state = stateManager.loadRunState(tmpDir, runId);
    assert.equal(state.branch, `feat/${slug}`);
    assert.equal(state.branching.strategy, 'trunk');
    assert.equal(state.branching.source, 'config');
    assert.equal(state.branching.featurePrefix, 'feat/');
    assert.equal(state.branching.featureBranch, `feat/${slug}`);
    assert.equal(state.branching.workBranch, null);
    assert.equal(state.branching.integrationBranch, defaultBranch);
    assert.equal(state.branching.syncWorkBranchAfterMerge, false);
    assert.equal(state.branchingSync, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


