#!/usr/bin/env node
'use strict';
/**
 * sdw-memory Tier-3 helper (stdlib only: fs, path, child_process, os).
 * Central wrapper for product knowledge: query/record/consolidate/classify
 * memory entries (trap|gap|pattern|error) across pluggable store backends.
 * Native backend: ws-memo vault (memo CLI). Fallback backend: local traps file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const KINDS = new Set(['trap', 'gap', 'pattern', 'error']);
const CORE_MODULES = new Set(['fs', 'path', 'os', 'child_process', 'util']);
const MEMO_TIMEOUT_SEARCH_MS = 15000;
const MEMO_TIMEOUT_WRITE_MS = 60000;
const QUERY_LIMIT_DEFAULT = 5;
const QUERY_LIMIT_MAX = 20;
const SNIPPET_LEN = 160;

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, '.sdw')) ||
        fs.existsSync(path.join(curr, '.git')) ||
        fs.existsSync(path.join(curr, 'skills')) ||
        fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

function keywordsOf(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this'].includes(w));
}

function slugOf(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

function cellText(value, maxLen) {
  return String(value || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function memoDisabled() {
  return process.env.SDW_MEMORY_NO_MEMO === '1';
}

function memoAvailable() {
  if (memoDisabled()) return false;
  try {
    const res = spawnSync('memo', ['--help'], { encoding: 'utf8', timeout: 10000 });
    return res && res.status === 0;
  } catch (e) {
    return false;
  }
}

/* ---------------- traps-file backend (.sdw/traps.md) ---------------- */

const TRAPS_HEADER = [
  '# Anti-Regression Traps Log',
  '',
  'Central repository log of behavioral and engineering traps to prevent repeating mistakes.',
  '',
  '| Slug | Title | Layer | Avoid | Action | Date |',
  '|---|---|---|---|---|---|'
];

function trapsPathFor(root) {
  return path.join(root, '.sdw', 'traps.md');
}

function readTrapRows(root) {
  const trapsPath = trapsPathFor(root);
  if (!fs.existsSync(trapsPath)) return { trapsPath, rows: [], exists: false };
  const rows = [];
  for (const rawLine of fs.readFileSync(trapsPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    const slug = cells.length > 1 ? cells[1] : '';
    if (!slug || /^slugs?$/i.test(slug) || /^-+$/.test(slug)) continue;
    rows.push({ slug, title: cells[2] || '', layer: cells[3] || '', avoid: cells[4] || '', action: cells[5] || '', date: cells[6] || '', line });
  }
  return { trapsPath, rows, exists: true };
}

function queryTraps(root, text, kind, limit) {
  const { rows } = readTrapRows(root);
  const q = String(text || '').toLowerCase();
  const keywords = keywordsOf(text);
  const hints = [];
  for (const row of rows) {
    const hay = `${row.slug} ${row.title} ${row.avoid} ${row.action}`.toLowerCase();
    if (hay.includes(q) || keywords.some(k => hay.includes(k))) {
      hints.push({ source: 'traps', slug: row.slug, title: row.title, snippet: `Avoid: ${row.avoid} Action: ${row.action}`.slice(0, SNIPPET_LEN), action: row.action });
      if (hints.length >= limit) break;
    }
  }
  void kind;
  return { hints, skipped: false };
}

function recordTraps(root, entry) {
  const slug = entry.slug || slugOf(entry.title);
  if (!slug) return { recorded: false, reason: 'rule yields empty trap slug' };
  const { trapsPath, rows, exists } = readTrapRows(root);
  if (rows.some(r => r.slug === slug)) return { slug, recorded: false, reason: 'trap slug already registered' };
  const date = new Date().toISOString().slice(0, 10);
  const row = `| ${cellText(slug, 80)} | ${cellText(entry.title, 80)} | ${cellText(entry.layer || 'general', 40)} | ${cellText(entry.avoid, 140)} | ${cellText(entry.action, 140)} | ${date} |`;
  if (!exists) {
    fs.mkdirSync(path.dirname(trapsPath), { recursive: true });
    fs.writeFileSync(trapsPath, [...TRAPS_HEADER, row, ''].join('\n'), 'utf8');
  } else {
    fs.appendFileSync(trapsPath, row + '\n', 'utf8');
  }
  return { slug, recorded: true, backend: 'traps' };
}

/* ---------------- ws-memo backend (memo CLI vault) ---------------- */

function memoSearch(root, query, limit) {
  if (memoDisabled()) return { hints: [], skipped: true, reason: 'SDW_MEMORY_NO_MEMO=1' };
  let raw = '';
  try {
    const res = spawnSync('memo',
      ['search', '--query', query, '--kinds', 'trap', '--limit', String(limit), '--sort', 'relevance', '--json', '--cwd', root],
      { encoding: 'utf8', timeout: MEMO_TIMEOUT_SEARCH_MS });
    if (!res || res.status !== 0) return { hints: [], skipped: true, reason: 'memo search exited non-zero' };
    raw = res.stdout || '';
  } catch (e) {
    return { hints: [], skipped: true, reason: 'memo CLI unavailable' };
  }
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data.hits || data.records || data.results || [];
    const hints = list.slice(0, limit).filter(h => h && typeof h === 'object').map(h => ({
      source: 'ws-memo',
      id: String(h.id || h.slug || ''),
      title: String(h.title || '').slice(0, 120),
      snippet: String(h.snippet || h.summary || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN)
    }));
    return { hints, skipped: false };
  } catch (e) {
    return { hints: [], skipped: true, reason: 'memo search returned invalid JSON' };
  }
}

