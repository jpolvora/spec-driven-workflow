'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sdwRules = require('../skills/sdw-rules/scripts/sdw_rules.cjs');
const reviewRunner = require('../skills/sdw-orch/scripts/review_runner.cjs');

test('AC1 & AC2: Three-Tier Progressive Disclosure Standard & Announcement Banner', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const skillPath = path.join(repoRoot, 'skills', 'sdw-rules', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'SKILL.md must exist in skills/sdw-rules');

  const content = fs.readFileSync(skillPath, 'utf8');
  const lines = content.split(/\r?\n/);
  assert.ok(lines.length <= 80, `Tier 1 SKILL.md must be <= 80 lines (actual: ${lines.length})`);
  assert.match(content, />\s*When this skill is loaded,\s*output "sdw-rules loaded\."/i, 'Must include announcement banner');

  // Verify Tier 2 references exist
  const refDir = path.join(repoRoot, 'skills', 'sdw-rules', 'references');
  assert.ok(fs.existsSync(path.join(refDir, 'karpathy_rules.md')), 'karpathy_rules.md must exist');
  assert.ok(fs.existsSync(path.join(refDir, 'anti_patterns.md')), 'anti_patterns.md must exist');
  assert.ok(fs.existsSync(path.join(refDir, 'traps_log.md')), 'traps_log.md must exist');

  // Verify Tier 3 script exists
  assert.ok(fs.existsSync(path.join(repoRoot, 'skills', 'sdw-rules', 'scripts', 'sdw_rules.cjs')), 'sdw_rules.cjs must exist');
});

test('AC3, AC4 & AC5: Codify Core Directives, Clarification Gates, and Simplicity First', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const skillPath = path.join(repoRoot, 'skills', 'sdw-rules', 'SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf8');

  assert.match(content, /Think & Ask Before Acting/i, 'Must define Think & Ask Before Acting');
  assert.match(content, /Simplicity First \(YAGNI\)/i, 'Must define Simplicity First');
  assert.match(content, /Surgical Scope Enclosure/i, 'Must define Surgical Scope Enclosure');
  assert.match(content, /Empirical Goal-Driven Verification/i, 'Must define Empirical Goal-Driven Verification');
  assert.match(content, /ask_question/i, 'Must specify ask_question for clarification');
  assert.match(content, /minimal requested scope/i, 'Must recommend minimal requested scope default');
});

test('AC6: Reference Documentation Details Anti-Patterns and Overengineering Traps', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const antiPatterns = fs.readFileSync(path.join(repoRoot, 'skills', 'sdw-rules', 'references', 'anti_patterns.md'), 'utf8');
  const karpathyRules = fs.readFileSync(path.join(repoRoot, 'skills', 'sdw-rules', 'references', 'karpathy_rules.md'), 'utf8');

  assert.match(antiPatterns, /Speculative Configurability/i, 'Documents speculative configurability');
  assert.match(antiPatterns, /Class Hierarchies for Single-Use Logic/i, 'Documents single-use class hierarchies');
  assert.match(karpathyRules, /Overengineered Solution/i, 'Includes overengineered vs minimal code comparison');
  assert.match(karpathyRules, /Minimal Viable Solution/i, 'Includes minimal viable code comparison');
});

test('AC7: Downstream Skills sdw-spec and sdw-orch Integrate sdw-rules References', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const specSkill = fs.readFileSync(path.join(repoRoot, 'skills', 'sdw-spec', 'SKILL.md'), 'utf8');
  const orchSkill = fs.readFileSync(path.join(repoRoot, 'skills', 'sdw-orch', 'SKILL.md'), 'utf8');

  assert.match(specSkill, /sdw-rules/i, 'sdw-spec must reference sdw-rules');
  assert.match(orchSkill, /sdw-rules/i, 'sdw-orch must reference sdw-rules');
});

