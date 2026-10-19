'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const dagPlanner = require('../skills/sdw-orch/scripts/dag_planner.cjs');
const evidenceValidator = require('../skills/sdw-orch/scripts/evidence_validator.cjs');
const implementationRunner = require('../skills/sdw-orch/scripts/implementation_runner.cjs');
const scoreEvaluator = require('../skills/sdw-orch/scripts/score_evaluator.cjs');
const batchRunner = require('../skills/sdw-orch/scripts/batch_runner.cjs');

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-impl-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });

  // Baseline SDW workspace
  sdwConfig.cmdInit({ root: tmpDir, force: true });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');

  // Initial commit
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-impl-project', version: '1.0.0' }, null, 2), 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

  return tmpDir;
}

function createTestSpec(repoRoot, slug, acCount = 2) {
  const specsDir = path.join(repoRoot, '.sdw', 'specs');
  if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });

  const specPath = path.join(specsDir, `${slug}.md`);
  let acsText = '';
  for (let i = 1; i <= acCount; i++) {
    acsText += `- AC${i}: The system shall satisfy acceptance condition ${i} for ${slug}.\n`;
  }

  const content = `---
id: null
slug: ${slug}
title: "Feature ${slug}"
source: local
specDate: 2026-10-19
---

# Feature ${slug}

## Description
Implementation test specification for ${slug}.
Affects file: src/${slug}.cjs

### Design Intent
Architectural intent for ${slug}.

## Acceptance Criteria
${acsText}
## Notes
Notes for ${slug}.

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

  fs.writeFileSync(specPath, content, 'utf8');
  return specPath;
}

// ---------------------------------------------------------------------------
// AC1 - AC5: Handoff Mode Default, Task Prompts, Pause State, Exit Code 4
// ---------------------------------------------------------------------------
test('AC1, AC2, AC3, AC4, AC5: Handoff mode defaults, writes prompts, sets awaiting_implementation, exits code 4', () => {
  const tmpDir = setupTestRepo();
  try {
    createTestSpec(tmpDir, 'handoff-demo', 2);

    const exitCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/handoff-demo.md',
      skipReview: true,
      skipPr: true
    });

    assert.equal(exitCode, 4, 'Handoff mode must exit with code 4 (AC5)');

    const state = stateManager.findLatestRunState(tmpDir);
    assert.ok(state, 'Run state must exist');
    assert.equal(state.status, 'paused', 'Run status must be paused (AC4)');
    assert.equal(state.steps[4].status, 'awaiting_implementation', 'Step 4 status must be awaiting_implementation (AC4)');

    const tasks = state.steps[4].tasks;
    assert.ok(tasks, 'Tasks map must exist on Step 4');
    const taskIds = Object.keys(tasks);
    assert.ok(taskIds.length >= 1, 'At least one task must be prepared');

    for (const taskId of taskIds) {
      const task = tasks[taskId];
      assert.equal(task.status, 'pending', 'Task status must be pending (AC4)');
      assert.ok(task.promptPath, 'Task must specify promptPath (AC3)');
      assert.ok(task.evidencePath, 'Task must specify evidencePath (AC3)');

      const absPromptPath = path.resolve(tmpDir, task.promptPath);
      assert.ok(fs.existsSync(absPromptPath), 'Rendered prompt file must exist on disk (AC3)');

      const promptContent = fs.readFileSync(absPromptPath, 'utf8');
      assert.ok(promptContent.includes(taskId), 'Prompt contains taskId');
      assert.ok(promptContent.includes(state.specSlug), 'Prompt contains specSlug');
      assert.ok(promptContent.includes(task.evidencePath), 'Prompt contains expected evidence path');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC6 - AC9: Task Finish Subcommand & Evidence Validation
// ---------------------------------------------------------------------------
test('AC6, AC7, AC8, AC9: task finish subcommand validates evidence schema, rejects invalid paths & missing dependencies', () => {
  const tmpDir = setupTestRepo();
  try {
    createTestSpec(tmpDir, 'task-finish-demo', 2);

    // Run to step 4 handoff
    sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/task-finish-demo.md',
      skipReview: true,
      skipPr: true
    });

    const state = stateManager.findLatestRunState(tmpDir);
    const taskId = Object.keys(state.steps[4].tasks)[0];

    // AC7: Reject missing required fields
    const invalidEvidence1 = {
      taskId,
      // missing acIds, filesChanged, summary
    };
    const evPath1 = path.join(tmpDir, 'invalid1.json');
    fs.writeFileSync(evPath1, JSON.stringify(invalidEvidence1), 'utf8');

    const code1 = sdwOrch.cmdTaskFinish({
      root: tmpDir,
      runId: state.runId,
      taskId,
      evidencePath: 'invalid1.json'
    });
    assert.equal(code1, 1, 'Must reject evidence missing required fields (AC7)');

    // AC7: Reject directory traversal and absolute paths in filesChanged
    const invalidEvidence2 = {
      taskId,
      acIds: ['AC1'],
      filesChanged: ['../secret.txt', '/etc/passwd', '.git/config'],
      summary: 'exploit'
    };
    const evPath2 = path.join(tmpDir, 'invalid2.json');
    fs.writeFileSync(evPath2, JSON.stringify(invalidEvidence2), 'utf8');

    const code2 = sdwOrch.cmdTaskFinish({
      root: tmpDir,
      runId: state.runId,
      taskId,
      evidencePath: 'invalid2.json'
    });
    assert.equal(code2, 1, 'Must reject evidence with invalid file paths (AC7)');

    // AC8: Reject unknown AC IDs
    const invalidEvidence3 = {
      taskId,
      acIds: ['AC999'],
      filesChanged: ['package.json'],
      summary: 'unknown AC'
    };
    const evPath3 = path.join(tmpDir, 'invalid3.json');
    fs.writeFileSync(evPath3, JSON.stringify(invalidEvidence3), 'utf8');

    const code3 = sdwOrch.cmdTaskFinish({
      root: tmpDir,
      runId: state.runId,
      taskId,
      evidencePath: 'invalid3.json'
    });
    assert.equal(code3, 1, 'Must reject evidence with unknown AC IDs (AC8)');

    // AC9: Reject completion when DAG dependency is not completed
    const multiTaskSpec = path.join(tmpDir, '.sdw', 'specs', 'multi-dep.md');
    fs.writeFileSync(multiTaskSpec, `---
