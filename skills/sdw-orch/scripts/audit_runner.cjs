'use strict';

// Spec 00018 AC11/AC12: adversarial audit. The audit re-derives the run's
// claims from the Step 4 acceptance records and the acceptance criteria ledger,
// compares the claimed files with the delivery diff (`git diff --name-only` of
// the delivery commit range), reruns verification in an audit-owned scratch
// worktree, and classifies one verdict per claimed acceptance criterion as
// `confirmed`, `refuted`, or `caveats`.
//
// The classification is recorded on run state, so the later ship-block rules can
// read the verdicts (and `resolveAuditBlocking`) without re-running the audit.
//
// Node.js standard library only (product guarantee: zero runtime dependencies).

const path = require('path');
const { spawnSync } = require('child_process');
const acLedger = require('./ac_ledger.cjs');
const freshVerify = require('./fresh_verify.cjs');

// AC12: the only verdict values an audit may record.
const AUDIT_VERDICT_VALUES = Object.freeze(['confirmed', 'refuted', 'caveats']);
// AC13/AC14: refuted always blocks ship; caveats blocks only when configured.
const AUDIT_POLICIES = Object.freeze(['refuted', 'caveats']);
const DEFAULT_AUDIT_POLICY = 'refuted';
const AUDIT_SCRATCH_DIRNAME = 'audit';

function normalizePath(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/');
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function normalizeClaimFile(value) {
  return normalizePath(trimmed(value)).replace(/^\.\//, '');
}

function resolveAuditScratchDir(projectRoot, runId) {
  return path.join(path.resolve(projectRoot), freshVerify.SCRATCH_ROOT_REL, String(runId), AUDIT_SCRATCH_DIRNAME);
}

function gitFailure(result, fallback) {
  const parts = [result && result.stderr, result && result.stdout, result && result.error && result.error.message]
    .map(value => (value === undefined || value === null ? '' : String(value).trim()))
    .filter(Boolean);
  return parts.join(' ').trim() || fallback;
}

function runGit(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
}

// AC11: the delivery commit range. A run before Step 6 has no delivery commit,
// so its working tree relative to `baseCommit` is compared instead. The output
// is exactly `git diff --name-only`, normalized to project-relative POSIX paths.
function collectDeliveryDiffFiles(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const baseCommit = trimmed(options.baseCommit);
  if (!baseCommit) {
    return { ok: false, error: 'The run state has no baseCommit, so the claimed work cannot be compared with a delivery diff.' };
  }
  const deliveryCommit = trimmed(options.deliveryCommit);
  const args = ['diff', '--name-only', '--no-color', '--no-ext-diff', baseCommit];
  if (deliveryCommit) args.push(deliveryCommit);
  const result = runGit(projectRoot, args);
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: `git diff --name-only failed for baseCommit "${baseCommit}"${deliveryCommit ? ` and deliveryCommit "${deliveryCommit}"` : ''}: ${gitFailure(result, 'unknown git error')}`
    };
  }
  const files = uniqueSorted((result.stdout || '')
    .split('\n')
    .map(normalizeClaimFile)
    .filter(Boolean));
  // A worker can create a file that is neither staged nor committed; `git diff`
  // never lists it, so it is added from the untracked set (ignored files excepted)
  // or a real claim would look missing and be refuted.
  const untracked = runGit(projectRoot, ['ls-files', '--others', '--exclude-standard']);
  if (!untracked.error && untracked.status === 0) {
    for (const file of (untracked.stdout || '').split('\n').map(normalizeClaimFile).filter(Boolean)) {
      if (!files.includes(file)) files.push(file);
    }
    files.sort();
  }
  return { ok: true, files, baseCommit, deliveryCommit: deliveryCommit || null };
}

// AC6/AC7 consistency: evidence with an explicit failing outcome never proves a
// criterion, so it is not counted as proof-bearing here either.
function isProofBearingEvidence(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const outcome = trimmed(entry.status).toLowerCase();
  return !outcome || outcome === 'passed';
}

function createClaim(id) {
  return {
    acId: id,
    text: null,
    taskIds: [],
    claimedFiles: [],
    citedFiles: [],
    hasLedgerRecord: false,
    ledgerStatus: null,
    ledgerEvidence: [],
    proofEvidenceCount: 0
  };
}

