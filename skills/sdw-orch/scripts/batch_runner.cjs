'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function loadProjectConfig(targetRoot) {
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    if (sdwConfig && typeof sdwConfig.loadConfig === 'function') {
      return sdwConfig.loadConfig(targetRoot);
    }
  } catch (e) {}

  const root = targetRoot || process.cwd();
  const configFile = path.join(root, '.sdw', 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const normRoot = root.replace(/\\/g, '/');
      const resolved = {};
      for (const [k, v] of Object.entries(raw)) {
        resolved[k] = typeof v === 'string' ? v.replace(/\{projectRoot\}/g, normRoot) : v;
      }
      return {
        specsDir: path.join(root, '.sdw', 'specs').replace(/\\/g, '/'),
        scoreMin: 8,
        scmCodeReviewEnabled: false,
        pushDelivery: false,
        stateDir: path.join(root, '.sdw', 'state').replace(/\\/g, '/'),
        ...resolved
      };
    } catch (e) {}
  }

  return {
    specsDir: path.join(root, '.sdw', 'specs').replace(/\\/g, '/'),
    scoreMin: 8,
    scmCodeReviewEnabled: false,
    pushDelivery: false,
    stateDir: path.join(root, '.sdw', 'state').replace(/\\/g, '/'),
    autoResolveGaps: false
  };
}

function getStateDir(targetRoot, config) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  if (config && config.stateDir) {
    return path.resolve(config.stateDir.replace(/\{projectRoot\}/g, normalizePath(root)));
  }
  return path.resolve(root, '.sdw', 'state');
}

function resolveSpec(specInput, targetRoot, config) {
  if (!specInput) return null;
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();

  const directPath = path.isAbsolute(specInput) ? specInput : path.resolve(root, specInput);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }

  if (config && config.specsDir) {
    const resolvedSpecsDir = config.specsDir.replace(/\{projectRoot\}/g, normalizePath(root));
    const inside = path.resolve(resolvedSpecsDir, specInput);
    if (fs.existsSync(inside) && fs.statSync(inside).isFile()) return inside;
    if (fs.existsSync(`${inside}.md`)) return `${inside}.md`;
    if (fs.existsSync(`${inside}.spec.md`)) return `${inside}.spec.md`;
  }

  const insideDefault = path.resolve(root, '.sdw', 'specs', specInput);
  if (fs.existsSync(insideDefault) && fs.statSync(insideDefault).isFile()) return insideDefault;
  if (fs.existsSync(`${insideDefault}.md`)) return `${insideDefault}.md`;

  return directPath;
}

function inferSlug(specFilePath) {
  const basename = path.basename(specFilePath, path.extname(specFilePath));
  try {
    if (fs.existsSync(specFilePath)) {
      const content = fs.readFileSync(specFilePath, 'utf8');
      const m = content.match(/slug:\s*([^\r\n]+)/);
      if (m) return m[1].trim();
    }
  } catch (e) {}
  return basename.replace(/^step-\d+-/, '');
}

function validateBatchSpecs(specs, targetRoot, config) {
  const resolvedList = [];
  for (const s of specs) {
    const resolved = resolveSpec(s, targetRoot, config);
    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return {
        valid: false,
        missing: s,
        resolved: null,
        specs: []
      };
    }
    resolvedList.push({
      input: s,
      resolved: normalizePath(resolved),
      slug: inferSlug(resolved)
    });
  }
  return {
    valid: true,
    missing: null,
    specs: resolvedList
  };
}

function getBatchManifestPath(targetRoot, batchId, config) {
  const stateDir = getStateDir(targetRoot, config);
  const cleanId = String(batchId || '').replace(/^batch-/, '');
  return path.join(stateDir, `batch-${cleanId}.json`);
}