function memoUpsert(root, entry) {
  if (memoDisabled()) return { recorded: false, reason: 'SDW_MEMORY_NO_MEMO=1' };
  const tags = [...new Set([...(entry.tags || []), `sdw-kind:${entry.kind}`])];
  const body = [
    `### [${new Date().toISOString()}] ${entry.title}`,
    `- **Layer**: ${entry.layer || 'other'}`,
    `- **SDW kind**: ${entry.kind}`,
    `- **Scenario / Context**: ${entry.avoid}`,
    `- **DO NOT**: ${entry.avoid}`,
    `- **INSTEAD DO**: ${entry.action}`
  ].join('\n');
  const args = ['upsert', '--kind', 'trap', '--slug', entry.slug, '--body', body, '--cwd', root, '--json'];
  if (entry.title) args.push('--title', entry.title);
  if (entry.severity) args.push('--severity', entry.severity);
  if (entry.paths && entry.paths.length > 0) args.push('--path', entry.paths[0]);
  void tags;
  let raw = '';
  try {
    const res = spawnSync('memo', args, { encoding: 'utf8', timeout: MEMO_TIMEOUT_WRITE_MS });
    if (!res || res.status !== 0) {
      const err = norm(((res && res.stderr) || '')).slice(0, 300);
      return { recorded: false, reason: `memo upsert exited non-zero${err ? `: ${err}` : ''}` };
    }
    raw = res.stdout || '';
  } catch (e) {
    return { recorded: false, reason: 'memo CLI unavailable' };
  }
  try {
    JSON.parse(raw);
    return { recorded: true, backend: 'ws-memo', slug: entry.slug };
  } catch (e) {
    return { recorded: false, reason: 'memo upsert returned invalid JSON' };
  }
}

/* ---------------- unified operations ---------------- */

function resolveBackends(requested, root) {
  const want = String(requested || 'auto').toLowerCase();
  const vault = want === 'ws-memo' || want === 'all' || want === 'auto' ? !memoDisabled() && memoAvailable() : false;
  const file = want === 'traps' || want === 'all' || want === 'auto';
  if (want !== 'auto' && want !== 'ws-memo' && want !== 'traps' && want !== 'all') {
    return { error: `unknown backend "${requested}" (expected auto|ws-memo|traps|all)` };
  }
  if (want === 'ws-memo' && !vault) return { error: 'ws-memo backend unavailable (memo CLI missing or disabled)' };
  return { vault, file, want };
}

function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return ['entry must be an object'];
  if (!KINDS.has(entry.kind)) errors.push(`kind must be one of ${[...KINDS].join('|')}`);
  if (typeof entry.title !== 'string' || entry.title.trim() === '') errors.push('title is required');
  if (typeof entry.avoid !== 'string' || entry.avoid.trim() === '') errors.push('avoid is required');
  if (typeof entry.action !== 'string' || entry.action.trim() === '') errors.push('action is required');
  if (entry.slug !== undefined && entry.slug !== null && !/^[a-z0-9][a-z0-9-]*$/.test(String(entry.slug))) {
    errors.push('slug must match ^[a-z0-9][a-z0-9-]*$');
  }
  return errors;
}

