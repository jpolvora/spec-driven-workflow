#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

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

function assertSafeSlug(specSlug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(specSlug))) {
    throw new Error(
      `Invalid specification slug "${specSlug}". Expected lowercase letters, digits, and hyphens (^[a-z0-9][a-z0-9-]*$).`
    );
  }
}

function assertSafeRef(ref, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(String(ref)) || String(ref).includes('..')) {
    throw new Error(`Invalid ${label} branch name "${ref}".`);
  }
}

function safeGit(executor, cmd) {
  try {
    return String(executor(cmd) || '');
  } catch (e) {
    return '';
  }
}

function listBranchCommits(executor, base, head) {
  const out = safeGit(executor, `git log ${base}..${head} --pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad --date=short`).trim();
  if (!out) return [];
  const commits = out.split(/\r?\n/).map((line) => {
    const parts = line.split('\x1f');
    return {
      hash: (parts[0] || '').trim(),
      short: (parts[1] || '').trim(),
      subject: (parts[2] || '').trim(),
      author: (parts[3] || '').trim(),
      date: (parts[4] || '').trim()
    };
  }).filter((c) => c.hash && c.subject);
  if (commits.length > 0) return commits.slice(0, 50);
  return [];
}

function listBranchFiles(executor, base, head) {
  const out = safeGit(executor, `git diff --name-status ${base}...${head}`).trim()
    || safeGit(executor, `git diff --name-only ${base}...${head}`).trim();
  if (!out) return [];
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 100);
}

function getSpecTitle(projectRoot, specSlug) {
  try {
    if (!specSlug) return null;
    const dir = path.join(projectRoot, '.sdw', 'specs');
    if (!fs.existsSync(dir)) return null;
    const normSlug = String(specSlug).replace(/^\d+-/, '');
    const files = fs.readdirSync(dir).filter((f) => f === `${specSlug}.md` || f.replace(/^\d+-/, '').replace(/\.md$/, '') === normSlug);
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).slice(0, 25).join('\n');
      const m = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      if (m && m[1].trim()) return m[1].trim();
    }
  } catch (e) {}
  return null;
}

function buildPrTitle({ explicit, specSlug, specTitle, head, base, commits }) {
  if (explicit) return explicit;
  if (!commits || commits.length === 0) {
    return specSlug ? `feat(${specSlug}): deliver ${specSlug}` : `feat: deliver changes from ${head}`;
  }
  const count = commits.length;
  if (specSlug) {
    const subject = specTitle || specSlug;
    const suffix = count > 1 ? ` (${count} commits)` : '';
    return `feat(${specSlug}): deliver ${subject}${suffix}`.slice(0, 120);
  }
  const first = String(commits[0].subject || '').slice(0, 80);
  const suffix = count > 1 ? ` (+${count - 1} more, ${head}→${base})` : ` (${head}→${base})`;
  return `feat(${head}): ${first}${suffix}`.slice(0, 120);
}

