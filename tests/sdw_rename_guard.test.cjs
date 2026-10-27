'use strict';

// Spec 00070: the skill formerly named sdw-orch is now sdw-run. Historical
// records keep the old name; everything live must speak the new one.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RETIRED_NAME = /sdw[-_]orch|sdwOrch/i;
const TEXT_FILE = /\.(md|cjs|js|json|ya?ml|txt)$/i;
const ALLOWED = [
  /^\.sdw\/specs\//,
  /^CHANGELOG\.md$/,
  /^tests\/sdw_rename_guard\.test\.cjs$/
];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function staleReferences() {
  const hits = [];
  for (const file of trackedFiles()) {
    if (ALLOWED.some((pattern) => pattern.test(file))) continue;
    if (!TEXT_FILE.test(file)) continue;
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    text.split('\n').forEach((line, index) => {
      if (RETIRED_NAME.test(line)) hits.push(`${file}:${index + 1}`);
    });
  }
  return hits;
}

test('AC12: no live file references the retired skill name', () => {
  const hits = staleReferences();
  assert.deepEqual(hits, [], `Retired name found at:\n${hits.join('\n')}`);
});

test('AC9: invoking the retired name exits non-zero and names sdw-run', () => {
  const retired = ['sdw', 'orch'].join('-');
  const cli = path.join(REPO_ROOT, 'skills', 'sdw-run', 'scripts', 'sdw_run.cjs');
  const result = spawnSync(process.execPath, [cli, retired], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 1, 'retired invocation exits non-zero');
  assert.match(result.stderr, /sdw-run/, 'message names the current skill');
});

test('AC1, AC2, AC11: the skill lives only under skills/sdw-run', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'skills', 'sdw-run', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'skills', 'sdw-run', 'scripts', 'sdw_run.cjs')));
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'skills', 'sdw-orch')), false);
  const testFiles = fs.readdirSync(path.join(REPO_ROOT, 'tests'));
  assert.equal(testFiles.some((name) => RETIRED_NAME.test(name)), false, 'no retired test file names');
});
