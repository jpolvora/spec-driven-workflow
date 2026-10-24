'use strict';

// Spec 00069 AC1-AC3: target-file resolution draws only from paths the
// specification names, verifies a bucket fallback against the repository, and
// accepts a declared new file that does not exist yet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const specGrilling = require('../skills/sdw-orch/scripts/spec_grilling.cjs');
const dagPlanner = require('../skills/sdw-orch/scripts/dag_planner.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');

// An agent-ready fixture (frontmatter, EARS criteria, DoR). Criteria name no
// project path unless a case supplies one, so coverage adds no noise.
function buildSpec(slug, options = {}) {
  const criteria = options.criteria || [
    '- AC1: The system shall record the widget target.',
    '- AC2: The system shall report the widget target.'
  ];
  return [
    '---',
    `slug: ${slug}`,
    `title: "${slug}"`,
    '---',
    '# Specification',
    '## Description',
    'Exercises target-file resolution.',
    '## Acceptance Criteria',
    ...criteria,
    ...(options.sections || []),
    '## Definition of Ready (DoR)',
    '| Readiness Item | Requirement | Verification Method |',
    '|---|---|---|',
    '| Ready | Valid | Check |'
  ].join('\n');
}

function makeRepo(slug, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-dag-targets-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, `${slug}.md`), content, 'utf8');
  return root;
}

function initGit(root) {
  execSync('git init -q', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'app.cjs'), '// baseline\n', 'utf8');
  execSync('git add -A', { cwd: root, stdio: 'ignore' });
  execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });
}

function preview(root, slug) {
  return spawnSync(
    process.execPath,
    [CLI, 'dag', 'preview', '--json', '--spec', `.sdw/specs/${slug}.md`],
    { cwd: root, encoding: 'utf8' }
  );
}

function taskFiles(plan) {
  return [...new Set((plan.tasks || []).flatMap(task => task.targetFiles || []))];
}

function quiet(run) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return run();
  } finally {
    console.warn = original;
  }
}

test('AC1: a pathless specification never synthesizes a target file from its slug', () => {
  const slug = 'custom-widget-demo';
  const content = buildSpec(slug);
  const fabricated = `skills/${slug}/scripts/${slug}.cjs`;

  const blueprint = specGrilling.generateRefinementBlueprint(content);
  assert.deepEqual(blueprint.targetFiles, [], 'the blueprint resolves no target file');
  assert.ok(!JSON.stringify(blueprint).includes(fabricated), 'no slug-shaped path is synthesized');
  assert.deepEqual(specGrilling.extractDeclaredNewFiles(content), []);

  const root = makeRepo(slug, content);
  try {
    const result = preview(root, slug);
    assert.ok(result.stdout.trim().length > 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.ok(!JSON.stringify(plan).includes(fabricated), 'the plan carries no synthesized path');
    assert.deepEqual(taskFiles(plan), [], 'planned tasks carry no invented target file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: a fallback bucket file missing from the repository refuses the plan with its path and rule', () => {
  const slug = '00071-sdw-config-preflight';
  const content = buildSpec(slug);
  const missingFile = 'skills/sdw-config/scripts/sdw_config.cjs';

  const root = makeRepo(slug, content);
  try {
    const planned = quiet(() => dagPlanner.generateDagPlan(content, { slug, targetRoot: root }));
    assert.equal(planned.refused, true, 'the plan is refused');
    assert.equal(planned.reason, 'missing-target-file');
    assert.equal(planned.fallbackRule, 'config', 'the refusal names the fallback rule');
    assert.deepEqual(planned.missingFiles, [missingFile], 'the refusal names the missing path');
    assert.deepEqual(planned.tasks, [], 'a refused plan carries no tasks');

    const result = preview(root, slug);
    assert.equal(result.status, 1, 'the refusal exits non-zero');
    assert.match(result.stderr, /missing-target-file rule=config/);
    assert.ok(result.stderr.includes(missingFile), 'the refusal prints the missing path');
    assert.match(result.stderr, /name the file in backticks/);

    const plan = JSON.parse(result.stdout);
    assert.equal(plan.refused, true);
    assert.equal(plan.reason, 'missing-target-file');
    assert.equal(plan.fallbackRule, 'config');
    assert.deepEqual(plan.missingTargetFiles, [missingFile]);
    assert.equal(fs.existsSync(path.join(root, '.sdw', 'state')), false, 'preview writes no run state');

    // Run path: Step 3 records the refusal and stops with a non-zero exit.
    initGit(root);
    const runCode = sdwOrch.cmdRun({
      root,
      specPath: `.sdw/specs/${slug}.md`,
      skipReview: true,
      skipPr: true
    });
    assert.equal(runCode, 1, 'the run refuses at Step 3');
    const state = stateManager.findLatestRunState(root);
    assert.equal(state.steps[3].status, 'failed');
    assert.match(String(state.steps[3].error || ''), /missing-target-file rule=config/);
    assert.ok(String(state.steps[3].error || '').includes(missingFile),
      'the recorded refusal names the missing path');
    assert.deepEqual(state.dagTasks || [], [], 'no DAG task is planned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Control: the same specification plans once the bucket file exists.
  const healthyRoot = makeRepo(slug, content);
  try {
    const bucketFile = path.join(healthyRoot, ...missingFile.split('/'));
    fs.mkdirSync(path.dirname(bucketFile), { recursive: true });
    fs.writeFileSync(bucketFile, "'use strict';\n", 'utf8');
    const result = preview(healthyRoot, slug);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(taskFiles(JSON.parse(result.stdout)), [missingFile],
      'the verified bucket file becomes the target');
  } finally {
    fs.rmSync(healthyRoot, { recursive: true, force: true });
  }
});

test('AC3: a declared new file under a New files note is planned without existing', () => {
  const slug = 'declared-new-file-demo';
  const declared = 'tests/widget_carrier.test.cjs';
  const content = buildSpec(slug, {
    sections: ['## New files', '', `- \`${declared}\` — created by this work.`]
  });

  assert.deepEqual(specGrilling.extractDeclaredNewFiles(content), [declared]);
  const blueprint = specGrilling.generateRefinementBlueprint(content);
  assert.deepEqual(blueprint.targetFiles, [declared]);
  assert.deepEqual(blueprint.declaredNewFiles, [declared]);

  const inline = buildSpec('inline-new-file-demo', {
    sections: ['- New files: `src/widget.cjs` and `src/widget_test.cjs`']
  });
  assert.deepEqual(specGrilling.extractDeclaredNewFiles(inline), ['src/widget.cjs', 'src/widget_test.cjs'],
    'an inline note declares multiple backticked files');

  const root = makeRepo(slug, content);
  try {
    assert.equal(fs.existsSync(path.join(root, ...declared.split('/'))), false,
      'the declared file does not exist yet');
    const result = preview(root, slug);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(taskFiles(JSON.parse(result.stdout)), [declared],
      'the declared new file is carried into the plan as a target file');
    assert.equal(fs.existsSync(path.join(root, ...declared.split('/'))), false,
      'planning never creates the declared file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
