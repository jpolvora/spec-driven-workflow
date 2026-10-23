#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const stateManager = require('./state_manager.cjs');
const specDerivation = require('./spec_derivation.cjs');
const specGrilling = require('./spec_grilling.cjs');
const dagPlanner = require('./dag_planner.cjs');
const scoreEvaluator = require('./score_evaluator.cjs');
const artifactWriter = require('./artifact_writer.cjs');
const implementationRunner = require('./implementation_runner.cjs');
const evidenceValidator = require('./evidence_validator.cjs');
const sandbox = require('./sandbox.cjs');
const deliveryReport = require('./delivery_report.cjs');
const memory = require('../../sdw-memory/scripts/sdw_memory.cjs');

// Spec 00043: short, consistent step-number progress headers. Additive only:
// plain text for humans and grep, no state or exit-code change.
const STEP_PROGRESS_NAMES = {
  1: 'Derivation',
  2: 'Refinement',
  3: 'DAG Generation',
  4: 'Implementation',
  5: 'Conformance Scoring',
  6: 'Delivery Commit',
  7: 'Delegated Review',
  8: 'PR Preparation'
};
function logStepEnter(step) {
  console.log(`[Step ${step}/8] Entering Step ${step}: ${STEP_PROGRESS_NAMES[step]}.`);
}
function logStepDone(step) {
  console.log(`[Step ${step}/8] Completed Step ${step}: ${STEP_PROGRESS_NAMES[step]}.`);
}
function logRunStarted(runId, specSlug, currentStep) {
  console.log(`[Step ${currentStep}/8] Run "${runId}" started (${specSlug}).`);
}
function logRunResumed(runId, specSlug, currentStep) {
  console.log(`[Step ${currentStep}/8] Run "${runId}" resumed (${specSlug}).`);
}
function getStepTaskTotals(state) {
  const dagTasks = (Array.isArray(state.dagTasks) && state.dagTasks.length > 0)
    ? state.dagTasks
    : ((state.steps && state.steps[3] && state.steps[3].output && state.steps[3].output.tasks) || []);
  const total = dagTasks.length;
  const done = Object.values((state.steps && state.steps[4] && state.steps[4].tasks) || {})
    .filter(t => t && t.status === 'completed').length;
  return { total, done };
}
function logTaskAccepted(state, taskId) {
  const { total, done } = getStepTaskTotals(state);
  console.log(`[Step 4/8] Task ${done}/${total} (${taskId}) accepted.`);
}

function resolveSkillScript(targetRoot, skillName, scriptRelPath, options = {}) {
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    if (sdwConfig && typeof sdwConfig.resolveSkillsRoot === 'function') {
      const info = sdwConfig.resolveSkillsRoot({
        root: targetRoot,
        callerDir: options.callerDir !== undefined ? options.callerDir : __dirname,
        homeDir: options.homeDir,
        ignoreCaller: options.ignoreCaller,
        skillsRoot: options.skillsRoot
      });
      if (info && info.exists && info.skillsRoot) {
        const candidate = path.join(info.skillsRoot, skillName, scriptRelPath);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch (e) {}
  // An explicit or configured root that failed validation must fail closed
  // instead of silently resolving scripts from a co-located installation (AC9).
  if (options.skillsRoot) return null;
  if (!options.ignoreCaller) {
    const fallback = path.resolve(__dirname, '../../', skillName, scriptRelPath);
    return fs.existsSync(fallback) ? fallback : null;
  }
  return null;
}

function getSpecIndexHelper(targetRoot, options = {}) {
  try {
    const scriptPath = resolveSkillScript(targetRoot, 'sdw-spec', path.join('scripts', 'spec_index.cjs'), options);
    if (scriptPath) {
      return require(scriptPath);
    }
  } catch (e) {}
  try {
    return require('../../sdw-spec/scripts/spec_index.cjs');
  } catch (e) {
    return null;
  }
}

function getScmProviderContract(targetRoot, options = {}) {
  try {
    const scriptPath = resolveSkillScript(targetRoot, 'sdw-spec', path.join('scripts', 'scm_provider_contract.cjs'), options);
    if (scriptPath) {
      return require(scriptPath);
    }
  } catch (e) {}
  try {
    return require('../../sdw-spec/scripts/scm_provider_contract.cjs');
  } catch (e) {
    return null;
  }
}

function parseArgs(args) {
  const result = {
    subcommand: null,
    specPath: null,
    specPaths: [],
    dryRun: false,
    runId: null,
    root: null,
    minScore: undefined,
    skipReview: false,
    skipPr: false,
    pollPr: undefined,
    push: false,
    abortOnGaps: false,
    simulateFailure: false,
    force: false,
    allowArchived: false,
    step: null,
    json: false,
    latest: false,
    unattended: false,
    skipSecurity: false,
    sandbox: false,
    noWorktrees: false,
    worktrees: false,
    noTaskCheckpoint: false,
    noFeatureBranch: false,
    featureBranch: false,
    taskId: null,
    evidencePath: null,
    verdictPath: null,
    reason: null,
    skillsRoot: null,
    implementationMode: null,
    refineMode: false,
    newRun: false
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--unattended') result.unattended = true;
    else if (arg === '--interactive') result.unattended = false;
    else if (arg === '--skip-security') result.skipSecurity = true;
    else if (arg === '--no-worktrees') result.noWorktrees = true;
    else if (arg === '--worktrees') result.worktrees = true;
    else if (arg === '--no-task-checkpoint') result.noTaskCheckpoint = true;
    else if (arg === '--no-feature-branch') result.noFeatureBranch = true;
    else if (arg === '--feature-branch') result.featureBranch = true;
    else if (arg === '--skip-review') result.skipReview = true;
    else if (arg === '--skip-pr') result.skipPr = true;
    else if (arg === '--poll-pr') result.pollPr = true;
    else if (arg === '--push') result.push = true;
    else if (arg === '--abort-on-gaps') result.abortOnGaps = true;
    else if (arg === '--simulate-failure') result.simulateFailure = true;
    else if (arg === '--force') result.force = true;
    else if (arg === '--allow-archived') result.allowArchived = true;
    else if (arg === '--second-pass' || arg === '--refine') result.refineMode = true;
    else if (arg === '--new-run') result.newRun = true;
    else if (arg === '--latest') result.latest = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--sandbox') result.sandbox = true;
    else if (arg === '--root') result.root = args[++i];
    else if (arg.startsWith('--root=')) result.root = arg.slice(7);
    else if (arg === '--skills-root') result.skillsRoot = args[++i];
    else if (arg.startsWith('--skills-root=')) result.skillsRoot = arg.slice(14);
    else if (arg === '--run-id') result.runId = args[++i];
    else if (arg.startsWith('--run-id=')) result.runId = arg.slice(9);
    else if (arg === '--task' || arg === '--task-id') result.taskId = args[++i];
    else if (arg.startsWith('--task=')) result.taskId = arg.slice(7);
    else if (arg.startsWith('--task-id=')) result.taskId = arg.slice(10);
    else if (arg === '--evidence' || arg === '--evidence-path') result.evidencePath = args[++i];
    else if (arg.startsWith('--evidence=')) result.evidencePath = arg.slice(11);
    else if (arg.startsWith('--evidence-path=')) result.evidencePath = arg.slice(16);
    else if (arg === '--mode') result.implementationMode = args[++i];
    else if (arg.startsWith('--mode=')) result.implementationMode = arg.slice(7);
    else if (arg === '--verdict') result.verdictPath = args[++i];
    else if (arg.startsWith('--verdict=')) result.verdictPath = arg.slice(10);
    else if (arg === '--reason') result.reason = args[++i];
    else if (arg.startsWith('--reason=')) result.reason = arg.slice(9);
    else if (arg === '--step') result.step = parseInt(args[++i], 10);
    else if (arg.startsWith('--step=')) result.step = parseInt(arg.slice(7), 10);
    else if (arg === '--min-score') result.minScore = parseInt(args[++i], 10);
    else if (arg.startsWith('--min-score=')) result.minScore = parseInt(arg.slice(12), 10);
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  const COMBINED = {
    'task finish': 'task-finish',
    'task next': 'task-next',
    'task abandon': 'task-abandon',
    'score submit': 'score-submit',
    'report re-render': 'report-re-render'
  };
  const combinedMatch = COMBINED[positional.slice(0, 2).join(' ')];
  if (combinedMatch) {
    result.subcommand = combinedMatch;
    const rest = positional.slice(2);
    result.specPaths = [];
    result.specPath = null;
    if (!result.taskId && rest[0]) result.taskId = rest[0];
    if (combinedMatch === 'task-finish' && !result.evidencePath && rest[1]) result.evidencePath = rest[1];
    if (combinedMatch === 'task-abandon' && !result.reason && rest[1]) result.reason = rest[1];
  } else if (['task-finish', 'task-next', 'task-abandon', 'score-submit', 'report-re-render'].includes(positional[0])) {
    result.subcommand = positional[0];
    const rest = positional.slice(1);
    result.specPaths = [];
    result.specPath = null;
    if (!result.taskId && rest[0]) result.taskId = rest[0];
    if (result.subcommand === 'task-finish' && !result.evidencePath && rest[1]) result.evidencePath = rest[1];
    if (result.subcommand === 'task-abandon' && !result.reason && rest[1]) result.reason = rest[1];
  } else {
    result.subcommand = positional[0] || null;
    result.specPaths = positional.slice(1);
    result.specPath = positional[1] || null;
  }

  return result;
}

function getBaseCommit(projectRoot) {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
}

// Latest delivery commit recorded for a completed run of this specification.
// A second pass uses it as the base so scoring and review see the delivered
// implementation, not only the refinement delta.
function findPriorDeliveryCommit(targetRoot, specSlug) {
  try {
    const root = path.resolve(targetRoot);
    let stateDir = path.join(root, '.sdw', 'state');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(root, '.sdw', 'config.json'), 'utf8'));
      if (raw && typeof raw.stateDir === 'string' && raw.stateDir.trim()) {
        stateDir = path.resolve(raw.stateDir.replace(/\{projectRoot\}/g, root));
      }
    } catch (e) {}
    if (!fs.existsSync(stateDir)) return null;
    const runs = fs.readdirSync(stateDir)
      .filter(name => name.endsWith('.state.json'))
      .map(name => {
        try {
          return JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        } catch (e) {
          return null;
        }
      })
      .filter(run => run && run.specSlug === specSlug && run.status === 'completed' && run.deliveryCommit)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return runs.length > 0 ? runs[0].deliveryCommit : null;
  } catch (e) {
    return null;
  }
}

function isGitRepo(projectRoot) {
  try {
    const res = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: projectRoot, stdio: 'ignore' });
    return res.status === 0;
  } catch (e) {
    return false;
  }
}

function assertSafeSlug(specSlug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(specSlug))) {
    throw new Error(
      `Invalid specification slug "${specSlug}". Expected lowercase letters, digits, and hyphens (^[a-z0-9][a-z0-9-]*$).`
    );
  }
}

// True when `ancestor` is reachable from `descendant`; a missing ref is never an
// ancestor. Used to decide whether a refreshed remote lane can seed a branch.
function isAncestorCommit(targetRoot, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  try {
    return spawnSync('git', ['merge-base', '--is-ancestor', String(ancestor), String(descendant)], {
      cwd: targetRoot,
      stdio: 'ignore'
    }).status === 0;
  } catch (e) {
    return false;
  }
}

