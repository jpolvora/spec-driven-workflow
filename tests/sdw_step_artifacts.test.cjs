'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwOrch = require('../skills/sdw-orch/scripts/sdw_orch.cjs');
const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const artifactWriter = require('../skills/sdw-orch/scripts/artifact_writer.cjs');

function setupTestRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-art-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "SDW Tester"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "tester@sdw.org"', { cwd: tmpDir, stdio: 'ignore' });

  // Baseline SDW workspace
  sdwConfig.cmdInit({ root: tmpDir, force: true });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.sdw/state/*\n!.sdw/state/.gitkeep\n.sdw/worktrees/\n', 'utf8');

  // Initial commit
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-artifacts', version: '1.0.0' }, null, 2), 'utf8');
  execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

  return tmpDir;
}

function createDummySpec(repoRoot, slug) {
  const specsDir = path.join(repoRoot, '.sdw', 'specs');
  if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });

  const specPath = path.join(specsDir, `${slug}.md`);
  const content = `---
id: null
slug: ${slug}
title: "Step Artifacts Test ${slug}"
source: local
specDate: 2026-10-19
---

# Specification — Step Artifacts Test ${slug}

## Description
Specification for step artifacts verification.
Affects file: skills/${slug}/scripts/worker.cjs

### Design Intent
Auditable intermediate artifacts for steps 2, 3, and 5.

## Acceptance Criteria
- AC1: The system shall persist step artifacts in dedicated run directory.
- AC2: The system shall record artifact paths in run state.

## Notes
Implementation notes.

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
| Ready | Valid | Check |

## Validation & Observation Notes
### Telemetry & Observable Signals
Artifacts written to disk.

### Negative & Failing Test Scenarios
- Scenario 1: Fails on invalid input.
`;

  fs.writeFileSync(specPath, content, 'utf8');
  return specPath;
}

test('sdw-step-artifacts - AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC12, AC13: Step 2, 3, 5 artifacts written and linked in state', () => {
  const repoRoot = setupTestRepo();
  try {
    const slug = '014-dummy-step-artifacts';
    const specPath = createDummySpec(repoRoot, slug);
    const runId = `run-${Date.now()}-${slug}`;

    const res = sdwOrch.cmdRun({
      specPath,
      root: repoRoot,
      runId,
      skipSecurity: true,
      skipReview: true,
      unattended: true,
      minScore: 0,
      implementation: {
        mode: 'command',
        command: 'node -e "const fs = require(\'fs\'); fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({ taskId: process.env.SDW_TASK_ID, acIds: [\'AC1\'], filesChanged: [\'.sdw/specs/014-dummy-step-artifacts.md\'], summary: \'done\' }));"'
      }
    });

    assert.strictEqual(res, 0);

    const state = stateManager.loadRunState(repoRoot, runId);

    // AC1 & AC6: artifactsDir recorded in state
    assert.ok(state.artifactsDir);
    assert.strictEqual(state.artifactsDir, `.sdw/state/${slug}/${runId}`);

    // AC5, AC6, AC7: Artifact paths relative with forward slashes
    const expectedStep2 = `.sdw/state/${slug}/${runId}/${slug}-step-2.md`;
    const expectedStep3 = `.sdw/state/${slug}/${runId}/${slug}-step-3.md`;
    const expectedStep5 = `.sdw/state/${slug}/${runId}/${slug}-step-5.md`;

    assert.strictEqual(state.steps[2].artifact, expectedStep2);
    assert.strictEqual(state.steps[3].artifact, expectedStep3);
    assert.strictEqual(state.steps[5].artifact, expectedStep5);

    // AC12: Steps 1, 4, 6, 7, 8 do not emit step artifacts
    assert.strictEqual(state.steps[1].artifact, null);
    assert.strictEqual(state.steps[4].artifact, null);
    assert.strictEqual(state.steps[6].artifact, null);
    assert.strictEqual(state.steps[7].artifact, null);
    assert.strictEqual(state.steps[8].artifact, null);

    // Verify files on disk
    const step2Abs = path.join(repoRoot, expectedStep2);
    const step3Abs = path.join(repoRoot, expectedStep3);
    const step5Abs = path.join(repoRoot, expectedStep5);

    assert.ok(fs.existsSync(step2Abs), 'Step 2 artifact must exist on disk');
    assert.ok(fs.existsSync(step3Abs), 'Step 3 artifact must exist on disk');
    assert.ok(fs.existsSync(step5Abs), 'Step 5 artifact must exist on disk');

    // AC2 & AC13: Step 2 contents
    const step2Content = fs.readFileSync(step2Abs, 'utf8');
    assert.ok(step2Content.includes('# Step 2 Artifact: Refinement Result'));
    assert.ok(step2Content.includes(`- **Specification Slug:** ${slug}`));
    assert.ok(step2Content.includes(`- **Run ID:** ${runId}`));
    assert.ok(step2Content.includes('## Decision Gaps & Resolutions'));
    assert.ok(step2Content.includes('## Decision Tree Walk'));
    assert.ok(step2Content.includes('## Refined Spec Snapshot'));

    // AC3 & AC13: Step 3 contents
    const step3Content = fs.readFileSync(step3Abs, 'utf8');
    assert.ok(step3Content.includes('# Step 3 Artifact: DAG Plan'));
    assert.ok(step3Content.includes('## Complexity Analysis'));
    assert.ok(step3Content.includes('## Task Decomposition'));
    assert.ok(step3Content.includes('## Task Context Prompts'));

    // AC4 & AC13: Step 5 contents
    const step5Content = fs.readFileSync(step5Abs, 'utf8');
    assert.ok(step5Content.includes('# Step 5 Artifact: Preliminary Implementation Report'));
    assert.ok(step5Content.includes('## Implementation Summary'));
    assert.ok(step5Content.includes('## Conformance Score'));
    assert.ok(step5Content.includes('## Verified Acceptance Criteria'));
    assert.ok(step5Content.includes('## Feedback'));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-step-artifacts - AC8: Resumed run reuses existing artifacts directory from state', () => {
  const repoRoot = setupTestRepo();
  try {
    const slug = '014-resume-artifacts';
    const runId = `run-${Date.now()}-${slug}`;

    // Initialize state manually with custom artifactsDir
    const customArtifactsDir = `.sdw/state/${slug}/custom-dir-${runId}`;
    const state = stateManager.createRunState({
      root: repoRoot,
      slug,
      runId,
      artifactsDir: customArtifactsDir
    });

    assert.strictEqual(state.artifactsDir, customArtifactsDir);

    // Resumed load preserves artifactsDir
    const reloaded = stateManager.loadRunState(repoRoot, runId);
    assert.strictEqual(reloaded.artifactsDir, customArtifactsDir);

    // Writing an artifact via helper targets the custom directory
    const rel = artifactWriter.writeStep2Artifact({
      targetRoot: repoRoot,
      specSlug: slug,
      runId,
      grillingResult: { gaps: [] },
      effectiveSpecContent: '# Spec',
      artifactsDir: reloaded.artifactsDir
    });

    assert.ok(rel.includes(`custom-dir-${runId}`));
    assert.ok(fs.existsSync(path.join(repoRoot, rel)));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-step-artifacts - AC9: Step re-execution overwrites artifact file deterministically', () => {
  const repoRoot = setupTestRepo();
  try {
    const slug = '014-overwrite-artifacts';
    const runId = `run-${Date.now()}-${slug}`;

    const rel1 = artifactWriter.writeStep5Artifact({
      targetRoot: repoRoot,
      specSlug: slug,
      runId,
      scoreReport: { score: 6, minScore: 8, passed: false, totalAcs: 2, verifiedCount: 1, failingCount: 1 },
      dagPlan: { tasks: [] }
    });

    const fileAbs = path.join(repoRoot, rel1);
    assert.ok(fs.readFileSync(fileAbs, 'utf8').includes('Score:** 6/10'));
    assert.ok(fs.readFileSync(fileAbs, 'utf8').includes('Result:** FAILED'));

    // Re-execute step 5 with passing score
    const rel2 = artifactWriter.writeStep5Artifact({
      targetRoot: repoRoot,
      specSlug: slug,
      runId,
      scoreReport: { score: 10, minScore: 8, passed: true, totalAcs: 2, verifiedCount: 2, failingCount: 0 },
      dagPlan: { tasks: [] }
    });

    assert.strictEqual(rel1, rel2);
    const updatedContent = fs.readFileSync(fileAbs, 'utf8');
    assert.ok(updatedContent.includes('Score:** 10/10'));
    assert.ok(updatedContent.includes('Result:** PASSED'));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('sdw-step-artifacts - AC10: Persistence failure logs warning and records error without halting run', () => {
  const repoRoot = setupTestRepo();
  try {
    const slug = '014-failure-artifacts';
    const runId = `run-${Date.now()}-${slug}`;
    stateManager.createRunState({ root: repoRoot, slug, runId });

    // Target a completely invalid file path (e.g. invalid character or non-creatable path)
    let warned = false;
    const origWarn = console.warn;
    console.warn = (msg) => {
      if (msg && (msg.includes('Failed to persist step') || msg.includes('Artifact persistence warning'))) {
        warned = true;
      }
    };

    try {
      // In Windows/Node, passing an un-creatable directory structure or invalid path triggers catch block
      const invalidPath = path.join(repoRoot, '.sdw', 'state', slug, runId, '\0invalid.md');
      const res = artifactWriter.writeStep2Artifact({
        targetRoot: repoRoot,
        specSlug: slug,
        runId,
        artifactsDir: path.join(repoRoot, 'non-existent\0dir')
      });

      assert.strictEqual(res, null);
      assert.ok(warned);

      const state = stateManager.loadRunState(repoRoot, runId);
      assert.ok(state.errors.some(e => e.error.includes('Artifact persistence warning')));
      // Status not changed to failed by persistence warning alone
      assert.strictEqual(state.status, 'in_progress');
    } finally {
      console.warn = origWarn;
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
