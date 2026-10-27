'use strict';

// Spec 00069: target-file resolution draws only from paths the specification
// names plus the files it declares new. A known real-file bucket is accepted
// only when every file it names exists, and a specification that promises no
// file is refused instead of dispatching a slice that cannot touch anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const specGrilling = require('../skills/sdw-run/scripts/spec_grilling.cjs');
const dagPlanner = require('../skills/sdw-run/scripts/dag_planner.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

function buildSpec(slug, options = {}) {
  const criteria = options.criteria || [
    '- AC1: The system shall record the widget target.',
    '- AC2: The system shall report the widget target.'
  ];
  const body = options.body || '';
  return [
    '---',
    `slug: ${slug}`,
    `title: "${slug}"`,
    '---',
    '# Specification',
    '',
    '## Description',
    'Exercises target-file resolution.',
    '',
    '## Acceptance Criteria',
    ...criteria,
    '',
    body
  ].join('\n');
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-dag-'));
}

test('AC1: a pathless specification never synthesizes a target file from its slug', () => {
  const slug = '00999-widget-polish';
  const content = buildSpec(slug);

  const blueprint = specGrilling.generateRefinementBlueprint(content, { slug });
  assert.deepStrictEqual(blueprint.targetFiles, []);

  const plan = dagPlanner.generateDagPlan(content, { slug, blueprint, targetRoot: REPO_ROOT });
  assert.equal(plan.refused, undefined);
  assert.equal(plan.totalTasks, 1);
  assert.deepStrictEqual(plan.tasks[0].targetFiles, []);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, `skills/${slug}/scripts/${slug}.cjs`)), false);
});

test('AC2: a fallback bucket file missing from the repository refuses the plan with its path and rule', () => {
  const root = tempRoot();
  const content = buildSpec('00999-sdw-spec-widget-sync');

  const plan = dagPlanner.generateDagPlan(content, { targetRoot: root });
  assert.equal(plan.refused, true);
  assert.equal(plan.reason, 'missing-target-file');
  assert.equal(plan.fallbackRule, 'spec');
  assert.ok(plan.missingFiles.includes('skills/sdw-spec/scripts/sdw_spec.cjs'));
  assert.equal(plan.totalTasks, 0);
});

test('AC2 negative: a bucket whose files all exist plans those files', () => {
  const content = buildSpec('00999-sdw-router-widget');
  const plan = dagPlanner.generateDagPlan(content, { targetRoot: REPO_ROOT });

  assert.ok(!plan.refused);
  assert.ok(Array.isArray(plan.tasks[0].targetFiles));
  assert.ok(plan.tasks[0].targetFiles.includes('skills/sdw-router/SKILL.md'));
});

test('AC3: a declared new file under a New files note is planned without existing', () => {
  const declared = 'skills/widget/scripts/widget.cjs';
  const content = buildSpec('00999-widget-tool', {
    body: ['## New files', `- \`${declared}\``, ''].join('\n')
  });

  const blueprint = specGrilling.generateRefinementBlueprint(content, { slug: '00999-widget-tool' });
  assert.deepStrictEqual(blueprint.targetFiles, [declared]);

  const plan = dagPlanner.generateDagPlan(content, { slug: '00999-widget-tool', blueprint, targetRoot: REPO_ROOT });
  assert.ok(!plan.refused);
  assert.ok(plan.tasks[0].targetFiles.includes(declared));
  assert.equal(fs.existsSync(path.join(REPO_ROOT, declared)), false);
});

test('AC5: a specification with real backticked paths plans those files', () => {
  const named = 'skills/sdw-doctor/scripts/sdw_doctor.cjs';
  const content = buildSpec('00999-doctor-widget', {
    body: ['## Notes', `- Implementation surfaces: \`${named}\``, ''].join('\n')
  });

  const plan = dagPlanner.generateDagPlan(content, { slug: '00999-doctor-widget', targetRoot: REPO_ROOT });
  assert.ok(!plan.refused);
  assert.ok(plan.tasks[0].targetFiles.includes(named));
});

test('AC6: an empty blueprint with no named path and no declaration plans no file fence', () => {
  const content = buildSpec('00999-widget-plain');
  const plan = dagPlanner.generateDagPlan(content, {
    slug: '00999-widget-plain',
    blueprint: { targetFiles: [] },
    targetRoot: REPO_ROOT
  });

  assert.equal(plan.refused, undefined);
  assert.equal(plan.totalTasks, 1);
  assert.deepStrictEqual(plan.tasks[0].targetFiles, []);
});