function git(targetRoot, args, options = {}) {
  const result = spawnSync('git', args, { cwd: targetRoot, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? String(result.stderr).trim() : '';
    throw new Error(stderr || `git ${args.join(' ')} failed (exit ${result.status})`);
  }
  return result.stdout;
}

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

// Emitted commands must work under any install topology (spec 026 AC10): resolve
// this CLI from its own location instead of assuming {projectRoot}/skills exists.
function followUpRootFlag(root) {
  try {
    return sandbox.readMarker(root) ? ` --root "${normalizePath(root)}"` : '';
  } catch (e) {
    return '';
  }
}

function orchCommandPath() {
  return __filename.replace(/\\/g, '/');
}

// Spec 00037 AC15 / spec 00045 AC1-AC3: a successful delivery records the exact
// retro command. `retro.enabled` decides whether sdw-orch also runs it.
function retroScriptPath(targetRoot) {
  return resolveSkillScript(targetRoot, 'sdw-retro', path.join('scripts', 'retro.cjs'))
    || path.resolve(__dirname, '../../sdw-retro/scripts/retro.cjs');
}

function retroCommandFor(targetRoot, runId) {
  return `node "${normalizePath(retroScriptPath(targetRoot))}" run --run-id ${runId} --root "${normalizePath(targetRoot)}"`;
}

// Runs sdw-retro for a completed run and normalizes the outcome into the shape
// recorded on state.retro (AC1). A non-zero exit, a missing report, or an
// unparsable payload is a recorded failure (AC2); it never throws.
function runRetroForCompletedRun(targetRoot, state) {
  const retro = {
    status: 'failed',
    reportMd: null,
    reportJson: null,
    error: null,
    ranAt: new Date().toISOString()
  };
  const result = spawnSync(process.execPath, [
    retroScriptPath(targetRoot),
    'run',
    '--run-id', state.runId,
    '--root', targetRoot,
    '--json'
  ], { cwd: targetRoot, encoding: 'utf8' });
  if (result.error) {
    retro.error = result.error.message;
    return retro;
  }
  if (result.status !== 0) {
    retro.error = String(result.stderr || '').trim() || `sdw-retro exited with code ${result.status}`;
    return retro;
  }
  let report;
  try {
    report = JSON.parse(result.stdout || '');
  } catch (parseError) {
    retro.error = `sdw-retro returned unparsable JSON: ${parseError.message}`;
    return retro;
  }
  const outputs = report && report.outputs;
  if (!outputs || typeof outputs.markdown !== 'string' || typeof outputs.json !== 'string') {
    retro.error = 'sdw-retro did not declare report output paths';
    return retro;
  }
  retro.status = 'passed';
  retro.reportMd = normalizePath(outputs.markdown);
  retro.reportJson = normalizePath(outputs.json);
  return retro;
}

// Spec 00045 AC4: a specification with a run that never reached a terminal
// status must be resumed, not restarted. Returns the open runs, newest first.
// The guard is read-only: a missing state directory means no run exists.
function findOpenRunsForSpec(stateDir, specSlug) {
  if (!fs.existsSync(stateDir)) return [];
  const open = [];
  for (const name of fs.readdirSync(stateDir)) {
    if (!name.endsWith('.state.json')) continue;
    let run = null;
    try {
      run = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
    } catch (e) {
      continue;
    }
    if (!run || run.specSlug !== specSlug) continue;
    if (run.status === 'completed' || run.status === 'failed') continue;
    open.push({
      runId: run.runId || name.replace(/\.state\.json$/, ''),
      status: run.status || 'unknown',
      createdAt: run.createdAt || ''
    });
  }
  open.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return open;
}

function isScopedExcluded(rel) {
  const n = normalizeRel(rel);
  return n.startsWith('.sdw/state/') || n === '.sdw/state'
    || n.startsWith('.sdw/worktrees/') || n === '.sdw/worktrees'
    || n.startsWith('.sdw/sandbox/') || n === '.sdw/sandbox'
    || n.startsWith('.git/');
}

function getStatusFiles(targetRoot) {
  try {
    const out = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return [];
    return out.split('\n')
      .map(l => l.trim().replace(/^[A-Z?]{1,2}\s+/, '').trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean)
      .map(normalizeRel)
      .filter(f => !isScopedExcluded(f));
  } catch (e) {
    return [];
  }
}

function statSignature(targetRoot, rel) {
  try {
    const abs = path.join(targetRoot, rel);
    if (!fs.existsSync(abs)) return '<deleted>';
    const st = fs.statSync(abs);
    if (!st.isFile()) return '<dir>';
    return `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    return '<error>';
  }
}

function snapshotStats(targetRoot) {
  const m = new Map();
  for (const f of getStatusFiles(targetRoot)) {
    m.set(f, statSignature(targetRoot, f));
  }
  return m;
}

function diffSinceSnapshot(targetRoot, beforeStats) {
  const afterFiles = getStatusFiles(targetRoot);
  const delta = [];
  for (const f of afterFiles) {
    const before = beforeStats ? beforeStats.get(f) : undefined;
    const now = statSignature(targetRoot, f);
    if (before === undefined || before !== now) delta.push(f);
  }
  return delta;
}

function isGitTracked(targetRoot, rel) {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: targetRoot, encoding: 'utf8', stdio: 'ignore' });
  return r.status === 0;
}

function stageAndCommitOnly(targetRoot, files, message) {
  if (!isGitRepo(targetRoot)) {
    return { committed: false, commitSha: null, files: [] };
  }
  const clean = [...new Set((files || []).map(normalizeRel))]
    .filter(f => f && !f.includes('..') && !path.isAbsolute(f) && !/^[a-zA-Z]:/.test(f) && !isScopedExcluded(f));
  const stageable = [];
  for (const f of clean) {
    const abs = path.join(targetRoot, f);
    if (fs.existsSync(abs)) {
      stageable.push(f);
    } else if (isGitTracked(targetRoot, f)) {
      stageable.push(f);
    }
  }
  if (stageable.length === 0) {
    return { committed: false, commitSha: getBaseCommit(targetRoot), files: [] };
  }
  git(targetRoot, ['add', '--', ...stageable], { stdio: 'ignore' });
  // Both the emptiness probe and the commit are scoped to the requested paths:
  // an index entry staged elsewhere (by an earlier step or by the operator)
  // must never ride along under this commit's subject.
  let staged = '';
  try {
    const probe = spawnSync('git', ['diff', '--cached', '--name-only', '--', ...stageable], {
      cwd: targetRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    staged = probe && probe.stdout ? String(probe.stdout).trim() : '';
  } catch (e) {
    staged = '';
  }
  if (!staged) {
    return { committed: false, commitSha: getBaseCommit(targetRoot), files: stageable };
  }
  git(targetRoot, ['commit', '-m', message, '--only', '--', ...stageable], { stdio: 'ignore' });
  return { committed: true, commitSha: getBaseCommit(targetRoot), files: stageable };
}

// Spec 00044 AC3: an accepted task is checkpointed immediately, not only at the
// Step 6 delivery commit. One scoped commit plus one tag per task keeps the work
// recoverable across a crash between tasks; the Step 6 exclusions apply.
function checkpointRefName(runId, taskId) {
  const part = value => String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '') || 'task';
  return `sdw-checkpoint-${part(runId)}-${part(taskId)}`;
}

function checkpointTask(targetRoot, { specSlug, runId, taskId, files = [], commitSha = null }) {
  let sha = commitSha;
  if (!sha) {
    const res = stageAndCommitOnly(targetRoot, files, `task(${specSlug}): ${taskId}`);
    if (!res.committed) return { commitSha: res.commitSha, tag: null, tagError: null };
    sha = res.commitSha;
  }
  const tag = checkpointRefName(runId, taskId);
  try {
    git(targetRoot, ['tag', '-f', tag, sha], { stdio: 'ignore' });
  } catch (tagErr) {
    // PR #34 review finding: the commit (or the integrated cherry-pick) is already
    // durable, and committed work can never be re-corroborated on retry. A tag that
    // cannot be written is reported, not raised, so the task is still accepted.
    return { commitSha: sha, tag: null, tagError: tagErr.message };
  }
  return { commitSha: sha, tag, tagError: null };
}

function collectDeliveryFiles(targetRoot, specSlug, state) {
  const files = new Set();
  const tasks = (state && state.steps && state.steps[4] && state.steps[4].tasks) || {};
  for (const t of Object.values(tasks)) {
    if (t && t.status === 'completed' && Array.isArray(t.filesChanged)) {
      for (const f of t.filesChanged) {
        const n = normalizeRel(String(f || '').trim());
        if (n && !n.includes('..') && !path.isAbsolute(n) && !/^[a-zA-Z]:/.test(n) && !isScopedExcluded(n)) {
          files.add(n);
        }
      }
    }
    if (t && t.status === 'completed' && Array.isArray(t.acIds) && t.filesChanged === undefined && Array.isArray(t.files)) {
      for (const f of t.files) {
        const n = normalizeRel(String(f || '').trim());
        if (n && !n.includes('..') && !path.isAbsolute(n) && !isScopedExcluded(n)) files.add(n);
      }
    }
  }
  try {
    const cfg = loadProjectConfig(targetRoot);
    const specsDirAbs = cfg && cfg.specsDir ? path.resolve(cfg.specsDir) : path.join(path.resolve(targetRoot), '.sdw', 'specs');
    const idxAbs = path.join(specsDirAbs, 'index.specs.md');
    if (fs.existsSync(idxAbs)) {
      const rel = normalizeRel(path.relative(path.resolve(targetRoot), idxAbs));
      if (rel && !rel.includes('..') && !isScopedExcluded(rel)) files.add(rel);
    }
  } catch (e) {}
  const fallbackIdx = '.sdw/specs/index.specs.md';
  try {
    if (fs.existsSync(path.join(path.resolve(targetRoot), fallbackIdx))) files.add(fallbackIdx);
  } catch (e) {}
  if (state && state.specPath) {
    try {
      const relSpec = normalizeRel(path.relative(path.resolve(targetRoot), path.resolve(state.specPath)));
      if (relSpec && !relSpec.includes('..') && !isScopedExcluded(relSpec) && fs.existsSync(path.resolve(targetRoot, relSpec))) {
        files.add(relSpec);
      }
    } catch (e) {}
  }
  return [...files].sort();
}

// AC17/AC19: the two paths the completion transition owns. They are committed
// together and scoped, so the merged pull request carries the flip instead of
// leaving it as a worktree change that only a later sync propagates.
function completedTransitionFiles(targetRoot, state) {
  const files = [];
  const root = path.resolve(targetRoot);
  try {
    const cfg = loadProjectConfig(root);
    const specsDirAbs = cfg && cfg.specsDir ? path.resolve(cfg.specsDir) : path.join(root, '.sdw', 'specs');
    const idxRel = normalizeRel(path.relative(root, path.join(specsDirAbs, 'index.specs.md')));
    if (idxRel && !idxRel.includes('..') && fs.existsSync(path.join(root, idxRel))) files.push(idxRel);
  } catch (e) {}
  if (state && state.specPath) {
    try {
      const specRel = normalizeRel(path.relative(root, path.resolve(root, state.specPath)));
      if (specRel && !specRel.includes('..') && fs.existsSync(path.join(root, specRel))) files.push(specRel);
    } catch (e) {}
  }
  return [...new Set(files)].sort();
}

// True when the branch already has a remote tracking ref on origin, so a commit
// created after the delivery stage still has a published branch to land on.
function branchIsPublished(targetRoot, branch) {
  if (!branch || branch === 'HEAD') return false;
  try {
    return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
      cwd: targetRoot,
      stdio: 'ignore'
    }).status === 0;
  } catch (e) {
    return false;
  }
}

function runSecurityGate(targetRoot, options = {}) {
  try {
    const scriptPath = resolveSkillScript(targetRoot, 'sdw-security-checks', path.join('scripts', 'sdw_security_checks.cjs'), options);
    const secScanner = scriptPath ? require(scriptPath) : require('../../sdw-security-checks/scripts/sdw_security_checks.cjs');
    if (secScanner && typeof secScanner.scan === 'function') {
      return secScanner.scan({ root: targetRoot, staged: options.staged !== false });
    }
  } catch (e) {
    return {
      exitCode: 2,
      severityCounts: { high: 0, medium: 0, advisory: 0 },
      findings: [],
      error: `Security scanner failed to load: ${e.message}`
    };
  }
  return {
    exitCode: 2,
    severityCounts: { high: 0, medium: 0, advisory: 0 },
    findings: [],
    error: 'Security scanner module unavailable'
  };
}

function runVerificationGates(targetRoot, config, options = {}) {
  const gates = {};
  let passed = true;
  const specSlug = options.slug || options.specSlug || (options.runId ? options.runId.replace(/^run-\d+-/, '') : 'feature');
  const runId = options.runId;

  const verificationConfig = (config && config.verification) || {};
  const gateTimeoutMs = Number(verificationConfig.timeoutMs) > 0
    ? Number(verificationConfig.timeoutMs)
    : 600000;
  const reqBuild = options.requiredBuild !== undefined
    ? options.requiredBuild
    : Boolean(config.requiredBuild || (verificationConfig.buildCommand && typeof verificationConfig.buildCommand === 'string'));
  const reqTests = options.runAllTests !== undefined
    ? options.runAllTests
    : Boolean(config.runAllTests || (verificationConfig.testCommand && typeof verificationConfig.testCommand === 'string'));

  if (reqBuild) {
    const buildCmd = (config.verification && config.verification.buildCommand) || config.buildCommand || 'npm run build';
    console.log(`[Step 4: Verification Gate] Executing build command: "${buildCmd}"...`);
    const start = Date.now();
    let buildPassed = false;
    let buildAttempts = 0;
    const maxFixAttempts = (typeof options.buildFixer === 'function') ? 3 : 0;
    let lastErr = null;

    while (!buildPassed && buildAttempts <= maxFixAttempts) {
      try {
        execSync(buildCmd, { cwd: targetRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: gateTimeoutMs });
        buildPassed = true;
        const durationMs = Date.now() - start;
        gates.build = { status: 'passed', exitCode: 0, durationMs };
        console.log(`[Step 4: Verification Gate] Build passed (${durationMs}ms).`);
      } catch (err) {
        lastErr = err;
        buildAttempts++;
        if (buildAttempts > maxFixAttempts) {
          const durationMs = Date.now() - start;
          const errMsg = maxFixAttempts > 0
            ? `Build verification failed after ${maxFixAttempts} attempt(s): ${err.message}`
            : `Build verification failed: ${err.message}`;
          gates.build = { status: 'failed', exitCode: err.status || 1, durationMs, error: errMsg };
          console.error(`[Step 4: Verification Gate] ${errMsg}`);
          if (runId) {
            stateManager.recordError(targetRoot, runId, 4, errMsg);
          }
          passed = false;
          break;
        }

        console.log(`[Step 4: Verification Gate] Build failed. Attempting automated surgical fix (attempt ${buildAttempts}/${maxFixAttempts})...`);
        const fixBefore = snapshotStats(targetRoot);
        if (typeof options.buildFixer === 'function') {
          options.buildFixer(targetRoot, buildAttempts);
        }
        const fixDelta = diffSinceSnapshot(targetRoot, fixBefore);
        if (fixDelta.length > 0) {
          if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
            const sec = runSecurityGate(targetRoot, { staged: false });
            if (sec.exitCode !== 0) {
              console.error(`[Step 4: Verification Gate] Fix commit rejected: secret leak detected.`);
              if (runId) {
                stateManager.recordError(targetRoot, runId, 4, 'Fix commit rejected: secret leak detected');
              }
              passed = false;
              gates.build = { status: 'failed', exitCode: 1, durationMs: Date.now() - start, error: 'Fix commit rejected: secret leak detected' };
              break;
            }
          }
          stageAndCommitOnly(targetRoot, fixDelta, `fix(${specSlug}): resolve build failure (attempt ${buildAttempts})`);
        }
      }
    }
  }

  if (reqTests && passed) {
    const testCmd = (config.verification && config.verification.testCommand) || config.testCommand || 'npm test';
    console.log(`[Step 4: Verification Gate] Executing test command: "${testCmd}"...`);
    const start = Date.now();
    let testPassed = false;
    let testAttempts = 0;
    const maxFixAttempts = (typeof options.testFixer === 'function') ? 3 : 0;
    let lastErr = null;

    while (!testPassed && testAttempts <= maxFixAttempts) {
      try {
        execSync(testCmd, { cwd: targetRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: gateTimeoutMs });
        testPassed = true;
        const durationMs = Date.now() - start;
        gates.test = { status: 'passed', exitCode: 0, durationMs };
        console.log(`[Step 4: Verification Gate] Tests passed (${durationMs}ms).`);
      } catch (err) {
        lastErr = err;
        testAttempts++;
        if (testAttempts > maxFixAttempts) {
          const durationMs = Date.now() - start;
          const errMsg = maxFixAttempts > 0
            ? `Test verification failed after ${maxFixAttempts} attempt(s): ${err.message}`
            : `Test verification failed: ${err.message}`;
          gates.test = { status: 'failed', exitCode: err.status || 1, durationMs, error: errMsg };
          console.error(`[Step 4: Verification Gate] ${errMsg}`);
          if (runId) {
            stateManager.recordError(targetRoot, runId, 4, errMsg);
          }
          passed = false;
          break;
        }

        console.log(`[Step 4: Verification Gate] Tests failed. Attempting automated surgical fix (attempt ${testAttempts}/${maxFixAttempts})...`);
        const testFixBefore = snapshotStats(targetRoot);
        if (typeof options.testFixer === 'function') {
          options.testFixer(targetRoot, testAttempts);
        }
        const testFixDelta = diffSinceSnapshot(targetRoot, testFixBefore);
        if (testFixDelta.length > 0) {
          if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
            const sec = runSecurityGate(targetRoot, { staged: false });
            if (sec.exitCode !== 0) {
              console.error(`[Step 4: Verification Gate] Fix commit rejected: secret leak detected.`);
              if (runId) {
                stateManager.recordError(targetRoot, runId, 4, 'Fix commit rejected: secret leak detected');
              }
              passed = false;
              gates.test = { status: 'failed', exitCode: 1, durationMs: Date.now() - start, error: 'Fix commit rejected: secret leak detected' };
              break;
            }
          }
          stageAndCommitOnly(targetRoot, testFixDelta, `fix(${specSlug}): resolve test failure (attempt ${testAttempts})`);
        }
      }
    }
  }

  return { passed, gates };
}

function loadProjectConfig(targetRoot, options = {}) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  let config = null;

  try {
    const scriptPath = resolveSkillScript(root, 'sdw-config', path.join('scripts', 'sdw_config.cjs'), options);
    const sdwConfig = scriptPath ? require(scriptPath) : require('../../sdw-config/scripts/sdw_config.cjs');
    if (sdwConfig && typeof sdwConfig.loadConfig === 'function') {
      config = sdwConfig.loadConfig(root, options);
    }
  } catch (e) {}

  if (!config) {
    const configFile = path.join(root, '.sdw', 'config.json');
    let raw = null;
    if (fs.existsSync(configFile)) {
      try { raw = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) {}
    }
    const normRoot = root.replace(/\\/g, '/');
    const resolved = {};
    for (const [k, v] of Object.entries(raw || {})) {
      resolved[k] = typeof v === 'string' ? v.replace(/\{projectRoot\}/g, normRoot) : v;
    }
    config = {
      specsDir: path.join(root, '.sdw', 'specs').replace(/\\/g, '/'),
      scoreMin: 8,
      scmCodeReviewEnabled: false,
      pushDelivery: false,
      stateDir: path.join(root, '.sdw', 'state').replace(/\\/g, '/'),
      autoResolveGaps: false,
      securityChecksEnabled: false,
      useWorktrees: false,
      useFeatureBranches: false,
      scmProvider: 'none',
      ...resolved
    };
  }

  // Every subcommand that reads configuration from a sandbox clone must inherit
  // the isolation, not only cmdRun. The marker is the single source of truth.
  const marker = sandbox.readMarker(root);
  if (marker) {
    applySandboxIsolation(config, options, {
      runId: marker.runId,
      root,
      branch: marker.branch,
      sourceRoot: marker.sourceRoot
    });
    options._effectiveRoot = root;
  }
  return config;
}

function resolveSpecPath(specInput, targetRoot, config) {
  if (!specInput) return null;
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();

  // Try direct path first
  const directPath = path.isAbsolute(specInput) ? specInput : path.resolve(root, specInput);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  // Try inside configured specsDir
  if (config && config.specsDir) {
    const insideSpecsDir = path.resolve(config.specsDir, specInput);
    if (fs.existsSync(insideSpecsDir)) return insideSpecsDir;
    if (fs.existsSync(`${insideSpecsDir}.md`)) return `${insideSpecsDir}.md`;
    if (fs.existsSync(`${insideSpecsDir}.spec.md`)) return `${insideSpecsDir}.spec.md`;
  }

  // Try inside default .sdw/specs
  const insideDefault = path.resolve(root, '.sdw', 'specs', specInput);
  if (fs.existsSync(insideDefault)) return insideDefault;
  if (fs.existsSync(`${insideDefault}.md`)) return `${insideDefault}.md`;

  return directPath;
}

function resolveSandboxDir(config, root) {
  const value = config && typeof config.sandboxDir === 'string' ? config.sandboxDir : '';
  return sandbox.sandboxParent(root, value);
}

function applySandboxIsolation(config, options, meta) {
  options._sandbox = meta;
  options.push = false;
  config.pushDelivery = false;
  config.scmProvider = 'none';
  config.scmCodeReviewEnabled = false;
  config.useFeatureBranches = false;
  config.useWorktrees = false;
  return config;
}

function buildBranchPlan(branching, specSlug) {
  const integrationBranch = typeof branching.integrationBranch === 'string' && branching.integrationBranch.trim()
    ? branching.integrationBranch.trim()
    : 'auto (origin/HEAD)';
  const workBranch = typeof branching.workBranch === 'string' && branching.workBranch.trim()
    ? branching.workBranch.trim()
    : null;
  // AC10: a null work lane, or one equal to the integration lane, starts from
  // the checked-out branch and needs no pre-start update.
  const workLaneSet = Boolean(workBranch);
  const distinctWorkLane = workLaneSet && workBranch !== branching.integrationBranch;
  const startLane = workLaneSet ? workBranch : 'current branch';
  const afterMerge = branching.syncWorkBranchAfterMerge
    ? (distinctWorkLane
      ? `fast-forward ${workBranch} to ${integrationBranch}${branching.pushSyncedWorkBranch ? `, then push ${workBranch} to origin` : ''}`
      : `fetch origin and fast-forward ${workBranch || 'the work branch'} to origin/${integrationBranch}`)
    : 'none';
  return {
    strategy: branching.strategy,
    source: branching.source,
    startLane,
    update: workLaneSet && Boolean(branching.updateWorkBranch),
    featureBranch: `${branching.featurePrefix}${specSlug}`,
    pullRequestTarget: integrationBranch,
    afterMerge
  };
}

// Spec 00057 AC9, AC12: reporting is best-effort. A malformed contribution and
// an unwritable report are warnings on the run, never a pipeline failure.
function recordContributionWarnings(targetRoot, state, warnings) {
  if (!warnings || warnings.length === 0) return state;
  let current = state;
  for (const warning of warnings) {
    try {
      stateManager.recordWarning(
        targetRoot,
        current.runId,
        warning.step || current.currentStep || 1,
        `Delivery report warning: ${warning.message}`
      );
    } catch (e) {
      // A warning that cannot be recorded must not stop the report either.
    }
  }
  return stateManager.loadRunState(targetRoot, current.runId) || current;
}

function refreshInProgressReport(targetRoot, state) {
  const result = deliveryReport.writeInProgressReport({ targetRoot, state });
  if (!result.ok) {
    console.warn(`[sdw-orch] Warning: could not write the in-progress delivery report: ${result.error}`);
    try {
      stateManager.recordWarning(
        targetRoot,
        state.runId,
        state.currentStep || 1,
        `Delivery report warning: in-progress report could not be written: ${result.error}`
      );
      return stateManager.loadRunState(targetRoot, state.runId) || state;
    } catch (e) {
      return state;
    }
  }
  return recordContributionWarnings(targetRoot, state, result.warnings);
}

/**
 * Spec 00057 AC2, AC9: appends the step's contribution to run state before the
 * next step begins, then re-renders the in-progress report from the whole list.
 * A `kind` already recorded for the step is skipped unless the caller allows
 * duplicates, so a resumed run never duplicates its history.
 */
function recordStepContributions(targetRoot, state, stepNumber, entries, options = {}) {
  let current = state;
  let changed = false;
  for (const entry of entries || []) {
    if (!options.allowDuplicates && deliveryReport.hasContribution(current, stepNumber, entry.kind)) {
      continue;
    }
    const contribution = deliveryReport.buildContribution({
      step: stepNumber,
      stepName: deliveryReport.STEP_NAMES[stepNumber],
      ...entry
    });
    const appended = deliveryReport.appendContribution(current, contribution);
    if (!appended.added) {
      try {
        stateManager.recordWarning(
          targetRoot,
          current.runId,
          stepNumber,
          `Delivery report warning: ${appended.warning}`
        );
      } catch (e) {}
      current = stateManager.loadRunState(targetRoot, current.runId) || current;
      continue;
    }
    changed = true;
  }
  if (changed) current = stateManager.saveRunState(targetRoot, current);
  return refreshInProgressReport(targetRoot, current);
}

function buildStep3Contribution(state, dispatchMode) {
  const output = (state.steps && state.steps[3] && state.steps[3].output) || {};
  const tasks = Array.isArray(output.tasks) ? output.tasks : [];
  const artifact = state.steps && state.steps[3] ? state.steps[3].artifact : null;
  return {
    kind: 'plan',
    title: `DAG plan: ${tasks.length} task(s)`,
    body: {
      taskIds: tasks.map((task) => task.id),
      dependencyOrder: tasks.map((task) => ({ id: task.id, dependencies: task.dependencies || [] })),
      dispatchMode: dispatchMode || 'subagent',
      complexity: output.complexity || null
    },
    evidence: artifact ? [artifact] : []
  };
}

/**
 * Spec 00057 AC3: one contribution per accepted task carrying the task id, its
 * acceptance outcome, the files it touched, and any retry or abandonment.
 */
function buildStep4Contributions(state) {
  const step4 = (state.steps && state.steps[4]) || {};
  const tasks = step4.tasks || {};
  const abandonments = (step4.dispatch && Array.isArray(step4.dispatch.abandonments))
    ? step4.dispatch.abandonments
    : [];
  const order = new Map();
  (Array.isArray(state.dagTasks) ? state.dagTasks : []).forEach((task, index) => order.set(task.id, index));
  return Object.entries(tasks)
    .filter(([, task]) => task && task.status === 'completed')
    .sort(([idA], [idB]) => {
      const indexA = order.has(idA) ? order.get(idA) : Number.MAX_SAFE_INTEGER;
      const indexB = order.has(idB) ? order.get(idB) : Number.MAX_SAFE_INTEGER;
      return indexA - indexB || idA.localeCompare(idB);
    })
    .map(([taskId, task]) => {
      const taskAbandonments = abandonments
        .filter((entry) => entry && entry.taskId === taskId)
        .map((entry) => ({ reason: entry.reason || null, at: entry.at || null }));
      return {
        kind: 'task',
        title: `Task ${taskId} accepted`,
        body: {
          taskId,
          outcome: task.evidenceStatus || task.status,
          filesChanged: Array.isArray(task.filesChanged) ? task.filesChanged : [],
          retries: Math.max(0, Number(task.sequence || 1) - 1),
          abandonments: taskAbandonments,
          commit: task.commitSha || null,
          acIds: Array.isArray(task.acIds) ? task.acIds : []
        },
        evidence: [task.evidencePath].filter(Boolean)
      };
    });
}

/**
 * Spec 00057 AC4, AC15: the score contribution carries the number, the required
 * minimum, and one verdict per criterion with its evidence; the judgment
 * contribution carries the advisory analysis.
 */
function buildStep5Contributions(state, scoreReport, minScore) {
  const scoring = scoreReport || (state.steps && state.steps[5] && state.steps[5].output) || {};
  const verdict = scoring.verdict || {};
  const analysisSource = scoring.analysis || {};
  const verdicts = Array.isArray(verdict.verdicts)
    ? verdict.verdicts
    : (Array.isArray(scoring.verdicts) ? scoring.verdicts : []);
  const analysis = {
    summary: typeof verdict.summary === 'string'
      ? verdict.summary
      : (typeof analysisSource.summary === 'string' ? analysisSource.summary : null),
    risks: Array.isArray(verdict.risks)
      ? verdict.risks
      : (Array.isArray(analysisSource.risks) ? analysisSource.risks : []),
    followUps: Array.isArray(verdict.followUps)
      ? verdict.followUps
      : (Array.isArray(analysisSource.followUps) ? analysisSource.followUps : [])
  };
  const requiredMinimum = scoring.minScore !== undefined && scoring.minScore !== null
    ? scoring.minScore
    : minScore;
  const artifact = state.steps && state.steps[5] ? state.steps[5].artifact : null;
  return [
    {
      kind: 'verdict',
      title: `Conformance score ${scoring.score}/${requiredMinimum}`,
      body: {
        score: scoring.score,
        minScore: requiredMinimum,
        passed: Boolean(scoring.passed),
        verifiedCount: scoring.verifiedCount,
        failingCount: scoring.failingCount,
        verdicts: verdicts.map((entry) => ({
          id: entry.id,
          verdict: entry.verdict,
          evidence: entry.evidence
        }))
      },
      evidence: verdicts.map((entry) => entry.evidence).filter(Boolean)
    },
    {
      kind: 'judgment',
      title: 'Judge analysis',
      body: analysis,
      evidence: artifact ? [artifact] : []
    }
  ];
}

/**
 * Spec 00057 AC5: the delivery commit, the staged files, and the security gate
 * outcome as the step recorded them.
 */
function buildStep6Contribution(state, details) {
  const detail = details || {};
  const stagedFiles = Array.isArray(detail.stagedFiles) ? detail.stagedFiles : [];
  return {
    kind: 'delivery',
    title: `Delivery commit ${detail.deliveryCommit || '(none)'}`,
    body: {
      deliveryCommit: detail.deliveryCommit || null,
      deliveryCommitCreated: Boolean(detail.deliveryCommitCreated),
      stagedFiles,
      securityGate: state.securityGate || { bypassed: false, status: 'not run' }
    },
    evidence: stagedFiles
  };
}

/**
 * Spec 00057 AC6: one contribution per review iteration, including an iteration
 * that applied no fix. Findings are already counted by severity.
 */
function buildStep7Contributions(iterations, reportRel) {
  return (iterations || []).map((iteration) => ({
    kind: 'review',
    title: `Review iteration ${iteration.iteration}`,
    body: {
      iteration: iteration.iteration,
      findings: iteration.findings,
      fixes: Array.isArray(iteration.fixes) ? iteration.fixes : [],
      passed: Boolean(iteration.passed)
    },
    evidence: [...(Array.isArray(iteration.fixes) ? iteration.fixes : []), reportRel].filter(Boolean)
  }));
}

function reviewSeverityCounts(findings) {
  const counts = { error: 0, warning: 0, suggestion: 0, info: 0 };
  for (const finding of findings || []) {
    const severity = String((finding && finding.severity) || 'info').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, severity)) counts[severity] += 1;
    else counts.info += 1;
  }
  return counts;
}

function extractConvergenceFixCommit(convergence) {
  const fixes = convergence && Array.isArray(convergence.issuesFixed) ? convergence.issuesFixed : [];
  for (const fix of fixes) {
    const match = String((fix && fix.resolution) || '').match(/Fixed in commit ([0-9a-f]{6,40})/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * Spec 00057 AC7: one convergence entry per delivery-stage attempt. sdw-ship-pr
 * owns the SCM loop and reports the final round state plus each resolved-thread
 * fix, so a paused and resumed delivery keeps one entry per attempt instead of
 * overwriting the previous convergence.
 */
function buildConvergenceContribution(shipResult) {
  const convergence = shipResult && shipResult.reviewConvergence;
  if (!convergence) return null;
  const failingChecks = Array.isArray(convergence.failingChecks)
    ? convergence.failingChecks.map((check) => ({
      name: check.name || check.context || check.check || '',
      status: check.status || check.conclusion || ''
    }))
    : [];
  return {
    kind: 'convergence',
    title: `Convergence iteration ${convergence.rounds || 0}`,
    body: {
      iteration: convergence.rounds || 0,
      rounds: convergence.rounds || 0,
      failingChecks,
      openThreads: Number(convergence.activeThreads) || 0,
      resolvedThreads: Number(convergence.resolvedThreads) || 0,
      fixCommit: extractConvergenceFixCommit(convergence)
    },
    evidence: []
  };
}

/**
 * Spec 00057 AC7/AC9: one convergence contribution per recorded iteration. The
 * ship result carries the round history; a result without it degrades to the
 * single summary entry so an older ship contract still renders.
 */
function buildConvergenceContributions(shipResult) {
  const convergence = shipResult && shipResult.reviewConvergence;
  if (!convergence) return [];
  const history = Array.isArray(convergence.history) ? convergence.history : [];
  if (history.length > 0) {
    return history.map((entry) => {
      const failingChecks = Array.isArray(entry.failingChecks)
        ? entry.failingChecks.map((name) => ({ name: String(name), status: '' }))
        : [];
      return {
        kind: 'convergence',
        title: `Convergence iteration ${entry.iteration || 0}`,
        body: {
          iteration: Number(entry.iteration) || 0,
          rounds: Number(convergence.rounds) || history.length,
          failingChecks,
          openThreads: Number(entry.openThreads) || 0,
          resolvedThreads: Number(entry.resolvedThreads) || 0,
          fixCommit: entry.fixCommit || null,
          converged: Boolean(entry.converged)
        },
        evidence: []
      };
    });
  }
  const single = buildConvergenceContribution(shipResult);
  return single ? [single] : [];
}

/**
 * Spec 00057 AC4/AC15: a re-judge replaces the Step 5 verdict and judgment
 * instead of stacking a second, conflicting pair, so the report always renders
 * the judgment that produced the score run state currently carries.
 */
function replaceStep5Contributions(state) {
  if (!state || !Array.isArray(state.reportContributions)) return state;
  state.reportContributions = state.reportContributions.filter(
    (entry) => !(entry && Number(entry.step) === 5 && (entry.kind === 'verdict' || entry.kind === 'judgment'))
  );
  return state;
}

/**
 * Spec 00057 AC7: a resumed Step 8 restarts the ship contract's convergence
 * history at iteration 1, so the rows from an earlier invocation are replaced
 * instead of duplicated. Each invocation owns the rounds that produced the
 * current delivery state.
 */
function replaceStep8ConvergenceContributions(state) {
  if (!state || !Array.isArray(state.reportContributions)) return state;
  state.reportContributions = state.reportContributions.filter(
    (entry) => !(entry && Number(entry.step) === 8 && entry.kind === 'convergence')
  );
  return state;
}

/**
 * Spec 00057 AC7: the pre-PR gate results and the push/pull-request outcome.
 * Gate rows come from sdw-ship-pr when it ran, otherwise from the attempts the
 * orchestrator executed itself, so a failed-then-passed gate appears twice.
 */
function buildStep8Contributions(state, shipResult, gateAttempts) {
  const ship = shipResult || {};
  const gates = Array.isArray(ship.prePrBoard) && ship.prePrBoard.length > 0
    ? ship.prePrBoard.map((row) => ({
      name: row.check,
      status: row.status,
      detail: row.evidence || null
    }))
    : (Array.isArray(gateAttempts) ? gateAttempts : []);
  const pullRequest = state.pullRequest || ship.pullRequest || null;
  return [
    {
      kind: 'gates',
      title: `Pre-PR gates: ${gates.length} result(s)`,
      body: { gates },
      evidence: []
    },
    {
      kind: 'ship',
      title: pullRequest ? `Pull request #${pullRequest.number !== undefined ? pullRequest.number : '?'}` : 'Delivery ship result',
      body: {
        pushed: Boolean(ship.pushed) || Boolean(state.pushedBranch),
        branch: state.pushedBranch || ship.head || null,
        pullRequest: pullRequest
          ? { number: pullRequest.number !== undefined ? pullRequest.number : null, url: pullRequest.url || null, title: pullRequest.title || null }
          : null,
        shipStatus: ship.shipStatus || state.shipStatus || null
      },
      evidence: pullRequest && pullRequest.url ? [pullRequest.url] : []
    }
  ];
}

/**
 * Spec 00057 AC22: the digest of run-scoped learnings whose path patterns match
 * the files a step will touch. It is passed with the dispatch, so a later step
 * applies what an earlier step learned without a reachable memory backend.
 */
function buildLearningDigest(targetRoot, state, files) {
  try {
    return memory.selectLearningDigest({ root: targetRoot, runId: state.runId, files });
  } catch (e) {
    return [];
  }
}