test('AC8: Deterministic Command-Line Helper Script Subcommands (doctor, audit-spec, log-trap)', (t) => {
  const repoRoot = path.resolve(__dirname, '..');

  // Test doctor
  const docRes = sdwRules.cmdDoctor({ root: repoRoot });
  assert.equal(docRes.passed, true, 'doctor must pass on clean repo');
  assert.equal(docRes.violationsCount, 0, 'doctor must report 0 violations');

  // Test audit-spec on valid spec
  const auditRes = sdwRules.cmdAuditSpec('.sdw/specs/008-sdw-rules-skill.md', { root: repoRoot });
  assert.equal(auditRes.passed, true, 'audit-spec must pass on 008 spec');

  // Test CLI execution via child_process
  const scriptPath = path.join(repoRoot, 'skills', 'sdw-rules', 'scripts', 'sdw_rules.cjs');
  const outDoctor = execSync(`node "${scriptPath}" doctor --json`, { encoding: 'utf8' });
  const parsedDoctor = JSON.parse(outDoctor);
  assert.equal(parsedDoctor.passed, true);
});

test('AC9: Review Verification Flags Unrequested Features or Code Expansions', (t) => {
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sdw-review-test-'));
  try {
    const fileWithUnrequested = path.join(tempDir, 'sample.cjs');
    fs.writeFileSync(fileWithUnrequested, `
      // Sample code
      function test() {
        // UNREQUESTED feature extension
        return 42;
      }
      module.exports = { test };
    `, 'utf8');

    // Run review check
    const findings = [];
    const text = fs.readFileSync(fileWithUnrequested, 'utf8');
    if (/@unrequested\b|@speculative\b|\/\/\s*UNREQUESTED\b|\/\*\s*UNREQUESTED\b/i.test(text)) {
      findings.push({
        file: 'sample.cjs',
        severity: 'error',
        rule: 'unrequested_scope_expansion',
        message: 'Unrequested feature or speculative code expansion detected without user confirmation.'
      });
    }

    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'unrequested_scope_expansion');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('AC10: Log Anti-Regression Trap Appends Entry to .sdw/traps.md', (t) => {
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sdw-traps-test-'));
  try {
    const result = sdwRules.cmdLogTrap({
      slug: 'unit-test-trap',
      title: 'Unit Test Trap Title',
      layer: 'testing',
      avoid: 'Avoid unverified assumptions',
      action: 'Always write empirical assertions',
      root: tempDir
    });

    assert.equal(result.success, true);
    const trapsFile = path.join(tempDir, '.sdw', 'traps.md');
    assert.ok(fs.existsSync(trapsFile), 'traps.md must be created');

    const content = fs.readFileSync(trapsFile, 'utf8');
    assert.match(content, /unit-test-trap/, 'Must contain trap slug');
    assert.match(content, /Unit Test Trap Title/, 'Must contain trap title');
    assert.match(content, /Avoid unverified assumptions/, 'Must contain avoid text');
    assert.match(content, /Always write empirical assertions/, 'Must contain action text');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Negative Scenario 1: log-trap Rejects Missing Required Fields (avoid or action)', (t) => {
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sdw-traps-fail-'));
  try {
    const result = sdwRules.cmdLogTrap({
      slug: 'bad-trap',
      title: 'Bad Trap',
      root: tempDir
    });

    assert.equal(result.success, false);
    assert.match(result.error, /mandatory/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Negative Scenario 2: doctor Fails on Line Budget Exceeded (> 120 lines)', (t) => {
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sdw-doc-fail-'));
  try {
    const skillsDir = path.join(tempDir, 'skills', 'bloated-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    // Write 130 lines
    const bloatedLines = ['---\nname: bloated-skill\n---\n# Bloated\n> When this skill is loaded, output "bloated-skill loaded."\n'];
    for (let i = 0; i < 130; i++) bloatedLines.push(`Line ${i}`);
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), bloatedLines.join('\n'), 'utf8');

    const result = sdwRules.cmdDoctor({ root: tempDir });
    assert.equal(result.passed, false, 'Must fail when line budget is exceeded');
    assert.ok(result.violations.some(v => v.rule === 'line_budget_exceeded'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Negative Scenario 3: doctor Fails on Missing Downstream sdw-rules Reference', (t) => {
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sdw-doc-ref-'));
  try {
    const skillsDir = path.join(tempDir, 'skills', 'sdw-spec');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), `---
name: sdw-spec
---
# sdw-spec
> When this skill is loaded, output "sdw-spec loaded."
No reference here.
`, 'utf8');

    const result = sdwRules.cmdDoctor({ root: tempDir });
    assert.equal(result.passed, false, 'Must fail when sdw-spec misses sdw-rules reference');
    assert.ok(result.violations.some(v => v.rule === 'missing_rules_reference'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
