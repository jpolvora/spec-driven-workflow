'use strict';

// Spec 00049: the finder derives candidates from controlled environment facts,
// reports its search bounds, exits 0 on every outcome, never prints a transcript
// line body, and never writes a file. A preload clears the environment that the
// platform injects into the child, so no real host variable can win.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FINDER = path.join(REPO_ROOT, 'skills', 'sdw-retro', 'scripts', 'find_session_transcript.cjs');
const SKILL_DIR = path.join(REPO_ROOT, 'skills', 'sdw-retro');

function makeDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function ageFile(file, hours) {
  const when = new Date(Date.now() - hours * 60 * 60 * 1000);
  fs.utimesSync(file, when, when);
}

function snapshotTree(root) {
  const entries = [];
  const walk = (dir) => {
    const children = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const child of children) {
      const absolute = path.join(dir, child.name);
      const stat = fs.statSync(absolute);
      entries.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        type: child.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
      if (child.isDirectory()) walk(absolute);
    }
  };
  walk(root);
  return entries;
}

function runFinder(env, args = [], cwd = REPO_ROOT, preloadLines = []) {
  const preload = path.join(os.tmpdir(), `sdw-finder-env-${process.pid}-${crypto.randomUUID()}.cjs`);
  fs.writeFileSync(preload, [
    "'use strict';",
    'const supplied = JSON.parse(process.env.SDW_FINDER_ENV);',
    'for (const key of Object.keys(process.env)) delete process.env[key];',
    'Object.assign(process.env, supplied);',
    ...preloadLines,
    ''
  ].join('\n'), 'utf8');

  const childEnv = { SDW_FINDER_ENV: JSON.stringify(env) };
  if (process.platform === 'win32') {
    childEnv.SystemRoot = process.env.SystemRoot;
    childEnv.WINDIR = process.env.WINDIR;
  }

  try {
    return spawnSync(process.execPath, ['--require', preload, FINDER, ...args], {
      cwd,
      encoding: 'utf8',
      env: childEnv
    });
  } finally {
    fs.rmSync(preload, { force: true });
  }
}

function parseResult(run) {
  assert.equal(run.signal, null);
  assert.equal(run.status, 0, run.stderr);
  const stdout = run.stdout.trim();
  assert.ok(stdout, 'the finder prints one JSON object');
  assert.equal(stdout.split(/\r?\n/).length, 1, 'stdout is exactly one JSON object');
  return JSON.parse(stdout);
}

function readSkillDoc(...segments) {
  return fs.readFileSync(path.join(SKILL_DIR, ...segments), 'utf8').replace(/\s+/g, ' ');
}

test('AC3: a session-id path segment under a home root is found and scored', (t) => {
  const root = makeDir(t, 'sdw-retro-discovery-');
  const home = path.join(root, 'home');
  const sessionId = 'abc12345';
  const transcript = path.join(home, 'projects', 'workspace', `session-${sessionId}`, 'messages.jsonl');
  writeFile(transcript, 'user: fixture message\nassistant: fixture reply\n');
  ageFile(transcript, 48);

  const output = parseResult(runFinder({
    SDW_FIXTURE_HOME: home,
    SDW_FIXTURE_SESSION_ID: sessionId
  }, ['--root', root], root));

  assert.equal(output.found, true);
  assert.equal(output.source, 'search-root');
  assert.equal(output.sessionId, sessionId);
  assert.equal(output.path, 'home/projects/workspace/session-abc12345/messages.jsonl');
  assert.equal(path.resolve(root, output.path), transcript);
  assert.equal(output.score, 90);
  assert.ok(output.entriesScanned > 0);
  assert.equal(output.roots.length, 1);
  assert.equal(output.roots[0].variable, 'SDW_FIXTURE_HOME');
  assert.equal(output.roots[0].path, home);
});

