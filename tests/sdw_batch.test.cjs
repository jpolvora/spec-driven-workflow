'use strict';

// sdw-batch queue contract: delegation to single sdw-orch runs, pause/resume
// continuity, completed-run reconciliation, failure policy, and summary output.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'skills', 'sdw-batch', 'scripts', 'sdw_batch.cjs');

const queue = require('../skills/sdw-batch/scripts/batch_queue.cjs');
const cli = require('../skills/sdw-batch/scripts/sdw_batch.cjs');

function writeSpec(root, name, slug) {
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const file = path.join(specsDir, name);
  fs.writeFileSync(file, `---\nslug: ${slug}\ntitle: "${slug}"\n---\n# ${slug}\n\n## Acceptance Criteria\n\n- AC1: The system shall exist.\n`, 'utf8');
  return file;
}

function writeState(root, runId, status, extra = {}) {
  const stateDir = path.join(root, '.sdw', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const pullRequest = extra.pullRequest || null;
  const shipStatus = extra.shipStatus || null;
  fs.writeFileSync(path.join(stateDir, `${runId}.state.json`), JSON.stringify({
    runId,
    status,
    specSlug: extra.specSlug || 'fixture',
    deliveryCommit: extra.deliveryCommit || null,
    branch: extra.branch || 'develop',
    baseCommit: extra.baseCommit || null,
    pullRequest,
    shipStatus,
    // Step 8 output is the delivery record sdw-orch writes for the item.
    steps: {
      8: { name: 'pr_preparation', status: extra.step8Status || 'completed', output: { pullRequest, shipStatus } }
    }
  }, null, 2), 'utf8');
}

function writeConfig(root, config) {
  fs.mkdirSync(path.join(root, '.sdw'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdw', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function writeDeliveredState(root, runId, prNumber) {
  writeState(root, runId, 'completed', {
    deliveryCommit: `commit-${prNumber}`,
    pullRequest: { number: prNumber, url: `https://example.test/pull/${prNumber}` },
    shipStatus: 'delivered'
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-'));
  const alpha = writeSpec(root, '00001-alpha.md', '00001-alpha');
  const beta = writeSpec(root, '00002-beta.md', '00002-beta');
  return { root, specs: [alpha, beta] };
}

function writeRegistry(root, rows) {
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  const lines = [
    '# Specification Index',
    '',
    '| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.prefix} | ${row.slug} | ${row.title || row.slug} | ${row.status} | local | 2026-10-21 | PASS | - |`),
    ''
  ];
  fs.writeFileSync(path.join(specsDir, 'index.specs.md'), lines.join('\n'), 'utf8');
}

function captureLogs(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    return { result: fn(), logs };
  } finally {
    console.log = original;
  }
}

function captureAll(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    return { result: fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

// Pre-flight fixtures need a real base lane on a real remote: a bare `origin`
// plus a work repository whose `develop` pushes to it.
function initRepoWithRemote(root) {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-origin-'));
  git(remote, ['init', '--bare', '-q']);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'SDW Tester']);
  git(root, ['config', 'user.email', 'tester@sdw.org']);
  fs.writeFileSync(path.join(root, 'README.md'), '# batch fixture\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial commit']);
  git(root, ['branch', '-M', 'develop']);
  git(root, ['remote', 'add', 'origin', remote.replace(/\\/g, '/')]);
  git(root, ['push', '-q', '-u', 'origin', 'develop']);
  return remote;
}

function writeDeliveredCommit(root, runId, deliveryCommit, prNumber) {
  writeState(root, runId, 'completed', {
    deliveryCommit,
    pullRequest: { number: prNumber, url: `https://example.test/pull/${prNumber}` },
    shipStatus: 'delivered'
  });
}

test('pre-flight: a missing specification rejects the batch before any manifest exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-pre-'));
  try {
    let invoked = false;
    const code = queue.runBatch(['missing-spec.md'], {
      root,
      noSync: true,
      _invoke: () => { invoked = true; return 0; }
    });
    assert.equal(code, 1);
    assert.equal(invoked, false, 'no delegation happens on pre-flight failure');
    const stateDir = path.join(root, '.sdw', 'state');
    const manifests = fs.existsSync(stateDir)
      ? fs.readdirSync(stateDir).filter(name => name.startsWith('batch-'))
      : [];
    assert.equal(manifests.length, 0, 'no batch manifest is created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run: delegates every item to one single-spec run and completes the queue', () => {
  const { root, specs } = setup();
  try {
    const calls = [];
    const { result, logs } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath, resume }) => {
        calls.push({ runId, specPath, resume });
        writeState(root, runId, 'completed', { deliveryCommit: `commit-${calls.length}` });
        return 0;
      }
    }));

    assert.equal(result, 0);
    assert.equal(calls.length, 2, 'one delegation per specification');
    assert.equal(calls[0].resume, false);
    assert.notEqual(calls[0].runId, calls[1].runId, 'each item gets its own run id');

    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'completed');
    assert.deepEqual(manifest.queue.map(item => item.status), ['completed', 'completed']);
    assert.equal(manifest.queue[0].deliveryCommit, 'commit-1');
    assert.equal(manifest.queue[1].deliveryCommit, 'commit-2');

    const output = logs.join('\n');
    assert.ok(output.includes('SDW Batch Execution Summary'), 'summary is printed');
    assert.ok(output.includes('00001-alpha') && output.includes('00002-beta'), 'summary names both items');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run: a dispatch pause records the run id, pauses the queue, and returns code 4', () => {
  const { root, specs } = setup();
  try {
    const code = queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => {
        writeState(root, runId, 'paused');
        return 4;
      }
    });
    assert.equal(code, 4);
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'paused');
    assert.equal(manifest.queue[0].status, 'awaiting_implementation');
    assert.ok(manifest.queue[0].runId, 'paused item records its run id');
    assert.equal(manifest.queue[1].status, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run: a judgment pause records the run id, pauses the queue, and returns code 5', () => {
  const { root, specs } = setup();
  try {
    let delegatedRunId = null;
    const code = queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => {
        delegatedRunId = runId;
        writeState(root, runId, 'paused');
        return 5;
      }
    });
    assert.equal(code, 5);
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'paused');
    assert.equal(manifest.queue[0].status, 'awaiting_judgment');
    assert.equal(manifest.queue[0].runId, delegatedRunId, 'judgment pause records its run id');
    assert.equal(manifest.queue[1].status, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume: continues the same run and advances only after it completes', () => {
  const { root, specs } = setup();
  try {
    assert.equal(queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => { writeState(root, runId, 'paused'); return 4; }
    }), 4);

    let manifest = queue.loadManifest(queue.loadConfig(root));
    const firstRunId = manifest.queue[0].runId;
    const observed = [];

    const code = queue.resumeBatch(manifest.batchId, {
      root,
      noSync: true,
      _invoke: ({ runId, resume }) => {
        observed.push({ runId, resume });
        if (runId === firstRunId) {
          writeState(root, runId, 'completed', { deliveryCommit: 'first-done' });
          return 0;
        }
        writeState(root, runId, 'paused');
        return 4;
      }
    });

    assert.equal(code, 4, 'queue pauses on the second item after completing the first');
    assert.deepEqual(observed[0], { runId: firstRunId, resume: true }, 'the paused run is resumed, not restarted');

    manifest = queue.loadManifest(queue.loadConfig(root), manifest.batchId);
    assert.equal(manifest.queue[0].status, 'completed');
    assert.equal(manifest.queue[0].runId, firstRunId);
    assert.equal(manifest.queue[0].deliveryCommit, 'first-done');
    assert.equal(manifest.queue[1].status, 'awaiting_implementation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume: a completed run state is reconciled without a second delegation', () => {
  const { root, specs } = setup();
  try {
    const config = queue.loadConfig(root);
    const manifest = queue.createManifest({ specs, options: { batchId: 'batch-manual' }, config });
    manifest.queue[0].status = 'awaiting_implementation';
    manifest.queue[0].runId = 'run-completed';
    queue.saveManifest(config, manifest);
    writeState(root, 'run-completed', 'completed', { deliveryCommit: 'done-123' });

    const invoked = [];
    const code = queue.resumeBatch('batch-manual', {
      root,
      noSync: true,
      _invoke: ({ runId }) => {
        invoked.push(runId);
        writeState(root, runId, 'paused');
        return 4;
      }
    });

    assert.equal(code, 4, 'queue advances to the second item and pauses there');
    assert.equal(invoked.length, 1, 'the completed item is not delegated again');
    assert.notEqual(invoked[0], 'run-completed');

    const updated = queue.loadManifest(config, 'batch-manual');
    assert.equal(updated.queue[0].status, 'completed');
    assert.equal(updated.queue[0].deliveryCommit, 'done-123');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failure: halts by default and continues with --continue-on-error', () => {
  const { root, specs } = setup();
  try {
    const halted = queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => { writeState(root, runId, 'failed'); return 1; }
    });
    assert.equal(halted, 1);
    let manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'halted');
    assert.equal(manifest.queue[0].status, 'failed');
    assert.equal(manifest.queue[1].status, 'pending');

    fs.rmSync(path.join(root, '.sdw', 'state'), { recursive: true, force: true });

    const continued = queue.runBatch(specs, {
      root,
      noSync: true,
      continueOnError: true,
      _invoke: ({ runId, specPath }) => {
        if (specPath.includes('alpha')) { writeState(root, runId, 'failed'); return 1; }
        writeState(root, runId, 'completed', { deliveryCommit: 'second-ok' });
        return 0;
      }
    });
    assert.equal(continued, 1, 'queue finishes with errors');
    manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'completed_with_errors');
    assert.equal(manifest.queue[0].status, 'failed');
    assert.equal(manifest.queue[1].status, 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume: --no-sync and --continue-on-error override the preserved manifest policy', () => {
  const { root, specs } = setup();
  const three = [...specs, writeSpec(root, '00003-gamma.md', '00003-gamma')];
  try {
    assert.equal(queue.runBatch(three, {
      root,
      _invoke: ({ runId }) => { writeState(root, runId, 'paused'); return 4; }
    }), 4);

    let manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.policy.continueOnError, false, 'manifest policy starts without continue-on-error');
    assert.equal(manifest.policy.syncIndex, true, 'manifest policy starts with sync enabled');

    const specSync = require('../skills/sdw-spec/scripts/spec_sync.cjs');
    const originalSyncIndex = specSync.syncIndex;
    let syncCalls = 0;
    specSync.syncIndex = () => { syncCalls += 1; return true; };

    const delegated = [];
    let code;
    try {
      code = queue.resumeBatch(manifest.batchId, {
        root,
        noSync: true,
        continueOnError: true,
        _invoke: ({ runId, resume }) => {
          delegated.push({ runId, resume });
          if (resume) {
            writeState(root, runId, 'completed', { deliveryCommit: 'first-ok' });
            return 0;
          }
          if (delegated.length === 2) {
            writeState(root, runId, 'failed');
            return 1;
          }
          writeState(root, runId, 'completed', { deliveryCommit: `commit-${delegated.length}` });
          return 0;
        }
      });
    } finally {
      specSync.syncIndex = originalSyncIndex;
    }

    assert.equal(code, 1, 'the queue reports the failure after continuing');
    assert.equal(syncCalls, 0, '--no-sync suppresses spec sync even though the manifest enables it');
    assert.deepEqual(delegated.map(entry => entry.resume), [true, false, false], 'the paused run resumes and later items are delegated');
    manifest = queue.loadManifest(queue.loadConfig(root), manifest.batchId);
    assert.deepEqual(manifest.queue.map(item => item.status), ['completed', 'failed', 'completed']);
    assert.equal(manifest.status, 'completed_with_errors', '--continue-on-error overrides the manifest policy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review: a custom --batch-id is normalized to the batch- prefix and stays discoverable', () => {
  const { root, specs } = setup();
  try {
    const config = queue.loadConfig(root);
    const manifest = queue.createManifest({ specs, options: { batchId: 'nightly' }, config });
    assert.equal(manifest.batchId, 'batch-nightly', 'the custom id gains the discovery prefix');
    assert.ok(fs.existsSync(queue.manifestFilePath(config, 'batch-nightly')), 'the manifest uses the prefixed file name');

    assert.equal(queue.loadManifest(config).batchId, 'batch-nightly', 'resume without an id discovers the custom batch');
    assert.equal(queue.loadManifest(config, 'nightly').batchId, 'batch-nightly', 'resume with the raw id still finds it');
    assert.equal(
      queue.createManifest({ specs, options: { batchId: 'batch-manual' }, config }).batchId,
      'batch-manual',
      'an already-prefixed id is left untouched'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review: a failed spec index sync warns the operator instead of failing silently', () => {
  const { root } = setup();
  const specSync = require('../skills/sdw-spec/scripts/spec_sync.cjs');
  const originalSyncIndex = specSync.syncIndex;
  const originalWarn = console.warn;
  const warnings = [];
  try {
    const config = queue.loadConfig(root);
    specSync.syncIndex = () => { throw new Error('index unavailable'); };
    console.warn = (...args) => warnings.push(args.join(' '));
    assert.equal(queue.triggerSpecSync(config), false, 'the sync stays non-fatal for the queue');
    assert.equal(warnings.length, 1, 'exactly one warning reaches the operator');
    assert.match(warnings[0], /spec index sync failed: index unavailable/);
  } finally {
    specSync.syncIndex = originalSyncIndex;
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review: resuming a completed_with_errors batch reports the failure instead of success', () => {
  const { root, specs } = setup();
  try {
    const code = queue.runBatch(specs, {
      root,
      noSync: true,
      continueOnError: true,
      _invoke: ({ runId, specPath }) => {
        if (specPath.includes('alpha')) { writeState(root, runId, 'failed'); return 1; }
        writeState(root, runId, 'completed', { deliveryCommit: 'beta-done' });
        return 0;
      }
    });
    assert.equal(code, 1, 'the run finishes with errors');

    const config = queue.loadConfig(root);
    const manifest = queue.loadManifest(config);
    assert.equal(manifest.status, 'completed_with_errors');

    const { result: resumed } = captureLogs(() => queue.resumeBatch(manifest.batchId, {
      root,
      noSync: true,
      _invoke: () => { throw new Error('a finished batch must not delegate'); }
    }));
    assert.equal(resumed, 1, 'resuming a finished-with-errors batch stays a failure');

    const after = queue.loadManifest(config, manifest.batchId);
    assert.equal(after.status, 'completed_with_errors', 'the failure is never relabeled as completed');
    assert.equal(after.queue[0].status, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review: an existing batch id is rejected instead of overwriting the queue', () => {
  const { root, specs } = setup();
  try {
    const config = queue.loadConfig(root);
    const first = queue.createManifest({ specs: [specs[0]], options: { batchId: 'nightly' }, config });

    assert.throws(
      () => queue.createManifest({ specs, options: { batchId: 'nightly' }, config }),
      /already exists/,
      'a colliding batch id is refused'
    );

    const reloaded = queue.loadManifest(config, 'nightly');
    assert.equal(reloaded.total, 1, 'the original queue is untouched');
    assert.equal(reloaded.createdAt, first.createdAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review: a delegated exit code 3 is a failure, not a pause', () => {
  const { root, specs } = setup();
  try {
    const { result } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => { writeState(root, runId, 'paused'); return 3; }
    }));

    assert.equal(result, 1, 'the batch reports a plain failure');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'halted');
    assert.equal(manifest.queue[0].status, 'failed', 'exit 3 never maps to awaiting_grilling');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review: --json emits one manifest document on stdout and progress on stderr', () => {
  const { root, specs } = setup();
  const stdoutChunks = [];
  const progress = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const originalError = console.error;
  let code;
  try {
    process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
    console.log = (...args) => { throw new Error(`unexpected stdout log: ${args.join(' ')}`); };
    console.error = (...args) => { progress.push(args.join(' ')); };
    code = queue.runBatch(specs, {
      root,
      noSync: true,
      json: true,
      _invoke: ({ runId }) => { writeState(root, runId, 'completed', { deliveryCommit: 'ok' }); return 0; }
    });
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(code, 0);
  const manifest = JSON.parse(stdoutChunks.join(''));
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.total, 2);
  assert.ok(progress.some(line => line.includes('Delegating')), 'progress lines move to stderr');
});

test('review: a malformed .sdw/config.json exits 1 with a clear error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-config-'));
  try {
    fs.mkdirSync(path.join(root, '.sdw'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sdw', 'config.json'), '{"specsDir": ', 'utf8');
    const result = spawnSync(process.execPath, [CLI, 'status', '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid \.sdw\/config\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skip: an implemented specification is never delegated again', () => {
  const { root, specs } = setup();
  try {
    writeRegistry(root, [
      { prefix: '00001', slug: '00001-alpha', status: 'completed' },
      { prefix: '00002', slug: '00002-beta', status: 'pending' }
    ]);
    const calls = [];
    const { result } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        calls.push(specPath);
        writeState(root, runId, 'completed', { deliveryCommit: 'beta-done' });
        return 0;
      }
    }));

    assert.equal(result, 0);
    assert.equal(calls.length, 1, 'only the pending specification is delegated');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.deepEqual(manifest.queue.map(item => item.status), ['already_implemented', 'completed']);
    assert.match(manifest.queue[0].skipReason, /already implemented/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skip: a fully implemented queue completes with zero delegations', () => {
  const { root, specs } = setup();
  try {
    writeRegistry(root, [
      { prefix: '00001', slug: '00001-alpha', status: 'completed' },
      { prefix: '00002', slug: '00002-beta', status: 'archived' }
    ]);
    const { result } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: () => { throw new Error('a skipped specification must not delegate'); }
    }));

    assert.equal(result, 0, 'an all-skipped batch is a success');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.deepEqual(manifest.queue.map(item => item.status), ['already_implemented', 'already_implemented']);
    assert.equal(manifest.status, 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skip: the registry wins over stale spec frontmatter', () => {
  const { root, specs } = setup();
  try {
    fs.writeFileSync(
      specs[0],
      '---\nslug: 00001-alpha\nstatus: completed\n---\n# 00001-alpha\n\n## Acceptance Criteria\n\n- AC1: The system shall exist.\n',
      'utf8'
    );
    writeRegistry(root, [
      { prefix: '00001', slug: '00001-alpha', status: 'pending' },
      { prefix: '00002', slug: '00002-beta', status: 'pending' }
    ]);
    const calls = [];
    const { result } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        calls.push(specPath);
        writeState(root, runId, 'completed', { deliveryCommit: 'done' });
        return 0;
      }
    }));

    assert.equal(result, 0);
    assert.equal(calls.length, 2, 'frontmatter status does not skip a registry-pending spec');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skip: resume re-checks the registry before delegating a pending item', () => {
  const { root, specs } = setup();
  try {
    const { result: paused } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => { writeState(root, runId, 'paused'); return 4; }
    }));
    assert.equal(paused, 4);

    writeRegistry(root, [
      { prefix: '00001', slug: '00001-alpha', status: 'completed' },
      { prefix: '00002', slug: '00002-beta', status: 'pending' }
    ]);
    const calls = [];
    const { result: resumed } = captureLogs(() => queue.resumeBatch(undefined, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        calls.push(specPath);
        writeState(root, runId, 'completed', { deliveryCommit: 'beta-done' });
        return 0;
      }
    }));

    assert.equal(resumed, 0);
    assert.equal(calls.length, 1, 'the item implemented during the pause is skipped');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.queue[0].status, 'already_implemented');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cli: run parses a specification list and batch options', () => {
  const options = cli.parseArgs(['run', 'a.md', 'b.md', '--continue-on-error', '--no-sync', '--batch-id', 'batch-x']);
  assert.deepEqual(options.specPaths, ['a.md', 'b.md']);
  assert.equal(options.continueOnError, true);
  assert.equal(options.noSync, true);
  assert.equal(options.batchId, 'batch-x');
  assert.equal(cli.parseArgs(['resume', 'batch-x']).batchId, 'batch-x');
  // Spec 00058 AC13: run and resume accept the same passthrough flag.
  assert.equal(cli.parseArgs(['run', 'a.md', '--new-run']).newRun, true);
  assert.equal(cli.parseArgs(['resume', 'batch-x', '--new-run']).newRun, true);
  assert.equal(cli.parseArgs(['resume', 'batch-x']).newRun, false);
});

