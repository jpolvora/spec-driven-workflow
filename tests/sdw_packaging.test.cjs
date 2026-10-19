'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const verifyModule = require('../scripts/verify_skills.cjs');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'verify_skills.cjs');

test('AC1: distributable skills organized under skills/ with valid frontmatter', () => {
  assert.ok(fs.existsSync(SKILLS_DIR), 'skills/ directory exists');
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
  assert.ok(entries.length >= 4, 'at least canonical skills present');
  for (const entry of entries) {
    const mdPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    assert.ok(fs.existsSync(mdPath), `SKILL.md exists for ${entry.name}`);
    const content = fs.readFileSync(mdPath, 'utf8');
    const fm = verifyModule.parseFrontmatter(content);
    assert.ok(fm, `${entry.name}: frontmatter parses`);
    assert.ok(fm.name && String(fm.name).trim(), `${entry.name}: frontmatter has name`);
    assert.ok(fm.description && String(fm.description).trim(), `${entry.name}: frontmatter has description`);
  }
});

test('AC2 & AC3: npx skills discovery layout (flat skills/<name>/SKILL.md, --skill filtering)', () => {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const entry of entries) {
    assert.ok(fs.existsSync(path.join(SKILLS_DIR, entry.name, 'SKILL.md')), `flat layout for ${entry.name}`);
  }
  const result = verifyModule.verifySkills({ root: ROOT });
  assert.equal(result.ok, true);
  const names = result.skills.map(s => s.name).sort();
  assert.ok(names.includes('sdw-router'), 'sdw-router discoverable');
  assert.ok(names.includes('sdw-spec'), 'sdw-spec discoverable');
  const single = result.skills.find(s => s.name === 'sdw-router');
  assert.ok(single, 'targeted --skill sdw-router resolves to single folder');
});

test('AC4: deterministic packaging verification script with zero external deps', () => {
  assert.ok(fs.existsSync(VERIFY_SCRIPT), 'scripts/verify_skills.cjs exists');
  const code = fs.readFileSync(VERIFY_SCRIPT, 'utf8');
  assert.ok(code.includes("'use strict'"), 'CommonJS strict mode');
  const reqs = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const builtins = new Set(require('module').builtinModules.map(m => m.replace(/^node:/, '')));
  for (const req of reqs) {
    if (req.startsWith('.') || req.startsWith('/')) continue;
    const bare = req.replace(/^node:/, '').split('/')[0];
    assert.ok(builtins.has(bare) || builtins.has(req), `only Node stdlib required, found "${req}"`);
  }
  assert.ok(!code.includes('axios') && !code.includes('express'), 'no external runtime deps');
});

test('AC5: verify flag validates three-tier architecture', () => {
  const out = execSync(`node "${VERIFY_SCRIPT}" verify`, { encoding: 'utf8' });
  assert.ok(out.includes('PASS'), 'verify subcommand passes');
  const out2 = execSync(`node "${VERIFY_SCRIPT}" --verify`, { encoding: 'utf8' });
  assert.ok(out2.includes('PASS'), '--verify flag passes');
  const result = verifyModule.verifySkills({ root: ROOT });
  assert.equal(result.ok, true);
  for (const s of result.skills) {
    assert.ok(s.lineCount <= 120, `${s.name} Tier 1 line budget <= 120 (got ${s.lineCount})`);
    const content = fs.readFileSync(path.join(SKILLS_DIR, s.name, 'SKILL.md'), 'utf8');
    assert.ok(/>\s*When this skill is loaded,\s*output/i.test(content), `${s.name} has announcement header`);
    assert.ok(fs.existsSync(path.join(SKILLS_DIR, s.name, 'references')), `${s.name} has references/`);
    assert.ok(fs.existsSync(path.join(SKILLS_DIR, s.name, 'scripts')), `${s.name} has scripts/`);
  }
});

test('AC6: missing SKILL.md aborts with exit 1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-pack-missing-'));
  try {
    fs.mkdirSync(path.join(tmp, 'skills', 'broken-skill'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}', 'utf8');
    const result = verifyModule.verifySkills({ root: tmp });
    assert.equal(result.ok, false, 'fails closed on missing SKILL.md');
    assert.ok(result.errors.some(e => e.skill === 'broken-skill'), 'reports broken skill');
    let code = 0;
    try {
      execSync(`node "${VERIFY_SCRIPT}" --root "${tmp}"`, { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      code = err.status;
    }
    assert.equal(code, 1, 'CLI exits 1 on missing file');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC6: broken frontmatter aborts with exit 1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-pack-front-'));
  try {
    const dir = path.join(tmp, 'skills', 'bad-skill');
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: \ndescription: \n---\n# Bad\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}', 'utf8');
    const result = verifyModule.verifySkills({ root: tmp });
    assert.equal(result.ok, false, 'fails closed on broken frontmatter');
    let code = 0;
    try {
      execSync(`node "${VERIFY_SCRIPT}" --root "${tmp}"`, { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      code = err.status;
    }
    assert.equal(code, 1, 'CLI exits 1 on broken frontmatter');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC7: workflow definitions deferred to spec 011 (no workflow ownership in 006)', () => {
  const code = fs.readFileSync(VERIFY_SCRIPT, 'utf8');
  assert.ok(!code.includes('.github/workflows'), 'verify script does not author workflow YAML');
  assert.ok(!code.includes('actions/checkout'), 'verify script contains no GitHub Actions logic');
  assert.ok(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'ci.yml')), 'ci.yml owned by spec 011 exists');
  assert.ok(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'release.yml')), 'release.yml owned by spec 011 exists');
});
