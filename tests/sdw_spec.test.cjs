'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { initIndex, readIndex, writeIndex, listIndex, archiveSpec, updateSpecStatus } = require('../skills/sdw-spec/scripts/spec_index.cjs');
const { getNextPrefix, createNewSpec, importRemoteSpec, toEarsCriterion } = require('../skills/sdw-spec/scripts/spec_creator.cjs');
const { validate, validateFile } = require('../skills/sdw-spec/scripts/validate_spec.cjs');
const { syncIndex } = require('../skills/sdw-spec/scripts/spec_sync.cjs');
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
    fs.writeFileSync(path.join(specsDir, '001-feature-alpha.md'), `---
id: null
slug: 001-feature-alpha
title: "Feature Alpha"
source: local
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
    assert.equal(entries[0].prefix, '001');
    assert.equal(entries[0].slug, '001-feature-alpha');
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
    assert.equal(getNextPrefix(specsDir), '001');

    // Add 001 and 002
    fs.writeFileSync(path.join(specsDir, '001-first.md'), '# First');
    fs.writeFileSync(path.join(specsDir, '002-second.md'), '# Second');
    assert.equal(getNextPrefix(specsDir), '003');

    // Add 009 -> next is 010
    fs.writeFileSync(path.join(specsDir, '009-ninth.md'), '# Ninth');
    assert.equal(getNextPrefix(specsDir), '010');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC5 & AC6: Specification Listing & Status Filtering', () => {
  const { tmpDir } = setupTestWorkspace();
  try {
    const dummyEntries = [
      { prefix: '001', slug: '001-feat-a', title: 'Feat A', status: 'pending', source: 'local', specDate: '2026-10-19', validation: 'PASS' },
      { prefix: '002', slug: '002-feat-b', title: 'Feat B', status: 'completed', source: 'local', specDate: '2026-10-19', validation: 'PASS' },
      { prefix: '003', slug: '003-feat-c', title: 'Feat C', status: 'archived', source: 'local', specDate: '2026-10-19', validation: 'PASS' }
    ];
    writeIndex(dummyEntries, { root: tmpDir });

    // AC5: listIndex displays all
    const all = listIndex({ root: tmpDir });
    assert.equal(all.length, 3);

    // AC6: Filter by status
    const pendingOnly = listIndex({ root: tmpDir, status: 'pending' });
    assert.equal(pendingOnly.length, 1);
    assert.equal(pendingOnly[0].slug, '001-feat-a');

    const completedOnly = listIndex({ root: tmpDir, status: 'completed' });
    assert.equal(completedOnly.length, 1);
    assert.equal(completedOnly[0].slug, '002-feat-b');

    const archivedOnly = listIndex({ root: tmpDir, status: 'archived' });
    assert.equal(archivedOnly.length, 1);
    assert.equal(archivedOnly[0].slug, '003-feat-c');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC7 & AC8: Specification Archiving & Uncompleted Rejection Gate', () => {
  const { tmpDir } = setupTestWorkspace();
  try {
    const dummyEntries = [
      { prefix: '001', slug: '001-active', title: 'Active', status: 'pending', source: 'local', specDate: '2026-10-19', validation: 'PASS' },
      { prefix: '002', slug: '002-done', title: 'Done', status: 'completed', source: 'local', specDate: '2026-10-19', validation: 'PASS' }
    ];
    writeIndex(dummyEntries, { root: tmpDir });

    // AC8: Rejects archiving uncompleted spec without --force
    assert.throws(() => {
      archiveSpec('001-active', { root: tmpDir, force: false });
    }, /Cannot archive specification "001-active" with status "pending"/);

    // AC7: Archiving completed spec succeeds and records timestamp
    const archived = archiveSpec('002-done', { root: tmpDir });
    assert.equal(archived.status, 'archived');
    assert.ok(archived.archivalDate, 'Records archival timestamp');

    // Archive uncompleted spec with --force succeeds
    const forceArchived = archiveSpec('001-active', { root: tmpDir, force: true });
    assert.equal(forceArchived.status, 'archived');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC9 & AC10: Authoring-Mode Validation & EARS Syntax Rejection', () => {
  // Valid spec with all 5 EARS patterns
  const validSpec = `---
id: null
slug: 001-ears-test
title: "EARS Validation"
source: local
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
    assert.equal(created.prefix, '001');
    assert.equal(created.slug, '001-session-management');
    assert.ok(fs.existsSync(created.filePath), 'Spec file created on disk');

    // Verify it passes validation
    const val = validateFile(created.filePath, { mode: 'authoring' });
    assert.equal(val.ok, true, `Generated spec passes validation: ${JSON.stringify(val.errors)}`);

    // AC12: Registered in index.specs.md with status pending
    const indexData = readIndex({ root: tmpDir });
    assert.equal(indexData.entries.length, 1);
    assert.equal(indexData.entries[0].slug, '001-session-management');
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

    assert.equal(imported.prefix, '001');
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
    fs.writeFileSync(path.join(specsDir, '001-feature-x.md'), `---
id: null
slug: 001-feature-x
title: "Feature X"
source: local
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
      specSlug: '001-feature-x',
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
    fs.writeFileSync(path.join(specsDir, '002-discovered.md'), `---
id: null
slug: 002-discovered
title: "Discovered Spec"
source: local
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
    assert.ok(afterDiscovery.entries.some(e => e.slug === '002-discovered' && e.status === 'pending'));

    // AC22: Missing spec flagged as MISSING without deleting historical row
    fs.unlinkSync(path.join(specsDir, '002-discovered.md'));
    syncIndex({ root: tmpDir });
    const afterMissing = readIndex({ root: tmpDir });
    const missingEntry = afterMissing.entries.find(e => e.slug === '002-discovered');
    assert.ok(missingEntry, 'Missing spec row retained in index');
    assert.equal(missingEntry.validation, 'MISSING');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC23, AC24 & AC25: Orchestrator Integration & Quality Gates', () => {
  const { tmpDir, specsDir } = setupTestWorkspace();
  try {
    const specPath = path.join(specsDir, '001-archived-test.md');
    fs.writeFileSync(specPath, `---
id: null
slug: 001-archived-test
title: "Archived Gate Test"
source: local
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
    updateSpecStatus('001-archived-test', 'completed', { root: tmpDir });
    archiveSpec('001-archived-test', { root: tmpDir });

    // AC25: sdw-orch rejects execution on archived spec without override flag
    const exitCodeBlocked = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '001-archived-test.md',
      force: false,
      allowArchived: false
    });
    assert.equal(exitCodeBlocked, 1, 'Rejects execution on archived spec without override');

    // Unarchive / allow archived execution with --allow-archived flag
    const exitCodeAllowed = sdwOrch.cmdRun({
      root: tmpDir,
      specPath: '001-archived-test.md',
      allowArchived: true,
      minScore: 0,
      skipReview: true,
      skipPr: true,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/001-archived-test.md\'], summary: \'done\' }));"'
      }
    });
    assert.equal(exitCodeAllowed, 0, 'Allows execution on archived spec with --allow-archived');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
