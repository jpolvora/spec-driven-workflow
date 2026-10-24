'use strict';

// Spec 00068 AC1: every Step 7 review finding carries an explicit disposition in
// run state. A finding is raised with `disposition: null` and is later disposed
// `fixed` (AC2: commit sha plus timestamp) or `waived` (AC3: non-empty rationale
// plus timestamp). The reviewer-assigned id (`CR-001`) is the finding identity;
// this module never mints a second one.

const stateManager = require('./state_manager.cjs');

const REVIEW_STEP = 7;
const DISPOSITIONS = ['fixed', 'waived'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// `at` is injectable so a test stays deterministic while the CLI writes real time.
function resolveAt(at) {
  if (at instanceof Date && !Number.isNaN(at.getTime())) return at.toISOString();
  if (typeof at === 'string' && at.trim()) {
    const parsed = new Date(at.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function findingId(finding) {
  if (!isPlainObject(finding) || finding.id === undefined || finding.id === null) return null;
  const id = String(finding.id).trim();
  return id || null;
}

function findingPath(finding) {
  if (!isPlainObject(finding)) return '';
  return String(finding.path || finding.file || '').trim();
}

function findingMessage(finding) {
  if (!isPlainObject(finding)) return '';
  return String(finding.message || '').trim();
}

function isDisposed(finding) {
  return isPlainObject(finding) && DISPOSITIONS.includes(finding.disposition);
}

// Spec 00068 AC1: one finding in the persisted shape. The disposition slot is
// always present, so an undisposed finding is explicit (`disposition: null`)
// instead of silently missing from the record.
function normalizeFinding(finding, previous) {
  if (!isPlainObject(finding)) return null;
  const id = findingId(finding);
  const path = findingPath(finding);
  const message = findingMessage(finding);
  const normalized = {
    ...finding,
    id,
    path,
    disposition: null,
    at: null,
    commit: null,
    reason: null
  };
  // Spec 00068 Notes: a re-reported finding keeps its disposition only when the
  // path and message are unchanged; a changed finding is raised again.
  if (isDisposed(previous)
    && findingId(previous) === id
    && findingPath(previous) === path
    && findingMessage(previous) === message) {
    normalized.disposition = previous.disposition;
    normalized.at = previous.at || null;
    normalized.commit = previous.commit || null;
    normalized.reason = previous.reason || null;
  }
  return normalized;
}

// Spec 00068 AC1: the whole Step 7 ledger, with earlier dispositions restored by
// finding id. The input list is never mutated.
function normalizeFindings(findings, previousFindings) {
  const previousById = new Map();
  for (const previous of Array.isArray(previousFindings) ? previousFindings : []) {
    const id = findingId(previous);
    if (id && !previousById.has(id)) previousById.set(id, previous);
  }
  const normalized = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    const id = findingId(finding);
    const entry = normalizeFinding(finding, id ? previousById.get(id) : null);
    if (entry) normalized.push(entry);
  }
  return normalized;
}

// Spec 00068 AC1-AC3: the pure disposition write. It refuses an unknown finding
// id, a missing commit sha, an empty rationale, and a request naming both
// dispositions; it returns a new list and leaves the input untouched.
function disposeFinding(findings, targetId, options) {
  const settings = isPlainObject(options) ? options : {};
  const id = String(targetId === undefined || targetId === null ? '' : targetId).trim();
  if (!id) throw new Error('A finding id is required to record a disposition.');
  const list = Array.isArray(findings) ? findings : [];
  const index = list.findIndex((finding) => findingId(finding) === id);
  if (index === -1) throw new Error(`Unknown finding id "${id}".`);

  const hasFixed = Object.prototype.hasOwnProperty.call(settings, 'fixed')
    && settings.fixed !== undefined && settings.fixed !== null;
  const hasWaived = Object.prototype.hasOwnProperty.call(settings, 'waived')
    && settings.waived !== undefined && settings.waived !== null;
  if (!hasFixed && !hasWaived) {
    throw new Error(`Finding "${id}" needs a disposition: --fixed <sha> or --waived <reason>.`);
  }
  if (hasFixed && hasWaived) {
    throw new Error(`Finding "${id}" takes exactly one disposition, not both.`);
  }

  let disposition;
  let commit = null;
  let reason = null;
  if (hasFixed) {
    commit = String(settings.fixed).trim();
    // Spec 00068 AC2: a fixed disposition records the fixing commit sha.
    if (!commit) throw new Error(`Finding "${id}" cannot be disposed fixed without a commit sha.`);
    disposition = 'fixed';
  } else {
    // Spec 00068 AC3: a waiver requires a non-empty rationale.
    reason = String(settings.waived).trim();
    if (!reason) throw new Error(`Finding "${id}" cannot be disposed waived without a non-empty rationale.`);
    disposition = 'waived';
  }

  // Spec 00068 AC2, AC3: the timestamp records when the disposition was taken.
  const updated = { ...list[index], disposition, at: resolveAt(settings.at), commit, reason };
  const next = list.slice();
  next[index] = updated;
  return {
    findings: next,
    finding: updated,
    message: disposition === 'fixed'
      ? `[Review] ${id} fixed in ${commit}`
      : `[Review] ${id} waived: ${reason}`
  };
}

// Spec 00068 AC1: the disposition lives in run state. The finding is located in
// `steps[7].output.findings`, updated, and saved; a refusal throws before
// anything is written.
function disposeInRunState(targetRoot, runId, targetId, options) {
  const state = stateManager.loadRunState(targetRoot, runId);
  const step7 = state.steps && state.steps[REVIEW_STEP];
  const output = isPlainObject(step7 && step7.output) ? step7.output : null;
  if (!output) throw new Error(`Run "${state.runId}" has no Step ${REVIEW_STEP} review findings to dispose.`);
  const result = disposeFinding(Array.isArray(output.findings) ? output.findings : [], targetId, options);
  state.steps[REVIEW_STEP].output = { ...output, findings: result.findings };
  const saved = stateManager.saveRunState(targetRoot, state);
  return { state: saved, finding: result.finding, message: result.message };
}

module.exports = {
  REVIEW_STEP,
  DISPOSITIONS,
  resolveAt,
  isDisposed,
  normalizeFinding,
  normalizeFindings,
  disposeFinding,
  disposeInRunState
};
