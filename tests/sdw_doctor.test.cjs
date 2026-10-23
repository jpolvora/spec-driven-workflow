'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runDoctor, runSmokeTest, buildIssueReport, detectInstallation, EXPECTED_SKILLS } = require('../skills/sdw-doctor/scripts/sdw_doctor.cjs');

function makeSkill(skillsRoot, name) {
  const dir = path.join(skillsRoot, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'references', 'notes.md'), '# Notes\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'scripts', 'tool.cjs'), "'use strict';\nconsole.log('ok');\n", 'utf8');
  const rules = name === 'sdw-rules' ? '' : '\n> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md).\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${name}
description: Test skill ${name}.
version: 0.1.0
invocation_names:
  - ${name}
---
# ${name}

> When this skill is loaded, output "${name} loaded."
${rules}
See [notes](references/notes.md).
`, 'utf8');
}

function makeInstall(skillsRoot) {
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const name of EXPECTED_SKILLS) makeSkill(skillsRoot, name);
}

function makeWorkspace(root, options = {}) {
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const config = options.config || { specsDir: '{projectRoot}/.sdw/specs' };
  fs.writeFileSync(path.join(root, '.sdw', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, '.sdw', 'config.schema.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.sdw', 'directory-structure.md'), '# Structure\n', 'utf8');
  fs.writeFileSync(path.join(specsDir, 'index.specs.md'), `# Specification Index

| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |
|---|---|---|---|---|---|---|---|
| 00001 | 00001-demo | Demo | pending | local | 2026-10-21 | PASS | - |
`, 'utf8');
  fs.writeFileSync(path.join(specsDir, '00001-demo.md'), `---
id: null
slug: 00001-demo
title: "Demo"
source: local
status: draft
specDate: 2026-10-21
---
# Specification — Demo
## Description
Demo description.
### Design Intent
Demo intent.
## Acceptance Criteria
- AC1: The system shall demonstrate a doctor check.
## Notes
None.
## Out of Scope
| Feature | Reason |
|---|---|
| Out | Scope |
## Assumptions & Open Questions
| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| A | B | C | y |
## Definition of Ready (DoR)
| Readiness Item | Requirement | Verification Method |
|---|---|---|
| R | V | M |
## Validation & Observation Notes
### Telemetry & Observable Signals
- Signals
### Negative & Failing Test Scenarios
- Rejection of invalid input
`, 'utf8');
}

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-doctor-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-doctor-home-'));
  return { root, home };
}

test('sdw-doctor: upstream detection wins over global install', () => {
  const { root, home } = tempDirs();
  try {
    makeInstall(path.join(root, 'skills'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'spec-driven-workflow', version: '0.0.0' }), 'utf8');
    makeInstall(path.join(home, '.agents', 'skills'));
    const detected = detectInstallation(root, home);
    assert.equal(detected.mode, 'upstream');
    assert.ok(detected.skillsRoot.endsWith(path.join('root', 'skills').split(path.sep).pop()));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sdw-doctor: vendored skills without the upstream marker are not treated as upstream', () => {
  const { root, home } = tempDirs();
  try {
    makeInstall(path.join(root, 'skills'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'consumer-app' }), 'utf8');
    const detected = detectInstallation(root, home);
    assert.notEqual(detected.mode, 'upstream');
    assert.equal(detected.mode, 'missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sdw-doctor: consumer-local install passes with valid workspace', () => {
  const { root, home } = tempDirs();
  try {
    makeInstall(path.join(root, '.agents', 'skills'));
    makeWorkspace(root);
    const result = runDoctor({ root, homeDir: home });
    assert.equal(result.mode, 'consumer-local');
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.presentSkills.length, EXPECTED_SKILLS.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Spec 00060 AC11: a report companion still sitting in the specification directory
// is a legacy location. Doctor names the move target and stays green.
test('00060 AC11: a legacy report companion is an advisory with its move target, never an audit failure', () => {
  const { root, home } = tempDirs();
  try {
    makeInstall(path.join(root, '.agents', 'skills'));
    makeWorkspace(root);
    const specsDir = path.join(root, '.sdw', 'specs');
    fs.writeFileSync(path.join(specsDir, '00001-demo-report.md'), '# Delivery Report — Demo\n', 'utf8');

    const legacy = runDoctor({ root, homeDir: home });
    assert.equal(legacy.ok, true, JSON.stringify(legacy.findings));
    const advisory = legacy.findings.find(f => f.code === 'spec-report-legacy-location');
    assert.ok(advisory, 'the legacy companion is reported');
    assert.equal(advisory.level, 'warning', 'the advisory never fails the audit');
    assert.equal(advisory.subject, '00001-demo-report.md');
    assert.match(advisory.message, /\.sdw\/reports\/00001-demo-report\.md/, 'the advisory carries the move target');
    assert.ok(!legacy.findings.some(f => f.level === 'error' && f.subject === '00001-demo-report.md'), 'the report is never audited as a specification');

    // A relocated report is silent, and a stale report row neither demands a file nor
    // fails the audit: a report row is never a specification row.
    fs.mkdirSync(path.join(root, '.sdw', 'reports'), { recursive: true });
    fs.renameSync(path.join(specsDir, '00001-demo-report.md'), path.join(root, '.sdw', 'reports', '00001-demo-report.md'));
    const indexPath = path.join(specsDir, 'index.specs.md');
    fs.writeFileSync(indexPath, `${fs.readFileSync(indexPath, 'utf8')}| 00002 | 00002-legacy-report | Delivery Report — Legacy | completed | local | 2026-10-22 | FAIL | - |\n`, 'utf8');

    const relocated = runDoctor({ root, homeDir: home });
    assert.equal(relocated.ok, true, JSON.stringify(relocated.findings));
    assert.ok(!relocated.findings.some(f => f.code === 'spec-report-legacy-location'), 'a relocated report is not flagged');
    assert.ok(!relocated.findings.some(f => f.code === 'spec-file-missing' && f.subject === '00002-legacy-report'), 'a stale report row is not a missing specification');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sdw-doctor: hybrid mode checks the global install quickly', () => {
  const { root, home } = tempDirs();
  try {
    makeInstall(path.join(home, '.agents', 'skills'));
    makeWorkspace(root);
    const result = runDoctor({ root, homeDir: home });
    assert.equal(result.mode, 'hybrid');
    assert.equal(result.globalRoot, path.join(home, '.agents', 'skills').replace(/\\/g, '/'));
    assert.equal(result.ok, true, JSON.stringify(result.findings));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sdw-doctor: missing install reports npx remediation and stops', () => {
  const { root, home } = tempDirs();
  try {
    const result = runDoctor({ root, homeDir: home });
    assert.equal(result.mode, 'missing');
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(f => f.code === 'installation-missing'));
    assert.ok(result.remediation.some(line => line.includes('npx skills add')));
    assert.ok(result.remediation.some(line => line.startsWith('Stop:')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sdw-doctor: missing skill is an error with reinstall advice', () => {
  const { root, home } = tempDirs();
  try {
    makeInstall(path.join(root, '.agents', 'skills'));
    fs.rmSync(path.join(root, '.agents', 'skills', 'sdw-orch', 'SKILL.md'));
    makeWorkspace(root);
    const result = runDoctor({ root, homeDir: home });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(f => f.code === 'skill-missing' && f.subject === 'sdw-orch'));
    assert.ok(result.remediation.some(line => line.includes('npx skills add')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sdw-doctor: invalid config suggests sdw-config remediation', () => {
  const { root, home } = tempDirs();
  try {
    makeInstall(path.join(root, '.agents', 'skills'));
    makeWorkspace(root, { config: { scoreMin: 8 } });
    const result = runDoctor({ root, homeDir: home });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(f => f.code === 'workspace-config-schema'));
    assert.ok(result.remediation.some(line => line.includes('sdw-config/scripts/sdw_config.cjs init')));
    assert.ok(result.remediation.some(line => line.includes('sdw_config.cjs check')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sdw-doctor: canonical repository passes the upstream audit', () => {
  const repoRoot = path.join(__dirname, '..');
  const result = runDoctor({ root: repoRoot, homeDir: path.join(os.tmpdir(), 'sdw-doctor-unused-home') });
  assert.equal(result.mode, 'upstream');
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.presentSkills.length, EXPECTED_SKILLS.length);
});

test('sdw-doctor: issue report captures errors and suggestions', () => {
  const report = buildIssueReport({
    mode: 'smoke',
    projectRoot: '/tmp/project',
    skillsRoot: '/tmp/skills',
    exitCode: 1,
    runId: 'run-1',
    stateStatus: 'failed',
    errors: [{ step: 4, error: 'Verification Gate failed' }],
    suggestions: ['Fix the test command'],
    stdout: '',
    stderr: 'boom'
  });
  assert.match(report, /Verification Gate failed/);
  assert.match(report, /Fix the test command/);
});

test('sdw-doctor test: sandbox smoke pipeline completes every step', () => {
  const repoRoot = path.join(__dirname, '..');
  const result = runSmokeTest({ root: repoRoot, timeoutMs: 180000 });
  assert.equal(result.ok, true, JSON.stringify({ errors: result.errors, stderr: result.stderr.slice(-2000) }, null, 2));
  assert.equal(result.stateStatus, 'completed');
  assert.equal(result.steps['8'], 'completed');
  assert.equal(result.exitCode, 0);
});
