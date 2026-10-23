'use strict';

// Spec 00030 AC14-AC25: cap refusal plus split proposal, file disjointness,
// execMode/levels/parallelizable flags, one-task-at-a-time dispatch, run-state
// recording, pure dag preview, AC-fenced dispatch prompts and task finish
// evidence, status queue depth, and the skill documentation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const dagPlanner = require('../skills/sdw-orch/scripts/dag_planner.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

const TARGET_FILES = [
  'skills/demo/a.cjs',
  'skills/demo/b.cjs',
  'skills/demo/c.cjs',
  'skills/demo/d.cjs',
  'skills/demo/e.cjs',
  'skills/demo/f.cjs'
];

// An agent-ready fixture (frontmatter, EARS criteria, DoR) so Step 1 never
// rewrites the criteria; the surfaces section feeds the Step 2 blueprint.
function buildSpec(slug, acCount, options = {}) {
  const criteria = Array.from({ length: acCount }, (_, index) =>
    `- AC${index + 1}: The system shall satisfy criterion ${index + 1}.`);
  return [
    '---',
    `slug: ${slug}`,
    `title: "${slug}"`,
    '---',
    '# Specification',
    '## Description',
    options.description || 'Exercises the complexity classifier and the DAG planner.',
    '## Acceptance Criteria',
    ...criteria,
    '## Implementation Surfaces',
    ...TARGET_FILES.map(file => `- \`${file}\``),
    '## Definition of Ready (DoR)',
    '| Readiness Item | Requirement | Verification Method |',
    '|---|---|---|',
    '| Specification | Agent-ready | Inspection |'
  ].join('\n');
}

function makeRepo(slug, acCount, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-dag-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, `${slug}.md`), buildSpec(slug, acCount, options), 'utf8');
  if (options.git !== false) {
    execSync('git init -q', { cwd: root, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
    execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'app.cjs'), '// baseline\n');
    execSync('git add .sdw app.cjs', { cwd: root, stdio: 'ignore' });
    execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });
  }
  return root;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
}

// Dispatches the first DAG task (Step 4 pause) and returns the loaded run state.
function pauseAtDispatch(root, slug) {
  const code = sdwOrch.cmdRun({
    root,
    specPath: `.sdw/specs/${slug}.md`,
    skipReview: true,
    skipPr: true
  });
  assert.equal(code, 4, 'Step 4 dispatches one task and pauses');
  return stateManager.findLatestRunState(root);
}

function writeEvidence(root, taskId, acIds, fileName) {
  fs.appendFileSync(path.join(root, 'app.cjs'), `// ${taskId} work ${fileName}\n`);
  const evidencePath = path.join(root, fileName);
  fs.writeFileSync(evidencePath, JSON.stringify({
    taskId,
    status: 'success',
    acIds,
    filesChanged: ['app.cjs'],
    tests: [],
    summary: `${taskId} work`
  }, null, 2), 'utf8');
  return evidencePath;
}

test('AC25: the classifier covers low, standard, and complex tiers with the touchpoint escalation', () => {
  const lowSpec = buildSpec('low-demo', 3);
  assert.equal(dagPlanner.analyzeComplexity(lowSpec, { targetFiles: TARGET_FILES }).level, 'low');
  assert.equal(dagPlanner.generateDagPlan(lowSpec, { slug: 'low-demo', targetFiles: TARGET_FILES }).taskCount, 1,
    'AC7: low complexity emits exactly one task');

  const standardSpec = buildSpec('standard-demo', 7);
  assert.equal(dagPlanner.analyzeComplexity(standardSpec, { targetFiles: TARGET_FILES }).level, 'standard');
  const standardPlan = dagPlanner.generateDagPlan(standardSpec, { slug: 'standard-demo', targetFiles: TARGET_FILES });
  assert.equal(standardPlan.taskCount, 2, 'AC8: standard complexity keeps the two-task split');
  assert.deepEqual(standardPlan.tasks.map(task => task.coveredAcs.length), [4, 3],
    'AC10: criteria split in declaration order with at most four per task');

  const complexSpec = buildSpec('complex-demo', 11);
  assert.equal(dagPlanner.analyzeComplexity(complexSpec, { targetFiles: TARGET_FILES }).level, 'complex');
  const complexPlan = dagPlanner.generateDagPlan(complexSpec, { slug: 'complex-demo', targetFiles: TARGET_FILES });
  assert.equal(complexPlan.taskCount, 3, 'AC9: complex complexity emits three to five tasks');
  assert.deepEqual(complexPlan.tasks.map(task => task.targetFiles.length), [2, 2, 2],
    'AC11: target files slice in blueprint order with at most three per task');

  const escalatedSpec = buildSpec('escalated-demo', 7, {
    description: 'Exercises the CLI, the run state, and the git workflow.'
  });
  assert.equal(dagPlanner.analyzeComplexity(escalatedSpec, { targetFiles: TARGET_FILES }).level, 'complex',
    'AC6: three touchpoints at seven criteria escalate to complex');
});

