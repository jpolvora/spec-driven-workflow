'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { registerSpec, readIndex, parseFrontmatter } = require('../skills/sdw-spec/scripts/spec_index.cjs');
const { syncUp, syncDown, runSyncDirection } = require('../skills/sdw-spec/scripts/spec_sync_remote.cjs');

const CLI = path.join(__dirname, '..', 'skills', 'sdw-spec', 'scripts', 'sdw_spec.cjs');

function setupWorkspace(scmProvider = 'github') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-sync-remote-'));
  fs.mkdirSync(path.join(root, '.sdw', 'specs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.sdw', 'config.json'),
    JSON.stringify({ scmProvider }, null, 2),
    'utf8'
  );
  return root;
}

// A specification fixture with the two linkage keys the direction reads.
function writeSpecification(root, options = {}) {
  const { prefix = '00001', slug = `${prefix}-demo-alpha`, title = 'Demo Alpha', source = 'local', scmSpecId = null, status = 'draft', legacyId = null } = options;
  const fileName = `${slug}.md`;
  const filePath = path.join(root, '.sdw', 'specs', fileName);
  const frontmatter = [
    '---',
    `id: ${legacyId !== null ? JSON.stringify(String(legacyId)) : 'null'}`,
    `slug: ${slug}`,
    `title: ${JSON.stringify(title)}`,
    `source: ${source}`,
    `status: ${status}`,
    'specDate: 2026-10-23'
  ];
  if (scmSpecId !== null) frontmatter.splice(3, 0, `scmSpecId: ${JSON.stringify(String(scmSpecId))}`);
  frontmatter.push('---', '', `# Specification — ${title}`, '', '## Description', '', 'Local body content.', '');
  fs.writeFileSync(filePath, frontmatter.join('\n'), 'utf8');
  return filePath;
}

function registerFixture(root, options = {}) {
  const { prefix = '00001', slug = `${prefix}-demo-alpha`, title = 'Demo Alpha', status = 'pending', source = 'local' } = options;
  registerSpec({ prefix, slug, title, status, source, specDate: '2026-10-23', validation: 'PASS' }, { root });
}

// Stubs the provider CLI: presence and auth probes are always answered, and any
// command without a handler fails loudly so no unintended call can slip through.
function createGithubExecutor(handlers = {}) {
  const executor = (cmd) => {
    executor.calls.push(cmd);
    if (cmd.includes('where gh') || cmd.includes('command -v gh')) return 'C:\\bin\\gh.exe';
    if (cmd.includes('gh auth status')) return '';
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (cmd.includes(pattern)) return typeof handler === 'function' ? handler(cmd) : handler;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };
  executor.calls = [];
  return executor;
}

async function captureStderr(operation) {
  const messages = [];
  const original = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  try {
    const result = await operation();
    return { result, messages };
  } finally {
    console.error = original;
  }
}

async function captureStdout(operation) {
  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(' '));
  try {
    const result = await operation();
    return { result, messages };
  } finally {
    console.log = original;
  }
}

// Every byte in the specs directory, used to prove a dry-run writes nothing.
function snapshotSpecs(root) {
  const specsDir = path.join(root, '.sdw', 'specs');
  return fs.readdirSync(specsDir).sort().map((name) => [name, fs.readFileSync(path.join(specsDir, name), 'utf8')]);
}

