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

test('00019 AC9: lockStaleMs is a positive integer key with a 300000 ms default', () => {
  assert.equal(sdwConfig.DEFAULT_CONFIG.lockStaleMs, 300000, 'the default stale threshold is five minutes');
  assert.equal(sdwConfig.DEFAULT_SCHEMA.properties.lockStaleMs.default, 300000, 'the schema publishes the same default');
  assert.equal(sdwConfig.DEFAULT_SCHEMA.properties.lockStaleMs.minimum, 1, 'the schema rejects a zero threshold');

  const valid = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', lockStaleMs: 1000 });
  assert.equal(valid.valid, true, 'a positive integer threshold is valid');
  assert.equal(valid.errors.length, 0);

  for (const value of [0, -1, 1.5, '300000', null]) {
    const invalid = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', lockStaleMs: value });
    assert.equal(invalid.valid, false, `lockStaleMs ${JSON.stringify(value)} is rejected`);
    assert.ok(invalid.errors.some(err => err.includes('lockStaleMs')), 'the error names the key');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-cfg-lock-'));
  try {
    assert.equal(sdwConfig.loadConfig(tmpDir).lockStaleMs, 300000, 'loadConfig applies the default when the file omits the key');
    fs.mkdirSync(path.join(tmpDir, '.sdw'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.sdw', 'config.json'),
      JSON.stringify({ specsDir: '{projectRoot}/.sdw/specs', lockStaleMs: 2500 }, null, 2),
      'utf8'
    );
    assert.equal(sdwConfig.loadConfig(tmpDir).lockStaleMs, 2500, 'loadConfig reads the configured threshold');
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

// Spec 00056 AC12: model hints are shape-validated deterministically. A
// malformed hint is a configuration error, never a detection or network action.
test('00056 AC12: validateConfigSchema accepts model hints and rejects malformed ones', () => {
  const valid = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    models: {
      default: { model: 'default-model', provider: null, effort: 'low', apiEndpoint: null },
      worker: null,
      detection: { enabled: true, command: 'node probe.cjs', timeoutMs: 5000 }
    }
  });
  assert.equal(valid.valid, true, 'AC12: a well-formed models block passes');
  assert.equal(valid.errors.length, 0);

  const wrongEffort = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    models: { worker: { model: 'worker-model', effort: 3 } }
  });
  assert.equal(wrongEffort.valid, false, 'AC12: a non-string effort is rejected');
  assert.ok(wrongEffort.errors.some(error => error.includes('models.worker.effort')), 'AC12: the error names the malformed property');

  const unknownRole = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    models: { planner: { model: 'planner-model' } }
  });
  assert.equal(unknownRole.valid, false, 'AC12: an unknown role key is rejected');
  assert.ok(unknownRole.errors.some(error => error.includes('models.planner')));

  const wrongHintShape = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    models: { worker: 'worker-model' }
  });
  assert.equal(wrongHintShape.valid, false, 'AC12: a non-object hint is rejected');

  const unknownHintKey = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    models: { worker: { model: 'worker-model', temperature: 1 } }
  });
  assert.equal(unknownHintKey.valid, false, 'AC12: an unknown hint key is rejected');

  const wrongDetection = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    models: { detection: { enabled: 'yes', timeoutMs: 0 } }
  });
  assert.equal(wrongDetection.valid, false, 'AC12: malformed detection settings are rejected');
  assert.ok(wrongDetection.errors.some(error => error.includes('models.detection.enabled')));
  assert.ok(wrongDetection.errors.some(error => error.includes('models.detection.timeoutMs')));
});

test('00056 AC12: cmdCheck rejects a malformed model hint and runs no detection command', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-56-model-check-'));
  try {
    sdwConfig.cmdInit({ root: tmpDir });
    const marker = path.join(tmpDir, 'detection-ran.txt').replace(/\\/g, '/');
    const configPath = path.join(tmpDir, '.sdw', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      specsDir: '{projectRoot}/.sdw/specs',
      models: {
        worker: { model: 'worker-model', effort: 3 },
        detection: { enabled: true, command: `node -e "require('fs').writeFileSync('${marker}', 'ran')"` }
      }
    }, null, 2), 'utf8');

    let output = '';
    const originalLog = console.log;
    console.log = (message) => { output += `${String(message)}\n`; };
    let code;
    try {
      code = sdwConfig.cmdCheck({ root: tmpDir, skillsRoot: path.resolve(__dirname, '../skills') });
    } finally {
      console.log = originalLog;
    }

    assert.equal(code, 1, 'AC12: cmdCheck exits 1 for a malformed hint');
    assert.match(output, /models\.worker\.effort/, 'AC12: cmdCheck names the malformed property');
    assert.equal(fs.existsSync(marker), false, 'AC12: no detection command runs during shape validation');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Spec 00021: the monitor reads `.sdw/config.json`, so both monitor keys are
