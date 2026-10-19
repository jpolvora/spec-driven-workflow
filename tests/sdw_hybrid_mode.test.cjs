'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwRouter = require('../skills/sdw-router/scripts/sdw_router.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

function createTempDir(prefix = 'sdw-hybrid-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createDummySkill(skillsDir, skillName, scriptName = null) {
  const target = path.join(skillsDir, skillName);
  fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(target, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Test skill ${skillName}\nversion: 1.0.0\n---\n# ${skillName}\n\n> When this skill is loaded, output "${skillName} loaded."\n`,
    'utf8'
  );
  const defaultScriptName = `${skillName.replace(/-/g, '_')}.cjs`;
  fs.writeFileSync(
    path.join(target, 'scripts', scriptName || defaultScriptName),
    `'use strict';\nmodule.exports = { name: '${skillName}' };\n`,
    'utf8'
  );
  return target;
}

test('AC1: {skillsRoot} token in .sdw/config.json is expanded during loadConfig and parse', () => {
  const tmpProject = createTempDir('sdw-ac1-proj-');
  const tmpGlobal = createTempDir('sdw-ac1-global-');
  try {
    const globalSkills = path.join(tmpGlobal, '.agents', 'skills');
    createDummySkill(globalSkills, 'sdw-spec');

    // Create local .sdw/config.json using {skillsRoot} token
    const sdwDir = path.join(tmpProject, '.sdw');
    fs.mkdirSync(sdwDir, { recursive: true });
    fs.writeFileSync(
      path.join(sdwDir, 'config.json'),
      JSON.stringify({
        specsDir: '{skillsRoot}/custom-specs',
        stateDir: '{projectRoot}/.sdw/state'
      }, null, 2),
      'utf8'
    );

    const loaded = sdwConfig.loadConfig(tmpProject, {
      homeDir: tmpGlobal,
      ignoreCaller: true
    });

    const expectedSkillsRoot = globalSkills.replace(/\\/g, '/');
    assert.equal(loaded.skillsRoot, expectedSkillsRoot);
    assert.equal(loaded.specsDir, `${expectedSkillsRoot}/custom-specs`);
    assert.equal(loaded.skillsMode, 'global');

    // CLI parse verification
    const cliScript = path.resolve(__dirname, '../skills/sdw-config/scripts/sdw_config.cjs');
    const parseOut = execSync(
      `node "${cliScript}" parse --root "${tmpProject}" --skills-root "${globalSkills}" --key specsDir --json`,
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(parseOut);
    assert.equal(parsed.specsDir, `${expectedSkillsRoot}/custom-specs`);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
  }
});

test('AC2 & AC3: Precedence order prefers explicit override, then project-local skills over global', () => {
  const tmpProject = createTempDir('sdw-ac2-proj-');
  const tmpGlobal = createTempDir('sdw-ac2-global-');
  const tmpOverride = createTempDir('sdw-ac2-override-');
  try {
    const localSkills = path.join(tmpProject, '.agents', 'skills');
    const globalSkills = path.join(tmpGlobal, '.agents', 'skills');
    const overrideSkills = path.join(tmpOverride, 'skills');

    createDummySkill(localSkills, 'sdw-config');
    createDummySkill(globalSkills, 'sdw-config');
    createDummySkill(overrideSkills, 'sdw-config');

    // 1. Without override: local skills win over global
    const localRes = sdwConfig.resolveSkillsRoot({
      root: tmpProject,
      homeDir: tmpGlobal,
      ignoreCaller: true
    });
    assert.ok(localRes);
    assert.equal(localRes.skillsRoot, localSkills.replace(/\\/g, '/'));
    assert.equal(localRes.mode, 'local');

    // 2. With explicit override: override wins over local and global
    const overrideRes = sdwConfig.resolveSkillsRoot({
      root: tmpProject,
      homeDir: tmpGlobal,
      skillsRoot: overrideSkills,
      ignoreCaller: true
    });
    assert.ok(overrideRes);
    assert.equal(overrideRes.skillsRoot, overrideSkills.replace(/\\/g, '/'));
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
    fs.rmSync(tmpOverride, { recursive: true, force: true });
  }
});

test('AC4: Project lacking local skills resolves to global user skills root ($HOME/.agents/skills)', () => {
  const tmpProject = createTempDir('sdw-ac4-proj-');
  const tmpGlobal = createTempDir('sdw-ac4-global-');
  try {
    const globalSkills = path.join(tmpGlobal, '.agents', 'skills');
    createDummySkill(globalSkills, 'sdw-config');

    // Project has no skills directory
    const resolved = sdwConfig.resolveSkillsRoot({
      root: tmpProject,
      homeDir: tmpGlobal,
      ignoreCaller: true
    });

    assert.ok(resolved);
    assert.equal(resolved.skillsRoot, globalSkills.replace(/\\/g, '/'));
    assert.equal(resolved.mode, 'global');
    assert.equal(resolved.exists, true);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
  }
});

test('AC5: sdw-config init in hybrid mode creates local .sdw files without polluting global skills', () => {
  const tmpProject = createTempDir('sdw-ac5-proj-');
  const tmpGlobal = createTempDir('sdw-ac5-global-');
  try {
    const globalSkills = path.join(tmpGlobal, '.agents', 'skills');
    createDummySkill(globalSkills, 'sdw-config');

    // Snapshot global skills directory state before init
    const globalEntriesBefore = fs.readdirSync(globalSkills);

    const initRes = sdwConfig.cmdInit({
      root: tmpProject,
      homeDir: tmpGlobal,
      ignoreCaller: true
    });

    assert.equal(initRes, 0);

    // Verify local project created .sdw structure
    assert.ok(fs.existsSync(path.join(tmpProject, '.sdw', 'config.json')));
    assert.ok(fs.existsSync(path.join(tmpProject, '.sdw', 'config.schema.json')));
    assert.ok(fs.existsSync(path.join(tmpProject, '.sdw', 'directory-structure.md')));
    assert.ok(fs.existsSync(path.join(tmpProject, '.sdw', 'specs')));
    assert.ok(fs.existsSync(path.join(tmpProject, '.sdw', 'state')));

    // Verify global skills directory was not polluted
    const globalEntriesAfter = fs.readdirSync(globalSkills);
    assert.deepEqual(globalEntriesBefore, globalEntriesAfter);
    assert.equal(fs.existsSync(path.join(globalSkills, '.sdw')), false);
    assert.equal(fs.existsSync(path.join(tmpGlobal, '.sdw')), false);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
  }
});

test('AC6: sdw-config check validates and reports resolved skills root and active mode', () => {
  const tmpProject = createTempDir('sdw-ac6-proj-');
  const tmpGlobal = createTempDir('sdw-ac6-global-');
  try {
    const globalSkills = path.join(tmpGlobal, '.agents', 'skills');
    createDummySkill(globalSkills, 'sdw-config');

    // Initialize project
    sdwConfig.cmdInit({ root: tmpProject, homeDir: tmpGlobal, ignoreCaller: true });

    const cliScript = path.resolve(__dirname, '../skills/sdw-config/scripts/sdw_config.cjs');
    const checkProc = spawnSync(
      process.execPath,
      [cliScript, 'check', '--root', tmpProject, '--skills-root', globalSkills, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: tmpGlobal, USERPROFILE: tmpGlobal }
      }
    );

    assert.equal(checkProc.status, 0);
    const parsed = JSON.parse(checkProc.stdout);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.skillsRoot, globalSkills.replace(/\\/g, '/'));
    assert.equal(parsed.skillsMode, 'global');

    const skillsCheck = parsed.checks.find(c => c.name === 'skills_root_resolution');
    assert.ok(skillsCheck);
    assert.equal(skillsCheck.passed, true);
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
  }
});