function formatLearningDigest(learnings) {
  if (!Array.isArray(learnings) || learnings.length === 0) return '';
  const lines = ['## Run Learnings (apply before acting)', '',
    'Recorded earlier in this run and matching the files this step touches. Apply each one you act on, then record it with `sdw-memory apply --run <runId> --slug <slug> --step <n> --evidence <locator>`:', ''];
  for (const entry of learnings) {
    const body = entry.body || {};
    const paths = (body.pathPatterns || []).join(', ');
    lines.push(`- [${body.severity}] \`${body.slug}\` (${body.kind}, recorded at step ${entry.step}): ${body.title}${paths ? ` - paths: ${paths}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

// The digest belongs before the finish command, so the actionable tail of the
// prompt stays last. A prompt without that heading gets the section appended.
function attachLearningDigest(promptFileAbs, digestText) {
  if (!digestText) return false;
  try {
    const content = fs.readFileSync(promptFileAbs, 'utf8');
    if (content.includes('## Run Learnings')) return false;
    const marker = '\n## Finish Command';
    const updated = content.includes(marker)
      ? content.replace(marker, `\n${digestText}${marker}`)
      : `${content.trimEnd()}\n\n${digestText}`;
    fs.writeFileSync(promptFileAbs, updated, 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Spec 00057 AC25: the retrospective contribution carries the signals, the
 * candidates, and the fixes the retro applied, so the report can render them.
 */
function buildRetroContribution(state, targetRoot) {
  const retro = (state && state.retro) || {};
  if (retro.status !== 'passed' || !retro.reportJson) return null;
  const root = path.resolve(targetRoot || state.projectRoot || process.cwd());
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(path.resolve(root, retro.reportJson), 'utf8'));
  } catch (e) {
    report = null;
  }
  if (!report || typeof report !== 'object') return null;
  const signals = report.signals && typeof report.signals === 'object' ? report.signals : {};
  const candidates = Array.isArray(report.candidates) ? report.candidates : [];
  const routed = Array.isArray(report.routedCandidates) ? report.routedCandidates : [];
  const routeById = new Map(routed.map(entry => [entry && entry.id, entry]));
  return {
    kind: 'retro',
    title: `Retrospective ${retro.status}: ${candidates.length} candidate(s)`,
    body: {
      status: retro.status,
      runStatus: report.status || null,
      signals: {
        retries: signals.retries || null,
        leftoverRuns: Array.isArray(signals.leftover_run) ? signals.leftover_run.length : 0,
        missingArtifacts: Array.isArray(signals.missingArtifacts) ? signals.missingArtifacts.length : 0,
        reviewFindings: signals.reviewFindings
          ? { total: signals.reviewFindings.total || 0, open: signals.reviewFindings.open || 0 }
          : { total: 0, open: 0 }
      },
      candidates: candidates.map(candidate => {
        const route = routeById.get(candidate && candidate.id);
        return {
          id: candidate && candidate.id ? candidate.id : null,
          title: candidate && candidate.title ? candidate.title : null,
          severity: candidate && candidate.severity ? candidate.severity : null,
          category: candidate && candidate.category ? candidate.category : null,
          route: route ? route.route : null,
          status: route ? route.status : null
        };
      }),
      fixes: report.fixes && typeof report.fixes === 'object'
        ? report.fixes
        : { recorded: [], consolidated: null, queuedSpecifications: [], failures: [] },
      routedCandidates: routed,
      reportMd: retro.reportMd || null,
      reportJson: retro.reportJson || null
    },
    evidence: [retro.reportMd, retro.reportJson].filter(Boolean)
  };
}

// AC25: appends the retro contribution once and re-renders the in-progress
// report, so the run state carries the retrospective without duplicating it.
function recordRetroContribution(targetRoot, state) {
  const contribution = buildRetroContribution(state, targetRoot);
  if (!contribution) return state;
  return recordStepContributions(targetRoot, state, 9, [contribution]);
}

/**
 * Spec 00057 AC28: refreshes the committed companion from run state. It never
 * commits and never amends: when the branch was already pushed, the refreshed
 * file stays uncommitted and the pushed commit is left untouched.
 */
function reRenderCompanionReport(targetRoot, state, options = {}) {
  const result = deliveryReport.writeDeliveryReport({
    targetRoot,
    state,
    minScore: options.minScore
  });
  if (!result) {
    return { ok: false, relPath: null, changed: false, pushed: Boolean(state.pushedBranch || state.registryCommit), amended: false };
  }
  return {
    ok: true,
    relPath: result.relPath,
    changed: Boolean(result.changed),
    pushed: Boolean(state.pushedBranch || state.registryCommit),
    amended: false
  };
}

function printRunDryRunPlan(context) {
  const { targetRoot, resolvedSpec, specSlug, config, options, branching: resolvedBranching } = context;
  let branching = resolvedBranching;
  if (!branching) {
    try {
      const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
      branching = sdwConfig.resolveBranching(config);
    } catch (e) {
      branching = { strategy: 'trunk', source: 'default', featurePrefix: 'feature/', workBranch: null, integrationBranch: null, updateWorkBranch: false, syncWorkBranchAfterMerge: false, pushSyncedWorkBranch: false };
    }
  }
  // AC15: the branch plan is resolved from configuration plus a read-only
  // origin/HEAD lookup; no pipeline step, state, branch, or mutation runs.
  const branchPlan = buildBranchPlan(branching, specSlug);
  let validation = null;
  let validatorFailure = null;
  try {
    const validatorPath = resolveSkillScript(targetRoot, 'sdw-spec', path.join('scripts', 'validate_spec.cjs'), options);
    const validator = validatorPath ? require(validatorPath) : require('../../sdw-spec/scripts/validate_spec.cjs');
    validation = validator.validateFile(resolvedSpec, { mode: 'authoring' });
  } catch (e) {
    // Fail closed: an unvalidated specification must never look like a passing plan.
    validatorFailure = e;
  }

  const validationErrors = validation && Array.isArray(validation.errors) ? validation.errors : [];
  const errors = validatorFailure
    ? [{ message: `Validator unavailable: ${validatorFailure.message}` }]
    : validationErrors;
  const valid = Boolean(validation && validation.ok);
  const steps = [
    '1 derivation',
    '2 refinement',
    '3 dag_generation',
    '4 implementation',
    '5 scoring',
    '6 delivery_commit',
    '7 code_review',
    '8 pr_preparation'
  ];
  const settings = {
    scoreMin: config.scoreMin !== undefined ? config.scoreMin : 8,
    pushDelivery: Boolean(config.pushDelivery),
    scmProvider: config.scmProvider || 'none',
    useFeatureBranches: Boolean(config.useFeatureBranches),
    useWorktrees: Boolean(config.useWorktrees),
    branching: branchPlan.strategy
  };

  // Spec 00054 AC18: the plan prints the same advisory observations the real
  // ingestion would record. It writes no report and no Step 2 artifact.
  let specObservations = [];
  try {
    specObservations = specGrilling.analyzeSpecObservations({
      targetRoot,
      specPath: resolvedSpec
    });
  } catch (observationErr) {
    specObservations = [];
  }

  if (options.json) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      executed: false,
      valid,
      specSlug,
      specPath: normalizePath(path.relative(targetRoot, resolvedSpec)),
      root: normalizePath(targetRoot),
      settings,
      branchPlan,
      steps,
      specObservations,
      reportContributions: {
        total: 0,
        text: deliveryReport.summarizeContributions({ reportContributions: [] }).text,
        plannedKinds: deliveryReport.PLANNED_CONTRIBUTION_KINDS,
        written: false
      },
      errors
    }, null, 2));
    return valid ? 0 : 1;
  }

  if (!valid) {
    console.error(`[sdw-orch dry-run] Specification validation failed: ${normalizePath(path.relative(targetRoot, resolvedSpec))}`);
    for (const error of errors) {
      console.error(`  ${error.ac ? `${error.ac}: ` : ''}${error.message}`);
    }
    return 1;
  }

  console.log(`[sdw-orch dry-run] Specification: ${normalizePath(path.relative(targetRoot, resolvedSpec))} (${specSlug})`);
  console.log(`[sdw-orch dry-run] Target root: ${normalizePath(targetRoot)}`);
  console.log(`[sdw-orch dry-run] Settings: scoreMin=${settings.scoreMin}, pushDelivery=${settings.pushDelivery}, scmProvider=${settings.scmProvider}, useFeatureBranches=${settings.useFeatureBranches}, useWorktrees=${settings.useWorktrees}, branching=${settings.branching}`);
  console.log(`[sdw-orch dry-run] Strategy: ${branchPlan.strategy}`);
  console.log(`[sdw-orch dry-run] Start lane: ${branchPlan.startLane} (update: ${branchPlan.update ? 'yes' : 'no'})`);
  console.log(`[sdw-orch dry-run] Feature branch: ${branchPlan.featureBranch}`);
  console.log(`[sdw-orch dry-run] Pull request target: ${branchPlan.pullRequestTarget}`);
  console.log(`[sdw-orch dry-run] After merge: ${branchPlan.afterMerge}`);
  console.log(`[sdw-orch dry-run] Steps: ${steps.join(' -> ')}`);
  const contributionSummary = deliveryReport.summarizeContributions({ reportContributions: [] });
  console.log(`[sdw-orch dry-run] Report contributions: ${contributionSummary.text}; planned kinds per step: ${deliveryReport.summarizePlannedContributions()}; no report written (--dry-run).`);
  for (const specObservation of specObservations) {
    console.log(`[sdw-orch dry-run] Spec observation (${specObservation.kind}, ${specObservation.severity}): ${specObservation.evidence}`);
  }
  console.log('[sdw-orch dry-run] No steps executed (--dry-run).');
  return 0;
}

