'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

test('sdw-config: loadConfig parses {projectRoot} tokens and provides defaults', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-cfg-test-'));
  try {
    const sdwDir = path.join(tmpDir, '.sdw');
    fs.mkdirSync(sdwDir, { recursive: true });
    const cfgPath = path.join(sdwDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      specsDir: '{projectRoot}/custom-specs',
      scoreMin: 9,
      scmCodeReviewEnabled: true
    }, null, 2), 'utf8');

    const config = sdwConfig.loadConfig(tmpDir);
    const expectedSpecs = path.join(tmpDir, 'custom-specs').replace(/\\/g, '/');

    assert.equal(config.specsDir, expectedSpecs, 'Resolves {projectRoot} token in specsDir');
    assert.equal(config.scoreMin, 9, 'Reads custom scoreMin');
    assert.equal(config.scmCodeReviewEnabled, true, 'Reads custom scmCodeReviewEnabled');
    assert.equal(config.autoResolveGaps, true, 'Applies default autoResolveGaps when omitted');
    assert.ok(config.stateDir.endsWith('/.sdw/state'), 'Applies default stateDir with projectRoot resolved');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-config: validateConfigSchema verifies valid and rejects invalid types/bounds', () => {
  // Valid config
  const valid = sdwConfig.validateConfigSchema({
    specsDir: '{projectRoot}/.sdw/specs',
    scoreMin: 8,
    scmCodeReviewEnabled: false,
    stateDir: '{projectRoot}/.sdw/state',
    autoResolveGaps: true
  });
  assert.equal(valid.valid, true, 'Valid config passes schema check');
  assert.equal(valid.errors.length, 0);

  // Missing specsDir
  const missingSpecs = sdwConfig.validateConfigSchema({ scoreMin: 8 });
  assert.equal(missingSpecs.valid, false);
  assert.ok(missingSpecs.errors.some(e => e.includes('specsDir')));

  // Invalid scoreMin (> 10)
  const invalidScoreMax = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    scoreMin: 15
  });
  assert.equal(invalidScoreMax.valid, false);
  assert.ok(invalidScoreMax.errors.some(e => e.includes('scoreMin')));

  // Invalid scoreMin string
  const invalidScoreType = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    scoreMin: 'high'
  });
  assert.equal(invalidScoreType.valid, false);

  // Invalid scmCodeReviewEnabled type
  const invalidBool = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    scmCodeReviewEnabled: 'yes'
  });
  assert.equal(invalidBool.valid, false);
  assert.ok(invalidBool.errors.some(e => e.includes('scmCodeReviewEnabled')));
});

test('sdw-config: cmdInit creates config.schema.json, config.json with $schema, and directories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-init-test-'));
  try {
    const code = sdwConfig.cmdInit({ root: tmpDir });
    assert.equal(code, 0, 'cmdInit succeeds');

    const schemaPath = path.join(tmpDir, '.sdw', 'config.schema.json');
    const configPath = path.join(tmpDir, '.sdw', 'config.json');
    const structurePath = path.join(tmpDir, '.sdw', 'directory-structure.md');

    assert.ok(fs.existsSync(schemaPath), 'config.schema.json exists');
    assert.ok(fs.existsSync(configPath), 'config.json exists');
    assert.ok(fs.existsSync(structurePath), 'directory-structure.md exists');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.$schema, './config.schema.json', 'config.json specifies $schema reference');
    assert.equal(config.scoreMin, 8);

    // cmdCheck passes on newly initialized project
    const checkCode = sdwConfig.cmdCheck({ root: tmpDir });
    assert.equal(checkCode, 0, 'cmdCheck passes for freshly initialized project');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-config: cmdCheck fails when config violates schema bounds', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-badcheck-test-'));
  try {
    sdwConfig.cmdInit({ root: tmpDir });
    const configPath = path.join(tmpDir, '.sdw', 'config.json');

    // Corrupt config with out-of-bounds scoreMin
    fs.writeFileSync(configPath, JSON.stringify({
      specsDir: '{projectRoot}/.sdw/specs',
      scoreMin: 99
    }, null, 2), 'utf8');

    const checkCode = sdwConfig.cmdCheck({ root: tmpDir });
    assert.equal(checkCode, 1, 'cmdCheck exits with 1 when schema validation fails');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-orch reads custom config values from .sdw/config.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-readcfg-test-'));
  try {
    sdwConfig.cmdInit({ root: tmpDir });
    const configPath = path.join(tmpDir, '.sdw', 'config.json');

    // Set custom scoreMin: 7 and custom stateDir
    fs.writeFileSync(configPath, JSON.stringify({
      specsDir: '{projectRoot}/.sdw/specs',
      scoreMin: 7,
      scmCodeReviewEnabled: true,
      stateDir: '{projectRoot}/.sdw/custom-state',
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/feature.md\'], summary: \'done\' }));"'
      }
    }, null, 2), 'utf8');

    const resolvedStateDir = stateManager.resolveStateDir(tmpDir);
    assert.ok(resolvedStateDir.endsWith('custom-state'), 'state_manager resolves custom stateDir from config');

    // Create a dummy spec in specsDir
    const specPath = path.join(tmpDir, '.sdw', 'specs', 'feature.md');
    fs.writeFileSync(specPath, `---
slug: feature
---
# Feature
## Acceptance Criteria
- AC1: The orchestrator shall test custom score.
`);

    // Verify sdw-orch detects the spec in specsDir even when passed as relative name
    const runCode = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: 'feature.md', // Relative name resolved via config.specsDir
      skipReview: true,
      skipPr: true
    });

    const state = stateManager.findLatestRunState(tmpDir);
    assert.ok(state, 'Run state created inside custom stateDir');
    assert.strictEqual(state.score, 10);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-config: validates pushDelivery boolean setting', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-pushcfg-test-'));
  try {
    sdwConfig.cmdInit({ root: tmpDir });
    const cfgPath = path.join(tmpDir, '.sdw', 'config.json');

    // Valid boolean
    fs.writeFileSync(cfgPath, JSON.stringify({
      specsDir: '{projectRoot}/.sdw/specs',
      pushDelivery: true
    }, null, 2), 'utf8');
    const validCheck = sdwConfig.cmdCheck({ root: tmpDir });
    assert.equal(validCheck, 0, 'Accepts boolean pushDelivery');

    // Invalid non-boolean
    fs.writeFileSync(cfgPath, JSON.stringify({
      specsDir: '{projectRoot}/.sdw/specs',
      pushDelivery: 'invalid-string'
    }, null, 2), 'utf8');
    const invalidCheck = sdwConfig.cmdCheck({ root: tmpDir });
    assert.equal(invalidCheck, 1, 'Rejects non-boolean pushDelivery');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