test('AC7: sdw-router scans and merges skills across canonical, consumer, and global with correct precedence', () => {
  const tmpProject = createTempDir('sdw-ac7-proj-');
  const tmpGlobal = createTempDir('sdw-ac7-global-');
  try {
    const canonSkills = path.join(tmpProject, 'skills');
    const consSkills = path.join(tmpProject, '.agents', 'skills');
    const globalSkills = path.join(tmpGlobal, '.agents', 'skills');

    // Create shadow skill in all three
    createDummySkill(canonSkills, 'shadow-skill');
    createDummySkill(consSkills, 'shadow-skill');
    createDummySkill(globalSkills, 'shadow-skill');

    // Create unique skills
    createDummySkill(consSkills, 'unique-cons');
    createDummySkill(globalSkills, 'unique-global');

    const scanned = sdwRouter.scanSkills({
      root: tmpProject,
      homeDir: tmpGlobal
    });

    const shadow = scanned.find(s => s.name === 'shadow-skill');
    const cons = scanned.find(s => s.name === 'unique-cons');
    const glob = scanned.find(s => s.name === 'unique-global');

    assert.ok(shadow);
    assert.equal(shadow.locationType, 'canonical', 'Canonical wins over consumer and global');

    assert.ok(cons);
    assert.equal(cons.locationType, 'consumer');

    assert.ok(glob);
    assert.equal(glob.locationType, 'global');
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
  }
});

