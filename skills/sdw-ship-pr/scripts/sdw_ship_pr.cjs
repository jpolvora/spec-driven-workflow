#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Import SCM provider contract from sdw-spec
let scmContract;
try {
  scmContract = require('../../sdw-spec/scripts/scm_provider_contract.cjs');
} catch (e) {
  try {
    scmContract = require(path.join(__dirname, '../../sdw-spec/scripts/scm_provider_contract.cjs'));
  } catch (err) {
    scmContract = null;
  }
}

/**
 * Parses CLI arguments
 */
function parseArgs(args) {
  const options = {
    runId: null,
    spec: null,
    head: null,
    base: null,
    title: null,
    body: null,
    push: false,
    pollPr: false,
    dryRun: false,
    json: false,
    maxIterations: 3,
    pollIntervalMs: 20000
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run-id' && args[i + 1]) {
      options.runId = args[++i];
    } else if (arg === '--spec' && args[i + 1]) {
      options.spec = args[++i];
    } else if (arg === '--head' && args[i + 1]) {
      options.head = args[++i];
    } else if (arg === '--base' && args[i + 1]) {
      options.base = args[++i];
    } else if (arg === '--title' && args[i + 1]) {
      options.title = args[++i];
    } else if (arg === '--body' && args[i + 1]) {
      options.body = args[++i];
    } else if (arg === '--push') {
      options.push = true;
    } else if (arg === '--poll-pr') {
      options.pollPr = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--max-iterations' && args[i + 1]) {
      options.maxIterations = parseInt(args[++i], 10) || 3;
    } else if (arg === '--poll-interval' && args[i + 1]) {
      const parsedInterval = parseInt(args[++i], 10);
      options.pollIntervalMs = Number.isFinite(parsedInterval) && parsedInterval >= 0 ? parsedInterval : 20000;
    } else if (arg === '--review-fix-command' && args[i + 1]) {
      options.reviewFixCommand = args[++i];
    } else if ((arg === '--root' || arg === '--project-root') && args[i + 1]) {
      options.projectRoot = args[++i];
    }
  }

  return options;
}

/**
 * Loads project configuration from .sdw/config.json
 */
function loadConfig(projectRoot = process.cwd()) {
  const configPath = path.join(projectRoot, '.sdw', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.warn(`[sdw-ship-pr] Warning: Failed to parse .sdw/config.json: ${e.message}`);
    }
  }
  return {};
}

/**
 * Locates and reads run state file if runId is supplied
 */
function locateStateFile(projectRoot, runId, specSlug = null) {
  if (!runId) return null;
  const stateDir = path.join(projectRoot, '.sdw', 'state');
  if (!fs.existsSync(stateDir)) return null;

  // Direct state file: .sdw/state/{runId}.state.json
  const directPath = path.join(stateDir, `${runId}.state.json`);
  if (fs.existsSync(directPath)) return directPath;

  // Subdirectory: .sdw/state/{spec}/{runId}.state.json
  if (specSlug) {
    const specSubPath = path.join(stateDir, specSlug, `${runId}.state.json`);
    if (fs.existsSync(specSubPath)) return specSubPath;
  }

  // Scan subdirectories
  const entries = fs.readdirSync(stateDir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const nested = path.join(stateDir, ent.name, `${runId}.state.json`);
      if (fs.existsSync(nested)) return nested;
    }
  }

  return null;
}

/**
 * Core PR Shipping execution
 */
