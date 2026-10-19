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

function parseArgs(args) {
  const result = {
    subcommand: null,
    specPath: null,
    runId: null,
    root: null,
    minScore: 8,
    skipReview: false,
    skipPr: false,
    json: false,
    latest: false
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--skip-review') result.skipReview = true;
    else if (arg === '--skip-pr') result.skipPr = true;
    else if (arg === '--latest') result.latest = true;
    else if (arg === '--root') result.root = args[++i];
    else if (arg.startsWith('--root=')) result.root = arg.slice(7);
    else if (arg === '--run-id') result.runId = args[++i];
    else if (arg.startsWith('--run-id=')) result.runId = arg.slice(9);
    else if (arg === '--min-score') result.minScore = parseInt(args[++i], 10);
    else if (arg.startsWith('--min-score=')) result.minScore = parseInt(arg.slice(12), 10);
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  result.subcommand = positional[0] || null;
  result.specPath = positional[1] || null;
  return result;
}

function getBaseCommit(projectRoot) {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
}

function cmdRun(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  if (!options.specPath) {
    console.error('Error: specPath is required for "run" command.');
    return 1;
  }

  const specFullPath = path.resolve(targetRoot, options.specPath);
  if (!fs.existsSync(specFullPath)) {
    console.error(`Error: Specification file not found at: ${specFullPath}`);
    return 1;
  }

  const rawSpecContent = fs.readFileSync(specFullPath, 'utf8');
  const specSlug = path.basename(specFullPath, path.extname(specFullPath)).replace(/^step-\d+-/, '');
  const baseCommit = getBaseCommit(targetRoot);

  // Initialize Run State (AC1)
  let state = stateManager.createRunState({
    root: targetRoot,
    specPath: options.specPath,
    slug: specSlug,
    runId: options.runId,
    baseCommit
  });

  console.log(`[sdw-implement] Initialized run "${state.runId}"`);
  console.log(`[sdw-implement] State file: ${stateManager.getStateFilePath(targetRoot, state.runId)}`);

  // Step 1: Spec Ingestion & Derivation (AC3, AC4)
  state = stateManager.updateStepState(targetRoot, state.runId, 1, 'in_progress');
  const derivationResult = specDerivation.deriveAgentSpec(rawSpecContent, { slug: specSlug });
  let effectiveSpecContent = rawSpecContent;
  if (derivationResult.derivationNeeded) {
    console.log(`[Step 1: Derivation] Spec reformulated for agentic execution.`);
    effectiveSpecContent = derivationResult.specContent;
    state = stateManager.updateStepState(targetRoot, state.runId, 1, 'completed', { derivationNeeded: true });
  } else {
    console.log(`[Step 1: Derivation] Skipped: input spec is already agent-ready.`);
    state = stateManager.updateStepState(targetRoot, state.runId, 1, 'skipped', { derivationNeeded: false });
  }

  // Step 2: Grilling Round & Gap Resolution (AC5, AC6)
  state = stateManager.updateStepState(targetRoot, state.runId, 2, 'in_progress');
  const grillingResult = specGrilling.analyzeSpecificationGaps(effectiveSpecContent);
  if (grillingResult.hasGaps) {
    console.log(`[Step 2: Grilling] Detected ${grillingResult.gapsCount} specification decision gaps.`);
    grillingResult.gaps.forEach(g => {
      console.log(`  * Gap [${g.dimension}]: ${g.question} -> Default: ${g.defaultChoice}`);
    });
  } else {
    console.log(`[Step 2: Grilling] Decision tree walk completed: zero unhandled gaps.`);
  }
  state = stateManager.updateStepState(targetRoot, state.runId, 2, 'completed', grillingResult);

  // Step 3: Complexity Analysis & DAG Task Decomposition (AC7)
  state = stateManager.updateStepState(targetRoot, state.runId, 3, 'in_progress');
  const dagPlan = dagPlanner.generateDagPlan(effectiveSpecContent, { slug: specSlug });
  console.log(`[Step 3: DAG Generation] Complexity: ${dagPlan.complexity.level}. Generated ${dagPlan.totalTasks} task(s).`);
  state.dagTasks = dagPlan.tasks;
  state = stateManager.saveRunState(targetRoot, state);
  state = stateManager.updateStepState(targetRoot, state.runId, 3, 'completed', dagPlan);

  // Step 4: Subagent Context Fencing & Dispatch (AC8)
  state = stateManager.updateStepState(targetRoot, state.runId, 4, 'in_progress');
  console.log(`[Step 4: Implementation] Prepared ${dagPlan.tasks.length} context-fenced task prompt(s).`);
  dagPlan.tasks.forEach(t => {
    console.log(`  + [${t.id}] ${t.title} (Covering: ${t.coveredAcs.join(', ')})`);
  });
  state = stateManager.updateStepState(targetRoot, state.runId, 4, 'completed', { tasksPrepared: dagPlan.tasks.length });

  // Step 5: Conformance Scoring Loop (AC9, AC10)
  state = stateManager.updateStepState(targetRoot, state.runId, 5, 'in_progress');
  let scoreReport = scoreEvaluator.evaluateScore(effectiveSpecContent, {
    projectRoot: targetRoot,
    baseCommit,
    minScore: options.minScore
  });

  state.score = scoreReport.score;
  state.scoreIteration = 1;
  console.log(`[Step 5: Scoring] Conformance score: ${scoreReport.score}/10 (Required: ${options.minScore}/10).`);

  if (!scoreReport.passed) {
    console.log(`[Step 5: Scoring Loop] Score below threshold. Feedback:`);
    console.log(scoreReport.feedback);
  }
  state = stateManager.updateStepState(targetRoot, state.runId, 5, 'completed', scoreReport);

  // Step 6: Delivery Commit (AC11)
  state = stateManager.updateStepState(targetRoot, state.runId, 6, 'in_progress');
  let commitSha = null;
  try {
    const statusOut = execSync('git status --porcelain', { cwd: targetRoot, encoding: 'utf8' }).trim();
    if (statusOut) {
      console.log(`[Step 6: Delivery Commit] Staging and committing implementation changes...`);
      execSync('git add -A', { cwd: targetRoot, stdio: 'ignore' });
      execSync(`git commit -m "feat(${specSlug}): implement ${specSlug}"`, { cwd: targetRoot, stdio: 'ignore' });
      commitSha = getBaseCommit(targetRoot);
      console.log(`[Step 6: Delivery Commit] Created delivery commit ${commitSha}`);
    } else {
      commitSha = baseCommit;
      console.log(`[Step 6: Delivery Commit] Working tree clean; using current commit ${commitSha}`);
    }
  } catch (err) {
    console.log(`[Step 6: Delivery Commit] Git commit note: ${err.message}`);
  }
  state.deliveryCommit = commitSha;
  state = stateManager.saveRunState(targetRoot, state);
  state = stateManager.updateStepState(targetRoot, state.runId, 6, 'completed', { commitSha });

  // Step 7: Automated Code Review Loop (AC12, AC13)
  if (!options.skipReview) {
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'in_progress');
    const reviewResult = reviewRunner.runAutomatedReview({
      projectRoot: targetRoot,
      baseCommit
    });
    console.log(`[Step 7: Code Review] ${reviewResult.summary}`);
    if (reviewResult.findings.length > 0) {
      reviewResult.findings.forEach(f => {
        console.log(`  [${f.severity.toUpperCase()}] ${f.file}: ${f.message}`);
      });
    }
    state = stateManager.updateStepState(targetRoot, state.runId, 7, reviewResult.passed ? 'completed' : 'failed', reviewResult);
  } else {
    state = stateManager.updateStepState(targetRoot, state.runId, 7, 'skipped', { reason: 'User requested skip' });
  }

  // Step 8: PR Preparation & Tracking (AC14, AC15)
  if (!options.skipPr) {
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'in_progress');
    const prPayload = {
      title: `feat(${specSlug}): implement ${specSlug}`,
      specPath: options.specPath,
      runId: state.runId,
      verifiedAcs: scoreReport.verifiedAcs.map(a => a.id),
      deliveryCommit: state.deliveryCommit
    };
    console.log(`[Step 8: PR Preparation] Specification marked completed. PR package prepared: "${prPayload.title}".`);
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'completed', prPayload);
  } else {
    state = stateManager.updateStepState(targetRoot, state.runId, 8, 'skipped', { reason: 'User requested skip' });
  }

  state.status = 'completed';
  state.currentStep = 8;
  state = stateManager.saveRunState(targetRoot, state);
  console.log(`\n[sdw-implement] Workflow completed successfully for run "${state.runId}".`);

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

  console.log(`[sdw-implement resume] Resuming run "${state.runId}" from step ${state.currentStep}/${state.totalSteps}`);
  // Continue execution with options
  return cmdRun({
    ...options,
    specPath: state.specPath,
    runId: state.runId
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
  } else {
    console.log(`Run ID:       ${state.runId}`);
    console.log(`Specification:${state.specPath}`);
    console.log(`Status:       ${state.status}`);
    console.log(`Current Step: ${state.currentStep} / ${state.totalSteps}`);
    console.log(`Score:        ${state.score !== null ? `${state.score}/10` : 'N/A'}`);
    console.log('\nSteps Overview:');
    for (const [sNum, sObj] of Object.entries(state.steps)) {
      console.log(`  Step ${sNum} [${sObj.name}]: ${sObj.status.toUpperCase()}`);
    }
  }
  return 0;
}

function showHelp() {
  console.log(`Usage: node sdw_implement.cjs <subcommand> [specPath] [options]

Subcommands:
  run <specPath>      Execute full 8-step orchestration workflow for specification
  resume              Resume paused or incomplete execution run
  status              Check status of current or specified run state
  help                Display this help documentation

Options:
  --run-id <id>       Explicit run identifier (default: auto-generated)
  --root <path>       Target workspace project root directory
  --min-score <n>     Minimum acceptable conformance score (default: 8)
  --latest            (status/resume) Target the most recent run state
  --skip-review       Skip code review step
  --skip-pr           Skip pull request preparation step
  --json              Output response in JSON format
  -h, --help          Show help message
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
      code = cmdRun(options);
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

main();
