'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { validateFile } = require('../skills/sdw-spec/scripts/validate_spec.cjs');

const CLI = path.join(__dirname, '..', 'skills', 'sdw-spec', 'scripts', 'sdw_spec.cjs');
const SLUG = '00099-drift-fixture';
const NAMED_PATH = 'skills/demo/scripts/demo.cjs';
const UNNAMED_PATH = 'skills/demo/scripts/other.cjs';

const FIXTURE_SPEC = `---
id: null
slug: ${SLUG}
title: "Drift Fixture"
source: local
status: ready-to-implement
specDate: 2026-10-21
---
# Specification — Drift Fixture

## Description

Fixture specification for drift repair verification. It names \`${NAMED_PATH}\`.

## Acceptance Criteria

- AC1: The system shall record the fixture script path.

## Notes

- Base note.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Semantic matching | Path inference could assign the wrong specification. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Mapping signal | Exact path mention | Conservative matching avoids false assignments. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Validation | Passes authoring validation | Run validate_spec.cjs |

## Validation & Observation Notes

### Telemetry & Observable Signals

- The report names matched and unmatched paths.

### Negative & Failing Test Scenarios

- An unknown base exits 1.
`;

const FIXTURE_INDEX = `# Specification Index

| Prefix | Slug | Status | Health | Title |
|--------|------|--------|--------|-------|
| 00099 | ${SLUG} | pending | PASS | Drift Fixture |
`;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupDriftRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-spec-update-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'SDW Spec Tests']);
  git(root, ['config', 'user.email', 'spec-tests@sdw.org']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const specPath = path.join(specsDir, `${SLUG}.md`);
  const indexPath = path.join(specsDir, 'index.specs.md');
  fs.writeFileSync(specPath, FIXTURE_SPEC, 'utf8');
  fs.writeFileSync(indexPath, FIXTURE_INDEX, 'utf8');

  for (const relPath of [NAMED_PATH, UNNAMED_PATH]) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, 'module.exports = "base";\n', 'utf8');
  }

  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture base']);

  return { root, specsDir, specPath, indexPath };
}

function runUpdate(root, args) {
  return spawnSync(process.execPath, [CLI, 'update', '--root', root, ...args], { cwd: root, encoding: 'utf8' });
}

function listTree(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        walk(path.join(dir, entry.name), rel);
      } else {
        found.push(rel);
      }
    }
  };
  walk(root, '');
  return found;
}

// AC7: the only new lines are the reported insertion block plus blank separators;
// every original line survives, in order.
function assertOnlyInsertionAdded(original, updated, insertion) {
  const insertionLines = insertion.split('\n');
  const updatedLines = updated.split('\n');
  const start = updatedLines.findIndex((line, index) =>
    insertionLines.every((expected, offset) => updatedLines[index + offset] === expected)
  );
  assert.ok(start >= 0, 'the reported insertion appears as a contiguous block');

  const remaining = updatedLines.slice(0, start).concat(updatedLines.slice(start + insertionLines.length));
  const originalLines = original.split('\n');
  let cursor = 0;
  let blankAdditions = 0;
  for (const line of remaining) {
    if (cursor < originalLines.length && line === originalLines[cursor]) {
      cursor += 1;
    } else if (line === '') {
      blankAdditions += 1;
    } else {
      assert.fail(`content outside the reported insertion changed or was added: ${JSON.stringify(line)}`);
    }
  }
  assert.equal(cursor, originalLines.length, 'every original line survives in order');
  assert.ok(blankAdditions <= 2, `only blank separator lines may be added, saw ${blankAdditions}`);
}

