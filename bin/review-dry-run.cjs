'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REVIEWER_BASE_URL = 'https://raw.githubusercontent.com/jpolvora/agentic-code-reviewers';
const REVIEWER_DEFAULT_REF = 'release';
const DEFAULT_ENGINE = 'opencode';
const DEFAULT_MODEL = 'opencode-go/claude-haiku-5-5';
const DEFAULT_VARIANT = 'medium';
const DEFAULT_TIMEOUT_MS = '1200000';
const DEFAULT_MAX_ROUNDS = '20';
const DEFAULT_TARGET_BRANCH = 'refs/heads/master';
const PINNED_OPENCODE_VERSION = '1.19.1';
const EXTRA_EXCLUDES = '.sdw/state/**';
const INCLUDE_PATTERNS = '**/*.md,**/*.yml,**/*.yaml,**/*.json,**/*.js,**/*.ts,**/*.cjs,**/*.sh';
const SCORE_MIN = '5';
const REPO_ROOT = path.resolve(__dirname, '..');

function resolveReviewerConfig(env = process.env) {
  const requestedEngine = String(env.AGENTIC_CODE_REVIEWERS_ENGINE || DEFAULT_ENGINE).trim() || DEFAULT_ENGINE;
  const engine = requestedEngine === 'cursor' || requestedEngine === 'cursor-sdk' ? 'cursor-sdk' : DEFAULT_ENGINE;
  const model = String(env.AGENTIC_CODE_REVIEWERS_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const variant = String(env.AGENTIC_CODE_REVIEWERS_VARIANT || DEFAULT_VARIANT).trim() || DEFAULT_VARIANT;
  const targetBranch =
    String(env.AGENTIC_CODE_REVIEWERS_TARGET_BRANCH || DEFAULT_TARGET_BRANCH).trim() || DEFAULT_TARGET_BRANCH;
  const ref = String(env.AGENTIC_CODE_REVIEWERS_REF || REVIEWER_DEFAULT_REF).trim() || REVIEWER_DEFAULT_REF;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) {
    throw new Error(`Invalid AGENTIC_CODE_REVIEWERS_REF: "${ref}".`);
  }
  const sha256 = String(env.AGENTIC_CODE_REVIEWERS_SHA256 || '').trim();
  const credential = engine === 'cursor-sdk' ? 'CURSOR_API_KEY' : 'OPENCODE_API_KEY';
  if (!String(env[credential] || '').trim()) {
    throw new Error(`${credential} is required for reviewer engine ${engine}`);
  }
  return { requestedEngine, engine, model, variant, targetBranch, ref, sha256 };
}

function resolveReviewerUrl(config) {
  return `${REVIEWER_BASE_URL}/${config.ref}/run.sh`;
}

function buildReviewerArgs(config) {
  return [
    '--engine', config.engine,
    '--model', config.model,
    '--variant', config.variant,
    '--dry-run',
    '--stack', 'Custom',
    '--target-branch', config.targetBranch,
    '--custom-prompt', '.github/agentic-code-reviewers-prompt.md',
    '--score-min', SCORE_MIN,
    '--include-patterns', INCLUDE_PATTERNS,
  ];
}

function readVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim().replace(/^v/, '');
}

function resolvePinnedOpencode(env = process.env) {
  const explicit = String(env.AGENTIC_CODE_REVIEWERS_OPENCODE_BIN || '').trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`AGENTIC_CODE_REVIEWERS_OPENCODE_BIN does not exist: ${explicit}`);
    }
    return { bin: explicit, shimDir: null, version: readVersion(explicit) };
  }

  let packagePath;
  try {
    packagePath = require.resolve('opencode-ai/package.json');
  } catch {
    throw new Error('opencode-ai is not installed. Run `npm install` before `npm run review:dry`.');
  }

  const bin = path.join(path.dirname(packagePath), 'bin', 'opencode.exe');
  if (!fs.existsSync(bin)) {
    throw new Error(`Pinned OpenCode binary not found at ${bin}. Run \`npm install\` again.`);
  }

  const version = readVersion(bin);
  if (version !== PINNED_OPENCODE_VERSION) {
    throw new Error(
      `Expected OpenCode ${PINNED_OPENCODE_VERSION}, found ${version || 'unknown'}. ` +
        'Run `npm install` or set AGENTIC_CODE_REVIEWERS_OPENCODE_BIN explicitly.',
    );
  }

  return { bin, shimDir: ensureOpencodeShim(bin), version };
}

function ensureOpencodeShim(bin) {
  const shimDir = path.join(REPO_ROOT, 'node_modules', '.cache', `sdw-opencode-${PINNED_OPENCODE_VERSION}`, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });

  if (process.platform === 'win32') {
    const shim = path.join(shimDir, 'opencode.exe');
    if (!fs.existsSync(shim)) {
      try {
        fs.linkSync(bin, shim);
      } catch {
        fs.copyFileSync(bin, shim);
      }
    }
    return shimDir;
  }

  const shim = path.join(shimDir, 'opencode');
  if (!fs.existsSync(shim)) {
    fs.symlinkSync(path.relative(shimDir, bin), shim);
  }
  return shimDir;
}

function buildReviewerEnv(config, pinned, env = process.env) {
  const next = {
    ...env,
    AGENTIC_CODE_REVIEWERS_EXTRA_EXCLUDE_PATTERNS: EXTRA_EXCLUDES,
    AGENTIC_CODE_REVIEWERS_TIMEOUT_MS:
      String(env.AGENTIC_CODE_REVIEWERS_TIMEOUT_MS || '').trim() || DEFAULT_TIMEOUT_MS,
    AGENTIC_CODE_REVIEWERS_MAX_ROUNDS:
      String(env.AGENTIC_CODE_REVIEWERS_MAX_ROUNDS || '').trim() || DEFAULT_MAX_ROUNDS,
  };
  if (pinned) {
    next.AGENTIC_CODE_REVIEWERS_OPENCODE_BIN = pinned.bin;
    if (pinned.shimDir) {
      next.PATH = `${pinned.shimDir}${path.delimiter}${env.PATH || ''}`;
    }
  }
  return next;
}

function run() {
  const config = resolveReviewerConfig();
  const pinned = config.engine === 'opencode' ? resolvePinnedOpencode() : null;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-review-'));
  const runnerPath = path.join(tempRoot, 'run.sh');
  try {
    const reviewerUrl = resolveReviewerUrl(config);
    const download = spawnSync('curl', ['-fsSL', reviewerUrl, '-o', runnerPath], { stdio: 'inherit' });
    if (download.error) throw download.error;
    if (download.status !== 0) return download.status || 1;
    if (config.sha256) {
      const crypto = require('crypto');
      const digest = crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex');
      if (digest !== config.sha256.toLowerCase()) {
        throw new Error(`Reviewer script checksum mismatch for ref "${config.ref}".`);
      }
    }

    if (pinned) {
      process.stdout.write(`Reviewer engine: ${config.engine} (OpenCode ${pinned.version})\n`);
      process.stdout.write(`Reviewer model:  ${config.model} (variant: ${config.variant})\n`);
    }

    const review = spawnSync('bash', [runnerPath, ...buildReviewerArgs(config)], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: buildReviewerEnv(config, pinned),
    });
    if (review.error) throw review.error;
    return review.status || 0;
  } finally {
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true });
  }
}

module.exports = {
  buildReviewerArgs,
  buildReviewerEnv,
  resolveReviewerConfig,
  resolveReviewerUrl,
  resolvePinnedOpencode,
  run,
};

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