// AC11: claimed acceptance criteria and files come from the two run records:
// accepted Step 4 tasks (acIds + filesChanged) and the acceptance criteria
// ledger (criteria, status, typed evidence). The ledger is authoritative for
// criterion identity, so it contributes every declared criterion even when no
// task claimed it; such an omission is incomplete evidence, not proof.
function collectClaims(options = {}) {
  const state = options.state || {};
  const ledger = options.ledger || null;
  const claims = new Map();
  const claimFor = id => {
    if (!claims.has(id)) claims.set(id, createClaim(id));
    return claims.get(id);
  };

  const tasks = (state.steps && state.steps[4] && state.steps[4].tasks) || {};
  for (const task of Object.values(tasks)) {
    if (!task || task.status !== 'completed') continue;
    const taskId = trimmed(task.id);
    const files = (Array.isArray(task.filesChanged) ? task.filesChanged : [])
      .map(normalizeClaimFile)
      .filter(Boolean);
    for (const rawId of Array.isArray(task.acIds) ? task.acIds : []) {
      const id = trimmed(rawId);
      if (!id) continue;
      const claim = claimFor(id);
      if (taskId && !claim.taskIds.includes(taskId)) claim.taskIds.push(taskId);
      for (const file of files) {
        if (!claim.claimedFiles.includes(file)) claim.claimedFiles.push(file);
      }
    }
  }

  const criteria = ledger && Array.isArray(ledger.criteria) ? ledger.criteria : [];
  for (const record of criteria) {
    const id = trimmed(record && record.id);
    if (!id) continue;
    const claim = claimFor(id);
    claim.text = trimmed(record.text) || claim.text;
    claim.hasLedgerRecord = true;
    claim.ledgerStatus = trimmed(record.status) || 'unverified';
    claim.ledgerEvidence = Array.isArray(record.evidence) ? record.evidence.map(item => ({ ...item })) : [];
    claim.proofEvidenceCount = claim.ledgerEvidence.filter(isProofBearingEvidence).length;
    // Ledger `file` evidence proves a path exists, not that the run changed it.
    // It is tracked as a citation, never as a claimed change, so an existing
    // unchanged file can only support a caveat and never refute the criterion.
    for (const evidence of claim.ledgerEvidence) {
      if (evidence && evidence.type === 'file') {
        const file = normalizeClaimFile(evidence.path);
        if (file && !claim.citedFiles.includes(file)) claim.citedFiles.push(file);
      }
    }
  }

  const entries = [...claims.values()].map(claim => ({
    ...claim,
    taskIds: [...claim.taskIds].sort(),
    claimedFiles: uniqueSorted(claim.claimedFiles),
    citedFiles: uniqueSorted(claim.citedFiles)
  }));
  return {
    entries,
    acIds: entries.map(entry => entry.acId),
    files: uniqueSorted(entries.flatMap(entry => entry.claimedFiles))
  };
}

// AC11: a claimed file is proven when the delivery diff lists it. A deletion is
// listed too, so a claimed deletion is not reported as a missing claim.
function compareClaimsToDiff(claims, diffFiles) {
  const diffSet = new Set((Array.isArray(diffFiles) ? diffFiles : []).map(normalizeClaimFile));
  const entries = (claims && Array.isArray(claims.entries) ? claims.entries : []).map(claim => ({
    ...claim,
    presentFiles: claim.claimedFiles.filter(file => diffSet.has(file)),
    missingFiles: claim.claimedFiles.filter(file => !diffSet.has(file))
  }));
  const files = claims && Array.isArray(claims.files) ? claims.files : [];
  return {
    entries,
    presentFiles: uniqueSorted(files.filter(file => diffSet.has(file))),
    missingFiles: uniqueSorted(files.filter(file => !diffSet.has(file))),
    diffFileCount: diffSet.size
  };
}

function collectFreshVerifyVerdicts(state) {
  const record = state && state.freshVerify;
  const byAc = new Map();
  for (const entry of Array.isArray(record && record.verdicts) ? record.verdicts : []) {
    const id = trimmed(entry && entry.id);
    if (!id) continue;
    byAc.set(id, {
      verdict: trimmed(entry.verdict) || null,
      reason: trimmed(entry.unverifiedReason) || null
    });
  }
  return {
    status: record ? trimmed(record.status) || null : null,
    byAc
  };
}