test('AC3: a file-valued variable resolves its transcript directly', (t) => {
  const root = makeDir(t, 'sdw-retro-file-');
  const transcript = path.join(root, 'transcripts', 'session.jsonl');
  writeFile(transcript, 'user: direct file fixture\n');

  const output = parseResult(runFinder({ SDW_FIXTURE_TRANSCRIPT_FILE: transcript }, [], root));

  assert.equal(output.found, true);
  assert.equal(output.source, 'env-file');
  assert.equal(output.sessionId, null);
  assert.equal(output.path, transcript);
  assert.equal(output.score, 30);
  assert.equal(output.entriesScanned, 0);
  assert.deepEqual(output.roots, []);
});

test('AC3: a directory value without a root-like variable name is ignored', (t) => {
  const root = makeDir(t, 'sdw-retro-ignored-');
  const container = path.join(root, 'store');
  writeFile(path.join(container, 'nested', 'transcript.jsonl'), 'user: should stay unseen\n');

  const output = parseResult(runFinder({ SDW_FIXTURE_STORE: container }, [], root));

  assert.equal(output.found, false);
  assert.equal(output.path, null);
  assert.equal(output.entriesScanned, 0);
  assert.deepEqual(output.roots, []);
});

test('AC3: without a session id a recent non-transcript extension is rejected', (t) => {
  const root = makeDir(t, 'sdw-retro-extension-');
  const home = path.join(root, 'home');
  writeFile(path.join(home, 'notes.txt'), 'user: not a transcript\n');

  const output = parseResult(runFinder({ SDW_FIXTURE_HOME: home }, [], root));

  assert.equal(output.found, false);
  assert.equal(output.path, null);
});

test('AC3: an operating-system root variable is skipped', (t) => {
  const root = makeDir(t, 'sdw-retro-os-');
  const system = path.join(root, 'system');
  const data = path.join(root, 'data');
  writeFile(path.join(system, 'session.v4.jsonl'), 'user: os fixture\n');
  writeFile(path.join(data, 'sessions', 'session-abc12345', 'transcript.jsonl'), 'user: data fixture\n');

  const output = parseResult(runFinder({
    SDW_FIXTURE_SYSTEM_ROOT: system,
    SDW_FIXTURE_DATA: data,
    SDW_FIXTURE_SESSION_ID: 'abc12345'
  }, ['--root', root], root));

  assert.equal(output.roots.length, 1);
  assert.equal(output.roots[0].variable, 'SDW_FIXTURE_DATA');
  assert.equal(output.found, true);
  assert.equal(output.path, 'data/sessions/session-abc12345/transcript.jsonl');
});