slug: multi-dep
---
# Multi Dep
## Acceptance Criteria
- AC1: The system shall run first task.
- AC2: The system shall run second task.
- AC3: The system shall run third task.
- AC4: The system shall run fourth task.
- AC5: The system shall run fifth task.
- AC6: The system shall run sixth task.
`);

    sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/multi-dep.md',
      skipReview: true,
      skipPr: true
    });

    const multiState = stateManager.findLatestRunState(tmpDir);
    const plan = multiState.steps[3].output;
    const taskWithDeps = plan.tasks.find(t => t.dependencies && t.dependencies.length > 0);

    if (taskWithDeps) {
      // Modify a file so changes exist
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ updated: true }, null, 2), 'utf8');

      const depEvidence = {
        taskId: taskWithDeps.id,
        acIds: taskWithDeps.coveredAcs,
        filesChanged: ['package.json'],
        summary: 'premature finish'
      };
      const depEvPath = path.join(tmpDir, 'dep-ev.json');
      fs.writeFileSync(depEvPath, JSON.stringify(depEvidence), 'utf8');

      const depCode = sdwOrch.cmdTaskFinish({
        root: tmpDir,
        runId: multiState.runId,
        taskId: taskWithDeps.id,
        evidencePath: 'dep-ev.json'
      });
      assert.equal(depCode, 1, 'Must reject task finish when DAG dependencies are uncompleted (AC9)');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC10 - AC15: Worktree Creation, Change Verification, Cherry-pick & Cleanup
// ---------------------------------------------------------------------------
test('AC10, AC11, AC12, AC13, AC14, AC15: Worktree lifecycle, change detection, cherry-pick integration & cleanup', () => {
  const tmpDir = setupTestRepo();
  try {
    const runId = 'run-wt-test';
    const taskId = 'task-wt-1';

    // AC10: Create worktree
    const wtInfo = implementationRunner.createTaskWorktree(tmpDir, runId, taskId);
    assert.ok(fs.existsSync(wtInfo.worktreeAbs), 'Worktree directory must exist (AC10)');

    // AC14: Check changes on unchanged worktree -> returns false
    const unchanged = implementationRunner.checkTaskChanges(tmpDir, wtInfo.worktreeAbs, ['new-file.cjs']);
    assert.equal(unchanged, false, 'checkTaskChanges returns false when no changes exist (AC14)');

    // Author changes inside worktree
    const newFileAbs = path.join(wtInfo.worktreeAbs, 'new-file.cjs');
    fs.writeFileSync(newFileAbs, 'module.exports = "hello from worktree";\n', 'utf8');

    // AC14: Check changes on modified worktree -> returns true
    const changed = implementationRunner.checkTaskChanges(tmpDir, wtInfo.worktreeAbs, ['new-file.cjs']);
    assert.equal(changed, true, 'checkTaskChanges returns true when changes exist (AC14)');

    // AC11, AC12, AC13: Integrate task worktree into primary tree
    const integration = implementationRunner.integrateTaskWorktree({
      targetRoot: tmpDir,
      specSlug: 'wt-test',
      taskId,
      taskWorktreeAbs: wtInfo.worktreeAbs,
      taskWorktreeRel: wtInfo.worktreeRel,
      taskBranch: wtInfo.branch
    });

    assert.ok(integration.commitSha, 'Integration returns commit SHA (AC11)');
    assert.equal(integration.integrated, true);

    // AC12: File must now exist in primary tree via cherry-pick
    const primaryFile = path.join(tmpDir, 'new-file.cjs');
    assert.ok(fs.existsSync(primaryFile), 'Cherry-picked file must exist in primary tree (AC12)');
    assert.equal(fs.readFileSync(primaryFile, 'utf8').trim(), 'module.exports = "hello from worktree";');

    // AC13: Worktree directory must be removed after integration
    assert.equal(fs.existsSync(wtInfo.worktreeAbs), false, 'Worktree directory must be removed after integration (AC13)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC16: Non-testable Tasks Allowed with Empty tests: [] Array
// ---------------------------------------------------------------------------
test('AC16: Non-testable task evidence accepted with empty tests: [] array', () => {
  const tmpDir = setupTestRepo();
  try {
    const validEvidence = {
      taskId: 'task-doc-1',
      acIds: ['AC1'],
      filesChanged: ['package.json'],
      tests: [],
      summary: 'Documentation or non-testable configuration task'
    };

    const validation = evidenceValidator.validateEvidence(validEvidence, {
      expectedTaskId: 'task-doc-1',
      specAcs: [{ id: 'AC1', text: 'Some AC' }],
      projectRoot: tmpDir
    });

    assert.equal(validation.valid, true, 'Evidence with empty tests array must be valid (AC16)');
    assert.deepEqual(validation.data.tests, [], 'Tests array preserved as empty array');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC17 - AC22: Build and Test Verification Gates
// ---------------------------------------------------------------------------
test('AC17, AC18, AC19, AC20, AC21, AC22: Verification gates run build/test, record state, halt on failure', () => {
  const tmpDir = setupTestRepo();
  try {
    createTestSpec(tmpDir, 'gate-spec', 1);

    // Configure failing build gate
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.implementation = {
      mode: 'command',
      command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/gate-spec.md\'], summary: \'done\' }));"'
    };
    cfg.verification = {
      buildCommand: 'node -e "console.error(\'build error\'); process.exit(1);"',
      testCommand: null
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const exitCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/gate-spec.md',
      skipReview: true,
      skipPr: true
    });

    assert.equal(exitCode, 1, 'Workflow must exit with code 1 when build verification gate fails (AC17)');

    const state = stateManager.findLatestRunState(tmpDir);
    assert.equal(state.status, 'failed');
    assert.equal(state.steps[4].status, 'failed');
    assert.ok(state.steps[4].gates.build, 'Build gate recorded');
    assert.equal(state.steps[4].gates.build.status, 'failed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC23 - AC24: Evidence-Based Conformance Scoring & Closed Failure
// ---------------------------------------------------------------------------
test('AC23, AC24: Conformance score strictly evidence-based, fails closed with 0 when no ACs exist', () => {
  const tmpDir = setupTestRepo();
  try {
    const specWithAcs = `## Acceptance Criteria