test('sdw-spec sync-remote - AC1: sync-up creates a provider item and persists the returned id', async () => {
  const root = setupWorkspace();
  try {
    const filePath = writeSpecification(root, { prefix: '00001', slug: '00001-demo-alpha', title: 'Demo Alpha' });
    registerFixture(root, { prefix: '00001', slug: '00001-demo-alpha', title: 'Demo Alpha' });

    const executor = createGithubExecutor({
      'gh issue create': 'https://github.com/org/repo/issues/321\n'
    });

    const report = await syncUp({ root, executor });

    assert.strictEqual(report.direction, 'sync-up');
    assert.strictEqual(report.provider, 'github');
    assert.strictEqual(report.transitions.length, 1);
    assert.strictEqual(report.transitions[0].action, 'created');
    assert.strictEqual(report.transitions[0].slug, '00001-demo-alpha');
    assert.strictEqual(report.transitions[0].id, '321');
    assert.ok(executor.calls.some((cmd) => cmd.startsWith('gh issue create')));

    const frontmatter = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(frontmatter.scmSpecId, '321', 'the created item id must be persisted');
    assert.strictEqual(frontmatter.source, 'github', 'the source must become the registered provider');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC1: sync-up updates a linked specification instead of creating another issue', async () => {
  const root = setupWorkspace();
  try {
    writeSpecification(root, { prefix: '00002', slug: '00002-demo-beta', title: 'Demo Beta', scmSpecId: '45' });
    registerFixture(root, { prefix: '00002', slug: '00002-demo-beta', title: 'Demo Beta' });

    const executor = createGithubExecutor({
      'gh issue view': JSON.stringify({
        number: 45,
        title: 'Old remote title',
        body: 'old remote body',
        state: 'OPEN',
        url: 'https://github.com/org/repo/issues/45'
      }),
      'gh issue edit': ''
    });

    const report = await syncUp({ root, executor });

    assert.strictEqual(report.transitions.length, 1);
    assert.strictEqual(report.transitions[0].action, 'updated');
    assert.strictEqual(report.transitions[0].id, '45');
    assert.ok(executor.calls.some((cmd) => cmd.startsWith('gh issue edit 45')));
    assert.ok(!executor.calls.some((cmd) => cmd.startsWith('gh issue create')), 'a linked specification must never create a second issue');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC1: sync-up treats a legacy id key as the remote link', async () => {
  const root = setupWorkspace();
  try {
    writeSpecification(root, { prefix: '00003', slug: '00003-demo-gamma', title: 'Demo Gamma', legacyId: '77' });
    registerFixture(root, { prefix: '00003', slug: '00003-demo-gamma', title: 'Demo Gamma' });

    const executor = createGithubExecutor({
      'gh issue view': JSON.stringify({ number: 77, title: 'Demo Gamma', body: 'Local body content.', state: 'OPEN', url: 'https://github.com/org/repo/issues/77' }),
      'gh issue edit': ''
    });

    const report = await syncUp({ root, executor });

    assert.strictEqual(report.transitions.length, 1);
    assert.strictEqual(report.transitions[0].action, 'updated');
    assert.ok(!executor.calls.some((cmd) => cmd.startsWith('gh issue create')), 'the legacy anchor must not create a duplicate');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC2 & AC8: sync-down follows remote state and creates a local specification for an unmatched item', async () => {
  const root = setupWorkspace();
  try {
    writeSpecification(root, { prefix: '00004', slug: '00004-demo-delta', title: 'Demo Delta', scmSpecId: '45' });
    registerFixture(root, { prefix: '00004', slug: '00004-demo-delta', title: 'Demo Delta' });

    const executor = createGithubExecutor({
      'gh issue list': JSON.stringify([
        { number: 45, title: 'Demo Delta', body: 'remote body', url: 'https://github.com/org/repo/issues/45', state: 'CLOSED', labels: [] },
        { number: 99, title: 'Remote only', body: 'no local match', url: 'https://github.com/org/repo/issues/99', state: 'OPEN', labels: [] }
      ])
    });

    const report = await syncDown({ root, executor });

    assert.strictEqual(report.direction, 'sync-down');
    const updated = report.transitions.find((transition) => transition.slug === '00004-demo-delta');
    assert.strictEqual(updated.action, 'updated');
    assert.strictEqual(updated.from, 'pending');
    assert.strictEqual(updated.to, 'completed');

    const created = report.transitions.find((transition) => transition.id === '99');
    assert.strictEqual(created.action, 'created', 'a remote item without a local match creates one');
    assert.ok(created.slug, 'the created transition names the local specification');
    const createdFrontmatter = parseFrontmatter(
      fs.readFileSync(path.join(root, '.sdw', 'specs', `${created.slug}.md`), 'utf8')
    );
    assert.strictEqual(createdFrontmatter.scmSpecId || createdFrontmatter.id, '99', 'the created specification carries the remote item id');
    assert.strictEqual(createdFrontmatter.source, 'github', 'the created specification carries the remote source');

    const row = readIndex({ root }).entries.find((entry) => entry.slug === '00004-demo-delta');
    assert.strictEqual(row.status, 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC2: sync-down never regresses a completed row to pending', async () => {
  const root = setupWorkspace();
  try {
    writeSpecification(root, { prefix: '00005', slug: '00005-demo-epsilon', title: 'Demo Epsilon', scmSpecId: '46' });
    registerFixture(root, { prefix: '00005', slug: '00005-demo-epsilon', title: 'Demo Epsilon', status: 'completed' });

    const executor = createGithubExecutor({
      'gh issue list': JSON.stringify([
        { number: 46, title: 'Demo Epsilon', body: 'remote body', url: 'https://github.com/org/repo/issues/46', state: 'OPEN', labels: [] }
      ])
    });

    const report = await syncDown({ root, executor });

    assert.strictEqual(report.transitions.length, 1);
    assert.strictEqual(report.transitions[0].action, 'skipped');
    assert.strictEqual(report.transitions[0].from, 'completed');

    const row = readIndex({ root }).entries.find((entry) => entry.slug === '00005-demo-epsilon');
    assert.strictEqual(row.status, 'completed', 'delivery evidence outranks a lagging tracker state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC3: sync-up with provider none exits non-zero, names none, and writes nothing', () => {
  const root = setupWorkspace('none');
  try {
    const filePath = writeSpecification(root, { prefix: '00006', slug: '00006-demo-zeta', title: 'Demo Zeta' });
    registerFixture(root, { prefix: '00006', slug: '00006-demo-zeta', title: 'Demo Zeta' });
    const before = fs.readFileSync(filePath, 'utf8');

    const result = spawnSync(process.execPath, [CLI, 'sync-up', '--root', root], { encoding: 'utf8' });

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /SCM provider is disabled \(none\)/);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), before, 'a refused run must not touch the specification');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC3: sync-down with provider none exits non-zero and names none', () => {
  const root = setupWorkspace('none');
  try {
    writeSpecification(root, { prefix: '00007', slug: '00007-demo-eta', title: 'Demo Eta', scmSpecId: '50' });
    registerFixture(root, { prefix: '00007', slug: '00007-demo-eta', title: 'Demo Eta' });
    const before = fs.readFileSync(path.join(root, '.sdw', 'specs', 'index.specs.md'), 'utf8');

    const result = spawnSync(process.execPath, [CLI, 'sync-down', '--root', root], { encoding: 'utf8' });

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /SCM provider is disabled \(none\)/);
    assert.strictEqual(fs.readFileSync(path.join(root, '.sdw', 'specs', 'index.specs.md'), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC4: a missing provider CLI exits non-zero naming gh', async () => {
  const root = setupWorkspace('github');
  try {
    writeSpecification(root, { prefix: '00008', slug: '00008-demo-theta', title: 'Demo Theta' });
    registerFixture(root, { prefix: '00008', slug: '00008-demo-theta', title: 'Demo Theta' });

    const executor = () => { throw new Error('not found on PATH'); };
    const { result, messages } = await captureStderr(() => runSyncDirection('sync-up', { root, executor }));

    assert.strictEqual(result, 1);
    assert.match(messages.join('\n'), /CLI "gh" is not installed or not found on PATH/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC4: an unauthenticated provider CLI exits non-zero naming the login command', async () => {
  const root = setupWorkspace('github');
  try {
    writeSpecification(root, { prefix: '00009', slug: '00009-demo-iota', title: 'Demo Iota' });
    registerFixture(root, { prefix: '00009', slug: '00009-demo-iota', title: 'Demo Iota' });

    const executor = (cmd) => {
      if (cmd.includes('where gh') || cmd.includes('command -v gh')) return 'C:\\bin\\gh.exe';
      throw new Error('gh auth status failed: not logged in');
    };
    const { result, messages } = await captureStderr(() => runSyncDirection('sync-down', { root, executor }));

    assert.strictEqual(result, 1);
    const output = messages.join('\n');
    assert.match(output, /CLI "gh" is not authenticated/);
    assert.match(output, /gh auth login/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC4: the CLI exits 1 through the process boundary when gh is unavailable', () => {
  const root = setupWorkspace('github');
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-empty-path-'));
  try {
    const filePath = writeSpecification(root, { prefix: '00010', slug: '00010-demo-kappa', title: 'Demo Kappa' });
    registerFixture(root, { prefix: '00010', slug: '00010-demo-kappa', title: 'Demo Kappa' });
    const before = fs.readFileSync(filePath, 'utf8');

    const result = spawnSync(process.execPath, [CLI, 'sync-up', '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, PATH: emptyPath, Path: emptyPath }
    });

    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /CLI "gh" is not installed or not found on PATH/);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), before, 'no plan may be applied when the capability is missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC9: sync-down updates a scmSpecId match and never regresses a completed row', async () => {
  const root = setupWorkspace();
  try {
    const pendingPath = writeSpecification(root, { prefix: '00011', slug: '00011-demo-lambda', title: 'Demo Lambda', scmSpecId: '60' });
    registerFixture(root, { prefix: '00011', slug: '00011-demo-lambda', title: 'Demo Lambda' });
    const completedPath = writeSpecification(root, { prefix: '00012', slug: '00012-demo-mu', title: 'Demo Mu', scmSpecId: '61' });
    registerFixture(root, { prefix: '00012', slug: '00012-demo-mu', title: 'Demo Mu', status: 'completed' });

    const executor = createGithubExecutor({
      'gh issue list': JSON.stringify([
        { number: 60, title: 'Demo Lambda', body: fs.readFileSync(pendingPath, 'utf8'), state: 'CLOSED', labels: [] },
        { number: 61, title: 'Demo Mu', body: fs.readFileSync(completedPath, 'utf8'), state: 'OPEN', labels: [] }
      ])
    });

    const report = await syncDown({ root, executor });

    const updated = report.transitions.find((transition) => transition.slug === '00011-demo-lambda');
    assert.strictEqual(updated.action, 'updated');
    assert.strictEqual(updated.from, 'pending');
    assert.strictEqual(updated.to, 'completed');

    const guarded = report.transitions.find((transition) => transition.slug === '00012-demo-mu');
    assert.strictEqual(guarded.action, 'skipped');
    assert.strictEqual(guarded.from, 'completed');
    assert.strictEqual(guarded.to, 'pending');

    const rows = readIndex({ root }).entries;
    assert.strictEqual(rows.find((row) => row.slug === '00011-demo-lambda').status, 'completed');
    assert.strictEqual(rows.find((row) => row.slug === '00012-demo-mu').status, 'completed', 'a remote open state never regresses a completed row');
    assert.deepStrictEqual(report.drift, [], 'a body equal to the local specification is not drift');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC9 & AC11: sync-down matches by slug marker and exact title without creating duplicates', async () => {
  const root = setupWorkspace();
  try {
    writeSpecification(root, { prefix: '00013', slug: '00013-demo-nu', title: 'Demo Nu' });
    registerFixture(root, { prefix: '00013', slug: '00013-demo-nu', title: 'Demo Nu' });
    const omicronPath = writeSpecification(root, { prefix: '00014', slug: '00014-demo-omicron', title: 'Demo Omicron' });
    registerFixture(root, { prefix: '00014', slug: '00014-demo-omicron', title: 'Demo Omicron' });
    const before = fs.readdirSync(path.join(root, '.sdw', 'specs')).sort();

    const executor = createGithubExecutor({
      'gh issue list': JSON.stringify([
        { number: 120, title: 'Renamed in the tracker', body: '<!-- sdw-spec: 00013-demo-nu -->\n\nremote body', state: 'CLOSED', labels: [] },
        { number: 121, title: 'Demo Omicron', body: fs.readFileSync(omicronPath, 'utf8'), state: 'CLOSED', labels: [] }
      ])
    });

    const report = await syncDown({ root, executor });

    const byMarker = report.transitions.find((transition) => transition.id === '120');
    assert.strictEqual(byMarker.slug, '00013-demo-nu', 'the marker names the local specification');
    assert.strictEqual(byMarker.action, 'updated');
    assert.deepStrictEqual(report.drift.map((entry) => entry.id), ['120'], 'the differing body is reported, not copied');

    const byTitle = report.transitions.find((transition) => transition.id === '121');
    assert.strictEqual(byTitle.slug, '00014-demo-omicron', 'an exact title claims an unlinked specification');
    assert.strictEqual(byTitle.action, 'updated');

    assert.deepStrictEqual(
      fs.readdirSync(path.join(root, '.sdw', 'specs')).sort(),
      before,
      'a matched item must not create a second specification'
    );
    assert.ok(
      !executor.calls.some((cmd) => /gh issue (create|edit|close|reopen)/.test(cmd)),
      'sync-down never writes to the provider'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC10: sync-down reports body drift and changes neither body', async () => {
  const root = setupWorkspace();
  try {
    const filePath = writeSpecification(root, { prefix: '00015', slug: '00015-demo-pi', title: 'Demo Pi', scmSpecId: '70' });
    registerFixture(root, { prefix: '00015', slug: '00015-demo-pi', title: 'Demo Pi' });
    const specBefore = fs.readFileSync(filePath, 'utf8');
    const indexBefore = fs.readFileSync(path.join(root, '.sdw', 'specs', 'index.specs.md'), 'utf8');

    const executor = createGithubExecutor({
      'gh issue list': JSON.stringify([
        { number: 70, title: 'Demo Pi', body: 'edited in the tracker', state: 'OPEN', labels: [] }
      ])
    });

    const report = await syncDown({ root, executor });

    assert.strictEqual(report.transitions.length, 1);
    assert.strictEqual(report.transitions[0].action, 'unchanged');
    assert.strictEqual(report.drift.length, 1);
    assert.strictEqual(report.drift[0].slug, '00015-demo-pi');
    assert.strictEqual(report.drift[0].action, 'drift');
    assert.match(report.drift[0].reason, /neither body changed/);

    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), specBefore, 'the local body must not be overwritten');
    assert.strictEqual(fs.readFileSync(path.join(root, '.sdw', 'specs', 'index.specs.md'), 'utf8'), indexBefore);
    assert.ok(
      !executor.calls.some((cmd) => /gh issue (create|edit|close|reopen)/.test(cmd)),
      'the remote body must not be overwritten'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC11: sync-up embeds the slug marker as the first line of every created issue body', async () => {
  const root = setupWorkspace();
  try {
    writeSpecification(root, { prefix: '00016', slug: '00016-demo-rho', title: 'Demo Rho' });
    registerFixture(root, { prefix: '00016', slug: '00016-demo-rho', title: 'Demo Rho' });

    const bodies = [];
    const executor = createGithubExecutor({
      'gh issue create': (cmd) => {
        const bodyFile = cmd.match(/--body-file "([^"]+)"/);
        bodies.push(bodyFile ? fs.readFileSync(bodyFile[1], 'utf8') : '');
        return 'https://github.com/org/repo/issues/500\n';
      }
    });

    const report = await syncUp({ root, executor });

    assert.strictEqual(report.transitions[0].action, 'created');
    assert.strictEqual(bodies.length, 1);
    const lines = bodies[0].split('\n');
    assert.strictEqual(lines[0], '<!-- sdw-spec: 00016-demo-rho -->', 'the marker is the first line of the issue body');
    assert.match(bodies[0], /# Specification/, 'the local specification content follows the marker');
    assert.match(bodies[0], /Local body content\./);

    const frontmatter = parseFrontmatter(fs.readFileSync(path.join(root, '.sdw', 'specs', '00016-demo-rho.md'), 'utf8'));
    assert.strictEqual(frontmatter.scmSpecId, '500', 'the created item id is still persisted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC12: sync-up --dry-run prints the plan without provider contact', async () => {
  const root = setupWorkspace();
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-dry-run-path-'));
  try {
    writeSpecification(root, { prefix: '00017', slug: '00017-demo-sigma', title: 'Demo Sigma' });
    registerFixture(root, { prefix: '00017', slug: '00017-demo-sigma', title: 'Demo Sigma' });
    writeSpecification(root, { prefix: '00018', slug: '00018-demo-tau', title: 'Demo Tau', scmSpecId: '88' });
    registerFixture(root, { prefix: '00018', slug: '00018-demo-tau', title: 'Demo Tau', status: 'completed' });
    const before = snapshotSpecs(root);

    const executor = createGithubExecutor();
    const { result, messages } = await captureStdout(() => runSyncDirection('sync-up', { root, executor, dryRun: true }));

    assert.strictEqual(result, 0);
    assert.deepStrictEqual(executor.calls, [], 'the dry-run must not run a provider command');
    const output = messages.join('\n');
    assert.match(output, /create issue for 00017-demo-sigma \(remote state open\)/, 'a planned create names the slug and mapped state');
    assert.match(output, /update issue #88 for 00018-demo-tau \(remote state closed\)/, 'a planned update names the item and mapped state');
    assert.match(output, /no provider calls, no files modified/);
    assert.deepStrictEqual(snapshotSpecs(root), before, 'the dry-run must not modify disk');

    const cli = spawnSync(process.execPath, [CLI, 'sync-up', '--dry-run', '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, PATH: emptyPath, Path: emptyPath }
    });

    assert.strictEqual(cli.status, 0, 'a dry-run succeeds without an installed provider CLI');
    assert.match(cli.stdout, /create issue for 00017-demo-sigma/);
    assert.match(cli.stdout, /no provider calls, no files modified/);
    assert.deepStrictEqual(snapshotSpecs(root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});

test('sdw-spec sync-remote - AC12: sync-down --dry-run never queries the provider and writes nothing', async () => {
  const root = setupWorkspace();
  try {
    writeSpecification(root, { prefix: '00019', slug: '00019-demo-upsilon', title: 'Demo Upsilon', scmSpecId: '90' });
    registerFixture(root, { prefix: '00019', slug: '00019-demo-upsilon', title: 'Demo Upsilon' });
    const before = snapshotSpecs(root);

    const executor = createGithubExecutor();
    const { result, messages } = await captureStdout(() => runSyncDirection('sync-down', { root, executor, dryRun: true }));

    assert.strictEqual(result, 0);
    assert.deepStrictEqual(executor.calls, [], 'the dry-run must not query the provider');
    assert.match(messages.join('\n'), /reconcile 00019-demo-upsilon \(#90\): remote state is not queried under --dry-run/);
    assert.deepStrictEqual(snapshotSpecs(root), before, 'the dry-run must not modify disk');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