function createBatchManifest({ root, specs, options, config }) {
  const stateDir = getStateDir(root, config);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const batchId = options.batchId || `batch-${Date.now()}`;
  const now = new Date().toISOString();

  const queue = specs.map((s, index) => {
    const resolved = resolveSpec(s, root, config);
    const slug = inferSlug(resolved || s);
    return {
      index,
      spec: s,
      slug,
      status: 'pending',
      runId: null,
      branch: null,
      deliveryCommit: null,
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
      syncIndex: options.noSync ? false : true,
      unattended: options.unattended !== false
    },
    total: queue.length,
    currentIndex: 0,
    queue
  };

  saveBatchManifest(root, manifest, config);
  return manifest;
}

function saveBatchManifest(targetRoot, manifest, config) {
  const stateDir = getStateDir(targetRoot, config);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  manifest.updatedAt = new Date().toISOString();
  const filePath = path.join(stateDir, `${manifest.batchId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf8');
  return filePath;
}

function listBatchManifests(targetRoot, config) {
  const stateDir = getStateDir(targetRoot, config);
  if (!fs.existsSync(stateDir)) return [];

  const files = fs.readdirSync(stateDir)
    .filter(f => f.startsWith('batch-') && f.endsWith('.json'))
    .sort((a, b) => {
      const statA = fs.statSync(path.join(stateDir, a));
      const statB = fs.statSync(path.join(stateDir, b));
      return statB.mtimeMs - statA.mtimeMs;
    });

  return files.map(f => {
    try {
      const full = path.join(stateDir, f);
      return { file: f, path: full, manifest: JSON.parse(fs.readFileSync(full, 'utf8')) };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

function loadBatchManifest(targetRoot, batchId, config) {
  const stateDir = getStateDir(targetRoot, config);
  if (!fs.existsSync(stateDir)) return null;

  if (batchId) {
    const cleanId = String(batchId).replace(/^batch-/, '');
    const directFile = path.join(stateDir, `batch-${cleanId}.json`);
    if (fs.existsSync(directFile)) {
      return JSON.parse(fs.readFileSync(directFile, 'utf8'));
    }
    const altFile = path.join(stateDir, `${batchId}.json`);
    if (fs.existsSync(altFile)) {
      return JSON.parse(fs.readFileSync(altFile, 'utf8'));
    }
    return null;
  }

  const manifests = listBatchManifests(targetRoot, config);
  return manifests.length > 0 ? manifests[0].manifest : null;
}

function triggerSpecSync(targetRoot) {
  try {
    const specSync = require('../../sdw-spec/scripts/spec_sync.cjs');
    if (specSync && typeof specSync.syncIndex === 'function') {
      specSync.syncIndex({ root: targetRoot });
      return;
    }
  } catch (e) {}

  try {
    execSync('node skills/sdw-spec/scripts/sdw_spec.cjs sync', {
      cwd: targetRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    });
  } catch (e) {}
}

function printSummaryReport(manifest, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const passedCount = manifest.queue.filter(q => q.status === 'completed').length;
  const failedCount = manifest.queue.filter(q => q.status === 'failed').length;
  const pendingCount = manifest.queue.filter(q => q.status === 'pending').length;
  const totalDurationMs = manifest.queue.reduce((acc, q) => acc + (q.durationMs || 0), 0);

  console.log('\n============================================================');
  console.log('SDW Orchestrator Batch Execution Summary');
  console.log(`Batch ID: ${manifest.batchId}`);
  console.log(`Status:   ${manifest.status}`);
  console.log(`Total:    ${manifest.total} (Passed: ${passedCount}, Failed: ${failedCount}, Pending: ${pendingCount})`);
  console.log(`Duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
  console.log('------------------------------------------------------------');
  console.log('# | Slug                           | Status      | Duration | Delivery Commit');
  console.log('--|--------------------------------|-------------|----------|----------------');
  manifest.queue.forEach(item => {
    const idx = String(item.index + 1).padEnd(2);
    const slug = (item.slug || item.spec).padEnd(30).slice(0, 30);
    const st = (item.status || 'unknown').padEnd(11);
    const dur = item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s`.padEnd(8) : '-       ';
    const commit = item.deliveryCommit || (item.error ? `Error: ${item.error.slice(0, 15)}` : '-');
    console.log(`${idx}| ${slug} | ${st} | ${dur} | ${commit}`);
  });
  console.log('============================================================\n');
}

function executeQueue(manifest, targetRoot, config, options, cmdRun) {
  let anyFailed = false;

  for (let i = manifest.currentIndex; i < manifest.queue.length; i++) {
    const item = manifest.queue[i];

    if (item.status === 'completed') {
      console.log(`[sdw-orch batch] Skipping completed specification [${item.index + 1}/${manifest.total}]: ${item.slug}`);
      continue;
    }

    manifest.currentIndex = i;
    item.status = 'in_progress';
    saveBatchManifest(targetRoot, manifest, config);

    console.log(`\n[sdw-orch batch] [${item.index + 1}/${manifest.total}] Starting specification: ${item.slug} (${item.spec})`);
    const startTime = Date.now();

    const runOpts = {
      ...options,
      root: targetRoot,
      specPath: item.spec,
      runId: undefined, // ensure isolated runId per spec (AC3, AC11)
      unattended: options.unattended !== false,
      autoResolveGaps: true,
      abortOnGaps: false,
      _runResult: null
    };

    let exitCode = 0;
    try {
      exitCode = cmdRun(runOpts);
    } catch (err) {
      exitCode = 1;
      runOpts._runResult = { error: err.message };
    }

    item.durationMs = Date.now() - startTime;

    if (runOpts._runResult) {
      item.runId = runOpts._runResult.runId || null;
      item.deliveryCommit = runOpts._runResult.deliveryCommit || null;
      item.branch = runOpts._runResult.branch || null;
    }

    if (exitCode === 0) {
      item.status = 'completed';
      item.error = null;
      console.log(`[sdw-orch batch] Specification "${item.slug}" completed successfully in ${(item.durationMs / 1000).toFixed(1)}s.`);
      saveBatchManifest(targetRoot, manifest, config);

      // AC4: Post-completion sdw-spec sync
      if (manifest.policy.syncIndex) {
        triggerSpecSync(targetRoot);
      }
    } else if (exitCode === 4) {
      // AC31, AC32: Pause queue when specification awaits task implementation
      item.status = 'awaiting_implementation';
      item.error = null;
      manifest.status = 'paused';
      manifest.updatedAt = new Date().toISOString();
      saveBatchManifest(targetRoot, manifest, config);
      console.log(`\n[sdw-orch batch] Specification "${item.slug}" paused with awaiting_implementation (exit code 4).`);
      console.log(`[sdw-orch batch] Batch queue paused at [${item.index + 1}/${manifest.total}]. Resume after task implementation with: sdw-orch resume-batch ${manifest.batchId}`);
      printSummaryReport(manifest, options);
      return 4;
    } else {
      anyFailed = true;
      item.status = 'failed';
      item.error = (runOpts._runResult && runOpts._runResult.error) ? runOpts._runResult.error : `Process exited with code ${exitCode}`;
      saveBatchManifest(targetRoot, manifest, config);

      if (!manifest.policy.continueOnError) {
        // AC5: Halt on error
        manifest.status = 'halted';
        manifest.updatedAt = new Date().toISOString();
        saveBatchManifest(targetRoot, manifest, config);
        console.error(`\n[sdw-orch batch] Halting batch execution on failure: "${item.slug}". Remaining ${manifest.total - item.index - 1} specifications remain queued.`);
        printSummaryReport(manifest, options);
        return exitCode || 1;
      } else {
        // AC6: Continue on error
        console.log(`[sdw-orch batch] Specification "${item.slug}" failed, continuing queue (--continue-on-error).`);
      }
    }
  }

  manifest.status = anyFailed ? 'completed_with_errors' : 'completed';
  manifest.updatedAt = new Date().toISOString();
  saveBatchManifest(targetRoot, manifest, config);

  printSummaryReport(manifest, options);
  return anyFailed ? 1 : 0;
}

function runBatch(specs, options, cmdRun) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const config = options._config || loadProjectConfig(targetRoot);

  if (!specs || specs.length === 0) {
    console.error('Error: No specifications provided for batch execution.');
    return 1;
  }

  // AC8: Pre-flight missing specification check
  const validation = validateBatchSpecs(specs, targetRoot, config);
  if (!validation.valid) {
    console.error(`Error: Batch pre-flight check failed: Specification file not found: "${validation.missing}"`);
    console.error('Batch execution rejected before any specifications were executed.');
    return 1;
  }

  // AC9: Side-effect-free dry-run
  if (options.dryRun) {
    console.log(`\n[sdw-orch batch] Dry-run execution plan (${validation.specs.length} specification(s)):`);
    validation.specs.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.slug} (${s.resolved})`);
    });
    console.log(`Policy: continueOnError=${Boolean(options.continueOnError)}, syncIndex=${options.noSync ? false : true}`);
    console.log('No tasks executed (--dry-run).\n');
    return 0;
  }

  // AC2: Initialize batch manifest
  const manifest = createBatchManifest({
    root: targetRoot,
    specs,
    options,
    config
  });

  console.log(`[sdw-orch batch] Initialized batch "${manifest.batchId}" with ${manifest.total} specification(s).`);
  console.log(`Policy: continueOnError=${manifest.policy.continueOnError}, syncIndex=${manifest.policy.syncIndex}`);

  return executeQueue(manifest, targetRoot, config, options, cmdRun);
}

function resumeBatch(batchId, options, cmdRun) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const config = options._config || loadProjectConfig(targetRoot);

  const manifest = loadBatchManifest(targetRoot, batchId, config);
  if (!manifest) {
    const identifier = batchId ? `"${batchId}"` : 'latest';
    console.error(`Error: No batch manifest found to resume (${identifier}).`);
    return 1;
  }

  if (manifest.status === 'completed') {
    console.log(`[sdw-orch batch] Batch "${manifest.batchId}" is already completed.`);
    printSummaryReport(manifest, options);
    return 0;
  }

  console.log(`[sdw-orch batch] Resuming batch "${manifest.batchId}" (${manifest.currentIndex + 1}/${manifest.total})...`);
  manifest.status = 'in_progress';
  saveBatchManifest(targetRoot, manifest, config);

  return executeQueue(manifest, targetRoot, config, options, cmdRun);
}

module.exports = {
  createBatchManifest,
  loadBatchManifest,
  saveBatchManifest,
  listBatchManifests,
  validateBatchSpecs,
  runBatch,
  resumeBatch,
  printSummaryReport,
  resolveSpec,
  inferSlug
};