function buildPrBody({ explicit, specSlug, specTitle, head, base, commits, files, config }) {
  if (explicit) return explicit;
  if ((!commits || commits.length === 0) && (!files || files.length === 0)) {
    return specSlug ? `Automated delivery for specification ${specSlug}.` : `Automated delivery pull request.`;
  }
  const lines = [];
  lines.push('## Summary');
  lines.push(`Automated delivery \`${head}\` → \`${base}\`.`);
  if (specSlug) lines.push(`- Spec: \`${specSlug}\`${specTitle ? ` — ${specTitle}` : ''}`);
  lines.push(`- Commits: ${commits.length}`);
  lines.push(`- Files changed: ${files.length}`);
  lines.push('');
  if (commits.length > 0) {
    lines.push('## Commits');
    commits.slice(0, 30).forEach((c) => lines.push(`- \`${c.short}\` ${c.subject} (${c.author}, ${c.date})`));
    if (commits.length > 30) lines.push(`- ... and ${commits.length - 30} more`);
    lines.push('');
    const feats = commits.filter((c) => /^feat(\(|:)/i.test(c.subject));
    const fixes = commits.filter((c) => /^fix(\(|:)/i.test(c.subject));
    const others = commits.filter((c) => !/^(feat|fix)(\(|:)/i.test(c.subject));
    lines.push('## Features');
    if (feats.length > 0) {
      lines.push('### Features');
      feats.slice(0, 20).forEach((c) => lines.push(`- \`${c.short}\` ${c.subject}`));
    }
    if (fixes.length > 0) {
      lines.push('### Fixes');
      fixes.slice(0, 20).forEach((c) => lines.push(`- \`${c.short}\` ${c.subject}`));
    }
    if (others.length > 0) {
      lines.push('### Other');
      others.slice(0, 20).forEach((c) => lines.push(`- \`${c.short}\` ${c.subject}`));
    }
    lines.push('');
  }
  if (files.length > 0) {
    lines.push('## Files changed');
    files.slice(0, 50).forEach((f) => lines.push(`- ${f}`));
    if (files.length > 50) lines.push(`- ... and ${files.length - 50} more`);
    lines.push('');
  }
  lines.push('## Verification');
  if (config.prePrCommand) lines.push(`- prePrCommand: \`${config.prePrCommand}\``);
  if (config.requiredBuild) lines.push(`- Build: \`${config.buildCommand || 'npm run build'}\``);
  if (config.runAllTests) lines.push(`- Tests: \`${config.testCommand || 'npm test'}\``);
  lines.push(`- Security checks: ${config.securityChecksEnabled ? 'enabled' : 'disabled'}`);
  return lines.join('\n');
}

/**
 * Builds the default sdw-fixer CLI command from active review threads.
 * Used when reviewFixCommand is unset (AC13): writes thread-derived findings
 * to a temp file and returns a `sdw_fixer.cjs run` invocation the caller
 * executes through the executor, reusing the existing verify/stage/commit
 * gates. Returns null when the fixer script is absent or threads are empty.
 */
function buildDefaultFixerCommand(projectRoot, activeList) {
  const fixerScript = path.join(projectRoot, 'skills', 'sdw-fixer', 'scripts', 'sdw_fixer.cjs');
  if (!fs.existsSync(fixerScript)) return null;
  const threads = (activeList || []).filter(t => t && !t.isResolved);
  if (threads.length === 0) return null;
  const findings = threads.map(t => {
    const rawPath = typeof t.path === 'string' ? t.path.trim().replace(/\\/g, '/') : '';
    const safe = rawPath && !path.isAbsolute(rawPath) && !/^[A-Za-z]:[\\/]/.test(rawPath) && !rawPath.split('/').includes('..');
    const firstComment = t.comments && t.comments[0] ? String(t.comments[0].body || '') : '';
    const evidence = (firstComment.trim() || 'Review feedback').slice(0, 500) || 'Review feedback';
    return {
      file: safe ? rawPath : 'REVIEW_THREADS.md',
      line: Number.isInteger(t.line) && t.line > 0 ? t.line : 1,
      rule: 'review_thread_feedback',
      evidence,
      severityHint: 'medium'
    };
  });
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fixer-'));
  } catch (e) {
    return null;
  }
  const findingsPath = path.join(dir, 'findings.json');
  const reportPath = path.join(dir, 'result.json');
  try {
    fs.writeFileSync(findingsPath, JSON.stringify({ batchId: `ship-pr-fix-${Date.now()}`, findings }, null, 2), 'utf8');
  } catch (e) {
    return null;
  }
  return { command: `node "${fixerScript}" run --findings "${findingsPath}" --report "${reportPath}"`, findingsPath, reportPath };
}

function resolveStateDir(projectRoot, config = {}) {
  const configured = config.stateDir || '{projectRoot}/.sdw/state';
  let skillsRootVal = typeof config.skillsRoot === 'string' && config.skillsRoot.trim()
    ? config.skillsRoot.replace(/\{projectRoot\}/g, projectRoot)
    : projectRoot;
  if (skillsRootVal.includes('{skillsRoot}')) skillsRootVal = projectRoot;
  const raw = String(configured).replace(/\{projectRoot\}/g, projectRoot).replace(/\{skillsRoot\}/g, skillsRootVal).replace(/\{projectRoot\}/g, projectRoot);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(projectRoot, raw);
}

function listChangedPaths(executor) {
  let out = '';
  try {
    out = String(executor('git status --porcelain -uall') || '');
  } catch (e) {
    return new Set();
  }
  const paths = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let file = line.slice(3).trim();
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4);
    file = file.replace(/^"(.*)"$/, '$1');
    if (file) paths.add(file);
  }
  return paths;
}

