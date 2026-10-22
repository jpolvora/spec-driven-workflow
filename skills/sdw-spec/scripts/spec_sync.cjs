'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolvePaths,
  readIndex,
  writeIndex,
  scanSpecsDir,
  isSpecificationFile,
  specFileForSlug,
  readHeaderStatus,
  writeHeaderStatus,
  headerStatusAgrees,
  expectedHeaderStatus
} = require('./spec_index.cjs');
const { validateFile } = require('./validate_spec.cjs');

function loadRunStates(stateDir) {
  const statesBySlug = new Map();
  if (!fs.existsSync(stateDir)) {
    return statesBySlug;
  }

  const files = fs.readdirSync(stateDir).filter(f => f.endsWith('.state.json'));

  for (const f of files) {
    const fullPath = path.join(stateDir, f);
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const state = JSON.parse(raw);
      const slug = state.specSlug || (state.specPath ? path.basename(state.specPath, path.extname(state.specPath)) : null);

      if (slug) {
        const existing = statesBySlug.get(slug);
        const mtime = fs.statSync(fullPath).mtimeMs;
        if (!existing || mtime > existing.mtimeMs) {
          statesBySlug.set(slug, { state, mtimeMs: mtime, file: f });
        }
      }
    } catch (err) {
      // Gracefully handle corrupted state JSON files (Negative Scenario)
      console.warn(`[sdw-spec sync] Warning: Skipping corrupted or unreadable state file "${f}": ${err.message}`);
    }
  }

  return statesBySlug;
}