// AC11: rerun verification for the claimed work in isolation. The scratch
// worktree is always removed, and a removal failure is reported instead of
// leaving the audit looking successful.
function reVerifyClaimedWork(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const testCommand = trimmed(options.testCommand);
  const baseCommit = trimmed(options.baseCommit);
  if (!testCommand) {
    return {
      status: 'unavailable',
      command: null,
      reason: 'no verification test command is configured (verification.testCommand)',
      scratchCleanup: null
    };
  }
  if (!baseCommit) {
    return {
      status: 'unavailable',
      command: testCommand,
      reason: 'the run state has no baseCommit to rebuild the delivery diff from',
      scratchCleanup: null
    };
  }

  const scratchDir = options.scratchDir
    ? path.resolve(options.scratchDir)
    : resolveAuditScratchDir(projectRoot, options.runId);
  let scratch;
  try {
    const diff = freshVerify.collectDeliveryDiff(projectRoot, baseCommit);
    scratch = freshVerify.createScratchWorktree({ projectRoot, baseCommit, diff: diff.text, scratchDir });
  } catch (err) {
    return {
      status: 'unavailable',
      command: testCommand,
      reason: `the audit scratch worktree could not be prepared: ${err.message}`,
      scratchCleanup: null
    };
  }

  let run = null;
  let cleanup = null;
  try {
    run = freshVerify.runTestCommand(testCommand, scratch.path, options.timeoutMs);
  } finally {
    cleanup = freshVerify.removeScratchWorktree({ projectRoot, worktreePath: scratch.path });
  }

  const observation = {
    status: run && run.passed ? 'passed' : 'failed',
    command: testCommand,
    exitCode: run ? run.exitCode : null,
    signal: run ? run.signal : null,
    timedOut: Boolean(run && run.timedOut),
    error: run ? run.error : null,
    outputTail: run ? run.outputTail : '',
    scratch: scratch.rel,
    scratchCleanup: cleanup
  };
  if (cleanup && !cleanup.ok) {
    return {
      ...observation,
      status: 'unavailable',
      reason: `the audit scratch worktree could not be removed: ${cleanup.error}`
    };
  }
  return observation;
}

function describeReVerification(reVerification) {
  if (!reVerification) return 'no re-verification was attempted';
  if (reVerification.status === 'unavailable') return `unavailable (${reVerification.reason})`;
  if (reVerification.status === 'passed') {
    return `passed (${reVerification.command} exited 0 in the audit scratch worktree)`;
  }
  return `failed (${freshVerify.describeTestObservation(reVerification)})`;
}

// AC12: confirmed = the claim and the evidence agree; refuted = the evidence
// contradicts the claim; caveats = the evidence is present but incomplete.
// A missing claimed file, a failed ledger verdict, or a failed re-verification
// refutes. Everything short of complete proof is a caveat, never a confirmation.
function classifyClaim(claim, reVerification, freshVerifyVerdicts) {
  const refuted = [];
  const caveats = [];

  if (claim.missingFiles.length > 0) {
    refuted.push(`claimed file(s) absent from the delivery diff: ${claim.missingFiles.join(', ')}`);
  }
  if (claim.hasLedgerRecord && claim.ledgerStatus === 'failed') {
    refuted.push('the acceptance criteria ledger marks this criterion failed');
  }
  if (reVerification && reVerification.status === 'failed') {
    refuted.push(`re-verification failed: ${describeReVerification(reVerification)}`);
  }

  if (refuted.length === 0) {
    if (reVerification && reVerification.status === 'unavailable') {
      caveats.push(`re-verification is unavailable: ${reVerification.reason}`);
    }
    if (!claim.hasLedgerRecord) {
      caveats.push('no acceptance criteria ledger record exists for this criterion');
    } else if (claim.ledgerStatus !== 'verified') {
      caveats.push(`the acceptance criteria ledger records this criterion as ${claim.ledgerStatus || 'unverified'}`);
    }
    if (claim.hasLedgerRecord && claim.proofEvidenceCount === 0) {
      caveats.push('no proof-bearing evidence is linked to this criterion');
    }
    if (claim.claimedFiles.length === 0) {
      caveats.push('no claimed file maps this criterion to the delivery diff');
    }
    if (claim.claimedFiles.length === 0 && claim.citedFiles && claim.citedFiles.length > 0) {
      caveats.push(`ledger cites existing file(s) the delivery diff does not change: ${claim.citedFiles.join(', ')}`);
    }
    const fresh = freshVerifyVerdicts && freshVerifyVerdicts.byAc.get(claim.acId);
    if (fresh && fresh.verdict === 'unverified') {
      caveats.push(`fresh verification marked this criterion unverified${fresh.reason ? `: ${fresh.reason}` : ''}`);
    }
  }

  const verdict = refuted.length > 0 ? 'refuted' : caveats.length > 0 ? 'caveats' : 'confirmed';
  return {
    acId: claim.acId,
    verdict,
    reasons: verdict === 'refuted' ? refuted : verdict === 'caveats' ? caveats : [],
    claimedFiles: claim.claimedFiles,
    citedFiles: claim.citedFiles || [],
    presentFiles: claim.presentFiles || [],
    missingFiles: claim.missingFiles || [],
    taskIds: claim.taskIds,
    ledgerStatus: claim.ledgerStatus,
    ledgerEvidenceCount: claim.ledgerEvidence.length,
    proofEvidenceCount: claim.proofEvidenceCount,
    freshVerifyVerdict: freshVerifyVerdicts ? (freshVerifyVerdicts.byAc.get(claim.acId) || {}).verdict || null : null,
    reVerification: reVerification ? reVerification.status : null
  };
}

