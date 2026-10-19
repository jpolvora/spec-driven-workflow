#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const stateManager = require('./state_manager.cjs');
const specDerivation = require('./spec_derivation.cjs');
const specGrilling = require('./spec_grilling.cjs');
const dagPlanner = require('./dag_planner.cjs');
const scoreEvaluator = require('./score_evaluator.cjs');
const reviewRunner = require('./review_runner.cjs');
const batchRunner = require('./batch_runner.cjs');

function getSpecIndexHelper() {
  try {
    return require('../../sdw-spec/scripts/spec_index.cjs');
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
    skipSecurity: false
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--unattended') result.unattended = true;
    else if (arg === '--interactive') result.unattended = false;
    else if (arg === '--skip-security') result.skipSecurity = true;
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
    else if (arg === '--step') result.step = parseInt(args[++i], 10);
    else if (arg.startsWith('--step=')) result.step = parseInt(arg.slice(7), 10);
    else if (arg === '--min-score') result.minScore = parseInt(args[++i], 10);
    else if (arg.startsWith('--min-score=')) result.minScore = parseInt(arg.slice(12), 10);
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  result.subcommand = positional[0] || null;
  result.specPaths = positional.slice(1);
  result.specPath = positional[1] || null;

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
    securityChecksEnabled: false
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

  const baseCommit = options.baseCommit || getBaseCommit(targetRoot);
  const startStep = options.startStep || (options.step ? options.step : 1);

  // Initialize or restore Run State (AC1, AC2)
  let state;
  if (options.runId && fs.existsSync(stateManager.getStateFilePath(targetRoot, options.runId))) {
    state = stateManager.loadRunState(targetRoot, options.runId);
  } else {
    state = stateManager.createRunState({
      root: targetRoot,
      specPath: options.specPath,
      slug: specSlug,
      runId: options.runId,
      baseCommit
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

  // Step 2: Grilling Round & Decision Gate (AC5, AC6)
  if (startStep <= 2 && state.steps[2].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 2, 'in_progress');
    const grillingResult = specGrilling.analyzeSpecificationGaps(effectiveSpecContent);

    if (grillingResult.hasGaps) {
      console.log(`[Step 2: Grilling] Detected ${grillingResult.gapsCount} specification decision gaps.`);
      for (const gap of grillingResult.gaps) {
        console.log(`  * Gap [${gap.dimension}]: ${gap.question} -> Default: ${gap.defaultChoice}`);
      }

      if (options.abortOnGaps && !options.unattended) {
        console.log(`[Step 2: Grilling] User cancellation / gate stop triggered (--abort-on-gaps). Halting without dispatch.`);
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
      console.log(`[Step 2: Grilling] Grilling check clean: all core decision dimensions covered.`);
    }

    state = stateManager.updateStepState(targetRoot, state.runId, 2, 'completed', { hasGaps: grillingResult.hasGaps, gaps: grillingResult.gaps });
  }

  // Step 3: Complexity Analysis & DAG Task Decomposition (AC7)
  let dagPlan = null;
  if (startStep <= 3 && state.steps[3].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 3, 'in_progress');
    dagPlan = dagPlanner.generateDagPlan(effectiveSpecContent, { slug: specSlug });
    console.log(`[Step 3: DAG Generation] Complexity: ${dagPlan.complexity.level}. Generated ${dagPlan.totalTasks} task(s).`);
    state.dagTasks = dagPlan.tasks;
    state = stateManager.saveRunState(targetRoot, state);
    state = stateManager.updateStepState(targetRoot, state.runId, 3, 'completed', dagPlan);
  } else if (state.steps[3].output) {
    dagPlan = state.steps[3].output;
  } else {
    dagPlan = dagPlanner.generateDagPlan(effectiveSpecContent, { slug: specSlug });
  }

  // Step 4: Subagent Context Fencing & Dispatch (AC8, AC16)
  if (startStep <= 4 && state.steps[4].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 4, 'in_progress');
    console.log(`[Step 4: Implementation] Prepared ${dagPlan.tasks.length} context-fenced task prompt(s).`);
    dagPlan.tasks.forEach(t => {
      console.log(`  + [${t.id}] ${t.title} (Covering: ${t.coveredAcs.join(', ')})`);
    });

    if (options.simulateFailure) {
      console.error(`[Step 4: Implementation] Unrecoverable failure occurred during subagent execution (AC16).`);
      stateManager.recordError(targetRoot, state.runId, 4, 'Simulated unrecoverable subagent execution failure');
      options._runResult = { runId: state.runId, status: 'failed', error: 'Simulated unrecoverable subagent execution failure' };
      return 1;
    }

    state = stateManager.updateStepState(targetRoot, state.runId, 4, 'completed', { tasksPrepared: dagPlan.tasks.length });
  }

  // Step 5: Conformance Scoring Loop (AC9, AC10)
  let scoreReport = null;
  if (startStep <= 5 && state.steps[5].status !== 'completed') {
    state = stateManager.updateStepState(targetRoot, state.runId, 5, 'in_progress');
    scoreReport = scoreEvaluator.evaluateScore(effectiveSpecContent, {
      projectRoot: targetRoot,
      slug: specSlug,
      baseCommit: state.baseCommit,
      minScore: effectiveMinScore
    });

    console.log(`[Step 5: Conformance Scoring] Score: ${scoreReport.score}/10 (Required: ${effectiveMinScore}/10). Passed: ${scoreReport.passed}`);
    console.log(`  Verified ACs: ${scoreReport.verifiedCount}/${scoreReport.totalAcs}`);
    console.log(`  Failing ACs:  ${scoreReport.failingCount}/${scoreReport.totalAcs}`);

    if (!scoreReport.passed) {
      console.error(`[Step 5: Conformance Scoring] Conformance score below threshold (${scoreReport.score} < ${effectiveMinScore}). Triggering re-implementation feedback loop.`);
      state = stateManager.updateStepState(targetRoot, state.runId, 5, 'reimplementation_needed', scoreReport);
      state.score = scoreReport.score;
      state.scoreIteration = (state.scoreIteration || 0) + 1;
      state.status = 'failed';
      stateManager.saveRunState(targetRoot, state);
      options._runResult = { runId: state.runId, status: 'failed', score: scoreReport.score, error: 'Conformance score below threshold' };
      return 2; // Exit code 2 indicates score failure / re-implementation needed
    }

    state = stateManager.updateStepState(targetRoot, state.runId, 5, 'completed', scoreReport);
    state.score = scoreReport.score;
    state.scoreIteration = (state.scoreIteration || 0) + 1;
    state = stateManager.saveRunState(targetRoot, state);
  } else if (state.steps[5] && state.steps[5].output) {
    scoreReport = state.steps[5].output;
    if (state.score === null && scoreReport.score !== undefined) {
      state.score = scoreReport.score;
    }
  }

  // Step 6: Delivery Commit (AC11)
  if (startStep <= 6 && state.steps[6].status !== 'completed') {
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
        const scanResult = runSecurityGate(targetRoot, { staged: true });
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
        const scanResult = runSecurityGate(targetRoot, { staged: true });
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

  // Step 8: PR Preparation & Remote Comment Loop (AC14, AC15)
  if (startStep <= 8 && state.steps[8].status !== 'completed' && !options.skipPr) {
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'in_progress');
    const prPayload = {
      title: `feat(${specSlug}): implement ${specSlug}`,
      specSlug,
      baseCommit: state.baseCommit,
      deliveryCommit: state.deliveryCommit,
      score: state.score,
      completedAt: new Date().toISOString()
    };
    console.log(`[Step 8: PR Preparation] Assembled PR payload: "${prPayload.title}".`);

    // Mark spec as completed in index.specs.md if helper exists (AC24)
    if (specIndex) {
      try {
        specIndex.updateSpecStatus(specSlug, 'completed', { root: targetRoot });
      } catch (e) {}
    }

    // Optional Remote Review Resolution Loop (AC15)
    const pollPr = options.pollPr !== undefined ? options.pollPr : (config.scmCodeReviewEnabled || false);
    if (pollPr) {
      console.log(`[Step 8: PR Preparation] SCM code review loop enabled. Polling for reviewer feedback...`);
      prPayload.pollEnabled = true;
    }

    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'completed', prPayload);
  } else if (options.skipPr) {
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'skipped', { reason: 'Skipped via --skip-pr' });
  }

  // Remote Push / Branch Publishing (--push or config.pushDelivery)
  const shouldPush = options.push !== undefined ? options.push : (config && config.pushDelivery);
  if (shouldPush) {
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
    console.error('Error: specify --run-id <id> or --latest to resume.');
    return 1;
  }

  // Reject obsolete run state files created before sdw-orch migration
  if (!state.orchestrator || state.orchestrator !== 'sdw-orch') {
    console.error(`Error: Run state "${state.runId}" is obsolete or incompatible with sdw-orch (orchestrator: "${state.orchestrator || 'legacy'}"). Resuming legacy run states is unsupported.`);
    return 1;
  }

  const resumptionStep = stateManager.getResumptionStep(state);
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
  console.log(`Status:       ${state.status}`);
  console.log(`Current Step: ${state.currentStep}/${state.totalSteps}`);
  console.log(`Score:        ${state.score !== null ? `${state.score}/10` : 'Not evaluated yet'}`);
  console.log(`Created:      ${state.createdAt}`);
  console.log(`Updated:      ${state.updatedAt}`);
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
  status                 Check status of current or specified run state
  help                   Display this help documentation

Options:
  --run-id <id>          Explicit run identifier (default: auto-generated)
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
  --latest               (status/resume) Target the most recent run state
  --push                 Push active branch and delivery commit to remote origin
  --skip-security        Bypass pre-commit security checks gate (audit logged)
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
  showHelp,
  loadProjectConfig,
  resolveSpecPath
};
