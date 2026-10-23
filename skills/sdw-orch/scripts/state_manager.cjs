'use strict';

const fs = require('fs');
const path = require('path');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function resolveStateDir(targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  let stateDir = path.join(root, '.sdw', 'state');
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    const config = sdwConfig.loadConfig(root);
    if (config && config.stateDir) {
      stateDir = path.resolve(config.stateDir);
    }
  } catch (e) {
    const configFile = path.join(root, '.sdw', 'config.json');
    if (fs.existsSync(configFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (raw.stateDir) {
          stateDir = path.resolve(raw.stateDir.replace(/\{projectRoot\}/g, normalizePath(root)));
        }
      } catch (err) {}
    }
  }
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  return stateDir;
}

function generateRunId(specSlug) {
  const cleanSlug = (specSlug || 'unnamed').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30);
  const timestamp = Date.now();
  return `run-${timestamp}-${cleanSlug}`;
}

function getStateFilePath(targetRoot, runId) {
  const stateDir = resolveStateDir(targetRoot);
  return path.join(stateDir, `${runId}.state.json`);
}

// AC6: a state write becomes visible only after the temporary file is complete.
// The rename replaces the previous file atomically, so a crash can leave a
// temporary file behind but never a partial state file. fsync is best-effort:
// Windows cannot fsync a directory, and durability must never fail the write.
function fsyncBestEffort(targetPath, flags) {
  let fd;
  try {
    fd = fs.openSync(targetPath, flags);
    fs.fsyncSync(fd);
  } catch (e) {
    // Best-effort durability only.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
}

function writeStateFileAtomic(stateFilePath, state) {
  const tempFile = `${stateFilePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fsyncBestEffort(tempFile, 'r+');
  fs.renameSync(tempFile, stateFilePath);
  fsyncBestEffort(path.dirname(stateFilePath), 'r');
  return stateFilePath;
}

function resolveArtifactsDir(targetRoot, specSlug, runId) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const stateDir = resolveStateDir(root);
  return normalizePath(path.join(stateDir, specSlug, runId));
}

function getArtifactsRelDir(targetRoot, specSlug, runId) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const absDir = resolveArtifactsDir(root, specSlug, runId);
  return normalizePath(path.relative(root, absDir));
}

function createRunState(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const specPath = options.specPath ? normalizePath(path.resolve(targetRoot, options.specPath)) : null;
  const specSlug = options.slug || (specPath ? path.basename(specPath, path.extname(specPath)).replace(/^step-\d+-/, '') : 'spec');
  const runId = options.runId || generateRunId(specSlug);
  const stateFilePath = getStateFilePath(targetRoot, runId);

  // If state already exists for this runId and overwrite is not forced, return existing state
  if (!options.overwrite && fs.existsSync(stateFilePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      if (!existing.artifactsDir) {
        existing.artifactsDir = getArtifactsRelDir(targetRoot, existing.specSlug || specSlug, existing.runId || runId);
      }
      return existing;
    } catch (e) {
      // If corrupted, recreate
    }
  }

  const artifactsRelDir = getArtifactsRelDir(targetRoot, specSlug, runId);

  const state = {
    orchestrator: 'sdw-orch',
    runId,
    specSlug,
    specPath,
    projectRoot: normalizePath(targetRoot),
    status: 'in_progress', // 'in_progress' | 'paused' | 'completed' | 'failed'
    revision: 0,
    currentStep: 1,
    totalSteps: 8,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseCommit: options.baseCommit || null,
    refineMode: Boolean(options.refineMode),
    deliveryCommitCreated: null,
    branch: options.branch || null,
    baseBranch: options.baseBranch || null,
    branchReused: Boolean(options.branchReused),
    branching: options.branching || null,
    branchingSync: options.branchingSync || null,
    worktrees: [],
    worktreeSkipReason: null,
    runtimeOverrides: options.runtimeOverrides || null,
    scm: options.scm || {
      provider: 'none',
      resolvedFrom: 'default',
      cliInstalled: null,
      cliAuthenticated: null,
      skipped: false,
      skipReason: null,
      errors: []
    },
    deliveryCommit: null,
    reviewCommit: null,
    score: null,
    scoreIteration: 0,
    reviewIteration: 0,
    dagTasks: [],
    artifactsDir: options.artifactsDir || artifactsRelDir,
    steps: {
      1: { name: 'derivation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      2: { name: 'refinement', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      3: { name: 'dag_generation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      4: { name: 'implementation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null, tasks: {}, gates: {}, dispatch: { activeTaskId: null, sequence: 0, dispatchedAt: null, abandonments: [] } },
      5: { name: 'scoring', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      6: { name: 'delivery_commit', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      7: { name: 'code_review', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      8: { name: 'pr_preparation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null }
    },
    errors: [],
    stepCheckpoints: {},
    turnPause: null
  };
  writeStateFileAtomic(stateFilePath, state);
  return state;
}

function loadRunState(targetRoot, runId) {
  const stateFilePath = getStateFilePath(targetRoot, runId);
  if (!fs.existsSync(stateFilePath)) {
    throw new Error(`State file not found for runId "${runId}" at ${normalizePath(stateFilePath)}`);
  }
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupted state file for runId "${runId}" at ${normalizePath(stateFilePath)}: ${err.message}`);
  }
}