function syncIndex(options = {}) {
  const { root, indexPath, specsDir, stateDir } = resolvePaths(options.root);
  const dryRun = Boolean(options.dryRun || options['dry-run']);

  let existingData = readIndex(options);
  let entries = [...existingData.entries];

  // If index does not exist at all, bootstrap from disk
  if (!existingData.exists || entries.length === 0) {
    entries = scanSpecsDir(options);
  }

  const runStates = loadRunStates(stateDir);
  const onDiskSpecs = new Map();

  if (fs.existsSync(specsDir)) {
    const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.md') && f !== 'index.specs.md');
    for (const f of files) {
      const fullPath = path.join(specsDir, f);
      const baseSlug = path.basename(f, '.md');
      onDiskSpecs.set(baseSlug, { file: f, fullPath });
    }
  }

  const transitions = [];
  const trackedSlugs = new Set();

  // 1. Reconcile existing tracked index entries
  for (const entry of entries) {
    trackedSlugs.add(entry.slug);
    const diskInfo = onDiskSpecs.get(entry.slug);

    // Check disk existence (AC22)
    if (!diskInfo) {
      if (entry.validation !== 'MISSING') {
        transitions.push({
          slug: entry.slug,
          field: 'validation',
          from: entry.validation,
          to: 'MISSING',
          reason: 'Specification file not found on disk'
        });
        entry.validation = 'MISSING';
      }
    } else {
      // Re-evaluate validation health
      try {
        const valRes = validateFile(diskInfo.fullPath, { mode: 'authoring' });
        const newHealth = valRes.ok ? 'PASS' : 'FAIL';
        if (entry.validation !== newHealth) {
          transitions.push({
            slug: entry.slug,
            field: 'validation',
            from: entry.validation,
            to: newHealth,
            reason: 'Re-evaluated specification health'
          });
          entry.validation = newHealth;
        }
      } catch (e) {
        entry.validation = 'FAIL';
      }
    }

    // Preserve archived specs (AC7, AC8)
    if (entry.status === 'archived') {
      continue;
    }

    // Check state files for execution & delivery evidence (AC19)
    // Match by exact slug or stripped slug
    const stateRecord = runStates.get(entry.slug) || 
      [...runStates.entries()].find(([k]) => entry.slug.includes(k) || k.includes(entry.slug))?.[1];

    if (stateRecord && stateRecord.state) {
      const st = stateRecord.state;
      const isCompleted = st.status === 'completed' || Boolean(st.deliveryCommit) || (st.steps && st.steps[8] && st.steps[8].status === 'completed');

      if (isCompleted && entry.status !== 'completed') {
        transitions.push({
          slug: entry.slug,
          field: 'status',
          from: entry.status,
          to: 'completed',
          reason: `Completed orchestrator state in ${stateRecord.file}`
        });
        entry.status = 'completed';
      } else if (st.status === 'in_progress' && entry.status !== 'pending' && entry.status !== 'completed') {
        transitions.push({
          slug: entry.slug,
          field: 'status',
          from: entry.status,
          to: 'pending',
          reason: `Active orchestrator run in ${stateRecord.file}`
        });
        entry.status = 'pending';
      }
    }
  }

  // 2. Discover untracked specification files in specsDir (AC20)
  for (const [diskSlug, diskInfo] of onDiskSpecs.entries()) {
    if (!trackedSlugs.has(diskSlug)) {
      const content = fs.readFileSync(diskInfo.fullPath, 'utf8');
      const prefixMatch = diskInfo.file.match(/^(\d{5})-/);
      const prefix = prefixMatch ? prefixMatch[1] : '';
      const titleMatch = content.match(/^#+\s+(?:Specification\s*[-—]\s*)?(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : diskSlug;
      const sourceMatch = content.match(/source:\s*([^\r\n]+)/);
      const source = sourceMatch ? sourceMatch[1].trim() : 'local';
      const dateMatch = content.match(/specDate:\s*([^\r\n]+)/);
      const specDate = dateMatch ? dateMatch[1].trim() : new Date().toISOString().slice(0, 10);

      let validation = 'PASS';
      try {
        const valRes = validateFile(diskInfo.fullPath, { mode: 'authoring' });
        validation = valRes.ok ? 'PASS' : 'FAIL';
      } catch (e) {
        validation = 'FAIL';
      }

      const newEntry = {
        prefix,
        slug: diskSlug,
        title,
        status: 'pending',
        source,
        specDate,
        validation,
        archivalDate: null
      };

      entries.push(newEntry);
      transitions.push({
        slug: diskSlug,
        field: 'entry',
        from: null,
        to: 'pending',
        reason: 'Untracked specification file discovered on disk'
      });
    }
  }

  // 3. Reconcile every specification header with its registry row (spec 00058
  // AC20/AC21). The registry owns lifecycle status, so a row recording a
  // delivery is authoritative: the header must say `implemented`. Every
  // disagreement is reported with the file, the registry value, and the header
  // value; one with a canonical header is repaired in the same pass, and one
  // without (a `pending` row that cannot say which authored status applies) is
  // reported as unresolved. `--dry-run` reports without writing.
  const headerDrift = [];
  for (const entry of entries) {
    if (!isSpecificationFile(`${entry.slug}.md`)) continue;
    const specFile = specFileForSlug(specsDir, entry.slug);
    if (!specFile) continue;
    const headerStatus = readHeaderStatus(fs.readFileSync(specFile, 'utf8'));
    if (headerStatusAgrees(entry.status, headerStatus)) continue;
    const drift = {
      slug: entry.slug,
      file: path.relative(root, specFile).replace(/\\/g, '/'),
      registryStatus: entry.status,
      headerStatus,
      expectedHeaderStatus: expectedHeaderStatus(entry.status),
      repaired: false
    };
    if (!dryRun && drift.expectedHeaderStatus) {
      drift.repaired = writeHeaderStatus(specFile, drift.expectedHeaderStatus) !== null;
      if (drift.repaired) {
        transitions.push({
          slug: entry.slug,
          field: 'headerStatus',
          from: headerStatus,
          to: drift.expectedHeaderStatus,
          file: drift.file,
          registryStatus: entry.status,
          reason: 'Specification header status reconciled from the registry'
        });
      }
    }
    headerDrift.push(drift);
  }

  // 4. Persist changes unless --dry-run is specified (AC21)
  if (!dryRun) {
    writeIndex(entries, options);
  }

  return {
    dryRun,
    totalEntries: entries.length,
    transitionsCount: transitions.length,
    transitions,
    headerDrift,
    headerDriftCount: headerDrift.length,
    unresolvedHeaderDrift: headerDrift.filter((drift) => !drift.repaired && !drift.expectedHeaderStatus),
    entries
  };
}

module.exports = {
  loadRunStates,
  syncIndex
};
