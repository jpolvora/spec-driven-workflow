'use strict';

/**
 * Spec 00017 AC1-AC4: the per-run acceptance criteria ledger.
 *
 * The ledger is the run's record of which acceptance criteria are verified and
 * which typed evidence proves them. This slice owns initialization, the record
 * schema, evidence linking, and evidence-type validation. Hashing, reporting,
 * auditing, and score derivation are later slices; they read the same stable
 * JSON and append through `linkEvidence`, so nothing here needs to change.
 */

const fs = require('fs');
const path = require('path');
const dagPlanner = require('./dag_planner.cjs');

const LEDGER_FILENAME = 'ac-ledger.json';
// AC4: the only evidence types a ledger record accepts.
const EVIDENCE_TYPES = Object.freeze(['file', 'test', 'commit', 'review', 'sabotage']);
const STATUS_UNVERIFIED = 'unverified';
const STATUS_VERIFIED = 'verified';

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

module.exports = {
  LEDGER_FILENAME,
  EVIDENCE_TYPES,
  STATUS_UNVERIFIED,
  STATUS_VERIFIED,
  normalizeProjectPath,
  parseCriteria,
  buildLedger,
  resolveLedgerPath,
  readLedger,
  writeLedger,
  buildEvidenceEntry,
  evidenceKey,
  initLedger,
  linkEvidence
};