function findLatestRunState(targetRoot) {
  const stateDir = resolveStateDir(targetRoot);
  const files = fs.readdirSync(stateDir).filter(f => f.endsWith('.state.json'));
  if (files.length === 0) return null;

  files.sort((a, b) => {
    const statA = fs.statSync(path.join(stateDir, a));
    const statB = fs.statSync(path.join(stateDir, b));
    return statB.mtimeMs - statA.mtimeMs;
  });

  const latestFile = path.join(stateDir, files[0]);
  try {
    return JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  } catch (err) {
    throw new Error(`Corrupted state file at ${normalizePath(latestFile)}: ${err.message}`);
  }
}

// Every persisted mutation advances the revision by one. A missing or invalid
// revision (a state written before this field existed) starts again at 1.
function nextRevision(state) {
  return (Number.isInteger(state.revision) ? state.revision : 0) + 1;
}

// AC1: the durable record of a step transition. Its revision is the revision the
// following save assigns, so the checkpoint and the state file never disagree.
function writeStepCheckpoint(state, stepNum, status, recordedAt) {
  state.stepCheckpoints = state.stepCheckpoints || {};
  const checkpoint = {
    step: Number(stepNum),
    revision: nextRevision(state),
    status,
    recordedAt
  };
  state.stepCheckpoints[String(stepNum)] = checkpoint;
  return checkpoint;
}

function saveRunState(targetRoot, state) {
  const stateFilePath = getStateFilePath(targetRoot, state.runId);
  state.revision = nextRevision(state);
  state.updatedAt = new Date().toISOString();
  writeStateFileAtomic(stateFilePath, state);
  return state;
}

function getResumptionStep(state) {
  for (let s = 1; s <= state.totalSteps; s++) {
    const stepObj = state.steps[s];
    if (!stepObj || (stepObj.status !== 'completed' && stepObj.status !== 'skipped')) {
      return s;
    }
  }
  return state.totalSteps;
}

// AC8: resume continues only from a complete state file whose revision is a
// non-negative integer. A partial write or a foreign revision is not recoverable
// here, so the caller refuses and reports the file plus the remediation.
function validateResumableState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, error: 'the file does not contain a run-state object' };
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) {
    const found = Object.prototype.hasOwnProperty.call(state, 'revision')
      ? JSON.stringify(state.revision)
      : 'missing';
    return { ok: false, error: `revision is ${found}; a non-negative integer is required` };
  }
  return { ok: true };
}

function recordError(targetRoot, runId, stepNum, errorMessage) {
  const state = loadRunState(targetRoot, runId);
  const now = new Date().toISOString();
  state.errors.push({ step: stepNum, timestamp: now, error: String(errorMessage) });
  state.status = 'failed';
  if (state.steps[stepNum]) {
    state.steps[stepNum].status = 'failed';
    state.steps[stepNum].error = String(errorMessage);
    writeStepCheckpoint(state, stepNum, 'failed', now);
  }
  return saveRunState(targetRoot, state);
}

function recordWarning(targetRoot, runId, stepNum, warningMessage) {
  const state = loadRunState(targetRoot, runId);
  const now = new Date().toISOString();
  state.errors = state.errors || [];
  state.errors.push({ step: stepNum, timestamp: now, error: String(warningMessage), warning: true });
  return saveRunState(targetRoot, state);
}

function recordStepArtifact(targetRoot, runId, stepNum, artifactRelPath) {
  const state = loadRunState(targetRoot, runId);
  if (state.steps && state.steps[stepNum]) {
    state.steps[stepNum].artifact = normalizePath(artifactRelPath);
  }
  return saveRunState(targetRoot, state);
}

