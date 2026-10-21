const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const memory = require('../skills/sdw-memory/scripts/sdw_memory.cjs');

process.env.SDW_MEMORY_NO_MEMO = '1';

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
    const rows = fs.readFileSync(path.join(root, '.sdw', 'traps.md'), 'utf8')
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
    fs.appendFileSync(path.join(root, '.sdw', 'traps.md'), '| dup | Dup | general | A2 | B2 | 2026-01-01 |\n', 'utf8');
    const before = fs.readFileSync(path.join(root, '.sdw', 'traps.md'), 'utf8').split('\n').filter(l => l.includes('| dup |')).length;
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

test('sdw-memory - doctor passes on a complete skill', () => {
  const r = memory.cmdDoctor({});
  assert.strictEqual(r.exit, 0);
  assert.strictEqual(r.result.passed, true);
});
