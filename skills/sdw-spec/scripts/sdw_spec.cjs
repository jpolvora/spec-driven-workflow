#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initIndex, listIndex, archiveSpec, resolvePaths, readIndex, parseFrontmatter, readDeclaredFields, isSpecificationFile } = require('./spec_index.cjs');
const { createNewSpec, importRemoteSpec } = require('./spec_creator.cjs');
const { syncIndex } = require('./spec_sync.cjs');
const { runSyncDirection } = require('./spec_sync_remote.cjs');
const { validateFile, SPEC_STATUSES, PRIORITY_VALUES, EFFORT_VALUES } = require('./validate_spec.cjs');

const SPEC_STATUS_TRANSITIONS = {
  draft: ['awaiting-approval', 'abandoned'],
  'awaiting-approval': ['ready-to-implement', 'draft', 'abandoned'],
  'ready-to-implement': ['implemented', 'awaiting-approval', 'abandoned'],
  implemented: [],
  abandoned: ['draft']
};

function parseArgs(args) {
  const result = {
    subcommand: null,
    target: null,
    root: null,
    status: null,
    provider: null,
    id: null,
    title: null,
    slug: null,
    from: null,
    limit: null,
    apply: false,
    force: false,
    json: false,
    dryRun: false,
    collisions: false,
    mode: 'authoring'
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--force') result.force = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--root') result.root = args[++i];
    else if (arg.startsWith('--root=')) result.root = arg.slice(7);
    else if (arg === '--status') result.status = args[++i];
    else if (arg.startsWith('--status=')) result.status = arg.slice(9);
    else if (arg === '--provider') result.provider = args[++i];
    else if (arg.startsWith('--provider=')) result.provider = arg.slice(11);
    else if (arg === '--id') result.id = args[++i];
    else if (arg.startsWith('--id=')) result.id = arg.slice(5);
    else if (arg === '--title') result.title = args[++i];
    else if (arg.startsWith('--title=')) result.title = arg.slice(8);
    else if (arg === '--slug') result.slug = args[++i];
    else if (arg.startsWith('--slug=')) result.slug = arg.slice(7);
    else if (arg === '--from') result.from = args[++i] || null;
    else if (arg.startsWith('--from=')) result.from = arg.slice(7) || null;
    else if (arg === '--limit') result.limit = args[++i];
    else if (arg.startsWith('--limit=')) result.limit = arg.slice(8);
    else if (arg === '--collisions') result.collisions = true;
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--mode') result.mode = args[++i];
    else if (arg.startsWith('--mode=')) result.mode = arg.slice(7);
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  result.subcommand = positional[0] || null;
  result.target = positional.slice(1).join(' ') || null;
  return result;
}

function showHelp() {
  console.log(`Usage: node sdw_spec.cjs <subcommand> [args] [options]

Subcommands:
  init                     Bootstrap {specsDir}/index.specs.md with standard headers and inventory
  list                     Display registered specifications with status and validation health
  list-by-priority         Rank pending specifications by declared priority, readiness, and effort
  new <requirements>      Synthesize canonical specification with autoincremented numerical prefix
  import                   Import remote tracker item from GitHub or Azure DevOps
  sync                     Reconcile index.specs.md against on-disk files and orchestrator run states, report and repair header-status drift
  sync-up                  Mirror local specifications to the registered SCM provider
  sync-down                Mirror remote tracker items into local specifications
  validate <specPath>      Validate frontmatter, section hierarchy, and strict EARS syntax
  status <slug> <status>   Change the spec header status with defined transitions
  update                   Propose a drift entry from changed files named by the specification
  archive <slug>           Transition completed specification to archived in index.specs.md
  help                     Show this help documentation

Spec statuses:
  draft | awaiting-approval | ready-to-implement | implemented | abandoned

Options:
  --root <path>            Target project workspace root directory
  --status <status>        Filter specifications by status (pending, completed, archived)
  --provider <name>        SCM provider for import and sync (github, azure-devops)
  --id <id>                Work item or issue ID for remote import
  --title <title>          Explicit title for newly synthesized specification
  --slug <slug>            Specification slug ("new" and "update" subcommands)
  --from <commit>          Base commit for drift comparison in "update" (default: HEAD)
  --limit <n>              Cap list-by-priority rows at n; the totals keep every pending specification
  --collisions             Report pending specifications that name the same skills/ path
  --apply                  Write the proposed drift insertion into the specification
  --mode <mode>            Validation mode (authoring | compat, default: authoring)
  --force                  Force overwrite or allow archiving incomplete specifications
  --dry-run                Print planned synchronization transitions without contacting the provider
  --json                   Output responses in structured JSON format
  -h, --help               Show help message
`);
}

