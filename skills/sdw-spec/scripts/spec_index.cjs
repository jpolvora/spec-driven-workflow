'use strict';

const fs = require('fs');
const path = require('path');
const { validateFile } = require('./validate_spec.cjs');

function resolvePaths(projectRoot) {
  let root = projectRoot ? path.resolve(projectRoot) : process.cwd();
  let specsDir = path.join(root, '.sdw', 'specs');
  let stateDir = path.join(root, '.sdw', 'state');

  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    if (sdwConfig && typeof sdwConfig.loadConfig === 'function') {
      const cfg = sdwConfig.loadConfig(root);
      if (cfg.specsDir) specsDir = cfg.specsDir;
      if (cfg.stateDir) stateDir = cfg.stateDir;
    }
  } catch (e) {
    const configFile = path.join(root, '.sdw', 'config.json');
    if (fs.existsSync(configFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const normRoot = root.replace(/\\/g, '/');
        if (raw.specsDir) specsDir = raw.specsDir.replace(/\{projectRoot\}/g, normRoot);
        if (raw.stateDir) stateDir = raw.stateDir.replace(/\{projectRoot\}/g, normRoot);
      } catch (err) {}
    }
  }

  return {
    root,
    specsDir: path.resolve(specsDir),
    stateDir: path.resolve(stateDir),
    indexPath: path.join(path.resolve(specsDir), 'index.specs.md')
  };
}

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};
  const values = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (item) {
      let val = item[2].trim().replace(/^['"]|['"]$/g, '');
      if (val === 'null') val = null;
      values[item[1]] = val;
    }
  }
  return values;
}

function readIndex(options = {}) {
  const { indexPath, specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(indexPath)) {
    return {
      exists: false,
      indexPath,
      entries: []
    };
  }

  const content = fs.readFileSync(indexPath, 'utf8');
  const lines = content.split('\n');
  const entries = [];

  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('| Prefix |') || trimmed.startsWith('|Prefix|')) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!trimmed.startsWith('|')) {
        if (trimmed) inTable = false;
        continue;
      }
      if (/^\|[\s:-]+\|$/.test(trimmed) || trimmed.includes('---')) {
        continue;
      }
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length >= 6) {
        entries.push({
          prefix: cells[0] || '',
          slug: cells[1] || '',
          title: cells[2] || '',
          status: cells[3] || 'pending',
          source: cells[4] || 'local',
          specDate: cells[5] || '',
          validation: cells[6] || 'PASS',
          archivalDate: cells[7] || null
        });
      }
    }
  }

  return {
    exists: true,
    indexPath,
    entries
  };
}