function cmdRun(options) {
  let targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const sourceRoot = targetRoot;
  let sandboxMeta = null;

  if (options.dryRun && options.sandbox) {
    console.error('[sdw-orch] Error: --dry-run and --sandbox are mutually exclusive: --dry-run prints a plan only, --sandbox executes the pipeline in an isolated clone.');
    options._runResult = { error: '--dry-run and --sandbox are mutually exclusive' };
    return 1;
  }
  if (options.sandbox && options.push) {
    console.error('[sdw-orch] Error: --sandbox and --push are mutually exclusive: a sandbox run never pushes.');
    options._runResult = { error: '--sandbox and --push are mutually exclusive' };
    return 1;
  }

  let sdwConfig = null;
  try {
    const sdwConfigScript = resolveSkillScript(targetRoot, 'sdw-config', path.join('scripts', 'sdw_config.cjs'), options);
    sdwConfig = sdwConfigScript ? require(sdwConfigScript) : require('../../sdw-config/scripts/sdw_config.cjs');
  } catch (e) {}
  let config = loadProjectConfig(targetRoot, options);
  // AC9/AC10: fail closed, but resolve configuration first so a configured
  // skillsRoot (or {skillsRoot} token) is honored instead of only CLI options.
  const detectedSkillsRoot = config && config.skillsMode && config.skillsMode !== 'unknown'
    ? config.skillsRoot
    : undefined;
  const skillsInfo = sdwConfig && typeof sdwConfig.resolveSkillsRoot === 'function'
    ? sdwConfig.resolveSkillsRoot({ root: targetRoot, callerDir: __dirname, skillsRoot: options.skillsRoot || detectedSkillsRoot })
    : null;
  if (!skillsInfo || !skillsInfo.exists) {
    console.error('Error: No valid skills directory found on disk (checked configured skillsRoot, project-local, and global $HOME/.agents/skills).');
    options._runResult = { error: 'Missing skills directory on disk' };
    return 1;
  }

  // AC10: honor the skills root resolved from .sdw/config.json for dynamic script resolution
  const resolveOptions = (detectedSkillsRoot && !options.skillsRoot)
    ? { ...options, skillsRoot: detectedSkillsRoot }
    : options;
  const effectiveMinScore = options.minScore !== undefined ? options.minScore : (config.scoreMin !== undefined ? config.scoreMin : 8);

  const resolvedSpec = resolveSpecPath(options.specPath, targetRoot, config);
  if (!resolvedSpec || !fs.existsSync(resolvedSpec)) {
    console.error(`Error: Specification file not found: "${options.specPath}"`);
    options._runResult = { error: `Specification file not found: "${options.specPath}"` };
    return 1;
  }

  const rawSpecContent = fs.readFileSync(resolvedSpec, 'utf8');
  const specBasename = path.basename(resolvedSpec, path.extname(resolvedSpec));
  const slugMatch = rawSpecContent.match(/slug:\s*([^\r\n]+)/);
  const specSlug = slugMatch ? slugMatch[1].trim() : specBasename.replace(/^step-\d+-/, '');

  try {
    assertSafeSlug(specSlug);
  } catch (slugErr) {
    console.error(`[sdw-orch] ${slugErr.message}`);
    options._runResult = { error: slugErr.message };
    return 1;
  }

  // AC9, AC14, AC15: resolve the branch lanes once so branch activation, run
  // state, and the dry-run plan share the same names and flags.
  let branching;
  try {
    if (!sdwConfig || typeof sdwConfig.resolveBranching !== 'function') {
      throw new Error('sdw-config resolveBranching is unavailable.');
    }
    branching = sdwConfig.resolveBranching(config);
  } catch (branchConfigErr) {
    console.error(`[sdw-orch] ${branchConfigErr.message}`);
    options._runResult = { error: branchConfigErr.message };
    return 1;
  }
  const featureBranchName = `${branching.featurePrefix}${specSlug}`;

  // Plan-only dry run: validate the specification and print the plan without
  // touching run state, artifacts, branches, worktrees, or clones (spec 029 AC1-AC3).
  if (options.dryRun) {
    // AC15: resolve an `auto` lane read-only from origin/HEAD so the plan shows
    // the same start lane, update step, and PR target the real run will use.
    try {
      if (!branching.integrationBranch || !String(branching.integrationBranch).trim()) {
        const head = String(execSync('git symbolic-ref --short refs/remotes/origin/HEAD', {
          cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        }) || '').trim();
        const resolved = head.replace(/^origin\//, '');
        if (resolved) {
          branching.integrationBranch = resolved;
          if (branching.mirrorWorkToIntegration && (!branching.workBranch || !String(branching.workBranch).trim())) {
            branching.workBranch = resolved;
          }
        }
      }
    } catch (autoErr) {
      // No remote default branch: keep the configuration-only lanes.
    }
    return printRunDryRunPlan({ targetRoot, resolvedSpec, specSlug, config, options, branching });
  }

  // Spec 00045 AC4: refuse to start a second run while another run for the same
  // specification is still open. Reusing an explicit --run-id restores that run
  // instead of creating a new one; --new-run is the intentional override.
  const stateDir = path.resolve((config && config.stateDir) || path.join(targetRoot, '.sdw', 'state'));
  const restoresExplicitRun = Boolean(options.runId
    && fs.existsSync(path.join(stateDir, `${options.runId}.state.json`)));
  if (!options.newRun && !restoresExplicitRun) {
    const openRuns = findOpenRunsForSpec(stateDir, specSlug);
    if (openRuns.length > 0) {
      const existing = openRuns[0];
      const message = `Specification "${specSlug}" already has an open run "${existing.runId}" (status: ${existing.status}). Continue it with: node "${normalizePath(orchCommandPath())}" resume --run-id ${existing.runId}. Pass --new-run to start a new run intentionally.`;
      console.error(`[sdw-orch] Blocked: ${message}`);
      options._runResult = { error: message };
      return 1;
    }
  }

  // Sandbox execution: run the whole pipeline against an isolated local clone
  // of the committed HEAD (spec 029 AC6-AC18).
  if (options.sandbox) {
    const runId = options.runId || stateManager.generateRunId(specSlug);
    let requestedSandboxDir;
    try {
      requestedSandboxDir = resolveSandboxDir(config, sourceRoot);
    } catch (dirErr) {
      console.error(`[sdw-orch] ${dirErr.message}`);
      options._runResult = { error: dirErr.message };
      return 1;
    }
    try {
      sandboxMeta = sandbox.createSandbox({
        sourceRoot,
        runId,
        slug: specSlug,
        specPath: resolvedSpec,
        sandboxDir: requestedSandboxDir
      });
    } catch (sandboxErr) {
      console.error(`[sdw-orch] Sandbox creation failed: ${sandboxErr.message}`);
      options._runResult = { error: sandboxErr.message };
      return 1;
    }
    targetRoot = sandboxMeta.absoluteRoot;
    options.runId = runId;
    options._effectiveRoot = targetRoot;
    config = loadProjectConfig(targetRoot, options);
    options._config = config;
    console.log(`[sandbox] Clone created at ${sandboxMeta.root} (branch ${sandboxMeta.branch}, origin removed).`);
    if (sandboxMeta.baselineDirty) {
      console.warn('[sandbox] Warning: working tree is dirty; uncommitted changes are not part of the sandbox baseline.');
    }
    if (sandboxMeta.specCopied) {
      console.log('[sandbox] Specification file was copied into the clone because it is not committed.');
    }
  }

  // Quality check: inspect index.specs.md status if available
  const specIndex = getSpecIndexHelper(targetRoot, resolveOptions);
  let registryStatus = null;
  if (specIndex) {
    try {
      const idxData = specIndex.readIndex({ root: targetRoot });
      if (idxData && idxData.exists) {
        const entry = idxData.entries.find(e => e.slug === specSlug || (specSlug && e.slug && e.slug.includes(specSlug)));
        if (entry) {
          registryStatus = entry.status;
          // AC25: While a specification is marked archived, prevent execution unless override flag
          if (entry.status === 'archived' && !options.force && !options.allowArchived) {
            console.error(`[sdw-orch] Blocked: Specification "${specSlug}" is marked "archived" in index.specs.md. Execution prohibited unless --force or --allow-archived is provided.`);
            options._runResult = { error: `Specification "${specSlug}" is marked "archived" in index.specs.md` };
            return 1;
          }
          // AC23: Update or verify specification status as pending
          if (entry.status !== 'completed' && entry.status !== 'archived') {
            specIndex.updateSpecStatus(entry.slug, 'pending', { root: targetRoot });
          }
        }
      }
    } catch (err) {}
  }

  // Second pass (refinement): only an already-delivered specification qualifies.
  let refineBaseCommit = null;
  if (options.refineMode) {
    const priorDelivery = findPriorDeliveryCommit(targetRoot, specSlug);
    const implemented = registryStatus === 'completed' || registryStatus === 'archived' || Boolean(priorDelivery);
    if (!implemented) {
      console.error(`[sdw-orch] Blocked: --second-pass refines an already implemented specification, but "${specSlug}" is not recorded as completed in index.specs.md and has no completed run.`);
      options._runResult = { error: `Specification "${specSlug}" is not implemented yet; run it without --second-pass first` };
      return 1;
    }
    refineBaseCommit = priorDelivery || null;
    console.log(`[sdw-orch] Second pass mode: refining the delivered implementation${refineBaseCommit ? ` (base ${refineBaseCommit})` : ''}.`);
  }

  // Resolve feature branches and worktrees settings (AC1, AC2, AC21)
  let useFeatureBranches = Boolean(config.useFeatureBranches);
  let featureBranchSource = 'config';
  if (options.noFeatureBranch) {
    useFeatureBranches = false;
    featureBranchSource = 'cli';
  } else if (options.featureBranch) {
    useFeatureBranches = true;
    featureBranchSource = 'cli';
  }

  let useWorktrees = Boolean(config.useWorktrees);
  let worktreesSource = 'config';
  if (options.noWorktrees) {
    useWorktrees = false;
    worktreesSource = 'cli';
  } else if (options.worktrees) {
    useWorktrees = true;
    worktreesSource = 'cli';
  }

  const runtimeOverrides = (options.noWorktrees || options.worktrees || options.noFeatureBranch || options.featureBranch)
    ? { useWorktrees, useFeatureBranches, worktreesSource, featureBranchSource }
    : null;

  // Resolve current and base branch
  let currentBranch = 'main';
  let baseBranch = 'main';
  try {
    currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {}
  try {
    const originHead = execSync('git symbolic-ref --short refs/remotes/origin/HEAD', { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    baseBranch = originHead.replace(/^origin\//, '');
  } catch (e) {
    baseBranch = currentBranch;
  }

  // AC2, AC3: `auto` integration lanes resolve to the repository default branch,
  // so mirror presets (github, gitlab) get a concrete work lane.
  if (!branching.integrationBranch || !String(branching.integrationBranch).trim()) {
    branching.integrationBranch = baseBranch;
    if (branching.mirrorWorkToIntegration && (!branching.workBranch || !String(branching.workBranch).trim())) {
      branching.workBranch = baseBranch;
    }
  }

  // AC14: the effective branch values recorded in run state.
  const runBranching = {
    strategy: branching.strategy,
    source: branching.source,
    featurePrefix: branching.featurePrefix,
    featureBranch: useFeatureBranches ? featureBranchName : null,
    workBranch: branching.workBranch,
    integrationBranch: branching.integrationBranch,
    updateWorkBranch: Boolean(branching.updateWorkBranch),
    syncWorkBranchAfterMerge: Boolean(branching.syncWorkBranchAfterMerge),
    pushSyncedWorkBranch: Boolean(branching.pushSyncedWorkBranch)
  };

  let activeBranch = currentBranch;
  let branchReused = false;
  // AC8 (spec 00058): the lane reference the feature branch actually started from.
  let branchStartPoint = null;

  // Feature branch activation before step 1 (AC6, AC8)
  // Dirty working trees are allowed: execution proceeds independently of git
  // state and delivery commits stage only tracked spec files (scoped commits).
  if (useFeatureBranches) {
    const targetBranch = featureBranchName;
    if (currentBranch === targetBranch) {
      // Safety: resumes run with uncommitted delivery changes on the feature
      // branch. Reuse it in place; never checkout, fetch, or fast-forward.
      branchReused = true;
      activeBranch = targetBranch;
      console.log(`[Branch Activation] Already on feature branch "${targetBranch}" (reused).`);
    } else {
      const branchCheck = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}`], { cwd: targetRoot });
      if (branchCheck.status === 0) {
        // AC8: Switch to existing branch and record reuse
        try {
          git(targetRoot, ['switch', targetBranch], { stdio: 'ignore' });
          branchReused = true;
          activeBranch = targetBranch;
          console.log(`[Branch Activation] Reused and switched to existing feature branch "${targetBranch}".`);
        } catch (switchErr) {
          console.error(`[Branch Activation] Failed to switch to branch "${targetBranch}": ${switchErr.message}`);
          return 1;
        }
      } else {
        const workBranch = branching.workBranch;
        // AC6, AC7, AC10: start from the work lane only when it is a distinct,
        // non-empty branch; a null work lane or one equal to the integration
        // lane preserves the trunk behavior (start from the checked-out branch).
        // AC7 still applies to the same-lane case (gitflow): the checked-out work
        // lane is updated in place before the feature branch is created.
        const workBranchSet = typeof workBranch === 'string' && workBranch.trim().length > 0;
        // A configured work lane is always the start point, including gitflow
        // where it equals the integration lane. Trunk behavior (checked-out
        // branch) applies only when no work lane is configured.
        const fromWorkLane = workBranchSet;
        const workLaneCheckedOut = workBranchSet && currentBranch === workBranch;
        const treeIsDirty = () => {
          try {
            return String(git(targetRoot, ['status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim().length > 0;
          } catch (e) {
            return false;
          }
        };
        const laneStartPoint = () => (fromWorkLane ? workBranch : currentBranch);
        let startRef = fromWorkLane ? workBranch : null;
        let startPoint = laneStartPoint();
        // The refreshed remote lane may seed the branch only when it descends from
        // the local lane: a stale lane must never drop local commits.
        const remoteLaneDescendsFromLocal = () => {
          try {
            const localSha = String(git(targetRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${workBranch}`], { stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
            const remoteSha = String(git(targetRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${workBranch}`], { stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
            if (!remoteSha) return false;
            return localSha === remoteSha || isAncestorCommit(targetRoot, localSha, remoteSha);
          } catch (e) {
            return false;
          }
        };
        if ((fromWorkLane || workLaneCheckedOut) && branching.updateWorkBranch) {
          try {
            if (workLaneCheckedOut) {
              // A checked-out lane is updated in place: git refuses to fetch into it.
              git(targetRoot, ['fetch', 'origin'], { stdio: 'ignore' });
              try {
                git(targetRoot, ['merge', '--ff-only', `origin/${workBranch}`], { stdio: 'ignore' });
              } catch (mergeErr) {
                // Product guarantee: a dirty tree never blocks activation.
                if (!treeIsDirty()) throw mergeErr;
                if (remoteLaneDescendsFromLocal()) {
                  // AC8: the refreshed remote lane commit is the start point, not
                  // the stale local lane; the start point is recorded below.
                  startRef = `refs/remotes/origin/${workBranch}`;
                  startPoint = `origin/${workBranch}`;
                  console.warn(`[Branch Activation] ${branching.strategy}: "${workBranch}" could not be fast-forwarded over dirty files; starting ${targetBranch} from ${startPoint}.`);
                } else {
                  console.warn(`[Branch Activation] ${branching.strategy}: skipped the update of "${workBranch}" over dirty files; continuing from the current HEAD.`);
                }
              }
            } else {
              // Update the lane ref without checking it out, so a dirty tree never blocks.
              git(targetRoot, ['fetch', 'origin', `${workBranch}:${workBranch}`], { stdio: 'ignore' });
            }
          } catch (updateErr) {
            const message = `Failed to update work branch "${workBranch}": ${updateErr.message}`;
            console.error(`[Branch Activation] ${message}`);
            options._runResult = { error: message };
            return 1;
          }
        }
        // AC6: Create and switch to new feature branch from the work lane.
        if (fromWorkLane) {
          const laneRef = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${workBranch}`], { cwd: targetRoot });
          if (laneRef.status !== 0 && startRef === workBranch) {
            const message = `Work branch "${workBranch}" does not exist locally; cannot start the feature branch.`;
            console.error(`[Branch Activation] ${message}`);
            options._runResult = { error: message };
            return 1;
          }
        }
        const createArgs = fromWorkLane
          ? ['switch', '-c', targetBranch, startRef || workBranch]
          : ['switch', '-c', targetBranch];
        const announceCreation = (startedFrom) => {
          let startSha = '';
          try { startSha = String(git(targetRoot, ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim(); } catch (shaErr) {}
          console.log(`[Branch Activation] ${branching.strategy}: created ${targetBranch} from ${startedFrom}${startSha ? ` at ${startSha}` : ''}.`);
        };
        try {
          git(targetRoot, createArgs, { stdio: 'ignore' });
          branchReused = false;
          activeBranch = targetBranch;
          branchStartPoint = startPoint;
          announceCreation(startPoint);
        } catch (createErr) {
          // Product guarantee: a dirty tree never blocks activation. When the work
          // lane checkout would overwrite dirty files, start from the current branch.
          // Any other creation failure (missing ref, invalid state) is a real error.
          if (fromWorkLane && treeIsDirty()) {
            try {
              git(targetRoot, ['switch', '-c', targetBranch], { stdio: 'ignore' });
              branchReused = false;
              activeBranch = targetBranch;
              branchStartPoint = currentBranch;
              console.warn(`[Branch Activation] ${branching.strategy}: work lane "${workBranch}" could not be checked out over dirty files; created ${targetBranch} from ${currentBranch}.`);
              announceCreation(currentBranch);
            } catch (fallbackErr) {
              console.error(`[Branch Activation] Failed to create branch "${targetBranch}": ${fallbackErr.message}`);
              return 1;
            }
          } else {
            console.error(`[Branch Activation] Failed to create branch "${targetBranch}": ${createErr.message}`);
            return 1;
          }
        }
      }
    }
  }

  const baseCommit = options.refineMode && refineBaseCommit
    ? refineBaseCommit
    : (options.baseCommit || getBaseCommit(targetRoot));
  const startStep = options.startStep || (options.step ? options.step : 1);

  const scmProvider = config.scmProvider || 'none';
  const scmState = {
    provider: scmProvider,
    resolvedFrom: 'config',
    cliInstalled: null,
    cliAuthenticated: null,
    skipped: false,
    skipReason: null,
    errors: []
  };

  // Initialize or restore Run State (AC1, AC2, AC9, AC17)
  let state;
  let resumedExistingRun = false;
  if (options.runId && fs.existsSync(stateManager.getStateFilePath(targetRoot, options.runId))) {
    resumedExistingRun = true;
    state = stateManager.loadRunState(targetRoot, options.runId);
    state.branch = activeBranch;
    state.baseBranch = baseBranch;
    state.branchReused = branchReused;
    state.branching = runBranching;
    if (!state.scm) state.scm = scmState;
    if (runtimeOverrides) state.runtimeOverrides = runtimeOverrides;
    state = stateManager.saveRunState(targetRoot, state);
  } else {
    state = stateManager.createRunState({
      root: targetRoot,
      specPath: options.specPath,
      slug: specSlug,
      runId: options.runId,
      baseCommit,
      branch: activeBranch,
      baseBranch,
      branchReused,
      branching: runBranching,
      runtimeOverrides,
      scm: scmState,
      refineMode: Boolean(options.refineMode)
    });
  }

  // Spec 00057 AC1: every run carries the append-only contribution list from the
  // first step boundary, including runs resumed from state written before it.
  if (!Array.isArray(state.reportContributions)) {
    state.reportContributions = [];
    state = stateManager.saveRunState(targetRoot, state);
  }

  // Persist and restore the mode so `resume` continues as a second pass.
  const refineMode = Boolean(options.refineMode || state.refineMode);
  if (refineMode && !state.refineMode) {
    state.refineMode = true;
    state = stateManager.saveRunState(targetRoot, state);
  }

  // AC8 (spec 00058): record the lane reference the feature branch started from.
  if (branchStartPoint) {
    state.branchStartPoint = branchStartPoint;
    state = stateManager.saveRunState(targetRoot, state);
  }

  if (sandboxMeta) {
    state.sandbox = {
      enabled: true,
      sourceRoot: normalizePath(sourceRoot),
      dir: sandboxMeta.sandboxDir,
      path: sandboxMeta.root,
      branch: sandboxMeta.branch
    };
    state = stateManager.saveRunState(targetRoot, state);
  }

  console.log(`[sdw-orch] Run "${state.runId}" active at step ${startStep}/8.`);
  console.log(`[sdw-orch] State file: ${stateManager.getStateFilePath(targetRoot, state.runId)}`);
  if (resumedExistingRun && !options._resumedLogged) logRunResumed(state.runId, specSlug, startStep);
  else if (!resumedExistingRun) logRunStarted(state.runId, specSlug, startStep);

  let effectiveSpecContent = rawSpecContent;

  // Step 1: Spec Ingestion & Derivation (AC3, AC4)
  if (startStep <= 1 && state.steps[1].status !== 'completed' && state.steps[1].status !== 'skipped') {
    state = stateManager.updateStepState(targetRoot, state.runId, 1, 'in_progress');
    logStepEnter(1);
    const derivationResult = specDerivation.deriveAgentSpec(rawSpecContent, { slug: specSlug });
    if (derivationResult.derivationNeeded) {
      console.log(`[Step 1: Derivation] Spec reformulated for agentic execution.`);
      effectiveSpecContent = derivationResult.specContent;
      state = stateManager.updateStepState(targetRoot, state.runId, 1, 'completed', { derivationNeeded: true });
    } else {
      console.log(`[Step 1: Derivation] Skipped: input spec is already agent-ready.`);
      state = stateManager.updateStepState(targetRoot, state.runId, 1, 'skipped', { derivationNeeded: false });
    }
    logStepDone(1);
    const step1Status = state.steps[1].status;
    state = recordStepContributions(targetRoot, state, 1, [{
      kind: 'derivation',
      title: step1Status === 'skipped' ? 'Derivation skipped' : 'Specification derived for agentic execution',
      body: {
        status: step1Status,
        derivationNeeded: Boolean(state.steps[1].output && state.steps[1].output.derivationNeeded)
      },
      evidence: []
    }]);
  }

  // Step 2: Refinement (Grilling + Technical Planning) (AC1, AC2)
  if (refineMode && startStep <= 2 && state.steps[2].status !== 'completed' && state.steps[2].status !== 'skipped') {
    logStepEnter(2);
    console.log('[Step 2: Refinement] Second pass: skipping decision-gap grilling; the implementation already exists.');
    state = stateManager.updateStepState(targetRoot, state.runId, 2, 'skipped', { mode: 'refine', reason: 'second pass reviews the delivered implementation' });
    logStepDone(2);
    state = recordStepContributions(targetRoot, state, 2, [{
      kind: 'refinement',
      title: 'Refinement skipped on the second pass',
      body: { status: 'skipped', mode: 'refine', reason: 'second pass reviews the delivered implementation' },
      evidence: []
    }]);
  } else if (startStep <= 2 && state.steps[2].status !== 'completed' && state.steps[2].status !== 'skipped') {
    state = stateManager.updateStepState(targetRoot, state.runId, 2, 'in_progress');
    logStepEnter(2);
    const grillingResult = specGrilling.analyzeSpecificationGaps(effectiveSpecContent, { slug: specSlug });

    if (grillingResult.hasGaps) {
      console.log(`[Step 2: Refinement] Detected ${grillingResult.gapsCount} specification decision gaps.`);
      for (const gap of grillingResult.gaps) {
        console.log(`  * Gap [${gap.dimension}]: ${gap.question} -> Default: ${gap.defaultChoice}`);
      }

      if (options.abortOnGaps && !options.unattended) {
        console.log(`[Step 2: Refinement] User cancellation / gate stop triggered (--abort-on-gaps). Halting without dispatch.`);
        state = stateManager.updateStepState(targetRoot, state.runId, 2, 'paused_grilling_gate', grillingResult);
        state.status = 'paused';
        stateManager.saveRunState(targetRoot, state);
        options._runResult = { runId: state.runId, status: 'paused', error: 'User cancellation at grilling gate' };
        return 3;
      }

      // Auto-resolve using recommended defaults
      for (const gap of grillingResult.gaps) {
        effectiveSpecContent = specGrilling.applyDecision(effectiveSpecContent, gap.dimension, gap.defaultChoice);
      }
    } else {
      console.log(`[Step 2: Refinement] Grilling check clean: all core decision dimensions covered.`);
    }

    const resolvedGaps = grillingResult.gaps.map(g => ({
      dimension: g.dimension,
      question: g.question,
      chosenOption: g.defaultChoice
    }));

    // Spec 00054 AC11-AC14: the ingestion analysis only reads sibling
    // specifications. A failure degrades to no observations; it never blocks,
    // rewrites, or changes the run.
    let specObservations = [];
    try {
      specObservations = specGrilling.analyzeSpecObservations({
        targetRoot,
        specPath: resolvedSpec,
        specContent: effectiveSpecContent
      });
    } catch (observationErr) {
      console.warn(`[Step 2: Refinement] Spec observation analysis skipped: ${observationErr.message}`);
    }
    for (const specObservation of specObservations) {
      console.log(`[sdw-orch] Spec observation (${specObservation.kind}, ${specObservation.severity}): ${specObservation.evidence}`);
    }

    const refinementOutput = {
      hasGaps: grillingResult.hasGaps,
      gaps: grillingResult.gaps,
      gapsResolved: resolvedGaps,
      blueprint: grillingResult.blueprint,
      specObservations
    };

    console.log(`[Step 2: Refinement] Refinement complete. Blueprint generated for ${grillingResult.blueprint.targetFiles.length} target file(s).`);
    const step2Artifact = artifactWriter.writeStep2Artifact({
      targetRoot,
      specSlug,
      runId: state.runId,
      grillingResult,
      effectiveSpecContent,
      specObservations,
      artifactsDir: state.artifactsDir
    });
    state = stateManager.updateStepState(targetRoot, state.runId, 2, 'completed', refinementOutput, null, { artifact: step2Artifact });
    logStepDone(2);
    state = recordStepContributions(targetRoot, state, 2, [{
      kind: 'refinement',
      title: grillingResult.hasGaps ? `Refinement resolved ${grillingResult.gaps.length} decision gap(s)` : 'Refinement found no decision gaps',
      body: {
        status: 'completed',
        hasGaps: grillingResult.hasGaps,
        gapsResolved: resolvedGaps,
        specObservations
      },
      evidence: step2Artifact ? [step2Artifact] : []
    }]);
  }

  // Step 3: Complexity Analysis & DAG Task Decomposition (AC3, AC7)
  let dagPlan = null;
  const blueprint = (state.steps[2] && state.steps[2].output && state.steps[2].output.blueprint) || null;
  if (refineMode && startStep <= 3 && state.steps[3].status !== 'completed' && state.steps[3].status !== 'skipped') {
    state = stateManager.updateStepState(targetRoot, state.runId, 3, 'in_progress');
    logStepEnter(3);
    const refineAcIds = dagPlanner.parseAcceptanceCriteria(effectiveSpecContent)
      .map(ac => (typeof ac === 'string' ? ac : ac.id));
    dagPlan = {
      complexity: { level: 'refinement', score: 0 },
      totalTasks: 1,
      tasks: [{
        id: 'task-refine',
        title: `Second pass: ${specSlug}`,
        description: 'Audit the delivered implementation against the specification, implement acceptance criteria that are missing or drifted, then apply clear simplification or quality improvements. Changing nothing is acceptable only when every criterion already holds and no drift remains.',
        coveredAcs: refineAcIds,
        dependencies: [],
        targetFiles: []
      }]
    };
    state.dagTasks = dagPlan.tasks;
    state = stateManager.saveRunState(targetRoot, state);
    console.log('[Step 3: DAG Generation] Second pass: one refinement task.');
    state = stateManager.updateStepState(targetRoot, state.runId, 3, 'completed', dagPlan);
    logStepDone(3);
  } else if (refineMode && state.steps[3].output) {
    dagPlan = state.steps[3].output;
  } else if (startStep <= 3 && state.steps[3].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 3, 'in_progress');
    logStepEnter(3);
    dagPlan = dagPlanner.generateDagPlan(effectiveSpecContent, { slug: specSlug, blueprint });
    console.log(`[Step 3: DAG Generation] Complexity: ${dagPlan.complexity.level}. Generated ${dagPlan.totalTasks} task(s).`);
    state.dagTasks = dagPlan.tasks;
    state = stateManager.saveRunState(targetRoot, state);
    const step3Artifact = artifactWriter.writeStep3Artifact({
      targetRoot,
      specSlug,
      runId: state.runId,
      dagPlan,
      artifactsDir: state.artifactsDir
    });
    state = stateManager.updateStepState(targetRoot, state.runId, 3, 'completed', dagPlan, null, { artifact: step3Artifact });
    logStepDone(3);
  } else if (state.steps[3].output) {
    dagPlan = state.steps[3].output;
  } else {
    dagPlan = dagPlanner.generateDagPlan(effectiveSpecContent, { slug: specSlug, blueprint });
  }

  if (state.steps[3] && state.steps[3].status === 'completed') {
    const step3DispatchMode = options.implementationMode
      || (config.implementation && config.implementation.mode)
      || 'subagent';
    state = recordStepContributions(targetRoot, state, 3, [buildStep3Contribution(state, step3DispatchMode)]);
  }

  // Step 4: Implementation execution (Spec 028 subagent dispatch / Spec 015 command mode)
  const implConfig = (options.implementation || config.implementation || {});
  const implMode = options.implementationMode || implConfig.mode || 'subagent';

  if (startStep <= 4 && state.steps[4].status !== 'completed') {
    state.steps[4].tasks = state.steps[4].tasks || {};
    state.steps[4].gates = state.steps[4].gates || {};
    logStepEnter(4);

    if (options.simulateFailure) {
      console.error(`[Step 4: Implementation] Unrecoverable failure occurred during subagent execution (AC16).`);
      state = stateManager.updateStepState(targetRoot, state.runId, 4, 'failed', { error: 'Simulated unrecoverable subagent execution failure' });
      stateManager.recordError(targetRoot, state.runId, 4, 'Simulated unrecoverable subagent execution failure');
      options._runResult = { runId: state.runId, status: 'failed', error: 'Simulated unrecoverable subagent execution failure' };
      return 1;
    }

    if (useWorktrees && dagPlan.tasks.length <= 1) {
      state.worktreeSkipReason = 'single low-complexity task';
      useWorktrees = false;
      state = stateManager.saveRunState(targetRoot, state);
    }

    const specAcs = dagPlanner.parseAcceptanceCriteria(effectiveSpecContent);

    if (implMode !== 'subagent' && implMode !== 'command') {
      // Spec 028 AC3: `handoff` (and anything unknown) is rejected, never silently skipped.
      const remediation = implMode === 'handoff'
        ? ' The "handoff" mode was replaced by "subagent".'
        : '';
      const errMsg = `Unknown implementation mode "${implMode}". Allowed: subagent, command.${remediation}`;
      console.error(`[Step 4: Implementation] ${errMsg}`);
      state = stateManager.updateStepState(targetRoot, state.runId, 4, 'failed', { error: errMsg });
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', error: errMsg };
      return 1;
    }

    if (implMode === 'subagent') {
      // AC52: subagent mode runs in the primary tree; task worktrees stay command-mode only.
      if (useWorktrees) {
        useWorktrees = false;
        state.worktreeSkipReason = 'subagent mode uses the primary working tree; task worktrees are only created in command mode';
        state = stateManager.saveRunState(targetRoot, state);
        console.log(`[Step 4: Worktree] Worktrees skipped in subagent mode; using the primary working tree.`);
      }

      const dispatch = dispatchNextTask({
        targetRoot,
        state,
        dagPlan,
        specAcs,
        specSlug,
        specPath: state.specPath,
        options
      });
      state = dispatch.state;

      if (!dispatch.ok) {
        console.error(`[Step 4: Dispatch] ${dispatch.reason}`);
        state.steps[4].status = 'failed';
        state.status = 'failed';
        stateManager.saveRunState(targetRoot, state);
        options._runResult = { runId: state.runId, status: 'failed', error: dispatch.reason };
        return 1;
      }

      state.status = 'paused';
      state.steps[4].status = 'awaiting_implementation';
      state = stateManager.saveRunState(targetRoot, state);

      printDispatchEnvelope(dispatch.envelope, state, options);

      options._runResult = {
        runId: state.runId,
        status: 'awaiting_implementation',
        currentStep: 4,
        activeTaskId: dispatch.envelope.taskId,
        sequence: dispatch.envelope.sequence
      };

      // AC29: dispatch pause
      return 4;
    } else if (implMode === 'command') {
      // AC21: execute implementation.command once per DAG task
      console.log(`[Step 4: Implementation] Running in command mode for ${dagPlan.tasks.length} task(s)...`);

      if (useWorktrees) {
        const gitCheck = spawnSync('git', ['--version'], { cwd: targetRoot, encoding: 'utf8' });
        const hasGitDir = fs.existsSync(path.join(targetRoot, '.git'));
        if (gitCheck.status !== 0 || !hasGitDir) {
          console.error('[Step 4: Worktree] Git unavailable or not a git repository for worktree operations.');
          state = stateManager.updateStepState(targetRoot, state.runId, 4, 'worktree_failure', { error: 'Git unavailable' });
          return 1;
        }
      }

      const completedTaskIds = new Set(
        Object.keys(state.steps[4].tasks || {}).filter(k => state.steps[4].tasks[k].status === 'completed')
      );

      for (const task of dagPlan.tasks) {
        if (completedTaskIds.has(task.id)) {
          console.log(`  + [${task.id}] Already completed.`);
          continue;
        }

        // Check DAG dependencies (AC9)
        const depCheck = implementationRunner.checkTaskDependencies(dagPlan, task.id, completedTaskIds);
        if (!depCheck.satisfied) {
          const err = `Task ${task.id} has uncompleted dependencies: ${depCheck.missingDependencies.join(', ')}`;
          console.error(`[Step 4: Implementation] ${err}`);
          state = stateManager.updateStepState(targetRoot, state.runId, 4, 'failed', { error: err });
          return 1;
        }

        let wtInfo = null;
        if (useWorktrees) {
          // AC10: branch from latest integrated commit of primary tree
          try {
            wtInfo = implementationRunner.createTaskWorktree(targetRoot, state.runId, task.id);
          } catch (wtErr) {
            console.error(`[Step 4: Worktree] Error creating worktree: ${wtErr.message}`);
            state = stateManager.updateStepState(targetRoot, state.runId, 4, 'worktree_failure', { error: wtErr.message });
            return 1;
          }
        }

        const rendered = implementationRunner.renderTaskPrompt({
          targetRoot,
          specSlug,
          runId: state.runId,
          stateDir: stateManager.resolveStateDir(targetRoot),
          task,
          specAcs,
          useWorktrees,
          taskWorktreeRel: wtInfo ? wtInfo.worktreeRel : null
        });

        // Execute command
        const commandBaseline = implementationRunner.captureDispatchBaseline(targetRoot);
        const cmdResult = implementationRunner.executeTaskCommand({
          config: {
            ...config,
            implementation: implConfig
          },
          task,
          promptFile: rendered.promptFileAbs,
          evidenceFile: rendered.evidenceFileAbs,
          targetRoot,
          worktreeDir: wtInfo ? wtInfo.worktreeAbs : null,
          specSlug
        });

        if (!cmdResult.success) {
          const errMsg = cmdResult.error || `Task command failed for ${task.id}`;
          console.error(`[Step 4: Implementation] Task ${task.id} failed: ${errMsg}`);
          state = stateManager.updateStepState(targetRoot, state.runId, 4, 'failed', { error: errMsg, task: task.id });
          return 1;
        }

        // Validate evidence file
        const evValidation = evidenceValidator.validateEvidenceFile(rendered.evidenceFileAbs, {
          expectedTaskId: task.id,
          specAcs,
          projectRoot: targetRoot
        });

        if (!evValidation.valid) {
          const errMsg = `Evidence validation failed for ${task.id}:\n  ` + evValidation.errors.join('\n  ');
          console.error(`[Step 4: Implementation] ${errMsg}`);
          state = stateManager.updateStepState(targetRoot, state.runId, 4, 'failed', { error: errMsg, task: task.id });
          return 1;
        }

        const evidenceData = evValidation.data;

        // Verify changes exist (AC14, AC15)
        const hasChanges = implementationRunner.checkTaskChanges(
          targetRoot,
          wtInfo ? wtInfo.worktreeAbs : null,
          useWorktrees,
          evidenceData.filesChanged,
          useWorktrees ? {} : { baseline: commandBaseline }
        );

        if (!hasChanges) {
          const errMsg = useWorktrees
            ? `Task working tree for ${task.id} contains no changes.`
            : `None of the files listed in filesChanged contain modifications in primary working tree.`;
          console.error(`[Step 4: Implementation] ${errMsg}`);
          state = stateManager.updateStepState(targetRoot, state.runId, 4, 'failed', { error: errMsg, task: task.id });
          return 1;
        }

        let commitSha = null;
        if (useWorktrees && wtInfo) {
          try {
            const intRes = implementationRunner.integrateTaskWorktree({
              targetRoot,
              specSlug,
              taskId: task.id,
              taskWorktreeAbs: wtInfo.worktreeAbs,
              taskWorktreeRel: wtInfo.worktreeRel,
              taskBranch: wtInfo.branch
            });
            commitSha = intRes.commitSha;
            state.worktrees = state.worktrees || [];
            state.worktrees.push({
              taskId: task.id,
              path: wtInfo.worktreeRel,
              branch: wtInfo.branch,
              status: 'integrated',
              commitSha
            });
          } catch (cpErr) {
            console.error(`[Step 4: Worktree] ${cpErr.message}`);
            state = stateManager.updateStepState(targetRoot, state.runId, 4, 'worktree_conflict', { error: cpErr.message });
            return 1;
          }
        } else {
          commitSha = getBaseCommit(targetRoot);
        }

        state.steps[4].tasks[task.id] = {
          id: task.id,
          title: task.title,
          status: 'completed',
          promptPath: rendered.promptFileRel,
          evidencePath: rendered.evidenceFileRel,
          commitSha,
          filesChanged: evidenceData.filesChanged,
          acIds: evidenceData.acIds,
          evidenceStatus: evidenceData.status || 'success',
          completedAt: new Date().toISOString()
        };
        completedTaskIds.add(task.id);
        stateManager.saveRunState(targetRoot, state);
        console.log(`[Step 4: Implementation] Task ${task.id} accepted (commit ${commitSha}, ${evidenceData.acIds.length} ACs, ${evidenceData.filesChanged.length} files).`);
        logTaskAccepted(state, task.id);
      }

      const gateResults = runVerificationGates(targetRoot, config, { ...options, runId: state.runId, slug: specSlug });
      if (!gateResults.passed) {
        state = stateManager.loadRunState(targetRoot, state.runId);
        state.steps[4].status = 'failed';
        state.steps[4].gates = gateResults.gates;
        state.status = 'failed';
        stateManager.saveRunState(targetRoot, state);
        return 1;
      }
      state.steps[4].gates = gateResults.gates;

      state = stateManager.updateStepState(targetRoot, state.runId, 4, 'completed', {
        tasks: state.steps[4].tasks,
        gates: state.steps[4].gates
      });
      logStepDone(4);
      state = recordStepContributions(targetRoot, state, 4, buildStep4Contributions(state));
    }
  }

  // Second pass with no accepted file changes: report and stop before scoring.
  if (refineMode && startStep <= 5 && state.status !== 'completed' && state.steps[5].status !== 'completed') {
    const acceptedRefineTasks = Object.values(state.steps[4].tasks || {}).filter(t => t.status === 'completed');
    const refineFiles = acceptedRefineTasks.flatMap(t => (Array.isArray(t.filesChanged) ? t.filesChanged : []));
    if (acceptedRefineTasks.length > 0 && refineFiles.length === 0) {
      const refineSummary = acceptedRefineTasks.map(t => t.summary).filter(Boolean).join(' ');
      const refineReport = artifactWriter.writeRefineReport({
        targetRoot,
        specSlug,
        runId: state.runId,
        artifactsDir: state.artifactsDir,
        specPath: state.specPath,
        baseCommit: state.baseCommit,
        outcome: 'no-change',
        deliveryCommit: null,
        score: null,
        summary: refineSummary,
        acIds: (state.dagTasks || []).flatMap(t => t.coveredAcs || []),
        filesChanged: []
      });
      state = stateManager.updateStepState(targetRoot, state.runId, 5, 'skipped', { reason: 'second pass produced no code change' });
      state = stateManager.updateStepState(targetRoot, state.runId, 6, 'skipped', { reason: 'second pass produced no code change', deliveryCommit: null });
      state = stateManager.updateStepState(targetRoot, state.runId, 7, 'skipped', { reason: 'second pass produced no code change' });
      state = stateManager.updateStepState(targetRoot, state.runId, 8, 'skipped', { reason: 'second pass produced no code change; nothing to ship' });
      // Set the outcome fields after the step updates: each update reloads state.
      state.refineReport = refineReport;
      state.deliveryCommitCreated = false;
      state.status = 'completed';
      state.currentStep = 8;
      state = stateManager.saveRunState(targetRoot, state);
      console.log(`[sdw-orch] Second pass finished with no code change. Report: ${refineReport || '(not written)'}`);
      options._runResult = { runId: state.runId, status: 'completed', refineOutcome: 'no-change', report: refineReport };
      return 0;
    }
  }

  // Step 5: Conformance Scoring — LLM judge (Spec 027)
  let scoreReport = null;
  if (startStep <= 5 && state.steps[5].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 5, 'in_progress');
    logStepEnter(5);

    const specAcs = dagPlanner.parseAcceptanceCriteria(effectiveSpecContent);
    const judgeConfig = scoreEvaluator.resolveJudgeConfig({ scoring: options.scoring || config.scoring });
    const judgePaths = scoreEvaluator.resolveJudgePaths({
      targetRoot,
      stateDir: stateManager.resolveStateDir(targetRoot),
      slug: specSlug,
      runId: state.runId
    });
    const scoringTouchedFiles = scoreEvaluator.getTouchedFiles(state.baseCommit, targetRoot);

    const failClosedScoring = (message, judgeMeta) => {
      const failedReport = {
        score: 0,
        passed: false,
        minScore: effectiveMinScore,
        totalAcs: specAcs.length,
        verifiedCount: 0,
        failingCount: specAcs.length,
        verifiedAcs: [],
        failingAcs: specAcs.map(ac => ({ id: ac.id, text: ac.text, reason: message })),
        touchedFiles: scoringTouchedFiles,
        evidenceLinks: {},
        judge: {
          mode: (judgeMeta && judgeMeta.mode) || judgeConfig.mode,
          criticity: (judgeMeta && judgeMeta.criticity) || judgeConfig.criticity,
          model: judgeConfig.model,
          provider: judgeConfig.provider,
          effort: judgeConfig.effort,
          apiEndpoint: judgeConfig.apiEndpoint,
          reportedScore: null,
          scoreMismatch: false,
          notes: null,
          diffBytes: judgeMeta ? judgeMeta.diffBytes : null,
          diffTruncated: judgeMeta ? Boolean(judgeMeta.diffTruncated) : false
        },
        feedback: `Conformance scoring failed closed: ${message}`
      };
      const failedArtifact = artifactWriter.writeStep5Artifact({
        targetRoot,
        specSlug,
        runId: state.runId,
        scoreReport: failedReport,
        dagPlan,
        artifactsDir: state.artifactsDir
      });
      state = stateManager.updateStepState(targetRoot, state.runId, 5, 'reimplementation_needed', failedReport, message, { artifact: failedArtifact });
      state.score = 0;
      state.scoreIteration = (state.scoreIteration || 0) + 1;
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      console.error(`[Step 5: Conformance Scoring] ${message}`);
      options._runResult = { runId: state.runId, status: 'failed', score: 0, error: message };
      return 2;
    };

    // AC8: a specification without acceptance criteria scores 0 and never invokes the judge.
    if (specAcs.length === 0) {
      return failClosedScoring('Specification has no acceptance criteria. Fails closed with score 0/10; the judge is not invoked.', { mode: 'none' });
    }

    const priorScoring = state.steps[5] && state.steps[5].output;
    let verdict = (priorScoring && priorScoring.verdict) || null;
    let judgeResolution = (priorScoring && priorScoring.judgeResolution) || 'agent';
    let judgeMeta = (priorScoring && priorScoring.judge) || {
      mode: judgeConfig.mode,
      criticity: judgeConfig.criticity,
      model: judgeConfig.model,
      provider: judgeConfig.provider,
      effort: judgeConfig.effort,
      apiEndpoint: judgeConfig.apiEndpoint,
      diffBytes: null,
      diffTruncated: false
    };

    // The verdict must cover the criteria the judge actually received, which are
    // recorded when the judge prompt is written.
    const judgeCriteria = (priorScoring && Array.isArray(priorScoring.judgeAcIds) && priorScoring.judgeAcIds.length > 0)
      ? priorScoring.judgeAcIds.map(id => {
          const match = specAcs.find(ac => ac.id === id);
          return { id, text: match ? match.text : '' };
        })
      : specAcs;

    if (verdict) {
      console.log(`[Step 5: Conformance Scoring] Reusing submitted judge verdict (${judgeResolution}).`);
    } else {
      const judgeDiff = scoreEvaluator.collectDiff(targetRoot, state.baseCommit);
      const judgeBundle = scoreEvaluator.buildJudgePrompt({
        slug: specSlug,
        acs: specAcs,
        diff: judgeDiff,
        criticity: judgeConfig.criticity,
        judge: judgeConfig
      });

      fs.mkdirSync(judgePaths.dir, { recursive: true });
      fs.writeFileSync(judgePaths.promptFileAbs, judgeBundle.prompt, 'utf8');
      fs.writeFileSync(judgePaths.diffFileAbs, judgeDiff.text || '', 'utf8');
      fs.writeFileSync(judgePaths.criteriaFileAbs, judgeBundle.criteriaText, 'utf8');

      judgeMeta = {
        mode: judgeConfig.mode,
        criticity: judgeBundle.criticity,
        model: judgeConfig.model,
        provider: judgeConfig.provider,
        effort: judgeConfig.effort,
        apiEndpoint: judgeConfig.apiEndpoint,
        diffBytes: judgeBundle.diffBytes,
        diffTruncated: judgeBundle.diffTruncated
      };

      if (judgeConfig.command) {
        console.log(`[Step 5: Conformance Scoring] Invoking configured judge command (criticity: ${judgeBundle.criticity}).`);
        const judgeRun = scoreEvaluator.runJudgeCommand({
          config,
          judge: judgeConfig,
          promptFileAbs: judgePaths.promptFileAbs,
          verdictFileAbs: judgePaths.verdictFileAbs,
          diffFileAbs: judgePaths.diffFileAbs,
          criteriaFileAbs: judgePaths.criteriaFileAbs,
          slug: specSlug,
          targetRoot
        });
        if (!judgeRun.success) {
          return failClosedScoring(`Judge command failed: ${judgeRun.error}`, judgeMeta);
        }
        const judgeRead = scoreEvaluator.readVerdictFile(judgePaths.verdictFileAbs);
        if (!judgeRead.ok) {
          return failClosedScoring(judgeRead.error, judgeMeta);
        }
        verdict = judgeRead.verdict;
        judgeResolution = 'command';
      } else {
        const pausedOutput = {
          status: 'awaiting_judgment',
          judgePromptPath: judgePaths.promptFileRel,
          judgeVerdictPath: judgePaths.verdictFileRel,
          judgeAcIds: specAcs.map(ac => ac.id),
          judge: judgeMeta
        };
        state = stateManager.updateStepState(targetRoot, state.runId, 5, 'awaiting_judgment', pausedOutput);
        state.status = 'paused';
        stateManager.saveRunState(targetRoot, state);
        console.log(`\n[Step 5: Conformance Scoring] Status: awaiting_judgment (criticity: ${judgeBundle.criticity}).`);
        console.log(`Judge context is fenced to the acceptance criteria and the generated diff only (${judgeBundle.diffBytes} bytes${judgeBundle.diffTruncated ? ', truncated' : ''}).`);
        console.log(`  Prompt:  ${judgePaths.promptFileRel}`);
        console.log(`  Verdict: ${judgePaths.verdictFileRel}`);
        console.log(`\nJudge each criterion against the diff, write the verdict JSON, then submit it with:`);
        console.log(`  node "${orchCommandPath()}" score submit --run-id ${state.runId} --verdict <verdictFile>`);
        options._runResult = {
          runId: state.runId,
          status: 'awaiting_judgment',
          currentStep: 5,
          judgePromptPath: judgePaths.promptFileRel,
          judgeVerdictPath: judgePaths.verdictFileRel
        };
        return 5;
      }
    }

    const verdictValidation = scoreEvaluator.validateVerdict(verdict, { acs: judgeCriteria });
    if (!verdictValidation.valid) {
      return failClosedScoring(
        'Judge verdict is malformed or incomplete:\n  - ' + verdictValidation.errors.join('\n  - '),
        judgeMeta
      );
    }

    scoreReport = scoreEvaluator.applyVerdict(verdictValidation.data, {
      acs: judgeCriteria,
      minScore: effectiveMinScore,
      touchedFiles: scoringTouchedFiles,
      judge: { ...judgeMeta, mode: judgeResolution }
    });

    console.log(`[Step 5: Conformance Scoring] Score: ${scoreReport.score}/10 (Required: ${effectiveMinScore}/10). Passed: ${scoreReport.passed}`);
    console.log(`  Verified ACs: ${scoreReport.verifiedCount}/${scoreReport.totalAcs}`);
    console.log(`  Failing ACs:  ${scoreReport.failingCount}/${scoreReport.totalAcs}`);
    if (scoreReport.passed && scoreReport.failingCount > 0) {
      console.warn(`[Step 5: Conformance Scoring] Warning: ${scoreReport.failingCount} AC(s) failed verification despite meeting minScore threshold (${effectiveMinScore}/10).`);
    }

    const step5Artifact = artifactWriter.writeStep5Artifact({
      targetRoot,
      specSlug,
      runId: state.runId,
      scoreReport,
      dagPlan,
      artifactsDir: state.artifactsDir
    });

    const scoredOutput = {
      ...scoreReport,
      verdict: verdictValidation.data,
      judgeResolution,
      judgePromptPath: judgePaths.promptFileRel,
      judgeVerdictPath: judgePaths.verdictFileRel,
      judgeAcIds: judgeCriteria.map(ac => ac.id),
      judgedAt: new Date().toISOString()
    };

    if (!scoreReport.passed) {
      console.error(`[Step 5: Conformance Scoring] Conformance score below threshold (${scoreReport.score} < ${effectiveMinScore}). Triggering re-implementation feedback loop.`);
      state = stateManager.updateStepState(targetRoot, state.runId, 5, 'reimplementation_needed', scoredOutput, null, { artifact: step5Artifact });
      state.score = scoreReport.score;
      state.scoreIteration = (state.scoreIteration || 0) + 1;
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', score: scoreReport.score, error: 'Conformance score below threshold' };
      return 2; // Exit code 2 indicates score failure / re-implementation needed
    }

    state = stateManager.updateStepState(targetRoot, state.runId, 5, 'completed', scoredOutput, null, { artifact: step5Artifact });
    logStepDone(5);
    state.score = scoreReport.score;
    state.scoreIteration = (state.scoreIteration || 0) + 1;
    state = stateManager.saveRunState(targetRoot, state);
    state = replaceStep5Contributions(state);
    state = recordStepContributions(targetRoot, state, 5, buildStep5Contributions(state, state.steps[5].output, effectiveMinScore));
  } else if (state.steps[5] && state.steps[5].output) {
    scoreReport = state.steps[5].output;
    if (state.score === null && scoreReport.score !== undefined) {
      state.score = scoreReport.score;
    }
  }

  // Step 6: Delivery Commit (AC11, AC20, AC25)
  if (startStep <= 6 && state.steps[6].status !== 'completed') {
    logStepEnter(6);
    // Quality gate: enforce Step 4 completion (AC20, AC25)
    if (!state.steps[4] || state.steps[4].status !== 'completed') {
      console.error(`[Step 6: Delivery Commit] Blocked: cannot create delivery commit because Step 4 is not completed.`);
      state = stateManager.updateStepState(targetRoot, state.runId, 6, 'blocked_step4_incomplete');
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', error: 'Blocked: Step 4 is not completed' };
      return 1;
    }

    const step4Tasks = (state.steps[4] && state.steps[4].tasks) || {};
    const dagTasks = state.dagTasks || (state.steps[3] && state.steps[3].output && state.steps[3].output.tasks) || [];
    const unacceptedTasks = dagTasks.filter(t => !step4Tasks[t.id] || step4Tasks[t.id].status !== 'completed');
    if (unacceptedTasks.length > 0) {
      console.error(`[Step 6: Delivery Commit] Blocked: ${unacceptedTasks.length} task(s) are not accepted (${unacceptedTasks.map(t => t.id).join(', ')}).`);
      state = stateManager.updateStepState(targetRoot, state.runId, 6, 'blocked_tasks_incomplete');
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', error: 'Blocked: Tasks not accepted' };
      return 1;
    }

    const topGates = (state.steps[4] && state.steps[4].gates) || {};
    const outGates = (state.steps[4] && state.steps[4].output && state.steps[4].output.gates) || {};
    const gates = Object.keys(topGates).length > 0 ? topGates : outGates;
    const failedGates = Object.keys(gates).filter(g => gates[g].status !== 'passed');
    if (failedGates.length > 0) {
      console.error(`[Step 6: Delivery Commit] Blocked: required verification gate(s) failed (${failedGates.join(', ')}).`);
      state = stateManager.updateStepState(targetRoot, state.runId, 6, 'blocked_gates_failed');
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', error: 'Blocked: Gates failed' };
      return 1;
    }

    // Quality gate: enforce score threshold before commit
    if (state.score !== null && state.score < effectiveMinScore) {
      console.error(`[Step 6: Delivery Commit] Blocked: cannot create delivery commit with failing conformance score (${state.score}/${effectiveMinScore}).`);
      return 2;
    }

    // Security checks gate (AC6, AC8, AC9, AC10, AC12)
    const securityChecksEnabled = Boolean(config.securityChecksEnabled);
    if (securityChecksEnabled) {
      if (options.skipSecurity) {
        console.log(`[Step 6: Security Gate] Pre-commit security check bypassed via --skip-security.`);
        state.securityGate = { bypassed: true, reason: '--skip-security' };
      } else {
        console.log(`[Step 6: Security Gate] securityChecksEnabled=true; running pre-commit leak scan...`);
        // Scan the worktree before staging: implementation changes are typically unstaged at this point.
        const scanResult = runSecurityGate(targetRoot, { staged: false });
        state.securityGate = {
          bypassed: false,
          exitCode: scanResult.exitCode,
          severityCounts: scanResult.severityCounts,
          findings: scanResult.findings
        };
        if (scanResult.exitCode !== 0) {
          console.error(`[Step 6: Security Gate] Commit blocked by security checks gate (exit code ${scanResult.exitCode}).`);
          state = stateManager.updateStepState(targetRoot, state.runId, 6, 'security_blocked', scanResult);
          state.status = 'failed';
          stateManager.saveRunState(targetRoot, state);
          options._runResult = { runId: state.runId, status: 'failed', error: 'Blocked by pre-commit security checks gate' };
          return scanResult.exitCode;
        }
        console.log(`[Step 6: Security Gate] Pre-commit security check passed.`);
      }
    }

    state = stateManager.updateStepState(targetRoot, state.runId, 6, 'in_progress');
    let commitSha = null;
    let deliveryCommitCreated = false;
    const stagedDeliveryFiles = new Set();
    try {
      // Spec 00058 AC17/AC18: the delivery commit never touches the registry.
      // A run that fails after this point must leave the registry row unchanged,
      // so the row flips only after the delivery stage in Step 8.
      if (!isGitRepo(targetRoot)) {
        console.log(`[Step 6: Delivery Commit] Non-git workspace: delivery commit skipped.`);
        commitSha = null;
      } else {
        // Scoped delivery commit: stage only tracked spec files (evidence
        // filesChanged + spec index). Unrelated worktree changes are left alone.
        const deliveryFiles = collectDeliveryFiles(targetRoot, specSlug, state);
        for (const file of deliveryFiles) stagedDeliveryFiles.add(file);
        if (deliveryFiles.length > 0) {
          console.log(`[Step 6: Delivery Commit] Staging scoped delivery files (${deliveryFiles.length}): ${deliveryFiles.join(', ')}`);
          const commitMessage = refineMode
            ? `refine(${specSlug}): second pass refinement`
            : `feat(${specSlug}): implement ${specSlug}`;
          const res = stageAndCommitOnly(targetRoot, deliveryFiles, commitMessage);
          commitSha = res.commitSha;
          deliveryCommitCreated = Boolean(res.committed);
          if (res.committed) {
            console.log(`[Step 6: Delivery Commit] Created delivery commit ${commitSha}`);
          } else {
            console.log(`[Step 6: Delivery Commit] No scoped changes to commit; using commit ${commitSha}`);
          }
        } else {
          commitSha = getBaseCommit(targetRoot) || baseCommit;
          console.log(`[Step 6: Delivery Commit] No tracked spec files to commit; using commit ${commitSha}`);
        }
        // Unclaimed run-modification capture: files dirtied during the run
        // but owned by no task (e.g. parent-level verification gate fixes).
        // Pre-existing WIP from the dispatch baseline is left alone. When no baseline exists, preserve legacy scoped-only behavior.
        try {
          const baseline = state.steps[4] && state.steps[4].dispatch && state.steps[4].dispatch.baseline;
          const baselineDirty = new Set(((baseline && baseline.dirty) || []).map(normalizeRel));
          if (baseline) {
          const deliverySet = new Set(deliveryFiles.map(normalizeRel));
          const unclaimed = getStatusFiles(targetRoot)
            .map(normalizeRel)
            .filter((f) => !deliverySet.has(f) && !baselineDirty.has(f))
            .filter((f) => isGitTracked(targetRoot, f));
          if (unclaimed.length > 0) {
            console.log(`[Step 6: Delivery Commit] Staging unclaimed run modifications (${unclaimed.length}): ${unclaimed.join(', ')}`);
            for (const file of unclaimed) stagedDeliveryFiles.add(file);
            const gateRes = stageAndCommitOnly(targetRoot, unclaimed, `chore(${specSlug}): include verification gate fixes`);
            if (gateRes.committed) {
              commitSha = gateRes.commitSha;
              deliveryCommitCreated = true;
              console.log(`[Step 6: Delivery Commit] Created gate-fix commit ${commitSha}`);
            }
          }
          } // baseline guard, preserve legacy scoped-only behavior otherwise
        } catch (e) {
          const captureErr = new Error(`Unclaimed capture failed: ${e.message}`);
          captureErr.captureFailure = true;
          throw captureErr;
        }
      }
    } catch (err) {
      console.error(`[Step 6: Delivery Commit] Git error: ${err.message}`);
      if (err && err.captureFailure) {
        state = stateManager.updateStepState(targetRoot, state.runId, 6, 'capture_failed', { error: err.message });
        state.status = 'failed';
        stateManager.saveRunState(targetRoot, state);
        options._runResult = { runId: state.runId, status: 'failed', error: `Step 6 gate-fix capture failed: ${err.message}` };
        return 1;
      }
      commitSha = getBaseCommit(targetRoot);
    }
    state.deliveryCommit = commitSha;
    state.deliveryCommitCreated = deliveryCommitCreated;
    state = stateManager.saveRunState(targetRoot, state);
    state = stateManager.updateStepState(targetRoot, state.runId, 6, 'completed', { deliveryCommit: commitSha, deliveryCommitCreated });
    logStepDone(6);
    state = recordStepContributions(targetRoot, state, 6, [buildStep6Contribution(state, {
      deliveryCommit: commitSha,
      deliveryCommitCreated,
      stagedFiles: [...stagedDeliveryFiles].sort()
    })]);
    if (refineMode && deliveryCommitCreated) {
      const refineTasks = Object.values(state.steps[4].tasks || {}).filter(t => t.status === 'completed');
      const refineReport = artifactWriter.writeRefineReport({
        targetRoot,
        specSlug,
        runId: state.runId,
        artifactsDir: state.artifactsDir,
        specPath: state.specPath,
        baseCommit: state.baseCommit,
        outcome: 'changed',
        deliveryCommit: commitSha,
        score: state.score,
        summary: refineTasks.map(t => t.summary).filter(Boolean).join(' '),
        acIds: (state.dagTasks || []).flatMap(t => t.coveredAcs || []),
        filesChanged: refineTasks.flatMap(t => (Array.isArray(t.filesChanged) ? t.filesChanged : []))
      });
      state.refineReport = refineReport;
      state = stateManager.saveRunState(targetRoot, state);
      console.log(`[sdw-orch] Second pass produced commit ${commitSha}. Report: ${refineReport || '(not written)'}`);
    }
  }

  // Step 7: Delegated Code Review via sdw-code-review (Spec 025)
  // Sole review authority is skills/sdw-code-review; orchestrator dispatches
  // CLI runner (or subagent in handoff) and inspects the JSON report.
  if (startStep <= 7 && state.steps[7].status !== 'completed' && !options.skipReview && !isGitRepo(targetRoot)) {
    // sdw-code-review requires a git range to review; a non-git workspace cannot host it.
    logStepEnter(7);
    console.log('[Step 7: Delegated Review] Non-git workspace: review skipped.');
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'skipped', { reason: 'non-git workspace' });
    logStepDone(7);
    state = recordStepContributions(targetRoot, state, 7, [{
      kind: 'review',
      title: 'Code review skipped',
      body: { skipped: true, reason: 'non-git workspace' },
      evidence: []
    }]);
  } else if (startStep <= 7 && state.steps[7].status !== 'completed' && !options.skipReview) {
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'in_progress');
    logStepEnter(7);
    const resolvedCodeReviewScript = resolveSkillScript(targetRoot, 'sdw-code-review', path.join('scripts', 'sdw_code_review.cjs'), resolveOptions);
    const codeReviewScript = resolvedCodeReviewScript || path.resolve(__dirname, '../../sdw-code-review/scripts/sdw_code_review.cjs');
    const hasCodeReview = fs.existsSync(codeReviewScript);

    if (!hasCodeReview) {
      const msg = `sdw-code-review skill missing at "${codeReviewScript}". Run packaging installer to restore skills/.`;
      console.error(`[Step 7: Delegated Review] ${msg}`);
      state = stateManager.updateStepState(targetRoot, state.runId, 7, 'review_failed', { error: msg });
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', error: msg };
      return 1;
    }

    let artifactsDirAbs = null;
    try {
      artifactsDirAbs = artifactWriter.ensureArtifactDir(targetRoot, specSlug, state.runId, state.artifactsDir);
    } catch (e) { artifactsDirAbs = null; }
    const reportAbsPath = artifactsDirAbs
      ? path.join(artifactsDirAbs, `${specSlug}-step-7.md`)
      : path.join(targetRoot, '.sdw', 'state', 'code-review.report.md');

    function parseReviewJson(stdout) {
      try {
        const t = String(stdout || '').trim();
        if (!t) return null;
        const s = t.indexOf('{');
        const e = t.lastIndexOf('}');
        if (s !== -1 && e !== -1 && e > s) return JSON.parse(t.slice(s, e + 1));
        return JSON.parse(t);
      } catch (err) { return null; }
    }

    function invokeCodeReviewCli(useFix) {
      const cliArgs = [codeReviewScript, 'run', '--target', targetRoot, '--report', reportAbsPath, '--json', '--max-iterations', '1'];
      if (state.baseCommit) cliArgs.push('--base', state.baseCommit);
      if (useFix) cliArgs.push('--fix');
      try {
        const proc = spawnSync(process.execPath, cliArgs, { cwd: targetRoot, encoding: 'utf8' });
        const parsed = parseReviewJson(proc.stdout);
        if (parsed) return { report: parsed, exitCode: proc.status };
      } catch (e) {}
      return null;
    }

    function invokeCodeReviewModule(useFix) {
      try {
        const cr = require(codeReviewScript);
        const report = cr.runCodeReview({
          projectRoot: targetRoot,
          base: state.baseCommit || null,
          report: reportAbsPath,
          fix: Boolean(useFix),
          dryRun: false,
          maxIterations: 1
        });
        return { report, exitCode: report.passed ? 0 : 1 };
      } catch (e) { return null; }
    }

    function invokeReview(useFix) {
      return invokeCodeReviewCli(useFix) || invokeCodeReviewModule(useFix);
    }

    console.log(`[Step 7: Delegated Review] Dispatching sdw-code-review (CLI) against base '${state.baseCommit || 'auto'}'...`);
    let first = invokeReview(false);
    if (!first || !first.report) {
      const msg = 'sdw-code-review invocation failed with no parsable JSON report.';
      console.error(`[Step 7: Delegated Review] ${msg}`);
      state = stateManager.updateStepState(targetRoot, state.runId, 7, 'review_failed', { error: msg });
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', error: msg };
      return 1;
    }
    let reviewReport = first.report;
    const reviewIterations = [];
    reviewIterations.push({
      iteration: 1,
      findings: reviewSeverityCounts(reviewReport.findings),
      fixes: [],
      passed: Boolean(reviewReport.passed)
    });
    console.log(`[Step 7: Delegated Review] ${reviewReport.passed ? 'Code review passed.' : `Code review failed with ${reviewReport.blockingCount || 0} blocking finding(s).`} Report: ${reviewReport.reportPath || reportAbsPath}`);

    let reviewLoop = 0;
    while (reviewReport && !reviewReport.passed && reviewLoop < 3) {
      const fixable = (reviewReport.findings || []).filter(f => f.fixable && f.status === 'open');
      if (fixable.length === 0) break;
      reviewLoop++;
      console.log(`[Step 7: Delegated Review] Applying auto-fixes for iteration ${reviewLoop}...`);
      const fixRes = invokeReview(true);
      if (!fixRes || !fixRes.report) break;
      const fixedFiles = fixRes.report.fixedFiles || [];
      reviewIterations.push({
        iteration: reviewIterations.length + 1,
        findings: reviewSeverityCounts(fixRes.report.findings),
        fixes: fixedFiles,
        passed: Boolean(fixRes.report.passed)
      });
      if (fixedFiles.length === 0) {
        reviewReport = fixRes.report;
        break;
      }
      if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
        console.log(`[Step 7: Security Gate] Running pre-commit leak scan before review-fix commit...`);
        const scanResult = runSecurityGate(targetRoot, { staged: false });
        if (scanResult.exitCode !== 0) {
          console.error(`[Step 7: Security Gate] Review-fix commit blocked by security checks gate (exit code ${scanResult.exitCode}).`);
          reviewReport = fixRes.report;
          break;
        }
      }
      try {
        stageAndCommitOnly(targetRoot, fixedFiles, `fix(${specSlug}): apply automated review fixes (iteration ${reviewLoop})`);
      } catch (e) {}
      const verify = invokeReview(false);
      reviewReport = (verify && verify.report) ? verify.report : fixRes.report;
    }

    state.reviewIteration = reviewLoop;
    let artifactRel = null;
    try {
      artifactRel = path.relative(targetRoot, reportAbsPath).replace(/\\/g, '/');
    } catch (e) { artifactRel = null; }
    if (!reviewReport.passed) {
      console.error(`[Step 7: Delegated Review] Review loop halted with unresolved errors.`);
      state = stateManager.updateStepState(targetRoot, state.runId, 7, 'review_failed', reviewReport, null, artifactRel ? { artifact: artifactRel } : undefined);
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      state = recordStepContributions(targetRoot, state, 7, buildStep7Contributions(reviewIterations, artifactRel), { allowDuplicates: true });
      options._runResult = { runId: state.runId, status: 'failed', error: 'Unresolved code review findings' };
      return 1;
    }

    state.reviewCommit = getBaseCommit(targetRoot);
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'completed', reviewReport, null, artifactRel ? { artifact: artifactRel } : undefined);
    logStepDone(7);
    state = recordStepContributions(targetRoot, state, 7, buildStep7Contributions(reviewIterations, artifactRel), { allowDuplicates: true });
  } else if (options.skipReview) {
    logStepEnter(7);
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'skipped', { reason: 'Skipped via --skip-review' });
    logStepDone(7);
    state = recordStepContributions(targetRoot, state, 7, [{
      kind: 'review',
      title: 'Code review skipped',
      body: { skipped: true, reason: 'Skipped via --skip-review' },
      evidence: []
    }]);
  }

  // Spec 00054 AC1, AC15, AC16, AC17: Step 7 has resolved, so write the delivery
  // report as a companion file beside the specification before Step 8 delegates
  // delivery to sdw-ship-pr. The same path is rewritten from current state on a
  // resumed run; a write or commit failure records a warning and never fails
  // delivery.
  {
    const writtenReport = deliveryReport.writeDeliveryReport({
      targetRoot,
      state,
      minScore: effectiveMinScore
    });
    if (writtenReport) {
      state.deliveryReport = writtenReport.relPath;
      state = stateManager.saveRunState(targetRoot, state);
      state = recordContributionWarnings(targetRoot, state, writtenReport.warnings);
      console.log(`[sdw-orch] Delivery report written: ${writtenReport.relPath}`);
      // AC15: the report is committed whenever it is written, including
      // --skip-pr and second-pass runs; only the git-repo precondition remains.
      if (isGitRepo(targetRoot)) {
        try {
          stageAndCommitOnly(
            targetRoot,
            [writtenReport.relPath],
            `docs(${specSlug}): record delivery report`
          );
        } catch (reportCommitErr) {
          stateManager.recordWarning(
            targetRoot,
            state.runId,
            7,
            `Delivery report warning: report could not be committed: ${reportCommitErr.message}`
          );
          state = stateManager.loadRunState(targetRoot, state.runId) || state;
        }
      }
    } else {
      stateManager.recordWarning(
        targetRoot,
        state.runId,
        7,
        `Delivery report warning: report could not be written at the companion path of "${state.specPath || '(no specification path)'}"`
      );
      state = stateManager.loadRunState(targetRoot, state.runId) || state;
    }
  }

  // Spec 00057 AC9: the companion write is also a step boundary, so the
  // in-progress report is refreshed from the same contribution list.
  state = refreshInProgressReport(targetRoot, state);

  // Step 8: PR Preparation, Pre-PR Gates & Remote Comment Loop (AC5, AC6, AC7, AC8, AC9, AC10, AC11, AC12, AC14, AC15)
  const resolvedShipPrScript = resolveSkillScript(targetRoot, 'sdw-ship-pr', path.join('scripts', 'sdw_ship_pr.cjs'), resolveOptions);
  const shipPrScript = resolvedShipPrScript || path.resolve(__dirname, '../../sdw-ship-pr/scripts/sdw_ship_pr.cjs');
  const hasShipPr = fs.existsSync(shipPrScript);

  const refineSkipShip = refineMode && state.deliveryCommitCreated === false;

  // Spec 00058 AC17/AC18/AC19: the registry row is the last record the delivery
  // owns. It flips only once the delivery stage reported the delivery, or when
  // `--skip-pr` is in effect, and the specification header follows it in the
  // same transition. A run that failed earlier leaves both untouched.
  const markSpecCompleted = () => {
    if (!specIndex || refineMode || typeof specIndex.updateSpecStatus !== 'function') return;
    try {
      specIndex.updateSpecStatus(specSlug, 'completed', { root: targetRoot });
    } catch (e) {
      // AC17: this transition owns the registry truth, so a failed write is
      // surfaced on the run instead of leaving a stale row behind silently. The
      // delivery already shipped, so the row is repaired by `sdw-spec sync`,
      // which reports the drift; the run records why it is stale.
      const message = `registry transition to completed failed for "${specSlug}": ${e.message}`;
      console.warn(`[sdw-orch] Warning: ${message}`);
      try {
        stateManager.recordWarning(targetRoot, state.runId, 8, message);
        state = stateManager.loadRunState(targetRoot, state.runId) || state;
      } catch (warnErr) {
        console.warn(`[sdw-orch] Warning: could not record the registry transition failure: ${warnErr.message}`);
      }
    }
  };

  if (refineSkipShip && state.steps[8].status !== 'completed' && state.steps[8].status !== 'skipped') {
    logStepEnter(8);
    console.log('[Step 8: PR Preparation] Second pass produced no new commit; nothing to ship.');
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'skipped', { reason: 'second pass produced no code to ship' });
    logStepDone(8);
  } else if (startStep <= 8 && state.steps[8].status !== 'completed' && !options.skipPr) {
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'in_progress');
    logStepEnter(8);
    const step8GateAttempts = [];
    let step8ShipResult = null;

    // If sdw-ship-pr is available and no unit-test fixer hooks are passed, delegate pre-PR gates to sdw-ship-pr as single owner
    if (!hasShipPr || options.testFixer || options.buildFixer || options.prePrHook) {
      // 1. Project-Specific Pre-PR Instructions / Lifecycle Hook (AC11, AC12)
      if (config.prePrInstructions) {
        console.log(`[Step 8: Pre-PR Gate] Evaluating project pre-PR instructions: "${config.prePrInstructions}"`);
      }
      if (config.prePrCommand || typeof options.prePrHook === 'function') {
        const prePrBefore = snapshotStats(targetRoot);
        try {
          if (config.prePrCommand) {
            console.log(`[Step 8: Pre-PR Gate] Executing pre-PR command: "${config.prePrCommand}"...`);
            execSync(config.prePrCommand, { cwd: targetRoot, stdio: 'inherit' });
            step8GateAttempts.push({ name: 'prePrCommand', status: 'passed', detail: config.prePrCommand });
          }
          if (typeof options.prePrHook === 'function') {
            options.prePrHook(targetRoot);
          }
          const prePrDelta = diffSinceSnapshot(targetRoot, prePrBefore);
          if (prePrDelta.length > 0) {
            // Verify secret leaks before staging pre-PR modifications (AC12)
            if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
              const secRes = runSecurityGate(targetRoot, { staged: false });
              if (secRes.exitCode !== 0) {
                console.error(`[Step 8: Pre-PR Gate] Pre-PR changes rejected by security leak check.`);
                state.status = 'failed';
                stateManager.recordError(targetRoot, state.runId, 8, 'Pre-PR changes rejected by security leak check');
                return 1;
              }
            }
            stageAndCommitOnly(targetRoot, prePrDelta, `chore(${specSlug}): apply pre-pr requirements`);
            state.deliveryCommit = getBaseCommit(targetRoot);
            stateManager.saveRunState(targetRoot, state);
          }
        } catch (err) {
          console.error(`[Step 8: Pre-PR Gate] Pre-PR command failed: ${err.message}`);
          step8GateAttempts.push({ name: 'prePrCommand', status: 'failed', detail: err.message });
          state.status = 'failed';
          stateManager.recordError(targetRoot, state.runId, 8, `Pre-PR command failed: ${err.message}`);
          return 1;
        }
      }

      // 2. Pre-PR Quality Gates (Build Verification & Full Test Pass) (AC5, AC6, AC7, AC8, AC9, AC10)
      const requiredBuild = Boolean(config.requiredBuild);
      const runAllTests = Boolean(config.runAllTests);
      const gateTimeoutMs = Number(config.verification && config.verification.timeoutMs) > 0
        ? Number(config.verification.timeoutMs)
        : 600000;

      if (!requiredBuild && !runAllTests) {
        console.log(`[Step 8: Pre-PR Verification] Build and test verification skipped (requiredBuild: false, runAllTests: false).`);
      } else {
        // Build Verification (AC5, AC8, AC9, AC10)
        if (requiredBuild) {
          const buildCmd = config.buildCommand || 'npm run build';
          console.log(`[Step 8: Pre-PR Verification] Running build check: ${buildCmd}`);
          let buildPassed = false;
          let buildAttempts = 0;
          const maxFixAttempts = 3;

          while (!buildPassed && buildAttempts <= maxFixAttempts) {
            try {
              execSync(buildCmd, { cwd: targetRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: gateTimeoutMs });
              buildPassed = true;
              step8GateAttempts.push({ name: 'build', status: 'passed', attempt: buildAttempts + 1, detail: buildCmd });
            } catch (buildErr) {
              buildAttempts++;
              step8GateAttempts.push({ name: 'build', status: 'failed', attempt: buildAttempts, detail: buildErr.message });
              if (buildAttempts > maxFixAttempts) {
                console.error(`[Step 8: Pre-PR Verification] Build verification failed after ${maxFixAttempts} attempt(s). Halting.`);
                state.status = 'failed';
                stateManager.recordError(targetRoot, state.runId, 8, `Build verification failed after ${maxFixAttempts} attempt(s): ${buildErr.message}`);
                return 1;
              }
              console.log(`[Step 8: Pre-PR Verification] Build failed. Attempting automated surgical fix (attempt ${buildAttempts}/${maxFixAttempts})...`);
              const buildFixBefore = snapshotStats(targetRoot);
              if (typeof options.buildFixer === 'function') {
                options.buildFixer(targetRoot, buildAttempts);
              }
              const buildFixDelta = diffSinceSnapshot(targetRoot, buildFixBefore);
              if (buildFixDelta.length > 0) {
                if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
                  const sec = runSecurityGate(targetRoot, { staged: false });
                  if (sec.exitCode !== 0) {
                    console.error(`[Step 8: Pre-PR Verification] Fix commit rejected: secret leak detected.`);
                    state.status = 'failed';
                    stateManager.recordError(targetRoot, state.runId, 8, 'Fix commit rejected: secret leak detected');
                    return 1;
                  }
                }
                stageAndCommitOnly(targetRoot, buildFixDelta, `fix(${specSlug}): resolve build failure (attempt ${buildAttempts})`);
                state.deliveryCommit = getBaseCommit(targetRoot);
                stateManager.saveRunState(targetRoot, state);
              } else {
                console.error(`[Step 8: Pre-PR Verification] No automated fixes could be generated for build failure.`);
                state.status = 'failed';
                stateManager.recordError(targetRoot, state.runId, 8, `Build verification failed: ${buildErr.message}`);
                return 1;
              }
            }
          }
        }

        // Test Verification (AC6, AC8, AC9, AC10)
        if (runAllTests) {
          const testCmd = config.testCommand || 'npm test';
          console.log(`[Step 8: Pre-PR Verification] Running test suite: ${testCmd}`);
          let testPassed = false;
          let testAttempts = 0;
          const maxFixAttempts = 3;

          while (!testPassed && testAttempts <= maxFixAttempts) {
            try {
              execSync(testCmd, { cwd: targetRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: gateTimeoutMs });
              testPassed = true;
              step8GateAttempts.push({ name: 'test', status: 'passed', attempt: testAttempts + 1, detail: testCmd });
            } catch (testErr) {
              testAttempts++;
              step8GateAttempts.push({ name: 'test', status: 'failed', attempt: testAttempts, detail: testErr.message });
              if (testAttempts > maxFixAttempts) {
                console.error(`[Step 8: Pre-PR Verification] Test verification failed after ${maxFixAttempts} attempt(s). Halting.`);
                state.status = 'failed';
                stateManager.recordError(targetRoot, state.runId, 8, `Test verification failed after ${maxFixAttempts} attempt(s): ${testErr.message}`);
                return 1;
              }
              console.log(`[Step 8: Pre-PR Verification] Tests failed. Attempting automated surgical fix (attempt ${testAttempts}/${maxFixAttempts})...`);
              const testFixBefore = snapshotStats(targetRoot);
              if (typeof options.testFixer === 'function') {
                options.testFixer(targetRoot, testAttempts);
              }
              const testFixDelta = diffSinceSnapshot(targetRoot, testFixBefore);
              if (testFixDelta.length > 0) {
                if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
                  const sec = runSecurityGate(targetRoot, { staged: false });
                  if (sec.exitCode !== 0) {
                    console.error(`[Step 8: Pre-PR Verification] Fix commit rejected: secret leak detected.`);
                    state.status = 'failed';
                    stateManager.recordError(targetRoot, state.runId, 8, 'Fix commit rejected: secret leak detected');
                    return 1;
                  }
                }
                stageAndCommitOnly(targetRoot, testFixDelta, `fix(${specSlug}): resolve test failure (attempt ${testAttempts})`);
                state.deliveryCommit = getBaseCommit(targetRoot);
                stateManager.saveRunState(targetRoot, state);
              } else {
                console.error(`[Step 8: Pre-PR Verification] No automated fixes could be generated for test failure.`);
                state.status = 'failed';
                stateManager.recordError(targetRoot, state.runId, 8, `Test verification failed: ${testErr.message}`);
                return 1;
              }
            }
          }
        }
      }
    }

    const prPayload = {
      title: `feat(${specSlug}): implement ${specSlug}`,
      specSlug,
      head: state.branch || null,
      base: state.baseBranch || null,
      baseCommit: state.baseCommit,
      deliveryCommit: state.deliveryCommit,
      score: state.score,
      completedAt: new Date().toISOString()
    };
    console.log(`[Step 8: PR Preparation] Assembled PR payload: "${prPayload.title}".`);

    // Optional Remote Review Resolution Loop & SCM Provider state (AC14, AC15, AC20)
    const pollPr = options.pollPr !== undefined ? options.pollPr : (config.scmCodeReviewEnabled || false);
    const currentScm = state.scm || { provider: config.scmProvider || 'none', resolvedFrom: 'config', cliInstalled: null, cliAuthenticated: null, skipped: false, skipReason: null, errors: [] };
    if (currentScm.provider === 'none') {
      console.log(`[Step 8: PR Preparation] SCM polling skipped (scmProvider: none).`);
      currentScm.skipped = true;
      currentScm.skipReason = 'scmProvider is set to "none"';
    } else {
      const scmContract = getScmProviderContract(targetRoot, resolveOptions);
      const capability = scmContract ? scmContract.checkScmCapability(currentScm.provider) : { available: false, error: 'contract unavailable' };
      currentScm.cliInstalled = capability.installed;
      currentScm.cliAuthenticated = capability.authenticated;

      if (!capability.available) {
        console.warn(`[Step 8: PR Preparation] SCM polling skipped: ${capability.error}`);
        currentScm.skipped = true;
        currentScm.skipReason = capability.error;
        if (!currentScm.errors) currentScm.errors = [];
        currentScm.errors.push(capability.error);
      } else if (pollPr) {
        console.log(`[Step 8: PR Preparation] SCM code review loop enabled via ${currentScm.provider} (${capability.bin}). Polling for reviewer feedback...`);
        prPayload.pollEnabled = true;
        prPayload.scmProvider = currentScm.provider;
      }
    }
    state.scm = currentScm;
    state = stateManager.saveRunState(targetRoot, state);

    // Delegate PR delivery, SCM submission, and review convergence to sdw-ship-pr (AC12, AC13)
    if (hasShipPr) {
      try {
        console.log(`[sdw-orch Step 8] Delegating delivery to sdw-ship-pr...`);
        // argv form: specSlug/runId/paths are never interpreted by a shell.
        const shipArgs = [
          shipPrScript,
          '--run-id', state.runId,
          '--spec', specSlug,
          '--root', targetRoot,
          ...(options.push || config.pushDelivery ? ['--push'] : []),
          ...(pollPr ? ['--poll-pr'] : []),
          ...(options.dryRun || options.sandbox || options._sandbox ? ['--dry-run'] : []),
          '--json'
        ];

        const shipProc = spawnSync(process.execPath, shipArgs, {
          cwd: targetRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
        if (shipProc.error) throw shipProc.error;
        const shipStdout = shipProc.stdout || '';
        if (!String(shipStdout).trim() && shipProc.status !== 0) {
          const shipErr = shipProc.stderr ? String(shipProc.stderr).trim() : '';
          throw new Error(shipErr || `sdw-ship-pr exited with code ${shipProc.status}`);
        }

        let shipResult = null;
        try {
          const trimmed = (shipStdout || '').trim();
          const jsonStart = trimmed.indexOf('{');
          const jsonEnd = trimmed.lastIndexOf('}');
          if (jsonStart !== -1 && jsonEnd !== -1) {
            shipResult = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
          } else {
            shipResult = JSON.parse(trimmed);
          }
        } catch (e) {
          console.warn(`[sdw-orch Step 8] Note: Failed to parse sdw-ship-pr JSON output: ${e.message}`);
        }

        if (shipResult) {
          step8ShipResult = shipResult;
          // Spec 00057 AC7, AC9: record every convergence iteration before any
          // pause decision and re-render after each one, so a delivery stopped on
          // failing checks still renders the rounds that already ran. A resumed
          // Step 8 restarts the history, so the earlier invocation's rows go.
          state = replaceStep8ConvergenceContributions(state);
          const convergenceContributions = buildConvergenceContributions(shipResult);
          for (const contribution of convergenceContributions) {
            state = recordStepContributions(targetRoot, state, 8, [contribution], { allowDuplicates: true });
            state = refreshInProgressReport(targetRoot, state) || state;
          }
        }

        if (shipResult) {
          const hasActivePr = Boolean(shipResult.pullRequest && (shipResult.pullRequest.url || shipResult.pullRequest.number));
          if (shipResult.blocking === true) {
            // Spec 00058 AC11: failing checks or open review threads are a pause,
            // not a failure. The host converges the pull request and resumes the
            // run from the delivery stage; nothing is marked failed or completed.
            const pauseMessage = shipResult.error || 'sdw-ship-pr reported an unconverged pull request';
            state.pullRequest = shipResult.pullRequest || state.pullRequest || null;
            state.shipStatus = shipResult.shipStatus || 'review_pending';
            state = stateManager.saveRunState(targetRoot, state);
            state = stateManager.updateStepState(targetRoot, state.runId, 8, 'blocked_convergence', {
              pullRequest: state.pullRequest,
              shipStatus: state.shipStatus,
              error: pauseMessage
            });
            state.status = 'paused';
            state = stateManager.saveRunState(targetRoot, state);
            state = refreshInProgressReport(targetRoot, state);
            const pausedPr = state.pullRequest && state.pullRequest.number !== undefined && state.pullRequest.number !== null
              ? ` #${state.pullRequest.number}`
              : '';
            console.error(`[sdw-orch Step 8] Delivery paused: ${pauseMessage}`);
            console.error(`[sdw-orch Step 8] Converge pull request${pausedPr} and resume with: node "${normalizePath(orchCommandPath())}" resume --run-id ${state.runId}`);
            options._runResult = {
              runId: state.runId,
              status: 'paused',
              shipStatus: state.shipStatus,
              pullRequest: state.pullRequest,
              error: pauseMessage
            };
            return 6;
          }
          if (shipResult.shipStatus === 'failed' || (shipResult.success === false && !hasActivePr)) {
            throw new Error(shipResult.error || 'sdw-ship-pr reported delivery failure');
          }
          if (hasActivePr && shipResult.shipStatus === 'review_pending') {
            console.log(`[sdw-orch Step 8] Active pull request #${shipResult.pullRequest.number || ''} is in review / awaiting approval (${shipResult.pullRequest.url || ''}).`);
          }
          if (shipResult.pullRequest) {
            state.pullRequest = shipResult.pullRequest;
            prPayload.pullRequest = shipResult.pullRequest;
          }
          state.shipStatus = shipResult.shipStatus;
          prPayload.shipStatus = shipResult.shipStatus;
          if (shipResult.pushed) {
            state.pushedBranch = shipResult.head;
            prPayload.pushedBranch = shipResult.head;
          }
          if (shipResult.branchingSync) {
            state.branchingSync = shipResult.branchingSync;
            prPayload.branchingSync = shipResult.branchingSync;
          }
          prPayload.reviewConvergence = shipResult.reviewConvergence;
        }
      } catch (shipErr) {
        console.error(`[sdw-orch Step 8] Delivery failed: ${shipErr.message}`);
        state.status = 'failed';
        state = stateManager.updateStepState(targetRoot, state.runId, 8, 'failed', { error: shipErr.message });
        stateManager.recordError(targetRoot, state.runId, 8, shipErr.message);
        options._runResult = { runId: state.runId, status: 'failed', error: shipErr.message };
        return 1;
      }
    }

    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'completed', prPayload);
    logStepDone(8);
    state = recordStepContributions(targetRoot, state, 8, buildStep8Contributions(state, step8ShipResult, step8GateAttempts), { allowDuplicates: true });
  } else if (options.skipPr) {
    logStepEnter(8);
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'skipped', { reason: 'Skipped via --skip-pr' });
    logStepDone(8);
    state = recordStepContributions(targetRoot, state, 8, [
      { kind: 'gates', title: 'Pre-PR gates skipped', body: { skipped: true, reason: 'Skipped via --skip-pr' }, evidence: [] },
      { kind: 'ship', title: 'Delivery skipped', body: { skipped: true, reason: 'Skipped via --skip-pr' }, evidence: [] }
    ]);
  }

  // AC17/AC19: one transition site, after the delivery stage reported the
  // delivery (or --skip-pr skipped it). Idempotent, so a resumed run that
  // already passed Step 8 converges on the same row.
  markSpecCompleted();

  // AC17/AC19 consequence: the transition writes the registry row and the
  // specification header after the delivery stage published the branch, so the
  // flip needs its own scoped commit to reach the pull request before the merge.
  const transitionFiles = completedTransitionFiles(targetRoot, state);
  if (transitionFiles.length > 0 && isGitRepo(targetRoot)) {
    try {
      const flip = stageAndCommitOnly(
        targetRoot,
        transitionFiles,
        `chore(${specSlug}): mark the specification completed in the registry`
      );
      if (flip && flip.committed) {
        state.registryCommit = flip.commitSha;
        state = stateManager.saveRunState(targetRoot, state);
        console.log(`[Step 8: Registry] Recorded the completion transition in ${flip.commitSha}.`);
      }
    } catch (flipErr) {
      const message = `the completion transition could not be committed: ${flipErr.message}`;
      console.warn(`[sdw-orch] Warning: ${message}`);
      try {
        stateManager.recordWarning(targetRoot, state.runId, 8, message);
        state = stateManager.loadRunState(targetRoot, state.runId) || state;
      } catch (warnErr) {}
    }
  }

  // Remote Push / Branch Publishing (--push or config.pushDelivery) fallback
  const shouldPush = options.push !== undefined ? options.push : (config && config.pushDelivery);
  const refineNothingToPush = refineMode && state.deliveryCommitCreated === false;
  // A delivery stage that found nothing left to push still leaves the branch on
  // the remote, so publication is proven from the remote ref, not only from the
  // ship result. Without this the post-delivery commits never reach the branch.
  const branchPublished = Boolean(state.pushedBranch) || branchIsPublished(targetRoot, state.branch);
  const pushForDelivery = Boolean(shouldPush) && !branchPublished;
  const pushForTransition = Boolean(state.registryCommit) && branchPublished;
  if ((pushForDelivery || pushForTransition) && !refineNothingToPush) {
    if (!isGitRepo(targetRoot)) {
      console.log(`[sdw-orch] Remote push skipped: not a git repository.`);
    } else {
      try {
        const remotes = execSync('git remote', { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (remotes && currentBranch && currentBranch !== 'HEAD') {
          console.log(`[sdw-orch] Pushing delivery branch to origin/${currentBranch}...`);
          git(targetRoot, ['push', 'origin', currentBranch], { stdio: 'inherit' });
          state.pushedBranch = currentBranch;
        } else if (!remotes) {
          console.log(`[sdw-orch] Remote push skipped: no git remote configured.`);
        }
      } catch (pushErr) {
        console.error(`[sdw-orch] Warning: git push failed: ${pushErr.message}`);
        if (!state.errors) state.errors = [];
        state.errors.push({ step: 8, timestamp: new Date().toISOString(), error: `git push failed: ${pushErr.message}` });
      }
    }
  } else if (!shouldPush && !options.skipPr && !hasShipPr) {
    console.log(`[Step 8: PR Preparation] Pre-PR verification passed. PR payload assembled (remote push disabled).`);
  }

  state.status = 'completed';
  state.currentStep = 8;
  state.retroCommand = retroCommandFor(targetRoot, state.runId);
  state = stateManager.saveRunState(targetRoot, state);
  console.log(`\n[sdw-orch] Workflow completed successfully for run "${state.runId}".`);

  // Spec 00045 AC1-AC3: execute the retrospective when retro.enabled is true,
  // record its outcome on state.retro, and keep the completed delivery even
  // when it fails. Otherwise keep the advisory print unchanged.
  if (config && config.retro && config.retro.enabled === true) {
    state.retro = runRetroForCompletedRun(targetRoot, state);
    state = stateManager.saveRunState(targetRoot, state);
    if (state.retro.status === 'passed') {
      console.log(`[sdw-retro] Retrospective report: ${state.retro.reportMd}`);
      console.log(`[sdw-retro] Retrospective data: ${state.retro.reportJson}`);
      // Spec 00057 AC25, AC28: the retro contribution joins run state and both
      // report paths are re-rendered. The companion refresh never commits and
      // never amends the pushed delivery, so a pushed commit stays untouched.
      state = recordRetroContribution(targetRoot, state);
      const reRendered = reRenderCompanionReport(targetRoot, state, { minScore: effectiveMinScore });
      if (reRendered.ok) {
        console.log(`[sdw-orch] Delivery report re-rendered after the retrospective: ${reRendered.relPath}${reRendered.changed ? ' (updated)' : ' (unchanged)'}${reRendered.pushed ? '; the pushed commit was not amended' : ''}`);
        // Spec 00057 AC11: the committed companion must carry the complete
        // contribution set, including Step 8 and the retrospective, so the
        // refresh lands as its own scoped commit and is pushed again when the
        // branch was already published. The pushed delivery is never amended.
        if (reRendered.changed && isGitRepo(targetRoot)) {
          try {
            const finalReport = stageAndCommitOnly(
              targetRoot,
              [reRendered.relPath],
              `docs(${specSlug}): record the final delivery report`
            );
            if (finalReport && finalReport.committed) {
              state.finalReportCommit = finalReport.commitSha;
              state = stateManager.saveRunState(targetRoot, state);
              console.log(`[sdw-orch] Final delivery report committed as ${finalReport.commitSha}.`);
              const finalBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetRoot, encoding: 'utf8' }).trim();
              if (finalBranch && finalBranch !== 'HEAD' && (state.pushedBranch || shouldPush || branchIsPublished(targetRoot, finalBranch))) {
                git(targetRoot, ['push', 'origin', finalBranch], { stdio: 'inherit' });
                console.log(`[sdw-orch] Final delivery report pushed to origin/${finalBranch}.`);
              }
            }
          } catch (finalReportErr) {
            console.warn(`[sdw-orch] Warning: the final delivery report could not be committed: ${finalReportErr.message}`);
            try {
              stateManager.recordWarning(targetRoot, state.runId, 8, `final delivery report commit failed: ${finalReportErr.message}`);
              state = stateManager.loadRunState(targetRoot, state.runId) || state;
            } catch (warnErr) {}
          }
        }
      } else {
        console.warn('[sdw-orch] Warning: the delivery report could not be re-rendered after the retrospective.');
      }
    } else {
      console.warn(`[sdw-retro] Retrospective failed; run "${state.runId}" stays completed: ${state.retro.error}`);
    }
  } else {
    console.log(`[sdw-retro] Review this delivery with (advisory, run manually):`);
    console.log(`  ${state.retroCommand}`);
  }

  options._runResult = {
    runId: state.runId,
    deliveryCommit: state.deliveryCommit,
    branch: state.branch || null,
    status: 'completed',
    score: state.score,
    error: null
  };

  if (options.json) {
    console.log(JSON.stringify(state, null, 2));
  }
  return 0;
}