async function cmdInit(options) {
  try {
    const entries = initIndex(options);
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', initialized: true, count: entries.length, entries }, null, 2));
    } else {
      console.log(`[sdw-spec init] Successfully bootstrapped specification index with ${entries.length} detected specification(s).`);
      entries.forEach(e => {
        console.log(`  + [${e.prefix}] ${e.slug} (${e.status.toUpperCase()}) - ${e.validation}`);
      });
    }
    return 0;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[sdw-spec init] Error: ${err.message}`);
    }
    return 1;
  }
}

function cmdList(options) {
  try {
    const list = listIndex(options);
    if (options.json) {
      console.log(JSON.stringify(list, null, 2));
    } else {
      console.log(`[sdw-spec list] Registered specifications (${list.length}${options.status ? ` filtered by status="${options.status}"` : ''}):\n`);
      if (list.length === 0) {
        console.log('  (no specifications found matching query)');
      } else {
        const pPad = Math.max(6, ...list.map(l => (l.prefix || '').length));
        const sPad = Math.max(10, ...list.map(l => (l.slug || '').length));
        const stPad = 11;
        const vPad = 8;
        console.log(`${'PREFIX'.padEnd(pPad)} | ${'SLUG'.padEnd(sPad)} | ${'STATUS'.padEnd(stPad)} | ${'HEALTH'.padEnd(vPad)} | TITLE`);
        console.log(`${'-'.repeat(pPad)}-|-|${'-'.repeat(sPad)}-|-|${'-'.repeat(stPad)}-|-|${'-'.repeat(vPad)}-|-${'-'.repeat(30)}`);
        for (const item of list) {
          const pref = (item.prefix || '').padEnd(pPad);
          const slug = (item.slug || '').padEnd(sPad);
          const stat = (item.status || 'pending').padEnd(stPad);
          const val = (item.validation || 'PASS').padEnd(vPad);
          console.log(`${pref} | ${slug} | ${stat} | ${val} | ${item.title}`);
        }
      }
    }
    return 0;
  } catch (err) {
    console.error(`[sdw-spec list] Error: ${err.message}`);
    return 1;
  }
}

// Spec 00055: ranking is a deterministic projection over declared frontmatter and
// registry state. It infers nothing, reads no clock, and writes no file.
const DEFAULT_PRIORITY = 'medium';
const READINESS_VALUES = ['ready-to-implement', 'draft', 'awaiting-approval'];

function compareText(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function rankIndex(values, value) {
  const index = values.indexOf(value);
  return index === -1 ? values.length : index;
}

function registeredSpecPath(specsDir, entry) {
  if (entry.slug) {
    const direct = path.join(specsDir, `${entry.slug}.md`);
    if (fs.existsSync(direct)) return direct;
  }
  if (entry.prefix && fs.existsSync(specsDir)) {
    // 00054 companions (`{slug}-report.md`) are delivery artifacts, never specifications.
    const match = fs
      .readdirSync(specsDir)
      .sort(compareText)
      .find((name) => name.startsWith(`${entry.prefix}-`) && name.endsWith('.md') && !/-report\.md$/.test(name));
    if (match) return path.join(specsDir, match);
  }
  return null;
}

function countAcceptanceCriteria(content) {
  return (String(content || '').match(/^- AC[1-9][0-9]*:/gm) || []).length;
}

function resolveBlockedEntry(entries, token) {
  return entries.find((entry) => entry.prefix === token || entry.slug === token) || null;
}

function declaredRowsFor(specsDir, entries) {
  return entries
    .map((entry) => {
      const specPath = registeredSpecPath(specsDir, entry);
      const content = specPath ? fs.readFileSync(specPath, 'utf8') : '';
      return {
        entry,
        declared: specPath
          ? readDeclaredFields(specPath)
          : { priority: null, value: '', effort: null, blockedBy: [] },
        readiness: specPath ? parseFrontmatter(content.replace(/\r\n?/g, '\n')).status || '' : '',
        acCount: countAcceptanceCriteria(content)
      };
    })
    .sort((a, b) => compareText(a.entry.prefix, b.entry.prefix));
}

function buildPriorityRanking(options = {}) {
  const { specsDir } = resolvePaths(options.root);
  const registry = readIndex({ root: options.root });
  const allEntries = registry.exists ? registry.entries : [];
  const pendingEntries = allEntries.filter((entry) => String(entry.status || '').toLowerCase() === 'pending');
  const declaredRows = declaredRowsFor(specsDir, pendingEntries);

  // AC9: an out-of-enum value makes the ranking meaningless, so nothing is printed.
  for (const row of declaredRows) {
    const { priority, effort } = row.declared;
    if (priority !== null && !PRIORITY_VALUES.includes(priority)) {
      throw new Error(`Invalid priority "${priority}" in specification ${row.entry.slug}; expected ${PRIORITY_VALUES.join(', ')}.`);
    }
    if (effort !== null && !EFFORT_VALUES.includes(effort)) {
      throw new Error(`Invalid effort "${effort}" in specification ${row.entry.slug}; expected ${EFFORT_VALUES.join(', ')}.`);
    }
  }

  // AC8: a blocker that resolves to no registered specification is an error, not a
  // silent pass; AC7 marks a row blocked only while its dependency stays pending.
  for (const row of declaredRows) {
    const unresolved = row.declared.blockedBy.find((token) => !resolveBlockedEntry(allEntries, token));
    if (unresolved !== undefined) {
      throw new Error(`Unresolved blockedBy entry "${unresolved}" in specification ${row.entry.slug}; no registered specification matches that prefix or slug.`);
    }
  }

  const items = declaredRows.map((row) => {
    const entry = row.entry;
    const blocked = row.declared.blockedBy.some((token) => {
      const dependency = resolveBlockedEntry(allEntries, token);
      return dependency !== null && String(dependency.status || '').toLowerCase() === 'pending';
    });
    return {
      rank: 0,
      prefix: entry.prefix || '',
      slug: entry.slug || '',
      title: entry.title || '',
      priority: row.declared.priority || DEFAULT_PRIORITY,
      effort: row.declared.effort,
      acCount: row.acCount,
      readiness: row.readiness,
      registryStatus: entry.status || 'pending',
      blockedBy: row.declared.blockedBy,
      blocked,
      value: row.declared.value,
      specDate: entry.specDate || ''
    };
  });

  items.sort(
    (a, b) =>
      rankIndex(PRIORITY_VALUES, a.priority) - rankIndex(PRIORITY_VALUES, b.priority) ||
      Number(a.blocked) - Number(b.blocked) ||
      rankIndex(READINESS_VALUES, a.readiness) - rankIndex(READINESS_VALUES, b.readiness) ||
      rankIndex(EFFORT_VALUES, a.effort) - rankIndex(EFFORT_VALUES, b.effort) ||
      compareText(a.specDate, b.specDate) ||
      compareText(a.prefix, b.prefix)
  );
  items.forEach((item, index) => {
    item.rank = index + 1;
  });

  return {
    counts: {
      pending: items.length,
      high: items.filter((item) => item.priority === 'high').length,
      medium: items.filter((item) => item.priority === 'medium').length,
      low: items.filter((item) => item.priority === 'low').length,
      blocked: items.filter((item) => item.blocked).length
    },
    items
  };
}

function blockedByLabel(item) {
  if (item.blockedBy.length === 0) return '-';
  const entries = item.blockedBy.join(', ');
  return item.blocked ? `blocked: ${entries}` : entries;
}

// AC11: `--limit` caps printed rows only; counts are computed before the slice.
function limitedItems(items, limit) {
  return limit === null ? items : items.slice(0, limit);
}

// AC12: a limit that is not a positive integer is a usage error, never a silent default.
function parseLimitOption(limit) {
  if (limit === null) return null;
  const raw = limit === undefined ? '' : String(limit).trim();
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`Invalid --limit value "${raw || '(missing)'}"; expected a positive integer.`);
  }
  return Number(raw);
}

function renderPriorityTable(ranking, limit = null) {
  const headers = ['RANK', 'PREFIX', 'PRIORITY', 'EFFORT', 'AC', 'READINESS', 'BLOCKED BY', 'VALUE'];
  const rows = limitedItems(ranking.items, limit).map((item) => [
    String(item.rank),
    item.prefix || '-',
    item.priority,
    item.effort || '-',
    String(item.acCount),
    item.readiness || '-',
    blockedByLabel(item),
    item.value || '-'
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const formatRow = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ').trimEnd();

  const lines = [`[sdw-spec list-by-priority] Ranked pending specifications (${ranking.counts.pending}):`, ''];
  lines.push(formatRow(headers));
  lines.push(widths.map((width) => '-'.repeat(width)).join('-|-'));
  rows.forEach((row) => lines.push(formatRow(row)));
  lines.push(
    `Totals: ${ranking.counts.pending} pending | ${ranking.counts.high} high | ${ranking.counts.medium} medium | ${ranking.counts.low} low | ${ranking.counts.blocked} blocked`
  );
  return lines.join('\n');
}

// AC13: the machine-readable projection carries no clock-derived field, so two runs
// over unchanged inputs serialize identically.
function renderPriorityJson(ranking, limit = null) {
  return JSON.stringify({ counts: ranking.counts, items: limitedItems(ranking.items, limit) }, null, 2);
}

// AC14: a collision surface is a `skills/` path token in the specification body.
// Wildcard tokens carry `*`, name no concrete surface, and are ignored.
const COLLISION_TOKEN = /skills\/[A-Za-z0-9_./*{}-]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

function collisionTokens(content) {
  const body = String(content || '').replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
  const tokens = new Set();
  for (const match of body.matchAll(COLLISION_TOKEN)) {
    const token = match[0].replace(TRAILING_PUNCTUATION, '');
    if (token.includes('*') || token.length <= 'skills/'.length) continue;
    tokens.add(token);
  }
  return [...tokens].sort(compareText);
}

function collectCollisions(options = {}) {
  const { specsDir } = resolvePaths(options.root);
  const registry = readIndex({ root: options.root });
  const surfaces = (registry.exists ? registry.entries : [])
    .filter((entry) => String(entry.status || '').toLowerCase() === 'pending')
    .sort((left, right) => compareText(left.prefix, right.prefix))
    .map((entry) => {
      const specPath = registeredSpecPath(specsDir, entry);
      return {
        prefix: entry.prefix || '',
        tokens: specPath ? collisionTokens(fs.readFileSync(specPath, 'utf8')) : []
      };
    });

  const pairs = [];
  for (let left = 0; left < surfaces.length; left += 1) {
    for (let right = left + 1; right < surfaces.length; right += 1) {
      const shared = surfaces[left].tokens.filter((token) => surfaces[right].tokens.includes(token));
      if (shared.length === 0) continue;
      pairs.push({ left: surfaces[left].prefix, right: surfaces[right].prefix, shared });
    }
  }

  // AC14: most shared surfaces first, then the left and right prefix ascending.
  pairs.sort(
    (a, b) => b.shared.length - a.shared.length || compareText(a.left, b.left) || compareText(a.right, b.right)
  );
  return pairs;
}

function renderCollisions(pairs) {
  if (pairs.length === 0) return 'No surface collisions among pending specifications.';
  const lines = [`[sdw-spec list-by-priority] Surface collisions among pending specifications (${pairs.length} pairs):`];
  for (const pair of pairs) {
    lines.push('');
    lines.push(`${pair.left} <-> ${pair.right} (${pair.shared.length} shared path${pair.shared.length === 1 ? '' : 's'})`);
    for (const token of pair.shared) lines.push(`  ${token}`);
  }
  return lines.join('\n');
}

function cmdListByPriority(options) {
  try {
    const limit = parseLimitOption(options.limit);
    // AC9/AC8 preconditions gate every invocation, including --collisions and --json.
    const ranking = buildPriorityRanking(options);
    if (options.collisions) {
      console.log(renderCollisions(collectCollisions(options)));
      return 0;
    }
    console.log(options.json ? renderPriorityJson(ranking, limit) : renderPriorityTable(ranking, limit));
    return 0;
  } catch (err) {
    console.error(`[sdw-spec list-by-priority] Error: ${err.message}`);
    return 1;
  }
}

function cmdNew(options) {
  try {
    const text = options.target;
    if (!text) {
      console.error('Error: free-text requirements input is required for "new" subcommand.');
      return 1;
    }

    const created = createNewSpec(text, options);
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', ...created }, null, 2));
    } else {
      console.log(`[sdw-spec new] Successfully created canonical specification "${created.slug}":`);
      console.log(`  File:   ${created.filePath}`);
      console.log(`  Prefix: ${created.prefix}`);
      console.log(`  Title:  ${created.title}`);
      console.log(`  Status: draft (registered as pending in index.specs.md)`);
    }
    return 0;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[sdw-spec new] Error: ${err.message}`);
    }
    return 1;
  }
}

