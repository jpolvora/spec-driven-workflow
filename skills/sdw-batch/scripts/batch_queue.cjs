'use strict';

// sdw-batch queue: iterates a specification list and delegates each item to
// sdw-orch as one independent single-specification run. This module owns the
// manifest and the loop; it never duplicates orchestrator step logic.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Batch delegation is unattended and never passes --abort-on-gaps, so the only
// pause codes sdw-orch can return here are dispatch (4) and judgment (5).
const PAUSE_STATUS = {
  4: 'awaiting_implementation',
  5: 'awaiting_judgment'
};

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

// Human progress belongs on stderr under --json so stdout stays one JSON document.
function say(options, message) {
  if (options && options.json) console.error(message);
  else console.log(message);
}

function loadConfig(targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const configFile = path.join(root, '.sdw', 'config.json');
  let raw = {};
  if (fs.existsSync(configFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        || {};
    } catch (e) {
      throw new Error(`invalid .sdw/config.json: ${e.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('invalid .sdw/config.json: expected a JSON object');
    }
  }
  const expand = (value, fallback) => {
    const chosen = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    return path.resolve(chosen.replace(/\{projectRoot\}/g, normalizePath(root)));
  };
  return {
    root,
    specsDir: expand(raw.specsDir, path.join(root, '.sdw', 'specs')),
    stateDir: expand(raw.stateDir, path.join(root, '.sdw', 'state'))
  };
}

function runStateDir(config) {
  if (!fs.existsSync(config.stateDir)) fs.mkdirSync(config.stateDir, { recursive: true });
  return config.stateDir;
}

function resolveSpec(specInput, config) {
  const direct = path.isAbsolute(specInput) ? specInput : path.resolve(config.root, specInput);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const inSpecsDir = path.resolve(config.specsDir, specInput);
  if (fs.existsSync(inSpecsDir) && fs.statSync(inSpecsDir).isFile()) return inSpecsDir;
  if (fs.existsSync(`${inSpecsDir}.md`)) return `${inSpecsDir}.md`;
  return direct;
}

function inferSlug(specPath) {
  try {
    const content = fs.readFileSync(specPath, 'utf8');
    const match = content.match(/slug:\s*([^\r\n]+)/);
    if (match) return match[1].trim();
  } catch (e) {
    // Fall back to the file name.
  }
  return path.basename(specPath, path.extname(specPath));
}

function generateRunId(slug) {
  const clean = String(slug || 'spec').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30);
  return `run-${Date.now()}-${clean}`;
}

function manifestFilePath(config, batchId) {
  return path.join(runStateDir(config), `${batchId}.json`);
}

// A specification is already implemented when the registry records it as
// completed or archived; the queue must not re-run it from scratch.
function implementedStatuses(config) {
  try {
    const specIndex = require('../../sdw-spec/scripts/spec_index.cjs');
    const { entries } = specIndex.readIndex({ root: config.root });
    const statuses = new Map();
    for (const entry of entries || []) {
      if (entry.status === 'completed' || entry.status === 'archived') {
        statuses.set(entry.slug, entry.status);
      }
    }
    return statuses;
  } catch (e) {
    console.warn(`[sdw-batch] WARNING: could not read the specification index: ${e.message}`);
    return new Map();
  }
}

function createManifest({ specs, options, config }) {
  // Discovery without an explicit id only scans `batch-*.json`, so every batch
  // id is normalized to that prefix; a custom id stays resumable by itself.
  const requested = options.batchId ? String(options.batchId) : `batch-${Date.now()}`;
  const batchId = requested.startsWith('batch-') ? requested : `batch-${requested}`;
  const manifestFile = manifestFilePath(config, batchId);
  if (fs.existsSync(manifestFile)) {
    throw new Error(`batch "${batchId}" already exists at ${normalizePath(path.relative(config.root, manifestFile))}; pass a different --batch-id`);
  }
  const now = new Date().toISOString();
  const implemented = implementedStatuses(config);
  const queue = specs.map((specInput, index) => {
    const resolved = resolveSpec(specInput, config);
    const slug = inferSlug(resolved);
    const registryStatus = implemented.get(slug) || null;
    return {
      index,
      spec: normalizePath(path.relative(config.root, resolved)) || specInput,
      slug,
      status: registryStatus ? 'already_implemented' : 'pending',
      skipReason: registryStatus ? `already implemented (index.specs.md status: ${registryStatus})` : null,
      runId: null,
      deliveryCommit: null,
      branch: null,
      durationMs: null,
      error: null
    };
  });
  const manifest = {
    batchId,
    createdAt: now,
    updatedAt: now,
    status: 'in_progress',
    policy: {
      continueOnError: Boolean(options.continueOnError),
      syncIndex: options.noSync ? false : true
    },
    total: queue.length,
    currentIndex: 0,
    queue
  };
  saveManifest(config, manifest);
  return manifest;
}

function saveManifest(config, manifest) {
  manifest.updatedAt = new Date().toISOString();
  fs.mkdirSync(runStateDir(config), { recursive: true });
  fs.writeFileSync(manifestFilePath(config, manifest.batchId), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

function loadManifest(config, batchId) {
  const stateDir = runStateDir(config);
  if (batchId) {
    const clean = String(batchId).replace(/^batch-/, '');
    const direct = path.join(stateDir, `batch-${clean}.json`);
    if (fs.existsSync(direct)) return JSON.parse(fs.readFileSync(direct, 'utf8'));
    const alt = path.join(stateDir, `${batchId}.json`);
    if (fs.existsSync(alt)) return JSON.parse(fs.readFileSync(alt, 'utf8'));
    return null;
  }
  const files = fs.readdirSync(stateDir)
    .filter(name => name.startsWith('batch-') && name.endsWith('.json'))
    .map(name => ({ name, mtimeMs: fs.statSync(path.join(stateDir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(stateDir, files[0].name), 'utf8'));
}

function readRunState(config, runId) {
  if (!runId) return null;
  const file = path.join(runStateDir(config), `${runId}.state.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function triggerSpecSync(config) {
  try {
    const specSync = require('../../sdw-spec/scripts/spec_sync.cjs');
    if (specSync && typeof specSync.syncIndex === 'function') {
      specSync.syncIndex({ root: config.root });
      return true;
    }
  } catch (e) {
    // Index sync is best effort; the manifest outcome stays authoritative, but
    // the failure must reach the operator instead of leaving a stale registry.
    console.warn(`[sdw-batch] WARNING: spec index sync failed: ${e.message}`);
  }
  return false;
}

function orchestratorScript() {
  return path.resolve(__dirname, '..', '..', 'sdw-orch', 'scripts', 'sdw_orch.cjs');
}

function invokeOrchestrator({ config, runId, specPath, resume }) {
  const script = orchestratorScript();
  const args = resume
    ? [script, 'resume', '--run-id', runId, '--root', config.root]
    : [script, 'run', path.resolve(config.root, specPath), '--run-id', runId, '--unattended', '--root', config.root];
  const result = spawnSync(process.execPath, args, { cwd: config.root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return typeof result.status === 'number' ? result.status : 1;
}

function applyRunState(item, state) {
  if (!state) return;
  item.runId = state.runId || item.runId;
  item.branch = state.branch || item.branch || null;
  item.deliveryCommit = state.deliveryCommit || item.deliveryCommit || null;
}

function printSummary(manifest, options = {}) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const count = status => manifest.queue.filter(item => item.status === status).length;
  console.log('\n============================================================');
  console.log('SDW Batch Execution Summary');
  console.log(`Batch ID: ${manifest.batchId}`);
  console.log(`Status:   ${manifest.status}`);
  console.log(`Total:    ${manifest.total} (Completed: ${count('completed')}, Skipped: ${count('already_implemented')}, Failed: ${count('failed')}, Paused: ${manifest.queue.filter(item => item.status.startsWith('awaiting_')).length})`);
  console.log('------------------------------------------------------------');
  console.log('# | Slug                           | Status      | Duration | Delivery Commit');
  console.log('--|--------------------------------|-------------|----------|----------------');
  manifest.queue.forEach(item => {
    const index = String(item.index + 1).padEnd(2);
    const slug = String(item.slug || item.spec).padEnd(30).slice(0, 30);
    const status = String(item.status || 'unknown').padEnd(11);
    const duration = item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s`.padEnd(8) : '-       ';
    const commit = item.deliveryCommit ? String(item.deliveryCommit).slice(0, 12) : '-';
    console.log(`${index}| ${slug} | ${status} | ${duration} | ${commit}`);
  });
  console.log('============================================================\n');
}

function finishFailure(manifest, config, item, exitCode, message, options, continueOnError) {
  item.status = 'failed';
  item.error = message || `sdw-orch exited with code ${exitCode}`;
  saveManifest(config, manifest);
  if (!continueOnError) {
    manifest.status = 'halted';
    saveManifest(config, manifest);
    console.error(`\n[sdw-batch] Halting queue on failure: "${item.slug}". Remaining ${manifest.total - item.index - 1} specification(s) pending.`);
    printSummary(manifest, options);
    // Batch exit codes stay unambiguous: 0 completed, 1 failure, 4/5 pause.
    return 1;
  }
  say(options, `[sdw-batch] "${item.slug}" failed; continuing queue (--continue-on-error).`);
  return null;
}

function executeQueue(manifest, config, options) {
  let anyFailed = false;
  const continueOnError = options.continueOnError !== undefined
    ? Boolean(options.continueOnError)
    : Boolean(manifest.policy.continueOnError);
  const syncIndex = options.noSync !== undefined
    ? !options.noSync
    : manifest.policy.syncIndex !== false;
  const implemented = implementedStatuses(config);

  for (let i = manifest.currentIndex; i < manifest.queue.length; i += 1) {
    const item = manifest.queue[i];
    if (item.status === 'completed') {
      say(options, `[sdw-batch] Skipping completed specification [${item.index + 1}/${manifest.total}]: ${item.slug}`);
      continue;
    }
    // Re-check the registry per item so a spec completed since the manifest was
    // created is never implemented twice, including on resume.
    if (item.status !== 'already_implemented' && implemented.has(item.slug)) {
      item.status = 'already_implemented';
      item.skipReason = `already implemented (index.specs.md status: ${implemented.get(item.slug)})`;
      saveManifest(config, manifest);
    }
    if (item.status === 'already_implemented') {
      say(options, `[sdw-batch] Skipping already-implemented specification [${item.index + 1}/${manifest.total}]: ${item.slug} (${item.skipReason})`);
      continue;
    }

    manifest.currentIndex = i;
    item.status = 'in_progress';
    saveManifest(config, manifest);

    say(options, `\n[sdw-batch] [${item.index + 1}/${manifest.total}] Delegating ${item.slug} to sdw-orch (single run)`);
    const started = Date.now();
    const prior = readRunState(config, item.runId);
    const resumable = prior && (prior.status === 'paused' || prior.status === 'in_progress');
    let exitCode = 0;
    let failureMessage = null;

    if (prior && prior.status === 'completed') {
      say(options, `[sdw-batch] Run "${item.runId}" already completed; reconciling queue item.`);
      applyRunState(item, prior);
    } else {
      const runId = item.runId || generateRunId(item.slug);
      item.runId = runId;
      try {
        exitCode = options._invoke
          ? options._invoke({ config, runId, specPath: item.spec, resume: Boolean(resumable), runState: prior })
          : invokeOrchestrator({ config, runId, specPath: item.spec, resume: Boolean(resumable) });
      } catch (err) {
        exitCode = 1;
        failureMessage = err.message;
      }
      applyRunState(item, readRunState(config, item.runId));
    }

    item.durationMs = (item.durationMs || 0) + (Date.now() - started);

    if (exitCode === 0) {
      const finalState = readRunState(config, item.runId);
      if (!finalState || finalState.status !== 'completed') {
        anyFailed = true;
        const halt = finishFailure(manifest, config, item, 1, `Run "${item.runId}" exited 0 without completing`, options, continueOnError);
        if (halt !== null) return halt;
        continue;
      }
      applyRunState(item, finalState);
      item.status = 'completed';
      item.error = null;
      say(options, `[sdw-batch] "${item.slug}" completed in ${(item.durationMs / 1000).toFixed(1)}s.`);
      saveManifest(config, manifest);
      if (syncIndex) triggerSpecSync(config);
    } else if (PAUSE_STATUS[exitCode]) {
      item.status = PAUSE_STATUS[exitCode];
      item.error = null;
      manifest.status = 'paused';
      saveManifest(config, manifest);
      say(options, `\n[sdw-batch] "${item.slug}" paused with ${item.status} (sdw-orch exit code ${exitCode}).`);
      say(options, `[sdw-batch] Continue that run, then resume the queue with: sdw-batch resume ${manifest.batchId}`);
      printSummary(manifest, options);
      return exitCode;
    } else {
      anyFailed = true;
      const halt = finishFailure(manifest, config, item, exitCode, failureMessage, options, continueOnError);
      if (halt !== null) return halt;
    }
  }

  // A resume can begin past items that already failed, so the terminal status is
  // derived from the whole queue, not only from failures observed this pass.
  const stillFailed = manifest.queue.some(item => item.status === 'failed');
  manifest.status = (anyFailed || stillFailed) ? 'completed_with_errors' : 'completed';
  saveManifest(config, manifest);
  printSummary(manifest, options);
  return manifest.status === 'completed' ? 0 : 1;
}

function validateSpecs(specs, config) {
  const resolved = [];
  for (const specInput of specs) {
    const specPath = resolveSpec(specInput, config);
    if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
      return { valid: false, missing: specInput, resolved: [] };
    }
    resolved.push(specPath);
  }
  return { valid: true, missing: null, resolved };
}

function runBatch(specs, options = {}) {
  const config = loadConfig(options.root);
  if (!specs || specs.length === 0) {
    console.error('Error: No specifications provided.');
    return 1;
  }
  const validation = validateSpecs(specs, config);
  if (!validation.valid) {
    console.error(`Error: Batch pre-flight failed: specification not found: "${validation.missing}"`);
    console.error('Batch rejected before any specification executed.');
    return 1;
  }
  if (options.dryRun) {
    const implemented = implementedStatuses(config);
    console.log(`\n[sdw-batch] Dry-run plan (${validation.resolved.length} specification(s)):`);
    validation.resolved.forEach((specPath, index) => {
      const slug = inferSlug(specPath);
      const registryStatus = implemented.get(slug);
      const note = registryStatus ? ` - skipped: already implemented (${registryStatus})` : '';
      console.log(`  ${index + 1}. ${slug} (${normalizePath(specPath)})${note}`);
    });
    console.log('No specification executed (--dry-run).\n');
    return 0;
  }
  const manifest = createManifest({ specs: validation.resolved, options, config });
  say(options, `[sdw-batch] Initialized "${manifest.batchId}" with ${manifest.total} specification(s).`);
  say(options, `Policy: continueOnError=${manifest.policy.continueOnError}, syncIndex=${manifest.policy.syncIndex}`);
  return executeQueue(manifest, config, options);
}

function resumeBatch(batchId, options = {}) {
  const config = loadConfig(options.root);
  const manifest = loadManifest(config, batchId);
  if (!manifest) {
    console.error(`Error: No batch manifest found (${batchId || 'latest'}).`);
    return 1;
  }
  if (manifest.status === 'completed' || manifest.status === 'completed_with_errors') {
    const ok = manifest.status === 'completed';
    say(options, `[sdw-batch] Batch "${manifest.batchId}" is already finished (${manifest.status}).`);
    printSummary(manifest, options);
    return ok ? 0 : 1;
  }
  manifest.status = 'in_progress';
  saveManifest(config, manifest);
  say(options, `[sdw-batch] Resuming "${manifest.batchId}" (${manifest.currentIndex + 1}/${manifest.total})...`);
  return executeQueue(manifest, config, options);
}

function formatStatus(manifest) {
  if (!manifest) return 'No batch manifest found.';
  const lines = [
    `Batch ID: ${manifest.batchId}`,
    `Status:   ${manifest.status}`,
    `Progress: ${manifest.currentIndex + 1}/${manifest.total}`,
    'Queue:'
  ];
  manifest.queue.forEach(item => {
    lines.push(`  [${item.index + 1}] ${item.slug}: ${item.status}${item.runId ? ` (${item.runId})` : ''}`);
  });
  return lines.join('\n');
}

module.exports = {
  createManifest,
  executeQueue,
  formatStatus,
  generateRunId,
  inferSlug,
  invokeOrchestrator,
  loadConfig,
  loadManifest,
  manifestFilePath,
  printSummary,
  readRunState,
  resolveSpec,
  resumeBatch,
  runBatch,
  saveManifest,
  triggerSpecSync,
  validateSpecs
};