// declared wherever the repository declares configuration.
test('00021: monitor.stallWindowSeconds and monitor.intervalSeconds are declared in the config surfaces', () => {
  const defaults = { stallWindowSeconds: 900, intervalSeconds: 60 };
  assert.deepEqual(sdwConfig.DEFAULT_CONFIG.monitor, defaults, 'the defaults publish the documented monitor values');

  const schemaMonitor = sdwConfig.DEFAULT_SCHEMA.properties.monitor;
  assert.equal(schemaMonitor.type, 'object');
  assert.equal(schemaMonitor.additionalProperties, false);
  for (const [key, value] of Object.entries(defaults)) {
    const declared = schemaMonitor.properties[key];
    assert.equal(declared.type, 'integer', `00021: DEFAULT_SCHEMA declares monitor.${key} as an integer`);
    assert.equal(declared.minimum, 1, `00021: DEFAULT_SCHEMA gives monitor.${key} a minimum`);
    assert.equal(declared.default, value, `00021: DEFAULT_SCHEMA publishes the monitor.${key} default`);
  }

  const valid = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    monitor: { stallWindowSeconds: 120, intervalSeconds: 5 }
  });
  assert.equal(valid.valid, true, '00021: a positive integer monitor block is valid');
  assert.equal(valid.errors.length, 0);

  for (const value of [0, -1, 1.5, '900', null, true]) {
    for (const key of ['stallWindowSeconds', 'intervalSeconds']) {
      const invalid = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', monitor: { [key]: value } });
      assert.equal(invalid.valid, false, `00021: monitor.${key} ${JSON.stringify(value)} is rejected`);
      assert.ok(invalid.errors.some(err => err.includes(`monitor.${key}`)), '00021: the error names the key');
    }
  }

  const notObject = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', monitor: 900 });
  assert.equal(notObject.valid, false);
  assert.ok(notObject.errors.some(err => err.includes('"monitor"') && err.includes('must be an object')));

  const unknownKey = sdwConfig.validateConfigSchema({ specsDir: '.sdw/specs', monitor: { stallWindow: 900 } });
  assert.equal(unknownKey.valid, false);
  assert.ok(unknownKey.errors.some(err => err.includes('monitor.stallWindow') && err.includes('not a recognized key')));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-cfg-monitor-'));
  try {
    assert.deepEqual(sdwConfig.loadConfig(tmpDir).monitor, defaults, '00021: loadConfig applies the monitor defaults');
    fs.mkdirSync(path.join(tmpDir, '.sdw'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.sdw', 'config.json'),
      JSON.stringify({ specsDir: '{projectRoot}/.sdw/specs', monitor: { stallWindowSeconds: 120 } }, null, 2),
      'utf8'
    );
    assert.equal(sdwConfig.loadConfig(tmpDir).monitor.stallWindowSeconds, 120, '00021: loadConfig reads the configured stall window');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // The repository template and its reference must declare the same keys.
  const repoRoot = path.resolve(__dirname, '..');
  const repoConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, '.sdw', 'config.json'), 'utf8'));
  assert.deepEqual(repoConfig.monitor, defaults, '00021: the repository config carries the documented monitor block');
  const repoSchema = JSON.parse(fs.readFileSync(path.join(repoRoot, '.sdw', 'config.schema.json'), 'utf8'));
  assert.equal(repoSchema.properties.monitor.properties.stallWindowSeconds.default, 900);
  assert.equal(repoSchema.properties.monitor.properties.intervalSeconds.default, 60);
  const reference = fs.readFileSync(path.join(repoRoot, 'skills', 'sdw-config', 'references', 'config_spec.md'), 'utf8');
  assert.match(reference, /\|\s*`monitor\.stallWindowSeconds`\s*\|/);
  assert.match(reference, /\|\s*`monitor\.intervalSeconds`\s*\|/);
  assert.match(reference, /"monitor": \{/);
});