function stageChangedSince(executor, before, projectRoot) {
  const after = listChangedPaths(executor);
  const changed = Array.from(after).filter(file => !before.has(file));
  if (changed.length === 0) return [];

  // argv form: filenames are never interpreted by a shell.
  const result = spawnSync('git', ['add', '--', ...changed], { cwd: projectRoot, stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error('Failed to stage the changed files for the scoped commit.');
  }
  return changed;
}

/**
 * Parses CLI arguments
 */
function parseArgs(args) {
  const options = {
    subcommand: null,
    pr: null,
    threadId: null,
    commentId: null,
    comment: null,
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
    pollIntervalMs: 20000,
    maxPreemptions: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'list-threads' || arg === 'resolve-thread' || arg === 'check-status') {
      options.subcommand = arg;
    } else if ((arg === '--pr' || arg === '--pr-number') && args[i + 1]) {
      options.pr = args[++i];
    } else if ((arg === '--thread' || arg === '--thread-id') && args[i + 1]) {
      options.threadId = args[++i];
    } else if (arg === '--comment-id' && args[i + 1]) {
      options.commentId = args[++i];
    } else if (arg === '--comment' && args[i + 1]) {
      options.comment = args[++i];
    } else if (arg === '--run-id' && args[i + 1]) {
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
    } else if (arg === '--merge' || arg === '--allow-merge') {
      options.merge = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--max-iterations' && args[i + 1]) {
      options.maxIterations = parseInt(args[++i], 10) || 3;
    } else if (arg === '--poll-interval' && args[i + 1]) {
      const parsedInterval = parseInt(args[++i], 10);
      options.pollIntervalMs = Number.isFinite(parsedInterval) && parsedInterval >= 0 ? parsedInterval : 20000;
    } else if (arg === '--max-preemptions' && args[i + 1]) {
      const parsedPreemptions = parseInt(args[++i], 10);
      options.maxPreemptions = Number.isFinite(parsedPreemptions) && parsedPreemptions >= 0 ? parsedPreemptions : 3;
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
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    if (sdwConfig && typeof sdwConfig.loadConfig === 'function') {
      const loaded = sdwConfig.loadConfig(projectRoot);
      if (loaded && typeof loaded === 'object') return loaded;
    }
  } catch (e) {}
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
function locateStateFile(projectRoot, runId, specSlug = null, config = {}) {
  if (!runId) return null;
  const stateDir = resolveStateDir(projectRoot, config);
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
  const verificationTimeoutMs = Number(config.verification && config.verification.timeoutMs) > 0
    ? Number(config.verification.timeoutMs)
    : 600000;

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

  const specSlug = options.spec || options.specSlug || null;
  if (specSlug) assertSafeSlug(specSlug);
  assertSafeRef(head, 'head');
  assertSafeRef(base, 'base');
  const specTitle = getSpecTitle(projectRoot, specSlug);
  const branchCommits = listBranchCommits(executor, base, head);
  const branchFiles = listBranchFiles(executor, base, head);
  const title = buildPrTitle({ explicit: options.title, specSlug, specTitle, head, base, commits: branchCommits });
  const body = buildPrBody({
    explicit: options.body, specSlug, specTitle, head, base,
    commits: branchCommits, files: branchFiles, config
  });

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
    // Spec 024 AC26: when merge is requested, an audit record exists from the
    // start, so a delivery that fails before the merge step still explains why
    // no merge happened.
    merge: options.merge
      ? { requested: true, attempted: false, ok: null, reason: 'delivery did not reach merge step' }
      : null,
    reviewConvergence: {
      enabled: scmCodeReviewEnabled,
      converged: false,
      rounds: 0,
      resolvedThreads: 0,
      activeThreads: 0,
      pendingThreads: [],
      failingChecks: [],
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
        const beforePrePr = listChangedPaths(executor);
        try {
          executor(config.prePrCommand, { timeout: verificationTimeoutMs });
        } catch (cmdErr) {
          throw new Error(`prePrCommand failed: ${cmdErr.message}`);
        }

        // Stage only files produced by the command; never sweep unrelated worktree changes.
        try {
          const changed = stageChangedSince(executor, beforePrePr, projectRoot);
          if (changed.length > 0) {
            // Scan the staged pre-PR changes before creating history.
            if (config.securityChecksEnabled) {
              let securityScanner = null;
              try {
                securityScanner = require('../../sdw-security-checks/scripts/sdw_security_checks.cjs');
              } catch (e) {
                securityScanner = null;
              }
              if (!securityScanner || typeof securityScanner.scan !== 'function') {
                throw new Error('Security checks enabled but the sdw-security-checks scanner is unavailable.');
              }
              const scanResult = securityScanner.scan({ root: projectRoot, staged: true });
              if (scanResult.exitCode !== 0) {
                throw new Error(`Security checks failed on pre-PR changes: ${scanResult.message || 'blocking findings detected'}`);
              }
            }

            log(`[sdw-ship-pr] Committing ${changed.length} pre-PR change(s)...`);
            const safeSlug = specSlug && specSlug !== 'unspecified' && /^[a-z0-9][a-z0-9-]*$/.test(specSlug) ? specSlug : null;
            const commitMsg = safeSlug ? `chore(${safeSlug}): apply pre-pr requirements` : 'chore: apply pre-pr requirements';
            const commitRes = spawnSync('git', ['commit', '-m', commitMsg], { cwd: projectRoot, stdio: 'ignore' });
            if (commitRes.status !== 0) {
              throw new Error(`pre-PR commit failed with exit code ${commitRes.status}`);
            }
          }
        } catch (modErr) {
          throw modErr;
        }
      }

      if (config.requiredBuild) {
        const buildCmd = config.buildCommand || (config.verification && config.verification.buildCommand) || 'npm run build';
        log(`[sdw-ship-pr] Running requiredBuild (${buildCmd})...`);
        try {
          executor(buildCmd, { timeout: verificationTimeoutMs });
        } catch (buildErr) {
          throw new Error(`requiredBuild failed: ${buildErr.message}`);
        }
      }

      if (config.runAllTests) {
        const testCmd = config.testCommand || (config.verification && config.verification.testCommand) || 'npm test';
        log(`[sdw-ship-pr] Running runAllTests (${testCmd})...`);
        try {
          executor(testCmd, { timeout: verificationTimeoutMs });
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

    // Check if an active PR is already open for this branch
    let activePrEarly = null;
    let providerEarly = null;
    if (scmProviderName !== 'none' && scmContract) {
      try {
        const capability = scmContract.checkScmCapability(scmProviderName, { executor });
        if (capability.available || dryRun) {
          providerEarly = scmContract.createScmProvider(scmProviderName, { executor });
          if (typeof providerEarly.findActivePullRequest === 'function') {
            activePrEarly = await providerEarly.findActivePullRequest({ head, base });
            if (activePrEarly) {
              log(`[sdw-ship-pr] Active PR #${activePrEarly.number} detected (${activePrEarly.url || 'open'}). Notice: Amending an active pull request while review/approval is pending is not a recommended practice, but adapting as a non-blocking operation: complementing PR with new commits and delivery details.`);
            }
          }
        }
      } catch (e) {}
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
          log(`[sdw-ship-pr] Pushing branch ${head} to remote origin${activePrEarly ? ` (complementing active PR #${activePrEarly.number})` : ''}...`);
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
      const provider = providerEarly || scmContract.createScmProvider(scmProviderName, { executor });

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

      // When an active PR is open/reused, complement the PR and update description if relevant
      if (prResult.reused && prResult.number && typeof provider.updatePullRequest === 'function') {
        const headCommit = safeGit(executor, 'git rev-parse --short HEAD').trim() || 'HEAD';
        const latestList = branchCommits.slice(0, 5).map((c) => `- \`${c.short}\` ${c.subject}`).join('\n');
        const amendmentNote = [
          `### Amending Delivery${specSlug && specSlug !== 'unspecified' ? `: ${specSlug}` : ''}`,
          `- Commit: \`${headCommit}\``,
          `- HEAD: \`${headCommit}\``,
          `- Timestamp: ${new Date().toISOString()}`,
          `- Commits in range \`${base}..${head}\`: ${branchCommits.length}`,
          `- Files changed: ${branchFiles.length}`,
          latestList ? `#### Latest commits\n${latestList}` : null
        ].filter(Boolean).join('\n');
        const newBodyContent = options.body || amendmentNote || body;
        if (newBodyContent || (!options.title && title)) {
          try {
            log(`[sdw-ship-pr] Notice: Amending an active pull request while review/approval is pending is not a recommended practice, but adapting as a non-blocking operation: complementing PR #${prResult.number} description with amending delivery...`);
            await provider.updatePullRequest({
              prNumber: prResult.number,
              title: options.title ? undefined : title,
              body: newBodyContent,
              appendBody: true,
              dryRun
            });
            log(`[sdw-ship-pr] Successfully updated PR description for PR #${prResult.number}.`);
          } catch (editErr) {
            warn(`[sdw-ship-pr] Warning: Could not update description for active PR #${prResult.number}: ${editErr.message}`);
          }
        }
      }

      // Step 4: Post-PR Review Convergence
      if (scmCodeReviewEnabled) {
        log(`[sdw-ship-pr] SCM review convergence enabled for PR #${prResult.number || 'simulate'}.`);
        const maxRounds = options.maxIterations || 3;
        const pollIntervalMs = options.pollIntervalMs === undefined
          ? 20000
          : Math.max(0, Number(options.pollIntervalMs) || 0);
        const reviewFixCommand = options.reviewFixCommand || config.reviewFixCommand || null;
        const testCommand = config.testCommand || (config.verification && config.verification.testCommand) || 'npm test';
        const runReviewSecurityGate = () => {
          if (!config.securityChecksEnabled || dryRun) return;
          let securityScanner = null;
          try {
            securityScanner = require('../../sdw-security-checks/scripts/sdw_security_checks.cjs');
          } catch (e) {
            securityScanner = null;
          }
          if (!securityScanner || typeof securityScanner.scan !== 'function') {
            throw new Error('Security checks enabled but the sdw-security-checks scanner is unavailable.');
          }
          const scanResult = securityScanner.scan({ root: projectRoot, staged: false });
          if (scanResult.exitCode !== 0) {
            throw new Error(`Security checks failed on review fix: ${scanResult.message || 'blocking findings detected'}`);
          }
        };
        let round = 0;
        let converged = false;

        // Concurrent-push adaptation: CI check states observed per round so a
        // superseded run (cancelled by a newer push) is recognized as preemption,
        // not failure. A preempted round grants the replacement run a fresh
        // convergence window instead of burning the iteration budget.
        const FAILED_CHECK_STATES = new Set(['fail', 'failure', 'failed', 'action_required', 'rejected', 'broken', 'timed_out', 'startup_failure']);
        const SUPERSEDED_CHECK_STATES = new Set(['cancelled', 'cancel']);
        const PENDING_CHECK_STATES = new Set(['pending', 'in_progress', 'queued', 'waiting', 'running']);
        const stateOf = c => String(c.state || '').toLowerCase();
        const bucketOf = c => String(c.bucket || '').toLowerCase();
        const isFailedCheck = c => !isSupersededCheck(c) && (FAILED_CHECK_STATES.has(stateOf(c)) || FAILED_CHECK_STATES.has(bucketOf(c)));
        const isSupersededCheck = c => SUPERSEDED_CHECK_STATES.has(stateOf(c)) || SUPERSEDED_CHECK_STATES.has(bucketOf(c));
        const checkClassOf = c => {
          if (isFailedCheck(c)) return 'failed';
          if (isSupersededCheck(c)) return 'superseded';
          if (PENDING_CHECK_STATES.has(stateOf(c)) || PENDING_CHECK_STATES.has(bucketOf(c))) return 'pending';
          return 'passed';
        };
        const maxPreemptions = Number.isFinite(Number(options.maxPreemptions ?? config.maxPreemptions))
          ? Math.max(0, Number(options.maxPreemptions ?? config.maxPreemptions))
          : 3;
        let preemptions = 0;
        let prevCheckClasses = null;
        report.reviewConvergence.preemptions = 0;
        report.reviewConvergence.supersededChecks = [];

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

          const activeList = reviewThreads.threads.filter(t => !t.isResolved);
          const failingChecks = (status.checks || []).filter(isFailedCheck);
          const supersededChecks = (status.checks || []).filter(isSupersededCheck);
          report.reviewConvergence.failingChecks = failingChecks;
          report.reviewConvergence.supersededChecks = supersededChecks;

          // Adaptation: a check that moved from a terminal state back to pending
          // (or a changed check set between rounds) means a newer CI run replaced
          // the observed one, typically after a concurrent push to the head branch.
          // Grant the replacement run a fresh window instead of halting.
          const checkClasses = new Map((status.checks || []).map(c => [c.name, checkClassOf(c)]));
          let preempted = false;
          if (prevCheckClasses && prevCheckClasses.size > 0) {
            if (checkClasses.size !== prevCheckClasses.size) {
              preempted = true;
            } else {
              for (const [name, cls] of checkClasses) {
                const prev = prevCheckClasses.get(name);
                const wasTerminal = prev === 'superseded' || prev === 'failed' || prev === 'passed';
                if (wasTerminal && cls === 'pending') {
                  preempted = true;
                  break;
                }
                if ((prev === 'superseded' || prev === 'failed') && cls === 'passed') {
                  preempted = true;
                  break;
                }
              }
            }
          }
          prevCheckClasses = checkClasses;
          if (preempted) {
            if (preemptions < maxPreemptions) {
              preemptions++;
              report.reviewConvergence.preemptions = preemptions;
              log(`[sdw-ship-pr] Detected superseded CI run replaced by a newer run (preemption ${preemptions}/${maxPreemptions}). Adapting: resetting convergence window.`);
              round = 0;
              if (pollIntervalMs > 0) await new Promise(r => setTimeout(r, pollIntervalMs));
              continue;
            }
            warn(`[sdw-ship-pr] Preemption budget exhausted (${maxPreemptions}); continuing with latest status.`);
          }
          if (supersededChecks.length > 0 && failingChecks.length === 0) {
            log(`[sdw-ship-pr] ${supersededChecks.length} superseded check(s) awaiting replacement run; waiting without treating them as failures.`);
          }

          // Failing CI with no review threads still needs a fixer. Reuse the same
          // test/security/scoped-commit/push gates before polling again.
          if (failingChecks.length > 0 && activeList.length === 0) {
            if (reviewFixCommand) {
              log(`[sdw-ship-pr] ${failingChecks.length} failing check(s); applying reviewFixCommand...`);
              const beforeCheckFix = listChangedPaths(executor);
              executor(reviewFixCommand);
              if (config.runAllTests) executor(testCommand);
              runReviewSecurityGate();
              const changed = stageChangedSince(executor, beforeCheckFix, projectRoot);
              if (changed.length > 0) {
                executor('git commit -m "fix(review): address failing checks"');
                executor(`git push origin ${head}`);
                if (pollIntervalMs > 0) await new Promise(r => setTimeout(r, pollIntervalMs));
                continue;
              }
              warn('[sdw-ship-pr] reviewFixCommand produced no changes for the failing checks.');
            } else if (typeof options.threadFixer === 'function') {
              const fixResult = await options.threadFixer({
                provider,
                prNumber: prResult.number,
                threads: [],
                checks: failingChecks,
                projectRoot,
                executor
              });
              if (fixResult && fixResult.fixed === true) {
                runReviewSecurityGate();
                if (pollIntervalMs > 0) await new Promise(r => setTimeout(r, pollIntervalMs));
                continue;
              }
              warn('[sdw-ship-pr] threadFixer did not confirm a fix for the failing checks.');
            } else {
              warn(`[sdw-ship-pr] ${failingChecks.length} failing check(s) with no configured fixer; leaving them as blockers.`);
            }
          }

          // If active threads exist, resolve them
          if (activeList.length > 0) {
            log(`[sdw-ship-pr] Detected ${activeList.length} active review thread(s).`);

            const pendingThreads = activeList.map(thread => ({
              threadId: thread.id,
              path: thread.path || null,
              line: thread.line || null,
              body: thread.comments && thread.comments[0] ? thread.comments[0].body : 'Review feedback'
            }));

            let fixSummary = 'Applied and verified the requested review fix.';
            let canResolve = false;
            let fixResult = null;
            // Thread feedback has no deterministic patch in the sdw-fixer catalog, so delegating
            // would only produce a skipped, status=no-op result. Fall through to the cooperative protocol.
            const defaultFixer = null;
            const effectiveFixCommand = reviewFixCommand || null;
            if (typeof options.threadFixer === 'function') {
              // The caller owns applying, testing, committing, and pushing the fix.
              fixResult = await options.threadFixer({
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
              runReviewSecurityGate();
              canResolve = true;
            } else if (effectiveFixCommand) {
              log(`[sdw-ship-pr] Applying review fixes via review fix command: ${effectiveFixCommand}`);
              const beforeReviewFix = listChangedPaths(executor);
              executor(effectiveFixCommand);

              if (config.runAllTests) {
                log(`[sdw-ship-pr] Verifying review fixes with test command: ${testCommand}`);
                executor(testCommand);
              }

              runReviewSecurityGate();

              const changed = stageChangedSince(executor, beforeReviewFix, projectRoot);
              if (changed.length === 0) {
                warn('[sdw-ship-pr] reviewFixCommand produced no changes; refusing to resolve review threads.');
                report.reviewConvergence.pendingThreads = pendingThreads;
                break;
              }

              executor('git commit -m "fix(review): address review feedback"');
              executor(`git push origin ${head}`);
              canResolve = true;
            } else {
              warn('[sdw-ship-pr] Active review threads require a code fix. Follow the cooperative review fix protocol:');
              warn('  1. Fetch all threads (list-threads)');
              warn('  2. Analyze root causes & name defect class across the pull request');
              warn('  3. Proactively fix all occurrences in sibling files');
              warn('  4. Verify with test suite (npm test)');
              warn('  5. Stage and commit (git commit -m "fix(review): address review feedback")');
              warn('  6. Push to remote tracking branch (git push origin <head>)');
              warn('  7. Close related threads with resolution comment (resolve-thread)');
              report.reviewConvergence.pendingThreads = pendingThreads;
              // Do not break: the external reviewer or a separate agent may resolve the threads
              // after applying fixes. The loop only observes and never resolves them itself.
            }

            if (canResolve) {
              let commitSha = '';
              try {
                commitSha = executor('git rev-parse --short HEAD').toString().trim();
              } catch (e) {}

              for (const thread of activeList) {
                const perThreadSummary = (fixResult && fixResult.resolutions && fixResult.resolutions[thread.id])
                  || fixSummary;
                const commitLine = commitSha ? `Fixed in commit ${commitSha}.\n\n` : '';
                const summaryNote = `<!-- resolution-reply -->\nResolved review issue: applied fix and verified acceptance criteria.\n\n${commitLine}Summary: ${perThreadSummary}`;

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
            }

            // Re-evaluate checks and review threads after the resolution pass. The pre-fix status
            // snapshot is stale once a commit is pushed.
            const updatedStatus = await provider.checkPrStatus(prResult.number);
            const updatedThreads = await provider.listReviewThreads(prResult.number);
            report.reviewConvergence.activeThreads = updatedThreads.activeCount;
            if (updatedStatus.allPassed && updatedThreads.activeCount === 0) {
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
          const hasActivePr = Boolean(report.pullRequest && (report.pullRequest.url || report.pullRequest.number));
          if (hasActivePr) {
            log(`[sdw-ship-pr] Active PR #${report.pullRequest.number || ''} is in review / awaiting approval. Notice: Amending an active pull request while review/approval is pending is not a recommended practice; adapting non-blocking workflow.`);
            report.nonBlocking = true;
            report.adaptedActivePr = true;
          }
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

    // Step 4.5: Optional merge (opt-in, fire and forget)
    // `--merge` / `--allow-merge` asks the SCM CLI to merge the converged pull
    // request. The outcome is advisory: missing permissions, approvals, or
    // unmet branch rules are outside this skill's contract and must never fail
    // the delivery.
    if (options.merge) {
      const mergePrNumber = report.pullRequest ? report.pullRequest.number : null;
      const convergedOk = Boolean(report.reviewConvergence && report.reviewConvergence.converged);
      report.merge = { requested: true, attempted: false, ok: null, reason: null };

      if (dryRun) {
        report.merge.reason = 'dry-run';
      } else if (mergePrNumber === null || mergePrNumber === undefined) {
        report.merge.reason = 'no pull request';
      } else if (!report.reviewConvergence.enabled) {
        report.merge.reason = 'review convergence disabled';
      } else if (!convergedOk) {
        report.merge.reason = 'review did not converge';
      } else if (scmProviderName === 'none' || !scmContract) {
        report.merge.reason = 'scm provider disabled';
      } else {
        report.merge.attempted = true;
        const mergeStartedAt = Date.now();
        try {
          const mergeProvider = providerEarly || scmContract.createScmProvider(scmProviderName, { executor });
          const mergeResult = await mergeProvider.mergePullRequest({ prNumber: mergePrNumber });
          report.merge.ok = true;
          report.merge.result = mergeResult;
          log(`[sdw-ship-pr] Merge command accepted for PR #${mergePrNumber} (fire and forget).`);
        } catch (mergeErr) {
          report.merge.ok = false;
          report.merge.error = mergeErr.message;
          warn(`[sdw-ship-pr] Merge attempt for PR #${mergePrNumber} did not complete (${mergeErr.message}). Ignored by design: permissions, approvals, and branch rules are outside this skill's contract.`);
        }
        report.merge.durationMs = Date.now() - mergeStartedAt;
      }

      if (report.merge.reason) {
        log(`[sdw-ship-pr] Merge skipped: ${report.merge.reason}.`);
      }
    }

    // Step 5: State Persistence
    if (options.runId) {
      const stateFilePath = locateStateFile(projectRoot, options.runId, specSlug, config);
      if (stateFilePath && fs.existsSync(stateFilePath)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
          if (!stateData.steps) stateData.steps = {};
          
          const hasActivePr = Boolean(report.pullRequest && (report.pullRequest.url || report.pullRequest.number));
          const isStepCompleted = report.success || (hasActivePr && report.shipStatus === 'review_pending');
          const existingStep8 = stateData.steps[8] || {};
          stateData.steps[8] = {
            step: 8,
            name: 'pr_preparation',
            status: isStepCompleted ? 'completed' : 'failed',
            timestamp: new Date().toISOString(),
            artifact: existingStep8.artifact !== undefined ? existingStep8.artifact : null,
            output: {
              ...(existingStep8.output || {}),
              pullRequest: report.pullRequest,
              shipStatus: report.shipStatus,
              nonBlocking: Boolean(report.nonBlocking),
              adaptedActivePr: Boolean(report.adaptedActivePr),
              pushedBranch: report.pushed ? head : null,
              merge: report.merge || null,
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
    // Expose the partial report (including the merge audit record) to callers.
    err.report = report;

    if (options.runId) {
      const stateFilePath = locateStateFile(projectRoot, options.runId, specSlug, config);
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

/**
 * Lists review threads for a pull request
 */
async function cmdListThreads(options, customExecutor) {
  const projectRoot = options.projectRoot || process.cwd();
  const config = loadConfig(projectRoot);
  const prNumber = options.pr || options.prNumber;
  if (!prNumber) {
    throw new Error('--pr <prNumber> is required for list-threads.');
  }
  const providerName = options.provider || config.scmProvider || 'github';
  const provider = (scmContract && scmContract.createScmProvider)
    ? scmContract.createScmProvider(providerName, { cwd: projectRoot, executor: customExecutor })
    : null;
  if (!provider) {
    throw new Error(`SCM provider contract is not available for provider: ${providerName}`);
  }
  return await provider.listReviewThreads(prNumber);
}

/**
 * Resolves a review thread on a pull request with an explanatory comment
 */
async function cmdResolveThread(options, customExecutor) {
  const projectRoot = options.projectRoot || process.cwd();
  const config = loadConfig(projectRoot);
  const prNumber = options.pr || options.prNumber;
  const threadId = options.threadId || options.thread;
  const comment = options.comment;
  if (!prNumber) throw new Error('--pr <prNumber> is required for resolve-thread.');
  if (!threadId) throw new Error('--thread <threadId> is required for resolve-thread.');
  if (scmContract && scmContract.assertResolutionComment) {
    scmContract.assertResolutionComment(comment);
  } else {
    const normalized = String(comment || '')
      .replace(/<!--\s*resolution-reply\s*-->/gi, '')
      .replace(/^[\s`'"]+|[\s`'"]+$/g, '')
      .trim();
    if (!normalized || /^[0-9a-f]{4,64}$/i.test(normalized)) {
      throw new Error('A resolution comment must explain the fix and cannot be empty or a bare commit hash.');
    }
  }

  const providerName = options.provider || config.scmProvider || 'github';
  const provider = (scmContract && scmContract.createScmProvider)
    ? scmContract.createScmProvider(providerName, { cwd: projectRoot, executor: customExecutor })
    : null;
  if (!provider) {
    throw new Error(`SCM provider contract is not available for provider: ${providerName}`);
  }

  // Format comment with resolution reply marker if not already present
  const formattedComment = comment.includes('<!-- resolution-reply -->')
    ? comment
    : `<!-- resolution-reply -->\n${comment}`;

  return await provider.resolveReviewThread({
    prNumber,
    threadId,
    commentId: options.commentId || null,
    comment: formattedComment,
    model: options.model || 'sdw-ship-pr',
    dryRun: Boolean(options.dryRun)
  });
}

/**
 * Checks CI check runs and review status for a pull request
 */
async function cmdCheckStatus(options, customExecutor) {
  const projectRoot = options.projectRoot || process.cwd();
  const config = loadConfig(projectRoot);
  const prNumber = options.pr || options.prNumber;
  if (!prNumber) throw new Error('--pr <prNumber> is required for check-status.');

  const providerName = options.provider || config.scmProvider || 'github';
  const provider = (scmContract && scmContract.createScmProvider)
    ? scmContract.createScmProvider(providerName, { cwd: projectRoot, executor: customExecutor })
    : null;
  if (!provider) {
    throw new Error(`SCM provider contract is not available for provider: ${providerName}`);
  }
  return await provider.checkPrStatus(prNumber);
}

// CLI Execution entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  let runnerPromise;
  if (options.subcommand === 'list-threads') {
    runnerPromise = cmdListThreads(options);
  } else if (options.subcommand === 'resolve-thread') {
    runnerPromise = cmdResolveThread(options);
  } else if (options.subcommand === 'check-status') {
    runnerPromise = cmdCheckStatus(options);
  } else {
    runnerPromise = runShipPr(options);
  }

  runnerPromise
    .then(result => {
      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (options.subcommand === 'list-threads') {
        console.log(`\n[sdw-ship-pr] PR #${options.pr} Review Threads (${result.activeCount} active, ${result.totalCount} total):`);
        for (const t of result.threads) {
          const status = t.isResolved ? 'RESOLVED' : 'ACTIVE';
          const fileLoc = t.path ? ` [${t.path}:${t.line || 1}]` : '';
          const snippet = t.comments && t.comments[0] ? t.comments[0].body.split('\n')[0].slice(0, 80) : '';
          console.log(`  - [${status}] Thread ${t.id}${fileLoc}: ${snippet}`);
        }
      } else if (options.subcommand === 'resolve-thread') {
        console.log(`\n[sdw-ship-pr] Resolved thread ${options.threadId} on PR #${options.pr}:`);
        console.log(`  Status: ${result.resolved ? 'Resolved' : 'Pending'}`);
      } else if (options.subcommand === 'check-status') {
        console.log(`\n[sdw-ship-pr] PR #${options.pr} Status:`);
        console.log(`  All passed: ${result.allPassed}`);
        console.log(`  State:      ${result.state}`);
      } else {
        console.log('\n[sdw-ship-pr] Delivery Complete:');
        console.log(`  Status:       ${result.shipStatus}`);
        console.log(`  Head:         ${result.head}`);
        console.log(`  Base:         ${result.base}`);
        console.log(`  SCM Provider: ${result.scmProvider}`);
        if (result.pullRequest && result.pullRequest.url) {
          console.log(`  PR URL:       ${result.pullRequest.url}`);
        }
      }
      const hasActivePr = Boolean(result && result.pullRequest && (result.pullRequest.url || result.pullRequest.number));
      const ok = options.subcommand === 'check-status'
        ? Boolean(result && result.allPassed === true)
        : Boolean(result && (result.success !== false || (hasActivePr && result.shipStatus === 'review_pending')) && result.resolved !== false);
      process.exit(ok ? 0 : 1);
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
  locateStateFile,
  cmdListThreads,
  cmdResolveThread,
  cmdCheckStatus,
  listBranchCommits,
  listBranchFiles,
  getSpecTitle,
  buildPrTitle,
  buildPrBody,
  buildDefaultFixerCommand
};