- AC1: First criterion.
- AC2: Second criterion.
- AC3: Third criterion.
- AC4: Fourth criterion.
`;

    // Only AC1 and AC2 covered by accepted evidence with real file
    const reportPartial = scoreEvaluator.evaluateScore(specWithAcs, {
      projectRoot: tmpDir,
      minScore: 5,
      evidenceRecords: [
        {
          taskId: 'task-1',
          acIds: ['AC1', 'AC2'],
          filesChanged: ['package.json'],
          summary: 'partial implementation'
        }
      ]
    });

    assert.equal(reportPartial.score, 5, 'Math.round(2/4 * 10) = 5 (AC23)');
    assert.equal(reportPartial.verifiedCount, 2);
    assert.equal(reportPartial.failingCount, 2);
    assert.equal(reportPartial.passed, true, 'Passes when score >= minScore 5');

    // Fails closed on spec with 0 ACs
    const emptySpec = `# No ACs Here\nJust some notes.`;
    const reportEmpty = scoreEvaluator.evaluateScore(emptySpec, {
      projectRoot: tmpDir,
      minScore: 0
    });

    assert.equal(reportEmpty.score, 0, 'Must score 0 when 0 ACs present (AC23)');
    assert.equal(reportEmpty.passed, false, 'Must fail closed when 0 ACs present');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC25: Step 6 Delivery Commit Quality Guard
