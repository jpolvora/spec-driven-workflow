'use strict';

// Spec 00018: fresh-context verification. The verifier receives only the
// specification acceptance criteria and the delivery diff, works in a scratch
// git worktree created from that diff, and returns exactly one verdict per
// criterion. This module owns the scratch lifecycle, prompt rendering, verdict
// validation, and cleanup; the orchestrator owns run-state recording.
//
// Node.js standard library only (product guarantee: zero runtime dependencies).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERDICT_VALUES = Object.freeze(['verified', 'unverified']);
const SCRATCH_ROOT_REL = '.sdw/worktrees';
const SCRATCH_DIRNAME = 'fresh-verify';
const PROMPT_FILE_NAME = 'fresh-verify.prompt.md';
const VERDICT_FILE_NAME = 'fresh-verify.verdict.json';
const DEFAULT_TEST_TIMEOUT_MS = 600000;
// The recorded output is a bounded tail, never the whole test transcript.
const TEST_OUTPUT_TAIL_CHARS = 1200;

// Spec 00018 AC3: the verifier context is fenced to these two inputs. Any other
// key is refused instead of silently omitted, so a transcript, DAG prompt,
// judge verdict, or run-state object can never leak into the verifier prompt.
const FENCED_PROMPT_KEYS = Object.freeze(['criteria', 'diff']);

class FreshVerifyError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'FreshVerifyError';
    this.code = options.code || 'fresh_verify_failed';
    this.detail = options.detail || null;
  }
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/');
}

function toRelPosix(root, absPath) {
  return normalizePath(path.relative(root, absPath));
}

function resolveScratchDir(projectRoot, runId) {
  return path.join(path.resolve(projectRoot), SCRATCH_ROOT_REL, String(runId), SCRATCH_DIRNAME);
}

function resolveArtifactPaths(projectRoot, artifactsDir) {
  const root = path.resolve(projectRoot);
  const dirAbs = path.resolve(root, artifactsDir);
  return {
    dirAbs,
    promptFileAbs: path.join(dirAbs, PROMPT_FILE_NAME),
    promptFileRel: toRelPosix(root, path.join(dirAbs, PROMPT_FILE_NAME)),
    verdictFileAbs: path.join(dirAbs, VERDICT_FILE_NAME),
    verdictFileRel: toRelPosix(root, path.join(dirAbs, VERDICT_FILE_NAME))
  };
}

function gitFailure(result, fallback) {
  const parts = [result && result.stderr, result && result.stdout, result && result.error && result.error.message]
    .map(value => (value === undefined || value === null ? '' : String(value).trim()))
    .filter(Boolean);
  return parts.join(' ').trim() || fallback;
}

