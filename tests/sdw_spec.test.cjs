'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { initIndex, readIndex, writeIndex, listIndex, archiveSpec, updateSpecStatus, scanSpecsDir, readDeclaredFields } = require('../skills/sdw-spec/scripts/spec_index.cjs');
const { getNextPrefix, createNewSpec, importRemoteSpec, toEarsCriterion } = require('../skills/sdw-spec/scripts/spec_creator.cjs');
const { validate, validateFile } = require('../skills/sdw-spec/scripts/validate_spec.cjs');
const { syncIndex } = require('../skills/sdw-spec/scripts/spec_sync.cjs');
const { buildPriorityRanking } = require('../skills/sdw-spec/scripts/sdw_spec.cjs');
const { ScmProvider, createScmProvider } = require('../skills/sdw-spec/scripts/scm_provider_contract.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');

// Spec 027: wire the deterministic judge stub for unattended runs past Step 4.
require('./fixtures/judge_env.cjs').installJudgeEnv();

function setupTestWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-spec-test-'));
  const sdwDir = path.join(tmpDir, '.sdw');
  const specsDir = path.join(sdwDir, 'specs');
  const stateDir = path.join(sdwDir, 'state');

  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify({
    specsDir: '{projectRoot}/.sdw/specs',
    stateDir: '{projectRoot}/.sdw/state',
    scoreMin: 8
  }, null, 2), 'utf8');

  return { tmpDir, sdwDir, specsDir, stateDir };
}