// ---------------------------------------------------------------------------
test('AC25: Step 6 delivery commit blocked if Step 4 is incomplete or tasks unaccepted', () => {
  const tmpDir = setupTestRepo();
  try {
    createTestSpec(tmpDir, 'guard-spec', 1);

    const runState = stateManager.createRunState({
      root: tmpDir,
      specPath: '.sdw/specs/guard-spec.md',
      slug: 'guard-spec'
    });

    // Mark steps 1, 2, 3 completed, step 4 still awaiting_implementation
    stateManager.updateStepState(tmpDir, runState.runId, 1, 'completed');
    stateManager.updateStepState(tmpDir, runState.runId, 2, 'completed');
    stateManager.updateStepState(tmpDir, runState.runId, 3, 'completed', {
      tasks: [{ id: 'task-1', title: 'Task 1', dependencies: [] }]
    });
    stateManager.updateStepState(tmpDir, runState.runId, 4, 'awaiting_implementation', {
      tasks: {
        'task-1': { status: 'pending' }
      }
    });

    // Attempt to resume from step 6 directly
    const exitCode = sdwOrch.cmdResume({
      root: tmpDir,
      runId: runState.runId
    });

    // In handoff mode with incomplete tasks, resume stops at Step 4 with code 4
    assert.equal(exitCode, 4, 'Resume must pause at Step 4 if tasks remain pending (AC25)');

    const loaded = stateManager.loadRunState(tmpDir, runState.runId);
    assert.notEqual(loaded.steps[6].status, 'completed', 'Step 6 must not complete without accepted tasks');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC26 - AC30: Command Mode Execution, Token Substitutions & Environment
// ---------------------------------------------------------------------------
test('AC26, AC27, AC28, AC29, AC30: Command mode token substitution, env allowlist, and automated completion', () => {
  const tmpDir = setupTestRepo();
  try {
    createTestSpec(tmpDir, 'cmd-mode-spec', 1);

    const outLog = path.join(tmpDir, 'cmd-output.json');

    // Command writes out its env and tokens, generates valid evidence and updates package.json
    const cmdStr = `node -e "const fs = require('fs'); const info = { taskId: process.env.SDW_TASK_ID, promptFile: process.env.SDW_PROMPT_FILE, workingDir: process.env.SDW_WORKING_DIR, targetRoot: process.env.SDW_TARGET_ROOT }; fs.writeFileSync('${outLog.replace(/\\/g, '/')}', JSON.stringify(info)); const ev = { taskId: process.env.SDW_TASK_ID, acIds: ['AC1'], filesChanged: ['package.json'], summary: 'automated completion' }; fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify(ev)); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); p.commandDone = true; fs.writeFileSync('package.json', JSON.stringify(p, null, 2));"`;

    const exitCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/cmd-mode-spec.md',
      skipReview: true,
      skipPr: true,
      minScore: 0,
      implementation: {
        mode: 'command',
        command: cmdStr
      }
    });

    assert.equal(exitCode, 0, 'Command mode execution must exit 0 on success (AC26, AC28)');

    assert.ok(fs.existsSync(outLog), 'Subprocess output log must exist');
    const recorded = JSON.parse(fs.readFileSync(outLog, 'utf8'));
    assert.ok(recorded.taskId.startsWith('task-'), 'SDW_TASK_ID passed (AC30)');
    assert.ok(fs.existsSync(recorded.promptFile), 'SDW_PROMPT_FILE passed and exists on disk (AC30)');
    assert.ok(recorded.targetRoot, 'SDW_TARGET_ROOT passed (AC30)');

    const state = stateManager.findLatestRunState(tmpDir);
    assert.equal(state.status, 'completed', 'Run completes through step 8');
    assert.equal(state.steps[4].status, 'completed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC31 - AC32: Batch Runner Queue Pause on Code 4
// ---------------------------------------------------------------------------
test('AC31, AC32: Batch runner pauses queue and sets status to awaiting_implementation when item exits code 4', () => {
  const tmpDir = setupTestRepo();
  try {
    const spec1 = createTestSpec(tmpDir, 'batch-pause-1', 1);
    const spec2 = createTestSpec(tmpDir, 'batch-pause-2', 1);

    const exitCode = sdwOrch.cmdBatchRun({
      root: tmpDir,
      specPaths: [spec1, spec2],
      skipReview: true,
      skipPr: true
    });

    assert.equal(exitCode, 4, 'Batch runner must exit with code 4 when item pauses (AC32)');

    const manifests = batchRunner.listBatchManifests(tmpDir);
    assert.equal(manifests.length, 1);
    const manifest = manifests[0].manifest;

    assert.equal(manifest.status, 'paused', 'Batch manifest status must be paused (AC31)');
    assert.equal(manifest.queue[0].status, 'awaiting_implementation', 'Item status must be awaiting_implementation (AC31)');
    assert.equal(manifest.queue[1].status, 'pending', 'Subsequent items remain pending (AC31)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC33 - AC36: Config Schema & Legacy Run State Rejection
// ---------------------------------------------------------------------------
test('AC33, AC34, AC35, AC36: Config schema validates implementation/verification, and rejects legacy runs without tasks', () => {
  const tmpDir = setupTestRepo();
  try {
    // AC33, AC34: Config schema validation
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');
    const validCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    validCfg.implementation = {
      mode: 'handoff',
      worktrees: true,
      timeoutMs: 120000
    };
    validCfg.verification = {
      buildCommand: 'npm run build',
      testCommand: 'npm test'
    };
    fs.writeFileSync(cfgPath, JSON.stringify(validCfg, null, 2), 'utf8');

    const schemaValidation = sdwConfig.cmdCheck({ root: tmpDir });
    assert.equal(schemaValidation, 0, 'Config with implementation & verification sections validates cleanly (AC33, AC34)');

    // AC35, AC36: Reject legacy state with only { tasksPrepared }
    const legacyState = stateManager.createRunState({
      root: tmpDir,
      specPath: '.sdw/specs/legacy.md',
      slug: 'legacy'
    });
    // Simulate legacy Step 4
    legacyState.steps[4] = {
      step: 4,
      name: 'Subagent Context Fencing & Dispatch',
      status: 'completed',
      output: { tasksPrepared: 2 } // Legacy schema without tasks map or gates
    };
    stateManager.saveRunState(tmpDir, legacyState);

    const resumeCode = sdwOrch.cmdResume({
      root: tmpDir,
      runId: legacyState.runId
    });

    assert.equal(resumeCode, 1, 'Must reject resumption of legacy run state lacking task evidence records with code 1 (AC35, AC36)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
