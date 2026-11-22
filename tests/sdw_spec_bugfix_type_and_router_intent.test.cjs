'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const validateSpec = require('../skills/sdw-spec/scripts/validate_spec.cjs');
const sdwSpec = require('../skills/sdw-spec/scripts/sdw_spec.cjs');
const sdwRouter = require('../skills/sdw-router/scripts/sdw_router.cjs');

const CLI_SPEC = path.join(__dirname, '..', 'skills', 'sdw-spec', 'scripts', 'sdw_spec.cjs');
const CLI_ROUTER = path.join(__dirname, '..', 'skills', 'sdw-router', 'scripts', 'sdw_router.cjs');

function setupWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-type-test-'));
  const sdwDir = path.join(tmpDir, '.sdw');
  const specsDir = path.join(sdwDir, 'specs');
  const stateDir = path.join(sdwDir, 'state');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify({
    specsDir: '{projectRoot}/.sdw/specs',
    stateDir: '{projectRoot}/.sdw/state'
  }, null, 2), 'utf8');
  return { tmpDir, specsDir, stateDir };
}

function parseFrontmatterBlock(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};
  const values = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (item) values[item[1]] = item[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

test('AC1, AC2: sdw-spec new supports --type with bugfix, feature, and task, defaulting to feature', () => {
  const ws = setupWorkspace();

  // 1. Default to feature when omitted
  const resDefault = spawnSync(process.execPath, [
    CLI_SPEC, 'new', 'Implement new analytics dashboard', '--root', ws.tmpDir
  ], { encoding: 'utf8' });
  assert.equal(resDefault.status, 0, `Command should succeed: ${resDefault.stderr}`);
  
  const files = fs.readdirSync(ws.specsDir).filter(f => f.endsWith('.md') && !f.includes('index'));
  assert.equal(files.length, 1);
  const contentDefault = fs.readFileSync(path.join(ws.specsDir, files[0]), 'utf8');
  const fmDefault = parseFrontmatterBlock(contentDefault);
  assert.equal(fmDefault.type, 'feature', 'Default type should be recorded as feature in frontmatter');

  // 2. Explicit bugfix type
  const resBugfix = spawnSync(process.execPath, [
    CLI_SPEC, 'new', 'Fix memory leak in websocket connection', '--type', 'bugfix', '--root', ws.tmpDir
  ], { encoding: 'utf8' });
  assert.equal(resBugfix.status, 0, `Command should succeed: ${resBugfix.stderr}`);
  
  const files2 = fs.readdirSync(ws.specsDir).filter(f => f.endsWith('.md') && !f.includes('index') && f !== files[0]);
  assert.equal(files2.length, 1);
  const contentBugfix = fs.readFileSync(path.join(ws.specsDir, files2[0]), 'utf8');
  const fmBugfix = parseFrontmatterBlock(contentBugfix);
  assert.equal(fmBugfix.type, 'bugfix', 'Resolved type bugfix should be recorded in frontmatter');

  // 3. Explicit task type
  const resTask = spawnSync(process.execPath, [
    CLI_SPEC, 'new', 'Database schema migration cleanup', '--type=task', '--root', ws.tmpDir
  ], { encoding: 'utf8' });
  assert.equal(resTask.status, 0, `Command should succeed: ${resTask.stderr}`);
  
  const files3 = fs.readdirSync(ws.specsDir).filter(f => f.endsWith('.md') && !f.includes('index') && f !== files[0] && f !== files2[0]);
  assert.equal(files3.length, 1);
  const contentTask = fs.readFileSync(path.join(ws.specsDir, files3[0]), 'utf8');
  const fmTask = parseFrontmatterBlock(contentTask);
  assert.equal(fmTask.type, 'task', 'Resolved type task should be recorded in frontmatter');
});

test('AC3: Frontmatter type can be omitted in legacy and default specifications without validation errors', () => {
  const existingSpec = path.join(__dirname, '..', '.sdw', 'specs', '00075-fresh-context-subagent-judge.md');
  const result = validateSpec.validateFile(existingSpec, { mode: 'authoring' });
  assert.equal(result.ok, true, 'Existing specification omitting type field must pass validation');
  assert.equal(result.errors.length, 0);
});

test('AC4: Unrecognized type value is rejected with an actionable error', () => {
  const ws = setupWorkspace();

  // 1. CLI rejection
  const res = spawnSync(process.execPath, [
    CLI_SPEC, 'new', 'Invalid spec type test', '--type', 'enhancement', '--root', ws.tmpDir
  ], { encoding: 'utf8' });
  assert.notEqual(res.status, 0, 'Command must exit non-zero for unrecognized type');
  assert.ok(/type must be one of/i.test(res.stderr) || /allowed types/i.test(res.stderr) || /unrecognized type/i.test(res.stderr),
    `Stderr should mention allowed types: ${res.stderr}`);

  // 2. Validator rejection
  const invalidSpec = `---
id: null
slug: 00099-invalid-type-spec
title: "Invalid Type Spec"
source: local
type: enhancement
status: draft
specDate: 2026-11-21
---
# Specification — Invalid Type Spec
## Description
Spec with invalid type.
### Design Intent
Verify validation rejection.
## Acceptance Criteria
- AC1: The system shall reject invalid type values.
## Notes
None.
## Out of Scope
None.
## Assumptions & Open Questions
None.
## Definition of Ready (DoR)
None.
`;
  const valResult = validateSpec.validate(invalidSpec, { mode: 'authoring' });
  assert.equal(valResult.ok, false, 'Specification with invalid type must fail validation');
  assert.ok(valResult.errors.some(e => e.code === 'type' || /type/i.test(e.message)));
});

test('AC5: sdw-router classifies prompt to fix a bug as sdw-spec with type bugfix', () => {
  const bugfixPrompts = [
    'create a spec to fix a bug in auth',
    'draft a bugfix spec for timeout',
    'create a spec to fix the memory leak',
    'author a spec to fix defect in payment processor',
    'write a bugfix spec for race condition'
  ];

  for (const prompt of bugfixPrompts) {
    const route = sdwRouter.routePrompt(prompt);
    assert.equal(route.matched, true, `Prompt should match router: "${prompt}"`);
    assert.equal(route.targetSkill, 'sdw-spec', `Prompt should route to sdw-spec: "${prompt}"`);
    assert.ok(route.options && route.options.type === 'bugfix',
      `Route should include options.type = 'bugfix' for prompt: "${prompt}". Got: ${JSON.stringify(route.options)}`);
  }

  // CLI execution verification
  const cliRes = spawnSync(process.execPath, [
    CLI_ROUTER, 'route', 'create a spec to fix the memory leak', '--json'
  ], { encoding: 'utf8' });
  assert.equal(cliRes.status, 0);
  const parsed = JSON.parse(cliRes.stdout);
  assert.equal(parsed.targetSkill, 'sdw-spec');
  assert.equal(parsed.options && parsed.options.type, 'bugfix');
});

test('AC6: sdw-router routes standard specification authoring prompts with default feature type', () => {
  const featurePrompts = [
    'create a spec for user notifications',
    'draft a specification for csv export',
    'author a new spec for checkout workflow'
  ];

  for (const prompt of featurePrompts) {
    const route = sdwRouter.routePrompt(prompt);
    assert.equal(route.matched, true, `Prompt should match: "${prompt}"`);
    assert.equal(route.targetSkill, 'sdw-spec', `Target should be sdw-spec: "${prompt}"`);
    const resolvedType = (route.options && route.options.type) || 'feature';
    assert.equal(resolvedType, 'feature', `Default type should be feature for prompt: "${prompt}"`);
  }

  // CLI execution verification for default feature type
  const cliRes = spawnSync(process.execPath, [
    CLI_ROUTER, 'route', 'create a spec for user notifications', '--json'
  ], { encoding: 'utf8' });
  assert.equal(cliRes.status, 0);
  const parsed = JSON.parse(cliRes.stdout);
  assert.equal(parsed.targetSkill, 'sdw-spec');
  const cliType = (parsed.options && parsed.options.type) || 'feature';
  assert.equal(cliType, 'feature');
});

test('AC7: sdw-spec list displays TYPE column for registered specifications', () => {
  const ws = setupWorkspace();

  // Create 3 specs: default (feature), explicit bugfix, explicit task
  spawnSync(process.execPath, [
    CLI_SPEC, 'new', 'Feature spec for analytics', '--root', ws.tmpDir
  ], { encoding: 'utf8' });

  spawnSync(process.execPath, [
    CLI_SPEC, 'new', 'Bugfix spec for crash', '--type', 'bugfix', '--root', ws.tmpDir
  ], { encoding: 'utf8' });

  spawnSync(process.execPath, [
    CLI_SPEC, 'new', 'Task spec for maintenance', '--type=task', '--root', ws.tmpDir
  ], { encoding: 'utf8' });

  // 1. Standard text list output contains TYPE column
  const resList = spawnSync(process.execPath, [
    CLI_SPEC, 'list', '--root', ws.tmpDir
  ], { encoding: 'utf8' });
  assert.equal(resList.status, 0, `Command should succeed: ${resList.stderr}`);
  assert.ok(resList.stdout.includes('TYPE'), `Output table header should include TYPE column:\n${resList.stdout}`);
  assert.ok(resList.stdout.includes('bugfix'), `Output should display bugfix type:\n${resList.stdout}`);
  assert.ok(resList.stdout.includes('task'), `Output should display task type:\n${resList.stdout}`);
  assert.ok(resList.stdout.includes('feature'), `Output should display feature type:\n${resList.stdout}`);

  // 2. Ordered text list output contains TYPE column
  const resOrdered = spawnSync(process.execPath, [
    CLI_SPEC, 'list', '--order=priority', '--root', ws.tmpDir
  ], { encoding: 'utf8' });
  assert.equal(resOrdered.status, 0);
  assert.ok(resOrdered.stdout.includes('TYPE'), `Ordered output header should include TYPE column:\n${resOrdered.stdout}`);

  // 3. JSON list output contains type property
  const resJson = spawnSync(process.execPath, [
    CLI_SPEC, 'list', '--json', '--root', ws.tmpDir
  ], { encoding: 'utf8' });
  assert.equal(resJson.status, 0);
  const items = JSON.parse(resJson.stdout);
  assert.equal(items.length, 3);
  const types = items.map(i => i.type || 'feature');
  assert.ok(types.includes('bugfix'), 'JSON output must include type: "bugfix"');
  assert.ok(types.includes('task'), 'JSON output must include type: "task"');
  assert.ok(types.includes('feature'), 'JSON output must include type: "feature"');
});

test('AC8: specification and router documentation documents bugfix type option and router intent mapping', () => {
  const root = path.resolve(__dirname, '..');
  
  // 1. sdw-spec SKILL.md documents --type
  const specSkill = fs.readFileSync(path.join(root, 'skills', 'sdw-spec', 'SKILL.md'), 'utf8');
  assert.ok(/--type/i.test(specSkill) || /bugfix/i.test(specSkill),
    'sdw-spec/SKILL.md should document --type or bugfix option');

  // 2. spec_standard.md documents type frontmatter
  const specStd = fs.readFileSync(path.join(root, 'skills', 'sdw-spec', 'references', 'spec_standard.md'), 'utf8');
  assert.ok(/type:\s*(?:['"]?bugfix['"]?|feature|task)/i.test(specStd) || /type key/i.test(specStd),
    'spec_standard.md should document type frontmatter key');

  // 3. sdw-router SKILL.md documents bugfix intent mapping
  const routerSkill = fs.readFileSync(path.join(root, 'skills', 'sdw-router', 'SKILL.md'), 'utf8');
  assert.ok(/bugfix/i.test(routerSkill) || /fix (?:a )?bug/i.test(routerSkill),
    'sdw-router/SKILL.md should document bugfix intent routing to sdw-spec');
});

test('AC9: automated unit tests verify type argument parsing, frontmatter output, router classification, and validation compatibility', () => {
  // Verifies that the suite comprehensively covers type parsing, frontmatter, router classification, and validation
  assert.equal(typeof sdwRouter.routePrompt, 'function');
  assert.equal(typeof validateSpec.validate, 'function');
  assert.equal(typeof validateSpec.validateFile, 'function');

  // Direct programmatic validation test
  const validBugfixSpec = `---
id: null
slug: 00098-bugfix-sample
title: "Bugfix Sample"
source: local
type: bugfix
status: draft
specDate: 2026-11-21
priority: high
---
# Specification — Bugfix Sample
## Description
Sample bugfix.
### Design Intent
Fix bug.
## Acceptance Criteria
- AC1: The system shall pass.
## Notes
None.
## Out of Scope
| Feature | Reason |
|---|---|
| None | N/A |
## Assumptions & Open Questions
| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| None | None | None | y |
## Definition of Ready (DoR)
| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Valid | Pass | Unit test |
## Validation & Observation Notes
### Telemetry & Observable Signals
- Signal 1
### Negative & Failing Test Scenarios
- Scenario 1
`;
  const res = validateSpec.validate(validBugfixSpec, { mode: 'authoring' });
  assert.equal(res.ok, true, `Bugfix spec should pass validation: ${JSON.stringify(res.errors)}`);
});