test('AC8: Consumer references document autoloading via {skillsRoot}', () => {
  const refPath = path.resolve(__dirname, '../skills/sdw-router/references/consumer_agents_setup.md');
  const content = fs.readFileSync(refPath, 'utf8');

  assert.ok(content.includes('{skillsRoot}'), 'Documentation specifies {skillsRoot} token');
  assert.ok(content.includes('Hybrid Mode'), 'Documentation covers hybrid mode');
});

test('AC9: Missing skills directory aborts execution with exit code 1', () => {
  const tmpProject = createTempDir('sdw-ac9-proj-');
  const emptyGlobal = createTempDir('sdw-ac9-global-');
  try {
    // Init config with valid specsDir but provide no skills locally or globally
    const sdwDir = path.join(tmpProject, '.sdw');
    fs.mkdirSync(sdwDir, { recursive: true });
    fs.writeFileSync(
      path.join(sdwDir, 'config.json'),
      JSON.stringify({
        specsDir: path.join(tmpProject, '.sdw', 'specs').replace(/\\/g, '/')
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(sdwDir, 'config.schema.json'), JSON.stringify({}, null, 2), 'utf8');
    fs.writeFileSync(path.join(sdwDir, 'directory-structure.md'), '# test', 'utf8');

    // 1. sdw-config check fails with code 1 specifically on skills_root_resolution
    const cliConfig = path.resolve(__dirname, '../skills/sdw-config/scripts/sdw_config.cjs');
    const checkProc = spawnSync(
      process.execPath,
      [cliConfig, 'check', '--root', tmpProject, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: emptyGlobal, USERPROFILE: emptyGlobal, SDW_SKILLS_ROOT: '' }
      }
    );
    assert.equal(checkProc.status, 1, 'sdw-config check aborts with code 1 when no skills exist');
    const checkData = JSON.parse(checkProc.stdout);
    assert.equal(checkData.valid, false);
    const skillsCheck = checkData.checks.find(c => c.name === 'skills_root_resolution');
    assert.ok(skillsCheck);
    assert.equal(skillsCheck.passed, false, 'skills_root_resolution check must fail when no skills exist');

    // 2. sdw-router doctor fails with code 1
    const cliRouter = path.resolve(__dirname, '../skills/sdw-router/scripts/sdw_router.cjs');
    const doctorProc = spawnSync(
      process.execPath,
      [cliRouter, 'doctor', '--root', tmpProject, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: emptyGlobal, USERPROFILE: emptyGlobal }
      }
    );
    assert.equal(doctorProc.status, 1, 'sdw-router doctor aborts with code 1 when no skills exist');
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(emptyGlobal, { recursive: true, force: true });
  }
});

test('AC10: sdw-orch dynamic script resolution locates helper scripts via resolved skillsRoot', () => {
  const tmpProject = createTempDir('sdw-ac10-proj-');
  const tmpGlobal = createTempDir('sdw-ac10-global-');
  try {
    const globalSkills = path.join(tmpGlobal, '.agents', 'skills');
    createDummySkill(globalSkills, 'sdw-code-review');
    createDummySkill(globalSkills, 'sdw-ship-pr');
    createDummySkill(globalSkills, 'sdw-spec');

    // In a project lacking local skills, resolveSkillsRoot points to globalSkills
    const info = sdwConfig.resolveSkillsRoot({
      root: tmpProject,
      homeDir: tmpGlobal,
      ignoreCaller: true
    });

    assert.ok(info);
    assert.equal(info.skillsRoot, globalSkills.replace(/\\/g, '/'));
    assert.equal(info.mode, 'global');

    // Verify scripts resolve via sdw-orch's resolveSkillScript helper
    const crScript = sdwOrch.resolveSkillScript(tmpProject, 'sdw-code-review', path.join('scripts', 'sdw_code_review.cjs'), {
      homeDir: tmpGlobal,
      ignoreCaller: true
    });
    const shipScript = sdwOrch.resolveSkillScript(tmpProject, 'sdw-ship-pr', path.join('scripts', 'sdw_ship_pr.cjs'), {
      homeDir: tmpGlobal,
      ignoreCaller: true
    });
    assert.ok(crScript, 'sdw-code-review script must resolve from global skills');
    assert.equal(crScript, path.join(globalSkills, 'sdw-code-review', 'scripts', 'sdw_code_review.cjs'));
    assert.ok(shipScript, 'sdw-ship-pr script must resolve from global skills');
    assert.equal(shipScript, path.join(globalSkills, 'sdw-ship-pr', 'scripts', 'sdw_ship_pr.cjs'));
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    fs.rmSync(tmpGlobal, { recursive: true, force: true });
  }
});
