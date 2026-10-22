#!/usr/bin/env node
'use strict';
/**
 * sdw-memory Tier-3 helper (stdlib only: fs, path, child_process, os).
 * Central wrapper for product knowledge: query/record/consolidate/classify
 * memory entries (trap|gap|pattern|error) across pluggable store backends.
 *
 * Backends live in separated contract files and are the only modules that
 * touch their store (see backends/base.cjs):
 *   - backends/traps.cjs   — local `.sdw/traps.md` table (read + write)
 *   - backends/files.cjs   — MEMORY.md / memory/*.md (read-only)
 *   - backends/wsmemo.cjs  — ws-memo vault via memo CLI (read + write)
 * This file only routes between backends; it never reads stores directly.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createBackend } = require('./backends/base.cjs');
const { memoDisabled, memoAvailable, resolveSkillDir, wsMemoStatus } = require('./backends/wsmemo.cjs');

const KINDS = new Set(['trap', 'gap', 'pattern', 'error']);
const CORE_MODULES = new Set(['fs', 'path', 'os', 'child_process', 'util']);
const QUERY_LIMIT_DEFAULT = 5;
const QUERY_LIMIT_MAX = 20;
const RUN_LEARNINGS_FILE = 'learnings.json';
const DIGEST_LIMIT_DEFAULT = 5;
const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

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

/* ---------------- unified operations (routing only) ---------------- */

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

function capLimit(limit) {
  return Math.min(Math.max(parseInt(limit, 10) || QUERY_LIMIT_DEFAULT, 1), QUERY_LIMIT_MAX);
}

function kindOf(options) {
  return options.kind && KINDS.has(options.kind) ? options.kind : null;
}

/* ---------------- backend selection: CLI > config > availability ----------------
   `.sdw/config.json` may declare `{ "memory": { "backends": {
   "wsMemo": true|false, "traps": true|false, "files": true|false } } }`.
   Missing keys default to enabled. Explicit `--backend` pins the target set;
   requesting a config-disabled backend is an error. SDW_MEMORY_NO_MEMO=1 and
   an unreachable memo CLI always disable the ws-memo vault. */

