const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const memory = require('../skills/sdw-memory/scripts/sdw_memory.cjs');

const MEMORY_SCRIPT = path.resolve(__dirname, '..', 'skills', 'sdw-memory', 'scripts', 'sdw_memory.cjs');

process.env.SDW_MEMORY_NO_MEMO = '1';

function findRepoRoot() {
  return path.resolve(__dirname, '..');
}

function setupRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-memory-test-'));
  fs.mkdirSync(path.join(root, '.sdw'), { recursive: true });
  return root;
}

test('sdw-memory - record validates kind, title, avoid, action', () => {
  const root = setupRoot();
  try {
    const r = memory.recordMemory(root, { kind: 'nope', title: 'T', avoid: 'A', action: 'X' }, { backend: 'traps' });
    assert.strictEqual(r.exit, 1);
    const r2 = memory.recordMemory(root, { kind: 'trap', title: '', avoid: 'A', action: 'X' }, { backend: 'traps' });
    assert.strictEqual(r2.exit, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-memory - record writes a traps row and dedupes by slug', () => {
  const root = setupRoot();
  try {
    const r = memory.recordMemory(root,
      { kind: 'trap', title: 'No debugger statements', avoid: 'Committed debugger lines', action: 'Delete them' },
      { backend: 'traps' });
    assert.strictEqual(r.exit, 0);
    assert.strictEqual(r.report.slug, 'no-debugger-statements');
    assert.deepStrictEqual(r.report.recorded, [{ backend: 'traps', slug: 'no-debugger-statements' }]);
    const rows = fs.readFileSync(path.join(root, '.sdw', 'memory', 'traps.md'), 'utf8')
      .split('\n').filter(l => l.includes('| no-debugger-statements |'));
    assert.strictEqual(rows.length, 1);
    const dup = memory.recordMemory(root,
      { kind: 'trap', title: 'No debugger statements', avoid: 'A', action: 'B' },
      { backend: 'traps' });
    assert.strictEqual(dup.exit, 1);
    assert.match(dup.error, /already registered/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-memory - query finds related traps by keyword', () => {
  const root = setupRoot();
  try {
    memory.recordMemory(root,
      { kind: 'error', title: 'Windows path separators', avoid: 'Backslash paths', action: 'Normalize slashes' },
      { backend: 'traps' });
    const q = memory.queryMemory(root, 'windows separators', { backend: 'traps', limit: 5 });
    assert.ok(!q.error);
    assert.strictEqual(q.hints.length, 1);
    assert.strictEqual(q.hints[0].slug, 'windows-path-separators');
    assert.ok(q.sources.some(s => s.startsWith('memory-traps:')));
    const miss = memory.queryMemory(root, 'unrelated zebra topic', { backend: 'traps' });
    assert.strictEqual(miss.hints.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-memory - recordTrap compat wrapper records and dedupes', () => {
  const root = setupRoot();
  try {
    const r = memory.recordTrap({ slug: 'surgical-diff', title: 'Surgical diff', avoid: 'A', action: 'B', root });
    assert.strictEqual(r.recorded, true);
    assert.strictEqual(r.slug, 'surgical-diff');
    const dup = memory.recordTrap({ slug: 'surgical-diff', title: 'Surgical diff', avoid: 'A', action: 'B', root });
    assert.strictEqual(dup.recorded, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-memory - consolidate merges duplicate slugs', () => {
  const root = setupRoot();
  try {
    memory.recordMemory(root, { kind: 'trap', title: 'Dup', avoid: 'A', action: 'B' }, { backend: 'traps' });
    fs.appendFileSync(path.join(root, '.sdw', 'memory', 'traps.md'), '| dup | Dup | general | A2 | B2 | 2026-01-01 |\n', 'utf8');
    const before = fs.readFileSync(path.join(root, '.sdw', 'memory', 'traps.md'), 'utf8').split('\n').filter(l => l.includes('| dup |')).length;
    assert.strictEqual(before, 2);
    const c = memory.consolidateMemory(root, { backend: 'traps' });
    assert.strictEqual(c.exit, 0);
    assert.strictEqual(c.report.removed, 1);
    assert.strictEqual(c.report.kept, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-memory - classify suggests deterministic kinds', () => {
  assert.strictEqual(memory.classifyMemory('leaked api token in logs').kind, 'trap');
  assert.strictEqual(memory.classifyMemory('missing coverage for timeouts').kind, 'gap');
  assert.strictEqual(memory.classifyMemory('preferred error-handling pattern').kind, 'pattern');
  assert.strictEqual(memory.classifyMemory('crash on null input').kind, 'error');
  const c = memory.classifyMemory('leaked api token in logs');
  assert.ok(c.slug && c.slug.length > 0);
});

test('sdw-memory - files backend scans .sdw/memory entries but excludes the traps table', () => {
  const root = setupRoot();
  try {
    fs.mkdirSync(path.join(root, '.sdw', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sdw', 'memory', 'traps.md'),
      '# Anti-Regression Traps Log\n\n| Slug | Title | Layer | Avoid | Action | Date |\n|---|---|---|---|---|---|\n| dup-risk | Dup risk | general | Repeating queries | Consult once per rule | 2026-01-01 |\n', 'utf8');
    fs.writeFileSync(path.join(root, '.sdw', 'memory', 'gaps.md'),
      '# Gaps\n\n- Unverified retry loop in ship convergence needs a regression test.\n', 'utf8');
    const q = memory.queryMemory(root, 'retry loop ship convergence', { backend: 'files' });
    assert.ok(!q.error);
    assert.strictEqual(q.hints.length, 1);
    assert.strictEqual(q.hints[0].file, '.sdw/memory/gaps.md');
    const dup = memory.queryMemory(root, 'dup risk', { backend: 'files' });
    assert.strictEqual(dup.hints.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-memory - doctor passes on a complete skill', () => {
  const r = memory.cmdDoctor({});
  assert.strictEqual(r.exit, 0);
  assert.strictEqual(r.result.passed, true);
});

test('sdw-memory - ws-memo skill compatibility resolves the installed skill', () => {
  const { resolveSkillDir, wsMemoStatus } = require('../skills/sdw-memory/scripts/backends/wsmemo.cjs');
  const root = findRepoRoot();
  const dir = resolveSkillDir(root, 'ws-memo');
  assert.ok(dir, 'ws-memo skill must resolve in this repo');
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
  const st = wsMemoStatus(root);
  assert.strictEqual(st.hasSkill, true);
  assert.strictEqual(st.skillDir, dir);
});

test('sdw-memory - memo launcher resolves without a shell', () => {
  delete process.env.SDW_MEMORY_NO_MEMO;
  try {
    const { resolveMemoLauncher, runMemo } = require('../skills/sdw-memory/scripts/backends/wsmemo.cjs');
    const launcher = resolveMemoLauncher();
    assert.ok(launcher === null || typeof launcher.argv0 === 'string');
    const r = runMemo(['--help'], { timeout: 20000 });
    if (launcher) {
      assert.strictEqual(r.ok, true);
    } else {
      assert.strictEqual(r.ok, false);
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
    }
  } finally {
    process.env.SDW_MEMORY_NO_MEMO = '1';
  }
});

test('sdw-memory - files backend is read-only and queryable', () => {
  const root = setupRoot();
  try {
    fs.writeFileSync(path.join(root, 'MEMORY.md'), '# Notes\n\nAvoid committing debugger statements.\n', 'utf8');
    const q = memory.queryMemory(root, 'debugger statements', { backend: 'files' });
    assert.ok(!q.error);
    assert.strictEqual(q.hints.length, 1);
    assert.strictEqual(q.hints[0].source, 'memory-files');
    const r = memory.recordMemory(root,
      { kind: 'trap', title: 'X', avoid: 'Y', action: 'Z' },
      { backend: 'files' });
    assert.strictEqual(r.exit, 1);
    assert.match(r.error, /read-only/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-memory - memory.backends config disables backends without errors', () => {
  const root = setupRoot();
  try {
    fs.writeFileSync(path.join(root, '.sdw', 'config.json'), JSON.stringify({
      memory: { backends: { wsMemo: false, traps: false, files: false } }
    }), 'utf8');
    const cfg = memory.loadMemoryConfig(root);
    assert.strictEqual(cfg.backends.wsMemo, false);
    const q = memory.queryMemory(root, 'anything', { backend: 'traps' });
    assert.ok(!q.error);
    assert.strictEqual(q.hints.length, 0);
    assert.ok(q.sources.every(s => s.includes('consult-skipped')));
    const all = memory.queryMemory(root, 'anything', { backend: 'all' });
    assert.ok(!all.error);
    assert.strictEqual(all.hints.length, 0);
    const rec = memory.recordMemory(root,
      { kind: 'trap', title: 'T', avoid: 'A', action: 'B' },
      { backend: 'auto' });
    assert.strictEqual(rec.exit, 0);
    assert.deepStrictEqual(rec.report.recorded, []);
    assert.strictEqual(rec.report.noop, true);
    const explicit = memory.recordMemory(root,
      { kind: 'trap', title: 'T', avoid: 'A', action: 'B' },
      { backend: 'ws-memo' });
    assert.strictEqual(explicit.exit, 0);
    assert.strictEqual(explicit.report.noop, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-memory - memory.backends config defaults to enabled', () => {
  const root = setupRoot();
  try {
    const cfg = memory.loadMemoryConfig(root);
    assert.deepStrictEqual(cfg, {});
    const res = memory.backendsEnabled(root, 'ws-memo');
    assert.strictEqual(res.enabled['ws-memo'], true);
    assert.strictEqual(res.enabled.traps, true);
    assert.strictEqual(res.enabled.files, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Spec 00057: run-scoped learnings (AC20-AC24).
// ---------------------------------------------------------------------------

function setupRun(status = 'in_progress') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-memory-run-'));
  const runId = 'run-5000-learnings';
  const state = {
    runId,
    specSlug: '00500-learnings',
    status,
    currentStep: 4,
    artifactsDir: `.sdw/state/00500-learnings/${runId}`,
    steps: { 4: { name: 'implementation', status: 'in_progress' }, 7: { name: 'code_review', status: 'pending' } },
    reportContributions: []
  };
  fs.mkdirSync(path.join(root, '.sdw', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdw', 'state', `${runId}.state.json`), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { root, runId, state };
}

function readState(root, runId) {
  return JSON.parse(fs.readFileSync(path.join(root, '.sdw', 'state', `${runId}.state.json`), 'utf8'));
}

const LEARNING_DRAFT = {
  kind: 'trap',
  title: 'Retry must abandon the active dispatch first',
  avoid: 'Dispatching a second task while one is in flight.',
  action: 'Abandon the active task with a reason before dispatching again.',
  slug: 'retry-must-abandon',
  severity: 'high',
  layer: 'application',
  paths: ['skills/sdw-orch/scripts/sdw_orch.cjs']
};

test('00057 AC20 & AC21: a run record appends the learning contribution and writes the run-scoped index', () => {
  const { root, runId } = setupRun();
  try {
    const recorded = memory.recordRunMemory(root, LEARNING_DRAFT, { backend: 'traps', runId, step: 4 });
    assert.strictEqual(recorded.exit, 0);
    assert.strictEqual(recorded.report.learning.body.kind, 'trap');
    assert.strictEqual(recorded.report.learning.body.slug, 'retry-must-abandon');
    assert.strictEqual(recorded.report.learning.body.severity, 'high');
    assert.strictEqual(recorded.report.learning.body.layer, 'application');
    assert.deepStrictEqual(recorded.report.learning.body.pathPatterns, ['skills/sdw-orch/scripts/sdw_orch.cjs']);
    assert.strictEqual(recorded.report.learning.body.backend, 'traps');
    assert.strictEqual(recorded.report.learning.step, 4);

    const state = readState(root, runId);
    const contributions = state.reportContributions.filter(entry => entry.kind === 'learning');
    assert.strictEqual(contributions.length, 1, 'AC20: the run state carries the learning contribution');
    assert.strictEqual(contributions[0].stepName, 'implementation');
    assert.strictEqual(contributions[0].title, LEARNING_DRAFT.title);
    assert.strictEqual(contributions[0].body.slug, 'retry-must-abandon');

    const indexPath = path.join(root, '.sdw', 'state', '00500-learnings', runId, 'learnings.json');
    assert.ok(fs.existsSync(indexPath), 'AC21: the run-scoped index is written in the run artifact directory');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.strictEqual(index.learnings.length, 1);
    assert.deepStrictEqual(index.learnings[0], contributions[0], 'AC21: the index entry is the same learning object as the contribution');
    assert.strictEqual(recorded.report.index, '.sdw/state/00500-learnings/run-5000-learnings/learnings.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00057 AC21: an unreachable backend still records the learning in the run index', () => {
  const { root, runId } = setupRun();
  try {
    fs.writeFileSync(path.join(root, '.sdw', 'config.json'), JSON.stringify({
      memory: { backends: { wsMemo: false, traps: false, files: false } }
    }), 'utf8');
    const recorded = memory.recordRunMemory(root, LEARNING_DRAFT, { backend: 'auto', runId, step: 4 });
    assert.strictEqual(recorded.exit, 0, 'the run record succeeds even with no reachable backend');
    assert.strictEqual(recorded.report.backendUnavailable, true);
    assert.strictEqual(recorded.report.learning.body.backend, 'unavailable', 'AC21: the backend is reported unavailable');
    const index = JSON.parse(fs.readFileSync(path.join(root, '.sdw', 'state', '00500-learnings', runId, 'learnings.json'), 'utf8'));
    assert.strictEqual(index.learnings[0].body.slug, 'retry-must-abandon');
    assert.strictEqual(memory.readRunLearnings(root, runId).length, 1, 'AC21: the learning stays queryable in-run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00057 AC22: query --run merges the run index with the enabled backends and the digest matches the files', () => {
  const { root, runId } = setupRun();
  try {
    memory.recordMemory(root, {
      kind: 'gap',
      title: 'Harness dismisses the retry guard',
      avoid: 'Assuming every dispatch survives.',
      action: 'Re-check the guard after a resume.',
      slug: 'harness-retry-guard'
    }, { backend: 'traps' });
    memory.recordRunMemory(root, LEARNING_DRAFT, { backend: 'traps', runId, step: 4 });

    const result = spawnSync(process.execPath, [
      MEMORY_SCRIPT, 'query', 'retry dispatch guard', '--run', runId, '--root', root, '--backend', 'traps', '--json'
    ], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.sources.includes('run-index:1 hints'), 'AC22: the run index answers the query');
    assert.ok(payload.sources.some(source => source.startsWith('memory-traps:')), 'AC22: the enabled backend is merged in');
    const slugs = payload.hints.map(hint => hint.slug);
    assert.ok(slugs.includes('retry-must-abandon'), 'AC22: the in-run learning is returned');
    assert.ok(slugs.includes('harness-retry-guard'), 'AC22: the backend entry is returned');

    const digest = memory.selectLearningDigest({ root, runId, files: ['skills/sdw-orch/scripts/sdw_orch.cjs'] });
    assert.strictEqual(digest.length, 1, 'AC22: the digest selects the matching learning');
    assert.strictEqual(digest[0].body.slug, 'retry-must-abandon');
    assert.strictEqual(memory.selectLearningDigest({ root, runId, files: ['tests/other.test.cjs'] }).length, 0, 'AC22: a non-matching step gets no learning');

    memory.recordRunMemory(root, { ...LEARNING_DRAFT, slug: 'critical-learning', severity: 'critical', paths: ['skills/**'] }, { backend: 'traps', runId, step: 5 });
    const ordered = memory.selectLearningDigest({ root, runId, files: ['skills/sdw-orch/scripts/sdw_orch.cjs'] });
    assert.deepStrictEqual(ordered.map(entry => entry.body.slug), ['critical-learning', 'retry-must-abandon'], 'AC22: the digest orders by severity then step');
    assert.strictEqual(memory.selectLearningDigest({ root, runId, files: ['skills/sdw-orch/scripts/sdw_orch.cjs'], limit: 1 }).length, 1, 'AC22: the digest is capped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('00057 AC24: applying a learning records the applying step and the evidence on the learning', () => {
  const { root, runId } = setupRun();
  try {
    memory.recordRunMemory(root, LEARNING_DRAFT, { backend: 'traps', runId, step: 4 });
    const applied = memory.applyLearning({ root, runId, slug: 'retry-must-abandon', step: 7, evidence: 'skills/sdw-orch/scripts/sdw_orch.cjs:910' });
    assert.strictEqual(applied.applied, true);
    assert.deepStrictEqual(applied.appliedBy, { step: 7, evidence: 'skills/sdw-orch/scripts/sdw_orch.cjs:910' });

    const index = JSON.parse(fs.readFileSync(path.join(root, '.sdw', 'state', '00500-learnings', runId, 'learnings.json'), 'utf8'));
    assert.deepStrictEqual(index.learnings[0].body.appliedBy, applied.appliedBy, 'AC24: the index names the applying step');
    const state = readState(root, runId);
    assert.deepStrictEqual(state.reportContributions[0].body.appliedBy, applied.appliedBy, 'AC24: the contribution names the applying step');

    const missing = memory.applyLearning({ root, runId, slug: 'never-recorded', step: 7, evidence: 'x:1' });
    assert.strictEqual(missing.applied, false, 'AC24: applying an absent learning fails instead of inventing one');
    assert.match(missing.error, /not recorded/);

    const noEvidence = memory.applyLearning({ root, runId, slug: 'retry-must-abandon', step: 7 });
    assert.strictEqual(noEvidence.applied, false, 'AC24: an application without evidence is refused');

    // The CLI path the protocol documents must reach the same code: a regression
    // passed the root string as the options object, so every CLI call failed.
    const cli = spawnSync(process.execPath, [
      MEMORY_SCRIPT, 'apply', '--run', runId, '--slug', 'retry-must-abandon',
      '--step', '8', '--evidence', 'skills/sdw-orch/scripts/sdw_orch.cjs:920',
      '--root', root, '--json'
    ], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, `AC24: the CLI applies a recorded learning: ${cli.stderr}`);
    const cliPayload = JSON.parse(cli.stdout);
    assert.strictEqual(cliPayload.applied, true, 'AC24: the CLI reports the application');
    assert.deepStrictEqual(
      cliPayload.appliedBy,
      { step: 8, evidence: 'skills/sdw-orch/scripts/sdw_orch.cjs:920' },
      'AC24: the CLI records the applying step and the evidence'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
