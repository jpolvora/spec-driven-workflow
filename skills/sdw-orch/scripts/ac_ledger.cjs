'use strict';

/**
 * Spec 00017 AC1-AC11: the per-run acceptance criteria ledger.
 *
 * The ledger is the run's record of which acceptance criteria are verified and
 * which typed evidence proves them. This file owns initialization, the record
 * schema, evidence linking, evidence-type validation, recording the Step 5
 * judge verdicts, deriving the score from the ledger, the canonical SHA-256
 * anchor, and the Markdown/JSON report. Auditing is a later slice; it reads the
 * same stable JSON, so nothing here needs to change.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dagPlanner = require('./dag_planner.cjs');

const LEDGER_FILENAME = 'ac-ledger.json';
// AC4: the only evidence types a ledger record accepts.
const EVIDENCE_TYPES = Object.freeze(['file', 'test', 'commit', 'review', 'sabotage']);
const STATUS_UNVERIFIED = 'unverified';
const STATUS_VERIFIED = 'verified';
// AC7: a judge can fail a criterion after other evidence once verified it. The
// record keeps that evidence but takes this status, so the score never counts it.
const STATUS_FAILED = 'failed';
const REVIEW_EVIDENCE_ID = 'step5-judge';

function normalizePath(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/');
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Evidence paths are always project-relative with forward slashes so the ledger
// does not depend on the machine, the working directory, or the separator.
function normalizeProjectPath(filePath, projectRoot) {
  const raw = normalizePath(trimmed(filePath)).replace(/^\.\//, '');
  if (!raw) return '';
  if (!path.isAbsolute(raw)) return raw;
  const relative = normalizePath(path.relative(path.resolve(projectRoot || process.cwd()), raw));
  return relative || '.';
}

// AC2: one record per acceptance criterion, in declaration order. A derived or
// repeated declaration of the same id is one criterion, not two.
function parseCriteria(specContent) {
  const seen = new Set();
  const criteria = [];
  for (const ac of dagPlanner.parseAcceptanceCriteria(specContent)) {
    if (seen.has(ac.id)) continue;
    seen.add(ac.id);
    criteria.push({
      id: ac.id,
      text: ac.text,
      status: STATUS_UNVERIFIED,
      evidence: []
    });
  }
  return criteria;
}

function buildLedger(options = {}) {
  if (!options.runId) throw new Error('Cannot build an acceptance criteria ledger without a run id.');
  if (!options.specSlug) throw new Error('Cannot build an acceptance criteria ledger without a specification slug.');
  return {
    runId: String(options.runId),
    specSlug: String(options.specSlug),
    generatedAt: options.generatedAt || new Date().toISOString(),
    criteria: parseCriteria(options.specContent)
  };
}

function resolveLedgerPath(options = {}) {
  if (!options.artifactsDir) {
    throw new Error('Cannot resolve the acceptance criteria ledger without the run artifact directory.');
  }
  return path.resolve(options.root || process.cwd(), normalizePath(options.artifactsDir), LEDGER_FILENAME);
}

function readLedger(ledgerPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (err) {
    throw new Error(`Unreadable acceptance criteria ledger ${normalizePath(ledgerPath)}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.criteria)) {
    throw new Error(`Invalid acceptance criteria ledger ${normalizePath(ledgerPath)}: the file declares no criteria array.`);
  }
  return parsed;
}

function writeLedger(ledgerPath, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return ledgerPath;
}

// AC1: initialize the ledger for a run before its first step. A run that already
// owns a ledger keeps it: evidence is append-only across resume.
function initLedger(options = {}) {
  const ledgerPath = resolveLedgerPath(options);
  if (fs.existsSync(ledgerPath)) {
    return { ledgerPath, ledger: readLedger(ledgerPath), created: false };
  }
  const ledger = buildLedger(options);
  writeLedger(ledgerPath, ledger);
  return { ledgerPath, ledger, created: true };
}

// AC3/AC4: the typed evidence payload. Each type names its own identity fields;
// an unknown type or a missing identity is refused before anything is written.
function buildEvidenceEntry(payload = {}, projectRoot) {
  const type = trimmed(payload.type);
  if (!EVIDENCE_TYPES.includes(type)) {
    return { error: `Unknown evidence type "${type}". Allowed types: ${EVIDENCE_TYPES.join(', ')}.` };
  }
  const entry = { type };
  if (type === 'file') {
    entry.path = normalizeProjectPath(payload.path, projectRoot);
    if (!entry.path) return { error: 'Evidence type "file" requires a project-relative path (--path <path>).' };
  } else if (type === 'test') {
    entry.name = trimmed(payload.name);
    entry.status = trimmed(payload.status);
    if (!entry.name) return { error: 'Evidence type "test" requires a test name (--name <name>).' };
    if (!entry.status) return { error: 'Evidence type "test" requires a test status (--status <passed|failed>).' };
  } else if (type === 'commit') {
    entry.sha = trimmed(payload.sha);
    if (!entry.sha) return { error: 'Evidence type "commit" requires a commit SHA (--sha <sha>).' };
  } else {
    entry.id = trimmed(payload.id);
    if (!entry.id) return { error: `Evidence type "${type}" requires an id (--id <id>).` };
  }
  // AC6: accepted task evidence names the task that produced it.
  const taskId = trimmed(payload.taskId);
  if (taskId) entry.taskId = taskId;
  return { entry };
}

function evidenceIdentity(entry) {
  if (entry.type === 'file') return entry.path;
  if (entry.type === 'test') return entry.name;
  if (entry.type === 'commit') return entry.sha;
  return entry.id;
}

// Evidence is de-duplicated by type plus its stable identity, so re-linking the
// same fact never manufactures a second proof.
function evidenceKey(entry) {
  return `${entry.type}|${evidenceIdentity(entry)}`;
}

// AC3: link one evidence payload to one or more declared criteria. Every
// validation completes before the first write, so a refused link leaves the
// ledger byte-for-byte unchanged.
function linkEvidence(options = {}) {
  const targetRoot = path.resolve(options.root || process.cwd());
  let ledgerPath;
  try {
    ledgerPath = options.ledgerPath
      ? path.resolve(targetRoot, options.ledgerPath)
      : resolveLedgerPath({ root: targetRoot, artifactsDir: options.artifactsDir });
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
  if (!fs.existsSync(ledgerPath)) {
    return {
      ok: false,
      errors: [`No acceptance criteria ledger found at ${normalizePath(path.relative(targetRoot, ledgerPath))}. Start the run before linking evidence.`]
    };
  }

  let ledger;
  try {
    ledger = readLedger(ledgerPath);
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }

  const acIds = [...new Set((Array.isArray(options.acIds) ? options.acIds : []).map(trimmed).filter(Boolean))];
  if (acIds.length === 0) {
    return { ok: false, errors: ['At least one acceptance criterion id is required (--ac <id> [<id> ...]).'] };
  }
  const records = new Map(ledger.criteria.map(record => [record.id, record]));
  const unknown = acIds.filter(id => !records.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: [`Unknown acceptance criterion${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. The ledger was not modified.`]
    };
  }

  const built = buildEvidenceEntry(options.evidence || {}, targetRoot);
  if (built.error) return { ok: false, errors: [built.error] };
  const entry = built.entry;
  const key = evidenceKey(entry);

  const linked = [];
  const duplicates = [];
  for (const id of acIds) {
    const record = records.get(id);
    if (!Array.isArray(record.evidence)) record.evidence = [];
    if (record.evidence.some(existing => evidenceKey(existing) === key)) {
      duplicates.push(id);
      continue;
    }
    record.evidence.push({ ...entry });
    record.status = STATUS_VERIFIED;
    linked.push(id);
  }

  if (linked.length > 0) writeLedger(ledgerPath, ledger);
  return { ok: true, ledger, ledgerPath, linked, duplicates, entry };
}

// AC7/AC8: the judge verdicts are evidence too. Each criterion receives one
// review entry whose status mirrors its verdict, and the record status follows
// it, so a criterion the judge failed is never counted as verified even when an
// earlier file, test, or commit entry once proved it.
function recordReviewVerdicts(options = {}) {
  const targetRoot = path.resolve(options.root || process.cwd());
  let ledgerPath;
  try {
    ledgerPath = options.ledgerPath
      ? path.resolve(targetRoot, options.ledgerPath)
      : resolveLedgerPath({ root: targetRoot, artifactsDir: options.artifactsDir });
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
  if (!fs.existsSync(ledgerPath)) {
    return {
      ok: false,
      errors: [`No acceptance criteria ledger found at ${normalizePath(path.relative(targetRoot, ledgerPath))}.`]
    };
  }

  let ledger;
  try {
    ledger = readLedger(ledgerPath);
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }

  const verdicts = Array.isArray(options.verdicts) ? options.verdicts : [];
  const records = new Map(ledger.criteria.map(record => [record.id, record]));
  const unknown = verdicts.map(item => trimmed(item && item.id)).filter(id => id && !records.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: [`Unknown acceptance criterion${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. The ledger was not modified.`]
    };
  }

  // A re-judge updates the same review entry instead of stacking a second
  // verdict for the same Step 5 judgment.
  const reviewId = trimmed(options.reviewId) || REVIEW_EVIDENCE_ID;
  let recorded = 0;
  for (const item of verdicts) {
    const id = trimmed(item && item.id);
    if (!id) continue;
    const record = records.get(id);
    if (!Array.isArray(record.evidence)) record.evidence = [];
    const verified = String(item.verdict || '').trim().toLowerCase() === 'verified';
    const entry = { type: 'review', id: reviewId, status: verified ? 'passed' : 'failed' };
    const index = record.evidence.findIndex(existing => evidenceKey(existing) === evidenceKey(entry));
    if (index >= 0) record.evidence[index] = entry;
    else record.evidence.push(entry);
    record.status = verified ? STATUS_VERIFIED : STATUS_FAILED;
    recorded += 1;
  }

  if (recorded > 0) writeLedger(ledgerPath, ledger);
  return { ok: true, ledger, ledgerPath, recorded };
}

// AC7/AC8: count only records that carry at least one evidence entry, and derive
// the 0-10 score as round(verifiedCount / totalAcs * 10). A record marked
// verified without evidence is not counted, so the ledger cannot inflate itself.
function deriveScore(ledger) {
  const criteria = ledger && Array.isArray(ledger.criteria) ? ledger.criteria : [];
  const totalAcs = criteria.length;
  const evidenced = criteria.filter(record => Array.isArray(record.evidence) && record.evidence.length > 0);
  const verifiedCount = evidenced.filter(record => record.status === STATUS_VERIFIED).length;
  const score = totalAcs === 0 ? 0 : Math.max(0, Math.min(10, Math.round((verifiedCount / totalAcs) * 10)));
  return {
    totalAcs,
    evidencedCount: evidenced.length,
    verifiedCount,
    failingCount: totalAcs - verifiedCount,
    score
  };
}

// AC9: canonical JSON sorts object keys at every depth and keeps array order, so
// the same ledger always hashes to the same digest on any machine.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashLedger(ledger) {
  return crypto.createHash('sha256').update(canonicalJson(ledger), 'utf8').digest('hex');
}

// AC9: the digest of the ledger exactly as it exists on disk.
function hashLedgerFile(ledgerPath) {
  return hashLedger(readLedger(ledgerPath));
}

// AC10: compare the digest anchored in run state with the ledger file. A run
// without a ledger, or a state written before the anchor existed, is not a
// mismatch: only a recorded hash that disagrees with the file fails.
function verifyLedgerHash(options = {}) {
  const ledgerPath = options.ledgerPath || null;
  const expectedSha256 = trimmed(options.expectedSha256).toLowerCase();
  if (!ledgerPath || !fs.existsSync(ledgerPath)) {
    return { ok: true, verified: false, expectedSha256, actualSha256: null, error: null };
  }
  if (!expectedSha256) {
    return { ok: true, verified: false, expectedSha256, actualSha256: null, error: null };
  }
  let actualSha256;
  try {
    actualSha256 = hashLedgerFile(ledgerPath);
  } catch (err) {
    return { ok: false, verified: true, expectedSha256, actualSha256: null, error: `Acceptance criteria ledger verification failed: ${err.message}` };
  }
  if (actualSha256 !== expectedSha256) {
    const relative = normalizePath(path.relative(path.resolve(options.root || process.cwd()), ledgerPath));
    return {
      ok: false,
      verified: true,
      expectedSha256,
      actualSha256,
      error: `Acceptance criteria ledger hash mismatch: run state records SHA-256 ${expectedSha256} `
        + `but ${relative || normalizePath(ledgerPath)} hashes to ${actualSha256}. `
        + 'The ledger changed after its last accepted update; verification fails closed.'
    };
  }
  return { ok: true, verified: true, expectedSha256, actualSha256, error: null };
}

// AC11: the same verified count Step 5 derives, plus one entry per AC with its
// status and its typed evidence. The summary is deterministic, so a report of an
// unchanged ledger is byte-identical.
function summarizeLedger(ledger) {
  const derived = deriveScore(ledger);
  const criteria = ledger && Array.isArray(ledger.criteria) ? ledger.criteria : [];
  return {
    runId: ledger && ledger.runId ? ledger.runId : null,
    specSlug: ledger && ledger.specSlug ? ledger.specSlug : null,
    totals: {
      total: derived.totalAcs,
      verified: derived.verifiedCount,
      unverified: derived.failingCount
    },
    criteria: criteria.map(record => ({
      id: record.id,
      status: record.status,
      text: record.text,
      evidence: Array.isArray(record.evidence) ? record.evidence : []
    }))
  };
}

function describeEvidence(entry) {
  let identity;
  if (entry.type === 'file') identity = entry.path;
  else if (entry.type === 'test') identity = entry.name;
  else if (entry.type === 'commit') identity = entry.sha;
  else identity = entry.id;
  const status = entry.status ? ` (${entry.status})` : '';
  return `${entry.type}: ${identity}${status}`;
}

function escapeTableCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderLedgerMarkdown(summary) {
  const lines = [
    '# Acceptance Criteria Ledger Report',
    '',
    `- Run: ${summary.runId || 'unknown'}`,
    `- Specification: ${summary.specSlug || 'unknown'}`,
    `- Total: ${summary.totals.total}`,
    `- Verified: ${summary.totals.verified}`,
    `- Unverified: ${summary.totals.unverified}`,
    '',
    '| AC | Status | Criterion | Evidence |',
    '| --- | --- | --- | --- |'
  ];
  for (const record of summary.criteria) {
    const evidence = record.evidence.length > 0
      ? record.evidence.map(describeEvidence).join('; ')
      : 'none';
    lines.push(`| ${record.id} | ${record.status} | ${escapeTableCell(record.text)} | ${escapeTableCell(evidence)} |`);
  }
  return `${lines.join('\n')}\n`;
}

// AC11: `ledger report --format md|json`. An unknown format is refused instead
// of silently falling back to another representation.
function renderLedgerReport(ledger, format) {
  const normalized = String(format || 'md').trim().toLowerCase();
  if (normalized === 'json') return `${JSON.stringify(summarizeLedger(ledger), null, 2)}\n`;
  if (normalized === 'md') return renderLedgerMarkdown(summarizeLedger(ledger));
  throw new Error(`Unknown ledger report format "${format}". Use: md | json.`);
}

module.exports = {
  LEDGER_FILENAME,
  EVIDENCE_TYPES,
  STATUS_UNVERIFIED,
  STATUS_VERIFIED,
  STATUS_FAILED,
  REVIEW_EVIDENCE_ID,
  normalizeProjectPath,
  parseCriteria,
  buildLedger,
  resolveLedgerPath,
  readLedger,
  writeLedger,
  buildEvidenceEntry,
  evidenceKey,
  initLedger,
  linkEvidence,
  recordReviewVerdicts,
  deriveScore,
  canonicalJson,
  hashLedger,
  hashLedgerFile,
  verifyLedgerHash,
  summarizeLedger,
  renderLedgerReport
};