function runGit(cwd, args, options = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

// Spec 00018 AC2: the scratch worktree is built from the delivery diff. The
// diff is the working tree compared with the run's base commit, so it covers
// checkpoint commits and any still-uncommitted accepted changes.
function collectDeliveryDiff(projectRoot, baseCommit) {
  if (!baseCommit) {
    throw new FreshVerifyError(
      'Cannot build the delivery diff: the run state has no baseCommit.',
      { code: 'missing_base_commit' }
    );
  }
  const result = runGit(projectRoot, ['diff', '--binary', '--no-color', '--no-ext-diff', String(baseCommit)]);
  if (result.error || result.status !== 0) {
    throw new FreshVerifyError(
      `git diff failed for base commit "${baseCommit}": ${gitFailure(result, 'unknown git error')}`,
      { code: 'delivery_diff_failed' }
    );
  }
  const text = result.stdout || '';
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

// Spec 00018 AC2/AC10/AC17: a detached worktree at the base commit with the
// delivery diff applied. Every failure removes a partially created worktree and
// throws, so the caller fails closed and never scores without isolation.
function createScratchWorktree(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  if (!options.scratchDir) {
    throw new FreshVerifyError('A scratch worktree path is required.', { code: 'invalid_scratch_dir' });
  }
  if (!options.baseCommit) {
    throw new FreshVerifyError(
      'Cannot create the scratch worktree: the run state has no baseCommit.',
      { code: 'missing_base_commit' }
    );
  }
  const scratchDir = path.resolve(options.scratchDir);
  const diff = typeof options.diff === 'string' ? options.diff : '';
  const diffBytes = Buffer.byteLength(diff, 'utf8');

  if (fs.existsSync(scratchDir)) {
    throw new FreshVerifyError(
      `Scratch worktree path already exists: "${normalizePath(scratchDir)}". Remove it or start a new verification.`,
      { code: 'scratch_path_exists' }
    );
  }
  fs.mkdirSync(path.dirname(scratchDir), { recursive: true });

  const add = runGit(projectRoot, ['worktree', 'add', '--detach', scratchDir, String(options.baseCommit)]);
  if (add.error || add.status !== 0) {
    removeScratchWorktree({ projectRoot, worktreePath: scratchDir });
    throw new FreshVerifyError(
      `Scratch worktree creation failed for base commit "${options.baseCommit}": ${gitFailure(add, 'git worktree add failed')}`,
      { code: 'scratch_worktree_failed' }
    );
  }

  let diffApplied = false;
  if (diff.trim()) {
    const applied = runGit(scratchDir, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: diff });
    if (applied.error || applied.status !== 0) {
      removeScratchWorktree({ projectRoot, worktreePath: scratchDir });
      throw new FreshVerifyError(
        `Applying the delivery diff in the scratch worktree failed: ${gitFailure(applied, 'git apply failed')}`,
        { code: 'diff_apply_failed' }
      );
    }
    diffApplied = true;
  }

  return {
    path: scratchDir,
    rel: toRelPosix(projectRoot, scratchDir),
    baseCommit: String(options.baseCommit),
    diffBytes,
    diffApplied
  };
}

// Spec 00018 AC10: cleanup is reported, never silent. An absent worktree is
// already clean; a removal that leaves the directory behind is a failure the
// caller must surface instead of continuing as if it succeeded.
function removeScratchWorktree(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const worktreePath = options.worktreePath ? path.resolve(options.worktreePath) : null;
  if (!worktreePath) {
    return { ok: true, removed: false, reason: 'no_worktree' };
  }
  if (!fs.existsSync(worktreePath)) {
    runGit(projectRoot, ['worktree', 'prune']);
    return { ok: true, removed: false, reason: 'absent' };
  }

  const removed = runGit(projectRoot, ['worktree', 'remove', '--force', worktreePath]);
  runGit(projectRoot, ['worktree', 'prune']);
  if (removed.error || removed.status !== 0 || fs.existsSync(worktreePath)) {
    return {
      ok: false,
      removed: false,
      error: gitFailure(removed, `git worktree remove left "${normalizePath(worktreePath)}" in place`)
    };
  }
  return { ok: true, removed: true };
}

// Spec 00018 AC5: one deterministic, reversible mutation per acceptance
// criterion. A fault is an exact-string replacement in one file of the scratch
// worktree, so it never depends on a mutation-testing tool or a random seed.
// A criterion with no executable surface is recorded as a documented no-op.
function describeFault(fault) {
  if (!fault) return null;
  if (fault.noOp) return `no-op mutation: ${fault.reason}`;
  return `${normalizePath(fault.file)}: replace ${JSON.stringify(fault.find)} with ${JSON.stringify(fault.replace)}`;
}

function readFaultPlan(faultsFileAbs) {
  const fileAbs = faultsFileAbs ? path.resolve(faultsFileAbs) : null;
  if (!fileAbs || !fs.existsSync(fileAbs)) {
    throw new FreshVerifyError(
      `Fault plan not found: "${normalizePath(fileAbs || '')}". Pass --faults <path> with one entry per acceptance criterion.`,
      { code: 'fault_plan_missing' }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fileAbs, 'utf8'));
  } catch (err) {
    throw new FreshVerifyError(`Fault plan "${normalizePath(fileAbs)}" is not valid JSON: ${err.message}`, { code: 'fault_plan_invalid' });
  }
  const faults = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.faults) ? parsed.faults : null);
  if (!faults) {
    throw new FreshVerifyError(
      `Fault plan "${normalizePath(fileAbs)}" must be a JSON array or an object with a "faults" array.`,
      { code: 'fault_plan_invalid' }
    );
  }
  return faults;
}

