'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const secChecks = require('../skills/sdw-security-checks/scripts/sdw_security_checks.cjs');
const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

test('sdw-security-checks - AC1 & AC2: Tier 1 SKILL.md layout and announcement banner', () => {
  const skillPath = path.resolve(__dirname, '../skills/sdw-security-checks/SKILL.md');
  assert.strictEqual(fs.existsSync(skillPath), true, 'SKILL.md must exist');

  const content = fs.readFileSync(skillPath, 'utf8');
  const lines = content.split(/\r?\n/);
  assert.ok(lines.length <= 120, `SKILL.md line count (${lines.length}) must be <= 120`);
  assert.ok(content.includes('> When this skill is loaded, output "sdw-security-checks loaded."'), 'Must contain exact loaded banner');
});

test('sdw-security-checks - AC14: Reference documentation catalog', () => {
  const catalogPath = path.resolve(__dirname, '../skills/sdw-security-checks/references/pattern_catalog.md');
  const contractPath = path.resolve(__dirname, '../skills/sdw-security-checks/references/integration_contract.md');
  assert.strictEqual(fs.existsSync(catalogPath), true, 'pattern_catalog.md must exist');
  assert.strictEqual(fs.existsSync(contractPath), true, 'integration_contract.md must exist');

  const catalogContent = fs.readFileSync(catalogPath, 'utf8');
  assert.ok(catalogContent.includes('AKIA'), 'Catalog must include AWS patterns');
  assert.ok(catalogContent.includes('allowlist secret'), 'Catalog must describe allowlist secret pragma');
  assert.ok(catalogContent.includes('.env'), 'Catalog must describe sensitive files');
});

test('sdw-security-checks - AC3 & AC4: securityChecksEnabled config schema and validation', () => {
  // Default config has securityChecksEnabled: false
  assert.strictEqual(sdwConfig.DEFAULT_CONFIG.securityChecksEnabled, false);

  // Valid boolean config
  const validRes = sdwConfig.validateConfigSchema({
    specsDir: '{projectRoot}/.sdw/specs',
    securityChecksEnabled: true
  });
  assert.strictEqual(validRes.valid, true);

  // Invalid non-boolean config must fail validation
  const invalidRes = sdwConfig.validateConfigSchema({
    specsDir: '{projectRoot}/.sdw/specs',
    securityChecksEnabled: 'true' // string instead of boolean
  });
  assert.strictEqual(invalidRes.valid, false);
  assert.ok(invalidRes.errors.some(e => e.includes('securityChecksEnabled') && e.includes('must be a boolean')));
});

