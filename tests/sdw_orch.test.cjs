'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const specDerivation = require('../skills/sdw-orch/scripts/spec_derivation.cjs');
const specGrilling = require('../skills/sdw-orch/scripts/spec_grilling.cjs');
const dagPlanner = require('../skills/sdw-orch/scripts/dag_planner.cjs');
const scoreEvaluator = require('../skills/sdw-orch/scripts/score_evaluator.cjs');
const reviewRunner = require('../skills/sdw-orch/scripts/review_runner.cjs');
const deliveryReport = require('../skills/sdw-orch/scripts/delivery_report.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

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
    assert.equal(runState.orchestrator, 'sdw-orch', 'Run state must record sdw-orch orchestrator');
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
    const exitCode = sdwOrch.cmdRun({
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
    sdwOrch.cmdResume({
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

    const exitCode = sdwOrch.cmdRun({
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

    const exitCode = sdwOrch.cmdResume({
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
    const exitCode = sdwOrch.cmdRun({
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
  const cliPath = path.resolve(__dirname, '../skills/sdw-orch/scripts/sdw_orch.cjs');
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
    code = sdwOrch.printRunDryRunPlan({
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
    code = sdwOrch.printRunDryRunPlan({
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
      code = sdwOrch.cmdRun({
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

test('00054 AC1 & AC15: Step 7 writes the delivery report beside the specification before Step 8', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-delivery-report-run-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmpDir, '.sdw', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# delivery fixture\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.json'), JSON.stringify({
      scoreMin: 8,
      scmProvider: 'none',
      useFeatureBranches: false,
      useWorktrees: false,
      pushDelivery: false
    }, null, 2), 'utf8');
    const slug = 'delivery';
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'specs', `${slug}.md`), `---
slug: ${slug}
title: Delivery Fixture
---
# Delivery Fixture
## Acceptance Criteria
- AC1: The orchestrator shall write the delivery report beside the specification.
`, 'utf8');
    execSync('git add -A && git commit -m "baseline"', { cwd: tmpDir, stdio: 'ignore' });

    const runId = `run-${Date.now()}-${slug}`;
    let output = '';
    const origLog = console.log;
    console.log = (msg) => { output += String(msg) + '\n'; };
    let code;
    try {
      code = sdwOrch.cmdRun({
        root: tmpDir,
        specPath: `.sdw/specs/${slug}.md`,
        runId,
        minScore: 8,
        skipReview: true,
        implementation: {
          mode: 'command',
          command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'README.md\'], tests: [{ name: \'fixture test\', status: \'passed\' }], summary: \'delivery fixture done\' })); fs.appendFileSync(\'README.md\', \'\\n# delivery update\');"'
        },
        scoring: judgeScoring()
      });
    } finally {
      console.log = origLog;
    }

    assert.equal(code, 0, 'Run completes');
    const reportPath = path.join(tmpDir, '.sdw', 'specs', 'delivery-report.md');
    assert.ok(fs.existsSync(reportPath), 'AC1: report is the specification sibling named {specFileNameWithoutExtension}-report.md');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.sdw', 'state', 'delivery-report.md')), 'AC1: report does not live in run state');

    const markdown = fs.readFileSync(reportPath, 'utf8');
    const state = stateManager.loadRunState(tmpDir, runId);
    assert.match(markdown, /^# Delivery Report — Delivery Fixture/m, 'AC2: report title names the specification');
    assert.ok(markdown.includes(state.runId), 'AC2: report records the run id');
    assert.ok(markdown.includes(`| Specification slug | ${slug} |`), 'AC2: report records the specification slug');
    assert.match(markdown, /Score \| 10\/10 \(scoreMin 8\)/, 'AC2: report records the score against scoreMin');
    assert.ok(markdown.includes('| Branch |'), 'AC2: report records the branch');
    assert.ok(markdown.includes('| Base branch |'), 'AC2: report records the base branch');
    assert.ok(markdown.includes('| Base commit |'), 'AC2: report records the base commit');
    assert.ok(markdown.includes('| Delivery commit |'), 'AC2: report records the delivery commit');
    assert.ok(markdown.includes('| Ship status |'), 'AC2: report records the ship status');
    assert.ok(markdown.includes('| Implementation start |'), 'AC2: report records the implementation start');
    assert.ok(markdown.includes('| Implementation end |'), 'AC2: report records the implementation end');
    assert.ok(markdown.includes('| Total wall-clock duration |'), 'AC2: report records the total duration');
    assert.ok(markdown.includes('| Step 1: derivation'), 'AC2: report records one row per step with its duration');
    assert.ok(markdown.includes('| task-1 |'), 'AC3: report summarizes accepted tasks');
    assert.ok(markdown.includes('| AC1 |'), 'AC3: report lists the covered acceptance criteria');
    assert.ok(markdown.includes(state.steps[4].tasks['task-1'].commitSha), 'AC3: report records the checkpoint commit');
    assert.ok(markdown.includes(`feat(${slug}): implement ${slug}`), 'AC4: report lists delivery commits with SHA and subject');
    assert.ok(markdown.includes('`README.md`'), 'AC5: report lists changed files');
    assert.match(markdown, /\| `README\.md` \| modified \|/, 'AC5: report records the change type');
    assert.ok(markdown.includes('## Spec Observations'), 'AC10: report includes the Spec Observations section');
    assert.ok(markdown.includes('## Notes'), 'AC9: report includes the Notes section');
    assert.ok(markdown.includes('## Outcome'), 'Report closes with the outcome section');

    assert.equal(state.deliveryReport, '.sdw/specs/delivery-report.md', 'Run state records the report path');
    assert.equal(state.steps[7].status, 'skipped', 'Report is written after Step 7 resolves');
    assert.match(output, /Delivery report written: \.sdw\/specs\/delivery-report\.md/, 'One console line names the written report');

    // AC15: the report lands in its own scoped commit that stages only that file.
    assert.equal(
      execSync('git log -1 --format=%s', { cwd: tmpDir, encoding: 'utf8' }).trim(),
      'docs(delivery): record delivery report',
      'AC15: the report is committed with its own scoped message'
    );
    const committedFiles = execSync('git show --name-only --format= HEAD', { cwd: tmpDir, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    assert.deepEqual(committedFiles, ['.sdw/specs/delivery-report.md'], 'AC15: the report commit stages only the report');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('00054 AC2-AC10: report renders tasks, commits, files, gates, review, breaking changes, quality, observations and notes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-delivery-report-render-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });
    fs.mkdirSync(path.join(tmpDir, '.sdw', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'skills', 'sdw-demo', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'specs', 'demo.md'), `---
slug: demo
title: "Demo Feature"
---
# Demo Feature
## Acceptance Criteria
- AC1: The system shall do X.
- AC2: The system shall do Y.
`, 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.json'), JSON.stringify({ scoreMin: 8 }, null, 2), 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.schema.json'), JSON.stringify({
      properties: { scoreMin: { type: 'integer' } }
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'skills', 'sdw-demo', 'scripts', 'demo.cjs'), '// usage: --dry-run\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'skills', 'sdw-demo', 'scripts', 'legacy.cjs'), '// legacy\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'base\n', 'utf8');
    execSync('git add -A && git commit -m "chore: base"', { cwd: tmpDir, stdio: 'ignore' });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'changed\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'added\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.json'), JSON.stringify({ scoreMin: 9, newKey: true }, null, 2), 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.schema.json'), JSON.stringify({
      properties: { scoreMin: { type: 'integer', minimum: 1 } }
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'skills', 'sdw-demo', 'scripts', 'demo.cjs'), '// usage: --dry-run --new-flag\n', 'utf8');
    fs.unlinkSync(path.join(tmpDir, 'skills', 'sdw-demo', 'scripts', 'legacy.cjs'));
    execSync('git add -A && git commit -m "feat: delivery"', { cwd: tmpDir, stdio: 'ignore' });
    const deliveryCommit = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    const evidenceDir = path.join(tmpDir, '.sdw', 'state', 'demo', 'run-fixture');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'task-task-1.evidence.json'), JSON.stringify({
      taskId: 'task-1',
      tests: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }]
    }), 'utf8');

    const state = {
      runId: 'run-fixture',
      specSlug: 'demo',
      specPath: '.sdw/specs/demo.md',
      status: 'completed',
      branch: 'feature/demo',
      baseBranch: 'develop',
      baseCommit,
      deliveryCommit,
      shipStatus: 'shipped',
      score: 9,
      createdAt: '2026-10-22T10:00:00.000Z',
      scoreIteration: 1,
      reviewIteration: 0,
      dagTasks: [
        { id: 'task-1', title: 'Core', coveredAcs: ['AC1'] },
        { id: 'task-2', title: 'Docs', coveredAcs: ['AC2'] }
      ],
      steps: {
        1: { name: 'derivation', status: 'skipped', completedAt: '2026-10-22T10:00:10.000Z', output: { derivationNeeded: false } },
        2: {
          name: 'refinement', status: 'completed', startedAt: '2026-10-22T10:00:10.000Z', completedAt: '2026-10-22T10:01:10.000Z',
          output: { specObservations: [{ kind: 'overlap', otherSpec: 'demo-old', evidence: 'shares demo.md', severity: 'high' }] }
        },
        3: { name: 'dag_generation', status: 'completed', startedAt: '2026-10-22T10:01:10.000Z', completedAt: '2026-10-22T10:01:40.000Z' },
        4: {
          name: 'implementation', status: 'completed', startedAt: '2026-10-22T10:01:40.000Z', completedAt: '2026-10-22T10:31:40.000Z',
          gates: {
            build: { status: 'passed', exitCode: 0, durationMs: 1200 },
            test: { status: 'failed', exitCode: 1, durationMs: 3000 }
          },
          dispatch: { abandonments: [{ taskId: 'task-1', reason: 'lost worker', at: '2026-10-22T10:05:00.000Z' }] },
          tasks: {
            'task-1': {
              id: 'task-1', title: 'Core', status: 'completed', acIds: ['AC1'], commitSha: deliveryCommit,
              filesChanged: ['skills/sdw-demo/scripts/demo.cjs', '.sdw/config.json'],
              dispatchedAt: '2026-10-22T10:01:40.000Z', completedAt: '2026-10-22T10:21:40.000Z',
              evidencePath: '.sdw/state/demo/run-fixture/task-task-1.evidence.json', sequence: 2
            },
            'task-2': {
              id: 'task-2', title: 'Docs', status: 'completed', acIds: ['AC2'], commitSha: deliveryCommit,
              filesChanged: ['README.md'],
              dispatchedAt: '2026-10-22T10:21:40.000Z', completedAt: '2026-10-22T10:31:40.000Z'
            }
          }
        },
        5: {
          name: 'scoring', status: 'completed', startedAt: '2026-10-22T10:31:40.000Z', completedAt: '2026-10-22T10:32:40.000Z',
          output: { score: 9, verdict: { verdicts: [{ id: 'AC1', status: 'verified' }, { id: 'AC2', status: 'verified' }, { id: 'AC3', status: 'failed' }] } }
        },
        6: { name: 'delivery_commit', status: 'completed', startedAt: '2026-10-22T10:32:40.000Z', completedAt: '2026-10-22T10:33:10.000Z' },
        7: {
          name: 'code_review', status: 'completed', startedAt: '2026-10-22T10:33:10.000Z', completedAt: '2026-10-22T10:35:10.000Z',
          artifact: '.sdw/state/demo/run-fixture/demo-step-7.md',
          output: { passed: true, errorCount: 0, warningCount: 1, suggestionCount: 2, blockingCount: 0, findings: [{ severity: 'warning' }] }
        },
        8: { name: 'pr_preparation', status: 'completed', startedAt: '2026-10-22T10:35:10.000Z', completedAt: '2026-10-22T10:36:10.000Z' }
      },
      errors: [{ step: 4, timestamp: '2026-10-22T10:05:00.000Z', error: 'Artifact persistence warning: x', warning: true }],
      securityGate: { bypassed: true, reason: '--skip-security' },
      worktreeSkipReason: 'single low-complexity task',
      branchReused: true,
      scm: { provider: 'none', skipped: true, skipReason: 'scmProvider is none' }
    };

    const markdown = deliveryReport.buildDeliveryReport({
      targetRoot: tmpDir,
      state,
      minScore: 8,
      now: '2026-10-22T11:00:00.000Z'
    });

    const sectionOrder = [
      '## Metadata', '## Tasks', '## Commits', '## Files Changed', '## Verification',
      '## Code Review', '## Breaking Changes', '## Quality', '## Spec Observations',
      '## Notes', '## Outcome'
    ];
    let cursor = -1;
    for (const section of sectionOrder) {
      const index = markdown.indexOf(section);
      assert.ok(index > cursor, `Report section ${section} appears in template order`);
      cursor = index;
    }

    assert.match(markdown, /\| Score \| 9\/10 \(scoreMin 8\) \|/, 'AC2: score is rendered against scoreMin');
    assert.match(markdown, /\| Base commit \| `[0-9a-f]+` \|/, 'AC2: base commit is rendered');
    assert.match(markdown, /\| Delivery commit \| `[0-9a-f]+` \|/, 'AC2: delivery commit is rendered');
    assert.match(markdown, /\| Ship status \| shipped \|/, 'AC2: ship status is rendered');
    assert.match(markdown, /\| Implementation start \| 2026-10-22T10:01:40.000Z \|/, 'AC2: implementation start comes from the first dispatch');
    assert.match(markdown, /\| Implementation end \| 2026-10-22T10:31:40.000Z \|/, 'AC2: implementation end comes from the last acceptance');
    assert.match(markdown, /\| Total wall-clock duration \| 30m \|/, 'AC2: total duration is rendered');
    assert.match(markdown, /\| Step 4: implementation \(completed\) \| 30m \|/, 'AC2: each step carries its duration');

    assert.match(markdown, /\| task-1 \| Core \| completed \| AC1 \| `[0-9a-f]+` \| 2026-10-22T10:01:40.000Z \| 2026-10-22T10:21:40.000Z \| 20m \|/, 'AC3: task rows carry id, title, status, ACs, checkpoint, start, end and duration');
    assert.match(markdown, /\| task-2 \| Docs \| completed \| AC2 \|/, 'AC3: every accepted task is listed');

    assert.match(markdown, /`[0-9a-f]+` \| feat: delivery \| base\.\.HEAD/, 'AC4: commits list SHA and subject');
    assert.match(markdown, /### task-1: Core/, 'AC5: files are grouped by task');
    assert.match(markdown, /### task-2: Docs/, 'AC5: each owning task gets its own group');
    assert.match(markdown, /\| `new-file\.txt` \| added \|/, 'AC5: added files are labelled');
    assert.match(markdown, /\| `README\.md` \| modified \|/, 'AC5: modified files are labelled');
    assert.match(markdown, /\| `skills\/sdw-demo\/scripts\/legacy\.cjs` \| deleted \|/, 'AC5: deleted files are labelled');

    assert.match(markdown, /build gate: status `passed`, exit code `0`/, 'AC6: build gate result is recorded');
    assert.match(markdown, /test gate: status `failed`, exit code `1`/, 'AC6: test gate result is recorded');
    assert.match(markdown, /Result: passed/, 'AC6: code review outcome is recorded');
    assert.match(markdown, /Findings: 0 error, 1 warning, 2 suggestion/, 'AC6: review finding counts are recorded');

    assert.match(markdown, /Configuration key\*\* `newKey` added with value true in `\.sdw\/config\.json`/, 'AC7: added configuration key is a candidate');
    assert.match(markdown, /Configuration key\*\* `scoreMin` changed from 8 to 9/, 'AC7: changed configuration key is a candidate');
    assert.match(markdown, /Configuration schema\*\* `properties\.scoreMin\.minimum` added/, 'AC7: schema property change is a candidate');
    assert.match(markdown, /CLI flag\*\* `--new-flag` added in `skills\/sdw-demo\/scripts\/demo\.cjs`/, 'AC7: CLI flag change is a candidate');
    assert.match(markdown, /File layout\*\* file deleted in `skills\/sdw-demo\/scripts\/legacy\.cjs`/, 'AC7: file layout change is a candidate');

    assert.match(markdown, /Judge verdicts: 2 verified, 1 failed \(3 judged\)/, 'AC8: per-criterion judge verdict counts are recorded');
    assert.match(markdown, /Review findings: 0 error, 1 warning, 2 suggestion/, 'AC8: review counts by severity are recorded');
    assert.match(markdown, /Executed tests: 2 recorded across 1 accepted task\(s\) \(1 passed, 1 failed, 0 skipped\)/, 'AC8: executed test totals are recorded');

    assert.match(markdown, /\| overlap \| demo-old \| shares demo\.md \| high \|/, 'AC10: observations carry kind, other spec, evidence and severity');

    assert.match(markdown, /Warning \(step 4, 2026-10-22T10:05:00\.000Z\): Artifact persistence warning: x/, 'AC9: warnings are recorded');
    assert.match(markdown, /Step 1 \(derivation\) skipped/, 'AC9: skipped steps are recorded');
    assert.match(markdown, /Task task-1 abandoned at 2026-10-22T10:05:00\.000Z: lost worker/, 'AC9: abandoned tasks are recorded');
    assert.match(markdown, /Task task-1 accepted after re-dispatch \(sequence 2\)/, 'AC9: re-dispatched tasks are recorded');
    assert.match(markdown, /Security gate bypassed: --skip-security/, 'AC9: security gate bypasses are recorded');
    assert.match(markdown, /Environment: .*branch reused.*worktrees skipped: single low-complexity task/, 'AC9: environment facts are recorded');

    const unchanged = deliveryReport.buildDeliveryReport({
      targetRoot: tmpDir,
      state: { ...state, baseCommit: deliveryCommit },
      minScore: 8,
      now: '2026-10-22T11:00:00.000Z'
    });
    assert.match(unchanged, /## Breaking Changes\n\nNone detected\./, 'AC7: no candidates renders None detected');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Spec 00054 test fixtures: a git workspace whose only contract is the report.
function setupDeliveryReportRepo(slug) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-delivery-report-run-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });
  fs.mkdirSync(path.join(tmpDir, '.sdw', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# delivery fixture\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.json'), JSON.stringify({
    scoreMin: 8,
    scmProvider: 'none',
    useFeatureBranches: false,
    useWorktrees: false,
    pushDelivery: false
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(tmpDir, '.sdw', 'specs', `${slug}.md`), `---
slug: ${slug}
title: Delivery Fixture
---
# Delivery Fixture
## Acceptance Criteria
- AC1: The orchestrator shall write the delivery report beside the specification.
`, 'utf8');
  execSync('git add -A && git commit -m "baseline"', { cwd: tmpDir, stdio: 'ignore' });
  return tmpDir;
}

function deliveryImplementation() {
  return {
    mode: 'command',
    command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'README.md\'], tests: [{ name: \'fixture test\', status: \'passed\' }], summary: \'delivery fixture done\' })); fs.appendFileSync(\'README.md\', \'\\n# delivery update\');"'
  };
}

function validDryRunSpec(slug, body) {
  return `---
id: null
slug: ${slug}
title: "Dry Observation"
source: local
status: draft
specDate: 2026-10-22
---

# Specification - Dry Observation

## Description

${body}

## Acceptance Criteria

- AC1: The system shall record the observation.

## Out of Scope

| Feature | Feature reason |
|---|---|
| None | None |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| None | None | None | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Ready | Valid | node validate |

## Validation & Observation Notes

### Negative & Failing Test Scenarios

- Scenario 1: An invalid input fails.
`;
}

test('00054 AC11-AC14: observations name overlaps, supersessions, and config conflicts without blocking', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-spec-observations-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.json'), JSON.stringify({ scoreMin: 8 }, null, 2), 'utf8');
    fs.writeFileSync(path.join(specsDir, 'index.specs.md'), [
      '# Specification Index',
      '',
      '| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |',
      '|---|---|---|---|---|---|---|---|',
      '| 00010 | 00010-delivered | Delivered | completed | local | 2026-10-20 | PASS | - |',
      '| 00060 | 00060-newer | Newer | pending | local | 2026-10-22 | PASS | - |',
      '| 00070 | 00070-conflict | Conflict | pending | local | 2026-10-22 | PASS | - |',
      ''
    ].join('\n'), 'utf8');
    const targetPath = path.join(specsDir, '00054-target.md');
    fs.writeFileSync(targetPath, `---
id: 54
slug: 00054-target
status: draft
---
# Target
Touches \`skills/sdw-orch/scripts/sdw_orch.cjs\` and declares scoreMin: 9.
`, 'utf8');
    fs.writeFileSync(path.join(specsDir, '00010-delivered.md'), `---
slug: 00010-delivered
status: completed
---
# Delivered
Also touches \`skills/sdw-orch/scripts/sdw_orch.cjs\`.
`, 'utf8');
    fs.writeFileSync(path.join(specsDir, '00060-newer.md'), `---
slug: 00060-newer
status: pending
---
# Newer
This specification supersedes \`00054-target\`.
`, 'utf8');
    fs.writeFileSync(path.join(specsDir, '00070-conflict.md'), `---
slug: 00070-conflict
status: pending
---
# Conflict
It fixes scoreMin: 7.
`, 'utf8');

    const observations = specGrilling.analyzeSpecObservations({ targetRoot: tmpDir, specPath: targetPath });
    for (const item of observations) {
      assert.ok(['overlap', 'superseded', 'conflict'].includes(item.kind), 'AC14: kind is one of the documented kinds');
      assert.ok(item.otherSpec, 'AC14: every observation names the other specification');
      assert.ok(item.evidence, 'AC14: every observation carries evidence');
      assert.ok(item.severity, 'AC14: every observation carries severity');
    }

    const overlap = observations.find((item) => item.kind === 'overlap' && item.otherSpec === '00010-delivered');
    assert.ok(overlap, 'AC11: a delivered specification sharing a target file is an overlap');
    assert.match(overlap.evidence, /00054-target/);
    assert.match(overlap.evidence, /00010-delivered/);
    assert.match(overlap.evidence, /skills\/sdw-orch\/scripts\/sdw_orch\.cjs/);
    assert.equal(overlap.severity, 'high', 'AC11: a delivered overlapping specification is high severity');

    const superseded = observations.find((item) => item.kind === 'superseded' && item.otherSpec === '00060-newer');
    assert.ok(superseded, 'AC12: a supersession reference to the target slug is recorded');
    assert.match(superseded.evidence, /00054-target/, 'AC12: the matched reference is named');

    const conflict = observations.find((item) => item.kind === 'conflict' && item.otherSpec === '00070-conflict');
    assert.ok(conflict, 'AC13: two specifications declaring the same key differently is a conflict');
    assert.match(conflict.evidence, /scoreMin/);
    assert.match(conflict.evidence, /9/);
    assert.match(conflict.evidence, /7/);

    // AC14: the analysis degrades to no observations instead of failing the run.
    assert.deepEqual(
      specGrilling.analyzeSpecObservations({ targetRoot: path.join(tmpDir, 'missing'), specPath: targetPath }),
      [],
      'AC14: an unreadable specification directory yields no observations and no error'
    );

    const noFilesPath = path.join(specsDir, '00054-nofiles.md');
    fs.writeFileSync(noFilesPath, `---
slug: 00054-nofiles
---
# No Files
No target paths are named here.
`, 'utf8');
    const noFileObservations = specGrilling.analyzeSpecObservations({ targetRoot: tmpDir, specPath: noFilesPath });
    assert.ok(!noFileObservations.some((item) => item.kind === 'overlap'), 'AC11: no target files means no overlap');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('00054 AC18: --dry-run prints the observations and writes no report or artifact', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-observations-dry-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'config.json'), JSON.stringify({
      scoreMin: 8, scmProvider: 'none', useFeatureBranches: false, useWorktrees: false, pushDelivery: false
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(specsDir, 'index.specs.md'), [
      '# Specification Index',
      '',
      '| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |',
      '|---|---|---|---|---|---|---|---|',
      '| 00010 | 00010-delivered | Delivered | completed | local | 2026-10-20 | PASS | - |',
      ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(
      path.join(specsDir, '00054-dry.md'),
      validDryRunSpec('00054-dry', 'Names `skills/sdw-orch/scripts/sdw_orch.cjs` as a target.')
    );
    fs.writeFileSync(path.join(specsDir, '00010-delivered.md'), `---
slug: 00010-delivered
status: completed
---
# Delivered
Names \`skills/sdw-orch/scripts/sdw_orch.cjs\`.
`, 'utf8');

    let output = '';
    const origLog = console.log;
    console.log = (msg) => { output += String(msg) + '\n'; };
    let code;
    try {
      code = sdwOrch.cmdRun({ root: tmpDir, specPath: '.sdw/specs/00054-dry.md', dryRun: true });
    } finally {
      console.log = origLog;
    }

    assert.equal(code, 0, 'AC18: a valid specification plans cleanly');
    assert.match(output, /Spec observation \(overlap, high\)/, 'AC18: observations are printed');
    assert.match(output, /No steps executed \(--dry-run\)/);
    assert.ok(!fs.existsSync(path.join(specsDir, '00054-dry-report.md')), 'AC18: no report is written');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.sdw', 'state')), 'AC18: no run state or Step 2 artifact is written');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('00054 AC16: an unwritable report path records a warning and delivery still succeeds', () => {
  const slug = 'delivery';
  const tmpDir = setupDeliveryReportRepo(slug);
  try {
    const reportPath = path.join(tmpDir, '.sdw', 'specs', `${slug}-report.md`);
    fs.mkdirSync(reportPath);

    const runId = `run-${Date.now()}-${slug}`;
    const origWarn = console.warn;
    console.warn = () => {};
    let code;
    try {
      code = sdwOrch.cmdRun({
        root: tmpDir,
        specPath: `.sdw/specs/${slug}.md`,
        runId,
        minScore: 8,
        skipReview: true,
        skipPr: true,
        implementation: deliveryImplementation(),
        scoring: judgeScoring()
      });
    } finally {
      console.warn = origWarn;
    }

    assert.equal(code, 0, 'AC16: a report failure never fails the delivery');
    const state = stateManager.loadRunState(tmpDir, runId);
    assert.equal(state.status, 'completed', 'AC16: the run completes');
    assert.ok(
      state.errors.some((entry) => entry.warning === true && /Delivery report warning/.test(entry.error)),
      'AC16: the warning is recorded in run state'
    );
    assert.ok(fs.statSync(reportPath).isDirectory(), 'AC16: the report path stayed unwritable');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('00054 AC17: a resumed run rewrites the report from current state instead of appending', () => {
  const slug = 'delivery';
  const tmpDir = setupDeliveryReportRepo(slug);
  try {
    const runId = `run-${Date.now()}-${slug}`;
    const code = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: `.sdw/specs/${slug}.md`,
      runId,
      minScore: 8,
      skipReview: true,
      skipPr: true,
      implementation: deliveryImplementation(),
      scoring: judgeScoring()
    });
    assert.equal(code, 0);

    const reportPath = path.join(tmpDir, '.sdw', 'specs', `${slug}-report.md`);
    assert.ok(fs.existsSync(reportPath), 'the first run wrote the report');
    fs.appendFileSync(reportPath, '\nSTALE APPENDIX\n', 'utf8');

    const state = stateManager.loadRunState(tmpDir, runId);
    state.score = 6;
    stateManager.saveRunState(tmpDir, state);

    const resumeCode = sdwOrch.cmdResume({ root: tmpDir, runId, skipReview: true, skipPr: true });
    assert.equal(resumeCode, 0, 'AC17: a resumed run regenerates the report and completes');

    const markdown = fs.readFileSync(reportPath, 'utf8');
    assert.ok(!markdown.includes('STALE APPENDIX'), 'AC17: the previous content is replaced, not appended');
    assert.match(markdown, /\| Score \| 6\/10 \(scoreMin 8\) \|/, 'AC17: the report reflects current run state');
    assert.equal((markdown.match(/# Delivery Report — /g) || []).length, 1, 'AC17: exactly one report is written');
    assert.equal(
      stateManager.loadRunState(tmpDir, runId).deliveryReport,
      '.sdw/specs/delivery-report.md',
      'AC17: the regenerated report keeps the same recorded path'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


