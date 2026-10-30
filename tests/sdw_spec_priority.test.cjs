'use strict';

// Spec 00072 — priority ordering. Covers AC1..AC8 (task-1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { validate, normalizePriority } = require('../skills/sdw-spec/scripts/validate_spec.cjs');
const { initIndex, readIndex, registerSpec, writeIndex, listIndex } = require('../skills/sdw-spec/scripts/spec_index.cjs');
const { syncIndex } = require('../skills/sdw-spec/scripts/spec_sync.cjs');

const CLI = path.join(__dirname, '..', 'skills', 'sdw-spec', 'scripts', 'sdw_spec.cjs');

function setupWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-spec-priority-'));
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

function specText(slug, priority) {
  const priorityLine = priority === null || priority === undefined ? '' : `priority: ${priority}\n`;
  return `---
id: null
slug: ${slug}
title: "${slug}"
source: local
${priorityLine}status: draft
specDate: 2026-10-29
---
# Specification — ${slug}
## Description
Priority fixture.
### Design Intent
Keep the fixture minimal.
## Acceptance Criteria
- AC1: The system shall expose a priority rank.
## Notes
None.
## Out of Scope
| Feature | Reason |
|---|---|
| Extra | Out of scope |
## Assumptions & Open Questions
| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Default | Value | Sound rationale | y |
## Definition of Ready (DoR)
| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Ready | Valid | Check |
## Validation & Observation Notes
### Telemetry & Observable Signals
- Signals
### Negative & Failing Test Scenarios
- Rejection of invalid input
`;
}

test('AC1: validator accepts high, medium, and low', () => {
  for (const priority of ['high', 'medium', 'low']) {
    const result = validate(specText('00001-priority-fixture', priority));
    assert.equal(result.ok, true, `${priority} must validate: ${JSON.stringify(result.errors)}`);
  }
});

test('AC2: an absent priority validates and reads as medium', () => {
  const result = validate(specText('00001-priority-fixture', null));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(normalizePriority(undefined), 'medium');
  assert.equal(normalizePriority(''), 'medium');

  const { tmpDir, specsDir } = setupWorkspace();
  try {
    fs.writeFileSync(path.join(specsDir, '00001-priority-fixture.md'), specText('00001-priority-fixture', null));
    initIndex({ root: tmpDir });
    const { entries } = readIndex({ root: tmpDir });
    assert.equal(entries[0].priority, 'medium');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC2: a legacy registry without a Priority column parses every row as medium', () => {
  const { tmpDir } = setupWorkspace();
  try {
    const legacy = `# Specification Index\n\n## Specifications\n\n` +
      `| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |\n` +
      `|---|---|---|---|---|---|---|---|\n` +
      `| 00001 | 00001-legacy | Legacy | pending | local | 2026-10-19 | PASS | - |\n`;
    fs.writeFileSync(path.join(tmpDir, '.sdw', 'specs', 'index.specs.md'), legacy, 'utf8');
    const { entries } = readIndex({ root: tmpDir });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].priority, 'medium');
    assert.equal(entries[0].status, 'pending');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC3: an unknown priority fails validation and names the allowed values', () => {
  const result = validate(specText('00001-priority-fixture', 'urgent'));
  assert.equal(result.ok, false);
  const finding = result.errors.find((error) => error.code === 'priority');
  assert.ok(finding, 'priority finding present');
  assert.match(finding.message, /high/);
  assert.match(finding.message, /medium/);
  assert.match(finding.message, /low/);
});

test('AC4: sync writes a Priority value for every registry row', () => {
  const { tmpDir, specsDir } = setupWorkspace();
  try {
    fs.writeFileSync(path.join(specsDir, '00001-high.md'), specText('00001-high', 'high'));
    fs.writeFileSync(path.join(specsDir, '00002-default.md'), specText('00002-default', null));
    initIndex({ root: tmpDir });
    syncIndex({ root: tmpDir });

    const raw = fs.readFileSync(path.join(specsDir, 'index.specs.md'), 'utf8');
    assert.match(raw, /\| Prefix \| Slug \| Title \| Status \| Priority \| Source \|/);
    const rows = raw.split('\n').filter((line) => /^\| \d{5} /.test(line));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
      assert.ok(['high', 'medium', 'low'].includes(cells[4]), `row has a priority: ${row}`);
    }
    const highCells = rows.find((row) => row.includes('00001-high')).split('|').slice(1, -1).map((cell) => cell.trim());
    assert.equal(highCells[4], 'high');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC5: registerSpec projects the frontmatter priority into the registry', () => {
  const { tmpDir, specsDir } = setupWorkspace();
  try {
    fs.writeFileSync(path.join(specsDir, '00001-projected.md'), specText('00001-projected', 'high'));
    registerSpec({
      prefix: '00001',
      slug: '00001-projected',
      title: 'Projected',
      status: 'pending',
      source: 'local',
      specDate: '2026-10-29',
      validation: 'PASS'
    }, { root: tmpDir });

    const { entries } = readIndex({ root: tmpDir });
    assert.equal(entries[0].priority, 'high');

    // An explicit meta.priority wins over the disk fallback.
    registerSpec({ prefix: '00001', slug: '00001-projected', priority: 'low' }, { root: tmpDir });
    const after = readIndex({ root: tmpDir }).entries;
    assert.equal(after[0].priority, 'low');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC6, AC7 & AC8: --order=priority ranks high first, ties by prefix, and prints RANK', () => {
  const { tmpDir, specsDir } = setupWorkspace();
  try {
    writeIndex([
      { prefix: '00003', slug: '00003-low', title: 'Low', status: 'pending', priority: 'low', source: 'local', specDate: '2026-10-29', validation: 'PASS' },
      { prefix: '00002', slug: '00002-medium', title: 'Medium', status: 'pending', priority: 'medium', source: 'local', specDate: '2026-10-29', validation: 'PASS' },
      { prefix: '00004', slug: '00004-high-b', title: 'High B', status: 'pending', priority: 'high', source: 'local', specDate: '2026-10-29', validation: 'PASS' },
      { prefix: '00001', slug: '00001-high-a', title: 'High A', status: 'pending', priority: 'high', source: 'local', specDate: '2026-10-29', validation: 'PASS' }
    ], { root: tmpDir });

    const json = execFileSync(process.execPath, [CLI, 'list', '--order=priority', '--json', '--root', tmpDir], { encoding: 'utf8' });
    const ordered = JSON.parse(json);
    assert.deepEqual(ordered.map((item) => item.prefix), ['00001', '00004', '00002', '00003']);
    assert.deepEqual(ordered.map((item) => item.rank), [1, 2, 3, 4]);
    assert.deepEqual(ordered.map((item) => item.priority), ['high', 'high', 'medium', 'low']);

    const text = execFileSync(process.execPath, [CLI, 'list', '--order=priority', '--root', tmpDir], { encoding: 'utf8' });
    assert.match(text, /RANK\s+\| PREFIX/);
    assert.ok(text.indexOf('00001-high-a') < text.indexOf('00003-low'), 'high rows print before low rows');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