function queryMemory(root, text, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || QUERY_LIMIT_DEFAULT, 1), QUERY_LIMIT_MAX);
  const kind = options.kind && KINDS.has(options.kind) ? options.kind : null;
  const resolved = resolveBackends(options.backend, root);
  if (resolved.error) return { error: resolved.error };
  const hints = [];
  const sources = [];
  if (resolved.file) {
    const r = queryTraps(root, text, kind, limit);
    for (const h of r.hints) hints.push(h);
    sources.push(r.hints.length > 0 ? `memory-traps:${r.hints.length} hints` : 'memory-traps:consult-skipped');
  }
  if (resolved.vault && hints.length < limit) {
    const r = memoSearch(root, `${text} ${keywordsOf(text).join(' ')}`.trim().slice(0, 120), limit - hints.length);
    for (const h of r.hints) hints.push(h);
    sources.push(r.skipped ? 'spec-memo:consult-skipped' : `spec-memo:${r.hints.length} hints`);
  } else if (resolved.vault) {
    sources.push('spec-memo:consult-skipped');
  }
  void kind;
  return { hints: hints.slice(0, limit), sources };
}

function recordMemory(root, entry, options = {}) {
  const errors = validateEntry(entry);
  if (errors.length > 0) return { exit: 1, error: errors.join('; ') };
  const resolved = resolveBackends(options.backend, root);
  if (resolved.error) return { exit: 1, error: resolved.error };
  const slug = entry.slug || slugOf(entry.title);
  if (!slug) return { exit: 1, error: 'title yields empty slug; pass --slug explicitly' };
  const full = { kind: entry.kind, slug, title: entry.title.trim(), avoid: entry.avoid.trim(), action: entry.action.trim(), layer: entry.layer || 'other', severity: entry.severity || 'medium', tags: entry.tags || [], paths: entry.paths || [] };
  const recorded = [];
  const skipped = [];
  if (resolved.vault) {
    const r = memoUpsert(root, full);
    if (r.recorded) recorded.push({ backend: 'ws-memo', slug });
    else skipped.push({ backend: 'ws-memo', reason: r.reason });
  }
  const useFile = resolved.file && (options.backend === 'traps' || options.backend === 'all' || !resolved.vault);
  if (useFile) {
    const r = recordTraps(root, full);
    if (r.recorded) recorded.push({ backend: 'traps', slug: r.slug });
    else skipped.push({ backend: 'traps', reason: r.reason });
  }
  if (recorded.length === 0) return { exit: 1, error: `nothing recorded: ${skipped.map(s => `${s.backend} (${s.reason})`).join('; ') || 'no backend selected'}` };
  return { exit: 0, report: { slug, recorded, skipped } };
}

/** Compatibility wrapper for sdw-rules log-trap hook. */
function recordTrap({ slug, title, avoid, action, layer, root, kind, tags, paths, backend }) {
  const res = recordMemory(path.resolve(root || findProjectRoot()), {
    kind: kind || 'trap', slug, title, avoid, action,
    layer: layer || 'general', tags, paths
  }, { backend: backend || 'auto' });
  if (res.exit !== 0) return { recorded: false, reason: res.error };
  const vaultHit = res.report.recorded.find(r => r.backend === 'ws-memo');
  return { recorded: true, slug: res.report.slug, backend: vaultHit ? 'ws-memo' : res.report.recorded[0].backend };
}

function classifyMemory(text) {
  const t = String(text || '').toLowerCase();
  const has = (...words) => words.some(w => t.includes(w));
  if (has('secret', 'token', 'api key', 'apikey', 'credential', 'password', 'private key', 'leak')) {
    return { kind: 'trap', slug: slugOf(text.split('\n')[0] || text), tags: ['security'], layer: 'other' };
  }
  if (has('debugger', 'console.log', 'todo', 'fixme', 'lint')) {
    return { kind: 'trap', slug: slugOf(text.split('\n')[0] || text), tags: ['hygiene'], layer: 'tests' };
  }
  if (has('flaky', 'race', 'timeout', 'perf', 'slow', 'hang', 'deadlock')) {
    return { kind: 'gap', slug: slugOf(text.split('\n')[0] || text), tags: ['reliability'], layer: 'infrastructure' };
  }
  if (has('pattern', 'convention', 'template', 'idiom', 'best practice')) {
    return { kind: 'pattern', slug: slugOf(text.split('\n')[0] || text), tags: ['convention'], layer: 'application' };
  }
  if (has('fail', 'error', 'crash', 'exception', 'broken', 'regression')) {
    return { kind: 'error', slug: slugOf(text.split('\n')[0] || text), tags: ['defect'], layer: 'application' };
  }
  return { kind: 'trap', slug: slugOf(text.split('\n')[0] || text), tags: [], layer: 'other' };
}

