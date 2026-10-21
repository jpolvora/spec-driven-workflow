'use strict';

// sdw-batch retro follow-up contract (spec 00046 AC1-AC8): consume the
// retrospective candidates a completed run recorded in state.retro, record the
// outcome on the manifest, queue draft specs for critical/high candidates under
// the queue policy, record creation failures, write the record-only report,
// skip without reading under none, and bound depth-1 items without prompting or
// halting. Every fixture lives in a temp root; no orchestrator run and no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const queue = require('../skills/sdw-batch/scripts/batch_queue.cjs');

const NOW = '2026-10-21T12:00:00.000Z';

function makeRoot(followUp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-batch-retro-'));
  fs.mkdirSync(path.join(root, '.sdw'), { recursive: true });
  const config = {
    specsDir: '{projectRoot}/.sdw/specs',
    stateDir: '{projectRoot}/.sdw/state',
    retro: { enabled: true, followUp: followUp || 'queue' }
  };
  fs.writeFileSync(path.join(root, '.sdw', 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return root;
}

function candidate(id, severity, extra = {}) {
  return {
    id,
    title: `${id} title`,
    severity,
    category: 'automated-check',
    evidence: { artifact: '.sdw/state/run-1.state.json', ref: '#steps.8.output' },
    proposedChange: { target: `.sdw/specs/${String(id).toLowerCase()}.md` },
    ...extra
  };
}

function writeRun(root, runId, candidates, options = {}) {
  const stateDir = path.join(root, '.sdw', 'state');
  const reportRel = `.sdw/state/00100-fixture/${runId}/${runId}.retro.json`;
  const retro = options.retro !== undefined
    ? options.retro
    : {
      status: 'passed',
      reportMd: reportRel.replace(/\.json$/, '.md'),
      reportJson: reportRel,
      error: null,
      ranAt: NOW
    };
  if (retro && retro.reportJson && options.writeReport !== false) {
    const reportAbs = path.join(root, retro.reportJson);
    fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
    const body = options.reportRaw !== undefined
      ? options.reportRaw
      : `${JSON.stringify({ runId, status: 'completed', candidates }, null, 2)}\n`;
    fs.writeFileSync(reportAbs, body, 'utf8');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `${runId}.state.json`),
    `${JSON.stringify({ runId, status: 'completed', retro }, null, 2)}\n`,
    'utf8'
  );
  return { reportRel };
}

function makeManifest() {
  return {
    batchId: 'batch-test',
    createdAt: NOW,
    updatedAt: NOW,
    status: 'in_progress',
    policy: { continueOnError: false, syncIndex: true },
    total: 2,
    currentIndex: 0,
    queue: [
      {
        index: 0,
        spec: '.sdw/specs/00001-alpha.md',
        slug: '00001-alpha',
        status: 'completed',
        runId: 'run-1',
        deliveryCommit: null,
        durationMs: null,
        error: null
      },
      {
        index: 1,
        spec: '.sdw/specs/00002-beta.md',
        slug: '00002-beta',
        status: 'pending',
        runId: null,
        deliveryCommit: null,
        durationMs: null,
        error: null
      }
    ]
  };
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

test('AC1: a completed item records the candidate count, severity breakdown, and report path', () => {
  const root = makeRoot('queue');
  try {
    const { reportRel } = writeRun(root, 'run-1', [
      candidate('RETRO-001', 'high'),
      candidate('RETRO-002', 'low')
    ]);
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    const item = manifest.queue[0];

    const result = queue.applyRetroFollowUp({
      config,
      manifest,
      item,
      deps: {
        createSpec: () => ({
          filePath: path.join(root, '.sdw', 'specs', '00100-high-fix.md'),
          slug: '00100-high-fix'
        })
      }
    });

    assert.equal(result, item.retroFollowUp, 'the outcome is recorded on the item');
    assert.equal(result.status, 'queued');
    assert.equal(result.candidates, 2, 'the recorded value is the candidate count');
    assert.deepEqual(result.bySeverity, { high: 1, low: 1 });
    assert.equal(result.reportPath, reportRel);
    assert.equal(result.queued.length, 1, 'only the high candidate is queued');
    assert.deepEqual(result.failures, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: critical and high candidates become draft specs appended after the remaining items', () => {
  const root = makeRoot('queue');
  try {
    writeRun(root, 'run-1', [
      candidate('RETRO-001', 'critical'),
      candidate('RETRO-002', 'medium'),
      candidate('RETRO-003', 'high')
    ]);
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    const created = [];
    const result = queue.applyRetroFollowUp({
      config,
      manifest,
      item: manifest.queue[0],
      deps: {
        createSpec: ({ candidate: entry }) => {
          created.push(entry.id);
          return {
            filePath: path.join(root, '.sdw', 'specs', `00100-${entry.id.toLowerCase()}.md`),
            slug: `00100-${entry.id.toLowerCase()}`
          };
        }
      }
    });

    assert.deepEqual(created, ['RETRO-001', 'RETRO-003'], 'medium candidates stay in the report');
    assert.equal(result.status, 'queued');
    assert.equal(manifest.queue.length, 4, 'two follow-ups are appended to a two-item queue');
    assert.equal(manifest.total, 4, 'the total follows the queue');
    assert.deepEqual(manifest.queue.map(entry => entry.slug), [
      '00001-alpha',
      '00002-beta',
      '00100-retro-001',
      '00100-retro-003'
    ], 'follow-ups land after the remaining items');

    const first = manifest.queue[2];
    assert.equal(first.index, 2);
    assert.equal(first.spec, '.sdw/specs/00100-retro-001.md');
    assert.equal(first.slug, '00100-retro-001');
    assert.equal(first.status, 'pending');
    assert.equal(first.followUpDepth, 1);
    assert.deepEqual(first.origin, { candidateId: 'RETRO-001', runId: 'run-1' });
    assert.deepEqual(result.queued, [
      { candidateId: 'RETRO-001', spec: '.sdw/specs/00100-retro-001.md', slug: '00100-retro-001' },
      { candidateId: 'RETRO-003', spec: '.sdw/specs/00100-retro-003.md', slug: '00100-retro-003' }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: a queued entry is on disk before the next specification is created', () => {
  const root = makeRoot('queue');
  try {
    writeRun(root, 'run-1', [
      candidate('RETRO-001', 'critical'),
      candidate('RETRO-003', 'high')
    ]);
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    const manifestPath = path.join(root, '.sdw', 'state', `${manifest.batchId}.json`);
    let firstEntryPersisted = null;
    queue.applyRetroFollowUp({
      config,
      manifest,
      item: manifest.queue[0],
      deps: {
        createSpec: ({ candidate: entry }) => {
          if (entry.id === 'RETRO-003') {
            const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            firstEntryPersisted = onDisk.queue.some(item => item.slug === '00100-retro-001');
          }
          return {
            filePath: path.join(root, '.sdw', 'specs', `00100-${entry.id.toLowerCase()}.md`),
            slug: `00100-${entry.id.toLowerCase()}`
          };
        }
      }
    });
    assert.equal(firstEntryPersisted, true, 'the earlier follow-up must survive an interruption before the batch save');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: resume re-enters the follow-up stage for candidates a crash left behind', () => {
  const root = makeRoot('queue');
  try {
    writeRun(root, 'run-1', [
      candidate('RETRO-001', 'critical'),
      candidate('RETRO-003', 'high')
    ]);
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    const item = manifest.queue[0];
    item.retroFollowUp = {
      status: 'queued',
      candidates: 2,
      bySeverity: { critical: 1, high: 1 },
      reportPath: '.sdw/state/run-1.retro.json',
      queued: [{ candidateId: 'RETRO-001', spec: '.sdw/specs/00100-retro-001.md', slug: '00100-retro-001' }],
      failures: [],
      processed: ['RETRO-001']
    };
    manifest.queue.push({
      index: 2,
      spec: '.sdw/specs/00100-retro-001.md',
      slug: '00100-retro-001',
      status: 'pending',
      runId: null,
      followUpDepth: 1
    });
    const created = [];
    const deps = {
      createSpec: ({ candidate: entry }) => {
        created.push(entry.id);
        return {
          filePath: path.join(root, '.sdw', 'specs', `00100-${entry.id.toLowerCase()}.md`),
          slug: `00100-${entry.id.toLowerCase()}`
        };
      }
    };

    const recovered = queue.recoverFollowUps(manifest, config, {}, deps);
    assert.equal(recovered, 1, 'only the interrupted candidate is recovered');
    assert.deepEqual(created, ['RETRO-003'], 'the checkpointed candidate is never re-created');

    const again = queue.recoverFollowUps(manifest, config, {}, deps);
    assert.equal(again, 0, 'a second resume is idempotent');
    assert.deepEqual(created, ['RETRO-003'], 'no duplicate specification on the second pass');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: the default seam creates the draft specification through the sdw-spec CLI', () => {
  const root = makeRoot('queue');
  try {
    writeRun(root, 'run-1', [candidate('RETRO-001', 'critical')]);
    const config = queue.loadConfig(root);
    const manifest = makeManifest();

    const result = queue.applyRetroFollowUp({ config, manifest, item: manifest.queue[0] });

    assert.equal(result.status, 'queued');
    assert.deepEqual(result.failures, []);
    const entry = manifest.queue[2];
    const specFile = path.join(root, entry.spec);
    assert.ok(fs.existsSync(specFile), `the CLI created ${entry.spec}`);
    const content = fs.readFileSync(specFile, 'utf8');
    assert.match(content, /^status: draft$/m, 'a follow-up specification is always a draft');
    assert.ok(content.includes('RETRO-001 title'), 'the candidate title reaches the specification');
    assert.ok(content.includes('Proposed change: .sdw/specs/retro-001.md'), 'the proposed change is serialized');
    assert.ok(content.includes('Evidence: '), 'the evidence reference is serialized');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: a failed specification creation is recorded against its candidate and the item stays completed', () => {
  const root = makeRoot('queue');
  try {
    writeRun(root, 'run-1', [
      candidate('RETRO-001', 'critical'),
      candidate('RETRO-002', 'high')
    ]);
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    const item = manifest.queue[0];

    const result = queue.applyRetroFollowUp({
      config,
      manifest,
      item,
      deps: {
        createSpec: ({ candidate: entry }) => {
          if (entry.id === 'RETRO-001') throw new Error('spec directory is read-only');
          return {
            filePath: path.join(root, '.sdw', 'specs', '00100-retro-002.md'),
            slug: '00100-retro-002'
          };
        }
      }
    });

    assert.equal(result.status, 'queued', 'the stage does not become a batch failure');
    assert.deepEqual(result.failures, [{ candidateId: 'RETRO-001', error: 'spec directory is read-only' }]);
    assert.equal(result.queued.length, 1, 'the next candidate is still processed');
    assert.equal(manifest.queue.length, 3, 'only the successful candidate is appended');
    assert.equal(manifest.queue[2].origin.candidateId, 'RETRO-002');
    assert.equal(item.status, 'completed', 'the completed item is untouched');
    assert.equal(manifest.status, 'in_progress', 'the queue status does not change');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC3: the summary lists queued follow-ups and every creation failure', () => {
  const manifest = makeManifest();
  manifest.queue[0].retroFollowUp = {
    status: 'queued',
    candidates: 2,
    bySeverity: { critical: 1, high: 1 },
    reportPath: '.sdw/state/fixture.retro.json',
    queued: [{ candidateId: 'RETRO-002', spec: '.sdw/specs/00100-retro-002.md', slug: '00100-retro-002' }],
    failures: [{ candidateId: 'RETRO-001', error: 'sdw-spec exited with code 1' }]
  };

  const { logs } = captureLogs(() => queue.printSummary(manifest));
  const output = logs.join('\n');

  assert.ok(output.includes('Retro Follow-Ups'), 'a follow-up section is printed');
  assert.ok(output.includes('candidates: 2 (critical: 1, high: 1)'), 'the severity breakdown is visible');
  assert.ok(output.includes('+ .sdw/specs/00100-retro-002.md'), 'the queued specification is visible');
  assert.ok(output.includes('! RETRO-001: sdw-spec exited with code 1'), 'the failure is listed with its candidate');
});

test('AC4: record policy writes one report listing every candidate and creates no specification', () => {
  const root = makeRoot('record');
  try {
    const { reportRel } = writeRun(root, 'run-1', [
      candidate('RETRO-001', 'critical'),
      candidate('RETRO-002', 'low')
    ]);
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    let creations = 0;

    const result = queue.applyRetroFollowUp({
      config,
      manifest,
      item: manifest.queue[0],
      deps: { createSpec: () => { creations += 1; throw new Error('record policy must not create specs'); } }
    });

    assert.equal(result.status, 'recorded');
    assert.equal(creations, 0, 'record policy creates no specification');
    assert.equal(manifest.queue.length, 2, 'record policy leaves the queue untouched');
    assert.equal(manifest.total, 2);

    const reportFile = path.join(root, '.sdw', 'state', 'batch-test.followups.md');
    assert.ok(fs.existsSync(reportFile), 'the follow-up report is written beside the manifest');
    const content = fs.readFileSync(reportFile, 'utf8');
    assert.ok(content.includes(`# Batch Retro Follow-Ups: batch-test`));
    assert.ok(content.includes(`- **Report:** \`${reportRel}\``));
    for (const marker of ['RETRO-001', 'RETRO-001 title', 'critical', 'RETRO-002', 'RETRO-002 title', 'low']) {
      assert.ok(content.includes(marker), `the report includes ${marker}`);
    }
    assert.ok(content.includes('.sdw/state/run-1.state.json#steps.8.output'), 'evidence is listed');
    assert.ok(content.includes('**Proposed change:** .sdw/specs/retro-001.md'), 'the proposed change is listed');
    assert.equal(fs.existsSync(path.join(root, '.sdw', 'specs')), false, 'no specification directory is created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC5: none leaves the retro report unread and records skipped', () => {
  const root = makeRoot('none');
  try {
    // The report path is an existing directory: any read attempt throws EISDIR
    // and would surface as invalid/failed instead of skipped.
    const reportDir = path.join(root, '.sdw', 'state', 'unreadable.retro.json');
    fs.mkdirSync(reportDir, { recursive: true });
    writeRun(root, 'run-1', [], {
      retro: { status: 'passed', reportMd: null, reportJson: '.sdw/state/unreadable.retro.json', error: null, ranAt: NOW },
      writeReport: false
    });
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    const item = manifest.queue[0];
    let creations = 0;

    const result = queue.applyRetroFollowUp({
      config,
      manifest,
      item,
      deps: { createSpec: () => { creations += 1; throw new Error('none policy must not create specs'); } }
    });

    assert.ok(fs.statSync(reportDir).isDirectory(), 'the fixture report path is a directory, not a readable report');
    assert.deepEqual(result, { status: 'skipped' });
    assert.deepEqual(item.retroFollowUp, { status: 'skipped' });
    assert.equal(creations, 0);
    assert.equal(manifest.queue.length, 2, 'the queue is untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing report: the item records unavailable and the stage does not throw', () => {
  const root = makeRoot('queue');
  try {
    writeRun(root, 'run-1', [], {
      retro: { status: 'passed', reportMd: null, reportJson: null, error: null, ranAt: NOW }
    });
    writeRun(root, 'run-2', [], {
      retro: { status: 'passed', reportMd: null, reportJson: '.sdw/state/deleted.retro.json', error: null, ranAt: NOW },
      writeReport: false
    });
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    manifest.queue[1].runId = 'run-2';

    const noPath = queue.applyRetroFollowUp({ config, manifest, item: manifest.queue[0] });
    assert.equal(noPath.status, 'unavailable');
    assert.equal(noPath.candidates, 0);
    assert.equal(noPath.reportPath, null);

    const deleted = queue.applyRetroFollowUp({ config, manifest, item: manifest.queue[1] });
    assert.equal(deleted.status, 'unavailable');
    assert.equal(deleted.reportPath, '.sdw/state/deleted.retro.json');
    assert.deepEqual(deleted.queued, []);
    assert.equal(manifest.queue.length, 2, 'nothing is queued');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed retro: the item records failed instead of throwing', () => {
  const root = makeRoot('queue');
  try {
    writeRun(root, 'run-1', [], {
      retro: { status: 'failed', reportMd: null, reportJson: null, error: 'retro exploded', ranAt: NOW }
    });
    const config = queue.loadConfig(root);
    const manifest = makeManifest();

    const result = queue.applyRetroFollowUp({ config, manifest, item: manifest.queue[0] });

    assert.equal(result.status, 'failed');
    assert.equal(result.reportPath, null);
    assert.equal(result.candidates, 0);
    assert.deepEqual(result.failures, []);
    assert.equal(manifest.queue.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed report: the item records invalid instead of throwing', () => {
  const root = makeRoot('queue');
  try {
    writeRun(root, 'run-1', [], { reportRaw: '{"candidates": [' });
    writeRun(root, 'run-2', [], { reportRaw: '{"candidates": "not-an-array"}' });
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    manifest.queue[1].runId = 'run-2';

    const broken = queue.applyRetroFollowUp({ config, manifest, item: manifest.queue[0] });
    assert.equal(broken.status, 'invalid');

    const wrongShape = queue.applyRetroFollowUp({ config, manifest, item: manifest.queue[1] });
    assert.equal(wrongShape.status, 'invalid');
    assert.equal(manifest.queue.length, 2, 'malformed candidates never enter the queue');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC6: a depth-1 follow-up item records its candidates and queues nothing further', () => {
  const root = makeRoot('queue');
  try {
    const { reportRel } = writeRun(root, 'run-1', [
      candidate('RETRO-001', 'high'),
      candidate('RETRO-002', 'high')
    ]);
    const config = queue.loadConfig(root);
    const manifest = makeManifest();
    const item = manifest.queue[0];
    item.followUpDepth = 1;
    let creations = 0;

    const result = queue.applyRetroFollowUp({
      config,
      manifest,
      item,
      deps: { createSpec: () => { creations += 1; throw new Error('depth guard must not create specs'); } }
    });

    assert.equal(result.status, 'depth-exceeded');
    assert.equal(result.candidates, 2, 'the candidate count stays visible');
    assert.deepEqual(result.bySeverity, { high: 2 }, 'the severity breakdown stays visible');
    assert.equal(result.reportPath, reportRel);
    assert.deepEqual(result.queued, [], 'no follow-up specification is queued');
    assert.equal(creations, 0);
    assert.equal(item.status, 'completed', 'the delegated outcome is untouched');
    assert.equal(manifest.queue.length, 2, 'no follow-up is appended');
    assert.equal(manifest.total, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loop: the follow-up stage runs after a completed item and appended items never queue more specs', () => {
  const root = makeRoot('queue');
  try {
    const specsDir = path.join(root, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const writeSpec = (name, slug) => {
      const file = path.join(specsDir, name);
      fs.writeFileSync(file, `---\nslug: ${slug}\ntitle: "${slug}"\n---\n# ${slug}\n`, 'utf8');
      return file;
    };
    const specs = [writeSpec('00001-alpha.md', '00001-alpha'), writeSpec('00002-beta.md', '00002-beta')];
    const created = [];

    const code = queue.runBatch(specs, {
      root,
      noSync: true,
      _retroDeps: {
        createSpec: ({ candidate: entry, item }) => {
          const filePath = path.join(specsDir, `00003-followup-${created.length + 1}.md`);
          created.push({ candidateId: entry.id, itemSlug: item.slug, filePath });
          return { filePath, slug: `00003-followup-${created.length}` };
        }
      },
      _invoke: ({ runId }) => {
        writeRun(root, runId, [candidate('RETRO-001', 'high')]);
        return 0;
      }
    });

    assert.equal(code, 0);
    assert.equal(created.length, 2, 'each original item queues exactly one follow-up');

    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.total, 4);
    assert.deepEqual(manifest.queue.map(entry => entry.followUpDepth || null), [null, null, 1, 1]);
    assert.equal(manifest.queue[2].status, 'completed');
    assert.equal(manifest.queue[2].retroFollowUp.status, 'depth-exceeded');
    assert.equal(manifest.queue[2].retroFollowUp.candidates, 1, 'the depth-1 candidate is still summarized');
    assert.deepEqual(manifest.queue[2].retroFollowUp.bySeverity, { high: 1 });
    assert.deepEqual(manifest.queue[2].retroFollowUp.queued, []);
    assert.equal(manifest.queue[0].retroFollowUp.status, 'queued');
    assert.equal(manifest.status, 'completed', 'the follow-up stage never halts or pauses the queue');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC7: a throwing specification creation never halts the queue and the item stays completed', () => {
  const root = makeRoot('queue');
  try {
    const specsDir = path.join(root, '.sdw', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const writeSpec = (name, slug) => {
      const file = path.join(specsDir, name);
      fs.writeFileSync(file, `---\nslug: ${slug}\ntitle: "${slug}"\n---\n# ${slug}\n`, 'utf8');
      return file;
    };
    const specs = [writeSpec('00001-alpha.md', '00001-alpha'), writeSpec('00002-beta.md', '00002-beta')];
    let runs = 0;

    const code = queue.runBatch(specs, {
      root,
      noSync: true,
      _retroDeps: { createSpec: () => { throw new Error('sdw-spec exploded'); } },
      _invoke: ({ runId }) => {
        runs += 1;
        writeRun(root, runId, [candidate('RETRO-001', 'high')]);
        return 0;
      }
    });

    assert.equal(code, 0, 'the batch still succeeds');
    assert.equal(runs, 2, 'the queue advanced past the failed follow-up');
    const manifest = queue.loadManifest(queue.loadConfig(root));
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.queue.length, 2, 'a failed creation appends nothing');
    const first = manifest.queue[0];
    assert.equal(first.status, 'completed', 'the delegated outcome stays completed');
    assert.equal(first.retroFollowUp.status, 'queued');
    assert.deepEqual(first.retroFollowUp.queued, []);
    assert.deepEqual(first.retroFollowUp.failures, [{ candidateId: 'RETRO-001', error: 'sdw-spec exploded' }]);
    assert.equal(manifest.queue[1].status, 'completed', 'the next item still runs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC7: the follow-up stage has no prompting or process-exit path', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'sdw-batch', 'scripts', 'batch_queue.cjs'),
    'utf8'
  );
  assert.doesNotMatch(source, /require\(['"]readline['"]\)/, 'no readline API');
  assert.doesNotMatch(source, /\breadline\b/, 'no readline reference');
  assert.doesNotMatch(source, /\bprompt\s*\(/, 'no prompt API');
  assert.doesNotMatch(source, /\bprocess\.exit\s*\(/, 'the stage returns instead of exiting');
});
