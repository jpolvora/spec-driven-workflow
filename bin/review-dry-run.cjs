'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REVIEWER_URL = 'https://raw.githubusercontent.com/jpolvora/agentic-code-reviewers/release/run.sh';
const DEFAULT_ENGINE = 'opencode';
const DEFAULT_MODEL = 'opencode-go/deepseek-v4.1-flash';
const DEFAULT_VARIANT = 'medium';
const DEFAULT_TIMEOUT_MS = '1200000';
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
  const credential = engine === 'cursor-sdk' ? 'CURSOR_API_KEY' : 'OPENCODE_API_KEY';
  if (!String(env[credential] || '').trim()) {
    throw new Error(`${credential} is required for reviewer engine ${engine}`);
  }
  return { requestedEngine, engine, model, variant, targetBranch };
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
    const download = spawnSync('curl', ['-fsSL', REVIEWER_URL, '-o', runnerPath], { stdio: 'inherit' });
    if (download.error) throw download.error;
    if (download.status !== 0) return download.status || 1;

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