function consolidateMemory(root, options = {}) {
  const resolved = resolveBackends(options.backend || 'traps', root);
  if (resolved.error) return { exit: 1, error: resolved.error };
  if (!resolved.file) {
    return { exit: 0, report: { backend: 'ws-memo', removed: 0, kept: 0, note: 'vault records are never auto-deleted; use memo gc / forget for lifecycle' } };
  }
  const { trapsPath, rows, exists } = readTrapRows(root);
  if (!exists) return { exit: 0, report: { backend: 'traps', removed: 0, kept: 0, note: 'no traps file present' } };
  const seen = new Set();
  const kept = [];
  let removed = 0;
  for (const row of rows) {
    if (seen.has(row.slug)) { removed += 1; continue; }
    seen.add(row.slug);
    kept.push(row);
  }
  if (removed > 0 && !options.dryRun) {
    const lines = [...TRAPS_HEADER, ...kept.map(r => r.line), ''];
    fs.writeFileSync(trapsPath, lines.join('\n'), 'utf8');
  }
  return { exit: 0, report: { backend: 'traps', removed, kept: kept.length, dryRun: Boolean(options.dryRun) } };
}

function cmdDoctor(options = {}) {
  const root = path.resolve(options.root || findProjectRoot());
  const issues = [];
  const skillDir = path.join(root, 'skills', 'sdw-memory');
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    issues.push('SKILL.md missing');
  } else {
    const content = fs.readFileSync(skillMd, 'utf8');
    if (content.split(/\r?\n/).length > 120) issues.push('SKILL.md exceeds 120 lines');
    if (!/>\s*When this skill is loaded,\s*output/i.test(content)) issues.push('SKILL.md missing announcement banner');
    if (!/sdw-rules/i.test(content)) issues.push('SKILL.md missing sdw-rules reference');
  }
  if (!fs.existsSync(path.join(skillDir, 'references', 'memory_protocol.md'))) {
    issues.push('references/memory_protocol.md missing');
  }
  const selfCheck = spawnSync(process.execPath, ['--check', __filename], { encoding: 'utf8' });
  if (selfCheck.status !== 0) issues.push(`script syntax check failed: ${(selfCheck.stderr || '').trim()}`);
  try {
    const src = fs.readFileSync(__filename, 'utf8');
    const requires = Array.from(src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map(m => m[1]);
    const external = requires.filter(r => !CORE_MODULES.has(r) && !r.startsWith('.') && !r.startsWith('/'));
    if (external.length > 0) issues.push(`external runtime dependencies: ${external.join(', ')}`);
  } catch (e) {
    issues.push(`cannot self-inspect requires: ${e.message}`);
  }
  let memo = 'unprobed';
  try {
    memo = memoAvailable() ? 'available' : 'unavailable';
  } catch (e) {
    memo = 'unavailable';
  }
  const passed = issues.length === 0;
  const result = { passed, skill: 'sdw-memory', memo, issues, summary: passed ? 'sdw-memory doctor passed.' : `sdw-memory doctor failed: ${issues.join('; ')}` };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sdw-memory doctor] ${result.summary} (vault: ${memo})`);
  return { exit: passed ? 0 : 1, result };
}

function parseArgs(args) {
  const o = { subcommand: null, backend: 'auto', kind: null, title: null, avoid: null, action: null, slug: null, tags: null, paths: null, layer: null, severity: null, limit: null, path: null, file: null, text: null, json: false, dryRun: false, root: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--backend' && args[i + 1]) o.backend = args[++i];
    else if (a.startsWith('--backend=')) o.backend = a.slice(10);
    else if (a === '--kind' && args[i + 1]) o.kind = args[++i];
    else if (a.startsWith('--kind=')) o.kind = a.slice(7);
    else if (a === '--title' && args[i + 1]) o.title = args[++i];
    else if (a.startsWith('--title=')) o.title = a.slice(8);
    else if (a === '--avoid' && args[i + 1]) o.avoid = args[++i];
    else if (a.startsWith('--avoid=')) o.avoid = a.slice(8);
    else if (a === '--action' && args[i + 1]) o.action = args[++i];
    else if (a.startsWith('--action=')) o.action = a.slice(9);
    else if (a === '--slug' && args[i + 1]) o.slug = args[++i];
    else if (a.startsWith('--slug=')) o.slug = a.slice(7);
    else if (a === '--tags' && args[i + 1]) o.tags = args[++i];
    else if (a.startsWith('--tags=')) o.tags = a.slice(7);
    else if (a === '--paths' && args[i + 1]) o.paths = args[++i];
    else if (a.startsWith('--paths=')) o.paths = a.slice(8);
    else if (a === '--layer' && args[i + 1]) o.layer = args[++i];
    else if (a.startsWith('--layer=')) o.layer = a.slice(8);
    else if (a === '--severity' && args[i + 1]) o.severity = args[++i];
    else if (a.startsWith('--severity=')) o.severity = a.slice(11);
    else if (a === '--limit' && args[i + 1]) o.limit = args[++i];
    else if (a.startsWith('--limit=')) o.limit = a.slice(8);
    else if (a === '--path' && args[i + 1]) o.path = args[++i];
    else if (a.startsWith('--path=')) o.path = a.slice(7);
    else if (a === '--root' && args[i + 1]) o.root = args[++i];
    else if (a.startsWith('--root=')) o.root = a.slice(7);
    else if (!a.startsWith('-')) positional.push(a);
  }
  o.subcommand = positional[0] || null;
  o.text = positional.slice(1).join(' ');
  return o;
}

function emit(options, payload) {
  if (options.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(payload.summary || JSON.stringify(payload));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root || findProjectRoot());
  if (!options.subcommand || options.subcommand === 'help' || options.subcommand === '--help') {
    console.log(`sdw-memory — central product knowledge wrapper (trap|gap|pattern|error)