test('AC1, AC3 & AC4: Index Bootstrapping & Preservation Gate', () => {
  const { tmpDir, specsDir } = setupTestWorkspace();
  try {
    // Populate dummy spec 001
    fs.writeFileSync(path.join(specsDir, '00001-feature-alpha.md'), `---
id: null
slug: 00001-feature-alpha
title: "Feature Alpha"
source: local

status: draft
specDate: 2026-10-19
---
# Specification — Feature Alpha
## Description
Core feature alpha description.
### Design Intent
Architectural intent.
## Acceptance Criteria
- AC1: The system shall provide feature alpha.
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
`, 'utf8');

    // AC3: initIndex bootstraps index.specs.md
    const entries = initIndex({ root: tmpDir });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prefix, '00001');
    assert.equal(entries[0].slug, '00001-feature-alpha');
    assert.equal(entries[0].status, 'pending');
    assert.equal(entries[0].validation, 'PASS');

    const indexPath = path.join(specsDir, 'index.specs.md');
    assert.ok(fs.existsSync(indexPath), 'index.specs.md was created on disk');

    // AC4: Calling init without force rejects and preserves existing records
    assert.throws(() => {
      initIndex({ root: tmpDir, force: false });
    }, /already exists.*Use --force/);

    // Calling init with force: true succeeds
    const forcedEntries = initIndex({ root: tmpDir, force: true });
    assert.equal(forcedEntries.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC2: Autoincrement Numerical Prefix Calculation', () => {
  const { tmpDir, specsDir } = setupTestWorkspace();
  try {
    // Empty directory starts at 001
    assert.equal(getNextPrefix(specsDir), '00001');

    // Add 001 and 002
    fs.writeFileSync(path.join(specsDir, '00001-first.md'), '# First');
    fs.writeFileSync(path.join(specsDir, '00002-second.md'), '# Second');
    assert.equal(getNextPrefix(specsDir), '00003');

    // Add 009 -> next is 010
    fs.writeFileSync(path.join(specsDir, '00009-ninth.md'), '# Ninth');
    assert.equal(getNextPrefix(specsDir), '00010');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC5 & AC6: Specification Listing & Status Filtering', () => {
  const { tmpDir } = setupTestWorkspace();
  try {
    const dummyEntries = [
      { prefix: '00001', slug: '00001-feat-a', title: 'Feat A', status: 'pending', source: 'local', specDate: '2026-10-19', validation: 'PASS' },
      { prefix: '00002', slug: '00002-feat-b', title: 'Feat B', status: 'completed', source: 'local', specDate: '2026-10-19', validation: 'PASS' },
      { prefix: '00003', slug: '00003-feat-c', title: 'Feat C', status: 'archived', source: 'local', specDate: '2026-10-19', validation: 'PASS' }
    ];
    writeIndex(dummyEntries, { root: tmpDir });

    // AC5: listIndex displays all
    const all = listIndex({ root: tmpDir });
    assert.equal(all.length, 3);

    // AC6: Filter by status
    const pendingOnly = listIndex({ root: tmpDir, status: 'pending' });
    assert.equal(pendingOnly.length, 1);
    assert.equal(pendingOnly[0].slug, '00001-feat-a');

    const completedOnly = listIndex({ root: tmpDir, status: 'completed' });
    assert.equal(completedOnly.length, 1);
    assert.equal(completedOnly[0].slug, '00002-feat-b');

    const archivedOnly = listIndex({ root: tmpDir, status: 'archived' });
    assert.equal(archivedOnly.length, 1);
    assert.equal(archivedOnly[0].slug, '00003-feat-c');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC7 & AC8: Specification Archiving & Uncompleted Rejection Gate', () => {
  const { tmpDir } = setupTestWorkspace();
  try {
    const dummyEntries = [
      { prefix: '00001', slug: '00001-active', title: 'Active', status: 'pending', source: 'local', specDate: '2026-10-19', validation: 'PASS' },
      { prefix: '00002', slug: '00002-done', title: 'Done', status: 'completed', source: 'local', specDate: '2026-10-19', validation: 'PASS' }
    ];
    writeIndex(dummyEntries, { root: tmpDir });

    // AC8: Rejects archiving uncompleted spec without --force
    assert.throws(() => {
      archiveSpec('00001-active', { root: tmpDir, force: false });
    }, /Cannot archive specification "00001-active" with status "pending"/);

    // AC7: Archiving completed spec succeeds and records timestamp
    const archived = archiveSpec('00002-done', { root: tmpDir });
    assert.equal(archived.status, 'archived');
    assert.ok(archived.archivalDate, 'Records archival timestamp');

    // Archive uncompleted spec with --force succeeds
    const forceArchived = archiveSpec('00001-active', { root: tmpDir, force: true });
    assert.equal(forceArchived.status, 'archived');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC9 & AC10: Authoring-Mode Validation & EARS Syntax Rejection', () => {
  // Valid spec with all 5 EARS patterns
  const validSpec = `---
id: null
slug: 00001-ears-test
title: "EARS Validation"
source: local

status: draft
specDate: 2026-10-19
---
# Specification — EARS Validation
## Description
Description text.
### Design Intent
Design intent text.
## Acceptance Criteria
- AC1: The system shall provide ubiquitous support.
- AC2: When trigger occurs, the system shall respond cleanly.
- AC3: While active, the system shall maintain state.
- AC4: Where optional feature is configured, the system shall enable integration.
- AC5: If invalid input is provided, then the system shall reject it.
## Notes
None.
## Out of Scope
| Feature | Reason |
|---|---|
| Unrelated | Out of scope |
## Assumptions & Open Questions
| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Standard | Default | Explicit rationale | y |
## Definition of Ready (DoR)
| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Config | Valid | Automated test |
## Validation & Observation Notes
### Telemetry & Observable Signals
- Console output logs
### Negative & Failing Test Scenarios
- Rejection of malformed criteria
`;

  const validRes = validate(validSpec, { mode: 'authoring' });
  assert.equal(validRes.ok, true, 'Valid EARS spec passes validation');
  assert.equal(validRes.acceptanceCriteria.length, 5);

  // AC10: Non-EARS syntax is rejected with the offending AC identifier
  const invalidSpec = validSpec.replace(
    '- AC1: The system shall provide ubiquitous support.',
    '- AC1: Users can click the button to submit forms.'
  );

  const invalidRes = validate(invalidSpec, { mode: 'authoring' });
  assert.equal(invalidRes.ok, false, 'Invalid EARS syntax fails validation');
  assert.ok(invalidRes.errors.some(e => e.ac === 'AC1' && e.message.includes('EARS')), 'Identifies AC1 as EARS violation');
});

test('AC11 & AC12: Free-Text Specification Synthesis (new)', () => {
  const { tmpDir, specsDir } = setupTestWorkspace();
  try {
    const rawRequirements = `Implement user session management with JWT tokens
- Support login endpoint returning signed JWT
- When token expires, the system shall reject requests with 401
- If token signature is invalid, then the system shall abort authentication
`;

    const created = createNewSpec(rawRequirements, { root: tmpDir, title: 'Session Management' });
    assert.equal(created.prefix, '00001');
    assert.equal(created.slug, '00001-session-management');
    assert.ok(fs.existsSync(created.filePath), 'Spec file created on disk');

    // Verify it passes validation
    const val = validateFile(created.filePath, { mode: 'authoring' });
    assert.equal(val.ok, true, `Generated spec passes validation: ${JSON.stringify(val.errors)}`);

    // AC12: Registered in index.specs.md with status pending
    const indexData = readIndex({ root: tmpDir });
    assert.equal(indexData.entries.length, 1);
    assert.equal(indexData.entries[0].slug, '00001-session-management');
    assert.equal(indexData.entries[0].status, 'pending');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC13, AC14, AC15, AC16 & AC17: Unified SCM Provider Contract & Remote Import', async () => {
  const { tmpDir, specsDir } = setupTestWorkspace();
  try {
    // Mock SCM Provider fulfilling the unified contract (AC13)
    const mockProvider = {
      async fetchWorkItem(id) {
        if (id === '404') {
          throw new Error('Work item not found on remote tracker.');
        }
        return {
          id: String(id),
          title: 'Add OAuth2 GitHub Authentication',
          description: 'Authenticate users via GitHub OAuth2 workflow.',
          acceptanceCriteria: [
            'The system shall exchange authorization code for access token.',
            'When login succeeds, the system shall issue session cookie.'
          ],
          source: 'github',
          url: `https://github.com/org/repo/issues/${id}`,
          state: 'open',
          tags: ['auth', 'security']
        };
      },
      async queryWorkItems() {
        return [];
      }
    };

    // AC14 & AC15: Import remote work item
    const imported = await importRemoteSpec({
      root: tmpDir,
      provider: 'github',
      id: '1234',
      scmProvider: mockProvider
    });

    assert.equal(imported.prefix, '00001');
    assert.ok(imported.slug.includes('1234'));
    assert.ok(fs.existsSync(imported.filePath));

    // Validates with Prior Work Sweep present
    const val = validateFile(imported.filePath, { mode: 'authoring' });
    assert.equal(val.ok, true, `Imported spec passes validation: ${JSON.stringify(val.errors)}`);

    // AC16: Retrieval failure halts with actionable error without creating file
    await assert.rejects(async () => {
      await importRemoteSpec({
        root: tmpDir,
        provider: 'github',
        id: '404',
        scmProvider: mockProvider
      });
    }, /SCM Import Failed.*Work item not found/);

    // AC17: Duplicate import rejected without --force
    await assert.rejects(async () => {
      await importRemoteSpec({
        root: tmpDir,
        provider: 'github',
        id: '1234',
        scmProvider: mockProvider,
        force: false
      });
    }, /already exists on disk.*Overwrite rejected without --force/);

    // Duplicate import succeeds with --force: true
    const reimported = await importRemoteSpec({
      root: tmpDir,
      provider: 'github',
      id: '1234',
      scmProvider: mockProvider,
      force: true
    });
    assert.ok(reimported);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC18, AC19, AC20, AC21 & AC22: Synchronization & Reconciliation', () => {
  const { tmpDir, specsDir, stateDir } = setupTestWorkspace();
  try {
    // 1. Create a spec on disk
    fs.writeFileSync(path.join(specsDir, '00001-feature-x.md'), `---
id: null
slug: 00001-feature-x
title: "Feature X"
source: local

status: draft
specDate: 2026-10-19
---
# Specification — Feature X
## Description
Desc.
### Design Intent
Intent.
## Acceptance Criteria
- AC1: The system shall support feature x.
## Notes
None.
## Out of Scope
| Feature | Reason |
|---|---|
| Scope | Bounded |
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
- Rejection of invalid inputs
`, 'utf8');

    initIndex({ root: tmpDir });
    let idx = readIndex({ root: tmpDir });
    assert.equal(idx.entries[0].status, 'pending');

    // AC19: Completed run state in stateDir transitions status to completed
    const runState = {
      runId: 'run-test-001',
      specSlug: '00001-feature-x',
      status: 'completed',
      deliveryCommit: 'abc1234'
    };
    fs.writeFileSync(path.join(stateDir, 'run-test-001.state.json'), JSON.stringify(runState), 'utf8');

    // Also add a corrupted state file to test graceful handling (Negative scenario 7)
    fs.writeFileSync(path.join(stateDir, 'corrupted.state.json'), '{ invalid json ...', 'utf8');

    let warnedCorrupted = false;
    const origWarn = console.warn;
    console.warn = (msg) => {
      if (String(msg).includes('corrupted.state.json')) warnedCorrupted = true;
    };
    let dryReport;
    try {
      // AC21: Dry-run preview does not mutate index on disk
      dryReport = syncIndex({ root: tmpDir, dryRun: true });
    } finally {
      console.warn = origWarn;
    }
    assert.strictEqual(warnedCorrupted, true, 'Gracefully warned and skipped corrupted state file');
    assert.equal(dryReport.dryRun, true);
    assert.equal(dryReport.transitions.some(t => t.to === 'completed'), true);
    // On-disk still pending
    assert.equal(readIndex({ root: tmpDir }).entries[0].status, 'pending');

    // Remove corrupted state file so subsequent index tests proceed cleanly
    fs.unlinkSync(path.join(stateDir, 'corrupted.state.json'));

    // Live sync updates status to completed
    const liveReport = syncIndex({ root: tmpDir, dryRun: false });
    assert.equal(readIndex({ root: tmpDir }).entries[0].status, 'completed');

    // AC20: Untracked spec discovery
    fs.writeFileSync(path.join(specsDir, '00002-discovered.md'), `---
id: null
slug: 00002-discovered
title: "Discovered Spec"
source: local

status: draft
specDate: 2026-10-19
---
# Specification — Discovered Spec
## Description
Desc.
### Design Intent
Intent.
## Acceptance Criteria
- AC1: The system shall discover untracked specs.
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
- Rejection
`, 'utf8');

    syncIndex({ root: tmpDir });
    const afterDiscovery = readIndex({ root: tmpDir });
    assert.equal(afterDiscovery.entries.length, 2);
    assert.ok(afterDiscovery.entries.some(e => e.slug === '00002-discovered' && e.status === 'pending'));

    // AC22: Missing spec flagged as MISSING without deleting historical row
    fs.unlinkSync(path.join(specsDir, '00002-discovered.md'));
    syncIndex({ root: tmpDir });
    const afterMissing = readIndex({ root: tmpDir });
    const missingEntry = afterMissing.entries.find(e => e.slug === '00002-discovered');
    assert.ok(missingEntry, 'Missing spec row retained in index');
    assert.equal(missingEntry.validation, 'MISSING');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC23, AC24 & AC25: Orchestrator Integration & Quality Gates', () => {
  const { tmpDir, specsDir } = setupTestWorkspace();
  try {
    const specPath = path.join(specsDir, '00001-archived-test.md');
    fs.writeFileSync(specPath, `---
id: null
slug: 00001-archived-test
title: "Archived Gate Test"
source: local

status: draft
specDate: 2026-10-19
---
# Specification — Archived Gate Test
## Description
Desc.
### Design Intent
Intent.
## Acceptance Criteria
- AC1: The system shall guard archived specs against orchestrator runs.
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
- Rejection of archived execution
`, 'utf8');

    initIndex({ root: tmpDir });
    // Transition to completed then archived
    updateSpecStatus('00001-archived-test', 'completed', { root: tmpDir });
    archiveSpec('00001-archived-test', { root: tmpDir });

    // AC25: sdw-orch rejects execution on archived spec without override flag
    const exitCodeBlocked = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '00001-archived-test.md',
      force: false,
      allowArchived: false
    });
    assert.equal(exitCodeBlocked, 1, 'Rejects execution on archived spec without override');

    // Unarchive / allow archived execution with --allow-archived flag
    const exitCodeAllowed = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '00001-archived-test.md',
      allowArchived: true,
      minScore: 0,
      skipReview: true,
      skipPr: true,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/00001-archived-test.md\'], summary: \'done\' }));"'
      }
    });
    assert.equal(exitCodeAllowed, 0, 'Allows execution on archived spec with --allow-archived');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Spec status: header key is required and enum-validated', () => {
  const body = (statusLine) => `---
id: null
slug: 00001-status-test
title: "Status Test"
source: local
${statusLine}specDate: 2026-10-21
---
# Specification — Status Test
## Description
Desc.
### Design Intent
Intent.
## Acceptance Criteria
- AC1: The system shall demonstrate status validation.
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
- Rejection of invalid status
`;

  const missing = validate(body(''), { mode: 'authoring' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(e => e.code === 'frontmatter-key' && e.message.includes('status')));

  const invalid = validate(body('status: shipped\n'), { mode: 'authoring' });
  assert.ok(invalid.errors.some(e => e.code === 'status'), 'Unknown status is rejected');

  const valid = validate(body('status: draft\n'), { mode: 'authoring' });
  assert.equal(valid.ok, true, `Draft status validates: ${JSON.stringify(valid.errors)}`);
});

test('Spec status subcommand: transition gate and header rewrite', () => {
  const { tmpDir } = setupTestWorkspace();
  try {
    const { cmdStatus } = require('../skills/sdw-spec/scripts/sdw_spec.cjs');
    const created = createNewSpec('Status transition demo', { root: tmpDir });
    const read = () => fs.readFileSync(created.filePath, 'utf8');

    assert.match(read(), /^status: draft$/m, 'New specs start as draft');
    assert.equal(cmdStatus({ target: `${created.slug} implemented`, root: tmpDir }), 1, 'Skips undefined transition');
    assert.match(read(), /^status: draft$/m, 'Refused transition leaves the header unchanged');
    assert.equal(cmdStatus({ target: `${created.slug} awaiting-approval`, root: tmpDir }), 0);
    assert.match(read(), /^status: awaiting-approval$/m);
    assert.equal(cmdStatus({ target: `${created.slug} implemented`, root: tmpDir, force: true }), 0);
    assert.match(read(), /^status: implemented$/m, '--force overrides the transition map');
    assert.equal(cmdStatus({ target: `${created.slug} not-a-status`, root: tmpDir }), 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Spec grilling reference is present and linked', () => {
  const root = path.join(__dirname, '..');
  const skill = fs.readFileSync(path.join(root, 'skills', 'sdw-spec', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('references/grilling.md'), 'SKILL.md links the grilling reference');
  assert.ok(skill.includes('awaiting-approval'), 'SKILL.md documents the status transition');
  assert.ok(fs.existsSync(path.join(root, 'skills', 'sdw-spec', 'references', 'grilling.md')));
});

test('Spec 00054 companions: a {slug}-report.md file is never registered as a specification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-spec-report-'));
  try {
    const specsDir = path.join(tmpDir, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, '00001-alpha.md'),
      '---\nid: null\nslug: 00001-alpha\ntitle: "Alpha"\nsource: local\nstatus: draft\nspecDate: 2026-10-22\n---\n\n# Alpha\n\n## Description\n\nBody.\n\n## Acceptance Criteria\n\n- AC1: The system shall work.\n',
      'utf8'
    );
    fs.writeFileSync(path.join(specsDir, '00001-alpha-report.md'), '# Delivery Report — Alpha\n', 'utf8');
    fs.writeFileSync(path.join(specsDir, 'index.specs.md'), '# Specification Index\n', 'utf8');

    const scanned = scanSpecsDir({ root: tmpDir });
    assert.equal(scanned.length, 1, 'the delivery report is not scanned as a specification');
    assert.equal(scanned[0].slug, '00001-alpha');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Spec 00055 fixtures: declared ranking fields live only in frontmatter; the
// registry keeps its existing columns.
const PRIORITY_CLI = path.join(__dirname, '..', 'skills', 'sdw-spec', 'scripts', 'sdw_spec.cjs');

function writePriorityFixture(root, spec) {
  const slug = `${spec.prefix}-${spec.name}`;
  const title = spec.title || spec.name;
  const lines = [
    '---',
    'id: null',
    `slug: ${slug}`,
    `title: "${title}"`,
    'source: local',
    `status: ${spec.status || 'draft'}`,
    `specDate: ${spec.date || '2026-10-01'}`
  ];
  if (spec.priority !== undefined) lines.push(`priority: ${spec.priority}`);
  if (spec.value !== undefined) lines.push(`value: "${spec.value}"`);
  if (spec.effort !== undefined) lines.push(`effort: ${spec.effort}`);
  if (spec.blockedBy !== undefined) lines.push(`blockedBy: [${spec.blockedBy.map((token) => `"${token}"`).join(', ')}]`);
  lines.push('---');
  const criteria = (spec.acs || ['The system shall satisfy the fixture.'])
    .map((criterion, index) => `- AC${index + 1}: ${criterion}`)
    .join('\n');
  const body = spec.body ? `\n${spec.body}\n` : '';
  fs.writeFileSync(
    path.join(root, '.sdw', 'specs', `${slug}.md`),
    `${lines.join('\n')}\n# Specification — ${title}\n\n## Description\n\nFixture.\n\n## Acceptance Criteria\n\n${criteria}\n${body}`,
    'utf8'
  );
  return {
    prefix: spec.prefix,
    slug,
    title,
    status: spec.registryStatus || 'pending',
    source: 'local',
    specDate: spec.date || '2026-10-01',
    validation: 'PASS'
  };
}

function setupPriorityWorkspace(specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-spec-priority-'));
  const sdwDir = path.join(root, '.sdw');
  fs.mkdirSync(path.join(sdwDir, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(sdwDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify({
    specsDir: '{projectRoot}/.sdw/specs',
    stateDir: '{projectRoot}/.sdw/state',
    scoreMin: 8
  }, null, 2), 'utf8');
  writeIndex(specs.map((spec) => writePriorityFixture(root, spec)), { root });
  return root;
}

function runListByPriority(root, args = []) {
  return spawnSync(process.execPath, [PRIORITY_CLI, 'list-by-priority', '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

function rankedPrefixes(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.match(/^\d+\s+\|\s+(\d{5})\s+\|/))
    .filter(Boolean)
    .map((match) => match[1]);
}

function tableRow(stdout, prefix) {
  const line = stdout.split('\n').find((candidate) => new RegExp(`^\\d+\\s+\\|\\s+${prefix}\\s+\\|`).test(candidate));
  assert.ok(line, `row for ${prefix} exists in the ranked table`);
  return line.split('|').map((cell) => cell.trim());
}

test('00055 AC1, AC2 & AC10: list-by-priority ranks registry-pending rows in a full table', () => {
  const root = setupPriorityWorkspace([
    { prefix: '00001', name: 'alpha', status: 'ready-to-implement', priority: 'high', effort: 'S', value: 'Ships alpha' },
    { prefix: '00002', name: 'beta', status: 'implemented', registryStatus: 'completed', priority: 'high', effort: 'S', value: 'Delivered' },
    { prefix: '00003', name: 'gamma', status: 'abandoned', registryStatus: 'archived', priority: 'low', effort: 'M' },
    { prefix: '00004', name: 'delta', status: 'draft', acs: ['The system shall do one thing.', 'The system shall do another thing.'] }
  ]);
  try {
    const help = spawnSync(process.execPath, [PRIORITY_CLI, 'help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /list-by-priority\s+Rank pending specifications/);

    const run = runListByPriority(root);
    assert.equal(run.status, 0, run.stderr);

    const header = run.stdout.split('\n').find((line) => line.startsWith('RANK '));
    assert.ok(header, 'ranked table header is printed');
    assert.deepEqual(
      header.split('|').map((cell) => cell.trim()),
      ['RANK', 'PREFIX', 'PRIORITY', 'EFFORT', 'AC', 'READINESS', 'BLOCKED BY', 'VALUE']
    );
    assert.deepEqual(rankedPrefixes(run.stdout), ['00001', '00004'], 'completed and archived rows are excluded');
    assert.deepEqual(tableRow(run.stdout, '00001').slice(0, 8), ['1', '00001', 'high', 'S', '1', 'ready-to-implement', '-', 'Ships alpha']);
    assert.deepEqual(tableRow(run.stdout, '00004').slice(0, 7), ['2', '00004', 'medium', '-', '2', 'draft', '-'], 'absent priority is medium and absent effort stays unset');
    assert.equal(tableRow(run.stdout, '00004')[7], '-', 'an absent value prints as a dash');
    assert.match(run.stdout, /^Totals: 2 pending \| 1 high \| 1 medium \| 0 low \| 0 blocked$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00055 AC4, AC5 & AC6: ordering follows priority, blocking, readiness, effort, specDate, prefix', () => {
  const root = setupPriorityWorkspace([
    { prefix: '00012', name: 'high-medium-effort', status: 'ready-to-implement', priority: 'high', effort: 'M', date: '2026-09-01' },
    { prefix: '00013', name: 'high-large-effort', status: 'ready-to-implement', priority: 'high', effort: 'L', date: '2026-09-01' },
    { prefix: '00003', name: 'high-unset-effort', status: 'ready-to-implement', priority: 'high', date: '2026-09-01' },
    { prefix: '00004', name: 'high-draft', status: 'draft', priority: 'high', effort: 'S', date: '2026-09-01' },
    { prefix: '00015', name: 'high-awaiting', status: 'awaiting-approval', priority: 'high', effort: 'S', date: '2026-09-01' },
    { prefix: '00006', name: 'high-blocked', status: 'ready-to-implement', priority: 'high', effort: 'S', date: '2026-09-01', blockedBy: ['00010'] },
    { prefix: '00002', name: 'high-late-date', status: 'ready-to-implement', priority: 'high', effort: 'S', date: '2026-10-02' },
    { prefix: '00005', name: 'high-early-date', status: 'ready-to-implement', priority: 'high', effort: 'S', date: '2026-10-01' },
    { prefix: '00008', name: 'medium-late-date', status: 'ready-to-implement', priority: 'medium', effort: 'S', date: '2026-10-05' },
    { prefix: '00011', name: 'medium-default-priority', status: 'ready-to-implement', effort: 'S', date: '2026-09-05' },
    { prefix: '00009', name: 'low-late-date', status: 'ready-to-implement', priority: 'low', effort: 'S', date: '2026-10-05' },
    { prefix: '00014', name: 'low-first-tie', status: 'ready-to-implement', priority: 'low', effort: 'S', date: '2026-10-04' },
    { prefix: '00020', name: 'low-second-tie', status: 'ready-to-implement', priority: 'low', effort: 'S', date: '2026-10-04' },
    { prefix: '00010', name: 'open-dependency', status: 'ready-to-implement', date: '2026-09-01' }
  ]);
  try {
    const expected = ['00005', '00002', '00012', '00013', '00003', '00004', '00015', '00006', '00011', '00008', '00010', '00014', '00020', '00009'];
    const ranking = buildPriorityRanking({ root });
    assert.deepEqual(ranking.items.map((item) => item.prefix), expected);
    assert.deepEqual(ranking.items.map((item) => item.rank), expected.map((_, index) => index + 1));

    const byPrefix = Object.fromEntries(ranking.items.map((item) => [item.prefix, item]));
    assert.equal(byPrefix['00011'].priority, 'medium', 'absent priority reads as medium');
    assert.equal(byPrefix['00003'].effort, null, 'absent effort stays unset');
    assert.equal(byPrefix['00006'].blocked, true);
    assert.equal(byPrefix['00005'].specDate, '2026-10-01');

    const run = runListByPriority(root);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(rankedPrefixes(run.stdout), expected, 'the printed table carries the same order');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00055 AC7: a blockedBy dependency blocks only while it stays pending', () => {
  const root = setupPriorityWorkspace([
    { prefix: '00030', name: 'blocked-design', status: 'ready-to-implement', priority: 'high', effort: 'S', date: '2026-10-01', blockedBy: ['00031'] },
    { prefix: '00033', name: 'delivered-dependency', status: 'ready-to-implement', priority: 'high', effort: 'S', date: '2026-10-02', blockedBy: ['00034'] },
    { prefix: '00031', name: 'open-dependency', status: 'draft', priority: 'low', effort: 'M', date: '2026-10-03' },
    { prefix: '00034', name: 'completed-dependency', status: 'implemented', registryStatus: 'completed', priority: 'high', effort: 'S', date: '2026-10-04' }
  ]);
  try {
    const ranking = buildPriorityRanking({ root });
    const byPrefix = Object.fromEntries(ranking.items.map((item) => [item.prefix, item]));
    assert.equal(byPrefix['00030'].blocked, true, 'a pending dependency blocks');
    assert.deepEqual(byPrefix['00030'].blockedBy, ['00031']);
    assert.equal(byPrefix['00033'].blocked, false, 'a completed dependency does not block');
    assert.deepEqual(ranking.items.map((item) => item.prefix), ['00033', '00030', '00031']);
    assert.equal(ranking.counts.blocked, 1);

    const run = runListByPriority(root);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(tableRow(run.stdout, '00030')[6], 'blocked: 00031');
    assert.equal(tableRow(run.stdout, '00033')[6], '00034', 'a satisfied dependency is listed without the blocked marker');
    assert.match(run.stdout, /^Totals: 3 pending \| 2 high \| 0 medium \| 1 low \| 1 blocked$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00055 AC8: an unresolved blockedBy entry exits 1 naming the specification and the entry', () => {
  const root = setupPriorityWorkspace([
    { prefix: '00040', name: 'orphan-blocker', priority: 'high', effort: 'S', blockedBy: ['00999'] }
  ]);
  try {
    const run = runListByPriority(root);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '', 'no partial table is printed');
    assert.match(run.stderr, /00040-orphan-blocker/);
    assert.match(run.stderr, /00999/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00055 AC9: an out-of-enum priority or effort exits 1 naming the specification and the value', () => {
  const priorityRoot = setupPriorityWorkspace([
    { prefix: '00050', name: 'bad-priority', priority: 'urgent', effort: 'S' }
  ]);
  try {
    const run = runListByPriority(priorityRoot);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '', 'no partial table is printed');
    assert.match(run.stderr, /00050-bad-priority/);
    assert.match(run.stderr, /urgent/);
  } finally {
    fs.rmSync(priorityRoot, { recursive: true, force: true });
  }

  const effortRoot = setupPriorityWorkspace([
    { prefix: '00051', name: 'bad-effort', priority: 'high', effort: 'XL' }
  ]);
  try {
    const run = runListByPriority(effortRoot);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '', 'no partial table is printed');
    assert.match(run.stderr, /00051-bad-effort/);
    assert.match(run.stderr, /XL/);
  } finally {
    fs.rmSync(effortRoot, { recursive: true, force: true });
  }
});

test('00055 AC3: declared fields are read from frontmatter in inline, scalar, absent, and CRLF forms', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-spec-declared-'));
  try {
    const specsDir = path.join(root, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const write = (name, frontmatter) => {
      const file = path.join(specsDir, `${name}.md`);
      fs.writeFileSync(file, `---\nid: null\nslug: ${name}\ntitle: "Fixture"\nsource: local\nstatus: draft\nspecDate: 2026-10-22\n${frontmatter}---\n# Fixture\n`, 'utf8');
      return file;
    };

    assert.deepEqual(
      readDeclaredFields(write('00001-inline', 'priority: high\nvalue: "Worth doing"\neffort: M\nblockedBy: ["00038", "00041"]\n')),
      { priority: 'high', value: 'Worth doing', effort: 'M', blockedBy: ['00038', '00041'] }
    );
    assert.deepEqual(
      readDeclaredFields(write('00002-scalar', 'priority: low\nblockedBy: 00038\n')),
      { priority: 'low', value: '', effort: null, blockedBy: ['00038'] }
    );
    assert.deepEqual(
      readDeclaredFields(write('00003-absent', '')),
      { priority: null, value: '', effort: null, blockedBy: [] }
    );
    assert.deepEqual(
      readDeclaredFields(write('00004-empty-list', 'blockedBy: []\n')),
      { priority: null, value: '', effort: null, blockedBy: [] }
    );

    const crlfFile = path.join(specsDir, '00005-crlf.md');
    fs.writeFileSync(
      crlfFile,
      '---\r\nid: null\r\nslug: 00005-crlf\r\ntitle: "Fixture"\r\nsource: local\r\nstatus: draft\r\nspecDate: 2026-10-22\r\npriority: medium\r\neffort: S\r\n---\r\n# Fixture\r\n',
      'utf8'
    );
    assert.deepEqual(readDeclaredFields(crlfFile), { priority: 'medium', value: '', effort: 'S', blockedBy: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function collisionPairs(stdout) {
  return [...stdout.matchAll(/^(\d{5}) <-> (\d{5}) \((\d+) shared paths?\)$/gm)].map((match) => [
    match[1],
    match[2],
    Number(match[3])
  ]);
}

function snapshotTree(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files.set(path.relative(root, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(root, '.sdw'));
  return files;
}

test('00055 AC11 & AC12: --limit caps rows while the totals keep every pending specification', () => {
  const root = setupPriorityWorkspace([
    { prefix: '00001', name: 'high-ready', status: 'ready-to-implement', priority: 'high', effort: 'S', date: '2026-10-01' },
    { prefix: '00002', name: 'high-draft', status: 'draft', priority: 'high', effort: 'M', date: '2026-10-02' },
    { prefix: '00003', name: 'medium', status: 'draft', priority: 'medium', effort: 'S', date: '2026-10-03' },
    { prefix: '00004', name: 'low', status: 'draft', priority: 'low', effort: 'S', date: '2026-10-04' }
  ]);
  try {
    const full = runListByPriority(root);
    assert.equal(full.status, 0, full.stderr);
    const fullOrder = rankedPrefixes(full.stdout);
    assert.deepEqual(fullOrder, ['00001', '00002', '00003', '00004']);

    const limited = runListByPriority(root, ['--limit', '2']);
    assert.equal(limited.status, 0, limited.stderr);
    assert.deepEqual(rankedPrefixes(limited.stdout), fullOrder.slice(0, 2), 'only the first n ranked rows print');
    assert.ok(limited.stdout.includes('Ranked pending specifications (4)'), 'the header keeps the full pending count');
    assert.match(limited.stdout, /^Totals: 4 pending \| 2 high \| 1 medium \| 1 low \| 0 blocked$/m);

    const single = runListByPriority(root, ['--limit=1']);
    assert.equal(single.status, 0, single.stderr);
    assert.deepEqual(rankedPrefixes(single.stdout), ['00001']);

    for (const invalid of ['0', 'abc', '-1', '1.5']) {
      const rejected = runListByPriority(root, [`--limit=${invalid}`]);
      assert.equal(rejected.status, 1, `--limit=${invalid} exits 1`);
      assert.equal(rejected.stdout, '', 'no table is printed for an invalid limit');
      assert.ok(rejected.stderr.includes(`Invalid --limit value "${invalid}"`), rejected.stderr);
    }

    const missing = runListByPriority(root, ['--limit']);
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes('Invalid --limit value "(missing)"'), missing.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00055 AC13: --json prints counts and timestamp-free ranked items', () => {
  const root = setupPriorityWorkspace([
    { prefix: '00001', name: 'alpha', status: 'ready-to-implement', priority: 'high', effort: 'S', value: 'Ships alpha', date: '2026-10-01' },
    { prefix: '00002', name: 'beta', status: 'draft', date: '2026-10-02', acs: ['The system shall do one thing.', 'The system shall do another thing.'] }
  ]);
  try {
    const run = runListByPriority(root, ['--json']);
    assert.equal(run.status, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(payload), ['counts', 'items']);
    assert.deepEqual(payload.counts, { pending: 2, high: 1, medium: 1, low: 0, blocked: 0 });
    assert.deepEqual(Object.keys(payload.items[0]), [
      'rank',
      'prefix',
      'slug',
      'title',
      'priority',
      'effort',
      'acCount',
      'readiness',
      'registryStatus',
      'blockedBy',
      'blocked',
      'value',
      'specDate'
    ]);
    assert.deepEqual(payload.items[0], {
      rank: 1,
      prefix: '00001',
      slug: '00001-alpha',
      title: 'alpha',
      priority: 'high',
      effort: 'S',
      acCount: 1,
      readiness: 'ready-to-implement',
      registryStatus: 'pending',
      blockedBy: [],
      blocked: false,
      value: 'Ships alpha',
      specDate: '2026-10-01'
    });
    assert.equal(payload.items[1].acCount, 2, 'the acceptance-criteria count is carried');
    assert.equal(payload.items[1].priority, 'medium', 'an absent priority reads as medium');
    assert.equal(payload.items[1].effort, null, 'an absent effort stays unset');
    assert.doesNotMatch(run.stdout, /timestamp|generatedAt|updatedAt|createdAt|runTime/i);

    const limited = JSON.parse(runListByPriority(root, ['--json', '--limit', '1']).stdout);
    assert.equal(limited.items.length, 1);
    assert.equal(limited.counts.pending, 2, 'counts keep every pending specification under --limit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00055 AC14 & AC15: --collisions reports shared skills/ paths in count-then-prefix order', () => {
  const root = setupPriorityWorkspace([
    { prefix: '00010', name: 'two-shared', body: 'See `skills/alpha/one.cjs` and `skills/beta/two.cjs`, plus `skills/*/SKILL.md`.' },
    { prefix: '00011', name: 'two-shared-peer', body: 'See skills/alpha/one.cjs and skills/beta/two.cjs.' },
    { prefix: '00012', name: 'one-shared', body: 'See `skills/alpha/one.cjs` and `skills/gamma/three.cjs`.' },
    { prefix: '00013', name: 'no-shared', body: 'See `skills/only/four.cjs`.' }
  ]);
  try {
    const run = runListByPriority(root, ['--collisions']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(collisionPairs(run.stdout), [
      ['00010', '00011', 2],
      ['00010', '00012', 1],
      ['00011', '00012', 1]
    ]);
    assert.ok(run.stdout.includes('skills/alpha/one.cjs'), 'the shared path is listed');
    assert.ok(!run.stdout.includes('skills/*'), 'a wildcard token names no concrete surface');
    assert.ok(run.stdout.indexOf('00010 <-> 00011') < run.stdout.indexOf('00010 <-> 00012'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const clean = setupPriorityWorkspace([
    { prefix: '00020', name: 'wildcard-only', body: 'Applies `skills/*/SKILL.md` to every skill.' },
    { prefix: '00021', name: 'unique-path', body: 'Applies `skills/only/one.cjs`.' }
  ]);
  try {
    const run = runListByPriority(clean, ['--collisions']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'No surface collisions among pending specifications.');
  } finally {
    fs.rmSync(clean, { recursive: true, force: true });
  }
});

test('00055 AC16 & AC17: repeated runs are byte-identical and write no byte', () => {
  const root = setupPriorityWorkspace([
    { prefix: '00001', name: 'alpha', priority: 'high', effort: 'S', body: 'Uses `skills/alpha/one.cjs`.' },
    { prefix: '00002', name: 'beta', priority: 'low', body: 'Uses `skills/alpha/one.cjs` and `skills/beta/two.cjs`.' },
    { prefix: '00003', name: 'gamma', blockedBy: ['00002'] }
  ]);
  try {
    fs.mkdirSync(path.join(root, '.sdw', 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.sdw', 'state', 'run-fixture.state.json'),
      JSON.stringify({ runId: 'run-fixture', status: 'running' }, null, 2),
      'utf8'
    );
    const before = Object.fromEntries(snapshotTree(root));

    for (const args of [[], ['--json'], ['--collisions'], ['--limit', '2']]) {
      const first = runListByPriority(root, args);
      const second = runListByPriority(root, args);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stdout, second.stdout, `stdout is byte-identical for ${args.join(' ') || '(table)'}`);
    }

    const after = Object.fromEntries(snapshotTree(root));
    assert.deepEqual(after, before, 'specification files, the registry, and run state are untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00055 AC18: authoring validation rejects out-of-enum priority and effort', () => {
  const spec = (extra) => `---
id: null
slug: 00001-enum
title: "Enum"
source: local
status: draft
specDate: 2026-10-22
${extra}---
# Specification — Enum
## Description
Desc.
### Design Intent
Intent.
## Acceptance Criteria
- AC1: The system shall validate declared ranking fields.
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
- Rejection of an out-of-enum priority
`;

  const valid = validate(spec('priority: high\nvalue: "x"\neffort: M\n'), { mode: 'authoring' });
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));

  const badPriority = validate(spec('priority: urgent\n'), { mode: 'authoring' });
  assert.equal(badPriority.ok, false);
  const priorityError = badPriority.errors.find((error) => error.code === 'priority');
  assert.ok(priorityError, 'priority enum violation is reported');
  assert.match(priorityError.message, /urgent/);
  assert.match(priorityError.message, /high, medium, low/);

  const badEffort = validate(spec('effort: XL\n'), { mode: 'authoring' });
  assert.equal(badEffort.ok, false);
  const effortError = badEffort.errors.find((error) => error.code === 'effort');
  assert.ok(effortError, 'effort enum violation is reported');
  assert.match(effortError.message, /XL/);
  assert.match(effortError.message, /S, M, L/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-spec-enum-'));
  try {
    const file = path.join(root, '00001-enum.md');
    fs.writeFileSync(file, spec('priority: urgent\n'), 'utf8');
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'skills', 'sdw-spec', 'scripts', 'validate_spec.cjs'), '--mode=authoring', file],
      { encoding: 'utf8' }
    );
    assert.equal(run.status, 1, 'the validator CLI exits 1');
    assert.match(run.stderr, /priority must be one of: high, medium, low \(found "urgent"\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00055 AC19: sdw-spec docs declare the subcommand and ranking fields within budget', () => {
  const root = path.join(__dirname, '..');
  const skill = fs.readFileSync(path.join(root, 'skills', 'sdw-spec', 'SKILL.md'), 'utf8');
  const standard = fs.readFileSync(path.join(root, 'skills', 'sdw-spec', 'references', 'spec_standard.md'), 'utf8');

  assert.ok(skill.split(/\r?\n/).length <= 120, 'the Tier-1 skill stays within its 120-line budget');
  for (const doc of [skill, standard]) {
    assert.ok(doc.includes('list-by-priority'), 'the subcommand is documented');
    for (const field of ['priority', 'value', 'effort', 'blockedBy']) {
      assert.ok(doc.includes(field), `${field} is documented`);
    }
  }

  assert.match(skill, /\| `priority` \| `high`, `medium`, `low` \| `medium` \|/);
  assert.match(skill, /\| `value` \| free text, one line \| none \|/);
  assert.match(skill, /\| `effort` \| `S`, `M`, `L` \| unset \|/);
  assert.match(skill, /\| `blockedBy` \| list of prefixes or slugs \| empty \|/);
  assert.match(standard, /'high' \| 'medium' \| 'low' \(default 'medium'\)/);
  assert.match(standard, /'S' \| 'M' \| 'L' \(default: unset\)/);
  assert.match(standard, /prefixes or slugs that land first \(default: empty\)/);
});
