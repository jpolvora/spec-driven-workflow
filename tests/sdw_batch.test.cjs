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
    specSlug: 'fixture',
    deliveryCommit: extra.deliveryCommit || null,
    branch: extra.branch || 'develop',
    pullRequest,
    shipStatus,
    // Step 8 output is the delivery record sdw-orch writes for the item.
    steps: {
      8: { name: 'pr_preparation', status: 'completed', output: { pullRequest, shipStatus } }
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
