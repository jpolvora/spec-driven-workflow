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
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

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

  // Evaluator handles evidence-based scoring (Spec 015)
  const reportWithEvidence = scoreEvaluator.evaluateScore(spec, {
    projectRoot: path.resolve(__dirname, '..'),
    minScore: 8,
    evidenceRecords: [
      {
        taskId: 'task-1',
        acIds: ['AC1', 'AC2'],
        filesChanged: ['skills/sdw-orch/scripts/state_manager.cjs'],
        summary: 'State manager implementation'
      }
    ]
  });

  assert.equal(typeof reportWithEvidence.score, 'number');
  assert.equal(reportWithEvidence.score, 10, 'Score is 10/10 with valid accepted evidence');
  assert.equal(reportWithEvidence.verifiedAcs.length, 2, 'All ACs verified with evidence');
  assert.equal(reportWithEvidence.passed, true);

  // Evaluator without evidence fails closed with score 0
  const reportWithoutEvidence = scoreEvaluator.evaluateScore(spec, {
    projectRoot: path.resolve(__dirname, '..'),
    minScore: 8
  });
  assert.equal(reportWithoutEvidence.score, 0, 'Score is 0 without evidence');
  assert.equal(reportWithoutEvidence.passed, false);
  assert.equal(reportWithoutEvidence.failingAcs.length, 2);
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
      }
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
      minScore: 0,
      skipReview: true,
      skipPr: false,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/push-feature.md\'], summary: \'push feature done\' }));"'
      }
    });

    assert.equal(exitCode, 0, 'Cleanly finishes run with --push flag without unhandled exceptions');
    const state = stateManager.findLatestRunState(tmpDir);
    assert.equal(state.status, 'completed', 'Run marked completed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC1, AC2, AC3 & AC11: Multi-Spec Batch Execution & Manifest Lifecycle', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-test-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });

    const specA = path.join(specsDir, '001-feature-a.md');
    fs.writeFileSync(specA, `---
slug: 001-feature-a
---
# Feature A
## Acceptance Criteria
- AC1: The system shall execute batch item A.
`);

    const specB = path.join(specsDir, '002-feature-b.md');
    fs.writeFileSync(specB, `---
slug: 002-feature-b
---
# Feature B
## Acceptance Criteria
- AC1: The system shall execute batch item B.
`);

    const exitCode = sdwOrch.cmdBatchRun({
      root: tmpDir,
      specPaths: [specA, specB],
      minScore: 0,
      skipReview: true,
      skipPr: true,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [process.env.SDW_SPEC_SLUG ? \'.sdw/specs/\' + process.env.SDW_SPEC_SLUG + \'.md\' : \'package.json\'], summary: \'batch done\' }));"'
      }
    });

    assert.equal(exitCode, 0, 'Batch execution must exit with code 0 on success (AC1)');

    const batchRunner = require('../skills/sdw-orch/scripts/batch_runner.cjs');
    const manifests = batchRunner.listBatchManifests(tmpDir);
    assert.equal(manifests.length, 1, 'Exactly one batch manifest must be created (AC2)');

    const manifest = manifests[0].manifest;
    assert.equal(manifest.total, 2, 'Batch total must be 2');
    assert.equal(manifest.status, 'completed', 'Batch status must be completed');
    assert.equal(manifest.queue.length, 2);
    assert.equal(manifest.queue[0].status, 'completed');
    assert.equal(manifest.queue[1].status, 'completed');

    // Context fencing: distinct run IDs and separate state files (AC3, AC11)
    assert.ok(manifest.queue[0].runId, 'First spec must have runId');
    assert.ok(manifest.queue[1].runId, 'Second spec must have runId');
    assert.notEqual(manifest.queue[0].runId, manifest.queue[1].runId, 'Each spec must have a unique isolated runId');

    const stateA = stateManager.loadRunState(tmpDir, manifest.queue[0].runId);
    const stateB = stateManager.loadRunState(tmpDir, manifest.queue[1].runId);
    assert.equal(stateA.specSlug, '001-feature-a');
    assert.equal(stateB.specSlug, '002-feature-b');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC5: Default Halt-on-Error Policy', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-halt-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });

    const spec1 = path.join(specsDir, '001-fail.md');
    fs.writeFileSync(spec1, `---
slug: 001-fail
---
# Fail Spec
## Acceptance Criteria
- AC1: The system shall fail in testing.
`);

    const spec2 = path.join(specsDir, '002-unreached.md');
    fs.writeFileSync(spec2, `---
slug: 002-unreached
---
# Unreached Spec
## Acceptance Criteria
- AC1: The system shall remain pending.
`);

    const exitCode = sdwOrch.cmdBatchRun({
      root: tmpDir,
      specPaths: [spec1, spec2],
      simulateFailure: true,
      continueOnError: false
    });

    assert.equal(exitCode, 1, 'Must exit with non-zero on failure when continue-on-error is false (AC5)');

    const batchRunner = require('../skills/sdw-orch/scripts/batch_runner.cjs');
    const manifest = batchRunner.loadBatchManifest(tmpDir);
    assert.equal(manifest.status, 'halted', 'Batch manifest status must be halted');
    assert.equal(manifest.queue[0].status, 'failed', 'Failing item marked failed');
    assert.equal(manifest.queue[1].status, 'pending', 'Subsequent items must remain pending');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC6: Continue-on-Error Policy (--continue-on-error)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-cont-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });

    const spec1 = path.join(specsDir, '001-fail.md');
    fs.writeFileSync(spec1, `---
slug: 001-fail
---
# Fail Spec
## Acceptance Criteria
- AC1: The system shall fail in testing.
`);

    const spec2 = path.join(specsDir, '002-fail-too.md');
    fs.writeFileSync(spec2, `---
slug: 002-fail-too
---
# Fail Spec Too
## Acceptance Criteria
- AC1: The system shall fail in testing too.
`);

    const exitCode = sdwOrch.cmdBatchRun({
      root: tmpDir,
      specPaths: [spec1, spec2],
      simulateFailure: true,
      continueOnError: true
    });

    assert.equal(exitCode, 1, 'Must return 1 when errors occurred across batch');

    const batchRunner = require('../skills/sdw-orch/scripts/batch_runner.cjs');
    const manifest = batchRunner.loadBatchManifest(tmpDir);
    assert.equal(manifest.status, 'completed_with_errors');
    assert.equal(manifest.queue[0].status, 'failed');
    assert.equal(manifest.queue[1].status, 'failed', 'Second item must have executed despite first failure (AC6)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC7: Batch Resumption via resume-batch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-res-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });

    const spec1 = path.join(specsDir, '001-done.md');
    fs.writeFileSync(spec1, `---
slug: 001-done
---
# Done Spec
## Acceptance Criteria
- AC1: The system shall finish.
`);

    const spec2 = path.join(specsDir, '002-todo.md');
    fs.writeFileSync(spec2, `---
slug: 002-todo
---
# Todo Spec
## Acceptance Criteria
- AC1: The system shall finish on resume.
`);

    const batchRunner = require('../skills/sdw-orch/scripts/batch_runner.cjs');
    // Simulate a partially completed batch
    const manifest = batchRunner.createBatchManifest({
      root: tmpDir,
      specs: [spec1, spec2],
      options: { continueOnError: false }
    });
    manifest.queue[0].status = 'completed';
    manifest.queue[0].durationMs = 1200;
    manifest.currentIndex = 1;
    manifest.status = 'halted';
    batchRunner.saveBatchManifest(tmpDir, manifest);

    const exitCode = sdwOrch.cmdResumeBatch({
      root: tmpDir,
      minScore: 0,
      skipReview: true,
      skipPr: true,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [process.env.SDW_SPEC_SLUG ? \'.sdw/specs/\' + process.env.SDW_SPEC_SLUG + \'.md\' : \'package.json\'], summary: \'batch resume done\' }));"'
      }
    });

    assert.equal(exitCode, 0, 'Resuming batch must succeed');
    const updated = batchRunner.loadBatchManifest(tmpDir, manifest.batchId);
    assert.equal(updated.status, 'completed', 'Batch must be completed after resume (AC7)');
    assert.equal(updated.queue[0].status, 'completed', 'First item remains completed');
    assert.equal(updated.queue[1].status, 'completed', 'Second item executed and completed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC8: Pre-flight Missing Specification Rejection', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-pre-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });

    const validSpec = path.join(specsDir, '001-valid.md');
    fs.writeFileSync(validSpec, `# Valid\n## Acceptance Criteria\n- AC1: The system shall exist.`);

    const exitCode = sdwOrch.cmdBatchRun({
      root: tmpDir,
      specPaths: [validSpec, 'non-existent-spec-missing.md']
    });

    assert.equal(exitCode, 1, 'Must exit with code 1 before executing anything (AC8)');

    const batchRunner = require('../skills/sdw-orch/scripts/batch_runner.cjs');
    const manifests = batchRunner.listBatchManifests(tmpDir);
    assert.equal(manifests.length, 0, 'No batch manifest may be created on pre-flight failure');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC9: Side-Effect-Free Dry-Run (--dry-run)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-dry-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });

    const spec1 = path.join(specsDir, '001-a.md');
    fs.writeFileSync(spec1, `# A\n## Acceptance Criteria\n- AC1: The system shall run.`);
    const spec2 = path.join(specsDir, '002-b.md');
    fs.writeFileSync(spec2, `# B\n## Acceptance Criteria\n- AC1: The system shall run.`);

    const exitCode = sdwOrch.cmdBatchRun({
      root: tmpDir,
      specPaths: [spec1, spec2],
      dryRun: true
    });

    assert.equal(exitCode, 0, 'Dry-run must exit with code 0 (AC9)');

    const batchRunner = require('../skills/sdw-orch/scripts/batch_runner.cjs');
    const manifests = batchRunner.listBatchManifests(tmpDir);
    assert.equal(manifests.length, 0, 'No batch manifest may be created during dry-run');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Multi-Spec Batch Unattended Execution: executes continuously without gate interruption', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-unattended-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });

    // Create 2 specifications with decision gaps
    const spec1 = path.join(specsDir, '001-feature-x.md');
    fs.writeFileSync(spec1, `---
slug: 001-feature-x
---
# Feature X
## Acceptance Criteria
- AC1: The system shall run unattended.`);

    const spec2 = path.join(specsDir, '002-feature-y.md');
    fs.writeFileSync(spec2, `---
slug: 002-feature-y
---
# Feature Y
## Acceptance Criteria
- AC1: The system shall complete the queue.`);

    const exitCode = sdwOrch.cmdBatchRun({
      root: tmpDir,
      specPaths: [spec1, spec2],
      abortOnGaps: true, // Should be overridden / bypassed in unattended mode
      minScore: 0,
      skipReview: true,
      skipPr: true,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [process.env.SDW_SPEC_SLUG ? \'.sdw/specs/\' + process.env.SDW_SPEC_SLUG + \'.md\' : \'package.json\'], summary: \'unattended done\' }));"'
      }
    });

    assert.equal(exitCode, 0, 'Unattended batch execution must complete successfully');

    const batchRunner = require('../skills/sdw-orch/scripts/batch_runner.cjs');
    const manifests = batchRunner.listBatchManifests(tmpDir);
    assert.equal(manifests.length, 1);
    const manifest = manifests[0].manifest;
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.policy.unattended, true, 'Manifest must reflect unattended policy');
    assert.equal(manifest.queue.length, 2);
    assert.equal(manifest.queue[0].status, 'completed');
    assert.equal(manifest.queue[1].status, 'completed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