Usage:
  node sdw_memory.cjs query "<text>" [--kind <kind>] [--backend auto|ws-memo|traps] [--limit N] [--json]
  node sdw_memory.cjs record --kind <kind> --title "..." --avoid "..." --action "..." [--slug S] [--tags a,b] [--paths f] [--layer L] [--severity S] [--backend ...] [--json]
  node sdw_memory.cjs consolidate [--backend traps] [--dry-run] [--json]
  node sdw_memory.cjs classify "<text>" [--json]
  node sdw_memory.cjs doctor [--json]`);
    process.exit(0);
  }
  if (options.subcommand === 'query') {
    if (!options.text) { console.error('[sdw-memory] Error: query requires text'); process.exit(1); }
    const r = queryMemory(root, options.text, options);
    if (r.error) { console.error(`[sdw-memory] Error: ${r.error}`); process.exit(1); }
    if (options.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`[sdw-memory] ${r.hints.length} hint(s): ${r.sources.join(', ')}`);
      for (const h of r.hints) console.log(`  - [${h.source}] ${h.slug || h.id || ''} ${h.title || ''}`.trim());
    }
    process.exit(0);
  }
  if (options.subcommand === 'record') {
    if (options.dryRun) {
      const errors = validateEntry({ kind: options.kind, title: options.title, avoid: options.avoid, action: options.action, slug: options.slug });
      if (errors.length > 0) { console.error(`[sdw-memory] Error: ${errors.join('; ')}`); process.exit(1); }
      console.log(JSON.stringify({ dryRun: true, slug: options.slug || slugOf(options.title), backends: options.backend }, null, 2));
      process.exit(0);
    }
    const r = recordMemory(root, {
      kind: options.kind, title: options.title, avoid: options.avoid, action: options.action,
      slug: options.slug, layer: options.layer,
      tags: options.tags ? options.tags.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      paths: options.paths ? options.paths.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      severity: options.severity
    }, { backend: options.backend });
    if (r.exit !== 0) { console.error(`[sdw-memory] Error: ${r.error}`); process.exit(1); }
    if (options.json) console.log(JSON.stringify(r.report, null, 2));
    else console.log(`[sdw-memory] Recorded ${r.report.slug}: ${r.report.recorded.map(x => x.backend).join(', ')}`);
    process.exit(0);
  }
  if (options.subcommand === 'consolidate') {
    const r = consolidateMemory(root, { backend: options.backend === 'auto' ? 'traps' : options.backend, dryRun: options.dryRun });
    if (r.exit !== 0) { console.error(`[sdw-memory] Error: ${r.error}`); process.exit(1); }
    if (options.json) console.log(JSON.stringify(r.report, null, 2));
    else console.log(`[sdw-memory] Consolidate (${r.report.backend}): removed ${r.report.removed}, kept ${r.report.kept}${options.dryRun ? ' (dry-run)' : ''}${r.report.note ? ` — ${r.report.note}` : ''}`);
    process.exit(0);
  }
  if (options.subcommand === 'classify') {
    if (!options.text) { console.error('[sdw-memory] Error: classify requires text'); process.exit(1); }
    console.log(JSON.stringify(classifyMemory(options.text), null, 2));
    process.exit(0);
  }
  if (options.subcommand === 'doctor') {
    const r = cmdDoctor({ root, json: options.json });
    process.exit(r.exit);
  }
  console.error(`[sdw-memory] Unknown subcommand "${options.subcommand}". Use query|record|consolidate|classify|doctor.`);
  process.exit(1);
}

module.exports = {
  findProjectRoot, keywordsOf, slugOf, memoAvailable, memoDisabled,
  queryMemory, recordMemory, recordTrap, classifyMemory, consolidateMemory, cmdDoctor
};

if (require.main === module) main();