test('AC7: --apply inserts only the reported text under ## Notes and preserves every other byte', () => {
  const { root, specPath } = setupDriftRepo();
  try {
    const original = fs.readFileSync(specPath, 'utf8');
    assert.equal(validateFile(specPath, { mode: 'authoring' }).ok, true, 'fixture specification is authoring-valid');

    fs.writeFileSync(path.join(root, NAMED_PATH), 'module.exports = "changed";\n', 'utf8');
    fs.writeFileSync(path.join(root, UNNAMED_PATH), 'module.exports = "changed too";\n', 'utf8');

    const proposal = runUpdate(root, ['--slug', SLUG, '--json']);
    assert.equal(proposal.status, 0, proposal.stderr);
    const report = JSON.parse(proposal.stdout);
    assert.deepEqual(report.matchedFiles, [NAMED_PATH]);
    assert.deepEqual(report.unmatchedFiles, [UNNAMED_PATH]);
    assert.equal(fs.readFileSync(specPath, 'utf8'), original, 'proposal mode modifies nothing');

    const applied = runUpdate(root, ['--slug', SLUG, '--apply', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    const applyReport = JSON.parse(applied.stdout);
    assert.equal(applyReport.applied, true);
    assert.equal(applyReport.file, `.sdw/specs/${SLUG}.md`);

    const updated = fs.readFileSync(specPath, 'utf8');
    assert.equal(updated.split(applyReport.insertion).length, 2, 'the reported insertion is written verbatim and once');
    assert.match(applyReport.insertion, /^### Drift Update \(.+; base HEAD\)$/m);
    assert.ok(applyReport.insertion.includes(`- \`${NAMED_PATH}\`: named by this specification and changed in the working set`));
    assert.ok(applyReport.insertion.includes(`- Revision: ${applyReport.revisionLine}`));
    assert.ok(!updated.includes(UNNAMED_PATH), 'an unmatched file is never recorded');

    const notesStart = updated.indexOf('## Notes');
    const insertStart = updated.indexOf(applyReport.insertion);
    const nextHeading = updated.slice(notesStart + '## Notes'.length).search(/^## /m);
    const nextHeadingStart = notesStart + '## Notes'.length + nextHeading;
    assert.ok(notesStart >= 0 && nextHeading >= 0);
    assert.ok(insertStart > notesStart && insertStart < nextHeadingStart, 'insertion lands under ## Notes only');

    assertOnlyInsertionAdded(original, updated, applyReport.insertion);
    assert.equal(validateFile(specPath, { mode: 'authoring' }).ok, true, 'specification stays authoring-valid after --apply');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC11: --apply leaves the specification header, lifecycle status, and registry row unchanged', () => {
  const { root, specPath, indexPath } = setupDriftRepo();
  try {
    const original = fs.readFileSync(specPath, 'utf8');
    const registry = fs.readFileSync(indexPath, 'utf8');
    const header = original.match(/^---\n[\s\S]*?\n---\n/)[0];

    fs.writeFileSync(path.join(root, NAMED_PATH), 'module.exports = "changed";\n', 'utf8');

    const applied = runUpdate(root, ['--slug', SLUG, '--apply', '--json']);
    assert.equal(applied.status, 0, applied.stderr);

    const updated = fs.readFileSync(specPath, 'utf8');
    assert.equal(updated.match(/^---\n[\s\S]*?\n---\n/)[0], header, 'frontmatter bytes are untouched');
    assert.match(updated, /^status: ready-to-implement$/m, 'lifecycle status is not rewritten');
    assert.match(updated, /^id: null$/m);
    assert.match(updated, /^slug: 00099-drift-fixture$/m);
    assert.equal(fs.readFileSync(indexPath, 'utf8'), registry, 'the registry row is not rewritten');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC8: an unresolved --from reference exits 1 and names the reference', () => {
  const { root, specPath } = setupDriftRepo();
  try {
    const original = fs.readFileSync(specPath, 'utf8');
    fs.writeFileSync(path.join(root, NAMED_PATH), 'module.exports = "changed";\n', 'utf8');

    const missing = 'no-such-commit-00038';
    const unresolved = runUpdate(root, ['--slug', SLUG, '--from', missing]);
    assert.equal(unresolved.status, 1);
    assert.ok(unresolved.stderr.includes('unresolved reference'), 'reports an unresolved reference');
    assert.ok(unresolved.stderr.includes(missing), 'names the unresolved reference');

    const blob = git(root, ['hash-object', '-w', path.join(root, NAMED_PATH)]).trim();
    const notCommit = runUpdate(root, ['--slug', SLUG, '--from', blob]);
    assert.equal(notCommit.status, 1, 'an object that is not a commit is rejected');
    assert.ok(notCommit.stderr.includes(blob), 'names the object that did not resolve to a commit');

    assert.equal(fs.readFileSync(specPath, 'utf8'), original, 'a failed base lookup writes nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC9: a slug with no specification file exits 1 and names the slug', () => {
  const { root, specsDir, specPath } = setupDriftRepo();
  try {
    const original = fs.readFileSync(specPath, 'utf8');
    const before = listTree(specsDir);

    const slug = '99999-absent-spec';
    const result = runUpdate(root, ['--slug', slug]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(slug), 'names the missing slug');
    assert.equal(fs.readFileSync(specPath, 'utf8'), original, 'the existing specification is untouched');
    assert.deepEqual(listTree(specsDir), before, 'no specification file is created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC10: no drift exits 0 with "No specification drift found" and writes nothing', () => {
  const { root, specsDir, specPath } = setupDriftRepo();
  try {
    const original = fs.readFileSync(specPath, 'utf8');

    const clean = runUpdate(root, ['--slug', SLUG]);
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /^No specification drift found$/m);
    assert.equal(fs.readFileSync(specPath, 'utf8'), original, 'the specification is untouched');

    fs.writeFileSync(path.join(root, UNNAMED_PATH), 'module.exports = "changed";\n', 'utf8');
    const before = { specs: listTree(specsDir), root: listTree(root) };
    const unrelated = runUpdate(root, ['--slug', SLUG, '--apply']);
    assert.equal(unrelated.status, 0, 'a change the specification never names is not drift');
    assert.match(unrelated.stdout, /^No specification drift found$/m);
    assert.equal(fs.readFileSync(specPath, 'utf8'), original, '--apply writes nothing when nothing matched');
    assert.deepEqual({ specs: listTree(specsDir), root: listTree(root) }, before, 'no file is created or modified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DoR: update is exposed through help and the documented JSON report fields', () => {
  const help = spawnSync(process.execPath, [CLI, 'update', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const token of ['update', '--slug', '--from', '--apply']) {
    assert.ok(help.stdout.includes(token), `help documents ${token}`);
  }

  const { root, specPath } = setupDriftRepo();
  try {
    fs.writeFileSync(path.join(root, NAMED_PATH), 'module.exports = "changed";\n', 'utf8');
    const report = JSON.parse(runUpdate(root, ['--slug', SLUG, '--json']).stdout);
    assert.equal(report.slug, SLUG);
    assert.equal(report.base, 'HEAD');
    assert.deepEqual(report.matchedFiles, [NAMED_PATH]);
    assert.deepEqual(report.unmatchedFiles, []);
    assert.equal(typeof report.insertion, 'string');
    assert.equal(typeof report.revisionLine, 'string');
    assert.ok(report.insertion.includes(report.revisionLine));
    assert.equal(fs.readFileSync(specPath, 'utf8').includes('### Drift Update'), false, 'JSON proposal does not write');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
