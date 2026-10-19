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
const reviewRunner = require('./review_runner.cjs');
const batchRunner = require('./batch_runner.cjs');
const artifactWriter = require('./artifact_writer.cjs');
const implementationRunner = require('./implementation_runner.cjs');
const evidenceValidator = require('./evidence_validator.cjs');

function getSpecIndexHelper() {
  try {
    return require('../../sdw-spec/scripts/spec_index.cjs');
  } catch (e) {
    return null;
  }
}

function getScmProviderContract() {
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
    batchId: null,
    continueOnError: false,
    dryRun: false,
    noSync: false,
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
    noWorktrees: false,
    worktrees: false,
    noFeatureBranch: false,
    featureBranch: false,
    taskId: null,
    evidencePath: null,
    implementationMode: null
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
    else if (arg === '--latest') result.latest = true;
    else if (arg === '--continue-on-error') result.continueOnError = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--no-sync') result.noSync = true;
    else if (arg === '--batch-id') result.batchId = args[++i];
    else if (arg.startsWith('--batch-id=')) result.batchId = arg.slice(11);
    else if (arg === '--root') result.root = args[++i];
    else if (arg.startsWith('--root=')) result.root = arg.slice(7);
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
    else if (arg === '--step') result.step = parseInt(args[++i], 10);
    else if (arg.startsWith('--step=')) result.step = parseInt(arg.slice(7), 10);
    else if (arg === '--min-score') result.minScore = parseInt(args[++i], 10);
    else if (arg.startsWith('--min-score=')) result.minScore = parseInt(arg.slice(12), 10);
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  if ((positional[0] === 'task' && positional[1] === 'finish') || positional[0] === 'task-finish') {
    result.subcommand = 'task-finish';
    const rest = positional[0] === 'task-finish' ? positional.slice(1) : positional.slice(2);
    result.specPaths = rest;
    if (!result.taskId && rest[0]) result.taskId = rest[0];
    if (!result.evidencePath && rest[1]) result.evidencePath = rest[1];
  } else {
    result.subcommand = positional[0] || null;
    result.specPaths = positional.slice(1);
    result.specPath = positional[1] || null;
  }

  if (result.subcommand === 'resume-batch') {
    result.batchId = result.batchId || positional[1] || null;
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

function runSecurityGate(targetRoot, options = {}) {
  try {
    const secScanner = require('../../sdw-security-checks/scripts/sdw_security_checks.cjs');
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
        execSync(buildCmd, { cwd: targetRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
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
        if (typeof options.buildFixer === 'function') {
          options.buildFixer(targetRoot, buildAttempts);
        }
        const fixStatus = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8' }).trim();
        if (fixStatus) {
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
          execSync('git add -A', { cwd: targetRoot, stdio: 'ignore' });
          execSync(`git commit -m "fix(${specSlug}): resolve build failure (attempt ${buildAttempts})"`, { cwd: targetRoot, stdio: 'ignore' });
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
        execSync(testCmd, { cwd: targetRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
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
        if (typeof options.testFixer === 'function') {
          options.testFixer(targetRoot, testAttempts);
        }
        const fixStatus = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8' }).trim();
        if (fixStatus) {
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
          execSync('git add -A', { cwd: targetRoot, stdio: 'ignore' });
          execSync(`git commit -m "fix(${specSlug}): resolve test failure (attempt ${testAttempts})"`, { cwd: targetRoot, stdio: 'ignore' });
        }
      }
    }
  }

  return { passed, gates };
}

function loadProjectConfig(targetRoot) {
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    if (sdwConfig && typeof sdwConfig.loadConfig === 'function') {
      return sdwConfig.loadConfig(targetRoot);
    }
  } catch (e) {}

  const root = targetRoot || process.cwd();
  const configFile = path.join(root, '.sdw', 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const normRoot = root.replace(/\\/g, '/');
      const resolved = {};
      for (const [k, v] of Object.entries(raw)) {
        resolved[k] = typeof v === 'string' ? v.replace(/\{projectRoot\}/g, normRoot) : v;
      }
      return {
        specsDir: path.join(root, '.sdw', 'specs').replace(/\\/g, '/'),
        scoreMin: 8,
        scmCodeReviewEnabled: false,
        pushDelivery: false,
        stateDir: path.join(root, '.sdw', 'state').replace(/\\/g, '/'),
        securityChecksEnabled: false,
        useWorktrees: false,
        useFeatureBranches: false,
        scmProvider: 'none',
        ...resolved
      };
    } catch (e) {}
  }

  return {
    specsDir: path.join(root, '.sdw', 'specs').replace(/\\/g, '/'),
    scoreMin: 8,
    scmCodeReviewEnabled: false,
    pushDelivery: false,
    stateDir: path.join(root, '.sdw', 'state').replace(/\\/g, '/'),
    autoResolveGaps: false,
    securityChecksEnabled: false,
    useWorktrees: false,
    useFeatureBranches: false,
    scmProvider: 'none'
  };
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

function cmdRun(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const config = loadProjectConfig(targetRoot);
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

  // Quality check: inspect index.specs.md status if available
  const specIndex = getSpecIndexHelper();
  if (specIndex) {
    try {
      const idxData = specIndex.readIndex({ root: targetRoot });
      if (idxData && idxData.exists) {
        const entry = idxData.entries.find(e => e.slug === specSlug || (specSlug && e.slug && e.slug.includes(specSlug)));
        if (entry) {
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

  let activeBranch = currentBranch;
  let branchReused = false;

  // Feature branch activation before step 1 (AC6, AC7, AC8)
  if (useFeatureBranches) {
    // AC7: Refuse dirty working tree
    try {
      const statusOut = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (statusOut) {
        console.error(`[Branch Activation] Error: Git working tree is dirty; cannot create or switch feature branch.`);
        options._runResult = { status: 'failed', error: 'Working tree is dirty; refusing feature branch activation' };
        return 1;
      }
    } catch (gitErr) {
      console.error(`[Branch Activation] Git error: ${gitErr.message}`);
      options._runResult = { status: 'failed', error: gitErr.message };
      return 1;
    }

    const targetBranch = `feature/${specSlug}`;
    if (currentBranch === targetBranch) {
      branchReused = true;
      activeBranch = targetBranch;
      console.log(`[Branch Activation] Already on feature branch "${targetBranch}" (reused).`);
    } else {
      const branchCheck = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}`], { cwd: targetRoot });
      if (branchCheck.status === 0) {
        // AC8: Switch to existing branch and record reuse
        try {
          execSync(`git switch ${targetBranch}`, { cwd: targetRoot, stdio: 'ignore' });
          branchReused = true;
          activeBranch = targetBranch;
          console.log(`[Branch Activation] Reused and switched to existing feature branch "${targetBranch}".`);
        } catch (switchErr) {
          console.error(`[Branch Activation] Failed to switch to branch "${targetBranch}": ${switchErr.message}`);
          return 1;
        }
      } else {
        // AC6: Create and switch to new feature branch
        try {
          execSync(`git switch -c ${targetBranch}`, { cwd: targetRoot, stdio: 'ignore' });
          branchReused = false;
          activeBranch = targetBranch;
          console.log(`[Branch Activation] Created and switched to feature branch "${targetBranch}" from ${baseBranch}.`);
        } catch (createErr) {
          console.error(`[Branch Activation] Failed to create branch "${targetBranch}": ${createErr.message}`);
          return 1;
        }
      }
    }
  }

  const baseCommit = options.baseCommit || getBaseCommit(targetRoot);
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
  if (options.runId && fs.existsSync(stateManager.getStateFilePath(targetRoot, options.runId))) {
    state = stateManager.loadRunState(targetRoot, options.runId);
    state.branch = activeBranch;
    state.baseBranch = baseBranch;
    state.branchReused = branchReused;
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
      runtimeOverrides,
      scm: scmState
    });
  }

  console.log(`[sdw-orch] Run "${state.runId}" active at step ${startStep}/8.`);
  console.log(`[sdw-orch] State file: ${stateManager.getStateFilePath(targetRoot, state.runId)}`);

  let effectiveSpecContent = rawSpecContent;

  // Step 1: Spec Ingestion & Derivation (AC3, AC4)
  if (startStep <= 1 && state.steps[1].status !== 'completed' && state.steps[1].status !== 'skipped') {
    state = stateManager.updateStepState(targetRoot, state.runId, 1, 'in_progress');
    const derivationResult = specDerivation.deriveAgentSpec(rawSpecContent, { slug: specSlug });
    if (derivationResult.derivationNeeded) {
      console.log(`[Step 1: Derivation] Spec reformulated for agentic execution.`);
      effectiveSpecContent = derivationResult.specContent;
      state = stateManager.updateStepState(targetRoot, state.runId, 1, 'completed', { derivationNeeded: true });
    } else {
      console.log(`[Step 1: Derivation] Skipped: input spec is already agent-ready.`);
      state = stateManager.updateStepState(targetRoot, state.runId, 1, 'skipped', { derivationNeeded: false });
    }
  }

  // Step 2: Refinement (Grilling + Technical Planning) (AC1, AC2)
  if (startStep <= 2 && state.steps[2].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 2, 'in_progress');
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

    const refinementOutput = {
      hasGaps: grillingResult.hasGaps,
      gaps: grillingResult.gaps,
      gapsResolved: resolvedGaps,
      blueprint: grillingResult.blueprint
    };

    console.log(`[Step 2: Refinement] Refinement complete. Blueprint generated for ${grillingResult.blueprint.targetFiles.length} target file(s).`);
    const step2Artifact = artifactWriter.writeStep2Artifact({
      targetRoot,
      specSlug,
      runId: state.runId,
      grillingResult,
      effectiveSpecContent,
      artifactsDir: state.artifactsDir
    });
    state = stateManager.updateStepState(targetRoot, state.runId, 2, 'completed', refinementOutput, null, { artifact: step2Artifact });
  }

  // Step 3: Complexity Analysis & DAG Task Decomposition (AC3, AC7)
  let dagPlan = null;
  const blueprint = (state.steps[2] && state.steps[2].output && state.steps[2].output.blueprint) || null;
  if (startStep <= 3 && state.steps[3].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 3, 'in_progress');
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
  } else if (state.steps[3].output) {
    dagPlan = state.steps[3].output;
  } else {
    dagPlan = dagPlanner.generateDagPlan(effectiveSpecContent, { slug: specSlug, blueprint });
  }

  // Step 4: Implementation Execution Contract & Evidence Gate (Spec 015)
  const implConfig = (options.implementation || config.implementation || {});
  const implMode = options.implementationMode || implConfig.mode || 'handoff';

  if (startStep <= 4 && state.steps[4].status !== 'completed') {
    state.steps[4].tasks = state.steps[4].tasks || {};
    state.steps[4].gates = state.steps[4].gates || {};

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

    if (implMode === 'handoff') {
      if (useWorktrees) {
        // Handoff prepares prompts for an external worker; task worktrees are not created here.
        // Fall back to the primary tree instead of advertising a non-existent working directory.
        useWorktrees = false;
        state.worktreeSkipReason = 'handoff mode uses the primary working tree; task worktrees are only created in command mode';
        state = stateManager.saveRunState(targetRoot, state);
        console.log(`[Step 4: Worktree] Worktrees skipped in handoff mode; using the primary working tree.`);
      }

      // AC3: write one prompt file per DAG task
      const preparedTasks = [];
      for (const task of dagPlan.tasks) {
        let taskWorktreeRel = null;
        if (useWorktrees) {
          taskWorktreeRel = `.sdw/worktrees/${state.runId}/${task.id}`;
        }
        const rendered = implementationRunner.renderTaskPrompt({
          targetRoot,
          specSlug,
          runId: state.runId,
          stateDir: stateManager.resolveStateDir(targetRoot),
          task,
          specAcs,
          useWorktrees,
          taskWorktreeRel
        });

        const existingTask = state.steps[4].tasks[task.id] || {};
        state.steps[4].tasks[task.id] = {
          ...existingTask,
          id: task.id,
          title: task.title,
          status: existingTask.status || 'pending',
          promptPath: rendered.promptFileRel,
          evidencePath: existingTask.evidencePath || rendered.evidenceFileRel,
          workingDir: rendered.workingDirRel,
          coveredAcs: task.coveredAcs || [],
          dependencies: task.dependencies || []
        };
        preparedTasks.push(task.id);
      }

      // AC4: set Step 4 status to awaiting_implementation
      state.status = 'paused';
      state.steps[4].status = 'awaiting_implementation';
      state = stateManager.saveRunState(targetRoot, state);

      console.log(`\n[Step 4: Implementation] Prepared ${dagPlan.tasks.length} task prompt file(s) under handoff mode.`);
      dagPlan.tasks.forEach(t => {
        const tState = state.steps[4].tasks[t.id];
        console.log(`  + [${t.id}] ${t.title}`);
        console.log(`      Prompt:   ${tState.promptPath}`);
        console.log(`      Evidence: ${tState.evidencePath}`);
      });
      console.log(`\n[Step 4: Implementation] Status: awaiting_implementation.`);
      console.log(`Please implement tasks respecting DAG dependencies and submit evidence with:`);
      console.log(`  node skills/sdw-orch/scripts/sdw_orch.cjs task finish --run-id ${state.runId} --task <taskId> --evidence <evidencePath>`);
      console.log(`Once all tasks have accepted evidence, continue with:`);
      console.log(`  node skills/sdw-orch/scripts/sdw_orch.cjs resume --run-id ${state.runId}`);

      options._runResult = {
        runId: state.runId,
        status: 'awaiting_implementation',
        currentStep: 4,
        tasksPrepared: preparedTasks.length
      };

      // AC5: exit with code 4
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
          evidenceData.filesChanged
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
          completedAt: new Date().toISOString()
        };
        completedTaskIds.add(task.id);
        stateManager.saveRunState(targetRoot, state);
        console.log(`[Step 4: Implementation] Task ${task.id} accepted (commit ${commitSha}, ${evidenceData.acIds.length} ACs, ${evidenceData.filesChanged.length} files).`);
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
    }
  }

  // Step 5: Conformance Scoring Loop (AC9, AC10, AC18, AC19, AC23, AC24)
  let scoreReport = null;
  if (startStep <= 5 && state.steps[5].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 5, 'in_progress');
    scoreReport = scoreEvaluator.evaluateScore(effectiveSpecContent, {
      projectRoot: targetRoot,
      slug: specSlug,
      baseCommit: state.baseCommit,
      minScore: effectiveMinScore,
      blueprint,
      tasks: (state.steps && state.steps[4] && state.steps[4].tasks) || {},
      state
    });

    console.log(`[Step 5: Conformance Scoring] Score: ${scoreReport.score}/10 (Required: ${effectiveMinScore}/10). Passed: ${scoreReport.passed}`);
    console.log(`  Verified ACs: ${scoreReport.verifiedCount}/${scoreReport.totalAcs}`);
    console.log(`  Failing ACs:  ${scoreReport.failingCount}/${scoreReport.totalAcs}`);

    const step5Artifact = artifactWriter.writeStep5Artifact({
      targetRoot,
      specSlug,
      runId: state.runId,
      scoreReport,
      dagPlan,
      artifactsDir: state.artifactsDir
    });

    if (!scoreReport.passed) {
      console.error(`[Step 5: Conformance Scoring] Conformance score below threshold (${scoreReport.score} < ${effectiveMinScore}). Triggering re-implementation feedback loop.`);
      state = stateManager.updateStepState(targetRoot, state.runId, 5, 'reimplementation_needed', scoreReport, null, { artifact: step5Artifact });
      state.score = scoreReport.score;
      state.scoreIteration = (state.scoreIteration || 0) + 1;
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', score: scoreReport.score, error: 'Conformance score below threshold' };
      return 2; // Exit code 2 indicates score failure / re-implementation needed
    }

    state = stateManager.updateStepState(targetRoot, state.runId, 5, 'completed', scoreReport, null, { artifact: step5Artifact });
    state.score = scoreReport.score;
    state.scoreIteration = (state.scoreIteration || 0) + 1;
    state = stateManager.saveRunState(targetRoot, state);
  } else if (state.steps[5] && state.steps[5].output) {
    scoreReport = state.steps[5].output;
    if (state.score === null && scoreReport.score !== undefined) {
      state.score = scoreReport.score;
    }
  }

  // Step 6: Delivery Commit (AC11, AC20, AC25)
  if (startStep <= 6 && state.steps[6].status !== 'completed') {
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

    const gates = (state.steps[4] && state.steps[4].gates) || {};
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
    try {
      // Mark spec as completed in index.specs.md prior to staging delivery commit (AC24)
      if (specIndex) {
        try {
          specIndex.updateSpecStatus(specSlug, 'completed', { root: targetRoot });
        } catch (e) {}
      }

      const statusOut = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8' }).trim();
      if (statusOut) {
        console.log(`[Step 6: Delivery Commit] Staging and committing implementation changes...`);
        execSync('git add -A', { cwd: targetRoot, stdio: 'ignore' });
        execSync(`git commit -m "feat(${specSlug}): implement ${specSlug}"`, { cwd: targetRoot, stdio: 'ignore' });
        commitSha = getBaseCommit(targetRoot);
        console.log(`[Step 6: Delivery Commit] Created delivery commit ${commitSha}`);
      } else {
        commitSha = getBaseCommit(targetRoot) || baseCommit;
        console.log(`[Step 6: Delivery Commit] Working tree clean; using commit ${commitSha}`);
      }
    } catch (err) {
      console.log(`[Step 6: Delivery Commit] Git note: ${err.message}`);
      commitSha = getBaseCommit(targetRoot);
    }
    state.deliveryCommit = commitSha;
    state = stateManager.saveRunState(targetRoot, state);
    state = stateManager.updateStepState(targetRoot, state.runId, 6, 'completed', { deliveryCommit: commitSha });
  }

  // Step 7: Automated Code Review Loop (AC12, AC13)
  if (startStep <= 7 && state.steps[7].status !== 'completed' && !options.skipReview) {
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'in_progress');
    let reviewReport = reviewRunner.runAutomatedReview({ projectRoot: targetRoot, baseCommit: state.baseCommit });
    console.log(`[Step 7: Automated Review] ${reviewReport.summary}`);

    let reviewLoop = 0;
    while (!reviewReport.passed && reviewLoop < 3) {
      reviewLoop++;
      console.log(`[Step 7: Automated Review] Applying auto-fixes for iteration ${reviewLoop}...`);
      const fixed = reviewRunner.applyAutoFixes(reviewReport.findings, targetRoot);
      if (fixed.length === 0) {
        break;
      }
      // Security checks gate before review-fix commit (AC7)
      if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
        console.log(`[Step 7: Security Gate] Running pre-commit leak scan before review-fix commit...`);
        // Review fixes are unstaged; scan the worktree so the gate sees them before staging.
        const scanResult = runSecurityGate(targetRoot, { staged: false });
        if (scanResult.exitCode !== 0) {
          console.error(`[Step 7: Security Gate] Review-fix commit blocked by security checks gate (exit code ${scanResult.exitCode}).`);
          break;
        }
      }
      try {
        execSync('git add -A', { cwd: targetRoot, stdio: 'ignore' });
        execSync(`git commit -m "fix(${specSlug}): apply automated review fixes (iteration ${reviewLoop})"`, { cwd: targetRoot, stdio: 'ignore' });
      } catch (e) {}
      reviewReport = reviewRunner.runAutomatedReview({ projectRoot: targetRoot, baseCommit: state.baseCommit });
    }

    state.reviewIteration = reviewLoop;
    if (!reviewReport.passed) {
      console.error(`[Step 7: Automated Review] Review loop halted with unresolved errors.`);
      state = stateManager.updateStepState(targetRoot, state.runId, 7, 'review_failed', reviewReport);
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      return 1;
    }

    state.reviewCommit = getBaseCommit(targetRoot);
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'completed', reviewReport);
  } else if (options.skipReview) {
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'skipped', { reason: 'Skipped via --skip-review' });
  }

  // Step 8: PR Preparation, Pre-PR Gates & Remote Comment Loop (AC5, AC6, AC7, AC8, AC9, AC10, AC11, AC12, AC14, AC15)
  if (startStep <= 8 && state.steps[8].status !== 'completed' && !options.skipPr) {
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'in_progress');

    const shipPrScript = path.resolve(__dirname, '../../sdw-ship-pr/scripts/sdw_ship_pr.cjs');
    const hasShipPr = fs.existsSync(shipPrScript);

    // If sdw-ship-pr is available and no unit-test fixer hooks are passed, delegate pre-PR gates to sdw-ship-pr as single owner
    if (!hasShipPr || options.testFixer || options.buildFixer || options.prePrHook) {
      // 1. Project-Specific Pre-PR Instructions / Lifecycle Hook (AC11, AC12)
      if (config.prePrInstructions) {
        console.log(`[Step 8: Pre-PR Gate] Evaluating project pre-PR instructions: "${config.prePrInstructions}"`);
      }
      if (config.prePrCommand || typeof options.prePrHook === 'function') {
        try {
          if (config.prePrCommand) {
            console.log(`[Step 8: Pre-PR Gate] Executing pre-PR command: "${config.prePrCommand}"...`);
            execSync(config.prePrCommand, { cwd: targetRoot, stdio: 'inherit' });
          }
          if (typeof options.prePrHook === 'function') {
            options.prePrHook(targetRoot);
          }
          const prePrStatus = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8' }).trim();
          if (prePrStatus) {
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
            execSync('git add -A', { cwd: targetRoot, stdio: 'ignore' });
            execSync(`git commit -m "chore(${specSlug}): apply pre-pr requirements"`, { cwd: targetRoot, stdio: 'ignore' });
            state.deliveryCommit = getBaseCommit(targetRoot);
            stateManager.saveRunState(targetRoot, state);
          }
        } catch (err) {
          console.error(`[Step 8: Pre-PR Gate] Pre-PR command failed: ${err.message}`);
          state.status = 'failed';
          stateManager.recordError(targetRoot, state.runId, 8, `Pre-PR command failed: ${err.message}`);
          return 1;
        }
      }

      // 2. Pre-PR Quality Gates (Build Verification & Full Test Pass) (AC5, AC6, AC7, AC8, AC9, AC10)
      const requiredBuild = Boolean(config.requiredBuild);
      const runAllTests = Boolean(config.runAllTests);

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
              execSync(buildCmd, { cwd: targetRoot, stdio: ['ignore', 'pipe', 'pipe'] });
              buildPassed = true;
            } catch (buildErr) {
              buildAttempts++;
              if (buildAttempts > maxFixAttempts) {
                console.error(`[Step 8: Pre-PR Verification] Build verification failed after ${maxFixAttempts} attempt(s). Halting.`);
                state.status = 'failed';
                stateManager.recordError(targetRoot, state.runId, 8, `Build verification failed after ${maxFixAttempts} attempt(s): ${buildErr.message}`);
                return 1;
              }
              console.log(`[Step 8: Pre-PR Verification] Build failed. Attempting automated surgical fix (attempt ${buildAttempts}/${maxFixAttempts})...`);
              if (typeof options.buildFixer === 'function') {
                options.buildFixer(targetRoot, buildAttempts);
              }
              const fixStatus = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8' }).trim();
              if (fixStatus) {
                if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
                  const sec = runSecurityGate(targetRoot, { staged: false });
                  if (sec.exitCode !== 0) {
                    console.error(`[Step 8: Pre-PR Verification] Fix commit rejected: secret leak detected.`);
                    state.status = 'failed';
                    stateManager.recordError(targetRoot, state.runId, 8, 'Fix commit rejected: secret leak detected');
                    return 1;
                  }
                }
                execSync('git add -A', { cwd: targetRoot, stdio: 'ignore' });
                execSync(`git commit -m "fix(${specSlug}): resolve build failure (attempt ${buildAttempts})"`, { cwd: targetRoot, stdio: 'ignore' });
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
              execSync(testCmd, { cwd: targetRoot, stdio: ['ignore', 'pipe', 'pipe'] });
              testPassed = true;
            } catch (testErr) {
              testAttempts++;
              if (testAttempts > maxFixAttempts) {
                console.error(`[Step 8: Pre-PR Verification] Test verification failed after ${maxFixAttempts} attempt(s). Halting.`);
                state.status = 'failed';
                stateManager.recordError(targetRoot, state.runId, 8, `Test verification failed after ${maxFixAttempts} attempt(s): ${testErr.message}`);
                return 1;
              }
              console.log(`[Step 8: Pre-PR Verification] Tests failed. Attempting automated surgical fix (attempt ${testAttempts}/${maxFixAttempts})...`);
              if (typeof options.testFixer === 'function') {
                options.testFixer(targetRoot, testAttempts);
              }
              const fixStatus = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8' }).trim();
              if (fixStatus) {
                if (Boolean(config.securityChecksEnabled) && !options.skipSecurity) {
                  const sec = runSecurityGate(targetRoot, { staged: false });
                  if (sec.exitCode !== 0) {
                    console.error(`[Step 8: Pre-PR Verification] Fix commit rejected: secret leak detected.`);
                    state.status = 'failed';
                    stateManager.recordError(targetRoot, state.runId, 8, 'Fix commit rejected: secret leak detected');
                    return 1;
                  }
                }
                execSync('git add -A', { cwd: targetRoot, stdio: 'ignore' });
                execSync(`git commit -m "fix(${specSlug}): resolve test failure (attempt ${testAttempts})"`, { cwd: targetRoot, stdio: 'ignore' });
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
      const scmContract = getScmProviderContract();
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
        const runArgs = [
          `"${shipPrScript}"`,
          `--run-id "${state.runId}"`,
          `--spec "${specSlug}"`,
          `--root "${targetRoot.replace(/\\/g, '/')}"`,
          options.push || config.pushDelivery ? '--push' : '',
          pollPr ? '--poll-pr' : '',
          options.dryRun ? '--dry-run' : '',
          '--json'
        ].filter(Boolean).join(' ');

        const shipStdout = execSync(`node ${runArgs}`, {
          cwd: targetRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });

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
          if (shipResult.success === false || shipResult.shipStatus === 'failed') {
            throw new Error(shipResult.error || 'sdw-ship-pr reported delivery failure');
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

    // Mark spec as completed in index.specs.md after successful delivery (AC24)
    if (specIndex) {
      try {
        specIndex.updateSpecStatus(specSlug, 'completed', { root: targetRoot });
      } catch (e) {}
    }
  } else if (options.skipPr) {
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'skipped', { reason: 'Skipped via --skip-pr' });
    if (specIndex) {
      try {
        specIndex.updateSpecStatus(specSlug, 'completed', { root: targetRoot });
      } catch (e) {}
    }
  }

  // Remote Push / Branch Publishing (--push or config.pushDelivery) fallback
  const shouldPush = options.push !== undefined ? options.push : (config && config.pushDelivery);
  if (shouldPush && !state.pushedBranch) {
    try {
      const remotes = execSync('git remote', { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: targetRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (remotes && currentBranch && currentBranch !== 'HEAD') {
        console.log(`[sdw-orch] Pushing delivery branch to origin/${currentBranch}...`);
        execSync(`git push origin ${currentBranch}`, { cwd: targetRoot, stdio: 'inherit' });
        state.pushedBranch = currentBranch;
      } else if (!remotes) {
        console.log(`[sdw-orch] Remote push skipped: no git remote configured.`);
      }
    } catch (pushErr) {
      console.error(`[sdw-orch] Warning: git push failed: ${pushErr.message}`);
      if (!state.errors) state.errors = [];
      state.errors.push({ step: 8, timestamp: new Date().toISOString(), error: `git push failed: ${pushErr.message}` });
    }
  } else if (!shouldPush) {
    console.log(`[Step 8: PR Preparation] Pre-PR verification passed. PR payload assembled (remote push disabled).`);
  }

  state.status = 'completed';
  state.currentStep = 8;
  state = stateManager.saveRunState(targetRoot, state);
  console.log(`\n[sdw-orch] Workflow completed successfully for run "${state.runId}".`);

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

  const config = loadProjectConfig(targetRoot);
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

  const completedTaskIds = new Set(
    Object.keys(state.steps[4].tasks).filter(k => state.steps[4].tasks[k].status === 'completed')
  );

  // Check DAG dependencies (AC9)
  const depCheck = implementationRunner.checkTaskDependencies({ tasks: dagTasks }, taskId, completedTaskIds);
  if (!depCheck.satisfied) {
    console.error(`Error: Task "${taskId}" has uncompleted dependencies: ${depCheck.missingDependencies.join(', ')}`);
    return 1;
  }

  // Load spec to validate AC IDs
  let specAcs = [];
  if (state.specPath && fs.existsSync(state.specPath)) {
    try {
      const specContent = fs.readFileSync(state.specPath, 'utf8');
      specAcs = dagPlanner.parseAcceptanceCriteria(specContent);
    } catch (e) {}
  }

  // Validate evidence schema & content (AC8, AC28, AC29)
  const evValidation = evidenceValidator.validateEvidenceFile(evidenceFileAbs, {
    expectedTaskId: taskId,
    specAcs,
    projectRoot: targetRoot
  });

  if (!evValidation.valid) {
    console.error(`Evidence validation failed for ${taskId}:\n  ` + evValidation.errors.join('\n  '));
    return 1;
  }

  const evidenceData = evValidation.data;

  // Corroborate changes (AC13, AC14, AC15)
  let commitSha = null;
  const taskWorktreeRel = `.sdw/worktrees/${state.runId}/${taskId}`;
  const taskWorktreeAbs = path.resolve(targetRoot, taskWorktreeRel);

  const worktreeExists = useWorktrees && fs.existsSync(taskWorktreeAbs);
  const effectiveUseWorktrees = useWorktrees && worktreeExists;

  const hasChanges = implementationRunner.checkTaskChanges(
    targetRoot,
    effectiveUseWorktrees ? taskWorktreeAbs : null,
    effectiveUseWorktrees,
    evidenceData.filesChanged
  );

  if (!hasChanges) {
    const errMsg = effectiveUseWorktrees
      ? `Task working tree for ${taskId} contains no changes.`
      : `None of the files listed in filesChanged contain modifications in primary working tree.`;
    console.error(`Error: ${errMsg}`);
    return 1;
  }

  // Integrate worktree if used (AC10, AC11)
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
  } else {
    commitSha = getBaseCommit(targetRoot);
  }

  // Record task completion in state (AC16)
  state.steps[4].tasks[taskId] = {
    ...(state.steps[4].tasks[taskId] || {}),
    id: taskId,
    title: targetTask.title,
    status: 'completed',
    evidencePath: path.isAbsolute(evidencePath) ? path.relative(targetRoot, evidenceFileAbs).replace(/\\/g, '/') : evidencePath.replace(/\\/g, '/'),
    commitSha,
    filesChanged: evidenceData.filesChanged,
    acIds: evidenceData.acIds,
    completedAt: new Date().toISOString()
  };

  completedTaskIds.add(taskId);
  state = stateManager.saveRunState(targetRoot, state);

  console.log(`[sdw-orch task finish] Task "${taskId}" successfully accepted.`);
  console.log(`  Covered ACs:   ${evidenceData.acIds.join(', ')}`);
  console.log(`  Files Changed: ${evidenceData.filesChanged.join(', ')}`);
  if (commitSha) {
    console.log(`  Commit SHA:    ${commitSha}`);
  }

  // Check if all DAG tasks are completed
  const remainingTasks = dagTasks.filter(t => !completedTaskIds.has(t.id));
  if (remainingTasks.length > 0) {
    console.log(`\nRemaining tasks to complete (${remainingTasks.length}):`);
    remainingTasks.forEach(t => console.log(`  - [${t.id}] ${t.title}`));
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
    console.log(`Step 4 completed successfully! Proceed to Step 5 by running:`);
    console.log(`  node skills/sdw-orch/scripts/sdw_orch.cjs resume --run-id ${state.runId}`);
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
      const resumeConfig = loadProjectConfig(targetRoot);
      const implMode = options.implementationMode || (resumeConfig.implementation && resumeConfig.implementation.mode) || 'handoff';
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

      console.error(`[sdw-orch resume] Cannot advance past Step 4: ${incompleteTasks.length} task(s) remain incomplete:`);
      dagTasks.forEach(t => {
        const isDone = completedTasks.includes(t.id);
        console.log(`  [${isDone ? 'COMPLETED' : 'PENDING'}] ${t.id}: ${t.title}`);
      });
      console.error(`\nPlease complete remaining tasks and submit accepted evidence via:`);
      console.error(`  node skills/sdw-orch/scripts/sdw_orch.cjs task finish --run-id ${state.runId} --task <taskId> --evidence <evidencePath>`);
      return 4;
    }

    // All tasks completed. Execute build and test verification gates (AC20)
    const config = loadProjectConfig(targetRoot);
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
    startStep: resumptionStep
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
  if (state.errors && state.errors.length > 0) {
    console.log('\nRecorded Errors:');
    state.errors.forEach(e => {
      console.log(`  [Step ${e.step}] ${e.error}`);
    });
  }
  return 0;
}

function cmdBatchRun(options) {
  const specs = options.specPaths && options.specPaths.length > 0
    ? options.specPaths
    : (options.specPath ? [options.specPath] : []);
  const batchOpts = {
    ...options,
    unattended: options.unattended !== false,
    autoResolveGaps: true
  };
  return batchRunner.runBatch(specs, batchOpts, cmdRun);
}

function cmdResumeBatch(options) {
  const batchOpts = {
    ...options,
    unattended: options.unattended !== false,
    autoResolveGaps: true
  };
  return batchRunner.resumeBatch(options.batchId, batchOpts, cmdRun);
}

function showHelp() {
  console.log(`Usage: node sdw_orch.cjs <subcommand> [specPath...] [options]

Subcommands:
  run <specPath...>      Execute orchestration workflow for single spec or batch queue
  resume                 Resume paused or incomplete execution run from state file
  resume-batch [batchId] Resume paused or incomplete multi-spec batch execution
  task finish            Submit accepted evidence for a completed DAG task
  status                 Check status of current or specified run state
  help                   Display this help documentation

Options:
  --run-id <id>          Explicit run identifier (default: auto-generated or latest)
  --task <id>            DAG task ID for task finish (alias: --task-id)
  --evidence <path>      Path to evidence JSON file (alias: --evidence-path)
  --mode <mode>          Implementation mode (handoff | command)
  --batch-id <id>        Explicit batch identifier for resume-batch
  --continue-on-error    Continue queue execution when a batch item fails
  --dry-run              Validate specs and display batch execution plan without executing
  --no-sync              Skip automatic sdw-spec sync between batch queue items
  --unattended           Execute without interruption, auto-resolving grilling gaps (default in batch)
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
  --no-feature-branch    Disable feature branch creation even if configured
  --feature-branch       Force feature branch creation
  --skip-review          Skip code review step
  --skip-pr              Skip pull request preparation step
  --force                Override quality gates or allow execution on archived specs
  --allow-archived       Permit execution of specs marked archived in index.specs.md
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
        code = cmdBatchRun(options);
      } else {
        code = cmdRun(options);
      }
      break;
    case 'resume-batch':
      code = cmdResumeBatch(options);
      break;
    case 'resume':
      code = cmdResume(options);
      break;
    case 'task-finish':
      code = cmdTaskFinish(options);
      break;
    case 'status':
      code = cmdStatus(options);
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
  cmdRun,
  cmdBatchRun,
  cmdResumeBatch,
  cmdResume,
  cmdStatus,
  cmdTaskFinish,
  showHelp,
  loadProjectConfig,
  resolveSpecPath
};