function loadMemoryConfig(root) {
  try {
    const p = path.join(path.resolve(root), '.sdw', 'config.json');
    if (!fs.existsSync(p)) return {};
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const m = cfg && cfg.memory;
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (e) {
    return {};
  }
}

function backendsEnabled(root, requested) {
  const memCfg = loadMemoryConfig(root);
  const cfgBackends = memCfg && memCfg.backends && typeof memCfg.backends === 'object' ? memCfg.backends : {};
  const cfgFlag = (key) => cfgBackends[key] === undefined ? true : Boolean(cfgBackends[key]);
  const enabled = {
    'ws-memo': cfgFlag('wsMemo') && cfgFlag('ws-memo'),
    traps: cfgFlag('traps'),
    files: cfgFlag('files')
  };
  const want = requested === undefined ? 'auto' : String(requested).toLowerCase();
  if (!['auto', 'ws-memo', 'traps', 'files', 'all'].includes(want)) {
    return { error: `unknown backend "${requested}" (expected auto|ws-memo|traps|files|all)` };
  }
  return { enabled, want };
}

/* Canonical per-backend consultation. Each section reports { hints, skipped }
   independently. `options.backends` accepts a subset like ['traps', 'files']
   to skip the vault. This is the single entry every skill must use instead
   of raw traps.md / MEMORY.md / memo access. */
function consultMemory(root, text, options = {}) {
  const limit = capLimit(options.limit);
  const kind = kindOf(options);
  const only = Array.isArray(options.backends) ? options.backends.map(s => String(s).toLowerCase()) : null;
  const cfg = backendsEnabled(root, undefined);
  const cfgEnabled = cfg.error ? { 'ws-memo': true, traps: true, files: true } : cfg.enabled;
  const out = {
    traps: { hints: [], skipped: true },
    files: { hints: [], skipped: true },
    vault: { hints: [], skipped: true }
  };
  const wants = (...names) => !only || names.some(n => only.includes(n));
  const vaultUp = !memoDisabled() && memoAvailable();
  if (wants('traps') && cfgEnabled.traps) {
    try {
      const b = createBackend('traps', { root });
      const r = b.query(text, { kind, limit });
      out.traps = { hints: r.hints, skipped: r.skipped };
    } catch (e) {
      out.traps = { hints: [], skipped: true };
    }
  }
  if (wants('files', 'memory-files') && cfgEnabled.files) {
    try {
      const b = createBackend('files', { root });
      const r = b.query(text, { kind, limit });
      out.files = { hints: r.hints, skipped: r.skipped };
    } catch (e) {
      out.files = { hints: [], skipped: true };
    }
  }
  if (wants('vault', 'ws-memo', 'wsmemo', 'spec-memo') && cfgEnabled['ws-memo'] && vaultUp) {
    try {
      const b = createBackend('ws-memo', { root });
      const r = b.query(text, { kind, limit });
      out.vault = { hints: r.hints, skipped: r.skipped };
    } catch (e) {
      out.vault = { hints: [], skipped: true };
    }
  }
  void kind;
  return out;
}

function queryMemory(root, text, options = {}) {
  const limit = capLimit(options.limit);
  const backendOpt = options.backend === undefined ? 'auto' : String(options.backend).toLowerCase();
  if (!['auto', 'ws-memo', 'traps', 'files', 'all'].includes(backendOpt)) {
    return { error: `unknown backend "${options.backend}" (expected auto|ws-memo|traps|files|all)` };
  }
  const cfg = backendsEnabled(root, backendOpt);
  if (cfg.error) return { error: cfg.error };
  const only = backendOpt === 'auto' || backendOpt === 'all' ? undefined : [backendOpt];
  const c = consultMemory(root, text, { kind: kindOf(options), limit, backends: only });
  const hints = [...c.traps.hints, ...c.files.hints, ...c.vault.hints].slice(0, limit);
  const run = options.run ? queryRunIndex(root, options.run, text) : null;
  const sources = [
    ...(run ? [run.source] : []),
    c.traps.hints.length > 0 ? `memory-traps:${c.traps.hints.length} hints` : 'memory-traps:consult-skipped',
    c.files.hints.length > 0 ? `memory-files:${c.files.hints.length} hints` : 'memory-files:consult-skipped',
    c.vault.skipped ? 'spec-memo:consult-skipped' : `spec-memo:${c.vault.hints.length} hints`
  ];
  return { hints: run ? [...run.hints, ...hints].slice(0, limit) : hints, sources };
}

/**
 * AC22: the run-scoped index is queried before the backends, so a step in the
 * same run sees what an earlier step learned even with no reachable backend.
 */
function queryRunIndex(root, runId, text) {
  const state = readRunState(root, runId);
  if (!state) return { hints: [], source: 'run-index:not-found' };
  const words = keywordsOf(text);
  const matches = readRunLearnings(root, runId).filter(entry => {
    const body = entry.body || {};
    const haystack = `${body.slug || ''} ${body.title || ''} ${body.kind || ''} ${body.layer || ''} ${(body.pathPatterns || []).join(' ')}`
      .toLowerCase();
    return words.length === 0 || words.some(word => haystack.includes(word));
  });
  const hints = matches.map(entry => ({
    source: 'run-index',
    slug: entry.body.slug,
    title: entry.body.title,
    kind: entry.body.kind,
    severity: entry.body.severity,
    step: entry.step,
    appliedBy: entry.body.appliedBy || null,
    paths: entry.body.pathPatterns || []
  }));
  return { hints, source: `run-index:${hints.length} hints` };
}

function recordMemory(root, entry, options = {}) {
  const errors = validateEntry(entry);
  if (errors.length > 0) return { exit: 1, error: errors.join('; ') };
  const backendOpt = String(options.backend || 'auto').toLowerCase();
  if (!['auto', 'ws-memo', 'traps', 'files', 'all'].includes(backendOpt)) {
    return { exit: 1, error: `unknown backend "${options.backend}" (expected auto|ws-memo|traps|files|all)` };
  }
  if (backendOpt === 'files') return { exit: 1, error: 'files backend is read-only; record targets ws-memo and/or traps' };
  const cfg = backendsEnabled(root, backendOpt);
  if (cfg.error) return { exit: 1, error: cfg.error };
  const slug = entry.slug || slugOf(entry.title);
  if (!slug) return { exit: 1, error: 'title yields empty slug; pass --slug explicitly' };
  const full = { kind: entry.kind, slug, title: entry.title.trim(), avoid: entry.avoid.trim(), action: entry.action.trim(), layer: entry.layer || 'other', severity: entry.severity || 'medium', tags: entry.tags || [], paths: entry.paths || [] };
  const vaultUp = !memoDisabled() && memoAvailable();
  const names = backendOpt === 'all'
    ? ['ws-memo', 'traps'].filter(n => (n === 'traps' ? cfg.enabled.traps : cfg.enabled['ws-memo'] && vaultUp))
    : backendOpt === 'auto'
      ? (vaultUp && cfg.enabled['ws-memo'] ? ['ws-memo'] : (cfg.enabled.traps ? ['traps'] : []))
      : (backendOpt === 'ws-memo'
        ? (cfg.enabled['ws-memo'] && vaultUp ? ['ws-memo'] : [])
        : (cfg.enabled.traps ? ['traps'] : []));
  const labels = { 'ws-memo': 'ws-memo', traps: 'traps' };
  const recorded = [];
  const skipped = [];
  for (const name of names) {
    let backend;
    try {
      backend = createBackend(name, { root });
    } catch (e) {
      skipped.push({ backend: labels[name] || name, reason: e.message });
      continue;
    }
    const r = backend.record(full);
    if (r.recorded) recorded.push({ backend: labels[name] || name, slug: r.slug || slug });
    else skipped.push({ backend: labels[name] || name, reason: r.reason });
  }
  if (recorded.length === 0) {
    if (names.length === 0) {
      return { exit: 0, report: { slug, recorded: [], skipped: [{ backend: backendOpt, reason: 'no memory backend enabled or available' }], noop: true, entry: full } };
    }
    return { exit: 1, error: `nothing recorded: ${skipped.map(s => `${s.backend} (${s.reason})`).join('; ') || 'no backend selected'}`, report: { slug, recorded: [], skipped, entry: full } };
  }
  return { exit: 0, report: { slug, recorded, skipped, entry: full } };
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
  const backendOpt = String(options.backend || 'traps').toLowerCase();
  if (!['traps', 'auto'].includes(backendOpt)) {
    if (['ws-memo', 'files', 'all'].includes(backendOpt)) {
      return { exit: 0, report: { backend: backendOpt, removed: 0, kept: 0, note: 'vault records are never auto-deleted; use memo gc / forget for lifecycle' } };
    }
    return { exit: 1, error: `unknown backend "${options.backend}" (expected traps|auto)` };
  }
  const cfg = backendsEnabled(root, 'traps');
  if (cfg.error) return { exit: 1, error: cfg.error };
  if (!cfg.enabled.traps) {
    return { exit: 0, report: { backend: 'traps', removed: 0, kept: 0, note: 'traps backend disabled in .sdw/config.json memory.backends' } };
  }
  const backend = createBackend('traps', { root });
  const r = backend.consolidate(Boolean(options.dryRun));
  return { exit: 0, report: { backend: 'traps', removed: r.removed, kept: r.kept, dryRun: Boolean(options.dryRun), ...(r.note ? { note: r.note } : {}) } };
}

/* ---------------- run-scoped learnings (spec 00057) ----------------
   Every memory entry a step records becomes a `learning` contribution in run
   state and an entry in `.sdw/state/{slug}/{runId}/learnings.json`. The index
   is the in-run queryable source, so a later step never depends on a reachable
   memory backend to apply what an earlier step learned (AC20-AC24). */

function resolveStateDir(root) {
  let stateDir = path.join(path.resolve(root), '.sdw', 'state');
  try {
    const configPath = path.join(path.resolve(root), '.sdw', 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg && typeof cfg.stateDir === 'string' && cfg.stateDir.trim()) {
        stateDir = path.resolve(cfg.stateDir.replace(/\{projectRoot\}/g, path.resolve(root)));
      }
    }
  } catch (e) {}
  return stateDir;
}