test('sdw-security-checks - AC8 & AC13: HIGH severity leaks detection and raw secret redaction', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sec-test-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    // Create a file containing an AWS key and a Slack token
    const fakeKey = 'AKIA' + '1234567890ABCDEF';
    const fakeSlack = 'xoxb-' + '123456789012-1234567890123-abcdefghijklmnopqrstuvwx';
    fs.writeFileSync(path.join(tmpDir, 'service.js'), `
      const awsKey = "${fakeKey}";
      const slack = "${fakeSlack}";
    `, 'utf8');

    const result = secChecks.scan({ root: tmpDir, staged: false });
    assert.strictEqual(result.exitCode, 1, 'HIGH severity finding must cause exit code 1');
    assert.strictEqual(result.severityCounts.high >= 2, true, 'Must detect at least 2 HIGH findings');

    // Verify raw secret values are NOT in the findings objects (AC13)
    for (const f of result.findings) {
      assert.ok(f.file, 'Finding must contain file path');
      assert.ok(f.line, 'Finding must contain line number');
      assert.ok(f.type, 'Finding must contain type');
      assert.ok(f.severity, 'Finding must contain severity');
      assert.strictEqual(f.raw, undefined, 'Finding must NOT contain raw secret field');
      assert.strictEqual(JSON.stringify(f).includes(fakeKey), false, 'Report must not leak raw secret key');
      assert.strictEqual(JSON.stringify(f).includes(fakeSlack), false, 'Report must not leak raw slack token');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-security-checks - False-positive suppression via allowlist secret pragma', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sec-test-pragma-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    const fakeKey = 'AKIA' + '9999999999ZZZZZZ';
    fs.writeFileSync(path.join(tmpDir, 'mock.js'), `
      const TEST_KEY = "${fakeKey}"; // pragma: allowlist secret
    `, 'utf8');

    const result = secChecks.scan({ root: tmpDir, staged: false });
    assert.strictEqual(result.exitCode, 0, 'Suppressed secret line must not trigger finding');
    assert.strictEqual(result.severityCounts.high, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-security-checks - AC10: MEDIUM severity warnings do not block by default', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sec-test-medium-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    // Bearer token is MEDIUM severity
    fs.writeFileSync(path.join(tmpDir, 'request.js'), `
      const auth = "Bearer 1234567890123456789012345678901234567890";
    `, 'utf8');

    const result = secChecks.scan({ root: tmpDir, staged: false, failOn: 'high' });
    assert.strictEqual(result.exitCode, 0, 'MEDIUM severity findings must not block when failOn is high');
    assert.strictEqual(result.severityCounts.medium >= 1, true);

    // When failOn is medium, it blocks
    const resultFailMedium = secChecks.scan({ root: tmpDir, staged: false, failOn: 'medium' });
    assert.strictEqual(resultFailMedium.exitCode, 1, 'MEDIUM severity findings must block when failOn is medium');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-security-checks - Sensitive filenames detection', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sec-test-files-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmpDir, '.env'), 'VAR=SECRET', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'credentials.json'), '{}', 'utf8');

    const result = secChecks.scan({ root: tmpDir, staged: false });
    assert.strictEqual(result.exitCode, 1);
    const types = result.findings.map(f => f.type);
    assert.ok(types.some(t => t.includes('.env')), 'Must detect .env');
    assert.ok(types.some(t => t.includes('Credentials file')), 'Must detect credentials.json');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-security-checks - AC15: Staged diff scanning', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sec-test-staged-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    // Initial clean commit
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'Hello', 'utf8');
    execSync('git add readme.txt', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: tmpDir, stdio: 'ignore' });

    // Empty staged set: exit 0
    const emptyResult = secChecks.scan({ root: tmpDir, staged: true });
    assert.strictEqual(emptyResult.exitCode, 0);
    assert.strictEqual(emptyResult.empty, true);

    // Stage a secret
    const fakeKey = 'AKIA' + 'ABCDEF0123456789';
    fs.writeFileSync(path.join(tmpDir, 'api.js'), `const key = "${fakeKey}";`, 'utf8');
    execSync('git add api.js', { cwd: tmpDir, stdio: 'ignore' });

    const stagedResult = secChecks.scan({ root: tmpDir, staged: true });
    assert.strictEqual(stagedResult.exitCode, 1);
    assert.strictEqual(stagedResult.severityCounts.high, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-security-checks - AC9: Fail-closed on scanner execution error', () => {
  const invalidDir = path.join(os.tmpdir(), 'non-existent-sdw-dir-' + Date.now());
  const result = secChecks.scan({ root: invalidDir });
  assert.strictEqual(result.exitCode, 2, 'Execution failure must exit code 2 (fail-closed)');
  assert.ok(result.error);
});

test('sdw-security-checks - AC18: .gitignore advisories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sec-test-gi-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n', 'utf8');

    const result = secChecks.scan({ root: tmpDir, staged: false });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.advisories.length > 0, 'Must produce advisories for missing secrets patterns');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sdw-security-checks - AC6, AC8, AC12: sdw-orch security gate enforcement & bypass', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-orch-sec-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    // Initialize sdw layout
    sdwConfig.cmdInit({ root: tmpDir, force: true });

    // Create a dummy spec
    const specPath = path.join(tmpDir, '.sdw', 'specs', 'dummy-sec.md');
    fs.writeFileSync(specPath, `---
slug: dummy-sec
title: Dummy Sec Spec
---
# Dummy Sec Spec
## Description
Spec for testing security checks gate.
## Acceptance Criteria
- AC1: The system shall pass.
## Notes
None
## Out of Scope
| Feature | Reason |
|---|---|
| None | None |
## Assumptions & Open Questions
| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| None | None | None | y |
## Definition of Ready (DoR)
| Readiness Item | Requirement | Verification Method |
|---|---|---|
| None | None | None |
## Validation & Observation Notes
### Telemetry & Observable Signals
None
### Negative & Failing Test Scenarios
None
`, 'utf8');

    // Initial commit
    execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

    // Configure securityChecksEnabled: true
    const configPath = path.join(tmpDir, '.sdw', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.securityChecksEnabled = true;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    // Stage a secret
    const fakeKey = 'AKIA' + 'BLOCKTHISKEY1234';
    fs.writeFileSync(path.join(tmpDir, 'leak.js'), `const k = "${fakeKey}";`, 'utf8');
    execSync('git add leak.js', { cwd: tmpDir, stdio: 'ignore' });

    // Run orchestrator - must be BLOCKED by security gate (AC8)
    const runBlockedCode = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      minScore: 0,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(runBlockedCode, 1, 'Must be blocked with exit code 1');

    // Run with --skip-security - must bypass gate and succeed (AC12)
    const runBypassCode = sdwOrch.cmdRun({
      specPath,
      root: tmpDir,
      minScore: 0,
      skipSecurity: true,
      skipReview: true,
      skipPr: true
    });
    assert.strictEqual(runBypassCode, 0, 'Must succeed when --skip-security is provided');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