async function cmdImport(options) {
  try {
    const imported = await importRemoteSpec(options);
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', ...imported }, null, 2));
    } else {
      console.log(`[sdw-spec import] Successfully imported remote item #${imported.item.id} (${imported.item.source}):`);
      console.log(`  File:   ${imported.filePath}`);
      console.log(`  Prefix: ${imported.prefix}`);
      console.log(`  Slug:   ${imported.slug}`);
      console.log(`  Title:  ${imported.title}`);
      console.log(`  Status: draft (registered as pending in index.specs.md)`);
    }
    return 0;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[sdw-spec import] ${err.message}`);
    }
    return 1;
  }
}

function cmdSync(options) {
  try {
    const report = syncIndex(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const modeLabel = report.dryRun ? ' [DRY-RUN]' : '';
      console.log(`[sdw-spec sync${modeLabel}] Reconciled ${report.totalEntries} specification(s) with ${report.transitionsCount} transition(s):`);
      if (report.transitions.length === 0) {
        console.log('  (all specification statuses and index entries are up to date)');
      } else {
        report.transitions.forEach(t => {
          console.log(`  * [${t.slug}] ${t.field}: "${t.from || 'none'}" -> "${t.to}" (${t.reason})`);
        });
      }
      // Spec 00060 AC4: discovery reports how many delivery report files it
      // excluded, so an operator can see the exclusion instead of guessing.
      if (report.excludedCount > 0) {
        console.log(`  Excluded ${report.excludedCount} delivery report file(s): ${report.excludedFiles.join(', ')}`);
      }
      // Spec 00058 AC20: every registry row whose header disagrees is named with
      // its file, its registry value, and its header value.
      if (report.headerDriftCount === 0) {
        console.log('  Header drift (registry vs specification header): none');
      } else {
        console.log(`  Header drift (registry vs specification header): ${report.headerDriftCount} disagreement(s)`);
        report.headerDrift.forEach(d => {
          const action = d.repaired
            ? `repaired -> ${d.expectedHeaderStatus}`
            : d.expectedHeaderStatus
              ? `would repair -> ${d.expectedHeaderStatus} (--dry-run)`
              : 'unresolved (the registry row authorizes no single header status)';
          console.log(`  ! ${d.file}: registry "${d.registryStatus}" vs header "${d.headerStatus || 'none'}" (${action})`);
        });
      }
    }
    return 0;
  } catch (err) {
    console.error(`[sdw-spec sync] Error: ${err.message}`);
    return 1;
  }
}

function cmdValidate(options) {
  if (!options.target) {
    console.error('Error: target specification path is required for "validate" subcommand.');
    return 1;
  }

  const { root, specsDir } = resolvePaths(options.root);
  let targetPath = path.resolve(root, options.target);
  if (!fs.existsSync(targetPath)) {
    const inSpecs = path.resolve(specsDir, options.target);
    if (fs.existsSync(inSpecs)) {
      targetPath = inSpecs;
    } else if (fs.existsSync(inSpecs + '.md')) {
      targetPath = inSpecs + '.md';
    }
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Specification file not found: ${targetPath}`);
    return 1;
  }

  try {
    const result = validateFile(targetPath, { mode: options.mode });
    if (options.json) {
      console.log(JSON.stringify({ file: targetPath.replace(/\\/g, '/'), ...result }, null, 2));
    } else {
      for (const warning of result.warnings) {
        console.warn(`WARN: ${warning.message}`);
      }
      for (const error of result.errors) {
        console.error(`ERROR: ${error.ac ? `${error.ac}: ` : ''}${error.message}`);
      }
      if (result.ok) {
        console.log(`PASS: ${path.basename(targetPath)} (${result.acceptanceCriteria.length} ACs)`);
      }
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return 1;
  }
}