// Spec 00018 AC5: normalize the operator-supplied plan into exactly one entry
// per acceptance criterion, in declaration order. An omitted entry is refused
// when a plan was supplied; only a wholly absent plan degrades to documented
// no-ops, so verification still records why nothing could be proven.
function planFaults(criteria, faults) {
  const acs = Array.isArray(criteria) ? criteria : [];
  const supplied = Array.isArray(faults);
  if (!supplied) {
    return acs.map(ac => ({
      id: String(ac.id).trim(),
      fault: {
        noOp: true,
        reason: 'no defect was injected because no fault plan was supplied for this verification'
      }
    }));
  }

  const knownIds = new Set(acs.map(ac => String(ac.id).trim()));
  const planned = new Map();
  faults.forEach((entry, index) => {
    const label = `faults[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new FreshVerifyError(`${label} must be an object.`, { code: 'fault_plan_invalid' });
    }
    const id = typeof entry.acId === 'string' ? entry.acId.trim() : (typeof entry.id === 'string' ? entry.id.trim() : '');
    if (!id) {
      throw new FreshVerifyError(`${label} is missing an acceptance-criterion id (acId).`, { code: 'fault_plan_invalid' });
    }
    if (!knownIds.has(id)) {
      throw new FreshVerifyError(`${label} names unknown acceptance criterion "${id}".`, { code: 'fault_plan_invalid' });
    }
    if (planned.has(id)) {
      throw new FreshVerifyError(`${label} repeats the fault for ${id}; exactly one fault per acceptance criterion is required.`, { code: 'fault_plan_invalid' });
    }
    if (entry.noOp === true) {
      const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
      if (!reason) {
        throw new FreshVerifyError(`${label} (${id}) is a no-op fault without a reason; document why the criterion has no executable surface.`, { code: 'fault_plan_invalid' });
      }
      planned.set(id, { noOp: true, reason });
      return;
    }
    const file = typeof entry.file === 'string' ? entry.file.trim() : '';
    const find = typeof entry.find === 'string' ? entry.find : '';
    const replace = typeof entry.replace === 'string' ? entry.replace : '';
    if (!file || !find) {
      throw new FreshVerifyError(
        `${label} (${id}) needs "file" and "find" strings, or "noOp": true with a "reason".`,
        { code: 'fault_plan_invalid' }
      );
    }
    planned.set(id, { file, find, replace });
  });

  const missing = acs.map(ac => String(ac.id).trim()).filter(id => !planned.has(id));
  if (missing.length > 0) {
    throw new FreshVerifyError(
      `Fault plan is missing a fault for ${missing.join(', ')}; one fault per acceptance criterion is required.`,
      { code: 'fault_plan_missing_criterion' }
    );
  }
  return acs.map(ac => ({ id: String(ac.id).trim(), fault: planned.get(String(ac.id).trim()) }));
}

function runTestCommand(command, cwd, timeoutMs) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    command,
    passed: !result.error && result.status === 0,
    exitCode: result.status,
    signal: result.signal || null,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    outputTail: output.length > TEST_OUTPUT_TAIL_CHARS ? output.slice(-TEST_OUTPUT_TAIL_CHARS) : output
  };
}

function describeTestObservation(run) {
  if (!run) return 'no test run was recorded';
  if (run.timedOut) return 'the test command timed out';
  if (run.signal) return `the test command was terminated by signal ${run.signal}`;
  if (run.error) return `the test command failed to run: ${run.error}`;
  return `the test command exited ${run.exitCode}${run.passed ? ' (passed)' : ''}`;
}

function readFileStatus(scratchPath, relFile) {
  const result = runGit(scratchPath, ['status', '--porcelain', '--', relFile]);
  if (result.error || result.status !== 0) {
    throw new FreshVerifyError(
      `Reading the scratch worktree status failed: ${gitFailure(result, 'git status failed')}`,
      { code: 'scratch_status_failed' }
    );
  }
  return (result.stdout || '').trim();
}

// Spec 00018 AC5: apply one fault inside the scratch worktree and keep the
// bytes needed to revert it. The target must resolve inside the scratch tree and
// contain the injected text exactly once, so the mutation is deterministic.
function applyFault(scratchPath, fault) {
  const root = path.resolve(scratchPath);
  const absPath = path.resolve(root, fault.file);
  const rel = normalizePath(path.relative(root, absPath));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new FreshVerifyError(
      `Fault target "${fault.file}" resolves outside the scratch worktree; refusing to inject it.`,
      { code: 'fault_target_outside_scratch' }
    );
  }
  let original;
  try {
    original = fs.readFileSync(absPath);
  } catch (err) {
    throw new FreshVerifyError(`Fault target "${rel}" is unreadable in the scratch worktree: ${err.message}`, { code: 'fault_target_missing' });
  }
  const text = original.toString('utf8');
  const occurrences = text.split(fault.find).length - 1;
  if (occurrences !== 1) {
    throw new FreshVerifyError(
      `Fault target "${rel}" must contain the injected text exactly once (found ${occurrences}); the fault plan is not applicable to this delivery diff.`,
      { code: 'fault_target_mismatch' }
    );
  }
  const statusBefore = readFileStatus(root, rel);
  fs.writeFileSync(absPath, text.replace(fault.find, fault.replace), 'utf8');
  return { absPath, rel, original, statusBefore };
}

// Spec 00018 AC5: every fault is reverted before the next one is applied. A
// revert that leaves the file changed, or the scratch tree dirty, fails closed.
function revertFault(scratchPath, applied) {
  fs.writeFileSync(applied.absPath, applied.original);
  const restored = fs.readFileSync(applied.absPath);
  const statusAfter = readFileStatus(path.resolve(scratchPath), applied.rel);
  if (!restored.equals(applied.original) || statusAfter !== applied.statusBefore) {
    throw new FreshVerifyError(
      `Scratch worktree is dirty after reverting the injected fault in "${applied.rel}"; refusing to continue verification.`,
      { code: 'scratch_dirty' }
    );
  }
}

// Spec 00018 AC5/AC6/AC7: run the test command once on the unmutated scratch
// worktree (the observed passing evidence), then inject and revert one fault per
// criterion. A fault whose mutation leaves the suite green is recorded as not
// detected; the caller marks that criterion unverified.
function runFaultInjection(options = {}) {
  if (!options.scratchPath) {
    throw new FreshVerifyError('Fault injection requires the scratch worktree path.', { code: 'invalid_scratch_dir' });
  }
  const scratchPath = path.resolve(options.scratchPath);
  const criteria = Array.isArray(options.criteria) ? options.criteria : [];
  const planned = planFaults(criteria, options.faults);
  const testCommand = typeof options.testCommand === 'string' && options.testCommand.trim()
    ? options.testCommand.trim()
    : null;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TEST_TIMEOUT_MS;

  // AC7: observed passing evidence must exist before any fault result is
  // interpretable; without it every criterion stays unverified.
  const baseline = testCommand ? runTestCommand(testCommand, scratchPath, timeoutMs) : null;
  const baselinePassed = Boolean(baseline && baseline.passed);
  const faults = [];

  for (const item of planned) {
    const fault = item.fault;
    const evidence = {
      id: item.id,
      fault,
      faultInjected: describeFault(fault),
      applied: false,
      reverted: false,
      noOpReason: fault.noOp ? fault.reason : null,
      baselinePassed,
      faultStatus: null,
      faultObserved: false,
      reason: null
    };

    if (fault.noOp) {
      evidence.reason = `No-op mutation: ${fault.reason}; the test suite proves nothing about this acceptance criterion.`;
      faults.push(evidence);
      continue;
    }

    const applied = applyFault(scratchPath, fault);
    evidence.applied = true;
    try {
      if (baselinePassed) {
        evidence.faultStatus = runTestCommand(testCommand, scratchPath, timeoutMs);
      }
    } finally {
      revertFault(scratchPath, applied);
      evidence.reverted = true;
    }

    if (!baselinePassed) {
      evidence.reason = baseline
        ? `No observed passing test evidence: ${describeTestObservation(baseline)} before any fault was injected.`
        : 'No observed passing test evidence: no test command is configured in the scratch worktree.';
    } else if (!evidence.faultStatus || evidence.faultStatus.passed) {
      evidence.reason = `Injected fault not detected: ${evidence.faultInjected}; ${describeTestObservation(evidence.faultStatus)}.`;
    } else {
      evidence.faultObserved = true;
    }
    faults.push(evidence);
  }

  return { baseline, faults, testCommand };
}

// Spec 00018 AC6/AC7: a verdict may only stay `verified` when the system holds
// both an observed passing test run and a detected fault for that criterion.
// Everything else is downgraded to `unverified` with the fault and the observed
// result named; the verifier's claim is preserved separately.
function faultUnverifiedReason(fault, baseline) {
  if (!fault) {
    return 'no fault injection evidence is recorded, so the test suite proves nothing about this acceptance criterion';
  }
  if (!baseline) {
    return 'no observed passing test evidence: no test command is configured, so the scratch worktree never ran tests';
  }
  if (!baseline.passed) {
    return `no observed passing test evidence: ${describeTestObservation(baseline)} before any fault was injected`;
  }
  if (fault.noOpReason || (fault.fault && fault.fault.noOp)) {
    return `the injected fault was a no-op mutation (${fault.noOpReason || fault.fault.reason}), so the test suite proves nothing about this criterion`;
  }
  if (!fault.faultObserved) {
    return `the injected fault was not detected: ${fault.faultInjected}; ${describeTestObservation(fault.faultStatus)}`;
  }
  return null;
}

function applyFaultEvidence(verdicts, evidence) {
  const baseline = evidence && evidence.baseline ? evidence.baseline : null;
  const faults = evidence && Array.isArray(evidence.faults) ? evidence.faults : [];
  const byId = new Map(faults.map(item => [String(item.id).trim(), item]));
  const out = [];

  for (const entry of Array.isArray(verdicts) ? verdicts : []) {
    const id = entry && entry.id ? String(entry.id).trim() : '';
    const fault = byId.get(id) || null;
    const claimedVerdict = entry && entry.verdict;
    const result = {
      ...entry,
      claimedVerdict,
      faultInjected: fault ? fault.faultInjected : null,
      faultObserved: fault ? Boolean(fault.faultObserved) : false,
      evidenceClaim: entry && typeof entry.passingEvidence === 'string' ? entry.passingEvidence : null
    };

    if (claimedVerdict === 'verified') {
      const reason = faultUnverifiedReason(fault, baseline);
      if (reason) {
        result.verdict = 'unverified';
        result.passingEvidence = null;
        result.unverifiedReason = reason;
      } else {
        result.passingEvidence = `${baseline.command} exited 0 in the scratch worktree`;
        result.unverifiedReason = null;
      }
    } else {
      result.passingEvidence = null;
      result.unverifiedReason = null;
    }
    out.push(result);
  }
  return { verdicts: out };
}

function diffFence(diff) {
  const longestRun = (String(diff).match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function criteriaBlock(criteria) {
  return criteria.map(ac => `- ${ac.id}: ${ac.text}`).join('\n');
}

// Spec 00018 AC3: renders the only content a verifier receives: acceptance
// criteria plus the delivery diff. The fence refuses any extra input key, so a
// caller cannot append the implementation transcript, worker reasoning, DAG
// prompt, judge verdict, or run state even by mistake.
function renderVerifierPrompt(input = {}) {
  const provided = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const refused = Object.keys(provided).filter(key => !FENCED_PROMPT_KEYS.includes(key));
  if (refused.length > 0) {
    throw new FreshVerifyError(
      `Fresh-verify prompt input is fenced to acceptance criteria and the diff; refused context: ${refused.join(', ')}.`,
      { code: 'context_fence_violation' }
    );
  }

  const criteria = Array.isArray(provided.criteria) ? provided.criteria : [];
  if (criteria.length === 0) {
    throw new FreshVerifyError(
      'Fresh-verify prompt requires at least one acceptance criterion.',
      { code: 'missing_criteria' }
    );
  }
  for (const ac of criteria) {
    if (!ac || typeof ac.id !== 'string' || !ac.id.trim() || typeof ac.text !== 'string') {
      throw new FreshVerifyError(
        'Every acceptance criterion needs an id and text.',
        { code: 'invalid_criteria' }
      );
    }
  }
  const diff = typeof provided.diff === 'string' ? provided.diff : '';
  const fence = diffFence(diff);

  const lines = [];
  lines.push('# Fresh verification');
  lines.push('');
  lines.push('You are an independent verifier. Decide, for every acceptance criterion below, whether the delivery diff satisfies it.');
  lines.push('Judge the behaviour the criterion demands, not the author\'s intent. A criterion you cannot tie to the diff is `unverified`.');
  lines.push('');
  lines.push(`## Acceptance Criteria (${criteria.length})`);
  lines.push('');
  lines.push(criteriaBlock(criteria.map(ac => ({ id: ac.id.trim(), text: ac.text }))));
  lines.push('');
  lines.push(`## Delivery Diff (${Buffer.byteLength(diff, 'utf8')} bytes)`);
  lines.push('');
  lines.push(`${fence}diff`);
  lines.push(diff || '(empty diff)');
  lines.push(fence);
  lines.push('');
  lines.push('## Verdict Contract');
  lines.push('');
  lines.push('Reply with JSON only, in this shape:');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "criteria": [');
  lines.push('    { "id": "AC1", "verdict": "verified" }');
  lines.push('  ],');
  lines.push('  "residualDefects": []');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push(`Write exactly one entry per acceptance criterion. The only accepted verdict values are ${VERDICT_VALUES.map(value => `\`${value}\``).join(' and ')}. A missing criterion, a duplicate criterion id, or any other value is rejected.`);
  lines.push('');
  return lines.join('\n');
}

// Spec 00018 AC4: exactly one verdict per acceptance criterion, each with the
// value `verified` or `unverified`. Every defect is named so a rejection is
// actionable, and extra per-criterion evidence fields are preserved for the
// later fault-injection and audit slices.
function validateVerdict(raw, criteria) {
  const acs = Array.isArray(criteria) ? criteria : [];
  const errors = [];
  const verdicts = [];
  const knownIds = new Set(acs.map(ac => String(ac.id).trim()));

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      errors: ['Verdict must be a JSON object of the shape {"criteria": [{"id": "AC1", "verdict": "verified"}]}.'],
      verdicts: [],
      residualDefects: []
    };
  }

  const entries = raw.criteria;
  if (!Array.isArray(entries)) {
    errors.push('Verdict "criteria" must be an array with exactly one entry per acceptance criterion.');
  } else {
    const seen = new Set();
    entries.forEach((entry, index) => {
      const label = `criteria[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${label} must be an object.`);
        return;
      }
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!id) {
        errors.push(`${label} is missing an acceptance-criterion id.`);
        return;
      }
      if (!knownIds.has(id)) {
        errors.push(`${label} names unknown acceptance criterion "${id}".`);
        return;
      }
      if (seen.has(id)) {
        errors.push(`Duplicate verdict for ${id}; exactly one verdict per acceptance criterion is required.`);
        return;
      }
      seen.add(id);
      const value = typeof entry.verdict === 'string' ? entry.verdict.trim() : '';
      if (!VERDICT_VALUES.includes(value)) {
        errors.push(`Invalid verdict value for ${id}: ${JSON.stringify(entry.verdict)}; expected "verified" or "unverified".`);
        return;
      }
      verdicts.push({ ...entry, id, verdict: value });
    });

    const missing = acs.map(ac => String(ac.id).trim()).filter(id => !seen.has(id));
    if (missing.length > 0) {
      errors.push(`Missing verdict for ${missing.join(', ')}; exactly one verdict per acceptance criterion is required.`);
    }
  }

  const residualDefects = Array.isArray(raw.residualDefects) ? raw.residualDefects : [];
  return { valid: errors.length === 0, errors, verdicts, residualDefects };
}

function readVerdictFile(verdictFileAbs) {
  if (!verdictFileAbs || !fs.existsSync(verdictFileAbs)) {
    return { ok: false, error: `Verdict file not found: "${normalizePath(verdictFileAbs || '')}".` };
  }
  try {
    return { ok: true, verdict: JSON.parse(fs.readFileSync(verdictFileAbs, 'utf8')) };
  } catch (err) {
    return { ok: false, error: `Verdict file "${normalizePath(verdictFileAbs)}" is not valid JSON: ${err.message}` };
  }
}

// Spec 00018 AC2/AC3: one call that builds the diff, creates the scratch
// worktree, and writes the fenced prompt. Any failure after the worktree exists
// removes it before rethrowing, so a failed start never leaves isolation behind.
function startVerification(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const criteria = Array.isArray(options.criteria) ? options.criteria : [];
  const artifacts = resolveArtifactPaths(projectRoot, options.artifactsDir);
  const scratchDir = options.scratchDir || resolveScratchDir(projectRoot, options.runId);
  const diff = collectDeliveryDiff(projectRoot, options.baseCommit);
  const prompt = renderVerifierPrompt({ criteria, diff: diff.text });
  const scratch = createScratchWorktree({
    projectRoot,
    baseCommit: options.baseCommit,
    diff: diff.text,
    scratchDir
  });

  try {
    fs.mkdirSync(artifacts.dirAbs, { recursive: true });
    fs.writeFileSync(artifacts.promptFileAbs, prompt, 'utf8');
  } catch (err) {
    const cleanup = removeScratchWorktree({ projectRoot, worktreePath: scratch.path });
    throw new FreshVerifyError(
      `Writing the fresh-verify prompt failed: ${err.message}${cleanup.ok ? '' : `; scratch cleanup also failed: ${cleanup.error}`}`,
      { code: 'prompt_write_failed' }
    );
  }

  return {
    diff,
    prompt,
    scratch,
    promptFileAbs: artifacts.promptFileAbs,
    promptFileRel: artifacts.promptFileRel,
    verdictFileAbs: artifacts.verdictFileAbs,
    verdictFileRel: artifacts.verdictFileRel
  };
}

// Spec 00018 AC4/AC10: validate the verdict and remove the scratch worktree on
// both outcomes. Cleanup is attempted even when validation fails, and a failed
// cleanup is reported with the result instead of being swallowed.
function completeVerification(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const validation = validateVerdict(options.verdict, options.criteria);
  const cleanup = options.worktreePath
    ? removeScratchWorktree({ projectRoot, worktreePath: options.worktreePath })
    : { ok: true, removed: false, reason: 'no_worktree' };
  return { validation, cleanup };
}

module.exports = {
  FreshVerifyError,
  VERDICT_VALUES,
  SCRATCH_ROOT_REL,
  SCRATCH_DIRNAME,
  PROMPT_FILE_NAME,
  VERDICT_FILE_NAME,
  FENCED_PROMPT_KEYS,
  normalizePath,
  resolveScratchDir,
  resolveArtifactPaths,
  collectDeliveryDiff,
  createScratchWorktree,
  removeScratchWorktree,
  readFaultPlan,
  planFaults,
  runTestCommand,
  describeTestObservation,
  runFaultInjection,
  applyFaultEvidence,
  renderVerifierPrompt,
  validateVerdict,
  readVerdictFile,
  startVerification,
  completeVerification
};
