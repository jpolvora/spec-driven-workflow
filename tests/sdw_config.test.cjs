'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

// Spec 027: wire the deterministic judge stub for unattended runs past Step 4.
require('./fixtures/judge_env.cjs').installJudgeEnv();

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

test('sdw-config: loadConfig fails fast on the removed flat build and test commands', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-cfg-legacy-'));
  try {
    const sdwDir = path.join(tmpDir, '.sdw');
    fs.mkdirSync(sdwDir, { recursive: true });
    const cfgPath = path.join(sdwDir, 'config.json');

    fs.writeFileSync(cfgPath, JSON.stringify({ runAllTests: true, testCommand: 'pytest -q' }, null, 2), 'utf8');
    assert.throws(() => sdwConfig.loadConfig(tmpDir), /verification\.testCommand/);

    fs.writeFileSync(cfgPath, JSON.stringify({ requiredBuild: true, buildCommand: 'make' }, null, 2), 'utf8');
    assert.throws(() => sdwConfig.loadConfig(tmpDir), /verification\.buildCommand/);

    fs.writeFileSync(cfgPath, JSON.stringify({ runAllTests: true, verification: { testCommand: 'pytest -q' } }, null, 2), 'utf8');
    assert.equal(sdwConfig.loadConfig(tmpDir).verification.testCommand, 'pytest -q');
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

    const skillsFixture = path.resolve(__dirname, '../skills');

    // cmdCheck passes on newly initialized project with skillsRoot fixture
    const checkCode = sdwConfig.cmdCheck({ root: tmpDir, skillsRoot: skillsFixture });
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

    const skillsFixture = path.resolve(__dirname, '../skills');
    const checkCode = sdwConfig.cmdCheck({ root: tmpDir, skillsRoot: skillsFixture });
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
    const skillsFixture = path.resolve(__dirname, '../skills');
    const validCheck = sdwConfig.cmdCheck({ root: tmpDir, skillsRoot: skillsFixture });
    assert.equal(validCheck, 0, 'Accepts boolean pushDelivery');

    // Invalid non-boolean
    fs.writeFileSync(cfgPath, JSON.stringify({
      specsDir: '{projectRoot}/.sdw/specs',
      pushDelivery: 'invalid-string'
    }, null, 2), 'utf8');
    const invalidCheck = sdwConfig.cmdCheck({ root: tmpDir, skillsRoot: skillsFixture });
    assert.equal(invalidCheck, 1, 'Rejects non-boolean pushDelivery');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-config: resolveBranching expands presets and explicit overrides win', () => {
  // No branching block -> default trunk preset
  assert.deepEqual(sdwConfig.resolveBranching({}), {
    strategy: 'trunk',
    source: 'default',
    mirrorWorkToIntegration: false,
    workBranch: null,
    integrationBranch: null,
    featurePrefix: 'feature/',
    updateWorkBranch: false,
    syncWorkBranchAfterMerge: false,
    pushSyncedWorkBranch: false
  });

  // trunk, explicit
  const trunk = sdwConfig.resolveBranching({ branching: { strategy: 'trunk' } });
  assert.equal(trunk.source, 'config');
  assert.equal(trunk.workBranch, null);
  assert.equal(trunk.integrationBranch, null);
  assert.equal(trunk.updateWorkBranch, false);
  assert.equal(trunk.syncWorkBranchAfterMerge, false);

  // github: work lane mirrors the integration lane (auto -> null)
  const github = sdwConfig.resolveBranching({ branching: { strategy: 'github' } });
  assert.equal(github.strategy, 'github');
  assert.equal(github.mirrorWorkToIntegration, true);
  assert.equal(github.workBranch, null);
  assert.equal(github.integrationBranch, null);
  assert.equal(github.updateWorkBranch, true);
  assert.equal(github.syncWorkBranchAfterMerge, true);

  // develop: named work lane, auto integration lane
  const develop = sdwConfig.resolveBranching({ branching: { strategy: 'develop' } });
  assert.equal(develop.workBranch, 'develop');
  assert.equal(develop.integrationBranch, null);
  assert.equal(develop.updateWorkBranch, true);
  assert.equal(develop.syncWorkBranchAfterMerge, true);

  // gitflow: feature branches start from develop and merge into develop
  const gitflow = sdwConfig.resolveBranching({ branching: { strategy: 'gitflow' } });
  assert.equal(gitflow.workBranch, 'develop');
  assert.equal(gitflow.integrationBranch, 'develop');
  assert.equal(gitflow.updateWorkBranch, true);
  assert.equal(gitflow.syncWorkBranchAfterMerge, true);

  // gitlab: work lane mirrors the integration lane (auto -> null)
  const gitlab = sdwConfig.resolveBranching({ branching: { strategy: 'gitlab' } });
  assert.equal(gitlab.workBranch, null);
  assert.equal(gitlab.integrationBranch, null);
  assert.equal(gitlab.updateWorkBranch, true);
  assert.equal(gitlab.syncWorkBranchAfterMerge, true);

  // An explicit integration branch flows into the mirroring work lane
  const githubMain = sdwConfig.resolveBranching({ branching: { strategy: 'github', integrationBranch: 'main' } });
  assert.equal(githubMain.integrationBranch, 'main');
  assert.equal(githubMain.workBranch, 'main');

  // Every explicit key overrides the preset
  const overridden = sdwConfig.resolveBranching({
    branching: {
      strategy: 'gitflow',
      featurePrefix: 'feat/',
      workBranch: 'release-line',
      integrationBranch: 'production',
      updateWorkBranch: false,
      syncWorkBranchAfterMerge: false,
      pushSyncedWorkBranch: true
    }
  });
  assert.deepEqual(overridden, {
    strategy: 'gitflow',
    source: 'config',
    mirrorWorkToIntegration: false,
    workBranch: 'release-line',
    integrationBranch: 'production',
    featurePrefix: 'feat/',
    updateWorkBranch: false,
    syncWorkBranchAfterMerge: false,
    pushSyncedWorkBranch: true
  });

  // A scaffolded default block (loadConfig shape with an empty raw file) is not
  // an explicit configuration: the strategy source stays "default".
  const scaffolded = sdwConfig.resolveBranching({
    branching: {
      strategy: 'trunk',
      featurePrefix: 'feature/',
      workBranch: null,
      integrationBranch: null,
      updateWorkBranch: false,
      syncWorkBranchAfterMerge: false,
      pushSyncedWorkBranch: false
    },
    raw: {}
  });
  assert.equal(scaffolded.strategy, 'trunk');
  assert.equal(scaffolded.source, 'default');

  // An explicit block in the raw file is the source
  const loaded = sdwConfig.resolveBranching({
    branching: { strategy: 'develop' },
    raw: { branching: { strategy: 'develop' } }
  });
  assert.equal(loaded.strategy, 'develop');
  assert.equal(loaded.source, 'config');

  // End to end through loadConfig: a scaffolded config without branching resolves the trunk defaults
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-branching-resolve-'));
  try {
    sdwConfig.cmdInit({ root: tmpDir });
    const scaffoldedResolution = sdwConfig.resolveBranching(sdwConfig.loadConfig(tmpDir));
    assert.equal(scaffoldedResolution.strategy, 'trunk');
    assert.equal(scaffoldedResolution.source, 'default');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Unknown strategy is rejected by the resolver as well
  assert.throws(
    () => sdwConfig.resolveBranching({ branching: { strategy: 'svn' } }),
    /Unknown branching\.strategy "svn"/
  );
});

test('sdw-config: validates branching keys, types, and strategy values', () => {
  const valid = sdwConfig.validateConfigSchema({
    specsDir: '{projectRoot}/.sdw/specs',
    branching: {
      strategy: 'gitflow',
      featurePrefix: 'feature/',
      workBranch: 'develop',
      integrationBranch: 'develop',
      updateWorkBranch: true,
      syncWorkBranchAfterMerge: true,
      pushSyncedWorkBranch: false
    }
  });
  assert.equal(valid.valid, true, 'A fully explicit branching object is valid');
  assert.equal(valid.errors.length, 0);

  const notObject = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', branching: 'gitflow' });
  assert.equal(notObject.valid, false);
  assert.ok(notObject.errors.some(e => e.includes('"branching"') && e.includes('must be an object')));

  const unknownKey = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', branching: { strategy: 'trunk', workbranch: 'develop' } });
  assert.equal(unknownKey.valid, false);
  assert.ok(unknownKey.errors.some(e => e.includes('branching.workbranch') && e.includes('not a recognized key')));

  const unknownStrategy = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', branching: { strategy: 'svn' } });
  assert.equal(unknownStrategy.valid, false);
  assert.ok(unknownStrategy.errors.some(e => e.includes('branching.strategy') && e.includes('svn') && e.includes('gitflow')));

  const wrongStrategyType = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', branching: { strategy: 5 } });
  assert.equal(wrongStrategyType.valid, false);
  assert.ok(wrongStrategyType.errors.some(e => e.includes('branching.strategy') && e.includes('must be a string')));

  const wrongFeaturePrefix = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', branching: { featurePrefix: 42 } });
  assert.equal(wrongFeaturePrefix.valid, false);
  assert.ok(wrongFeaturePrefix.errors.some(e => e.includes('branching.featurePrefix') && e.includes('must be a string')));

  const wrongWorkBranch = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', branching: { workBranch: 42 } });
  assert.equal(wrongWorkBranch.valid, false);
  assert.ok(wrongWorkBranch.errors.some(e => e.includes('branching.workBranch') && e.includes('must be a string or null')));

  const wrongIntegrationBranch = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', branching: { integrationBranch: [] } });
  assert.equal(wrongIntegrationBranch.valid, false);
  assert.ok(wrongIntegrationBranch.errors.some(e => e.includes('branching.integrationBranch') && e.includes('must be a string or null')));

  const wrongBooleans = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    branching: { updateWorkBranch: 'yes', syncWorkBranchAfterMerge: 1, pushSyncedWorkBranch: null }
  });
  assert.equal(wrongBooleans.valid, false);
  for (const key of ['updateWorkBranch', 'syncWorkBranchAfterMerge', 'pushSyncedWorkBranch']) {
    assert.ok(wrongBooleans.errors.some(e => e.includes(`branching.${key}`) && e.includes('must be a boolean')), `Names ${key} and its expected type`);
  }

  // Null lanes stay valid: null means auto (integration) or current branch (work)
  const nullLanes = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', branching: { workBranch: null, integrationBranch: null } });
  assert.equal(nullLanes.valid, true);
});

test('sdw-config: cmdCheck rejects an unknown branching strategy end to end', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-branchcfg-test-'));
  try {
    sdwConfig.cmdInit({ root: tmpDir });
    const configPath = path.join(tmpDir, '.sdw', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      specsDir: '{projectRoot}/.sdw/specs',
      branching: { strategy: 'unknown-model' }
    }, null, 2), 'utf8');

    const skillsFixture = path.resolve(__dirname, '../skills');
    const checkCode = sdwConfig.cmdCheck({ root: tmpDir, skillsRoot: skillsFixture });
    assert.equal(checkCode, 1, 'cmdCheck exits 1 for an unknown strategy');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