test('00058 AC13: the delegated invocation forwards --new-run to the orchestrator', () => {
  const config = { root: process.cwd() };
  const withFlag = queue.orchestratorArgs({
    config,
    runId: 'run-1',
    specPath: '.sdw/specs/00001-alpha.md',
    resume: false,
    newRun: true
  });
  const withoutFlag = queue.orchestratorArgs({
    config,
    runId: 'run-2',
    specPath: '.sdw/specs/00001-alpha.md',
    resume: false,
    newRun: false
  });
  assert.ok(withFlag.includes('--new-run'), 'a fresh delegated run carries --new-run');
  assert.ok(!withoutFlag.includes('--new-run'), 'the flag is absent when it was not requested');
  assert.equal(withFlag[1], 'run');
  assert.ok(withFlag.includes('--run-id') && withFlag.includes('run-1'));
});

// Spec 00053 AC1-AC7: the queue merges each delivered pull request before it
// advances, records the outcome per item, and never re-merges on resume.

test('AC1: batch.autoMerge resolves to true when absent and honours an explicit false', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-merge-config-'));
  try {
    assert.equal(queue.loadConfig(root).autoMerge, true, 'an absent batch.autoMerge resolves to true');
    writeConfig(root, { batch: { autoMerge: false } });
    assert.equal(queue.loadConfig(root).autoMerge, false, 'the configured false is preserved');
    writeConfig(root, { batch: { autoMerge: true } });
    assert.equal(queue.loadConfig(root).autoMerge, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2 & AC5: a delivered pull request is merged before the next item is delegated and recorded on the manifest', () => {
  const { root, specs } = setup();
  try {
    writeConfig(root, { scmProvider: 'github', batch: { autoMerge: true } });
    const events = [];
    const { result } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        const name = path.basename(specPath);
        events.push(`delegate:${name}`);
        writeDeliveredState(root, runId, name.includes('alpha') ? '11' : '12');
        return 0;
      },
      _mergePr: ({ prNumber, command, provider }) => {
        events.push(`merge:${prNumber}`);
        assert.equal(provider, 'github', 'the configured SCM provider is used');
        assert.match(command, /^gh pr merge \d+ --merge$/, 'the ship-pr merge command is reused');
        return { merged: true };
      }
    }));

    assert.equal(result, 0);
    assert.deepEqual(events, [
      'delegate:00001-alpha.md',
      'merge:11',
      'delegate:00002-beta.md',
      'merge:12'
    ], 'each delivered pull request is merged before the queue advances');

    const manifest = queue.loadManifest(queue.loadConfig(root));
    for (const item of manifest.queue) {
      assert.ok(item.merge, 'every completed item records its merge outcome');
      for (const field of ['requested', 'attempted', 'ok', 'status', 'prNumber', 'at']) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(item.merge, field),
          `the merge record carries ${field}`
        );
      }
      assert.equal(item.merge.requested, true);
      assert.equal(item.merge.attempted, true);
      assert.equal(item.merge.ok, true);
      assert.equal(item.merge.status, 'merged');
      assert.equal(typeof item.merge.at, 'string');
    }
    assert.equal(manifest.queue[0].merge.prNumber, '11');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: autoMerge false and --no-merge skip the merge with the policy reason', () => {
  const policyOff = setup();
  try {
    writeConfig(policyOff.root, { scmProvider: 'github', batch: { autoMerge: false } });
    let calls = 0;
    const { result } = captureLogs(() => queue.runBatch(policyOff.specs, {
      root: policyOff.root,
      noSync: true,
      _invoke: ({ runId }) => { writeDeliveredState(policyOff.root, runId, '7'); return 0; },
      _mergePr: () => { calls += 1; }
    }));

    assert.equal(result, 0);
    assert.equal(calls, 0, 'a false policy never calls the provider');
    const manifest = queue.loadManifest(queue.loadConfig(policyOff.root));
    for (const item of manifest.queue) {
      assert.equal(item.merge.status, 'skipped');
      assert.equal(item.merge.requested, false);
      assert.equal(item.merge.attempted, false);
      assert.equal(item.merge.ok, null);
      assert.match(item.merge.reason, /batch\.autoMerge is false/);
    }
  } finally {
    fs.rmSync(policyOff.root, { recursive: true, force: true });
  }

  const flagOff = setup();
  try {
    writeConfig(flagOff.root, { scmProvider: 'github', batch: { autoMerge: true } });
    let calls = 0;
    const { result } = captureLogs(() => queue.runBatch(flagOff.specs, {
      root: flagOff.root,
      noSync: true,
      noMerge: true,
      _invoke: ({ runId }) => { writeDeliveredState(flagOff.root, runId, '8'); return 0; },
      _mergePr: () => { calls += 1; }
    }));

    assert.equal(result, 0);
    assert.equal(calls, 0, '--no-merge overrides a true policy');
    const manifest = queue.loadManifest(queue.loadConfig(flagOff.root));
    assert.equal(manifest.queue[0].merge.status, 'skipped');
    assert.match(manifest.queue[0].merge.reason, /--no-merge/);
  } finally {
    fs.rmSync(flagOff.root, { recursive: true, force: true });
  }
});