test('AC3/AC4: an empty root reports no candidate and still reports its bounds', (t) => {
  const root = makeDir(t, 'sdw-retro-empty-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });

  const output = parseResult(runFinder({ SDW_FIXTURE_HOME: home }, [], root));

  assert.equal(output.found, false);
  assert.equal(output.path, null);
  assert.equal(output.sessionId, null);
  assert.equal(output.entriesScanned, 0);
  assert.equal(Number.isInteger(output.elapsedMs), true);
  assert.ok(output.elapsedMs >= 0);
  assert.equal(output.roots.length, 1);
});

test('AC4: --max-entries stops a tree of many files at the bound', (t) => {
  const root = makeDir(t, 'sdw-retro-bound-');
  const home = path.join(root, 'home');
  const nested = path.join(home, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  for (let index = 0; index < 100; index += 1) {
    fs.writeFileSync(path.join(nested, `entry-${String(index).padStart(3, '0')}.bin`), 'x');
  }

  const output = parseResult(runFinder({ SDW_FIXTURE_HOME: home }, ['--max-entries', '3'], root));

  assert.equal(output.entriesScanned, 3);
  assert.equal(output.found, false);
  assert.equal(Number.isInteger(output.elapsedMs), true);
});

test('AC4: a per-root budget and the session-id rule reject a noisy-root decoy', (t) => {
  const root = makeDir(t, 'sdw-retro-budget-');
  const noisy = path.join(root, 'noisy');
  const store = path.join(root, 'store');
  const sessionId = 'feed1234';
  fs.mkdirSync(noisy, { recursive: true });
  for (let index = 0; index < 100; index += 1) {
    fs.writeFileSync(path.join(noisy, `decoy-${String(index).padStart(3, '0')}.txt`), 'user: decoy\n');
  }
  writeFile(path.join(noisy, 'newest.txt'), 'user: recent decoy\n');
  const match = path.join(store, 'sessions', `session-${sessionId}`, 'transcript.jsonl');
  writeFile(match, 'user: match\n');

  const output = parseResult(runFinder({
    SDW_FIXTURE_DATA: noisy,
    SDW_FIXTURE_DIR: store
  }, ['--root', root, '--max-entries', '40'], root));

  assert.equal(output.roots.length, 2);
  assert.equal(output.roots[0].variable, 'SDW_FIXTURE_DATA');
  assert.equal(output.found, true);
  assert.equal(output.path, 'store/sessions/session-feed1234/transcript.jsonl');
  assert.equal(path.resolve(root, output.path), match);
  assert.ok(output.entriesScanned > 0 && output.entriesScanned <= 30, `entriesScanned=${output.entriesScanned}`);
});

test('AC5: an unreadable root still exits 0 with one JSON object', (t) => {
  const root = makeDir(t, 'sdw-retro-unreadable-');
  const home = path.join(root, 'home');
  writeFile(path.join(home, 'nested', 'session.jsonl'), 'user: fixture\n');

  const output = parseResult(runFinder({ SDW_FIXTURE_HOME: home }, [], root, [
    "const fs = require('fs');",
    'const blocked = process.env.SDW_FIXTURE_HOME;',
    'const readdir = fs.readdirSync;',
    'fs.readdirSync = function (dir, options) {',
    '  if (dir === blocked) {',
    '    fs.rmSync(blocked, { recursive: true, force: true });',
    "    const error = new Error('root removed after resolution');",
    "    error.code = 'ENOENT';",
    '    throw error;',
    '  }',
    '  return readdir.call(fs, dir, options);',
    '};'
  ]));

  assert.equal(output.found, false);
  assert.equal(output.path, null);
  assert.equal(output.entriesScanned, 0);
  assert.equal(output.roots.length, 1);
});

test('AC5: an expired budget still exits 0 with one JSON object', (t) => {
  const root = makeDir(t, 'sdw-retro-timeout-');
  const home = path.join(root, 'home');
  writeFile(path.join(home, 'nested', 'session.jsonl'), 'user: fixture\n');

  const output = parseResult(runFinder({ SDW_FIXTURE_HOME: home }, ['--timeout-ms', '0'], root));

  assert.equal(output.found, false);
  assert.equal(output.path, null);
  assert.equal(output.entriesScanned, 0);
  assert.equal(output.roots.length, 1);
  assert.equal(Number.isInteger(output.elapsedMs), true);
});

test('AC7: finder output never contains a transcript line body and changes no file', (t) => {
  const root = makeDir(t, 'sdw-retro-content-');
  const marker = 'TRANSCRIPT_LINE_SHOULD_NOT_LEAK_00049';
  const transcript = path.join(root, 'transcripts', 'session.jsonl');
  writeFile(transcript, `user: ${marker}\nassistant: another line\n`);
  const before = snapshotTree(root);

  const run = runFinder({ SDW_FIXTURE_TRANSCRIPT_FILE: transcript }, [], root);
  const output = parseResult(run);

  assert.equal(output.found, true);
  assert.equal(run.stdout.includes(marker), false);
  assert.equal(run.stderr.includes(marker), false);
  assert.deepEqual(snapshotTree(root), before);
});

test('AC6: the skill states both discovery branches and the host default', () => {
  for (const doc of [
    readSkillDoc('SKILL.md'),
    readSkillDoc('references', 'session_discovery.md'),
    readSkillDoc('references', 'retro_protocol.md')
  ]) {
    assert.match(doc, /found[^\n]{0,10}true/);
    assert.match(doc, /--transcript <path>/);
    assert.match(doc, /retro-session-\{runId\}\.md/);
    assert.match(doc, /--transcript <file> --transcript-mode captured/);
    assert.equal(/--transcript-mode host\b/.test(doc), false);
  }
});
