'use strict';

// Spec 00058 AC19, AC20 & AC21: the registry owns lifecycle status and every
// specification header projects it. The transition writes both surfaces, and
// `sdw-spec sync` names every disagreement it finds and repairs what it can.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  readIndex,
  writeIndex,
  updateSpecStatus,
  readHeaderStatus
} = require('../skills/sdw-spec/scripts/spec_index.cjs');
const { syncIndex } = require('../skills/sdw-spec/scripts/spec_sync.cjs');

const CLI = path.join(__dirname, '..', 'skills', 'sdw-spec', 'scripts', 'sdw_spec.cjs');

function writeSpecFile(root, slug, headerStatus) {
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const statusLine = headerStatus === null ? '' : `status: ${headerStatus}\n`;
  const file = path.join(specsDir, `${slug}.md`);
  fs.writeFileSync(file, `---\nslug: ${slug}\ntitle: "${slug}"\n${statusLine}---\n# ${slug}\n\n## Acceptance Criteria\n\n- AC1: The system shall exist.\n`, 'utf8');
  return file;
}

function writeRegistryRow(root, rows) {
  writeIndex(rows.map((row) => ({
    prefix: row.slug.slice(0, 5),
    slug: row.slug,
    title: row.slug,
    status: row.status,
    source: 'local',
    specDate: '2026-10-22',
    validation: 'PASS',
    archivalDate: null
  })), { root });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-header-drift-'));
  fs.mkdirSync(path.join(root, '.sdw', 'state'), { recursive: true });
  return root;
}

test('00058 AC19: marking a specification completed sets its header to implemented in the same transition', () => {
  const root = setup();
  try {
    const slug = '00060-transition';
    const specFile = writeSpecFile(root, slug, 'draft');
    writeRegistryRow(root, [{ slug, status: 'pending' }]);

    const entry = updateSpecStatus(slug, 'completed', { root });

    assert.equal(entry.status, 'completed');
    const row = readIndex({ root }).entries.find((item) => item.slug === slug);
    assert.equal(row.status, 'completed', 'the registry row records the transition');
    assert.equal(readHeaderStatus(fs.readFileSync(specFile, 'utf8')), 'implemented', 'the header follows the registry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00058 AC19: a pending transition rewrites no header, because pending names no authored status', () => {
  const root = setup();
  try {
    const slug = '00061-pending';
    const specFile = writeSpecFile(root, slug, 'ready-to-implement');
    writeRegistryRow(root, [{ slug, status: 'completed' }]);

    updateSpecStatus(slug, 'pending', { root });

    assert.equal(readHeaderStatus(fs.readFileSync(specFile, 'utf8')), 'ready-to-implement');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00058 AC20 & AC21: sync names the file, both values, and repairs every disagreement it can resolve', () => {
  const root = setup();
  try {
    const completedSlug = '00062-completed-draft';
    const pendingSlug = '00063-pending-ready';
    const reportSlug = '00062-completed-draft-report';
    const completedFile = writeSpecFile(root, completedSlug, 'draft');
    writeSpecFile(root, pendingSlug, 'ready-to-implement');
    // A delivery report companion beside the specification: it is never a
    // registry target, so its registry row is ignored by the drift pass.
    fs.writeFileSync(path.join(root, '.sdw', 'specs', `${reportSlug}.md`), '# Delivery Report\n', 'utf8');
    writeRegistryRow(root, [
      { slug: completedSlug, status: 'completed' },
      { slug: pendingSlug, status: 'pending' },
      { slug: reportSlug, status: 'pending' }
    ]);

    const dry = syncIndex({ root, dryRun: true });
    assert.equal(dry.headerDriftCount, 1, 'only the specification whose header disagrees is reported');
    const drift = dry.headerDrift[0];
    assert.equal(drift.slug, completedSlug);
    assert.equal(drift.file, `.sdw/specs/${completedSlug}.md`, 'the disagreement names the file');
    assert.equal(drift.registryStatus, 'completed', 'the disagreement names the registry value');
    assert.equal(drift.headerStatus, 'draft', 'the disagreement names the header value');
    assert.equal(drift.repaired, false, 'a dry run reports without writing');
    assert.equal(readHeaderStatus(fs.readFileSync(completedFile, 'utf8')), 'draft', 'a dry run leaves the header untouched');

    const live = syncIndex({ root });
    assert.equal(live.headerDriftCount, 1);
    assert.equal(live.headerDrift[0].repaired, true);
    assert.ok(
      live.transitions.some((transition) => transition.field === 'headerStatus' && transition.from === 'draft' && transition.to === 'implemented'),
      'the repair is recorded as a transition'
    );
    assert.equal(readHeaderStatus(fs.readFileSync(completedFile, 'utf8')), 'implemented', 'the header is repaired from the registry');

    const after = syncIndex({ root, dryRun: true });
    assert.equal(after.headerDriftCount, 0, 'a reconciled workspace reports zero disagreements');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00058 AC20: a disagreement the registry cannot resolve is reported and left alone', () => {
  const root = setup();
  try {
    const slug = '00064-pending-implemented';
    const specFile = writeSpecFile(root, slug, 'implemented');
    writeRegistryRow(root, [{ slug, status: 'pending' }]);

    const report = syncIndex({ root });

    assert.equal(report.headerDriftCount, 1);
    const drift = report.headerDrift[0];
    assert.equal(drift.registryStatus, 'pending');
    assert.equal(drift.headerStatus, 'implemented');
    assert.equal(drift.expectedHeaderStatus, null, 'a pending row authorizes no single authored status');
    assert.equal(drift.repaired, false);
    assert.equal(readHeaderStatus(fs.readFileSync(specFile, 'utf8')), 'implemented', 'an unresolvable disagreement is never rewritten');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00058 AC20: sdw-spec sync prints every disagreement with the file and both values', () => {
  const root = setup();
  try {
    const slug = '00065-cli-drift';
    writeSpecFile(root, slug, 'draft');
    writeRegistryRow(root, [{ slug, status: 'completed' }]);

    const result = spawnSync(process.execPath, [CLI, 'sync', '--root', root, '--dry-run'], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    const output = String(result.stdout || '');
    assert.ok(output.includes(`.sdw/specs/${slug}.md`), 'the report names the file');
    assert.match(output, /registry "completed"/, 'the report names the registry value');
    assert.match(output, /header "draft"/, 'the report names the header value');
    assert.match(output, /would repair -> implemented/, 'a dry run reports the repair it would make');
    assert.equal(readHeaderStatus(fs.readFileSync(path.join(root, '.sdw', 'specs', `${slug}.md`), 'utf8')), 'draft');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