test('AC4: a failed merge is recorded and the queue advances with the item still completed', () => {
  const { root, specs } = setup();
  try {
    writeConfig(root, { scmProvider: 'github', batch: { autoMerge: true } });
    const attempts = [];
    const { result, logs } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        writeDeliveredState(root, runId, path.basename(specPath).includes('alpha') ? '21' : '22');
        return 0;
      },
      _mergePr: ({ prNumber }) => {
        attempts.push(prNumber);
        throw new Error('branch protection blocks the merge');
      }
    }));

    assert.equal(result, 0, 'the batch exit code reflects the delegated runs, never the merge');
    assert.deepEqual(attempts, ['21', '22'], 'a failed merge never stops the next item');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.deepEqual(manifest.queue.map(item => item.status), ['completed', 'completed']);
    assert.equal(manifest.status, 'completed');

    const first = manifest.queue[0].merge;
    assert.equal(first.status, 'failed');
    assert.equal(first.ok, false);
    assert.equal(first.attempted, true);
    assert.match(first.reason, /branch protection/);
    assert.ok(logs.join('\n').includes('Merge failed'), 'the operator sees the merge failure');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC6: resume never merges an item whose manifest already records an attempted merge', () => {
  const { root, specs } = setup();
  try {
    writeConfig(root, { scmProvider: 'github', batch: { autoMerge: true } });
    let mergeCalls = 0;

    const { result: paused } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        if (path.basename(specPath).includes('alpha')) {
          writeDeliveredState(root, runId, '31');
          return 0;
        }
        writeState(root, runId, 'paused');
        return 4;
      },
      _mergePr: () => { mergeCalls += 1; return { merged: true }; }
    }));

    assert.equal(paused, 4);
    assert.equal(mergeCalls, 1);
    let manifest = queue.loadManifest(queue.loadConfig(root));
    const firstMergeAt = manifest.queue[0].merge.at;
    assert.equal(manifest.queue[0].merge.status, 'merged');

    const { result: resumed } = captureLogs(() => queue.resumeBatch(manifest.batchId, {
      root,
      noSync: true,
      _invoke: ({ runId }) => { writeDeliveredState(root, runId, '32'); return 0; },
      _mergePr: () => { mergeCalls += 1; return { merged: true }; }
    }));

    assert.equal(resumed, 0);
    assert.equal(mergeCalls, 2, 'only the item that had not merged yet is merged');

    manifest = queue.loadManifest(queue.loadConfig(root), manifest.batchId);
    assert.equal(manifest.queue[0].merge.at, firstMergeAt, 'the recorded merge is never reissued');

    // Even a reconciled item that re-enters the completed branch keeps its
    // recorded attempt: the guard is on the attempt, not on the item status.
    manifest.queue[0].status = 'awaiting_implementation';
    manifest.status = 'in_progress';
    manifest.currentIndex = 0;
    queue.saveManifest(queue.loadConfig(root), manifest);

    const { result: reconciled } = captureLogs(() => queue.resumeBatch(manifest.batchId, {
      root,
      noSync: true,
      _invoke: () => { throw new Error('a completed run must not be delegated'); },
      _mergePr: () => { mergeCalls += 1; return { merged: true }; }
    }));

    assert.equal(reconciled, 0);
    assert.equal(mergeCalls, 2, 'an attempted merge recorded on the manifest is never reissued');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC7: the summary prints each item merge outcome', () => {
  const { root, specs } = setup();
  try {
    writeConfig(root, { scmProvider: 'github', batch: { autoMerge: true } });
    const { result, logs } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        if (path.basename(specPath).includes('alpha')) {
          writeDeliveredState(root, runId, '41');
        } else {
          writeState(root, runId, 'completed', { deliveryCommit: 'no-pr' });
        }
        return 0;
      },
      _mergePr: () => ({ merged: true })
    }));

    assert.equal(result, 0);
    const output = logs.join('\n');
    assert.ok(output.includes('| Merge'), 'the summary carries a merge column');
    assert.match(output, /00001-alpha.*merged #41/);
    assert.match(output, /00002-beta.*skipped: no-pr/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00053 AC8: `--no-merge` is accepted by both `run` and `resume`.

test('AC8: --no-merge parses on run and resume and the CLI accepts the flag', () => {
  const run = cli.parseArgs(['run', 'a.md', 'b.md', '--no-merge']);
  assert.equal(run.noMerge, true, 'run accepts --no-merge');
  assert.deepEqual(run.specPaths, ['a.md', 'b.md'], 'the flag never consumes a specification path');
  const resume = cli.parseArgs(['resume', 'batch-x', '--no-merge']);
  assert.equal(resume.noMerge, true, 'resume accepts --no-merge');
  assert.equal(resume.batchId, 'batch-x');
  assert.equal(cli.parseArgs(['run', 'a.md']).noMerge, false, 'the default is a configured merge');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-no-merge-'));
  try {
    const spec = writeSpec(root, '00001-alpha.md', '00001-alpha');
    const runResult = spawnSync(process.execPath, [CLI, 'run', spec, '--dry-run', '--no-merge', '--root', root], { encoding: 'utf8' });
    assert.equal(runResult.status, 0, `run --no-merge is accepted: ${runResult.stderr}`);
    assert.match(runResult.stdout, /Dry-run plan/);

    const resumeResult = spawnSync(process.execPath, [CLI, 'resume', '--no-merge', '--root', root], { encoding: 'utf8' });
    assert.doesNotMatch(resumeResult.stderr, /unknown option/, 'resume never rejects --no-merge');
    assert.match(resumeResult.stderr, /No batch manifest found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00053 AC11-AC13: the pre-flight refreshes the base lane, proves earlier
// deliveries are reachable from it, and reacts to a stale base.

test('AC11: the pre-flight refreshes the base from origin and records the resolved base commit per item', () => {
  const { root, specs } = setup();
  let remote = null;
  try {
    const config = {
      scmProvider: 'github',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    };
    writeConfig(root, config);
    remote = initRepoWithRemote(root);
    const initial = git(root, ['rev-parse', 'refs/remotes/origin/develop']);
    let advanced = null;
    let delegations = 0;
    const { result } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        delegations += 1;
        const alpha = path.basename(specPath).includes('alpha');
        writeDeliveredCommit(root, runId, initial, alpha ? '51' : '52');
        if (alpha) {
          // Advance the remote base while the first item runs, so the second
          // pre-flight proves it refreshed rather than reading a cached ref.
          git(root, ['commit', '-q', '--allow-empty', '-m', 'advance origin']);
          advanced = git(root, ['rev-parse', 'HEAD']);
          git(root, ['push', '-q', 'origin', 'develop']);
          git(root, ['reset', '-q', '--hard', 'HEAD~1']);
        }
        return 0;
      },
      _mergePr: () => ({ merged: true })
    }));

    assert.equal(result, 0);
    assert.equal(delegations, 2);
    const manifest = queue.loadManifest(queue.loadConfig(root));
    for (const item of manifest.queue) {
      assert.equal(item.preflight.status, 'refreshed');
      assert.equal(item.preflight.remote, 'origin');
      assert.equal(item.preflight.baseBranch, 'develop');
      assert.match(item.preflight.baseCommit, /^[0-9a-f]{40}$/);
      assert.equal(typeof item.preflight.at, 'string');
    }
    assert.equal(manifest.queue[0].preflight.baseCommit, initial);
    assert.equal(manifest.queue[1].preflight.baseCommit, advanced, 'the second pre-flight reads the advanced remote base');
    assert.notEqual(manifest.queue[0].preflight.baseCommit, manifest.queue[1].preflight.baseCommit);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('AC12: the pre-flight merges an earlier open pull request when auto-merge is enabled, then delegates', () => {
  const { root, specs } = setup();
  let remote = null;
  try {
    writeConfig(root, {
      scmProvider: 'github',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    remote = initRepoWithRemote(root);
    // The first delivery stays on a feature branch: the base cannot contain it
    // until the pull request is merged.
    git(root, ['switch', '-q', '-c', 'feature/00001-alpha']);
    fs.writeFileSync(path.join(root, 'delivery.txt'), 'alpha delivery\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'alpha delivery']);
    const delivery = git(root, ['rev-parse', 'HEAD']);
    git(root, ['switch', '-q', 'develop']);

    const mergeCalls = [];
    let delegations = 0;
    const { result } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        delegations += 1;
        const alpha = path.basename(specPath).includes('alpha');
        writeDeliveredCommit(root, runId, delivery, alpha ? '71' : '72');
        return 0;
      },
      _mergePr: ({ prNumber }) => {
        mergeCalls.push(prNumber);
        if (mergeCalls.length === 1) throw new Error('branch protection blocks the merge');
        if (mergeCalls.length === 2) {
          // The first attempt threw before the provider merged anything, so the
          // recorded attempt is a failure and this retry is the first effective
          // merge of the pull request (AC12), never a re-issue of a merge that
          // already happened (AC6).
          const attempt = queue.loadManifest(queue.loadConfig(root));
          assert.equal(attempt.queue[0].merge.attempted, true);
          assert.equal(attempt.queue[0].merge.status, 'failed', 'the first attempt merged nothing');
          // The provider merge lands the delivery on the remote base.
          git(root, ['push', '-q', '--force', 'origin', 'refs/heads/feature/00001-alpha:refs/heads/develop']);
        }
        return { merged: true };
      }
    }));

    assert.equal(result, 0, 'the queue continues after the pre-flight merge');
    assert.equal(delegations, 2);
    assert.deepEqual(mergeCalls, ['71', '71', '72'], 'the failed attempt is retried once by the pre-flight, then the second item merges its own pull request');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.queue[1].status, 'completed');
    assert.equal(manifest.queue[0].merge.status, 'merged', 'the pre-flight merge is recorded on the earlier item');
    assert.equal(manifest.queue[0].merge.ok, true);
    assert.equal(manifest.queue[0].merge.prNumber, '71');
    assert.equal(manifest.queue[1].preflight.status, 'refreshed');
    assert.equal(manifest.queue[1].preflight.baseCommit, delivery, 'the base is refreshed again after the merge');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('AC6 & AC12: the pre-flight never re-merges a pull request whose manifest records a merged attempt', () => {
  const { root, specs } = setup();
  let remote = null;
  try {
    writeConfig(root, {
      scmProvider: 'github',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    remote = initRepoWithRemote(root);
    git(root, ['switch', '-q', '-c', 'feature/00001-alpha']);
    fs.writeFileSync(path.join(root, 'delivery.txt'), 'alpha delivery\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'alpha delivery']);
    const delivery = git(root, ['rev-parse', 'HEAD']);
    git(root, ['switch', '-q', 'develop']);

    const mergeCalls = [];
    let delegations = 0;
    const { result, errors } = captureAll(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        delegations += 1;
        const alpha = path.basename(specPath).includes('alpha');
        writeDeliveredCommit(root, runId, delivery, alpha ? '91' : '92');
        return 0;
      },
      // The merge is recorded but never reaches the remote base, so the
      // pre-flight finds the delivery missing while the record says merged.
      _mergePr: ({ prNumber }) => { mergeCalls.push(prNumber); return { merged: true }; }
    }));

    assert.equal(result, 1, 'a recorded merge whose delivery is missing halts instead of re-merging');
    assert.equal(delegations, 1, 'the second specification is never delegated');
    assert.deepEqual(mergeCalls, ['91'], 'the pre-flight never re-issues a recorded merge');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'halted');
    assert.equal(manifest.queue[0].merge.status, 'merged');
    const preflight = manifest.queue[1].preflight;
    assert.equal(preflight.status, 'halted');
    assert.match(preflight.reason, /#91/);
    assert.match(preflight.reason, /records merged pull request/);
    assert.ok(preflight.reason.includes(delivery), 'the halt names the missing delivery commit');
    assert.match(errors.join('\n'), /Pre-flight halted the queue/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('AC12: a still-open earlier pull request halts the queue when auto-merge is disabled', () => {
  const { root, specs } = setup();
  let remote = null;
  try {
    writeConfig(root, {
      scmProvider: 'github',
      batch: { autoMerge: false },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    remote = initRepoWithRemote(root);
    git(root, ['switch', '-q', '-c', 'feature/00001-alpha']);
    fs.writeFileSync(path.join(root, 'delivery.txt'), 'alpha delivery\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'alpha delivery']);
    const delivery = git(root, ['rev-parse', 'HEAD']);
    git(root, ['switch', '-q', 'develop']);

    let delegations = 0;
    let mergeCalls = 0;
    const { result, errors } = captureAll(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => {
        delegations += 1;
        writeDeliveredCommit(root, runId, delivery, '81');
        return 0;
      },
      _mergePr: () => { mergeCalls += 1; return { merged: true }; }
    }));

    assert.equal(result, 1, 'a disabled auto-merge halts instead of delegating on a stale base');
    assert.equal(delegations, 1, 'the second specification is never delegated');
    assert.equal(mergeCalls, 0, 'auto-merge stays disabled for the pre-flight too');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'halted');
    assert.deepEqual(manifest.queue.map(item => item.status), ['completed', 'pending']);
    const preflight = manifest.queue[1].preflight;
    assert.equal(preflight.status, 'halted');
    assert.match(preflight.reason, /#81/);
    assert.match(preflight.reason, /auto-merge is disabled/);
    assert.ok(preflight.reason.includes(delivery), 'the halt names the missing delivery commit');
    assert.match(preflight.reason, /develop/, 'the halt names the branch');
    const output = errors.join('\n');
    assert.match(output, /Pre-flight halted the queue/);
    assert.match(output, /00002-beta/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('AC13: a refreshed base missing the previous delivery commit halts and names the commit and the branch', () => {
  const { root, specs } = setup();
  let remote = null;
  try {
    writeConfig(root, {
      scmProvider: 'github',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    remote = initRepoWithRemote(root);
    git(root, ['switch', '-q', '-c', 'feature/00001-alpha']);
    fs.writeFileSync(path.join(root, 'delivery.txt'), 'alpha delivery\n', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'alpha delivery']);
    const delivery = git(root, ['rev-parse', 'HEAD']);
    git(root, ['switch', '-q', 'develop']);

    let delegations = 0;
    const { result, errors } = captureAll(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => {
        delegations += 1;
        writeDeliveredCommit(root, runId, delivery, '91');
        return 0;
      },
      // The completion merge is accepted, but the base never receives it.
      _mergePr: () => ({ merged: true })
    }));

    assert.equal(result, 1);
    assert.equal(delegations, 1, 'the queue halts before delegating the next item');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'halted');
    assert.deepEqual(manifest.queue.map(item => item.status), ['completed', 'pending']);
    const preflight = manifest.queue[1].preflight;
    assert.equal(preflight.status, 'halted');
    assert.ok(preflight.reason.includes(delivery), 'the halt names the missing delivery commit');
    assert.match(preflight.reason, /base branch "develop"/);
    assert.equal(preflight.baseBranch, 'develop');
    assert.equal(typeof preflight.baseCommit, 'string');
    assert.match(errors.join('\n'), /Pre-flight halted the queue before delegating "00002-beta"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});


// Spec 00058 AC1-AC4: the skip path skips the implementation only. The merge
// stage still runs on adopted delivery evidence, and an item without any
// evidence is recorded `no-delivery-evidence` and named in the summary.
test('00058 AC1 & AC3 & AC4: the skip path merges adopted evidence and names the item without any', () => {
  const { root, specs } = setup();
  let remote = null;
  try {
    writeConfig(root, {
      scmProvider: 'github',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    remote = initRepoWithRemote(root);
    const initial = git(root, ['rev-parse', 'refs/remotes/origin/develop']);
    writeRegistry(root, [
      { prefix: '00001', slug: '00001-alpha', status: 'completed' },
      { prefix: '00002', slug: '00002-beta', status: 'completed' }
    ]);
    // Recorded evidence for alpha only: a completed run with a delivery commit
    // already reachable from the base and a delivered pull request.
    writeState(root, 'run-alpha-delivered', 'completed', {
      specSlug: '00001-alpha',
      deliveryCommit: initial,
      pullRequest: { number: 61, url: 'https://example.test/pull/61' },
      shipStatus: 'delivered'
    });

    let delegations = 0;
    const mergeCalls = [];
    const { result, logs } = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: () => { delegations += 1; return 0; },
      _mergePr: ({ prNumber }) => { mergeCalls.push(prNumber); return { merged: true }; }
    }));

    assert.equal(result, 0, 'a fully skipped queue completes');
    assert.equal(delegations, 0, 'neither specification is delegated');
    assert.deepEqual(mergeCalls, [61], 'the skipped item with evidence still merges its pull request');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.deepEqual(manifest.queue.map(item => item.status), ['already_implemented', 'already_implemented']);
    assert.equal(manifest.queue[0].runId, 'run-alpha-delivered', 'the completed run is adopted onto the item');
    assert.equal(manifest.queue[0].deliveryCommit, initial, 'the recorded delivery commit is adopted');
    assert.equal(manifest.queue[0].merge.status, 'merged');
    assert.equal(manifest.queue[0].merge.prNumber, 61);
    assert.equal(manifest.queue[1].merge.status, 'skipped');
    assert.equal(manifest.queue[1].merge.reason, 'no-delivery-evidence');
    assert.equal(manifest.queue[1].deliveryCommit, null);
    const output = logs.join('\n');
    assert.match(output, /Merge skipped \(no delivery evidence\): 00002-beta/, 'the summary names the unproven item');
    assert.doesNotMatch(output, /Merge skipped \(no delivery evidence\): 00001-alpha/, 'the proven item is never named');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});

// Spec 00058 AC7: a local work lane behind the refreshed remote lane is
// fast-forwarded, and the commit it reached is the recorded start point.
test('00058 AC7: the pre-flight fast-forwards the local work lane and records the start point', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-lane-'));
  const alpha = writeSpec(root, '00001-alpha.md', '00001-alpha');
  let remote = null;
  try {
    writeConfig(root, {
      scmProvider: 'none',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    remote = initRepoWithRemote(root);
    const behind = git(root, ['rev-parse', 'refs/heads/develop']);
    git(root, ['commit', '-q', '--allow-empty', '-m', 'advance the remote lane']);
    const advanced = git(root, ['rev-parse', 'HEAD']);
    git(root, ['push', '-q', 'origin', 'develop']);
    git(root, ['reset', '-q', '--hard', behind]);
    assert.equal(git(root, ['rev-parse', 'refs/heads/develop']), behind, 'the local lane starts behind the remote');

    const { result } = captureLogs(() => queue.runBatch([alpha], {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        writeState(root, runId, 'completed', {
          specSlug: '00001-alpha',
          deliveryCommit: advanced,
          branch: path.basename(specPath, '.md')
        });
        return 0;
      }
    }));

    assert.equal(result, 0);
    const manifest = queue.loadManifest(queue.loadConfig(root));
    const preflight = manifest.queue[0].preflight;
    assert.equal(preflight.status, 'refreshed');
    assert.equal(preflight.baseCommit, advanced, 'the refreshed base is the advanced remote commit');
    assert.equal(preflight.startPoint, advanced, 'the start point is the fast-forwarded commit');
    assert.equal(preflight.startPointSource, 'fast-forwarded');
    assert.equal(git(root, ['rev-parse', 'refs/heads/develop']), advanced, 'the local work lane moved onto the refreshed commit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});

// Spec 00058 AC8: a dirty tree is never a halt. The branch start point falls back
// to the refreshed remote lane commit, and the recorded source says why.
test('00058 AC8: a dirty tree defers the lane update and records the remote ref as the start point', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-dirty-'));
  const alpha = writeSpec(root, '00001-alpha.md', '00001-alpha');
  let remote = null;
  try {
    writeConfig(root, {
      scmProvider: 'none',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    remote = initRepoWithRemote(root);
    const behind = git(root, ['rev-parse', 'refs/heads/develop']);
    fs.writeFileSync(path.join(root, 'README.md'), '# batch fixture\n\nremote advance\n', 'utf8');
    git(root, ['commit', '-q', '-am', 'advance the remote lane']);
    const advanced = git(root, ['rev-parse', 'HEAD']);
    git(root, ['push', '-q', 'origin', 'develop']);
    git(root, ['reset', '-q', '--hard', behind]);
    // Dirt over the same file the fast-forward must rewrite.
    fs.writeFileSync(path.join(root, 'README.md'), '# batch fixture\n\nlocal uncommitted edit\n', 'utf8');

    const { result, logs } = captureLogs(() => queue.runBatch([alpha], {
      root,
      noSync: true,
      _invoke: ({ runId }) => {
        writeState(root, runId, 'completed', { specSlug: '00001-alpha', deliveryCommit: behind, branch: 'feature/00001-alpha' });
        return 0;
      }
    }));

    assert.equal(result, 0, 'a dirty tree never halts the queue');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    const preflight = manifest.queue[0].preflight;
    assert.equal(preflight.status, 'refreshed');
    assert.equal(preflight.baseCommit, advanced);
    assert.equal(preflight.startPointSource, 'deferred');
    assert.equal(preflight.startPoint, 'origin/develop', 'the refreshed remote ref is the start point');
    assert.equal(preflight.laneCommit, behind, 'the stale local lane commit is recorded');
    assert.equal(git(root, ['rev-parse', 'refs/heads/develop']), behind, 'the blocked lane stays where it was');
    assert.match(logs.join('\n'), /start origin\/develop/, 'the summary prints the start point used');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});

// Spec 00058 AC9 & AC10: the provider is the last resolution source, and its
// merged state proves a delivery even when the run stopped at review_pending.
test('00058 AC9 & AC10: the provider resolves the pull request and proves a review_pending delivery merged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-provider-'));
  const alpha = writeSpec(root, '00001-alpha.md', '00001-alpha');
  try {
    writeConfig(root, {
      scmProvider: 'github',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    const findCalls = [];
    const mergeCalls = [];
    const { result } = captureLogs(() => queue.runBatch([alpha], {
      root,
      noSync: true,
      _invoke: ({ runId }) => {
        writeState(root, runId, 'completed', {
          specSlug: '00001-alpha',
          deliveryCommit: 'delivery-abc',
          branch: 'feature/00001-alpha',
          shipStatus: 'review_pending'
        });
        return 0;
      },
      _findPr: ({ head }) => { findCalls.push(head); return { number: 77, url: 'https://example.test/pull/77' }; },
      _isPrMerged: ({ prNumber }) => prNumber === 77,
      _mergePr: (args) => { mergeCalls.push(args); return { merged: true }; }
    }));

    assert.equal(result, 0);
    assert.deepEqual(findCalls, ['feature/00001-alpha'], 'the provider is queried by the recorded head branch');
    assert.equal(mergeCalls.length, 0, 'no merge is issued for a pull request the provider reports merged');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.queue[0].merge.status, 'merged');
    assert.equal(manifest.queue[0].merge.prNumber, 77);
    assert.equal(manifest.queue[0].merge.source, 'provider');
    assert.equal(manifest.queue[0].merge.observed, 'merged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00058 AC11 & AC12: exit 6 is a pause. The item awaits convergence, and
// resume continues that exact run at the delivery stage.
test('00058 AC11 & AC12: a delivery convergence pause records awaiting_convergence and resume continues the same run', () => {
  const { root, specs } = setup();
  try {
    let firstRunId = null;
    const code = captureLogs(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId }) => {
        firstRunId = runId;
        writeState(root, runId, 'paused', {
          specSlug: '00001-alpha',
          pullRequest: { number: 88, url: 'https://example.test/pull/88' },
          shipStatus: 'review_pending',
          step8Status: 'blocked_convergence'
        });
        return 6;
      }
    })).result;

    assert.equal(code, 6, 'the convergence pause is propagated as exit code 6');
    let manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'paused');
    assert.equal(manifest.queue[0].status, 'awaiting_convergence');
    assert.equal(manifest.queue[0].runId, firstRunId);
    assert.equal(manifest.queue[1].status, 'pending');

    const observed = [];
    const resumeCode = captureLogs(() => queue.resumeBatch(manifest.batchId, {
      root,
      noSync: true,
      _invoke: ({ runId, resume }) => {
        observed.push({ runId, resume });
        if (runId === firstRunId) {
          writeState(root, runId, 'completed', { specSlug: '00001-alpha', deliveryCommit: 'delivered-88' });
          return 0;
        }
        writeState(root, runId, 'paused');
        return 4;
      }
    })).result;

    assert.equal(resumeCode, 4, 'the queue advances to the next item and pauses there');
    assert.deepEqual(observed[0], { runId: firstRunId, resume: true }, 'resume continues the paused run from the delivery stage');
    manifest = queue.loadManifest(queue.loadConfig(root), manifest.batchId);
    assert.equal(manifest.queue[0].status, 'completed');
    assert.equal(manifest.queue[0].runId, firstRunId, 'no new run is started for the converged delivery');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Spec 00058 AC13-AC16: a stale open run is named, halts without failing the
// item, and is superseded by --new-run instead of resumed.
function staleRunFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-stale-'));
  const alpha = writeSpec(root, '00001-alpha.md', '00001-alpha');
  writeConfig(root, {
    scmProvider: 'none',
    batch: { autoMerge: true },
    branching: { workBranch: 'develop', integrationBranch: 'develop' }
  });
  const remote = initRepoWithRemote(root);
  // A commit that never reached the work lane: exactly the paused run left from
  // a previous day, whose base predates every delivery merged since.
  git(root, ['commit', '-q', '--allow-empty', '-m', 'stale base']);
  const staleBase = git(root, ['rev-parse', 'HEAD']);
  git(root, ['reset', '-q', '--hard', 'HEAD~1']);
  writeState(root, 'run-stale-alpha', 'paused', { specSlug: '00001-alpha', baseCommit: staleBase });
  return { root, alpha, remote, staleBase, laneCommit: git(root, ['rev-parse', 'refs/heads/develop']) };
}

test('00058 AC14 & AC15: a stale open run halts naming the run, its base commit, and the --new-run remedy', () => {
  const fixture = staleRunFixture();
  try {
    let delegations = 0;
    const { result, logs, errors } = captureAll(() => queue.runBatch([fixture.alpha], {
      root: fixture.root,
      noSync: true,
      _invoke: () => { delegations += 1; return 0; }
    }));

    assert.equal(result, 1, 'a stale open run halts the queue');
    assert.equal(delegations, 0, 'nothing is delegated onto an unproven base');
    const manifest = queue.loadManifest(queue.loadConfig(fixture.root));
    assert.equal(manifest.status, 'halted');
    assert.equal(manifest.queue[0].status, 'pending', 'the item is never marked failed');
    assert.equal(manifest.queue[0].staleRun.classification, 'stale');
    assert.equal(manifest.queue[0].staleRun.runId, 'run-stale-alpha');
    assert.equal(manifest.queue[0].staleRun.baseCommit, fixture.staleBase);
    assert.equal(manifest.queue[0].staleRun.laneCommit, fixture.laneCommit);
    const output = errors.join('\n');
    assert.match(output, /Stale open run blocked delegation of "00001-alpha"/);
    assert.ok(output.includes('run-stale-alpha'), 'the halt names the run id');
    assert.ok(output.includes(fixture.staleBase), 'the halt names the run base commit');
    assert.ok(output.includes(fixture.laneCommit), 'the halt names the refreshed lane commit');
    assert.match(output, /--new-run/, 'the halt names the remedy');
    assert.match(logs.join('\n'), /Stale open runs/);
    assert.match(logs.join('\n'), /stale \| run run-stale-alpha/, 'the summary names the classification');
    assert.ok(logs.join('\n').includes(fixture.staleBase), 'the summary names the run base commit');
    assert.ok(logs.join('\n').includes(fixture.laneCommit), 'the summary names the refreshed lane commit');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.remote, { recursive: true, force: true });
  }
});

test('00058 AC13 & AC16: --new-run supersedes the stale run, records its id, and never resumes it', () => {
  const fixture = staleRunFixture();
  try {
    const invocations = [];
    const { result, logs } = captureLogs(() => queue.runBatch([fixture.alpha], {
      root: fixture.root,
      noSync: true,
      newRun: true,
      _invoke: ({ runId, resume, newRun }) => {
        invocations.push({ runId, resume, newRun });
        writeState(fixture.root, runId, 'completed', { specSlug: '00001-alpha', deliveryCommit: 'fresh-delivery' });
        return 0;
      }
    }));

    assert.equal(result, 0, 'the queue advances on a fresh run');
    assert.equal(invocations.length, 1);
    assert.notEqual(invocations[0].runId, 'run-stale-alpha', 'a fresh run id is used');
    assert.equal(invocations[0].resume, false, 'the stale run is never resumed');
    assert.equal(invocations[0].newRun, true, 'the flag is forwarded to the delegated run');
    const manifest = queue.loadManifest(queue.loadConfig(fixture.root));
    assert.equal(manifest.queue[0].supersededRunId, 'run-stale-alpha', 'the superseded run id is recorded on the item');
    assert.equal(manifest.queue[0].staleRun.superseded, true);
    assert.equal(manifest.queue[0].status, 'completed');
    const staleState = queue.readRunState(queue.loadConfig(fixture.root), 'run-stale-alpha');
    assert.equal(staleState.status, 'paused', 'the stale run state is left untouched');
    assert.match(logs.join('\n'), /superseded by --new-run/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(fixture.remote, { recursive: true, force: true });
  }
});

// Spec 00058 AC6: when no open pull request can deliver the missing commit, the
// pre-flight halts naming the commit and the branch instead of delegating.
test('00058 AC6: a missing delivery with no open pull request halts naming the commit and the branch', () => {
  const { root, specs } = setup();
  let remote = null;
  try {
    writeConfig(root, {
      scmProvider: 'github',
      batch: { autoMerge: true },
      branching: { workBranch: 'develop', integrationBranch: 'develop' }
    });
    remote = initRepoWithRemote(root);
    // A delivery commit the base never received, with no pull request recorded.
    git(root, ['commit', '-q', '--allow-empty', '-m', 'delivery that never landed']);
    const lostDelivery = git(root, ['rev-parse', 'HEAD']);
    git(root, ['reset', '-q', '--hard', 'HEAD~1']);

    let delegations = 0;
    const { result, errors } = captureAll(() => queue.runBatch(specs, {
      root,
      noSync: true,
      _invoke: ({ runId, specPath }) => {
        delegations += 1;
        writeState(root, runId, 'completed', {
          specSlug: path.basename(specPath, '.md'),
          deliveryCommit: lostDelivery,
          shipStatus: 'delivered'
        });
        return 0;
      }
    }));

    assert.equal(result, 1, 'the queue halts');
    assert.equal(delegations, 1, 'the next specification is never delegated');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'halted');
    assert.deepEqual(manifest.queue.map(item => item.status), ['completed', 'pending']);
    const preflight = manifest.queue[1].preflight;
    assert.equal(preflight.status, 'halted');
    assert.ok(preflight.reason.includes(lostDelivery), 'the halt names the missing delivery commit');
    assert.match(preflight.reason, /base branch "develop"/, 'the halt names the branch');
    assert.match(preflight.reason, /no open pull request can deliver it/);
    assert.match(errors.join('\n'), /Pre-flight halted the queue before delegating "00002-beta"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (remote) fs.rmSync(remote, { recursive: true, force: true });
  }
});