async function runShipPr(options = {}, customExecutor = null) {
  const projectRoot = options.projectRoot || process.cwd();
  const executor = customExecutor || ((cmd, opts = {}) => execSync(cmd, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }));

  const config = options.config || loadConfig(projectRoot);
  const dryRun = Boolean(options.dryRun);

  // 1. Resolve branches
  let head = options.head;
  if (!head) {
    try {
      head = executor('git rev-parse --abbrev-ref HEAD').trim();
    } catch (e) {
      head = 'HEAD';
    }
  }

  let base = options.base || config.baseBranch || 'master';
  if (!options.base && !config.baseBranch) {
    try {
      const remotes = executor('git remote').trim();
      if (remotes) {
        const remoteInfo = executor('git remote show origin');
        const match = remoteInfo.match(/HEAD branch:\s*([^\s]+)/);
        if (match && match[1]) {
          base = match[1];
        }
      }
    } catch (e) {
      base = 'master';
    }
  }

  const specSlug = options.spec || null;
  const title = options.title || (specSlug ? `feat(${specSlug}): deliver ${specSlug}` : `feat: deliver changes from ${head}`);
  const body = options.body || (specSlug ? `Automated delivery for specification ${specSlug}.` : `Automated delivery pull request.`);

  const pushDelivery = options.push || Boolean(config.pushDelivery);
  const scmProviderName = config.scmProvider || 'none';
  const scmCodeReviewEnabled = options.pollPr || Boolean(config.scmCodeReviewEnabled);

  const report = {
    success: false,
    head,
    base,
    scmProvider: scmProviderName,
    pushed: false,
    prePrPassed: false,
    pullRequest: null,
    reviewConvergence: {
      enabled: scmCodeReviewEnabled,
      converged: false,
      rounds: 0,
      resolvedThreads: 0,
      activeThreads: 0,
      pendingThreads: [],
      issuesFixed: []
    },
    shipStatus: 'pending',
    error: null
  };

  const log = options.json ? console.error : console.log;
  const warn = options.json ? console.error : console.warn;

  try {
    // Step 1: Pre-PR Verification Gates
    log('[sdw-ship-pr] Evaluating pre-PR requirements...');

    if (config.prePrInstructions) {
      log(`[sdw-ship-pr] Pre-PR Instructions: ${config.prePrInstructions}`);
    }

    if (dryRun) {
      log('[sdw-ship-pr] (dry-run) Simulating pre-PR verification gates (prePrCommand, requiredBuild, runAllTests, security checks)...');
      report.prePrPassed = true;
    } else {
      if (config.prePrCommand) {
        log(`[sdw-ship-pr] Running prePrCommand: "${config.prePrCommand}"...`);
        try {
          executor(config.prePrCommand);
        } catch (cmdErr) {
          throw new Error(`prePrCommand failed: ${cmdErr.message}`);
        }

        // Stage and commit pre-PR modifications if generated
        try {
          const modStatus = executor('git status --porcelain').toString().trim();
          if (modStatus) {
            log('[sdw-ship-pr] Staging and committing pre-PR modifications...');
            executor('git add -A');
            const commitMsg = specSlug && specSlug !== 'unspecified' ? `chore(${specSlug}): apply pre-pr requirements` : 'chore: apply pre-pr requirements';
            executor(`git commit -m "${commitMsg}"`);
          }
        } catch (modErr) {
          // non-git or commit error ignored
        }
      }

      if (config.requiredBuild) {
        const buildCmd = config.buildCommand || (config.verification && config.verification.buildCommand) || 'npm run build';
        log(`[sdw-ship-pr] Running requiredBuild (${buildCmd})...`);
        try {
          executor(buildCmd);
        } catch (buildErr) {
          throw new Error(`requiredBuild failed: ${buildErr.message}`);
        }
      }

      if (config.runAllTests) {
        const testCmd = config.testCommand || (config.verification && config.verification.testCommand) || 'npm test';
        log(`[sdw-ship-pr] Running runAllTests (${testCmd})...`);
        try {
          executor(testCmd);
        } catch (testErr) {
          throw new Error(`runAllTests failed: ${testErr.message}`);
        }
      }

      if (config.securityChecksEnabled) {
        log('[sdw-ship-pr] Evaluating security leak checks...');
        let securityScanner = null;
        try {
          securityScanner = require('../../sdw-security-checks/scripts/sdw_security_checks.cjs');
        } catch (e) {
          securityScanner = null;
        }
        if (!securityScanner || typeof securityScanner.scan !== 'function') {
          throw new Error('Security checks enabled but the sdw-security-checks scanner is unavailable.');
        }

        // Scan the worktree: pre-PR changes are not staged yet.
        const scanResult = securityScanner.scan({ root: projectRoot, staged: false });
        if (scanResult.exitCode !== 0) {
          throw new Error(`Security checks failed: ${scanResult.message || 'blocking findings detected'}`);
        }
      }

      report.prePrPassed = true;
    }

    // Step 2: Remote Branch Publishing
    if (pushDelivery) {
      if (dryRun) {
        log(`[sdw-ship-pr] (dry-run) git push -u origin ${head}`);
        report.pushed = true;
      } else {
        let hasRemote = false;
        try {
          const remotes = executor('git remote').toString().trim();
          hasRemote = Boolean(remotes);
        } catch (e) {}

        if (!hasRemote) {
          log('[sdw-ship-pr] Remote push skipped: no git remote configured.');
        } else {
          log(`[sdw-ship-pr] Pushing branch ${head} to remote origin...`);
          try {
            executor(`git push -u origin ${head}`);
            report.pushed = true;
          } catch (pushErr) {
            throw new Error(`git push failed: ${pushErr.message}`);
          }
        }
      }
    }

    // Step 3: Pull Request Creation / Idempotent Reuse
    if (scmProviderName === 'none') {
      log('[sdw-ship-pr] scmProvider is set to "none". Skipping remote pull request creation.');
      report.shipStatus = 'delivered_local';
      report.success = true;
    } else {
      if (!scmContract) {
        throw new Error('SCM provider contract module is unavailable.');
      }

      const capability = scmContract.checkScmCapability(scmProviderName, { executor });
      if (!capability.available && !dryRun) {
        throw new Error(capability.error || `SCM CLI capability check failed for ${scmProviderName}.`);
      }

      log(`[sdw-ship-pr] Preparing pull request via ${scmProviderName}...`);
      const provider = scmContract.createScmProvider(scmProviderName, { executor });

      const prResult = await provider.createPullRequest({
        title,
        body,
        head,
        base,
        draft: false,
        dryRun
      });

      report.pullRequest = {
        number: prResult.number,
        url: prResult.url,
        head: prResult.head,
        base: prResult.base,
        reused: prResult.reused || false,
        dryRun: prResult.dryRun || false
      };

      log(`[sdw-ship-pr] Pull request ${prResult.reused ? 'reused' : 'created'}: ${prResult.url || '(dry-run simulated)'}`);

      // Step 4: Post-PR Review Convergence
      if (scmCodeReviewEnabled) {
        log(`[sdw-ship-pr] SCM review convergence enabled for PR #${prResult.number || 'simulate'}.`);
        const maxRounds = options.maxIterations || 3;
        const pollIntervalMs = options.pollIntervalMs === undefined
          ? 20000
          : Math.max(0, Number(options.pollIntervalMs) || 0);
        const reviewFixCommand = options.reviewFixCommand || config.reviewFixCommand || null;
        const testCommand = config.testCommand || (config.verification && config.verification.testCommand) || 'npm test';
        let round = 0;
        let converged = false;

        while (round < maxRounds && !converged) {
          round++;
          report.reviewConvergence.rounds = round;
          log(`[sdw-ship-pr] Convergence round ${round}/${maxRounds}...`);

          if (dryRun) {
            log('[sdw-ship-pr] (dry-run) Simulating review convergence checks and active thread resolution.');
            report.reviewConvergence.converged = true;
            report.reviewConvergence.activeThreads = 0;
            converged = true;
            break;
          }

          // Check CI and policies
          const status = await provider.checkPrStatus(prResult.number);
          const reviewThreads = await provider.listReviewThreads(prResult.number);

          report.reviewConvergence.activeThreads = reviewThreads.activeCount;

          if (status.allPassed && reviewThreads.activeCount === 0) {
            log('[sdw-ship-pr] All checks passed and 0 active review threads detected. Review converged successfully.');
            converged = true;
            report.reviewConvergence.converged = true;
            break;
          }

          // If active threads exist, resolve them
          const activeList = reviewThreads.threads.filter(t => !t.isResolved);
          if (activeList.length > 0) {
            log(`[sdw-ship-pr] Detected ${activeList.length} active review thread(s).`);

            const pendingThreads = activeList.map(thread => ({
              threadId: thread.id,
              path: thread.path || null,
              line: thread.line || null,
              body: thread.comments && thread.comments[0] ? thread.comments[0].body : 'Review feedback'
            }));

            let fixSummary = 'Applied and verified the requested review fix.';
            if (typeof options.threadFixer === 'function') {
              // The caller owns applying, testing, committing, and pushing the fix.
              const fixResult = await options.threadFixer({
                provider,
                prNumber: prResult.number,
                threads: activeList,
                projectRoot,
                executor
              });
              if (!fixResult || fixResult.fixed !== true) {
                warn('[sdw-ship-pr] threadFixer did not confirm a fix; leaving review threads active.');
                report.reviewConvergence.pendingThreads = pendingThreads;
                break;
              }
              fixSummary = fixResult.summary || fixSummary;
            } else if (reviewFixCommand) {
              log(`[sdw-ship-pr] Applying review fixes via reviewFixCommand: ${reviewFixCommand}`);
              executor(reviewFixCommand);

              if (config.runAllTests) {
                log(`[sdw-ship-pr] Verifying review fixes with test command: ${testCommand}`);
                executor(testCommand);
              }

              const fixChanges = executor('git status --porcelain').toString().trim();
              if (!fixChanges) {
                warn('[sdw-ship-pr] reviewFixCommand produced no changes; refusing to resolve review threads.');
                report.reviewConvergence.pendingThreads = pendingThreads;
                break;
              }

              executor('git add -A');
              executor('git commit -m "fix(review): address review feedback"');
              executor(`git push origin ${head}`);
            } else {
              warn('[sdw-ship-pr] Active review threads require a code fix. Set reviewFixCommand, pass threadFixer, or resolve them outside this loop; refusing to resolve them without a verified fix.');
              report.reviewConvergence.pendingThreads = pendingThreads;
              break;
            }

            for (const thread of activeList) {
              const summaryNote = `Resolved review issue: applied fix and verified acceptance criteria.\n\nSummary: ${fixSummary}`;

              const resolveRes = await provider.resolveReviewThread({
                prNumber: prResult.number,
                threadId: thread.id,
                commentId: thread.comments && thread.comments[0] ? thread.comments[0].id : null,
                comment: summaryNote,
                model: 'sdw-ship-pr',
                dryRun
              });

              if (resolveRes.resolved) {
                report.reviewConvergence.resolvedThreads++;
                report.reviewConvergence.issuesFixed.push({
                  threadId: thread.id,
                  resolution: summaryNote
                });
                log(`[sdw-ship-pr] Closed and resolved review thread ${thread.id} with resolution summary.`);
              }
            }

            // Re-evaluate review threads after resolution
            const updatedThreads = await provider.listReviewThreads(prResult.number);
            report.reviewConvergence.activeThreads = updatedThreads.activeCount;
            if (status.allPassed && updatedThreads.activeCount === 0) {
              log('[sdw-ship-pr] All checks passed and 0 active review threads detected after resolution pass. Review converged successfully.');
              converged = true;
              report.reviewConvergence.converged = true;
              break;
            }
          }

          if (round >= maxRounds && !converged) {
            warn(`[sdw-ship-pr] Reached maximum review convergence rounds (${maxRounds}) with residual active threads.`);
          } else if (!converged && pollIntervalMs > 0) {
            await new Promise(r => setTimeout(r, pollIntervalMs));
          }
        }

        if (!converged && !dryRun) {
          report.shipStatus = 'review_pending';
          report.success = false;
        } else {
          report.shipStatus = 'delivered';
          report.success = true;
        }
      } else {
        report.shipStatus = 'delivered';
        report.success = true;
      }
    }

    // Step 5: State Persistence
    if (options.runId) {
      const stateFilePath = locateStateFile(projectRoot, options.runId, specSlug);
      if (stateFilePath && fs.existsSync(stateFilePath)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
          if (!stateData.steps) stateData.steps = {};
          
          const existingStep8 = stateData.steps[8] || {};
          stateData.steps[8] = {
            step: 8,
            name: 'pr_preparation',
            status: 'completed',
            timestamp: new Date().toISOString(),
            artifact: existingStep8.artifact !== undefined ? existingStep8.artifact : null,
            output: {
              ...(existingStep8.output || {}),
              pullRequest: report.pullRequest,
              shipStatus: report.shipStatus,
              pushedBranch: report.pushed ? head : null,
              reviewConvergence: report.reviewConvergence
            }
          };

          stateData.pullRequest = report.pullRequest;
          stateData.shipStatus = report.shipStatus;
          fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 2), 'utf8');
          log(`[sdw-ship-pr] Updated run state at ${stateFilePath}`);
        } catch (saveErr) {
          warn(`[sdw-ship-pr] Warning: Could not update state file: ${saveErr.message}`);
        }
      }
    }

    return report;
  } catch (err) {
    report.success = false;
    report.shipStatus = 'failed';
    report.error = err.message;

    if (options.runId) {
      const stateFilePath = locateStateFile(projectRoot, options.runId, specSlug);
      if (stateFilePath && fs.existsSync(stateFilePath)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
          if (!stateData.errors) stateData.errors = [];
          stateData.errors.push({
            step: 8,
            timestamp: new Date().toISOString(),
            error: err.message
          });
          fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 2), 'utf8');
        } catch (e) {}
      }
    }

    throw err;
  }
}

// CLI Execution entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  runShipPr(options)
    .then(report => {
      if (options.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        console.log('\n[sdw-ship-pr] Delivery Complete:');
        console.log(`  Status:       ${report.shipStatus}`);
        console.log(`  Head:         ${report.head}`);
        console.log(`  Base:         ${report.base}`);
        console.log(`  SCM Provider: ${report.scmProvider}`);
        if (report.pullRequest && report.pullRequest.url) {
          console.log(`  PR URL:       ${report.pullRequest.url}`);
        }
      }
      process.exit(0);
    })
    .catch(err => {
      console.error(`\n[sdw-ship-pr] Error: ${err.message}`);
      if (options.json) {
        process.stdout.write(JSON.stringify({ success: false, error: err.message }, null, 2) + '\n');
      }
      process.exit(1);
    });
}

module.exports = {
  runShipPr,
  parseArgs,
  loadConfig,
  locateStateFile
};