// AC2: store arbitrary, caller-supplied progress JSON for one step. The step's
// current status is snapshotted so the checkpoint is readable on its own.
function recordCheckpoint(targetRoot, runId, stepNum, progress) {
  const step = Number(stepNum);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Invalid checkpoint step "${stepNum}". Expected a positive integer.`);
  }
  const state = loadRunState(targetRoot, runId);
  const stepObj = state.steps && state.steps[step];
  const checkpoint = writeStepCheckpoint(state, step, stepObj ? stepObj.status : 'unknown', new Date().toISOString());
  checkpoint.progress = progress === undefined ? null : progress;
  saveRunState(targetRoot, state);
  return { state, checkpoint };
}

// AC3: record an explicit turn-boundary pause. A pause is a handoff marker, not
// a step status change; it survives process restarts because it lives in state.
function recordTurnPause(targetRoot, runId, stepNum, reason, nextAction) {
  const step = Number(stepNum);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Invalid turn-pause step "${stepNum}". Expected a positive integer.`);
  }
  const cleanReason = String(reason === undefined || reason === null ? '' : reason).trim();
  const cleanNextAction = String(nextAction === undefined || nextAction === null ? '' : nextAction).trim();
  if (!cleanReason) throw new Error('A turn pause requires a non-empty reason.');
  if (!cleanNextAction) throw new Error('A turn pause requires a non-empty next action.');
  const state = loadRunState(targetRoot, runId);
  state.turnPause = {
    step,
    reason: cleanReason,
    nextAction: cleanNextAction,
    recordedAt: new Date().toISOString()
  };
  saveRunState(targetRoot, state);
  return { state, turnPause: state.turnPause };
}

function updateStepState(targetRoot, runId, stepNum, status, outputData, error, options) {
  const state = loadRunState(targetRoot, runId);
  const now = new Date().toISOString();
  if (!state.steps[stepNum]) {
    state.steps[stepNum] = { name: `step_${stepNum}`, status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null };
  }

  const stepObj = state.steps[stepNum];
  stepObj.status = status;
  if (status === 'in_progress' && !stepObj.startedAt) {
    stepObj.startedAt = now;
  }
  if (status === 'completed' || status === 'skipped') {
    stepObj.completedAt = now;
  }
  if (outputData !== undefined) {
    stepObj.output = outputData;
  }

  let opt = options;
  if (error && typeof error === 'object' && !error.message && !Array.isArray(error) && (error.artifact || error.artifactsDir)) {
    opt = error;
    error = null;
  }
  if (opt && opt.artifact) {
    stepObj.artifact = normalizePath(opt.artifact);
  }
  if (opt && opt.artifactsDir) {
    state.artifactsDir = normalizePath(opt.artifactsDir);
  }

  if (error) {
    stepObj.error = error;
    state.errors.push({ step: stepNum, timestamp: now, error: String(error) });
    state.status = 'failed';
  }

  state.currentStep = stepNum;
  writeStepCheckpoint(state, stepNum, status, now);
  // AC5: a finished step consumes its checkpoint and any turn pause that targets
  // it. Only this step's records are cleared; another step's pause still stands.
  if (status === 'completed' || status === 'skipped') {
    delete state.stepCheckpoints[String(stepNum)];
    if (state.turnPause && Number(state.turnPause.step) === Number(stepNum)) {
      state.turnPause = null;
    }
  }
  return saveRunState(targetRoot, state);
}

function updateTaskState(targetRoot, runId, taskId, taskState) {
  const state = loadRunState(targetRoot, runId);
  if (!state.steps[4]) {
    state.steps[4] = { name: 'implementation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null, tasks: {}, gates: {} };
  }
  state.steps[4].tasks = state.steps[4].tasks || {};
  state.steps[4].tasks[taskId] = { ...(state.steps[4].tasks[taskId] || {}), ...taskState };
  return saveRunState(targetRoot, state);
}

function updateGateState(targetRoot, runId, gateName, gateState) {
  const state = loadRunState(targetRoot, runId);
  if (!state.steps[4]) {
    state.steps[4] = { name: 'implementation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null, tasks: {}, gates: {} };
  }
  state.steps[4].gates = state.steps[4].gates || {};
  state.steps[4].gates[gateName] = { ...(state.steps[4].gates[gateName] || {}), ...gateState };
  return saveRunState(targetRoot, state);
}

module.exports = {
  normalizePath,
  resolveStateDir,
  resolveArtifactsDir,
  getArtifactsRelDir,
  generateRunId,
  getStateFilePath,
  createRunState,
  loadRunState,
  findLatestRunState,
  saveRunState,
  getResumptionStep,
  validateResumableState,
  recordError,
  recordWarning,
  recordStepArtifact,
  recordCheckpoint,
  recordTurnPause,
  updateStepState,
  updateTaskState,
  updateGateState
};