function summarizeAuditVerdicts(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const count = value => list.filter(item => item.verdict === value).length;
  const summary = {
    total: list.length,
    confirmed: count('confirmed'),
    refuted: count('refuted'),
    caveats: count('caveats')
  };
  const overall = summary.refuted > 0
    ? 'refuted'
    : summary.caveats > 0
      ? 'caveats'
      : summary.confirmed > 0 ? 'confirmed' : 'caveats';
  return { ...summary, overall };
}

function normalizeAuditPolicy(policy) {
  const value = trimmed(policy).toLowerCase();
  return AUDIT_POLICIES.includes(value) ? value : DEFAULT_AUDIT_POLICY;
}

// AC13/AC14 readiness: the recorded verdicts plus this helper are all the ship
// gate needs. `refuted` always blocks; `caveats` blocks only under that policy.
function resolveAuditBlocking(options = {}) {
  const policy = normalizeAuditPolicy(options.policy);
  const verdicts = Array.isArray(options.verdicts) ? options.verdicts : [];
  const selected = verdicts.filter(item => item.verdict === 'refuted' || (policy === 'caveats' && item.verdict === 'caveats'));
  return {
    policy,
    blocked: selected.length > 0,
    acIds: selected.map(item => item.acId),
    verdicts: selected.map(item => item.verdict),
    reasons: selected.map(item => `${item.acId} ${item.verdict}: ${(item.reasons || []).join(' ')}`)
  };
}

// AC11/AC12: one audit run. A missing baseCommit or an unreadable delivery diff
// fails closed; an unreadable ledger or unavailable re-verification is incomplete
// evidence and classifies as caveats instead.
function runAudit(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const state = options.state || {};
  const runId = trimmed(options.runId) || trimmed(state.runId) || 'run';

  let ledger = options.ledger || null;
  let ledgerError = null;
  if (!ledger && options.ledgerPath) {
    try {
      ledger = acLedger.readLedger(path.resolve(projectRoot, options.ledgerPath));
    } catch (err) {
      ledgerError = err.message;
    }
  }

  const claims = collectClaims({ state, ledger });
  const diff = collectDeliveryDiffFiles({
    projectRoot,
    baseCommit: options.baseCommit,
    deliveryCommit: options.deliveryCommit
  });
  if (!diff.ok) {
    return { ok: false, error: diff.error };
  }

  const comparison = compareClaimsToDiff(claims, diff.files);
  const reVerification = reVerifyClaimedWork({
    projectRoot,
    runId,
    baseCommit: options.baseCommit,
    testCommand: options.testCommand,
    timeoutMs: options.timeoutMs,
    scratchDir: options.scratchDir
  });
  const freshVerifyVerdicts = collectFreshVerifyVerdicts(state);
  const verdicts = comparison.entries.map(claim => classifyClaim(claim, reVerification, freshVerifyVerdicts));
  const summary = summarizeAuditVerdicts(verdicts);
  const blocking = resolveAuditBlocking({ verdicts, policy: options.policy });

  const record = {
    status: 'completed',
    verdicts,
    overall: summary.overall,
    summary,
    blocking,
    claims: { acIds: claims.acIds, files: claims.files },
    diff: {
      baseCommit: diff.baseCommit,
      deliveryCommit: diff.deliveryCommit,
      fileCount: diff.files.length,
      files: diff.files
    },
    reVerification,
    freshVerify: {
      status: freshVerifyVerdicts.status,
      verdicts: verdicts.map(item => ({ id: item.acId, verdict: item.freshVerifyVerdict }))
    },
    ledgerError,
    auditedAt: new Date().toISOString()
  };

  return {
    ok: true,
    record,
    claims: record.claims,
    diff: record.diff,
    reVerification,
    verdicts,
    summary,
    blocking
  };
}

module.exports = {
  AUDIT_VERDICT_VALUES,
  AUDIT_POLICIES,
  DEFAULT_AUDIT_POLICY,
  AUDIT_SCRATCH_DIRNAME,
  normalizePath,
  resolveAuditScratchDir,
  collectDeliveryDiffFiles,
  collectClaims,
  compareClaimsToDiff,
  collectFreshVerifyVerdicts,
  reVerifyClaimedWork,
  describeReVerification,
  classifyClaim,
  summarizeAuditVerdicts,
  normalizeAuditPolicy,
  resolveAuditBlocking,
  runAudit
};
