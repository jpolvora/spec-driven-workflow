'use strict';

const fs = require('fs');
const path = require('path');
const { resolvePaths, readIndex, writeIndex, scanSpecsDir, findSpecGroupFiles, specGroupKey, parseSpecFilename } = require('./spec_index.cjs');
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
  const { indexPath, specsDir, stateDir } = resolvePaths(options.root);
  const dryRun = Boolean(options.dryRun || options['dry-run']);

  let existingData = readIndex(options);
  let entries = [...existingData.entries];

  // If index does not exist at all, bootstrap from disk
  if (!existingData.exists || entries.length === 0) {
    entries = scanSpecsDir(options);
  }

  const runStates = loadRunStates(stateDir);

  const transitions = [];
  const trackedSlugs = new Set();

  // Group all on-disk files (originals + vNN revisions) so history files
  // never gain their own index row: the row always points at the latest.
  const diskGroups = new Map();
  if (fs.existsSync(specsDir)) {
    const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.md') && f !== 'index.specs.md');
    for (const f of files) {
      const parsed = parseSpecFilename(f);
      const key = parsed ? specGroupKey(parsed) : `raw:${f}`;
      if (!diskGroups.has(key)) diskGroups.set(key, []);
      diskGroups.get(key).push({ file: f, parsed });
    }
    for (const members of diskGroups.values()) {
      members.sort((a, b) => (a.parsed ? a.parsed.version : 0) - (b.parsed ? b.parsed.version : 0));
    }
  }
  const groupLatest = (entry) => {
    const group = findSpecGroupFiles(specsDir, entry.slug) || findSpecGroupFiles(specsDir, entry.prefix);
    if (!group || group.files.length === 0) return null;
    return group.files[group.files.length - 1];
  };

  // 1. Reconcile existing tracked index entries
  for (const entry of entries) {
    trackedSlugs.add(entry.slug);
    const eParsed = parseSpecFilename(`${entry.slug || ''}.md`);
    if (eParsed) trackedSlugs.add(specGroupKey(eParsed));
    if (entry.prefix) trackedSlugs.add(entry.prefix);
    const latest = groupLatest(entry);
    const diskInfo = latest ? { file: latest.filename, fullPath: latest.fullPath } : null;

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
      // Repoint a tracked row at the newest on-disk revision of its group.
      if (latest.slug !== entry.slug) {
        transitions.push({
          slug: entry.slug,
          field: 'slug',
          from: entry.slug,
          to: latest.slug,
          reason: `Newer versioned revision on disk (${latest.filename})`
        });
        entry.slug = latest.slug;
      }
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

  // 2. Discover untracked specification files in specsDir (AC20).
  // One row per version group, always pointing at the latest revision;
  // older revisions on disk are history and gain no row of their own.
  for (const [groupKey, members] of diskGroups.entries()) {
    const latestMember = members[members.length - 1];
    const latestSlug = latestMember.parsed ? latestMember.parsed.slug : latestMember.file.replace(/\.md$/, '');
    const tracked = trackedSlugs.has(latestSlug) || trackedSlugs.has(groupKey) ||
      members.some(m => trackedSlugs.has(m.parsed ? m.parsed.slug : m.file.replace(/\.md$/, '')));
    if (!tracked) {
      const latestPath = path.join(specsDir, latestMember.file);
      const content = fs.readFileSync(latestPath, 'utf8');
      const prefixMatch = latestMember.file.match(/^(\d{5})-/);
      const prefix = prefixMatch ? prefixMatch[1] : '';
      const titleMatch = content.match(/^#+\s+(?:Specification\s*[-—]\s*)?(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : latestSlug;
      const sourceMatch = content.match(/source:\s*([^\r\n]+)/);
      const source = sourceMatch ? sourceMatch[1].trim() : 'local';
      const dateMatch = content.match(/specDate:\s*([^\r\n]+)/);
      const specDate = dateMatch ? dateMatch[1].trim() : new Date().toISOString().slice(0, 10);

      let validation = 'PASS';
      try {
        const valRes = validateFile(latestPath, { mode: 'authoring' });
        validation = valRes.ok ? 'PASS' : 'FAIL';
      } catch (e) {
        validation = 'FAIL';
      }

      const newEntry = {
        prefix,
        slug: latestSlug,
        title,
        status: 'pending',
        source,
        specDate,
        validation,
        archivalDate: null
      };

      entries.push(newEntry);
      transitions.push({
        slug: latestSlug,
        field: 'entry',
        from: null,
        to: 'pending',
        reason: 'Untracked specification file discovered on disk'
      });
    }
  }

  // 3. Persist changes unless --dry-run is specified (AC21)
  if (!dryRun) {
    writeIndex(entries, options);
  }

  return {
    dryRun,
    totalEntries: entries.length,
    transitionsCount: transitions.length,
    transitions,
    entries
  };
}

module.exports = {
  loadRunStates,
  syncIndex
};