test('AC14: a refused plan emits a two-spec split proposal and writes no plan', () => {
  const root = makeRepo('overflow-demo', 24);
  try {
    const spec = buildSpec('overflow-demo', 24);

    // Planner contract: the proposal partitions criteria and blueprint files.
    const refusedPlan = dagPlanner.generateDagPlan(spec, { slug: 'overflow-demo', targetFiles: TARGET_FILES });
    assert.equal(refusedPlan.refused, true);
    assert.equal(refusedPlan.tasksNeeded, 6, '24 criteria need six tasks of four');
    assert.equal(refusedPlan.cap, 5);
    assert.equal(refusedPlan.tasks.length, 0, 'a refused plan carries no tasks');
    assert.equal(refusedPlan.taskCount, 0);
    assert.deepEqual(refusedPlan.splitProposal.map(proposal => proposal.slug),
      ['overflow-demo-a', 'overflow-demo-b'], 'the proposal names two focused specifications');
    assert.deepEqual(refusedPlan.splitProposal.map(proposal => [proposal.acIds[0], proposal.acIds[proposal.acIds.length - 1]]),
      [['AC1', 'AC12'], ['AC13', 'AC24']], 'the criteria partition follows declaration order');
    assert.deepEqual(refusedPlan.splitProposal.flatMap(proposal => proposal.targetFiles), TARGET_FILES,
      'the file partitions cover the blueprint exactly once');

    // Preview shows the same proposal without side effects and exits non-zero.
    const preview = runCli(root, ['dag', 'preview', '--spec', '.sdw/specs/overflow-demo.md']);
    assert.equal(preview.status, 1, 'the refusal exit code is non-zero');
    assert.match(preview.stderr, /split-required tasks-needed=6 cap=5/);
    assert.match(preview.stdout, /overflow-demo-a/);
    assert.match(preview.stdout, /overflow-demo-b/);
    assert.equal(fs.existsSync(path.join(root, '.sdw', 'state')), false, 'preview writes no run state');

    // Run path: Step 3 fails closed, no plan artifact, no DAG tasks.
    const runCode = sdwOrch.cmdRun({
      root,
      specPath: '.sdw/specs/overflow-demo.md',
      skipReview: true,
      skipPr: true
    });
    assert.equal(runCode, 1, 'the run refuses with a non-zero exit');
    const state = stateManager.findLatestRunState(root);
    assert.equal(state.steps[3].status, 'failed');
    assert.match(String(state.steps[3].error || ''), /split-required tasks-needed=6 cap=5/);
    assert.equal(state.steps[3].output.splitProposal.length, 2, 'the refusal records the split proposal');
    assert.deepEqual(state.dagTasks, [], 'no DAG task is planned');
    assert.ok(!fs.existsSync(path.join(root, '.sdw', 'state', 'overflow-demo', state.runId, 'overflow-demo-step-3.md')),
      'no Step 3 artifact is written for a refused plan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC15 & AC16: the plan records pairwise disjointness, execMode, wave levels, and flags', () => {
  const plan = dagPlanner.generateDagPlan(buildSpec('complex-demo', 11), {
    slug: 'complex-demo',
    targetFiles: TARGET_FILES
  });

  assert.equal(plan.execMode, 'sequential', 'AC16: the plan records the sequential exec mode');
  assert.deepEqual(plan.levels, [['task-1'], ['task-2'], ['task-3']], 'AC16: one wave level per chained task');
  assert.deepEqual(plan.tasks.map(task => task.level), [0, 1, 2], 'AC16: each task records its wave level');
  assert.deepEqual(plan.tasks.map(task => task.parallelizable), [false, false, false],
    'AC17: a chained wave has no parallelizable sibling');
  assert.deepEqual(plan.tasks.map(task => task.dependencies), [[], ['task-1'], ['task-2']],
    'AC18: dependencies are recorded per task');

  assert.equal(plan.fileDisjointness.length, 3, 'AC15: every task pair is analyzed');
  for (const entry of plan.fileDisjointness) {
    assert.ok(Array.isArray(entry.pair) && entry.pair.length === 2, 'AC15: each record names its task pair');
    assert.equal(entry.disjoint, true, 'AC15: the planner slices disjoint file sets');
    assert.deepEqual(entry.sharedFiles, []);
  }
  assert.deepEqual(plan.fileDisjointness.map(entry => entry.pair),
    [['task-1', 'task-2'], ['task-1', 'task-3'], ['task-2', 'task-3']],
    'AC15: all unordered pairs are covered once');
});

test('AC17: parallelizable tasks never break the one-task-at-a-time dispatch', () => {
  const root = makeRepo('parallel-demo', 4);
  try {
    const state = stateManager.createRunState({
      root,
      specPath: '.sdw/specs/parallel-demo.md',
      slug: 'parallel-demo'
    });
    const tasks = [
      {
        id: 'task-1', title: 'Parallel A', coveredAcs: ['AC1', 'AC2'], dependencies: [],
        targetFiles: ['skills/demo/a.cjs'], level: 0, parallelizable: true
      },
      {
        id: 'task-2', title: 'Parallel B', coveredAcs: ['AC3', 'AC4'], dependencies: [],
        targetFiles: ['skills/demo/b.cjs'], level: 0, parallelizable: true
      }
    ];
    const plan = {
      complexity: { level: 'complex', acCount: 4, touchpoints: [], targetFileCount: 2 },
      taskCount: 2,
      execMode: 'sequential',
      levels: [['task-1', 'task-2']],
      fileDisjointness: [{ pair: ['task-1', 'task-2'], disjoint: true, sharedFiles: [] }],
      tasks
    };
    stateManager.updateStepState(root, state.runId, 3, 'completed', plan);
    const loadedState = stateManager.loadRunState(root, state.runId);
    loadedState.dagTasks = tasks;
    loadedState.steps[4].status = 'in_progress';
    stateManager.saveRunState(root, loadedState);

    assert.equal(sdwOrch.cmdTaskNext({ root, runId: state.runId }), 0, 'the first task dispatches');
    const afterFirst = stateManager.loadRunState(root, state.runId);
    assert.equal(afterFirst.steps[4].dispatch.activeTaskId, 'task-1');
    assert.equal(afterFirst.steps[4].dispatch.sequence, 1);
    assert.equal(afterFirst.steps[4].tasks['task-2'], undefined, 'the parallelizable sibling is not dispatched');

    assert.equal(sdwOrch.cmdTaskNext({ root, runId: state.runId }), 1, 'a concurrent dispatch is refused');
    const afterSecond = stateManager.loadRunState(root, state.runId);
    assert.equal(afterSecond.steps[4].dispatch.sequence, 1, 'the sequence does not advance');
    assert.equal(afterSecond.steps[4].dispatch.activeTaskId, 'task-1', 'exactly one task stays in flight');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC18: run state records complexity, task count, dependencies, and execMode', () => {
  const root = makeRepo('state-demo', 11);
  try {
    const state = pauseAtDispatch(root, 'state-demo');
    const recorded = state.steps[3].output;

    assert.equal(recorded.complexity.level, 'complex', 'complexity is recorded');
    assert.equal(recorded.taskCount, 3, 'the task count is recorded');
    assert.equal(recorded.execMode, 'sequential', 'execMode is recorded');
    assert.deepEqual(recorded.levels, [['task-1'], ['task-2'], ['task-3']], 'wave levels are recorded');
    assert.deepEqual(recorded.tasks[1].dependencies, ['task-1'], 'per-task dependencies are recorded');
    assert.equal(state.dagTasks.length, 3, 'the DAG tasks are recorded on the run state');
    assert.equal(state.steps[4].status, 'awaiting_implementation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC19: dag preview prints the plan and touches no state, artifact, branch, or registry row', () => {
  const root = makeRepo('preview-demo', 11);
  try {
    const indexPath = path.join(root, '.sdw', 'specs', 'index.specs.md');
    const indexContent = '| id | slug | status |\n|---|---|---|\n| 001 | preview-demo | pending |\n';
    fs.writeFileSync(indexPath, indexContent, 'utf8');
    execSync('git add .sdw', { cwd: root, stdio: 'ignore' });
    execSync('git commit -qm "registry"', { cwd: root, stdio: 'ignore' });
    const branchesBefore = execSync('git branch --list', { cwd: root, encoding: 'utf8' });
    const statusBefore = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' });

    const preview = runCli(root, ['dag', 'preview', '--spec', '.sdw/specs/preview-demo.md']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /complexity=complex acs=11 tasks=3 execMode=sequential/);
    assert.match(preview.stdout, /levels=\[\["task-1"\],\["task-2"\],\["task-3"\]\]/);
    assert.match(preview.stdout, /task-2 \| AC5,AC6,AC7,AC8 \| deps=task-1 \| level=1 \| files=skills\/demo\/c\.cjs,skills\/demo\/d\.cjs/);
    assert.match(preview.stdout, /fileDisjointness: task-1\/task-2=disjoint/);

    assert.equal(fs.existsSync(path.join(root, '.sdw', 'state')), false, 'no run state is written');
    assert.equal(fs.existsSync(path.join(root, '.sdw', 'sandbox')), false, 'no sandbox directory is created');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), indexContent, 'the registry row is untouched');
    assert.equal(execSync('git branch --list', { cwd: root, encoding: 'utf8' }), branchesBefore, 'no branch is created');
    assert.equal(execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }), statusBefore, 'the tree is untouched');

    // A missing specification fails closed and names the path.
    const missing = runCli(root, ['dag', 'preview', '--spec', '.sdw/specs/missing.md']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /\.sdw\/specs\/missing\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC20: dag preview --json emits identifiers, dependencies, and file lists', () => {
  const root = makeRepo('preview-json-demo', 11);
  try {
    const preview = runCli(root, ['dag', 'preview', '--json', '--spec', '.sdw/specs/preview-json-demo.md']);
    assert.equal(preview.status, 0, preview.stderr);
    const plan = JSON.parse(preview.stdout);

    assert.equal(plan.complexity, 'complex');
    assert.equal(plan.execMode, 'sequential');
    assert.equal(plan.taskCount, 3);
    assert.deepEqual(plan.levels, [['task-1'], ['task-2'], ['task-3']]);
    assert.deepEqual(plan.tasks.map(task => task.id), ['task-1', 'task-2', 'task-3']);
    assert.deepEqual(plan.tasks[1].acIds, ['AC5', 'AC6', 'AC7', 'AC8']);
    assert.deepEqual(plan.tasks[1].dependencies, ['task-1']);
    assert.deepEqual(plan.tasks[1].targetFiles, ['skills/demo/c.cjs', 'skills/demo/d.cjs']);
    assert.equal(plan.tasks[1].level, 1);
    assert.equal(plan.tasks[1].parallelizable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC21: the dispatch prompt is limited to the task assigned criteria', () => {
  const root = makeRepo('fence-demo', 7);
  try {
    const state = pauseAtDispatch(root, 'fence-demo');
    const firstTaskId = state.steps[4].dispatch.activeTaskId;
    const firstPrompt = fs.readFileSync(
      path.resolve(root, state.steps[4].tasks[firstTaskId].promptPath), 'utf8');

    for (const index of [1, 2, 3, 4]) {
      assert.ok(firstPrompt.includes(`- AC${index}: The system shall satisfy criterion ${index}.`),
        `AC21: the assigned criterion AC${index} is carried with its text`);
    }
    for (const index of [5, 6, 7]) {
      assert.ok(!firstPrompt.includes(`The system shall satisfy criterion ${index}`),
        `AC21: the text of unassigned criterion AC${index} is absent`);
      assert.ok(firstPrompt.includes(`- AC${index}\n`),
        `AC21: AC${index} is only named under the do-not-regress list`);
    }

    assert.equal(sdwOrch.cmdTaskFinish({
      root,
      runId: state.runId,
      taskId: firstTaskId,
      evidencePath: writeEvidence(root, firstTaskId, ['AC1'], 'task-1.evidence.json')
    }), 0, 'the first task is accepted');
    assert.equal(sdwOrch.cmdTaskNext({ root, runId: state.runId }), 0, 'the second task dispatches');

    const afterSecond = stateManager.loadRunState(root, state.runId);
    const secondTaskId = afterSecond.steps[4].dispatch.activeTaskId;
    const secondPrompt = fs.readFileSync(
      path.resolve(root, afterSecond.steps[4].tasks[secondTaskId].promptPath), 'utf8');
    for (const index of [5, 6, 7]) {
      assert.ok(secondPrompt.includes(`- AC${index}: The system shall satisfy criterion ${index}.`),
        `AC21: the second task carries AC${index}`);
    }
    assert.ok(!secondPrompt.includes('The system shall satisfy criterion 1.'), 'AC21: AC1 text is absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC22: task finish rejects acceptance evidence outside the assigned criteria', () => {
  const root = makeRepo('evidence-fence-demo', 7);
  try {
    const state = pauseAtDispatch(root, 'evidence-fence-demo');
    const taskId = state.steps[4].dispatch.activeTaskId;

    // AC5 belongs to task-2: the submission is rejected and the task stays dispatched.
    const outOfScope = writeEvidence(root, taskId, ['AC5'], 'out-of-scope.evidence.json');
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath: outOfScope }), 1);
    const rejected = stateManager.loadRunState(root, state.runId);
    assert.equal(rejected.steps[4].dispatch.activeTaskId, taskId, 'the task stays dispatched');
    assert.notEqual((rejected.steps[4].tasks[taskId] || {}).status, 'completed', 'the task is not accepted');
    assert.equal((rejected.steps[4].tasks['task-2'] || {}).status, undefined,
      'the other task is never completed by a rejected submission');

    // Its own criteria are accepted.
    const inScope = writeEvidence(root, taskId, ['AC1'], 'in-scope.evidence.json');
    assert.equal(sdwOrch.cmdTaskFinish({ root, runId: state.runId, taskId, evidencePath: inScope }), 0);
    const accepted = stateManager.loadRunState(root, state.runId);
    assert.equal(accepted.steps[4].tasks[taskId].status, 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC23: status reports the remaining queue depth while tasks are incomplete', () => {
  const root = makeRepo('queue-demo', 7);
  try {
    const state = pauseAtDispatch(root, 'queue-demo');
    const status = runCli(root, ['status', '--run-id', state.runId]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Queue: 2 remaining/, 'both tasks are still in the queue');

    assert.equal(sdwOrch.cmdTaskFinish({
      root,
      runId: state.runId,
      taskId: state.steps[4].dispatch.activeTaskId,
      evidencePath: writeEvidence(root, state.steps[4].dispatch.activeTaskId, ['AC1'], 'queue.evidence.json')
    }), 0);
    const afterOne = runCli(root, ['status', '--run-id', state.runId]);
    assert.match(afterOne.stdout, /Queue: 1 remaining/, 'the queue shrinks by the accepted task');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC24: the skill docs document the classifier thresholds and the cap behavior', () => {
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-orch', 'SKILL.md'), 'utf8');
  const protocol = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-orch', 'references', 'orchestrator_protocol.md'), 'utf8');

  assert.ok(skill.split(/\r?\n/).length <= 120, 'the Tier-1 skill definition stays within 120 lines');
  for (const token of ['<=4 low', '5-10 standard', '>10 complex', 'at most five tasks', 'split-required tasks-needed=N cap=5', 'split proposal']) {
    assert.ok(skill.includes(token), `SKILL.md documents "${token}"`);
  }
  assert.ok(skill.includes('dag preview'), 'SKILL.md documents the preview subcommand');

  for (const token of [
    'Four or fewer criteria are `low`',
    'five to ten are `standard`',
    'more than ten are `complex`',
    'three detected touchpoints with seven or more criteria escalate to `complex`',
    'split-required tasks-needed=N cap=5',
    '`parallelizable`',
    'dag preview [--json] [--spec <path>]'
  ]) {
    assert.ok(protocol.includes(token), `the protocol documents "${token}"`);
  }
});