function getDispatchRecord(state) {
  const step4 = state.steps && state.steps[4];
  if (!step4) return { activeTaskId: null, sequence: 0, dispatchedAt: null, abandonments: [] };
  step4.dispatch = step4.dispatch || { activeTaskId: null, sequence: 0, dispatchedAt: null, abandonments: [] };
  step4.dispatch.abandonments = Array.isArray(step4.dispatch.abandonments) ? step4.dispatch.abandonments : [];
  return step4.dispatch;
}

function getDagTasksForState(state) {
  if (Array.isArray(state.dagTasks) && state.dagTasks.length > 0) return state.dagTasks;
  return (state.steps && state.steps[3] && state.steps[3].output && state.steps[3].output.tasks) || [];
}

function readSpecAcsForState(targetRoot, state) {
  if (!state.specPath) return [];
  try {
    const content = fs.readFileSync(path.resolve(targetRoot, state.specPath), 'utf8');
    return dagPlanner.parseAcceptanceCriteria(content);
  } catch (e) {
    return [];
  }
}

/**
 * Dispatches the next ready DAG task (Spec 028 AC4-AC8).
 * Exactly one task may be in flight: a second dispatch is rejected.
 */
function dispatchNextTask(context) {
  const { targetRoot, state, dagPlan, specAcs, specSlug, specPath, options } = context;
  const step4 = state.steps[4];
  step4.tasks = step4.tasks || {};
  const tasks = step4.tasks;
  const dispatch = getDispatchRecord(state);

  if (dispatch.activeTaskId) {
    return {
      ok: false,
      state,
      reason: `Task "${dispatch.activeTaskId}" is already dispatched. Finish it or abandon it before dispatching another task.`
    };
  }

  const dagTasks = (dagPlan && Array.isArray(dagPlan.tasks) && dagPlan.tasks.length > 0)
    ? dagPlan.tasks
    : getDagTasksForState(state);
  const completedIds = new Set(Object.keys(tasks).filter(id => tasks[id].status === 'completed'));
  const incomplete = dagTasks.filter(task => !completedIds.has(task.id));

  if (incomplete.length === 0) {
    return {
      ok: false,
      exhausted: true,
      state,
      reason: `All ${dagTasks.length} DAG task(s) are completed. Continue with: node "${orchCommandPath()}" resume --run-id ${state.runId}${followUpRootFlag(targetRoot)}`
    };
  }

  const ready = incomplete.find(task => (task.dependencies || []).every(dep => completedIds.has(dep)));
  if (!ready) {
    const blocking = [...new Set(incomplete.flatMap(task => (task.dependencies || []).filter(dep => !completedIds.has(dep))))];
    return {
      ok: false,
      state,
      reason: `No DAG task is dispatchable. Pending task(s) ${incomplete.map(task => task.id).join(', ')} are blocked by: ${blocking.join(', ')}.`
    };
  }

  const sandboxed = Boolean(options && options._sandbox);
  const rendered = implementationRunner.renderTaskPrompt({
    targetRoot,
    specSlug,
    specPath: specPath || state.specPath,
    runId: state.runId,
    stateDir: stateManager.resolveStateDir(targetRoot),
    task: ready,
    specAcs,
    useWorktrees: false,
    taskWorktreeRel: null,
    dagTasks,
    taskStates: tasks,
    abandonments: dispatch.abandonments,
    absolutePaths: sandboxed,
    refineMode: Boolean(state.refineMode)
  });

  const displayPrompt = sandboxed ? normalizePath(rendered.promptFileAbs) : rendered.promptFileRel;
  const displayEvidence = sandboxed ? normalizePath(rendered.evidenceFileAbs) : rendered.evidenceFileRel;
  const displayWorkingDir = sandboxed ? normalizePath(targetRoot) : rendered.workingDirRel;
  const evidenceArg = sandboxed ? `"${displayEvidence}"` : displayEvidence;
  const rootFlag = sandboxed ? ` --root "${normalizePath(targetRoot)}"` : '';

  // Spec 00057 AC22: the learnings recorded earlier in this run reach the step
  // before it acts, both inside the prompt file and in the dispatch envelope.
  const digest = buildLearningDigest(targetRoot, state, [
    ...(Array.isArray(ready.targetFiles) ? ready.targetFiles : []),
    specPath || state.specPath
  ].filter(Boolean));
  const digestText = formatLearningDigest(digest);
  if (digestText) attachLearningDigest(rendered.promptFileAbs, digestText);
  const digestEnvelope = digest.map(entry => ({
    slug: entry.body.slug,
    kind: entry.body.kind,
    severity: entry.body.severity,
    title: entry.body.title,
    pathPatterns: entry.body.pathPatterns || [],
    step: entry.step
  }));

  const previous = tasks[ready.id] || {};
  dispatch.activeTaskId = ready.id;
  dispatch.sequence = (dispatch.sequence || 0) + 1;
  dispatch.dispatchedAt = new Date().toISOString();
  dispatch.baseline = implementationRunner.captureDispatchBaseline(targetRoot);

  tasks[ready.id] = {
    ...previous,
    id: ready.id,
    title: ready.title,
    status: 'dispatched',
    promptPath: displayPrompt,
    evidencePath: displayEvidence,
    workingDir: displayWorkingDir,
    coveredAcs: ready.coveredAcs || [],
    dependencies: ready.dependencies || [],
    sequence: dispatch.sequence,
    dispatchedAt: dispatch.dispatchedAt
  };

  const envelope = {
    runId: state.runId,
    specSlug,
    taskId: ready.id,
    title: ready.title,
    status: 'dispatched',
    sequence: dispatch.sequence,
    promptFile: displayPrompt,
    promptBytes: rendered.promptBytes,
    evidenceFile: displayEvidence,
    specPath: specPath || state.specPath,
    workingDir: displayWorkingDir,
    acIds: ready.coveredAcs || [],
    dependencies: ready.dependencies || [],
    learnings: digestEnvelope,
    subagentBrief: `Spawn one subagent for this task only. Give it: read ${sandboxed ? `"${displayPrompt}"` : displayPrompt} and execute it exactly as written, then report back per its report contract.${digestEnvelope.length > 0 ? ` The prompt carries ${digestEnvelope.length} run learning(s) recorded earlier in this run; require the worker to apply them and record each application with \`sdw-memory apply --run ${state.runId} --slug <slug> --step <n> --evidence <locator>\`.` : ''}${sandboxed ? ` Run every command with cwd "${displayWorkingDir}".` : ''}`,
    finishCommand: `node "${orchCommandPath()}" task finish --run-id ${state.runId} --task ${ready.id} --evidence ${evidenceArg}${rootFlag}`
  };

  return { ok: true, state, envelope, sequence: dispatch.sequence };
}

function printDispatchEnvelope(envelope, state, options) {
  if (options && options.json) {
    console.log(JSON.stringify(envelope, null, 2));
    try {
      const { total } = getStepTaskTotals(state);
      console.error(`[Step 4/8] Task ${envelope.sequence}/${total} (${envelope.taskId}) dispatched.`);
    } catch (e) {}
    return;
  }
  const { total } = getStepTaskTotals(state);
  console.log(`[Step 4/8] Task ${envelope.sequence}/${total} (${envelope.taskId}) dispatched.`);
  console.log(`\n[Step 4: Dispatch] ${envelope.taskId} dispatched (sequence ${envelope.sequence}, ${envelope.acIds.length} ACs, ${envelope.dependencies.length} dependency(ies)).`);
  console.log(`  Title:    ${envelope.title}`);
  console.log(`  Prompt:   ${envelope.promptFile} (${envelope.promptBytes} bytes)`);
  console.log(`  Evidence: ${envelope.evidenceFile}`);
  console.log(`  Spec:     ${envelope.specPath}`);
  console.log(`\nSpawn one subagent for this task only:`);
  console.log(`  ${envelope.subagentBrief}`);
  console.log(`\nWhen the worker reports back, submit its evidence with:`);
  console.log(`  ${envelope.finishCommand}`);
  console.log(`\n[Step 4: Dispatch] Status: awaiting_implementation (one task in flight).`);
}

function cmdTaskNext(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  let state = null;
  try {
    state = options.runId ? stateManager.loadRunState(targetRoot, options.runId) : stateManager.findLatestRunState(targetRoot);
  } catch (err) {
    console.error(`[sdw-orch task next] ${err.message}`);
    return 1;
  }
  if (!state) {
    console.error('[sdw-orch task next] No run state found. Start a run first.');
    return 1;
  }
  if (!state.steps || !state.steps[4]) {
    console.error(`[sdw-orch task next] Run "${state.runId}" has not reached Step 4 yet.`);
    return 1;
  }

  const dispatchConfig = loadProjectConfig(targetRoot, options);
  const dispatchMode = options.implementationMode || (dispatchConfig.implementation && dispatchConfig.implementation.mode) || 'subagent';
  if (dispatchMode !== 'subagent') {
    console.error(`[sdw-orch task next] Dispatch requires implementation.mode "subagent" (current: "${dispatchMode}").`);
    return 1;
  }

  const specAcs = readSpecAcsForState(targetRoot, state);
  if (specAcs.length === 0) {
    console.error(`[sdw-orch task next] Specification "${state.specPath}" is unreadable or declares no acceptance criteria.`);
    return 1;
  }

  const result = dispatchNextTask({
    targetRoot,
    state,
    dagPlan: { tasks: getDagTasksForState(state) },
    specAcs,
    specSlug: state.specSlug,
    specPath: state.specPath,
    options
  });

  if (result.exhausted) {
    console.log(`[sdw-orch task next] ${result.reason}`);
    return 0;
  }
  if (!result.ok) {
    console.error(`[sdw-orch task next] ${result.reason}`);
    return 1;
  }

  stateManager.saveRunState(targetRoot, result.state);
  printDispatchEnvelope(result.envelope, result.state, options);
  return 0;
}

function cmdTaskAbandon(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  let state = null;
  try {
    state = options.runId ? stateManager.loadRunState(targetRoot, options.runId) : stateManager.findLatestRunState(targetRoot);
  } catch (err) {
    console.error(`[sdw-orch task abandon] ${err.message}`);
    return 1;
  }
  if (!state) {
    console.error('[sdw-orch task abandon] No run state found.');
    return 1;
  }

  const taskId = options.taskId;
  if (!taskId) {
    console.error('[sdw-orch task abandon] Task ID is required (--task <taskId>).');
    return 1;
  }
  const reason = options.reason || options.abandonReason;
  if (!reason || String(reason).trim().length === 0) {
    console.error('[sdw-orch task abandon] A reason is required (--reason "<text>").');
    return 1;
  }

  const step4 = state.steps && state.steps[4];
  if (!step4) {
    console.error(`[sdw-orch task abandon] Run "${state.runId}" has not reached Step 4.`);
    return 1;
  }

  const dispatch = getDispatchRecord(state);
  if (!dispatch.activeTaskId) {
    console.error('[sdw-orch task abandon] No task is currently dispatched.');
    return 1;
  }
  if (dispatch.activeTaskId !== taskId) {
    console.error(`[sdw-orch task abandon] Task "${taskId}" is not the dispatched task. Active task: "${dispatch.activeTaskId}".`);
    return 1;
  }

  step4.tasks = step4.tasks || {};
  const record = step4.tasks[taskId] || { id: taskId };
  const abandonedAt = new Date().toISOString();
  dispatch.abandonments.push({ taskId, reason: String(reason).trim(), at: abandonedAt });
  dispatch.activeTaskId = null;
  dispatch.dispatchedAt = null;
  step4.tasks[taskId] = { ...record, status: 'pending', abandonedAt, abandonmentReason: String(reason).trim() };
  step4.status = 'awaiting_implementation';
  state.status = 'paused';
  stateManager.saveRunState(targetRoot, state);

  console.log(`[sdw-orch task abandon] ${taskId} returned to pending (reason: ${String(reason).trim()}).`);
  console.log(`Dispatch it again with:`);
  console.log(`  node "${orchCommandPath()}" task next --run-id ${state.runId}${followUpRootFlag(targetRoot)}`);
  return 0;
}

function cmdTaskFinish(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  let state = null;
  if (options.runId) {
    state = stateManager.loadRunState(targetRoot, options.runId);
  } else {
    state = stateManager.findLatestRunState(targetRoot);
  }

  if (!state) {
    console.error('Error: No run state found to submit task evidence.');
    return 1;
  }

  const taskId = options.taskId;
  if (!taskId) {
    console.error('Error: Task ID is required (--task <taskId>).');
    return 1;
  }

  const evidencePath = options.evidencePath;
  if (!evidencePath) {
    console.error('Error: Evidence path is required (--evidence <evidencePath>).');
    return 1;
  }

  const evidenceFileAbs = path.isAbsolute(evidencePath)
    ? evidencePath
    : path.resolve(targetRoot, evidencePath);

  if (!fs.existsSync(evidenceFileAbs)) {
    console.error(`Error: Evidence file not found: "${evidenceFileAbs}".`);
    return 1;
  }

  const config = loadProjectConfig(targetRoot, options);
  const useWorktrees = options.worktrees ? true : (options.noWorktrees ? false : Boolean(config.useWorktrees));

  const dagTasks = (Array.isArray(state.dagTasks) && state.dagTasks.length > 0)
    ? state.dagTasks
    : ((state.steps[3] && state.steps[3].output && state.steps[3].output.tasks) || []);
  const targetTask = dagTasks.find(t => t.id === taskId);
  if (!targetTask) {
    console.error(`Error: Task "${taskId}" not found in DAG plan for run "${state.runId}".`);
    return 1;
  }

  state.steps[4] = state.steps[4] || { name: 'implementation', status: 'awaiting_implementation', tasks: {}, gates: {} };
  state.steps[4].tasks = state.steps[4].tasks || {};

  // Spec 028 AC9: only the dispatched task may be completed, which also rules out
  // out-of-order acceptance and a second worker finishing someone else's task.
  const dispatch = getDispatchRecord(state);
  if (dispatch.activeTaskId !== taskId) {
    console.error(dispatch.activeTaskId
      ? `Error: Task "${taskId}" is not the dispatched task. Active task: "${dispatch.activeTaskId}". Finish or abandon "${dispatch.activeTaskId}" first.`
      : `Error: No task is currently dispatched. Dispatch one with: node "${orchCommandPath()}" task next --run-id ${state.runId}${followUpRootFlag(targetRoot)}`);
    return 1;
  }

  const completedTaskIds = new Set(
    Object.keys(state.steps[4].tasks).filter(k => state.steps[4].tasks[k].status === 'completed')
  );

  // Check DAG dependencies (AC9)
  const depCheck = implementationRunner.checkTaskDependencies({ tasks: dagTasks }, taskId, completedTaskIds);
  if (!depCheck.satisfied) {
    console.error(`Error: Task "${taskId}" has uncompleted dependencies: ${depCheck.missingDependencies.join(', ')}`);
    return 1;
  }

  // Load spec to validate AC IDs (fail closed: unknown-AC detection requires a known AC set)
  let specAcs = [];
  if (state.specPath) {
    try {
      const specContent = fs.readFileSync(path.resolve(targetRoot, state.specPath), 'utf8');
      specAcs = dagPlanner.parseAcceptanceCriteria(specContent);
    } catch (e) {
      specAcs = [];
    }
  }
  if (!Array.isArray(specAcs) || specAcs.length === 0) {
    console.error(`Error: Cannot validate evidence for task "${taskId}": specification at "${state.specPath}" is unreadable or declares no acceptance criteria.`);
    return 1;
  }

  // Validate evidence schema & content (AC8, AC28, AC29)
  const evValidation = evidenceValidator.validateEvidenceFile(evidenceFileAbs, {
    expectedTaskId: taskId,
    specAcs,
    projectRoot: targetRoot,
    allowEmptyFilesChanged: Boolean(state.refineMode)
  });

  if (!evValidation.valid) {
    console.error(`Evidence validation failed for ${taskId}:\n  ` + evValidation.errors.join('\n  '));
    return 1;
  }

  const evidenceData = evValidation.data;

  // Spec 028 AC25/AC26: only an honest success closes a task.
  const evidenceStatus = String(evidenceData.status || '').trim().toLowerCase();
  if (evidenceStatus !== 'success') {
    console.error(`Error: Task "${taskId}" reported status "${evidenceStatus || 'unknown'}". Only "success" is accepted; abandon it with task abandon --reason to re-dispatch.`);
    return 1;
  }

  // Corroborate changes (Spec 015 AC13-AC15, Spec 028 AC27)
  let commitSha = null;
  const taskWorktreeRel = `.sdw/worktrees/${state.runId}/${taskId}`;
  const taskWorktreeAbs = path.resolve(targetRoot, taskWorktreeRel);

  const worktreeExists = useWorktrees && fs.existsSync(taskWorktreeAbs);
  const effectiveUseWorktrees = useWorktrees && worktreeExists;

  // A second-pass refinement may honestly change nothing: empty filesChanged is
  // accepted in that mode instead of requiring corroborated edits.
  const refineNoChange = Boolean(state.refineMode)
    && Array.isArray(evidenceData.filesChanged)
    && evidenceData.filesChanged.length === 0;

  const hasChanges = refineNoChange || implementationRunner.checkTaskChanges(
    targetRoot,
    effectiveUseWorktrees ? taskWorktreeAbs : null,
    effectiveUseWorktrees,
    evidenceData.filesChanged,
    effectiveUseWorktrees ? {} : { baseline: dispatch.baseline }
  );

  if (!hasChanges) {
    const errMsg = effectiveUseWorktrees
      ? `Task working tree for ${taskId} contains no changes.`
      : `None of the files listed in filesChanged changed since this task was dispatched.`;
    console.error(`Error: ${errMsg}`);
    return 1;
  }

  // PR #34 review finding: the checkpoint must not bypass the Step 6 pre-commit
  // secret scan. It runs before integration and before the checkpoint commit, over
  // the tree that holds the task's change, so a leak is rejected before any commit
  // or cherry-pick exists. The task stays dispatched for a clean retry.
  if (!options.noTaskCheckpoint && !state.refineMode && config.securityChecksEnabled && !options.skipSecurity) {
    const scanRoot = effectiveUseWorktrees ? taskWorktreeAbs : targetRoot;
    const scanResult = runSecurityGate(scanRoot, { staged: false });
    if (scanResult.exitCode !== 0) {
      console.error(`Error: Task "${taskId}" blocked by pre-commit security checks (exit code ${scanResult.exitCode}). No commit, cherry-pick, or tag was created.`);
      state.steps[4].securityGate = {
        bypassed: false,
        taskId,
        scanRoot: effectiveUseWorktrees ? taskWorktreeRel : '.',
        exitCode: scanResult.exitCode,
        severityCounts: scanResult.severityCounts,
        findings: scanResult.findings
      };
      stateManager.saveRunState(targetRoot, state);
      return scanResult.exitCode;
    }
  }

  // Integrate worktree if used (AC10, AC11)
  let checkpointTag = null;
  if (effectiveUseWorktrees) {
    try {
      const intRes = implementationRunner.integrateTaskWorktree({
        targetRoot,
        specSlug: state.specSlug,
        taskId,
        taskWorktreeAbs,
        taskWorktreeRel,
        taskBranch: `sdw-${state.runId}-${taskId}`
      });
      commitSha = intRes.commitSha;
      state.worktrees = state.worktrees || [];
      state.worktrees.push({
        taskId,
        path: taskWorktreeRel,
        branch: `sdw-${state.runId}-${taskId}`,
        status: 'integrated',
        commitSha
      });
    } catch (cpErr) {
      console.error(`Error: Worktree integration failed for ${taskId}: ${cpErr.message}`);
      return 1;
    }
  }

  // Spec 00044 AC3: save every accepted task in the primary tree so a crash or
  // reset between tasks cannot lose corroborated work. Step 6 stays the delivery
  // commit and aggregates whatever this checkpoint did not already commit.
  // Second-pass runs are excluded: their explicit `refine(...)` Step 6 commit is
  // the save, and `deliveryCommitCreated` must still describe it.
  if (!options.noTaskCheckpoint && !state.refineMode) {
    try {
      const checkpoint = checkpointTask(targetRoot, {
        specSlug: state.specSlug,
        runId: state.runId,
        taskId,
        files: evidenceData.filesChanged,
        // Worktree mode: the cherry-pick creates a new SHA on the primary branch,
        // so the tag must point at that integrated commit, not the pre-integration
        // worktree commit whose branch is deleted right after integration.
        commitSha: effectiveUseWorktrees ? getBaseCommit(targetRoot) : null
      });
      commitSha = checkpoint.commitSha || commitSha;
      checkpointTag = checkpoint.tag;
      if (checkpoint.tagError) {
        console.warn(`[sdw-orch task finish] Warning: checkpoint tag for "${taskId}" was not created: ${checkpoint.tagError}. The saved commit already covers the work.`);
      }
    } catch (cpErr) {
      // Only a failed commit reaches this branch: the work is still uncommitted, so
      // rejecting the task keeps a meaningful retry path.
      console.error(`Error: Failed to checkpoint task "${taskId}": ${cpErr.message}`);
      return 1;
    }
  } else if (!effectiveUseWorktrees) {
    commitSha = getBaseCommit(targetRoot);
  }

  // Record task completion in state (Spec 015 AC16, Spec 028 AC10)
  dispatch.activeTaskId = null;
  dispatch.dispatchedAt = null;
  state.steps[4].tasks[taskId] = {
    ...(state.steps[4].tasks[taskId] || {}),
    id: taskId,
    title: targetTask.title,
    status: 'completed',
    evidencePath: path.isAbsolute(evidencePath) ? path.relative(targetRoot, evidenceFileAbs).replace(/\\/g, '/') : evidencePath.replace(/\\/g, '/'),
    commitSha,
    checkpointTag,
    filesChanged: evidenceData.filesChanged,
    acIds: evidenceData.acIds,
    summary: evidenceData.summary,
    evidenceStatus: 'success',
    completedAt: new Date().toISOString()
  };

  completedTaskIds.add(taskId);
  state = stateManager.saveRunState(targetRoot, state);

  console.log(`[sdw-orch task finish] Task "${taskId}" successfully accepted.`);
  logTaskAccepted(state, taskId);
  console.log(`  Covered ACs:   ${evidenceData.acIds.join(', ')}`);
  console.log(`  Files Changed: ${evidenceData.filesChanged.join(', ')}`);
  if (commitSha) {
    console.log(`  Commit SHA:    ${commitSha}`);
  }
  if (checkpointTag) {
    console.log(`  Checkpoint:    ${checkpointTag}`);
  }

  // Check if all DAG tasks are completed
  const remainingTasks = dagTasks.filter(t => !completedTaskIds.has(t.id));
  if (remainingTasks.length > 0) {
    console.log(`\nRemaining tasks to dispatch (${remainingTasks.length}):`);
    remainingTasks.forEach(t => console.log(`  - [${t.id}] ${t.title}`));
    console.log(`\nDispatch the next task with:`);
    console.log(`  node "${orchCommandPath()}" task next --run-id ${state.runId}${followUpRootFlag(targetRoot)}`);
  } else {
    console.log(`\nAll ${dagTasks.length} DAG tasks have completed!`);
    // Run verification gates (AC17, AC18, AC19)
    console.log(`Executing verification gates on integrated tree...`);
    const gateResults = runVerificationGates(targetRoot, config, { ...options, runId: state.runId, slug: state.specSlug });
    // runVerificationGates records failures through stateManager.recordError, which reloads and
    // writes the state file. Reload before writing gates so those failures are not overwritten.
    state = stateManager.loadRunState(targetRoot, state.runId) || state;
    state.steps[4].gates = gateResults.gates;
    if (!gateResults.passed) {
      console.error(`Verification gates failed.`);
      state.steps[4].status = 'failed';
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      return 1;
    }
    state = stateManager.updateStepState(targetRoot, state.runId, 4, 'completed', {
      tasks: state.steps[4].tasks,
      gates: state.steps[4].gates
    });
    logStepDone(4);
    state = recordStepContributions(targetRoot, state, 4, buildStep4Contributions(state));
    console.log(`Step 4 completed successfully! Proceed to Step 5 by running:`);
    console.log(`  node "${orchCommandPath()}" resume --run-id ${state.runId}${followUpRootFlag(targetRoot)}`);
  }

  options._finishResult = { runId: state.runId, taskId, status: 'completed' };
  return 0;
}

function cmdResume(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  let state = null;
  if (options.runId) {
    state = stateManager.loadRunState(targetRoot, options.runId);
  } else if (options.latest) {
    state = stateManager.findLatestRunState(targetRoot);
    if (!state) {
      console.error('Error: No existing run state files found to resume.');
      return 1;
    }
  } else {
    state = stateManager.findLatestRunState(targetRoot);
    if (!state) {
      console.error('Error: specify --run-id <id> or --latest to resume.');
      return 1;
    }
  }

  // Reject obsolete run state files created before sdw-orch migration
  if (!state.orchestrator || state.orchestrator !== 'sdw-orch') {
    console.error(`Error: Run state "${state.runId}" is obsolete or incompatible with sdw-orch (orchestrator: "${state.orchestrator || 'legacy'}"). Resuming legacy run states is unsupported.`);
    return 1;
  }

  // Reject legacy run states with only { tasksPrepared } in Step 4 (AC24)
  const step4 = state.steps && state.steps[4];
  if (step4 && step4.status === 'completed') {
    const isLegacyStep4 = step4.output &&
      step4.output.tasksPrepared !== undefined &&
      (!step4.tasks || Object.keys(step4.tasks).length === 0);
    if (isLegacyStep4) {
      console.error(`Error: Run state "${state.runId}" contains a legacy Step 4 execution with only { tasksPrepared } and no task evidence records. Resuming legacy run states is unsupported. Please start a new run.`);
      return 1;
    }
  }

  let resumptionStep = stateManager.getResumptionStep(state);
  logRunResumed(state.runId, state.specSlug, resumptionStep);
  options._resumedLogged = true;

  // Only the Step 4 resumption path owns task completion and verification gates (AC20).
  // Resuming at Steps 1-3 must let cmdRun generate the DAG and enter Step 4 normally.
  if (resumptionStep === 4) {
    const dagTasks = (Array.isArray(state.dagTasks) && state.dagTasks.length > 0)
      ? state.dagTasks
      : ((state.steps[3] && state.steps[3].output && state.steps[3].output.tasks) || []);
    const completedTasks = Object.keys((state.steps[4] && state.steps[4].tasks) || {}).filter(
      k => state.steps[4].tasks[k].status === 'completed'
    );
    const incompleteTasks = dagTasks.filter(t => !completedTasks.includes(t.id));

    if (incompleteTasks.length > 0) {
      const resumeConfig = loadProjectConfig(targetRoot, options);
      const implMode = options.implementationMode || (resumeConfig.implementation && resumeConfig.implementation.mode) || 'subagent';
      if (implMode === 'command') {
        console.log(`[sdw-orch resume] Command mode detected; re-entering Step 4 to dispatch the configured command.`);
        return cmdRun({
          ...options,
          specPath: state.specPath,
          runId: state.runId,
          startStep: 4,
          implementationMode: 'command'
        });
      }

      if (implMode === 'subagent') {
        const dispatch = getDispatchRecord(state);
        if (dispatch.activeTaskId) {
          // AC31: re-emit the in-flight envelope so a lost dispatch is recoverable.
          const activeRecord = (state.steps[4].tasks || {})[dispatch.activeTaskId] || {};
          const activeTask = dagTasks.find(t => t.id === dispatch.activeTaskId) || {};
          const envelope = {
            runId: state.runId,
            specSlug: state.specSlug,
            taskId: dispatch.activeTaskId,
            title: activeRecord.title || activeTask.title || dispatch.activeTaskId,
            status: 'dispatched',
            sequence: dispatch.sequence,
            promptFile: activeRecord.promptPath || null,
            promptBytes: null,
            evidenceFile: activeRecord.evidencePath || null,
            specPath: state.specPath,
            workingDir: activeRecord.workingDir || '.',
            acIds: activeRecord.coveredAcs || activeTask.coveredAcs || [],
            dependencies: activeRecord.dependencies || activeTask.dependencies || [],
            subagentBrief: `Spawn one subagent for this task only. Give it: read ${activeRecord.promptPath} and execute it exactly as written, then report back per its report contract.`,
            finishCommand: `node "${orchCommandPath()}" task finish --run-id ${state.runId} --task ${dispatch.activeTaskId} --evidence ${sandbox.readMarker(targetRoot) ? `"${activeRecord.evidencePath}"` : activeRecord.evidencePath}${sandbox.readMarker(targetRoot) ? ` --root "${normalizePath(targetRoot)}"` : ''}`
          };
          printDispatchEnvelope(envelope, state, options);
          console.log(`\n[sdw-orch resume] Task "${dispatch.activeTaskId}" is still in flight. If that worker is gone, release it with:`);
          console.log(`  node "${orchCommandPath()}" task abandon --run-id ${state.runId} --task ${dispatch.activeTaskId} --reason "<why>"${followUpRootFlag(targetRoot)}`);
          return 4;
        }

        // AC32: no dispatch in flight: refuse the gates and hand out the next task.
        console.error(`[sdw-orch resume] Cannot advance past Step 4: ${incompleteTasks.length} task(s) remain incomplete:`);
        dagTasks.forEach(t => {
          const isDone = completedTasks.includes(t.id);
          console.log(`  [${isDone ? 'COMPLETED' : 'PENDING'}] ${t.id}: ${t.title}`);
        });
        console.error(`\nDispatch the next task with:`);
        console.error(`  node "${orchCommandPath()}" task next --run-id ${state.runId}${followUpRootFlag(targetRoot)}`);
        return 4;
      }

      console.error(`[sdw-orch resume] Cannot advance past Step 4: ${incompleteTasks.length} task(s) remain incomplete.`);
      return 4;
    }

    // All tasks completed. Execute build and test verification gates (AC20)
    const config = loadProjectConfig(targetRoot, options);
    console.log(`[sdw-orch resume] All ${dagTasks.length} DAG task(s) completed. Running verification gates...`);
    const gateResults = runVerificationGates(targetRoot, config, { ...options, runId: state.runId, slug: state.specSlug });
    state.steps[4].gates = gateResults.gates;

    if (!gateResults.passed) {
      console.error(`[sdw-orch resume] Verification gates failed. Step 4 remains incomplete.`);
      state.steps[4].status = 'failed';
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      return 1;
    }

    // Mark Step 4 completed
    state = stateManager.updateStepState(targetRoot, state.runId, 4, 'completed', {
      tasks: state.steps[4].tasks,
      gates: state.steps[4].gates
    });
    logStepDone(4);
    state = recordStepContributions(targetRoot, state, 4, buildStep4Contributions(state));
    state.status = 'in_progress';
    state = stateManager.saveRunState(targetRoot, state);
    console.log(`[sdw-orch resume] Step 4 completed. Advancing to Step 5 (Conformance Scoring).`);
    resumptionStep = stateManager.getResumptionStep(state);
  }

  console.log(`[sdw-orch resume] Restoring session state for run "${state.runId}".`);
  console.log(`[sdw-orch resume] Resuming from step ${resumptionStep}/${state.totalSteps} (steps 1-${resumptionStep - 1} already resolved).`);

  return cmdRun({
    ...options,
    specPath: state.specPath,
    runId: state.runId,
    startStep: resumptionStep,
    // A second pass keeps its mode and scoring base across resumes.
    ...(state.refineMode ? { refineMode: true, baseCommit: options.baseCommit || state.baseCommit } : {})
  });
}

function cmdStatus(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  let state = null;
  if (options.runId) {
    state = stateManager.loadRunState(targetRoot, options.runId);
  } else {
    state = stateManager.findLatestRunState(targetRoot);
    if (!state) {
      console.error('No run state files found.');
      return 1;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }

  console.log(`\nSDW Orchestrator Run Status`);
  console.log(`=========================`);
  console.log(`Run ID:       ${state.runId}`);
  console.log(`Spec:         ${state.specSlug}`);
  console.log(`Branch:       ${state.branch || 'None'}`);
  console.log(`Base Branch:  ${state.baseBranch || 'None'}`);
  if (state.scm) {
    const scmInfo = state.scm.skipped
      ? `${state.scm.provider} (skipped: ${state.scm.skipReason})`
      : state.scm.provider;
    console.log(`SCM Provider: ${scmInfo}`);
  }
  console.log(`Status:       ${state.status}`);
  console.log(`Current Step: ${state.currentStep}/${state.totalSteps}`);
  console.log(`Score:        ${state.score !== null ? `${state.score}/10` : 'Not evaluated yet'}`);
  console.log(`Created:      ${state.createdAt}`);
  console.log(`Updated:      ${state.updatedAt}`);
  if (state.worktrees && state.worktrees.length > 0) {
    console.log(`\nWorktrees:`);
    state.worktrees.forEach(w => {
      console.log(`  [${w.taskId}] ${w.path} (${w.status}) -> commit: ${w.commitSha || 'none'}`);
    });
  }
  console.log(`\nSteps:`);

  for (let s = 1; s <= state.totalSteps; s++) {
    const step = state.steps[s];
    const statusMark = step.status === 'completed' ? 'PASS' : step.status === 'skipped' ? 'SKIP' : step.status === 'in_progress' ? 'RUN ' : 'WAIT';
    console.log(`  [Step ${s}] [${statusMark}] ${step.name}: ${step.status}`);
  }

  // Spec 028 AC37: dispatch visibility.
  const step4 = state.steps[4];
  if (step4 && step4.tasks && Object.keys(step4.tasks).length > 0) {
    const dispatch = step4.dispatch || {};
    console.log(`\nDispatch:`);
    console.log(`  Active task: ${dispatch.activeTaskId || 'none'}`);
    if (dispatch.activeTaskId && dispatch.dispatchedAt) {
      const ageMs = Date.now() - Date.parse(dispatch.dispatchedAt);
      console.log(`  Dispatched:  ${dispatch.dispatchedAt} (${Math.max(0, Math.round(ageMs / 60000))}m ago)`);
    }
    console.log(`  Tasks:`);
    for (const [taskId, record] of Object.entries(step4.tasks)) {
      console.log(`    [${String(record.status || 'pending').toUpperCase()}] ${taskId}: ${record.title || ''}`);
    }
  }

  if (state.errors && state.errors.length > 0) {
    console.log('\nRecorded Errors:');
    state.errors.forEach(e => {
      console.log(`  [Step ${e.step}] ${e.error}`);
    });
  }
  return 0;
}

function cmdScoreSubmit(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  let state = null;
  if (options.runId) {
    state = stateManager.loadRunState(targetRoot, options.runId);
  } else {
    state = stateManager.findLatestRunState(targetRoot);
  }
  if (!state) {
    console.error('Error: No run state found to submit a judge verdict.');
    return 1;
  }

  if (!options.verdictPath) {
    console.error('Error: Verdict path is required (--verdict <path>).');
    return 1;
  }
  const verdictFileAbs = path.isAbsolute(options.verdictPath)
    ? options.verdictPath
    : path.resolve(targetRoot, options.verdictPath);

  const scoringStep = state.steps && state.steps[5];
  const scoringStatus = scoringStep ? scoringStep.status : 'pending';
  if (!['awaiting_judgment', 'judged', 'reimplementation_needed', 'in_progress'].includes(scoringStatus)) {
    console.error(`[sdw-orch score submit] Run "${state.runId}" is not awaiting a judge verdict (Step 5 status: "${scoringStatus}").`);
    return 1;
  }

  let specContent = '';
  if (state.specPath) {
    try {
      specContent = fs.readFileSync(path.resolve(targetRoot, state.specPath), 'utf8');
    } catch (e) {
      specContent = '';
    }
  }
  const specAcs = dagPlanner.parseAcceptanceCriteria(specContent);
  if (specAcs.length === 0) {
    console.error(`Error: Specification "${state.specPath}" is unreadable or declares no acceptance criteria.`);
    return 1;
  }

  const verdictRead = scoreEvaluator.readVerdictFile(verdictFileAbs);
  if (!verdictRead.ok) {
    console.error(`Error: ${verdictRead.error}`);
    return 1;
  }

  const priorOutput = (state.steps[5] && state.steps[5].output) || {};
  const judgeCriteria = (Array.isArray(priorOutput.judgeAcIds) && priorOutput.judgeAcIds.length > 0)
    ? priorOutput.judgeAcIds.map(id => {
        const match = specAcs.find(ac => ac.id === id);
        return { id, text: match ? match.text : '' };
      })
    : specAcs;

  const validation = scoreEvaluator.validateVerdict(verdictRead.verdict, { acs: judgeCriteria });
  if (!validation.valid) {
    console.error('Error: Judge verdict rejected:');
    validation.errors.forEach(item => console.error(`  - ${item}`));
    return 1;
  }

  const config = loadProjectConfig(targetRoot, options);
  const minScore = options.minScore !== undefined
    ? options.minScore
    : (config.scoreMin !== undefined ? config.scoreMin : 8);
  const judgeConfig = scoreEvaluator.resolveJudgeConfig({ scoring: options.scoring || config.scoring });
  const report = scoreEvaluator.applyVerdict(validation.data, {
    acs: judgeCriteria,
    minScore,
    touchedFiles: scoreEvaluator.getTouchedFiles(state.baseCommit, targetRoot),
    judge: { ...judgeConfig, ...(priorOutput.judge || {}), mode: 'submitted' }
  });

  state.steps[5] = state.steps[5] || { name: 'scoring', status: 'pending', output: null, artifact: null };
  state.steps[5].status = report.passed ? 'judged' : 'reimplementation_needed';
  state.steps[5].output = {
    ...report,
    verdict: validation.data,
    judgeResolution: 'submitted',
    judgePromptPath: priorOutput.judgePromptPath || null,
    judgeVerdictPath: priorOutput.judgeVerdictPath || null,
    judgedAt: new Date().toISOString()
  };
  state.score = report.score;
  state.scoreIteration = (state.scoreIteration || 0) + 1;
  state.status = report.passed ? 'paused' : 'failed';
  state = stateManager.saveRunState(targetRoot, state);
  // Spec 00057 AC15: the submitted summary, risks, and follow-ups persist as the
  // Step 5 verdict and judgment contributions before the run pauses.
  state = replaceStep5Contributions(state);
  state = recordStepContributions(targetRoot, state, 5, buildStep5Contributions(state, state.steps[5].output, minScore));

  console.log(`[sdw-orch score submit] Score: ${report.score}/10 (Required: ${minScore}/10). Passed: ${report.passed}`);
  console.log(`  Verified ACs: ${report.verifiedCount}/${report.totalAcs}`);
  console.log(`  Failing ACs:  ${report.failingCount}/${report.totalAcs}`);
  if (report.judge.scoreMismatch) {
    console.warn(`[sdw-orch score submit] Warning: the judge reported ${report.judge.reportedScore}/10 while its per-criterion verdicts yield ${report.score}/10; the verdicts are authoritative.`);
  }

  if (report.passed) {
    console.log(`\nContinue the workflow with:`);
    console.log(`  node "${orchCommandPath()}" resume --run-id ${state.runId}${followUpRootFlag(targetRoot)}`);
    return 0;
  }

  console.error(`[sdw-orch score submit] Conformance below threshold. Address the failing criteria, then re-run or re-judge.`);
  return 2;
}

/**
 * Spec 00057 AC28: refreshes the companion and the in-progress report from run
 * state on demand. It records a pending retro contribution when the retro ran
 * but its contribution is missing, and it never commits, pushes, or amends.
 */
function cmdReportReRender(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  let state = null;
  try {
    state = options.runId
      ? stateManager.loadRunState(targetRoot, options.runId)
      : stateManager.findLatestRunState(targetRoot);
  } catch (err) {
    console.error(`[sdw-orch report re-render] ${err.message}`);
    return 1;
  }
  if (!state) {
    console.error('[sdw-orch report re-render] No run state found to re-render from.');
    return 1;
  }
  if (!state.specPath) {
    console.error(`[sdw-orch report re-render] Run "${state.runId}" records no specification path; nothing to refresh.`);
    return 1;
  }

  state = recordRetroContribution(targetRoot, state);
  state = refreshInProgressReport(targetRoot, state);
  const companion = reRenderCompanionReport(targetRoot, state, { minScore: options.minScore });
  const inProgressPath = deliveryReport.resolveInProgressReportPath(targetRoot, state);
  const result = {
    ok: companion.ok,
    runId: state.runId,
    companion: companion.relPath,
    inProgress: inProgressPath ? normalizeRel(path.relative(targetRoot, inProgressPath)) : null,
    changed: companion.changed,
    pushed: companion.pushed,
    amended: false
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!companion.ok) {
    console.error(`[sdw-orch report re-render] The companion report could not be written for run "${state.runId}".`);
  } else {
    console.log(`[sdw-orch report re-render] Companion report refreshed: ${companion.relPath}${companion.changed ? ' (updated)' : ' (unchanged)'}.`);
    console.log(`[sdw-orch report re-render] In-progress report refreshed: ${result.inProgress}.`);
    if (companion.pushed) {
      console.log('[sdw-orch report re-render] The delivery branch was already pushed; the refreshed companion stays uncommitted and no commit was amended.');
    }
  }
  return companion.ok ? 0 : 1;
}

function cmdSandbox(options) {
  const sourceRoot = options.root ? path.resolve(options.root) : process.cwd();
  const action = String((options.specPaths && options.specPaths[0]) || options.target || 'list').trim().split(/\s+/)[0] || 'list';
  let sandboxDir = null;
  try {
    sandboxDir = resolveSandboxDir(loadProjectConfig(sourceRoot, options), sourceRoot);
  } catch (err) {
    console.error(`[sandbox] ${err.message}`);
    return 1;
  }

  if (action === 'list') {
    const items = sandbox.listSandboxes(sourceRoot, sandboxDir);
    if (options.json) {
      console.log(JSON.stringify({ sandboxes: items }, null, 2));
      return 0;
    }
    if (items.length === 0) {
      console.log('[sandbox] No sandboxes found.');
      return 0;
    }
    console.log(`[sandbox] ${items.length} sandbox(es):`);
    for (const item of items) {
      const ageMinutes = Math.round((item.ageMs || 0) / 60000);
      console.log(`  ${item.runId} | ${item.status} | ${item.branch} | ${ageMinutes}m | ${item.root}`);
    }
    return 0;
  }

  if (action === 'report') {
    if (!options.runId) {
      console.error('Error: --run-id is required for "sandbox report".');
      return 1;
    }
    try {
      const result = sandbox.writeReport(sourceRoot, options.runId, sandboxDir);
      console.log(result.report);
      return 0;
    } catch (err) {
      console.error(`[sandbox] ${err.message}`);
      return 1;
    }
  }

  if (action === 'clean') {
    if (!options.runId) {
      console.error('Error: --run-id is required for "sandbox clean".');
      return 1;
    }
    try {
      const cleanResult = sandbox.cleanSandbox(sourceRoot, options.runId, sandboxDir);
      if (cleanResult && cleanResult.orphan) {
        console.log(`[sandbox] Removed orphaned sandbox directory for run "${options.runId}" (no metadata was found).`);
      } else {
        console.log(`[sandbox] Removed clone for run "${options.runId}". Report kept at ${sandbox.normalizePath(path.relative(sourceRoot, sandbox.getReportPath(sourceRoot, options.runId, sandboxDir)))}.`);
      }
      return 0;
    } catch (err) {
      console.error(`[sandbox] ${err.message}`);
      return 1;
    }
  }

  console.error(`Unknown sandbox action "${action}". Use: sandbox list | sandbox report --run-id <id> | sandbox clean --run-id <id>`);
  return 1;
}

function showHelp() {
  console.log(`Usage: node sdw_orch.cjs <subcommand> [specPath] [options]

Subcommands:
  run <specPath>         Execute the orchestration workflow for one specification
  resume                 Resume paused or incomplete execution run from state file
  task next              Dispatch the next ready DAG task to one worker (subagent mode)
  task finish            Submit accepted evidence for the dispatched DAG task
  task abandon           Return the dispatched DAG task to the queue
  score submit           Submit a judge verdict for Step 5 conformance scoring
  report re-render       Refresh the delivery report and the in-progress report from run state (never commits)
  status                 Check status of current or specified run state
  sandbox list           List isolated sandboxes created by --sandbox
  sandbox report         Regenerate and print the report for a sandbox (--run-id)
  sandbox clean          Delete a sandbox clone, keeping its report (--run-id)
  help                   Display this help documentation

Options:
  --run-id <id>          Explicit run identifier (default: auto-generated or latest)
  --new-run              Start a new run even when another run for the same specification is open
  --task <id>            DAG task ID for task next/finish/abandon (alias: --task-id)
  --evidence <path>      Path to evidence JSON file (alias: --evidence-path)
  --reason <text>        Why the dispatched task is being abandoned
  --verdict <path>       Path to judge verdict JSON file for score submit
  --mode <mode>          Implementation mode (subagent | command)
  --dry-run              Print the execution plan and validate the spec; execute nothing
  --sandbox              Execute the whole pipeline in an isolated local clone; never pushes
  --unattended           Execute without interruption, auto-resolving grilling gaps
  --interactive          Require manual confirmation at decision gates
  --root <path>          Target workspace project root directory
  --step <n>             Start or run specific step (1-8)
  --min-score <n>        Minimum acceptable conformance score (default: 8)
  --poll-pr              Enable remote PR review polling
  --abort-on-gaps        Halt at grilling gate if decision gaps are detected (ignored in unattended mode)
  --simulate-failure     Simulate subagent unrecoverable failure for testing
  --latest               (status/resume/task finish) Target the most recent run state
  --push                 Push active branch and delivery commit to remote origin
  --skip-security        Bypass pre-commit security checks gate (audit logged)
  --no-worktrees         Disable git worktrees even if configured
  --worktrees            Force git worktrees on multi-task plans
  --no-task-checkpoint   Do not commit and tag each accepted task (Step 6 remains the only save)
  --no-feature-branch    Disable feature branch creation even if configured
  --feature-branch       Force feature branch creation
  --skip-review          Skip code review step
  --skip-pr              Skip pull request preparation step
  --force                Override quality gates or allow execution on archived specs
  --allow-archived       Permit execution of specs marked archived in index.specs.md
  --second-pass          Refine an already implemented spec (alias: --refine):
                         review what was delivered, simplify, report, commit only
                         on a real change, and ship only when a commit was created
  --json                 Output response in JSON format
  -h, --help             Show help message
`);
}

function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.subcommand || options.subcommand === 'help' || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(args.includes('-h') || args.includes('--help') || options.subcommand === 'help' ? 0 : 1);
  }

  let code = 0;
  switch (options.subcommand) {
    case 'run':
      if (options.specPaths && options.specPaths.length > 1) {
        console.error('[sdw-orch] Error: "run" executes exactly one specification. Use "sdw-batch run <spec...>" for a queue of specifications.');
        code = 1;
      } else {
        code = cmdRun(options);
      }
      break;
    case 'resume':
      code = cmdResume(options);
      break;
    case 'task-finish':
      code = cmdTaskFinish(options);
      break;
    case 'task-next':
      code = cmdTaskNext(options);
      break;
    case 'task-abandon':
      code = cmdTaskAbandon(options);
      break;
    case 'score-submit':
      code = cmdScoreSubmit(options);
      break;
    case 'report-re-render':
      code = cmdReportReRender(options);
      break;
    case 'status':
      code = cmdStatus(options);
      break;
    case 'sandbox':
      code = cmdSandbox(options);
      break;
    default:
      console.error(`Unknown subcommand: "${options.subcommand}". Run with --help for usage.`);
      code = 1;
      break;
  }

  try {
    const refreshRoot = options._effectiveRoot || (options.root ? path.resolve(options.root) : process.cwd());
    sandbox.refreshReportForRoot(refreshRoot);
  } catch (e) {}

  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = {
  cmdRun,
  cmdResume,
  cmdStatus,
  cmdTaskNext,
  cmdTaskAbandon,
  cmdTaskFinish,
  cmdScoreSubmit,
  cmdReportReRender,
  cmdSandbox,
  printRunDryRunPlan,
  showHelp,
  loadProjectConfig,
  resolveSpecPath,
  collectDeliveryFiles,
  stageAndCommitOnly,
  getStatusFiles,
  snapshotStats,
  diffSinceSnapshot,
  resolveSkillScript,
  recordStepContributions,
  refreshInProgressReport,
  buildStep3Contribution,
  buildStep4Contributions,
  buildStep5Contributions,
  buildStep6Contribution,
  buildStep7Contributions,
  buildConvergenceContribution,
  buildStep8Contributions,
  buildLearningDigest,
  formatLearningDigest,
  buildRetroContribution,
  recordRetroContribution,
  reRenderCompanionReport
};
