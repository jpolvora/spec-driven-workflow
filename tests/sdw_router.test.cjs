'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwRouter = require('../skills/sdw-router/scripts/sdw_router.cjs');

test('AC1 & AC2: Autoloaded Router & Minimal Context Budget (SKILL.md <= 120 lines)', () => {
  const skillPath = path.resolve(__dirname, '../skills/sdw-router/SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'SKILL.md exists in skills/sdw-router/');

  const content = fs.readFileSync(skillPath, 'utf8');
  const lines = content.split(/\r?\n/);
  assert.ok(lines.length <= 120, `SKILL.md must be <= 120 lines for minimal context budget. Current: ${lines.length}`);

  // Announcement heading
  assert.ok(content.includes('> When this skill is loaded, output "sdw-router loaded."'), 'Contains required load announcement');

  // Frontmatter
  const meta = sdwRouter.parseFrontmatter(content);
  assert.equal(meta.name, 'sdw-router');
  assert.equal(meta.version, '0.1.0');
  assert.ok(Array.isArray(meta.invocation_names));
  assert.ok(meta.invocation_names.includes('sdw-router'));
  assert.ok(meta.invocation_names.includes('router'));
});

test('AC3: Route project configuration & environment verification intents to sdw-config', () => {
  const prompts = [
    'Check the .sdw workspace configuration',
    'Verify environment and parse config.json settings',
    'Initialize sdw workspace in this directory'
  ];

  for (const p of prompts) {
    const res = sdwRouter.routePrompt(p);
    assert.equal(res.matched, true, `Should match prompt: "${p}"`);
    assert.equal(res.targetSkill, 'sdw-config', `Expected sdw-config for prompt: "${p}"`);
    assert.ok(res.confidence > 0, 'Confidence should be positive');
  }
});

test('AC4: Route specification authoring, formatting, listing, and archiving to sdw-spec', () => {
  const prompts = [
    'Author a new specification for customer invoicing',
    'Validate spec against EARS syntax rules',
    'List all specs registered in index.specs.md',
    'Archive completed specification 00001-sdw-implement-initial-version'
  ];

  for (const p of prompts) {
    const res = sdwRouter.routePrompt(p);
    assert.equal(res.matched, true, `Should match prompt: "${p}"`);
    assert.equal(res.targetSkill, 'sdw-spec', `Expected sdw-spec for prompt: "${p}"`);
  }
});

test('AC5: Route specification implementation, orchestration, and resumption to sdw-run', () => {
  const prompts = [
    'Start workflow to implement spec 00003-sdw-router-skill',
    'Resume orchestrator execution for run-1792396125490',
    'Check sdw-run status and conformance score of active delivery'
  ];

  for (const p of prompts) {
    const res = sdwRouter.routePrompt(p);
    assert.equal(res.matched, true, `Should match prompt: "${p}"`);
    assert.equal(res.targetSkill, 'sdw-run', `Expected sdw-run for prompt: "${p}"`);
  }
});

test('AC6: Explicit skill invocations honored directly', () => {
  const testCases = [
    { prompt: '/sdw-config check', expected: 'sdw-config' },
    { prompt: '@sdw-spec new "Create user profile"', expected: 'sdw-spec' },
    { prompt: '/sdw-run run .sdw/specs/003.md', expected: 'sdw-run' },
    { prompt: '/sdw-run status', expected: 'sdw-run' }
  ];

  for (const tc of testCases) {
    const res = sdwRouter.routePrompt(tc.prompt);
    assert.equal(res.matched, true);
    assert.equal(res.targetSkill, tc.expected);
    assert.equal(res.confidence, 1.0, 'Explicit invocation should have confidence 1.0');
    assert.equal(res.reason, 'explicit_invocation');
  }
});

test('AC7: Tied confidence disambiguation queries user with recommended default', () => {
  // "spec config" contains equal weights for sdw-spec and sdw-config
  const res = sdwRouter.routePrompt('spec config');
  assert.equal(res.matched, true);
  assert.equal(res.isAmbiguous, true, 'Flags tie as ambiguous');
  assert.ok(Array.isArray(res.candidates));
  assert.ok(res.candidates.includes('sdw-config'));
  assert.ok(res.candidates.includes('sdw-spec'));
  assert.ok(res.clarification, 'Provides clarification structure');
  assert.ok(res.clarification.question, 'Includes clarification question');
  assert.ok(res.clarification.options.length >= 2, 'Has candidate options');
  assert.ok(res.clarification.options.some(opt => opt.includes('(Recommended)')), 'Marks recommended default');
});

test('AC8: Missing or unreadable skill directory reports actionable resolution error', () => {
  // Test 1: Explicit invocation of non-existent skill
  const res = sdwRouter.routePrompt('/sdw-nonexistent');
  assert.equal(res.matched, true);
  assert.equal(res.hasError, true);
  assert.ok(res.error.includes('missing or unreadable on disk'), 'Actionable error for missing skill');
  assert.ok(res.error.includes('sdw-nonexistent'));

  // Test 2: In a temporary root where sdw-config directory has no SKILL.md
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-router-test-'));
  try {
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'sdw-config'), { recursive: true });
    // Note: SKILL.md is deliberately not created

    const resTemp = sdwRouter.routePrompt('/sdw-config check', { root: tmpDir });
    assert.equal(resTemp.hasError, true);
    assert.ok(resTemp.error.includes('missing or unreadable on disk'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC9: Deterministic CLI helper subcommands (scan, route, doctor)', () => {
  const cliScript = path.resolve(__dirname, '../skills/sdw-router/scripts/sdw_router.cjs');
  assert.ok(fs.existsSync(cliScript), 'CLI script exists');

  // scan --json
  const scanOut = execSync(`node "${cliScript}" scan --json`, { encoding: 'utf8' });
  const scanData = JSON.parse(scanOut);
  assert.ok(scanData.total > 0);
  assert.ok(Array.isArray(scanData.skills));
  assert.ok(scanData.skills.some(s => s.name === 'sdw-router'));

  // route --json
  const routeOut = execSync(`node "${cliScript}" route "parse config.json" --json`, { encoding: 'utf8' });
  const routeData = JSON.parse(routeOut);
  assert.equal(routeData.matched, true);
  assert.equal(routeData.targetSkill, 'sdw-config');

  // doctor --json
  const doctorOut = execSync(`node "${cliScript}" doctor --json`, { encoding: 'utf8' });
  const docData = JSON.parse(doctorOut);
  assert.equal(docData.passed, true);
  assert.ok(docData.skillsCount >= 4);
});

test('AC10: Discovers skills in both canonical (skills/) and consumer (.agents/skills/) directories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-disc-test-'));
  try {
    const canonDir = path.join(tmpDir, 'skills', 'my-canon-skill');
    const consDir = path.join(tmpDir, '.agents', 'skills', 'my-cons-skill');

    fs.mkdirSync(canonDir, { recursive: true });
    fs.mkdirSync(consDir, { recursive: true });

    fs.writeFileSync(path.join(canonDir, 'SKILL.md'), '---\nname: my-canon-skill\n---\n# Canon\n', 'utf8');
    fs.writeFileSync(path.join(consDir, 'SKILL.md'), '---\nname: my-cons-skill\n---\n# Cons\n', 'utf8');

    const discovered = sdwRouter.scanSkills({ root: tmpDir, homeDir: null });
    assert.equal(discovered.length, 2);

    const canon = discovered.find(s => s.name === 'my-canon-skill');
    const cons = discovered.find(s => s.name === 'my-cons-skill');

    assert.ok(canon, 'Discovers canonical skill');
    assert.equal(canon.locationType, 'canonical');

    assert.ok(cons, 'Discovers consumer skill');
    assert.equal(cons.locationType, 'consumer');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC11: Documents consumer AGENTS.md setup in references', () => {
  const refPath = path.resolve(__dirname, '../skills/sdw-router/references/consumer_agents_setup.md');
  assert.ok(fs.existsSync(refPath), 'consumer_agents_setup.md exists');

  const content = fs.readFileSync(refPath, 'utf8');
  assert.ok(content.includes('AGENTS.md'), 'References AGENTS.md setup');
  assert.ok(content.includes('sdw-router'), 'Explains sdw-router configuration');
  assert.ok(content.includes('progressive disclosure') || content.includes('context budget'), 'Explains context budget benefits');
});

test('AC12: Passive non-interference pass-through for unrecognized / general prompts', () => {
  const genericPrompts = [
    'Adjust the padding and margin in header navbar CSS',
    'Fix null pointer exception in payment calculation module',
    'Write a quick helper function to format currency in EUR'
  ];

  for (const p of genericPrompts) {
    const res = sdwRouter.routePrompt(p);
    assert.equal(res.matched, false, `Should not match generic prompt: "${p}"`);
    assert.equal(res.passThrough, true, `Pass-through should be true for: "${p}"`);
  }
});

test('AC13: Harness and agent agnosticism (pure Node.js 22 built-ins)', () => {
  const scriptPath = path.resolve(__dirname, '../skills/sdw-router/scripts/sdw_router.cjs');
  const code = fs.readFileSync(scriptPath, 'utf8');

  // Verify no external require calls
  const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const allowedBuiltins = new Set(['fs', 'path', 'process', 'child_process', 'os']);

  for (const req of requires) {
    assert.ok(allowedBuiltins.has(req), `Requires must only be Node builtins. Found: "${req}"`);
  }
});