function runStatePath(root, runId) {
  return path.join(resolveStateDir(root), `${runId}.state.json`);
}

function readRunState(root, runId) {
  try {
    return JSON.parse(fs.readFileSync(runStatePath(root, runId), 'utf8'));
  } catch (e) {
    return null;
  }
}

function resolveRunIndexPath(root, runId, state) {
  const runState = state || readRunState(root, runId);
  if (!runState) return null;
  const artifactsRel = runState.artifactsDir || path.join('.sdw', 'state', runState.specSlug || 'spec', runId);
  const artifactsAbs = path.isAbsolute(artifactsRel) ? artifactsRel : path.resolve(root, artifactsRel);
  return path.join(artifactsAbs, RUN_LEARNINGS_FILE);
}

function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
    return { ok: true };
  } catch (err) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (e) {}
    return { ok: false, error: err.message };
  }
}

function normalizePathPatterns(paths) {
  const list = Array.isArray(paths) ? paths : (typeof paths === 'string' ? paths.split(',') : []);
  return list.map(p => norm(String(p || '').trim().replace(/^\.\//, ''))).filter(Boolean);
}

function learningSeverityRank(value) {
  const key = String(value || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, key) ? SEVERITY_ORDER[key] : 4;
}

/**
 * One learning record shared by the run index and the `learning` contribution,
 * so the report and the index never diverge (spec 00057 AC20, AC21).
 */
function buildLearningEntry(options = {}) {
  const step = Math.max(1, parseInt(options.step, 10) || 1);
  const pathPatterns = normalizePathPatterns(options.pathPatterns);
  const title = String(options.title || options.slug || '').trim();
  return {
    step,
    stepName: String(options.stepName || `step_${step}`),
    at: options.at || new Date().toISOString(),
    kind: 'learning',
    title,
    body: {
      kind: options.kind || null,
      slug: options.slug || null,
      title,
      severity: options.severity || 'medium',
      layer: options.layer || 'other',
      pathPatterns,
      backend: options.backend || 'unavailable',
      appliedBy: null
    },
    evidence: pathPatterns.slice()
  };
}

function readIndexFile(indexPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (Array.isArray(parsed)) return { ok: true, entries: parsed };
    if (parsed && Array.isArray(parsed.learnings)) return { ok: true, entries: parsed.learnings };
    return { ok: false, entries: [], error: 'run index has no learnings array' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, entries: [], missing: true };
    return { ok: false, entries: [], error: err.message };
  }
}

/**
 * Appends one learning to the run-scoped index and to run state. The state
 * write comes first: a failed index write is reported, never thrown, and the
 * report can still render the learning from run state.
 */
function writeRunLearning(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const runId = options.runId;
  const learning = options.learning;
  if (!runId) return { ok: false, error: 'runId is required to write a learning' };
  if (!learning || learning.kind !== 'learning') return { ok: false, error: 'a learning entry is required' };
  const state = options.state || readRunState(root, runId);
  if (!state) return { ok: false, error: `run not found: ${runId}` };
  if (!Array.isArray(state.reportContributions)) state.reportContributions = [];
  state.reportContributions.push(learning);
  try {
    fs.mkdirSync(path.dirname(runStatePath(root, runId)), { recursive: true });
    fs.writeFileSync(runStatePath(root, runId), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: `run state could not be written: ${err.message}` };
  }
  const indexPath = resolveRunIndexPath(root, runId, state);
  const index = readIndexFile(indexPath);
  if (!index.ok) {
    return { ok: true, indexWritten: false, warning: `run index is unreadable: ${index.error}`, indexPath, learning };
  }
  const entries = [...index.entries, learning];
  const written = writeFileAtomic(indexPath, `${JSON.stringify({ runId, specSlug: state.specSlug || null, updatedAt: learning.at, learnings: entries }, null, 2)}\n`);
  if (!written.ok) {
    return { ok: true, indexWritten: false, warning: `run index could not be written: ${written.error}`, indexPath, learning };
  }
  return { ok: true, indexWritten: true, indexPath, indexRel: norm(path.relative(root, indexPath)), learning };
}

/**
 * Reads the run-scoped index, falling back to run state when the index file is
 * missing or unreadable, so an in-run query keeps working either way (AC21).
 */
function readRunLearnings(root, runId) {
  const state = readRunState(root, runId);
  const indexPath = state ? resolveRunIndexPath(root, runId, state) : null;
  if (indexPath) {
    const index = readIndexFile(indexPath);
    if (index.ok && index.entries.length > 0) {
      return index.entries.filter(entry => entry && entry.kind === 'learning' && entry.body && entry.body.slug);
    }
  }
  if (!state || !Array.isArray(state.reportContributions)) return [];
  return state.reportContributions.filter(entry => entry && entry.kind === 'learning' && entry.body && entry.body.slug);
}

function patternMatchesFile(pattern, file) {
  const normalizedPattern = norm(String(pattern || '').toLowerCase()).replace(/^\.\//, '');
  const normalizedFile = norm(String(file || '').toLowerCase()).replace(/^\.\//, '');
  if (!normalizedPattern || !normalizedFile) return false;
  if (!normalizedPattern.includes('*')) {
    return normalizedFile === normalizedPattern
      || normalizedFile.startsWith(`${normalizedPattern}/`);
  }
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.split('**').map(part => part.split('*').join('[^/]*')).join('.*')}$`);
  return regex.test(normalizedFile);
}

/**
 * Digest rule (AC22): the run-scoped learnings whose path patterns match the
 * files a step will touch, ordered by severity then recording step, capped.
 */
function selectLearningDigest(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const files = (Array.isArray(options.files) ? options.files : [options.files]).filter(Boolean);
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || DIGEST_LIMIT_DEFAULT, 1), QUERY_LIMIT_MAX);
  const learnings = readRunLearnings(root, options.runId)
    .filter(entry => (entry.body.pathPatterns || []).some(pattern => files.some(file => patternMatchesFile(pattern, file))))
    .sort((a, b) => (
      learningSeverityRank(a.body.severity) - learningSeverityRank(b.body.severity)
      || Number(a.step) - Number(b.step)
      || String(a.at).localeCompare(String(b.at))
    ));
  return learnings.slice(0, limit);
}

/**
 * AC24: records the step that applied a learning and one evidence locator on
 * both the index entry and its run-state contribution.
 */
function applyLearning(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const runId = options.runId;
  const slug = String(options.slug || '').trim();
  if (!runId || !slug) return { applied: false, error: 'runId and slug are required' };
  const evidence = String(options.evidence || '').trim();
  if (!evidence) return { applied: false, error: 'evidence is required to record an application' };
  const state = readRunState(root, runId);
  if (!state) return { applied: false, error: `run not found: ${runId}` };
  const step = Math.max(1, parseInt(options.step, 10) || parseInt(state.currentStep, 10) || 1);
  const appliedBy = { step, evidence: norm(evidence) };
  const matchesSlug = entry => entry && entry.kind === 'learning' && entry.body && entry.body.slug === slug;
  let applied = false;

  const indexPath = resolveRunIndexPath(root, runId, state);
  const index = readIndexFile(indexPath);
  if (index.ok && index.entries.some(matchesSlug)) {
    const entries = index.entries.map(entry => (matchesSlug(entry) ? { ...entry, body: { ...entry.body, appliedBy } } : entry));
    const written = writeFileAtomic(indexPath, `${JSON.stringify({ runId, specSlug: state.specSlug || null, updatedAt: new Date().toISOString(), learnings: entries }, null, 2)}\n`);
    if (!written.ok) return { applied: false, error: `run index could not be written: ${written.error}` };
    applied = true;
  }
  if (Array.isArray(state.reportContributions) && state.reportContributions.some(matchesSlug)) {
    state.reportContributions = state.reportContributions.map(entry => (matchesSlug(entry) ? { ...entry, body: { ...entry.body, appliedBy } } : entry));
    try {
      fs.writeFileSync(runStatePath(root, runId), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch (err) {
      return { applied: false, error: `run state could not be written: ${err.message}` };
    }
    applied = true;
  }
  if (!applied) return { applied: false, error: `learning not recorded in run "${runId}": ${slug}` };
  return { applied: true, runId, slug, appliedBy };
}

/**
 * AC20, AC21: records through the configured backends, then records the same
 * entry as a learning contribution and in the run-scoped index. An unreachable
 * backend still records the learning for the run and reports it unavailable.
 */
function recordRunMemory(root, entry, options = {}) {
  const recorded = recordMemory(root, entry, options);
  const normalized = recorded.report && recorded.report.entry;
  if (!normalized) return recorded;
  const runId = options.runId;
  const state = readRunState(root, runId);
  if (!state) return { exit: 1, error: `run not found: ${runId}`, report: recorded.report };
  const step = Math.max(1, parseInt(options.step, 10) || parseInt(state.currentStep, 10) || 1);
  const stepName = (state.steps && state.steps[step] && state.steps[step].name) || `step_${step}`;
  const backend = recorded.report.recorded.length > 0
    ? recorded.report.recorded.map(item => item.backend).join('+')
    : 'unavailable';
  const learning = buildLearningEntry({
    step,
    stepName,
    kind: normalized.kind,
    slug: normalized.slug,
    title: normalized.title,
    severity: normalized.severity,
    layer: normalized.layer,
    pathPatterns: normalized.paths,
    backend
  });
  const written = writeRunLearning({ root, runId, learning, state });
  if (!written.ok) return { exit: 1, error: written.error, report: recorded.report };
  return {
    exit: 0,
    report: {
      ...recorded.report,
      backendUnavailable: recorded.report.recorded.length === 0,
      backendError: recorded.error || null,
      learning,
      index: written.indexRel || null,
      warning: written.warning || null
    }
  };
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
  const backendsDir = path.join(skillDir, 'scripts', 'backends');
  for (const f of ['base.cjs', 'traps.cjs', 'files.cjs', 'wsmemo.cjs']) {
    if (!fs.existsSync(path.join(backendsDir, f))) issues.push(`scripts/backends/${f} missing`);
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
  let memo = 'unavailable';
  let wsMemoSkill = null;
  try {
    const st = wsMemoStatus(root);
    wsMemoSkill = st.skillDir;
    memo = st.cliAvailable ? 'available' : 'unavailable';
  } catch (e) {
    memo = 'unavailable';
  }
  void os;
  const passed = issues.length === 0;
  const result = { passed, skill: 'sdw-memory', memo, wsMemoSkill, issues, summary: passed ? 'sdw-memory doctor passed.' : `sdw-memory doctor failed: ${issues.join('; ')}` };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sdw-memory doctor] ${result.summary} (vault: ${memo})`);
  return { exit: passed ? 0 : 1, result };
}

function parseArgs(args) {
  const o = { subcommand: null, backend: 'auto', kind: null, title: null, avoid: null, action: null, slug: null, tags: null, paths: null, layer: null, severity: null, limit: null, path: null, file: null, text: null, json: false, dryRun: false, root: null, run: null, step: null, evidence: null };
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
    else if (a === '--run' && args[i + 1]) o.run = args[++i];
    else if (a.startsWith('--run=')) o.run = a.slice(6);
    else if (a === '--step' && args[i + 1]) o.step = parseInt(args[++i], 10);
    else if (a.startsWith('--step=')) o.step = parseInt(a.slice(7), 10);
    else if (a === '--evidence' && args[i + 1]) o.evidence = args[++i];
    else if (a.startsWith('--evidence=')) o.evidence = a.slice(11);
    else if (!a.startsWith('-')) positional.push(a);
  }
  o.subcommand = positional[0] || null;
  o.text = positional.slice(1).join(' ');
  return o;
}

function emitSummary(r) {
  if (r.error) { console.error(`[sdw-memory] Error: ${r.error}`); process.exit(1); }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root || findProjectRoot());
  if (!options.subcommand || options.subcommand === 'help' || options.subcommand === '--help') {
    console.log(`sdw-memory — central product knowledge wrapper (trap|gap|pattern|error)
Backends live in scripts/backends/ (contract: backends/base.cjs). Default backend auto prefers the ws-memo vault, falling back to the local traps file.
Usage:
  node sdw_memory.cjs query "<text>" [--kind <kind>] [--backend auto|ws-memo|traps|files|all] [--run <runId>] [--limit N] [--json]
  node sdw_memory.cjs record --kind <kind> --title "..." --avoid "..." --action "..." [--slug S] [--tags a,b] [--paths f] [--layer L] [--severity S] [--run <runId>] [--step N] [--backend ...] [--json]
  node sdw_memory.cjs apply --run <runId> --slug <slug> [--step N] --evidence <locator> [--json]
  node sdw_memory.cjs consolidate [--backend traps] [--dry-run] [--json]
  node sdw_memory.cjs classify "<text>" [--json]
  node sdw_memory.cjs doctor [--json]`);
    process.exit(0);
  }
  if (options.subcommand === 'query') {
    if (!options.text) { console.error('[sdw-memory] Error: query requires text'); process.exit(1); }
    const r = queryMemory(root, options.text, options);
    emitSummary(r);
    if (options.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`[sdw-memory] ${r.hints.length} hint(s): ${r.sources.join(', ')}`);
      for (const h of r.hints) console.log(`  - [${h.source}] ${h.slug || h.id || h.file || ''} ${h.title || ''}`.trim());
    }
    process.exit(0);
  }
  if (options.subcommand === 'apply') {
    if (!options.run) { console.error('[sdw-memory] Error: apply requires --run <runId>'); process.exit(1); }
    if (!options.slug) { console.error('[sdw-memory] Error: apply requires --slug <slug>'); process.exit(1); }
    if (!options.evidence) { console.error('[sdw-memory] Error: apply requires --evidence <locator>'); process.exit(1); }
    const applied = applyLearning(root, { runId: options.run, slug: options.slug, step: options.step, evidence: options.evidence });
    if (!applied.applied) { console.error(`[sdw-memory] Error: ${applied.error}`); process.exit(1); }
    if (options.json) console.log(JSON.stringify(applied, null, 2));
    else console.log(`[sdw-memory] Applied ${applied.slug} at step ${applied.appliedBy.step} (evidence ${applied.appliedBy.evidence})`);
    process.exit(0);
  }
  if (options.subcommand === 'record') {
    if (options.dryRun) {
      const errors = validateEntry({ kind: options.kind, title: options.title, avoid: options.avoid, action: options.action, slug: options.slug });
      if (errors.length > 0) { console.error(`[sdw-memory] Error: ${errors.join('; ')}`); process.exit(1); }
      console.log(JSON.stringify({ dryRun: true, slug: options.slug || slugOf(options.title), backends: options.backend }, null, 2));
      process.exit(0);
    }
    const draft = {
      kind: options.kind, title: options.title, avoid: options.avoid, action: options.action,
      slug: options.slug, layer: options.layer,
      tags: options.tags ? options.tags.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      paths: options.paths ? options.paths.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      severity: options.severity
    };
    const r = options.run
      ? recordRunMemory(root, draft, { backend: options.backend, runId: options.run, step: options.step })
      : recordMemory(root, draft, { backend: options.backend });
    if (r.exit !== 0) { console.error(`[sdw-memory] Error: ${r.error}`); process.exit(1); }
    if (options.json) console.log(JSON.stringify(r.report, null, 2));
    else if (options.run) {
      const backendLabel = r.report.backendUnavailable ? 'unavailable (recorded in the run index)' : r.report.recorded.map(x => x.backend).join(', ');
      console.log(`[sdw-memory] Recorded ${r.report.learning.body.slug} as a learning at step ${r.report.learning.step}: ${backendLabel}`);
      if (r.report.index) console.log(`[sdw-memory] Run index: ${r.report.index}`);
      if (r.report.warning) console.warn(`[sdw-memory] Warning: ${r.report.warning}`);
    } else console.log(`[sdw-memory] Recorded ${r.report.slug}: ${r.report.recorded.map(x => x.backend).join(', ')}`);
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
  resolveSkillDir, wsMemoStatus, trapsPathFor: require('./backends/traps.cjs').trapsPathFor,
  consultMemory, queryMemory, recordMemory, recordTrap, loadMemoryConfig, backendsEnabled,
  classifyMemory, consolidateMemory, cmdDoctor,
  RUN_LEARNINGS_FILE, resolveStateDir, resolveRunIndexPath, readRunLearnings,
  buildLearningEntry, writeRunLearning, selectLearningDigest, applyLearning,
  recordRunMemory, queryRunIndex, patternMatchesFile
};

if (require.main === module) main();