function cmdArchive(options) {
  if (!options.target) {
    console.error('Error: specification slug or prefix is required for "archive" subcommand.');
    return 1;
  }

  try {
    const archived = archiveSpec(options.target, options);
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', archived }, null, 2));
    } else {
      console.log(`[sdw-spec archive] Specification "${archived.slug}" successfully marked archived.`);
      console.log(`  Archival Date: ${archived.archivalDate}`);
    }
    return 0;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[sdw-spec archive] Error: ${err.message}`);
    }
    return 1;
  }
}

function findSpecFile(specsDir, key) {
  const direct = path.join(specsDir, `${key}.md`);
  // Spec 00060 AC5: a key resolves to a specification file and never to a
  // delivery report companion, wherever that companion sits.
  if (isSpecificationFile(`${key}.md`) && fs.existsSync(direct)) return direct;
  if (!fs.existsSync(specsDir)) return null;
  const files = fs.readdirSync(specsDir).filter(name => isSpecificationFile(name) && /^\d{5}-.*\.md$/.test(name));
  const match = files.find(name => {
    const base = name.replace(/\.md$/, '');
    return base === key || base.startsWith(`${key}-`) || base.includes(key);
  });
  return match ? path.join(specsDir, match) : null;
}

function cmdStatus(options) {
  const parts = String(options.target || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    console.error('Error: usage is "status <slug> <status>".');
    console.error(`  Allowed statuses: ${SPEC_STATUSES.join(', ')}`);
    return 1;
  }
  const [key, nextStatus] = parts;
  if (!SPEC_STATUSES.includes(nextStatus)) {
    console.error(`Error: unknown status "${nextStatus}". Allowed: ${SPEC_STATUSES.join(', ')}.`);
    return 1;
  }

  const { root, specsDir } = resolvePaths(options.root);
  const specFile = findSpecFile(specsDir, key);
  if (!specFile) {
    console.error(`Error: specification not found for "${key}" under ${specsDir}.`);
    return 1;
  }

  const content = fs.readFileSync(specFile, 'utf8');
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) {
    console.error(`Error: ${path.basename(specFile)} has no YAML frontmatter.`);
    return 1;
  }

  const currentMatch = fmMatch[1].match(/^status:\s*(.*)$/m);
  const currentStatus = currentMatch ? currentMatch[1].trim() : null;
  if (currentStatus === nextStatus) {
    console.log(`[sdw-spec status] ${path.basename(specFile)} is already ${nextStatus}.`);
    return 0;
  }

  const allowed = currentStatus ? (SPEC_STATUS_TRANSITIONS[currentStatus] || []) : SPEC_STATUSES;
  if (!options.force && currentStatus && !allowed.includes(nextStatus)) {
    console.error(`[sdw-spec status] Refused: ${currentStatus} -> ${nextStatus} is not a defined transition.`);
    console.error(`  Allowed from ${currentStatus}: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}. Use --force to override.`);
    return 1;
  }

  const nextBlock = currentMatch
    ? fmMatch[1].replace(/^status:\s*.*$/m, `status: ${nextStatus}`)
    : fmMatch[1].replace(/^(source:\s*.*)$/m, `$1\nstatus: ${nextStatus}`);
  const updated = content.replace(fmMatch[0], `---\n${nextBlock}\n---\n`);
  fs.writeFileSync(specFile, updated, 'utf8');

  const rel = path.relative(root, specFile).replace(/\\/g, '/');
  if (options.json) {
    console.log(JSON.stringify({ status: 'ok', file: rel, from: currentStatus, to: nextStatus }, null, 2));
  } else {
    console.log(`[sdw-spec status] ${rel}: ${currentStatus || '(none)'} -> ${nextStatus}`);
  }
  return 0;
}

// Drift repair (spec 00038) never rewrites history or lifecycle: it only proposes a
// Notes entry for files the specification already names.

const DRIFT_EXCLUDED_PREFIXES = ['.git/', '.sdw/state/', '.sdw/sandbox/', '.sdw/worktrees/'];

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

function resolveCommitRef(root, ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: root,
    encoding: 'utf8'
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function normalizeProjectPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function isDriftExcluded(relPath) {
  return DRIFT_EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

// AC2, AC3, AC4: tracked working-tree and index changes against <base>, plus untracked
// non-ignored files, minus ephemeral run-state, sandbox, worktree, and .git paths.
function collectDriftFiles(root, baseRef) {
  const changed = new Set();

  // -z keeps non-ASCII, quoted, and backslash paths unquoted; --no-renames makes
  // the output strict status/path pairs, so a rename is a delete plus an add and
  // both paths stay in the drift set. --relative makes diff paths relative to
  // the project root, matching `ls-files --others` when the root sits below the
  // git top level.
  const tracked = runGit(root, ['diff', '--name-status', '--no-renames', '--relative', '-z', baseRef, '--', '.']);
  const fields = tracked.split('\0').filter((field) => field !== '');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const relPath = fields[i + 1].trim();
    if (relPath) changed.add(normalizeProjectPath(relPath));
  }

  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const field of untracked.split('\0')) {
    if (field.trim()) changed.add(normalizeProjectPath(field.trim()));
  }

  return [...changed].filter((relPath) => relPath && !isDriftExcluded(relPath)).sort();
}

// AC5: only an exact project-relative path mention makes a file in scope. A
// trailing period that ends a sentence is not part of the path, while a period
// followed by a word character continues a longer filename and stays rejected.
// An optional `./` prefix is accepted, because the changed-path side strips it
// through normalizeProjectPath and both sides must normalize alike.
function specMentionsPath(specContent, relPath) {
  const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.\\/-])(?:\\.\\/)?${escaped}(?![A-Za-z0-9_\\/-]|\\.\\w)`).test(specContent);
}