function writeIndex(entries, options = {}) {
  const { indexPath, specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
  }

  // Sort entries deterministically by prefix
  entries.sort((a, b) => {
    const numA = parseInt(a.prefix, 10) || 0;
    const numB = parseInt(b.prefix, 10) || 0;
    return numA - numB;
  });

  let md = `# Specification Index\n\n`;
  md += `Central repository index tracking specification lifecycle states, metadata, and validation health.\n\n`;
  md += `## Status Definitions\n\n`;
  md += `- \`pending\`: Specification is authored and awaiting execution or currently in progress.\n`;
  md += `- \`completed\`: Implementation, verification, and pull request preparation are complete.\n`;
  md += `- \`archived\`: Specification lifecycle is finished and retired from active development.\n\n`;
  md += `## Specifications\n\n`;
  md += `| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;

  for (const e of entries) {
    const prefix = e.prefix || '';
    const slug = e.slug || '';
    const title = (e.title || '').replace(/\|/g, '\\|');
    const status = e.status || 'pending';
    const source = e.source || 'local';
    const specDate = e.specDate || '';
    const validation = e.validation || 'PASS';
    const archival = e.archivalDate || '-';
    md += `| ${prefix} | ${slug} | ${title} | ${status} | ${source} | ${specDate} | ${validation} | ${archival} |\n`;
  }

  fs.writeFileSync(indexPath, md, 'utf8');
  return entries;
}

function scanSpecsDir(options = {}) {
  const { specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(specsDir)) {
    return [];
  }

  // Spec 00054 writes `{slug}-report.md` companions beside the specification;
  // they are delivery artifacts, never registry entries.
  const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.md') && f !== 'index.specs.md' && !/-report\.md$/.test(f));
  const detected = [];

  for (const f of files) {
    const fullPath = path.join(specsDir, f);
    const content = fs.readFileSync(fullPath, 'utf8');
    const fm = parseFrontmatter(content);
    const prefixMatch = f.match(/^(\d{5})-/);
    const prefix = prefixMatch ? prefixMatch[1] : (fm.slug && fm.slug.match(/^(\d{5})-/) ? fm.slug.match(/^(\d{5})-/)[1] : '');
    const slug = fm.slug || path.basename(f, '.md');
    const title = fm.title || slug;
    const source = fm.source || 'local';
    const specDate = fm.specDate || '';

    let validation = 'PASS';
    try {
      const v = validateFile(fullPath, { mode: 'authoring' });
      validation = v.ok ? 'PASS' : 'FAIL';
    } catch (e) {
      validation = 'FAIL';
    }

    detected.push({
      prefix,
      slug,
      title,
      status: 'pending',
      source,
      specDate,
      validation,
      archivalDate: null,
      filename: f
    });
  }

  return detected;
}

function initIndex(options = {}) {
  const { indexPath } = resolvePaths(options.root);

  if (fs.existsSync(indexPath) && !options.force) {
    const existing = readIndex(options);
    if (existing.entries.length > 0) {
      throw new Error(`Specification index already exists at ${indexPath}. Preserving existing records. Use --force to overwrite.`);
    }
  }

  const detected = scanSpecsDir(options);
  writeIndex(detected, options);
  return detected;
}

function listIndex(options = {}) {
  const { exists, entries } = readIndex(options);
  let list = entries;

  if (!exists) {
    // If index.specs.md doesn't exist yet, scan directory directly
    list = scanSpecsDir(options);
  }

  if (options.status) {
    const targetStatus = String(options.status).toLowerCase().trim();
    list = list.filter(e => (e.status || '').toLowerCase() === targetStatus);
  }

  return list;
}

function archiveSpec(slugOrPrefix, options = {}) {
  const { exists, entries } = readIndex(options);
  if (!exists || entries.length === 0) {
    throw new Error('Specification index does not exist. Run "sdw-spec init" first.');
  }

  const target = String(slugOrPrefix).trim();
  const index = entries.findIndex(e => e.slug === target || e.prefix === target || target.includes(e.slug));

  if (index === -1) {
    throw new Error(`Specification "${slugOrPrefix}" not found in specification index.`);
  }

  const entry = entries[index];
  if (entry.status !== 'completed' && !options.force) {
    throw new Error(`Cannot archive specification "${entry.slug}" with status "${entry.status}". Only completed specifications can be archived. Use --force to override.`);
  }

  entry.status = 'archived';
  entry.archivalDate = new Date().toISOString().slice(0, 10);
  writeIndex(entries, options);
  return entry;
}

function updateSpecStatus(slugOrPrefix, newStatus, options = {}) {
  const { exists, entries } = readIndex(options);
  if (!exists) return null;

  const target = String(slugOrPrefix).trim();
  const entry = entries.find(e => e.slug === target || e.prefix === target || target.includes(e.slug));
  if (!entry) return null;

  entry.status = newStatus;
  if (options.validation) {
    entry.validation = options.validation;
  }
  writeIndex(entries, options);
  return entry;
}

function registerSpec(meta, options = {}) {
  const { entries } = readIndex(options);
  const existingIdx = entries.findIndex(e => e.slug === meta.slug || (meta.prefix && e.prefix === meta.prefix));

  if (existingIdx >= 0) {
    entries[existingIdx] = {
      ...entries[existingIdx],
      ...meta
    };
  } else {
    entries.push({
      prefix: meta.prefix || '',
      slug: meta.slug || '',
      title: meta.title || meta.slug || '',
      status: meta.status || 'pending',
      source: meta.source || 'local',
      specDate: meta.specDate || new Date().toISOString().slice(0, 10),
      validation: meta.validation || 'PASS',
      archivalDate: meta.archivalDate || null
    });
  }

  writeIndex(entries, options);
  return meta;
}

module.exports = {
  resolvePaths,
  readIndex,
  writeIndex,
  scanSpecsDir,
  initIndex,
  listIndex,
  archiveSpec,
  updateSpecStatus,
  registerSpec
};
