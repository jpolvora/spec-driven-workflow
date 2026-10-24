'use strict';

// Spec 00069 AC1-AC6: target-file resolution draws only from paths the
// specification names, verifies a bucket fallback against the repository,
// accepts a declared new file that does not exist yet, refuses a managed
// specification that promises no file, and reports all of it in the preview.

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

// Spec 00069 AC4: the refusal guards a registered backlog specification, so the
// fixture needs a real registry row for the planner to treat it as managed.
function registerSpec(root, slug) {
  const indexPath = path.join(root, '.sdw', 'specs', 'index.specs.md');
  fs.writeFileSync(indexPath, [
    '# Specification Index',
    '',
    '| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |',
    '|---|---|---|---|---|---|---|---|',
    `| ${slug.slice(0, 5)} | ${slug} | ${slug} | pending | local | 2026-10-24 | PASS | - |`,
    ''
  ].join('\n'), 'utf8');
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

test('AC6: a specification with real backticked paths plans those files', () => {
  const slug = '00073-real-path-demo';
  const named = 'skills/demo/scripts/widget.cjs';
  const content = buildSpec(slug, {
    sections: ['## Implementation Surfaces', '', `- \`${named}\``]
  });
  const root = makeRepo(slug, content);
  try {
    fs.mkdirSync(path.join(root, ...named.split('/').slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(root, ...named.split('/')), "'use strict';\n", 'utf8');
    registerSpec(root, slug);

    const result = preview(root, slug);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(plan.targetFiles, [named], 'the resolved target file is reported');
    assert.deepEqual(taskFiles(plan), [named], 'the task slice carries the resolved file');
    assert.deepEqual(plan.declaredNewFiles, [], 'no file was declared new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC5: dag preview --json reports resolved target files and declared new files without state', () => {
  const slug = '00074-preview-report';
  const named = 'skills/demo/scripts/widget.cjs';
  const declared = 'tests/widget_carrier.test.cjs';
  const content = buildSpec(slug, {
    sections: [
      '## Implementation Surfaces',
      '',
      `- \`${named}\``,
      '',
      '## New files',
      '',
      `- \`${declared}\` — created by this work.`
    ]
  });
  const root = makeRepo(slug, content);
  try {
    fs.mkdirSync(path.join(root, ...named.split('/').slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(root, ...named.split('/')), "'use strict';\n", 'utf8');
    registerSpec(root, slug);
    const indexPath = path.join(root, '.sdw', 'specs', 'index.specs.md');
    const indexBefore = fs.readFileSync(indexPath, 'utf8');

    const result = preview(root, slug);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(plan.targetFiles, [named, declared], 'the preview reports every resolved target');
    assert.deepEqual(plan.declaredNewFiles, [declared], 'the preview reports the declared new file');
    assert.deepEqual(taskFiles(plan), [named, declared], 'the tasks carry the same targets');
    assert.equal(fs.existsSync(path.join(root, '.sdw', 'state')), false, 'preview writes no run state');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBefore, 'preview leaves the registry untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4, AC5 & AC6: a registered specification with no path and no declared new file is refused', () => {
  const slug = '00075-pathless-refusal';
  const content = buildSpec(slug);
  const root = makeRepo(slug, content);
  try {
    registerSpec(root, slug);

    const result = preview(root, slug);
    assert.equal(result.status, 1, 'the refusal exits non-zero');
    assert.match(result.stderr, /no-target-files/);
    assert.ok(result.stderr.includes(`spec=${slug}`), 'the refusal names the specification');
    assert.match(result.stderr, /New files/, 'the refusal names the declaration the author must add');

    const plan = JSON.parse(result.stdout);
    assert.equal(plan.refused, true);
    assert.equal(plan.reason, 'no-target-files', 'the preview reports the refusal reason');
    assert.equal(plan.specSlug, slug, 'the preview reports the refused specification');
    assert.deepEqual(plan.targetFiles, [], 'no target file is resolved');
    assert.deepEqual(plan.declaredNewFiles, [], 'no new file is declared');
    assert.match(plan.declaration, /backticks/);
    assert.match(plan.declaration, /New files/);
    assert.equal(fs.existsSync(path.join(root, '.sdw', 'state')), false, 'preview writes no run state');

    // The run path records the same refusal at Step 3 and plans no task.
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
    assert.match(String(state.steps[3].error || ''), /no-target-files/);
    assert.ok(String(state.steps[3].error || '').includes(slug), 'the recorded refusal names the specification');
    assert.deepEqual(state.dagTasks || [], [], 'no DAG task is planned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4: an unregistered pathless specification keeps the spec 00064 no-file plan', () => {
  const slug = 'ad-hoc-widget-demo';
  const content = buildSpec(slug);
  const root = makeRepo(slug, content);
  try {
    const result = preview(root, slug);
    assert.equal(result.status, 0, 'an ad-hoc specification is not a managed backlog item');
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.refused, undefined, 'the plan is emitted, not refused');
    assert.deepEqual(plan.targetFiles, [], 'it still resolves no invented file');
    assert.deepEqual(taskFiles(plan), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