function driftTimestamp(now) {
  const date = now instanceof Date ? now : new Date();
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function driftRevisionLine(matchedFiles) {
  return `${matchedFiles.length} changed file(s) named by this specification: ${matchedFiles.join(', ')}`;
}

function buildDriftInsertion(matchedFiles, baseLabel, timestamp) {
  const lines = [`### Drift Update (${timestamp}; base ${baseLabel})`];
  for (const relPath of matchedFiles) {
    lines.push(`- \`${relPath}\`: named by this specification and changed in the working set`);
  }
  lines.push(`- Revision: ${driftRevisionLine(matchedFiles)}`);
  return lines.join('\n');
}

// Inserts the reviewed block at the end of ## Notes; every other byte is preserved.
function appendDriftInsertion(specContent, insertion) {
  const notes = specContent.match(/^## Notes[ \t]*$/m);
  if (!notes) return null;

  const bodyStart = notes.index + notes[0].length;
  const rest = specContent.slice(bodyStart);
  const nextSection = rest.search(/^## /m);
  const insertAt = nextSection === -1 ? specContent.length : bodyStart + nextSection;
  const head = specContent.slice(0, insertAt);
  const tail = specContent.slice(insertAt);
  const separator = head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n';

  return tail
    ? `${head}${separator}${insertion}\n\n${tail}`
    : `${head}${separator}${insertion}\n`;
}

function cmdUpdate(options) {
  const slug = options.slug ? String(options.slug).trim() : '';
  if (!slug) {
    console.error('Error: --slug <slug> is required for "update" subcommand.');
    return 1;
  }

  const { root, specsDir } = resolvePaths(options.root);
  const specFile = findSpecFile(specsDir, slug);
  if (!specFile) {
    console.error(`Error: no specification file found for slug "${slug}" under ${specsDir.replace(/\\/g, '/')}.`);
    return 1;
  }

  const specContent = fs.readFileSync(specFile, 'utf8');
  if (!/^## Notes[ \t]*$/m.test(specContent)) {
    console.error(`Error: ${path.basename(specFile)} has no "## Notes" section; no drift entry can be proposed.`);
    return 1;
  }

  const baseLabel = options.from ? String(options.from) : 'HEAD';
  const baseCommit = resolveCommitRef(root, baseLabel);
  if (!baseCommit) {
    console.error(`Error: unresolved reference "${baseLabel}": it does not resolve to a commit.`);
    return 1;
  }

  let changedFiles;
  try {
    changedFiles = collectDriftFiles(root, baseCommit);
  } catch (err) {
    console.error(`[sdw-spec update] Error: ${err.message}`);
    return 1;
  }

  const matchedFiles = [];
  const unmatchedFiles = [];
  for (const relPath of changedFiles) {
    (specMentionsPath(specContent, relPath) ? matchedFiles : unmatchedFiles).push(relPath);
  }

  const specRelPath = path.relative(root, specFile).replace(/\\/g, '/');

  if (matchedFiles.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ slug, base: baseLabel, matchedFiles, unmatchedFiles, insertion: '', revisionLine: '' }, null, 2));
    } else {
      console.log('No specification drift found');
    }
    return 0;
  }

  const revisionLine = driftRevisionLine(matchedFiles);
  const insertion = buildDriftInsertion(matchedFiles, baseLabel, driftTimestamp(options.now));

  if (options.apply) {
    fs.writeFileSync(specFile, appendDriftInsertion(specContent, insertion), 'utf8');
    if (options.json) {
      console.log(JSON.stringify({ slug, base: baseLabel, matchedFiles, unmatchedFiles, insertion, revisionLine, applied: true, file: specRelPath }, null, 2));
    } else {
      console.log(`[sdw-spec update] Applied drift entry to ${specRelPath}.`);
      console.log(`  Base: ${baseLabel}`);
      console.log(`  Matched files: ${matchedFiles.length}`);
      console.log(`  Revision line: ${revisionLine}`);
    }
    return 0;
  }

  if (options.json) {
    console.log(JSON.stringify({ slug, base: baseLabel, matchedFiles, unmatchedFiles, insertion, revisionLine }, null, 2));
    return 0;
  }

  console.log(`[sdw-spec update] ${specRelPath} (base ${baseLabel})`);
  console.log(`Matched files (${matchedFiles.length}):`);
  matchedFiles.forEach((relPath) => console.log(`  - ${relPath}`));
  console.log(`Unmatched files (${unmatchedFiles.length}):`);
  unmatchedFiles.forEach((relPath) => console.log(`  - ${relPath}`));
  console.log('Proposed insertion:');
  console.log(insertion);
  console.log('');
  console.log(`Revision line: ${revisionLine}`);
  console.log('No files modified. Re-run with --apply to write this insertion.');
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.subcommand || options.subcommand === 'help' || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(args.includes('-h') || args.includes('--help') || options.subcommand === 'help' ? 0 : 1);
  }

  let code = 0;
  switch (options.subcommand) {
    case 'init':
      code = await cmdInit(options);
      break;
    case 'list':
      code = cmdList(options);
      break;
    case 'list-by-priority':
      code = cmdListByPriority(options);
      break;
    case 'new':
      code = cmdNew(options);
      break;
    case 'import':
      code = await cmdImport(options);
      break;
    case 'sync':
      code = cmdSync(options);
      break;
    case 'sync-up':
    case 'sync-down':
      code = await runSyncDirection(options.subcommand, options);
      break;
    case 'validate':
      code = cmdValidate(options);
      break;
    case 'archive':
      code = cmdArchive(options);
      break;
    case 'status':
      code = cmdStatus(options);
      break;
    case 'update':
      code = cmdUpdate(options);
      break;
    default:
      console.error(`Unknown subcommand: "${options.subcommand}". Run with --help for usage.`);
      code = 1;
      break;
  }

  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  cmdInit,
  cmdList,
  cmdListByPriority,
  buildPriorityRanking,
  renderPriorityTable,
  cmdNew,
  cmdImport,
  cmdSync,
  cmdValidate,
  cmdArchive,
  cmdStatus,
  cmdUpdate,
  collectDriftFiles,
  specMentionsPath,
  buildDriftInsertion,
  appendDriftInsertion,
  SPEC_STATUS_TRANSITIONS
};
