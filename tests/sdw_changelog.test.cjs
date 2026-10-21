'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'skills', 'sdw-changelog', 'scripts', 'append_changelog.cjs');

const ENTRY_ARGS = [
  '--prompt', 'Record the delivery',
  '--done', 'Wrote the record',
  '--result', 'Changelog updated'
];

function makeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-changelog-'));
  fs.mkdirSync(path.join(dir, '.sdw'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(root, config) {
  fs.writeFileSync(path.join(root, '.sdw', 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function run(root, args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { cwd: root, encoding: 'utf8' });
}

test('append: creates the configured file below # Changelog and reports the path', (t) => {
  const root = makeProject(t);
  writeConfig(root, { changelogEnabled: true, changelogFile: 'docs/CHANGELOG.md' });

  const result = run(root, [...ENTRY_ARGS, '--agent', 'worker', '--date', '2026-01-02 03:04']);
  assert.equal(result.status, 0, result.stderr);

  const file = path.join(root, 'docs', 'CHANGELOG.md');
  assert.ok(fs.existsSync(file), 'missing parent directory and file are created');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '# Changelog\n\n### [2026-01-02 03:04] Agent: worker\n'
      + '- **Prompt**: Record the delivery\n'
      + '- **Done**: Wrote the record\n'
      + '- **Result**: Changelog updated\n'
  );
  assert.match(result.stdout, /changelog: appended to /);
  assert.ok(result.stdout.includes(file), 'status line names the resolved path');
});

test('AC8: appending preserves every existing entry byte-identical', (t) => {
  const root = makeProject(t);
  writeConfig(root, {});

  const file = path.join(root, 'CHANGELOG.md');
  const existingEntry = '### [2025-12-31 23:59] Agent: legacy\n'
    + '- **Prompt**: legacy prompt\n'
    + '- **Done**: legacy work\n'
    + '- **Result**: legacy result with no trailing newline';
  fs.writeFileSync(file, `# Changelog\n\n${existingEntry}`, 'utf8');

  const result = run(root, [...ENTRY_ARGS, '--date', '2026-05-06 07:08']);
  assert.equal(result.status, 0, result.stderr);

  const updated = fs.readFileSync(file, 'utf8');
  assert.equal(
    updated,
    '# Changelog\n\n'
      + '### [2026-05-06 07:08] Agent: agent\n'
      + '- **Prompt**: Record the delivery\n'
      + '- **Done**: Wrote the record\n'
      + '- **Result**: Changelog updated\n\n'
      + existingEntry
  );
  assert.ok(updated.endsWith(existingEntry), 'existing entry survives byte-identical');
});

test('AC7: an identical Prompt/Done/Result block is skipped and the file is unchanged', (t) => {
  const root = makeProject(t);
  writeConfig(root, {});

  const first = run(root, [...ENTRY_ARGS, '--agent', 'worker', '--date', '2026-01-02 03:04']);
  assert.equal(first.status, 0, first.stderr);

  const file = path.join(root, 'CHANGELOG.md');
  const before = fs.readFileSync(file, 'utf8');

  const duplicate = run(root, [...ENTRY_ARGS, '--agent', 'other', '--date', '2026-09-09 09:09']);
  assert.equal(duplicate.status, 0, 'duplicate exits 0');
  assert.match(duplicate.stdout, /skipped: duplicate-block/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'duplicate leaves the file byte-identical');

  const duplicateJson = run(root, [...ENTRY_ARGS, '--json']);
  assert.equal(duplicateJson.status, 0);
  assert.deepEqual(JSON.parse(duplicateJson.stdout), { ok: true, skipped: 'duplicate-block' });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'JSON duplicate leaves the file byte-identical');
});

test('disabled: changelogEnabled false exits 0 with skipped: disabled and writes nothing', (t) => {
  const root = makeProject(t);
  writeConfig(root, { changelogEnabled: false });

  const result = run(root, [...ENTRY_ARGS, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, skipped: 'disabled' });
  assert.equal(fs.existsSync(path.join(root, 'CHANGELOG.md')), false, 'no changelog file is created');
});

test('AC9: a missing required flag exits 1 with a usage message naming the flag', (t) => {
  const root = makeProject(t);
  writeConfig(root, {});

  const result = run(root, ['--prompt', 'Record the delivery', '--result', 'Changelog updated']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing required --done/);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(path.join(root, 'CHANGELOG.md')), false, 'nothing is written');
});

test('AC10: empty or whitespace-only required values are rejected before writing', (t) => {
  const root = makeProject(t);
  writeConfig(root, {});

  const whitespace = run(root, ['--prompt', '   ', '--done', 'Wrote the record', '--result', 'Changelog updated']);
  assert.equal(whitespace.status, 1);
  assert.match(whitespace.stderr, /--prompt/);
  assert.match(whitespace.stderr, /must not be empty/);

  const empty = run(root, ['--prompt', 'Record the delivery', '--done', 'Wrote the record', '--result', '']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /--result/);

  assert.equal(fs.existsSync(path.join(root, 'CHANGELOG.md')), false, 'nothing is written');
});

test('AC11: absolute or escaping changelog paths exit 1 without writing', (t) => {
  const absoluteRoot = makeProject(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-changelog-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const absoluteTarget = path.join(outsideDir, 'CHANGELOG.md');
  writeConfig(absoluteRoot, { changelogFile: absoluteTarget });

  const absolute = run(absoluteRoot, [...ENTRY_ARGS]);
  assert.equal(absolute.status, 1, 'absolute changelogFile is rejected');
  assert.match(absolute.stderr, /changelogFile/);
  assert.equal(fs.existsSync(absoluteTarget), false, 'absolute target is not created');

  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-changelog-escape-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const project = path.join(outer, 'project');
  fs.mkdirSync(path.join(project, '.sdw'), { recursive: true });
  writeConfig(project, { changelogFile: '../escaped.md' });

  const escaping = run(project, [...ENTRY_ARGS]);
  assert.equal(escaping.status, 1, 'escaping changelogFile is rejected');
  assert.match(escaping.stderr, /project root/);
  assert.equal(fs.existsSync(path.join(outer, 'escaped.md')), false, 'escaping target is not created');
});

test('AC12: changelogEnabled and changelogFile are documented in the config schema, config, and reference', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.sdw', 'config.schema.json'), 'utf8'));
  assert.equal(schema.properties.changelogEnabled.type, 'boolean');
  assert.equal(schema.properties.changelogEnabled.default, true);
  assert.equal(schema.properties.changelogFile.type, 'string');
  assert.equal(schema.properties.changelogFile.default, '{projectRoot}/CHANGELOG.md');

  const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.sdw', 'config.json'), 'utf8'));
  assert.equal(config.changelogEnabled, true);
  assert.equal(config.changelogFile, '{projectRoot}/CHANGELOG.md');

  const reference = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-config', 'references', 'config_spec.md'), 'utf8');
  assert.match(reference, /\|\s*`changelogEnabled`\s*\|/);
  assert.match(reference, /\|\s*`changelogFile`\s*\|/);
});
