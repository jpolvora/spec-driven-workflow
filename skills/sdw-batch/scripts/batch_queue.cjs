'use strict';

// sdw-batch queue: iterates a specification list and delegates each item to
// sdw-orch as one independent single-specification run. This module owns the
// manifest and the loop; it never duplicates orchestrator step logic.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Batch delegation is unattended and never passes --abort-on-gaps, so the pause
// codes sdw-orch can return here are dispatch (4), judgment (5), and delivery
// convergence (6). Every other non-zero code is a failure.
const PAUSE_STATUS = {
  4: 'awaiting_implementation',
  5: 'awaiting_judgment',
  6: 'awaiting_convergence'
};

// Spec 00046: a completed run records its retrospective candidates in
// state.retro. The batch consumes them under one explicit policy: only
// critical/high candidates become draft specifications, and a follow-up item
// is never allowed to queue more follow-ups.
const FOLLOW_UP_POLICIES = ['queue', 'record', 'none'];
const DEFAULT_FOLLOW_UP_POLICY = 'queue';
const QUEUED_SEVERITIES = ['critical', 'high'];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

// Human progress belongs on stderr under --json so stdout stays one JSON document.
function say(options, message) {
  if (options && options.json) console.error(message);
  else console.log(message);
}

function loadConfig(targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const configFile = path.join(root, '.sdw', 'config.json');
  let raw = {};
  if (fs.existsSync(configFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        || {};
    } catch (e) {
      throw new Error(`invalid .sdw/config.json: ${e.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('invalid .sdw/config.json: expected a JSON object');
    }
  }
  const expand = (value, fallback) => {
    const chosen = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    return path.resolve(chosen.replace(/\{projectRoot\}/g, normalizePath(root)));
  };
  const batch = raw.batch && typeof raw.batch === 'object' && !Array.isArray(raw.batch) ? raw.batch : {};
  return {
    root,
    specsDir: expand(raw.specsDir, path.join(root, '.sdw', 'specs')),
    stateDir: expand(raw.stateDir, path.join(root, '.sdw', 'state')),
    retro: raw.retro && typeof raw.retro === 'object' && !Array.isArray(raw.retro) ? raw.retro : {},
    // Spec 00053 AC11: the pre-flight refreshes the configured lanes, so the
    // queue carries the branch block it must resolve, unmerged.
    branching: raw.branching && typeof raw.branching === 'object' && !Array.isArray(raw.branching) ? raw.branching : {},
    // Spec 00053 AC1: an unattended queue merges by default; only an explicit
    // boolean false opts out, and an absent key resolves to true.
    autoMerge: typeof batch.autoMerge === 'boolean' ? batch.autoMerge : true,
    scmProvider: typeof raw.scmProvider === 'string' && raw.scmProvider.trim()
      ? raw.scmProvider.trim().toLowerCase()
      : 'none'
  };
}

function runStateDir(config) {
  if (!fs.existsSync(config.stateDir)) fs.mkdirSync(config.stateDir, { recursive: true });
  return config.stateDir;
}

function resolveSpec(specInput, config) {
  const direct = path.isAbsolute(specInput) ? specInput : path.resolve(config.root, specInput);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const inSpecsDir = path.resolve(config.specsDir, specInput);
  if (fs.existsSync(inSpecsDir) && fs.statSync(inSpecsDir).isFile()) return inSpecsDir;
  if (fs.existsSync(`${inSpecsDir}.md`)) return `${inSpecsDir}.md`;
  return direct;
}

function inferSlug(specPath) {
  try {
    const content = fs.readFileSync(specPath, 'utf8');
    const match = content.match(/slug:\s*([^\r\n]+)/);
    if (match) return match[1].trim();
  } catch (e) {
    // Fall back to the file name.
  }
  return path.basename(specPath, path.extname(specPath));
}

function generateRunId(slug) {
  const clean = String(slug || 'spec').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30);
  return `run-${Date.now()}-${clean}`;
}

function manifestFilePath(config, batchId) {
  return path.join(runStateDir(config), `${batchId}.json`);
}

// A specification is already implemented when the registry records it as
// completed or archived; the queue must not re-run it from scratch.
function implementedStatuses(config) {
  try {
    const specIndex = require('../../sdw-spec/scripts/spec_index.cjs');
    const { entries } = specIndex.readIndex({ root: config.root });
    const statuses = new Map();
    for (const entry of entries || []) {
      if (entry.status === 'completed' || entry.status === 'archived') {
        statuses.set(entry.slug, entry.status);
      }
    }
    return statuses;
  } catch (e) {
    console.warn(`[sdw-batch] WARNING: could not read the specification index: ${e.message}`);
    return new Map();
  }
}

function createManifest({ specs, options, config }) {
  // Discovery without an explicit id only scans `batch-*.json`, so every batch
  // id is normalized to that prefix; a custom id stays resumable by itself.
  const requested = options.batchId ? String(options.batchId) : `batch-${Date.now()}`;
  const batchId = requested.startsWith('batch-') ? requested : `batch-${requested}`;
  const manifestFile = manifestFilePath(config, batchId);
  if (fs.existsSync(manifestFile)) {
    throw new Error(`batch "${batchId}" already exists at ${normalizePath(path.relative(config.root, manifestFile))}; pass a different --batch-id`);
  }
  const now = new Date().toISOString();
  const implemented = implementedStatuses(config);
  const queue = specs.map((specInput, index) => {
    const resolved = resolveSpec(specInput, config);
    const slug = inferSlug(resolved);
    const registryStatus = implemented.get(slug) || null;
    return {
      index,
      spec: normalizePath(path.relative(config.root, resolved)) || specInput,
      slug,
      status: registryStatus ? 'already_implemented' : 'pending',
      skipReason: registryStatus ? `already implemented (index.specs.md status: ${registryStatus})` : null,
      runId: null,
      deliveryCommit: null,
      branch: null,
      durationMs: null,
      error: null,
      merge: null
    };
  });
  const manifest = {
    batchId,
    createdAt: now,
    updatedAt: now,
    status: 'in_progress',
    policy: {
      continueOnError: Boolean(options.continueOnError),
      syncIndex: options.noSync ? false : true
    },
    total: queue.length,
    currentIndex: 0,
    queue
  };
  saveManifest(config, manifest);
  return manifest;
}

function saveManifest(config, manifest) {
  manifest.updatedAt = new Date().toISOString();
  fs.mkdirSync(runStateDir(config), { recursive: true });
  fs.writeFileSync(manifestFilePath(config, manifest.batchId), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

function loadManifest(config, batchId) {
  const stateDir = runStateDir(config);
  if (batchId) {
    const clean = String(batchId).replace(/^batch-/, '');
    const direct = path.join(stateDir, `batch-${clean}.json`);
    if (fs.existsSync(direct)) return JSON.parse(fs.readFileSync(direct, 'utf8'));
    const alt = path.join(stateDir, `${batchId}.json`);
    if (fs.existsSync(alt)) return JSON.parse(fs.readFileSync(alt, 'utf8'));
    return null;
  }
  const files = fs.readdirSync(stateDir)
    .filter(name => name.startsWith('batch-') && name.endsWith('.json'))
    .map(name => ({ name, mtimeMs: fs.statSync(path.join(stateDir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(stateDir, files[0].name), 'utf8'));
}

function readRunState(config, runId) {
  if (!runId) return null;
  const file = path.join(runStateDir(config), `${runId}.state.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Spec 00058 AC14: an open run left by an earlier invocation still owns the
// specification. The queue resumes it when it is still valid and names it when
// it is not, instead of delegating into the orchestrator's own block.
function openRunsForSpec(config, slug) {
  if (!slug) return [];
  let names = [];
  try {
    names = fs.readdirSync(runStateDir(config));
  } catch (e) {
    return [];
  }
  const runs = [];
  for (const name of names) {
    if (!name.endsWith('.state.json')) continue;
    const file = path.join(config.stateDir, name);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      continue;
    }
    if (!state || state.specSlug !== slug) continue;
    if (state.status !== 'paused' && state.status !== 'in_progress') continue;
    runs.push({ state, mtimeMs: fs.statSync(file).mtimeMs });
  }
  // Newest first: the most recent invocation owns the specification.
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs).map(entry => entry.state);
}

function resolveOpenRun({ config, item } = {}) {
  if (!item) return null;
  const own = readRunState(config, item.runId);
  if (own && (own.status === 'paused' || own.status === 'in_progress')) return own;
  const candidates = openRunsForSpec(config, item.slug);
  return candidates.length > 0 ? candidates[0] : null;
}

// AC14: a run is stale when its recorded base commit is not an ancestor of the
// refreshed work lane commit the next branch starts from. Both commits are
// recorded on the classification, which the summary prints verbatim.
function classifyStaleRun({ config, item, state } = {}) {
  if (!state) return null;
  const laneCommit = item && item.preflight ? item.preflight.baseCommit : null;
  const runBaseCommit = state.baseCommit || null;
  if (!laneCommit || !runBaseCommit) return null;
  if (baseContains(config, runBaseCommit, laneCommit)) return null;
  return {
    classification: 'stale',
    runId: state.runId,
    baseCommit: runBaseCommit,
    laneCommit,
    classifiedAt: new Date().toISOString()
  };
}

// AC3: delivery evidence is read from recorded values only. The item's own run
// comes first; then the most recent completed run for the specification that
// carries a delivery commit. Nothing is inferred from a title.
function mostRecentDeliveryRun(config, slug) {
  if (!slug) return null;
  const dir = runStateDir(config);
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.state.json')) continue;
    const file = path.join(dir, name);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      continue;
    }
    if (!state || state.status !== 'completed' || state.specSlug !== slug || !state.deliveryCommit) continue;
    const parsed = Date.parse(state.updatedAt || state.completedAt || '');
    const when = Number.isFinite(parsed) ? parsed : fs.statSync(file).mtimeMs;
    if (!best || when >= best.when) best = { state, when };
  }
  return best ? best.state : null;
}

function hasPullRequestNumber(pullRequest) {
  return Boolean(pullRequest)
    && pullRequest.number !== undefined
    && pullRequest.number !== null;
}

function stepOutputPullRequest(state) {
  const output = state && state.steps && state.steps[8] ? state.steps[8].output : null;
  return output && output.pullRequest ? output.pullRequest : null;
}

// AC3: adopt the run id, delivery commit, branch, and pull request recorded for
// the specification onto the queue item before its merge stage runs.
function adoptDeliveryEvidence({ config, item } = {}) {
  if (!item) return null;
  const state = readRunState(config, item.runId) || mostRecentDeliveryRun(config, item.slug);
  if (!state) return null;
  applyRunState(item, state);
  const pullRequest = stepOutputPullRequest(state) || (state.pullRequest || null);
  if (hasPullRequestNumber(pullRequest)) item.pullRequest = pullRequest;
  return state;
}

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

function providerKind(config) {
  const name = String((config && config.scmProvider) || '').toLowerCase().trim();
  if (name === 'github' || name === 'gh') return 'github';
  if (name === 'azure-devops' || name === 'azure_devops' || name === 'ado' || name === 'az') return 'ado';
  return null;
}

function runProviderCommand(config, command) {
  const result = spawnSync(command, {
    cwd: config.root,
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) return null;
  const text = String(result.stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// AC9: the provider resolves a pull request from the head branch recorded on the
// item or its run state. A value that is not branch-shaped is never queried.
function providerPullRequest({ config, head, options = {} } = {}) {
  const kind = providerKind(config);
  if (!kind || typeof head !== 'string' || !SAFE_BRANCH.test(head) || head.includes('..')) return null;
  if (typeof options._findPr === 'function') {
    const found = options._findPr({ head, provider: kind, config });
    return hasPullRequestNumber(found) ? found : null;
  }
  const command = kind === 'github'
    ? `gh pr list --head ${head} --state all --json number,url,state --limit 1`
    : `az repos pr list --source-branch ${head} --status all --output json`;
  const parsed = runProviderCommand(config, command);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || typeof entry !== 'object') return null;
  const number = entry.number !== undefined ? entry.number : entry.pullRequestId;
  if (number === undefined || number === null) return null;
  return {
    number,
    url: entry.url || entry.webUrl || null,
    state: String(entry.state || entry.status || '').toLowerCase() || null
  };
}

// AC10: the provider's merged state proves a delivery even when the delegated
// run stopped at `review_pending`. Unknown (null) never counts as merged.
function providerMerged({ config, prNumber, options = {} } = {}) {
  const kind = providerKind(config);
  if (!kind || !/^\d+$/.test(String(prNumber))) return null;
  if (typeof options._isPrMerged === 'function') {
    const value = options._isPrMerged({ prNumber, provider: kind, config });
    return value === true ? true : (value === false ? false : null);
  }
  const command = kind === 'github'
    ? `gh pr view ${prNumber} --json state,merged`
    : `az repos pr show --id ${prNumber} --output json`;
  const parsed = runProviderCommand(config, command);
  if (!parsed || typeof parsed !== 'object') return null;
  if (kind === 'github') {
    if (typeof parsed.merged === 'boolean') return parsed.merged;
    return String(parsed.state || '').toLowerCase() === 'merged';
  }
  return String(parsed.status || '').toLowerCase() === 'completed';
}

// AC9 resolution order: the delegated run's step 8 output, then the run state,
// then the SCM provider by the recorded head branch.
function resolvePullRequest({ config, item, state, options = {} } = {}) {
  const stepOutput = state && state.steps && state.steps[8] ? state.steps[8].output : null;
  const fromStep = stepOutput && stepOutput.pullRequest ? stepOutput.pullRequest : null;
  const fromState = state && state.pullRequest ? state.pullRequest : null;
  const shipStatus = (stepOutput && stepOutput.shipStatus) || (state && state.shipStatus) || null;
  if (hasPullRequestNumber(fromStep)) return { pullRequest: fromStep, shipStatus, source: 'step-8' };
  if (hasPullRequestNumber(fromState)) return { pullRequest: fromState, shipStatus, source: 'run-state' };
  const head = (state && state.branch) || (item && item.branch) || null;
  const fromProvider = providerPullRequest({ config, head, options });
  return { pullRequest: fromProvider, shipStatus, source: fromProvider ? 'provider' : null };
}

function pullRequestNumber(resolved) {
  return resolved && hasPullRequestNumber(resolved.pullRequest)
    ? resolved.pullRequest.number
    : null;
}

function retroFollowUpPolicy(config) {
  const followUp = config && config.retro ? config.retro.followUp : null;
  const value = typeof followUp === 'string' ? followUp.trim().toLowerCase() : '';
  return FOLLOW_UP_POLICIES.includes(value) ? value : DEFAULT_FOLLOW_UP_POLICY;
}

// One shape for every outcome: a status with no candidates still carries the
// fields the manifest and the summary read.
function followUpRecord(status, extras = {}) {
  return {
    status,
    candidates: 0,
    bySeverity: {},
    reportPath: null,
    queued: [],
    failures: [],
    processed: [],
    ...extras
  };
}

function describeCandidateValue(value) {
  if (value === null || value === undefined) return 'not recorded';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.artifact === 'string' && typeof value.ref === 'string') {
    return `${value.artifact}${value.ref}`;
  }
  if (typeof value === 'object' && typeof value.target === 'string') {
    const rest = { ...value };
    delete rest.target;
    return Object.keys(rest).length > 0 ? `${value.target} (${JSON.stringify(rest)})` : value.target;
  }
  return JSON.stringify(value);
}

function candidateSpecText(candidate) {
  const heading = candidate.id
    ? `Retro follow-up ${candidate.id}: ${candidate.title || 'untitled candidate'}`
    : `Retro follow-up: ${candidate.title || 'untitled candidate'}`;
  return [
    heading,
    '',
    `Proposed change: ${describeCandidateValue(candidate.proposedChange)}`,
    `Evidence: ${describeCandidateValue(candidate.evidence)}`
  ].join('\n');
}

function specScript() {
  return path.resolve(__dirname, '..', '..', 'sdw-spec', 'scripts', 'sdw_spec.cjs');
}

// Default seam: the sdw-spec CLI owns drafting, numbering, and index
// registration, so the batch never writes a specification itself.
function createSpecWithCli({ config, candidate }) {
  if (!config || !config.root) throw new Error('a resolved batch config is required to create a specification');
  const title = String(candidate.title || candidate.id || 'Retro follow-up').trim();
  const result = spawnSync(process.execPath, [
    specScript(),
    'new',
    candidateSpecText(candidate),
    '--title', title,
    '--root', config.root,
    '--json'
  ], { cwd: config.root, encoding: 'utf8' });
  if (result.error) throw result.error;
  let payload = null;
  try {
    payload = String(result.stdout || '').trim() ? JSON.parse(String(result.stdout).trim()) : null;
  } catch (e) {
    payload = null;
  }
  if (result.status !== 0 || !payload || payload.status === 'error') {
    const detail = (payload && payload.error) || String(result.stderr || '').trim();
    throw new Error(detail || `sdw-spec new exited with code ${result.status}`);
  }
  if (typeof payload.filePath !== 'string' || !payload.filePath.trim()) {
    throw new Error('sdw-spec new did not return the created specification path');
  }
  return payload;
}

function appendFollowUpQueueEntry(manifest, item, candidate, created, config) {
  if (!manifest || !Array.isArray(manifest.queue)) throw new Error('batch manifest has no queue');
  const filePath = created && (created.filePath || created.file);
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('sdw-spec new did not return the created specification path');
  }
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(config.root, filePath);
  const nextIndex = manifest.queue.reduce(
    (max, entry) => (Number.isInteger(entry.index) && entry.index > max ? entry.index : max),
    -1
  ) + 1;
  const entry = {
    index: nextIndex,
    spec: normalizePath(path.relative(config.root, absolute)),
    slug: created.slug || inferSlug(absolute),
    status: 'pending',
    followUpDepth: 1,
    origin: { candidateId: candidate.id || null, runId: item.runId || null }
  };
  manifest.queue.push(entry);
  manifest.total = manifest.queue.length;
  return entry;
}

function followUpReportPath(config, manifest) {
  return path.join(runStateDir(config), `${manifest.batchId}.followups.md`);
}

function renderFollowUpSection(item, followUp, candidates) {
  const lines = [
    `## [${item.index + 1}] ${item.slug || item.spec || 'item'}`,
    '',
    `- **Run:** ${item.runId || 'unknown'}`,
    `- **Report:** \`${followUp.reportPath}\``,
    `- **Candidates:** ${candidates.length}`,
    ''
  ];
  if (candidates.length === 0) lines.push('No candidates recorded.', '');
  for (const candidate of candidates) {
    lines.push(`### ${candidate.id || 'candidate'}: ${candidate.title || 'untitled'}`);
    lines.push('');
    lines.push(`- **Severity:** ${candidate.severity || 'unknown'}`);
    lines.push(`- **Category:** ${candidate.category || 'unknown'}`);
    lines.push(`- **Evidence:** ${describeCandidateValue(candidate.evidence)}`);
    lines.push(`- **Proposed change:** ${describeCandidateValue(candidate.proposedChange)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function writeFollowUpReport(config, manifest, item, followUp, candidates) {
  const file = followUpReportPath(config, manifest);
  const section = renderFollowUpSection(item, followUp, candidates);
  fs.mkdirSync(runStateDir(config), { recursive: true });
  if (fs.existsSync(file)) {
    fs.appendFileSync(file, section, 'utf8');
  } else {
    const header = [
      `# Batch Retro Follow-Ups: ${manifest.batchId}`,
      '',
      '- **Policy:** record',
      `- **Generated at:** ${new Date().toISOString()}`,
      ''
    ].join('\n');
    fs.writeFileSync(file, `${header}${section}`, 'utf8');
  }
  return file;
}

// Consumes the retrospective record of a completed item. It never throws: a
// missing report, a failed retro, malformed JSON, or a failed spec creation is
// recorded on the manifest and the queue keeps advancing.
function applyRetroFollowUp({ config, manifest, item, options, deps } = {}) {
  const record = followUp => {
    if (item) item.retroFollowUp = followUp;
    return followUp;
  };
  try {
    if (!item) return undefined;
    const policy = retroFollowUpPolicy(config);
    if (policy === 'none') return record({ status: 'skipped' });

    const state = readRunState(config, item.runId);
    const retro = state && state.retro;
    if (!retro) return record(followUpRecord('unavailable'));
    if (retro.status !== 'passed') {
      const failedPath = retro.reportJson ? normalizePath(retro.reportJson) : null;
      return record(followUpRecord('failed', { reportPath: failedPath }));
    }
    if (!retro.reportJson) return record(followUpRecord('unavailable'));
    const reportPath = normalizePath(retro.reportJson);

    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.resolve(config.root, reportPath), 'utf8'));
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 'unavailable' : 'invalid';
      return record(followUpRecord(status, { reportPath }));
    }
    if (!report || typeof report !== 'object' || !Array.isArray(report.candidates)) {
      return record(followUpRecord('invalid', { reportPath }));
    }
    const candidates = report.candidates.filter(
      candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    );
    const bySeverity = {};
    for (const candidate of candidates) {
      const severity = typeof candidate.severity === 'string' && candidate.severity ? candidate.severity : 'unknown';
      bySeverity[severity] = (bySeverity[severity] || 0) + 1;
    }
    const followUp = followUpRecord(policy === 'record' ? 'recorded' : 'queued', {
      candidates: candidates.length,
      bySeverity,
      reportPath
    });
    // Carry the checkpoint and the history across a resume: processed ids stop
    // duplicate specs, queued and failed entries stay visible in the summary.
    const previous = item.retroFollowUp && typeof item.retroFollowUp === 'object' ? item.retroFollowUp : {};
    if (Array.isArray(previous.queued)) followUp.queued = [...previous.queued];
    if (Array.isArray(previous.failures)) followUp.failures = [...previous.failures];
    if (Array.isArray(previous.processed)) followUp.processed = [...previous.processed];

    if (policy === 'record') {
      writeFollowUpReport(config, manifest, item, followUp, candidates);
      return record(followUp);
    }

    // A follow-up item still records what its own retrospective found; the depth
    // bound suppresses new specifications, not the candidate summary.
    if (item.followUpDepth >= 1) return record({ ...followUp, status: 'depth-exceeded' });

    const createSpec = deps && typeof deps.createSpec === 'function' ? deps.createSpec : createSpecWithCli;
    const processed = new Set(Array.isArray(followUp.processed) ? followUp.processed : []);
    for (const candidate of candidates) {
      if (!QUEUED_SEVERITIES.includes(candidate.severity)) continue;
      const candidateId = candidate.id || null;
      if (candidateId && processed.has(candidateId)) continue;
      try {
        const created = createSpec({ config, manifest, item, candidate });
        const entry = appendFollowUpQueueEntry(manifest, item, candidate, created, config);
        followUp.queued.push({ candidateId, spec: entry.spec, slug: entry.slug });
      } catch (err) {
        followUp.failures.push({
          candidateId,
          error: err && err.message ? err.message : String(err)
        });
      }
      // Checkpoint by candidate id and persist the entry together with the
      // manifest: a resumed batch must neither re-create a queued spec nor
      // drop the candidates that were still pending when it stopped.
      if (candidateId) {
        processed.add(candidateId);
        followUp.processed = [...processed];
      }
      saveManifest(config, manifest);
    }
    return record(followUp);
  } catch (err) {
    return record({
      ...followUpRecord('failed'),
      failures: [{ candidateId: null, error: err && err.message ? err.message : String(err) }]
    });
  }
}

// A resumed batch re-enters the follow-up stage for completed items whose
// candidate loop was interrupted. Processed candidate ids make the re-entry
// idempotent, and the remaining critical/high candidates are queued now instead
// of being silently lost because the item already counts as completed.
function recoverFollowUps(manifest, config, options = {}, deps) {
  if (!manifest || !Array.isArray(manifest.queue)) return 0;
  if (retroFollowUpPolicy(config) !== 'queue') return 0;
  let recovered = 0;
  for (const item of manifest.queue) {
    if (!item || item.status !== 'completed') continue;
    if (item.followUpDepth >= 1) continue;
    const followUp = item.retroFollowUp;
    if (!followUp || followUp.status === 'skipped' || followUp.status === 'unavailable') continue;
    const before = Array.isArray(followUp.queued) ? followUp.queued.length : 0;
    applyRetroFollowUp({ config, manifest, item, options, deps });
    const after = item.retroFollowUp && Array.isArray(item.retroFollowUp.queued)
      ? item.retroFollowUp.queued.length
      : 0;
    if (after > before) recovered += after - before;
  }
  if (recovered > 0) saveManifest(config, manifest);
  return recovered;
}

// Spec 00053 AC2/AC3: the queue merge reuses the SCM provider contract that
// `sdw-ship-pr --merge` already issues: one CLI call, the provider default
// merge method, and never a head-branch deletion.
function mergeCommandFor(provider, prNumber) {
  const name = String(provider || '').toLowerCase().trim();
  if (name === 'github' || name === 'gh') return `gh pr merge ${prNumber} --merge`;
  if (name === 'azure-devops' || name === 'azure_devops' || name === 'ado' || name === 'az') {
    return `az repos pr update --id ${prNumber} --status completed`;
  }
  return null;
}

// Synchronous provider call: the queue loop is spawnSync-based, so the merge
// returns a value or throws instead of resolving a promise.
function runMergeCommand({ config, command }) {
  const result = spawnSync(command, {
    cwd: config.root,
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `${command} exited with code ${result.status}`);
  }
  return { merged: true, command };
}

// Effective merge policy for one invocation: the configured default, with
// `--no-merge` (AC3/AC8 of spec 00053) overriding it for run and resume alike.
function mergeEnabled(config, options = {}) {
  return options.noMerge !== true && Boolean(config && config.autoMerge);
}

// Records one merge outcome per queue item. A policy skip or a provider failure
// is recorded on the item and the queue keeps advancing: the item's delivery
// status is owned by the delegated run and never changes here.
function applyMerge({ config, manifest, item, options = {} } = {}) {
  if (!item) return undefined;
  // AC6: a resumed queue never re-merges an item whose attempt is already on
  // the manifest, whether that attempt succeeded or failed. This is the
  // per-item rule; the pre-flight reads the same record through
  // preflightMergeOpen, which treats only a `merged` record as final.
  if (item.merge && item.merge.attempted === true) return item.merge;

  const at = new Date().toISOString();
  const noMerge = options.noMerge === true;
  const requested = mergeEnabled(config, options);
  const record = (status, extra = {}) => {
    item.merge = {
      requested,
      attempted: false,
      ok: null,
      status,
      reason: null,
      prNumber: null,
      at,
      ...extra
    };
    saveManifest(config, manifest);
    return item.merge;
  };

  if (!requested) {
    // AC3: the policy reason stays on the record so the summary explains why.
    const reason = noMerge ? '--no-merge' : 'batch.autoMerge is false';
    say(options, `[sdw-batch] Merge skipped for ${item.slug}: ${reason}.`);
    return record('skipped', { reason });
  }

  // AC3/AC9: the delivery evidence is adopted onto the item, then the pull
  // request resolves from step 8, the run state, and finally the provider.
  const state = adoptDeliveryEvidence({ config, item });
  const resolved = resolvePullRequest({ config, item, state, options });
  const prNumber = pullRequestNumber(resolved);
  if (prNumber === null) {
    // AC4: a skipped item whose delivery cannot be proven carries no evidence.
    const reason = item.status === 'already_implemented' && !state ? 'no-delivery-evidence' : 'no-pr';
    say(options, `[sdw-batch] Merge skipped for ${item.slug}: ${reason}.`);
    return record('skipped', { reason, source: resolved.source });
  }
  // The provider contract only accepts numeric pull request ids; validating
  // here keeps the CLI command free of state-derived shell input.
  if (!/^\d+$/.test(String(prNumber))) {
    say(options, `[sdw-batch] Merge skipped for ${item.slug}: invalid-pr-number.`);
    return record('skipped', { reason: 'invalid-pr-number', prNumber, source: resolved.source });
  }

  // AC10: a run that stopped at `review_pending` still delivered when the
  // provider reports that pull request merged.
  if (resolved.shipStatus !== 'delivered') {
    const merged = providerMerged({ config, prNumber, options });
    if (merged === true) {
      item.merge = {
        requested,
        attempted: false,
        ok: true,
        status: 'merged',
        reason: null,
        prNumber,
        source: resolved.source,
        observed: 'merged',
        at
      };
      say(options, `[sdw-batch] Pull request ${prNumber} for ${item.slug} is already merged.`);
      saveManifest(config, manifest);
      return item.merge;
    }
  }

  const command = mergeCommandFor(config && config.scmProvider, prNumber);
  if (!command) {
    say(options, `[sdw-batch] Merge skipped for ${item.slug}: scmProvider "${config.scmProvider}" cannot merge.`);
    return record('skipped', { reason: 'no scm provider', prNumber, source: resolved.source });
  }

  const mergePr = typeof options._mergePr === 'function' ? options._mergePr : runMergeCommand;
  try {
    mergePr({ config, item, prNumber, command, provider: config.scmProvider });
    item.merge = { requested: true, attempted: true, ok: true, status: 'merged', reason: null, prNumber, source: resolved.source, at };
    say(options, `[sdw-batch] Merged ${prNumber} for ${item.slug}.`);
  } catch (err) {
    // AC4: record the failure, keep the item completed, let the queue advance.
    const message = err && err.message ? err.message : String(err);
    item.merge = { requested: true, attempted: true, ok: false, status: 'failed', reason: message, prNumber, source: resolved.source, at };
    say(options, `[sdw-batch] Merge failed for ${item.slug}: ${message}`);
  }
  saveManifest(config, manifest);
  return item.merge;
}

// Spec 00053 AC11-AC13: every delegation is preceded by a base refresh. The
// refreshed base must reach every earlier delivery commit; a missing one is
// either merged through its still-open pull request, or halts the queue before
// a stale base can seed the next item.
const BATCH_REMOTE = 'origin';

function gitCommand(config, args) {
  const result = spawnSync('git', args, {
    cwd: config.root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `git ${args.join(' ')} exited with code ${result.status}`);
  }
  return String(result.stdout || '').trim();
}

// The lane the next item branches from: the configured work lane, then the
// integration lane, then the remote default branch. No lane means the queue
// cannot prove a base, so the pre-flight records the condition instead.
function baseBranchOf(config) {
  const branching = config && config.branching ? config.branching : {};
  for (const value of [branching.workBranch, branching.integrationBranch]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  try {
    const head = gitCommand(config, ['symbolic-ref', '--short', `refs/remotes/${BATCH_REMOTE}/HEAD`]);
    if (!head) return null;
    return head.startsWith(`${BATCH_REMOTE}/`) ? head.slice(BATCH_REMOTE.length + 1).trim() : head.trim();
  } catch (e) {
    return null;
  }
}

// Fetches the base lane into its remote-tracking ref without touching the work
// tree or any local branch. A repository without a remote has nothing shared
// to prove, which is a recorded condition, never a halt.
function refreshBase(config, baseBranch) {
  try {
    gitCommand(config, ['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    return { status: 'unavailable', reason: err.message };
  }
  try {
    gitCommand(config, ['remote', 'get-url', BATCH_REMOTE]);
  } catch (e) {
    return { status: 'no-remote', reason: `remote "${BATCH_REMOTE}" is not configured` };
  }
  gitCommand(config, ['fetch', BATCH_REMOTE, `+refs/heads/${baseBranch}:refs/remotes/${BATCH_REMOTE}/${baseBranch}`]);
  return {
    status: 'refreshed',
    baseCommit: gitCommand(config, ['rev-parse', `refs/remotes/${BATCH_REMOTE}/${baseBranch}`])
  };
}

function baseContains(config, commit, baseCommit) {
  try {
    gitCommand(config, ['merge-base', '--is-ancestor', String(commit), String(baseCommit)]);
    return true;
  } catch (e) {
    return false;
  }
}

function missingDeliveryMessage(prior, baseBranch) {
  return `base branch "${baseBranch}" does not contain delivery commit ${prior.deliveryCommit} from "${prior.slug}"`;
}

// AC5: every earlier queue item that carries a delivery commit is a delivery to
// prove, whatever that item's status. The registry row decides implementation,
// never whether the base received the delivery.
function missingDeliveries(config, manifest, item, baseCommit) {
  return manifest.queue.filter(prior =>
    prior.index < item.index
    && prior.deliveryCommit
    && !baseContains(config, prior.deliveryCommit, baseCommit));
}

function currentBranchOf(config) {
  try {
    const name = gitCommand(config, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return name && name !== 'HEAD' ? name : null;
  } catch (e) {
    return null;
  }
}

function workTreeDirty(config) {
  try {
    return gitCommand(config, ['status', '--porcelain']).length > 0;
  } catch (e) {
    return false;
  }
}

// AC7/AC8: move the local work lane onto the refreshed remote lane commit. A
// lane that cannot reach the refreshed commit is a halt; a work tree that blocks
// the update is not, because the branch start point falls back to the remote ref.
function fastForwardWorkLane({ config, lane, baseCommit }) {
  let localCommit = null;
  try {
    localCommit = gitCommand(config, ['rev-parse', '--verify', '--quiet', `refs/heads/${lane}`]) || null;
  } catch (e) {
    localCommit = null;
  }
  if (localCommit === baseCommit) return { status: 'current', startPoint: baseCommit, localCommit };
  if (localCommit && !baseContains(config, localCommit, baseCommit)) {
    return {
      status: 'halted',
      localCommit,
      reason: `work lane "${lane}" at ${localCommit} cannot reach the refreshed commit ${baseCommit}`
    };
  }
  const checkedOut = currentBranchOf(config) === lane;
  try {
    if (checkedOut) {
      gitCommand(config, ['merge', '--ff-only', String(baseCommit)]);
    } else if (localCommit) {
      // A lane that is not checked out is moved without touching the work tree.
      gitCommand(config, ['update-ref', `refs/heads/${lane}`, String(baseCommit), String(localCommit)]);
    } else {
      gitCommand(config, ['update-ref', `refs/heads/${lane}`, String(baseCommit)]);
    }
    return { status: 'fast-forwarded', startPoint: baseCommit, localCommit: baseCommit };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    if (checkedOut && workTreeDirty(config)) {
      // AC8: the remote commit is the start point the next branch will use.
      return { status: 'deferred', startPoint: `${BATCH_REMOTE}/${lane}`, localCommit, reason: detail };
    }
    return {
      status: 'halted',
      localCommit,
      reason: `work lane "${lane}" at ${localCommit || '(missing)'} cannot reach the refreshed commit ${baseCommit}: ${detail}`
    };
  }
}

// AC5: the base proof adopts the evidence of earlier items that never recorded
// it themselves, so a skipped item still counts as a delivery.
function adoptPriorEvidence({ config, manifest, item } = {}) {
  if (!manifest || !Array.isArray(manifest.queue) || !item) return;
  for (const prior of manifest.queue) {
    if (prior.index >= item.index) continue;
    if (prior.deliveryCommit) continue;
    adoptDeliveryEvidence({ config, item: prior });
  }
}

// Pre-flight merge eligibility. The per-item path (applyMerge) treats any
// recorded attempt as final; this path re-issues the merge while the earlier
// delivery is missing from the refreshed base, because AC6 requires the queue
// to land an earlier open pull request before delegating the next item. A
// recorded `failed` attempt merged nothing, so retrying it is recovery; only a
// record whose status is `merged` is final here.
function preflightMergeOpen(prior, resolved) {
  const prNumber = pullRequestNumber(resolved);
  if (prNumber === null) return false;
  if (resolved.shipStatus === 'failed') return false;
  return !(prior.merge && prior.merge.status === 'merged');
}

// Spec 00066 AC1-AC3: an earlier delivery may only be merged once the required
// checks report success. The probe is injectable (`_checksStatus`) so tests stay
// deterministic; the production probe reads `gh pr checks` for github and yields
// `null` (unknown) for any provider or CLI that cannot report checks, which keeps
// today's immediate merge instead of hanging the queue.
const CHECK_POLL_INTERVAL_MS = 5000;
const CHECK_POLL_ATTEMPTS = 60;

function normalizeChecks(value) {
  if (!value || typeof value !== 'object') return null;
  const state = String(value.state || '').toLowerCase().trim();
  if (state !== 'pending' && state !== 'pass' && state !== 'fail') return null;
  const failing = Array.isArray(value.failing)
    ? value.failing.map(name => String(name).trim()).filter(Boolean)
    : [];
  return { state, failing };
}

const PASSING_CHECK_STATES = new Set(['success', 'successful', 'pass', 'passed', 'skipped', 'neutral']);
const FAILING_CHECK_STATES = new Set([
  'failure', 'failed', 'error', 'cancelled', 'canceled', 'timed_out', 'action_required', 'startup_failure'
]);

// `gh pr checks` exits non-zero while checks are pending (8) or failing (1), so
// the JSON body is read whatever the exit status: only an unreadable report,
// zero checks, or an absent CLI means the provider cannot report. `--required`
// limits the gate to the checks the protected branch actually requires, so an
// advisory check can never block or halt the queue.
function providerChecksStatus({ config, prNumber, provider } = {}) {
  if (providerKind({ scmProvider: provider }) !== 'github' || !/^\d+$/.test(String(prNumber))) return null;
  const result = spawnSync(`gh pr checks ${prNumber} --required --json name,state`, {
    cwd: config.root,
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (!result || result.error) return null;
  let entries = null;
  try {
    const parsed = JSON.parse(String(result.stdout || '').trim());
    if (Array.isArray(parsed)) entries = parsed;
  } catch (e) {
    entries = null;
  }
  if (!entries || entries.length === 0) return null;
  const failing = [];
  let pending = false;
  for (const entry of entries) {
    const state = String((entry && (entry.state || entry.conclusion || entry.status)) || '').toLowerCase();
    if (FAILING_CHECK_STATES.has(state)) failing.push(String((entry && (entry.name || entry.context)) || '').trim() || 'unnamed check');
    else if (!PASSING_CHECK_STATES.has(state)) pending = true;
  }
  if (failing.length > 0) return { state: 'fail', failing };
  return { state: pending ? 'pending' : 'pass', failing: [] };
}

// One observation. `null` means the checks cannot be reported: the pre-flight
// then issues today's immediate merge instead of blocking on a missing capability.
function checksStatus({ config, prNumber, provider, options = {} } = {}) {
  if (typeof options._checksStatus === 'function') {
    return normalizeChecks(options._checksStatus({ prNumber, provider, config }));
  }
  // An injected merge hook is a test/fake seam that owns provider interaction,
  // so the queue never shells out to a real CLI when one is supplied.
  if (typeof options._mergePr === 'function') return null;
  return normalizeChecks(providerChecksStatus({ config, prNumber, provider }));
}

// A synchronous queue still waits: `Atomics.wait` blocks without a timer, and a
// test injects `_sleep` so polling runs with no wall-clock delay.
function defaultSleep(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// AC1/AC2: poll the required checks to a terminal state. Both the interval and
// the attempt count are bounded, so a provider that never settles halts the queue.
function waitForChecks({ config, prNumber, provider, options = {} } = {}) {
  const sleep = typeof options._sleep === 'function' ? options._sleep : defaultSleep;
  const interval = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs >= 0
    ? options.pollIntervalMs
    : CHECK_POLL_INTERVAL_MS;
  const attempts = Number.isInteger(options.pollAttempts) && options.pollAttempts > 0
    ? options.pollAttempts
    : CHECK_POLL_ATTEMPTS;
  let observed = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) sleep(interval);
    observed = checksStatus({ config, prNumber, provider, options });
    if (!observed) return { state: 'unavailable', attempts: attempt };
    if (observed.state !== 'pending') return { state: observed.state, failing: observed.failing, attempts: attempt };
  }
  return { state: 'timeout', failing: observed ? observed.failing : [], attempts };
}

function failingChecksReason(prNumber, failing) {
  // The names are what the operator must fix; a check that reports no name at
  // all still identifies its state.
  return failing.length > 0
    ? `required checks failed for pull request #${prNumber}: ${failing.join(', ')}`
    : `required checks failed for pull request #${prNumber}`;
}

// AC1-AC3: merge one earlier delivery pull request under the check gate. No merge
// request is created while checks are pending; a provider refusal while checks are
// pending records waiting, polls to a terminal state, and retries exactly once.
// Returns `{ ok: true }` or `{ halt: reason }`; the caller adds the delivery context.
function mergeEarlierDelivery({ config, manifest, prior, item, prNumber, command, source, options = {} } = {}) {
  const provider = config.scmProvider;
  const mergePr = typeof options._mergePr === 'function' ? options._mergePr : runMergeCommand;
  // Spec 00066 AC4: the check gate keeps its evidence on the merge record. The
  // fields are additive, so a record written before the gate (or by the per-item
  // path) stays readable: its check fields are simply absent.
  const attempts = [];
  let observed = null;
  let retryOutcome = null;
  const record = fields => {
    prior.merge = {
      requested: true,
      attempted: attempts.length > 0,
      ok: null,
      status: null,
      reason: null,
      prNumber,
      source,
      at: new Date().toISOString(),
      checks: observed ? { state: observed.state, failing: observed.failing.slice() } : null,
      attempts: attempts.map(entry => ({ ...entry })),
      retryOutcome,
      ...fields
    };
    saveManifest(config, manifest);
    return prior.merge;
  };
  // One merge attempt, timestamped: the record proves how often and when the
  // provider was asked, whatever the outcome.
  const attempt = () => {
    const at = new Date().toISOString();
    try {
      mergePr({ config, item: prior, prNumber, command, provider });
      attempts.push({ at, ok: true, reason: null });
    } catch (err) {
      attempts.push({ at, ok: false, reason: err && err.message ? err.message : String(err) });
      throw err;
    }
  };

  // AC1: the merge request is created only after the required checks pass.
  const checks = checksStatus({ config, prNumber, provider, options });
  observed = checks;
  if (checks && checks.state === 'fail') {
    const reason = failingChecksReason(prNumber, checks.failing);
    retryOutcome = 'not-needed';
    record({ ok: false, status: 'failed', reason });
    return { halt: reason };
  }
  if (checks && checks.state === 'pending') {
    // AC2's `waiting` record is written before the poll, so an interrupted queue
    // shows why it stopped instead of a merge that looks merely failed.
    record({ status: 'waiting', reason: 'required checks pending' });
    say(options, `[sdw-batch] Waiting for required checks on pull request ${prNumber} before merging it.`);
    const waited = waitForChecks({ config, prNumber, provider, options });
    if (waited.state === 'fail') {
      observed = { state: 'fail', failing: waited.failing };
      retryOutcome = 'not-needed';
      const reason = failingChecksReason(prNumber, waited.failing);
      record({ ok: false, status: 'failed', reason });
      return { halt: reason };
    }
    if (waited.state === 'timeout') {
      observed = { state: 'pending', failing: waited.failing };
      retryOutcome = 'not-needed';
      const reason = `pull request #${prNumber} did not report a terminal check state after ${waited.attempts} poll(s)`;
      record({ ok: false, status: 'failed', reason });
      return { halt: reason };
    }
    if (waited.state !== 'pass') {
      // The gate started from pending because the checks must be green before the
      // merge. A provider that stops reporting mid-wait is not evidence of green,
      // so the merge is never requested (the initial-unknown degrade stays above).
      observed = null;
      retryOutcome = 'not-needed';
      const reason = `pull request #${prNumber} checks stopped reporting while pending; the merge was not requested`;
      record({ ok: false, status: 'failed', reason });
      return { halt: reason };
    }
    observed = { state: 'pass', failing: [] };
  }

  try {
    attempt();
    retryOutcome = 'not-needed';
    record({ attempted: true, ok: true, status: 'merged' });
    say(options, `[sdw-batch] Merged ${prNumber} for ${prior.slug} before delegating ${item.slug}.`);
    return { ok: true };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    // AC2: the refusal is only a check refusal when the checks are still pending;
    // anything else keeps the established single-attempt failure.
    const refusal = checksStatus({ config, prNumber, provider, options });
    observed = refusal;
    if (!refusal || refusal.state !== 'pending') {
      retryOutcome = 'not-needed';
      record({ attempted: true, ok: false, status: 'failed', reason: detail });
      return { halt: `the pre-flight merge of pull request #${prNumber} failed: ${detail}` };
    }
    record({ attempted: true, ok: null, status: 'waiting', reason: detail });
    say(options, `[sdw-batch] Merge of pull request ${prNumber} was refused while its checks are pending; waiting for them to finish.`);
    const waited = waitForChecks({ config, prNumber, provider, options });
    if (waited.state !== 'pass') {
      // The retry never ran: the checks never reached a passing state.
      retryOutcome = 'not-attempted';
      observed = waited.state === 'fail'
        ? { state: 'fail', failing: waited.failing }
        : waited.state === 'timeout'
          ? { state: 'pending', failing: waited.failing }
          : null;
      const reason = waited.state === 'fail'
        ? failingChecksReason(prNumber, waited.failing)
        : waited.state === 'timeout'
          ? `pull request #${prNumber} did not report a terminal check state after ${waited.attempts} poll(s)`
          : `pull request #${prNumber} is not mergeable: the provider refused the merge (${detail})`;
      record({ attempted: true, ok: false, status: 'failed', reason });
      return { halt: reason };
    }
    observed = { state: 'pass', failing: [] };
    try {
      attempt();
      retryOutcome = 'succeeded';
      record({ attempted: true, ok: true, status: 'merged' });
      say(options, `[sdw-batch] Merged ${prNumber} for ${prior.slug} after its required checks passed.`);
      return { ok: true };
    } catch (retryErr) {
      retryOutcome = 'failed';
      const retryDetail = retryErr && retryErr.message ? retryErr.message : String(retryErr);
      const reason = `pull request #${prNumber} is not mergeable after its checks passed: ${retryDetail}`;
      record({ attempted: true, ok: false, status: 'failed', reason });
      return { halt: reason };
    }
  }
}

function runPreflight({ config, manifest, item, options = {} } = {}) {
  const at = new Date().toISOString();
  const baseBranch = baseBranchOf(config);
  const store = (status, extra = {}) => {
    item.preflight = {
      requested: true,
      status,
      remote: BATCH_REMOTE,
      baseBranch,
      baseCommit: null,
      startPoint: null,
      reason: null,
      at,
      ...extra
    };
    saveManifest(config, manifest);
    return item.preflight;
  };
  if (!baseBranch) {
    store('no-base-branch', { reason: 'no work or integration branch resolves for the base refresh' });
    return null;
  }

  let refreshed;
  try {
    refreshed = refreshBase(config, baseBranch);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    store('failed', { reason: message });
    return { halt: true, message: `pre-flight could not refresh "${baseBranch}" from ${BATCH_REMOTE}: ${message}` };
  }
  if (refreshed.status !== 'refreshed') {
    store(refreshed.status, { reason: refreshed.reason });
    return null;
  }

  let baseCommit = refreshed.baseCommit;
  let lane = fastForwardWorkLane({ config, lane: baseBranch, baseCommit });
  if (lane.status === 'halted') {
    const message = `${lane.reason}; refusing to delegate "${item.slug}" on a stale base`;
    store('halted', { baseCommit, reason: message });
    return { halt: true, message };
  }
  store('refreshed', {
    baseCommit,
    startPoint: lane.startPoint,
    startPointSource: lane.status,
    laneCommit: lane.localCommit || null
  });

  adoptPriorEvidence({ config, manifest, item });
  let missing = missingDeliveries(config, manifest, item, baseCommit);
  if (missing.length === 0) return null;

  let mergedAny = false;
  for (const prior of missing) {
    const priorState = adoptDeliveryEvidence({ config, item: prior });
    const resolved = resolvePullRequest({ config, item: prior, state: priorState, options });
    const prNumber = pullRequestNumber(resolved);
    const alreadyMerged = Boolean(prior.merge && prior.merge.status === 'merged');
    if (!preflightMergeOpen(prior, resolved)) {
      const message = alreadyMerged
        ? `${missingDeliveryMessage(prior, baseBranch)} although its manifest records merged pull request #${prNumber}`
        : `${missingDeliveryMessage(prior, baseBranch)} and no open pull request can deliver it`;
      store('halted', { baseCommit, startPoint: lane.startPoint, reason: message });
      return { halt: true, message };
    }
    // AC6: an earlier pull request is still open, so the base omits its
    // delivery. Auto-merge lands it now; a disabled policy halts instead.
    if (!mergeEnabled(config, options)) {
      const message = `pull request #${prNumber} for "${prior.slug}" is still open, so "${baseBranch}" lacks delivery commit ${prior.deliveryCommit}; auto-merge is disabled (enable batch.autoMerge, drop --no-merge, or merge the pull request manually)`;
      store('halted', { baseCommit, startPoint: lane.startPoint, reason: message });
      return { halt: true, message };
    }
    const command = mergeCommandFor(config.scmProvider, prNumber);
    if (!command || !/^\d+$/.test(String(prNumber))) {
      const message = `${missingDeliveryMessage(prior, baseBranch)} and scmProvider "${config.scmProvider}" cannot merge pull request #${prNumber}`;
      store('halted', { baseCommit, startPoint: lane.startPoint, reason: message });
      return { halt: true, message };
    }
    // Spec 00066 AC1-AC3: the merge is gated on the required checks. A failing
    // check, a poll that never settles, or a pull request that stays unmergeable
    // halts the queue naming the pull request and the checks.
    const outcome = mergeEarlierDelivery({
      config,
      manifest,
      prior,
      item,
      prNumber,
      command,
      source: resolved.source,
      options
    });
    if (outcome.halt) {
      const message = `${missingDeliveryMessage(prior, baseBranch)}; ${outcome.halt}`;
      store('halted', { baseCommit, startPoint: lane.startPoint, reason: message });
      return { halt: true, message };
    }
    mergedAny = true;
  }

  if (mergedAny) {
    // One extra refresh after the merges: the same fetch, never a wait loop.
    try {
      baseCommit = refreshBase(config, baseBranch).baseCommit;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      store('failed', { baseCommit, startPoint: lane.startPoint, reason: message });
      return { halt: true, message: `pre-flight could not refresh "${baseBranch}" after merging earlier items: ${message}` };
    }
    lane = fastForwardWorkLane({ config, lane: baseBranch, baseCommit });
    if (lane.status === 'halted') {
      const message = `${lane.reason}; refusing to delegate "${item.slug}" on a stale base`;
      store('halted', { baseCommit, reason: message });
      return { halt: true, message };
    }
    item.preflight.baseCommit = baseCommit;
    item.preflight.startPoint = lane.startPoint;
    item.preflight.startPointSource = lane.status;
    item.preflight.laneCommit = lane.localCommit || null;
    saveManifest(config, manifest);
  }

  missing = missingDeliveries(config, manifest, item, baseCommit);
  if (missing.length > 0) {
    // AC6: the refreshed base still omits a delivery; name the commit and the
    // branch instead of delegating onto a stale base.
    const message = `${missingDeliveryMessage(missing[0], baseBranch)}; refusing to delegate "${item.slug}" on a stale base`;
    store('halted', { baseCommit, startPoint: lane.startPoint, reason: message });
    return { halt: true, message };
  }
  return null;
}

function triggerSpecSync(config) {
  try {
    const specSync = require('../../sdw-spec/scripts/spec_sync.cjs');
    if (specSync && typeof specSync.syncIndex === 'function') {
      specSync.syncIndex({ root: config.root });
      return true;
    }
  } catch (e) {
    // Index sync is best effort; the manifest outcome stays authoritative, but
    // the failure must reach the operator instead of leaving a stale registry.
    console.warn(`[sdw-batch] WARNING: spec index sync failed: ${e.message}`);
  }
  return false;
}

function orchestratorScript() {
  return path.resolve(__dirname, '..', '..', 'sdw-orch', 'scripts', 'sdw_orch.cjs');
}

// AC13: `--new-run` is forwarded to the delegated run, so the orchestrator
// starts a fresh run instead of blocking on the open run it would otherwise
// consider resumable. A resume has no such flag: the queue supersedes first.
function orchestratorArgs({ config, runId, specPath, resume, newRun }) {
  const script = orchestratorScript();
  if (resume) return [script, 'resume', '--run-id', runId, '--root', config.root];
  return [
    script,
    'run',
    path.resolve(config.root, specPath),
    '--run-id',
    runId,
    '--unattended',
    ...(newRun ? ['--new-run'] : []),
    '--root',
    config.root
  ];
}

function invokeOrchestrator({ config, runId, specPath, resume, newRun }) {
  const args = orchestratorArgs({ config, runId, specPath, resume, newRun });
  const result = spawnSync(process.execPath, args, { cwd: config.root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return typeof result.status === 'number' ? result.status : 1;
}

function applyRunState(item, state) {
  if (!state) return;
  item.runId = state.runId || item.runId;
  item.branch = state.branch || item.branch || null;
  item.deliveryCommit = state.deliveryCommit || item.deliveryCommit || null;
}

function mergeOutcomeLabel(merge) {
  if (!merge) return '-';
  if (merge.status === 'merged') {
    return merge.prNumber !== null && merge.prNumber !== undefined ? `merged #${merge.prNumber}` : 'merged';
  }
  if (merge.status === 'failed') return 'failed';
  if (merge.status === 'skipped') return `skipped: ${merge.reason || 'policy'}`;
  return '-';
}

function printSummary(manifest, options = {}) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const count = status => manifest.queue.filter(item => item.status === status).length;
  console.log('\n============================================================');
  console.log('SDW Batch Execution Summary');
  console.log(`Batch ID: ${manifest.batchId}`);
  console.log(`Status:   ${manifest.status}`);
  console.log(`Total:    ${manifest.total} (Completed: ${count('completed')}, Skipped: ${count('already_implemented')}, Failed: ${count('failed')}, Paused: ${manifest.queue.filter(item => item.status.startsWith('awaiting_')).length})`);
  console.log('------------------------------------------------------------');
  console.log('# | Slug                           | Status      | Duration | Delivery Commit | Merge');
  console.log('--|--------------------------------|-------------|----------|-----------------|------------------');
  manifest.queue.forEach(item => {
    const index = String(item.index + 1).padEnd(2);
    const slug = String(item.slug || item.spec).padEnd(30).slice(0, 30);
    const status = String(item.status || 'unknown').padEnd(11);
    const duration = item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s`.padEnd(8) : '-       ';
    const commit = item.deliveryCommit ? String(item.deliveryCommit).slice(0, 12) : '-';
    console.log(`${index}| ${slug} | ${status} | ${duration} | ${commit} | ${mergeOutcomeLabel(item.merge)}`);
  });
  // AC4: a merge skipped for missing delivery evidence names its item here, so
  // an unattended queue never hides an unproven delivery behind a table row.
  const noEvidence = manifest.queue.filter(item => item.merge && item.merge.reason === 'no-delivery-evidence');
  if (noEvidence.length > 0) {
    console.log('------------------------------------------------------------');
    console.log(`Merge skipped (no delivery evidence): ${noEvidence.map(item => item.slug || item.spec).join(', ')}`);
  }
  // AC8: the pre-flight records the start point the next branch actually uses.
  const startPoints = manifest.queue.filter(item => item.preflight && item.preflight.startPoint);
  if (startPoints.length > 0) {
    console.log('------------------------------------------------------------');
    console.log('Pre-flight start points');
    startPoints.forEach(item => {
      const preflight = item.preflight;
      const base = preflight.baseCommit ? String(preflight.baseCommit).slice(0, 12) : '-';
      console.log(`${String(item.slug || item.spec).padEnd(30).slice(0, 30)} | base ${base} | start ${preflight.startPoint}`);
    });
  }
  // AC14: every stale open run is named with its classification and both commits.
  const staleRuns = manifest.queue.filter(item => item.staleRun);
  if (staleRuns.length > 0) {
    console.log('------------------------------------------------------------');
    console.log('Stale open runs');
    staleRuns.forEach(item => {
      const stale = item.staleRun;
      const action = stale.superseded || item.supersededRunId === stale.runId
        ? `superseded by --new-run (${item.supersededRunId})`
        : 'halted: pass --new-run to supersede';
      console.log(`${String(item.slug || item.spec).padEnd(30).slice(0, 30)} | ${stale.classification} | run ${stale.runId} | base ${stale.baseCommit} | lane ${stale.laneCommit} | ${action}`);
    });
  }
  // Follow-up outcomes stay visible: queued specs and creation failures are
  // the operator's only signal that the retrospective changed the queue.
  const followUps = manifest.queue.filter(item => {
    const followUp = item.retroFollowUp;
    if (!followUp) return false;
    return followUp.status === 'queued'
      || followUp.status === 'recorded'
      || (Array.isArray(followUp.failures) && followUp.failures.length > 0);
  });
  if (followUps.length > 0) {
    console.log('------------------------------------------------------------');
    console.log('Retro Follow-Ups');
    followUps.forEach(item => {
      const followUp = item.retroFollowUp;
      const breakdown = Object.entries(followUp.bySeverity || {})
        .map(([severity, count]) => `${severity}: ${count}`)
        .join(', ');
      const candidateLabel = `candidates: ${followUp.candidates || 0}${breakdown ? ` (${breakdown})` : ''}`;
      const queuedCount = Array.isArray(followUp.queued) ? followUp.queued.length : 0;
      console.log(`${String(item.slug || item.spec).padEnd(30).slice(0, 30)} | ${String(followUp.status).padEnd(10)} | ${candidateLabel}, queued: ${queuedCount}`);
      (followUp.queued || []).forEach(entry => console.log(`  + ${entry.spec}`));
      (followUp.failures || []).forEach(failure => console.log(`  ! ${failure.candidateId || 'candidate'}: ${failure.error}`));
    });
  }
  console.log('============================================================\n');
}

function finishFailure(manifest, config, item, exitCode, message, options, continueOnError) {
  item.status = 'failed';
  item.error = message || `sdw-orch exited with code ${exitCode}`;
  saveManifest(config, manifest);
  if (!continueOnError) {
    manifest.status = 'halted';
    saveManifest(config, manifest);
    console.error(`\n[sdw-batch] Halting queue on failure: "${item.slug}". Remaining ${manifest.total - item.index - 1} specification(s) pending.`);
    printSummary(manifest, options);
    // Batch exit codes stay unambiguous: 0 completed, 1 failure, 4/5 pause.
    return 1;
  }
  say(options, `[sdw-batch] "${item.slug}" failed; continuing queue (--continue-on-error).`);
  return null;
}

function haltOnPreflight(manifest, config, item, preflight, options) {
  manifest.status = 'halted';
  saveManifest(config, manifest);
  console.error(`\n[sdw-batch] Pre-flight halted the queue before delegating "${item.slug}": ${preflight.message}`);
  printSummary(manifest, options);
  return 1;
}

// AC15: a stale open run halts the queue by name instead of failing the item.
// The item was never delegated, so it keeps its status and stays resumable once
// the operator converges it or supersedes it.
function haltOnStaleRun(manifest, config, item, stale, options) {
  manifest.status = 'halted';
  saveManifest(config, manifest);
  console.error(`\n[sdw-batch] Stale open run blocked delegation of "${item.slug}": run "${stale.runId}" has base commit ${stale.baseCommit}, which is not an ancestor of the refreshed work lane commit ${stale.laneCommit}.`);
  console.error(`[sdw-batch] Pass --new-run to start a fresh run and record "${stale.runId}" as the superseded run id.`);
  printSummary(manifest, options);
  return 1;
}

function executeQueue(manifest, config, options) {
  let anyFailed = false;
  const continueOnError = options.continueOnError !== undefined
    ? Boolean(options.continueOnError)
    : Boolean(manifest.policy.continueOnError);
  const syncIndex = options.noSync !== undefined
    ? !options.noSync
    : manifest.policy.syncIndex !== false;
  const implemented = implementedStatuses(config);

  for (let i = manifest.currentIndex; i < manifest.queue.length; i += 1) {
    const item = manifest.queue[i];
    if (item.status === 'completed') {
      say(options, `[sdw-batch] Skipping completed specification [${item.index + 1}/${manifest.total}]: ${item.slug}`);
      continue;
    }
    // Re-check the registry per item so a spec completed since the manifest was
    // created is never implemented twice, including on resume.
    if (item.status !== 'already_implemented' && implemented.has(item.slug)) {
      item.status = 'already_implemented';
      item.skipReason = `already implemented (index.specs.md status: ${implemented.get(item.slug)})`;
      saveManifest(config, manifest);
    }
    if (item.status === 'already_implemented') {
      // AC1/AC2: only the implementation is skipped. The base is still proved
      // before the next delegation and the item's delivery is still merged.
      say(options, `[sdw-batch] Skipping already-implemented specification [${item.index + 1}/${manifest.total}]: ${item.slug} (${item.skipReason})`);
      adoptDeliveryEvidence({ config, item });
      const skipPreflight = runPreflight({ config, manifest, item, options });
      if (skipPreflight && skipPreflight.halt) {
        return haltOnPreflight(manifest, config, item, skipPreflight, options);
      }
      applyMerge({ config, manifest, item, options });
      saveManifest(config, manifest);
      continue;
    }

    // Spec 00053 AC11-AC13: refresh the base and prove the earlier deliveries
    // are reachable before this item is delegated. A halt leaves the item
    // pending and returns the failure exit code without touching the run.
    const preflight = runPreflight({ config, manifest, item, options });
    if (preflight && preflight.halt) {
      return haltOnPreflight(manifest, config, item, preflight, options);
    }

    // Spec 00058 AC14-AC16: an open run is resumed only while its own base
    // commit is reachable from the refreshed lane. A stale one halts the queue
    // with the run id, its base commit, and the remedy; `--new-run` supersedes
    // it, records the replaced id, and starts a fresh run.
    const openRun = resolveOpenRun({ config, item });
    if (openRun) {
      const stale = classifyStaleRun({ config, item, state: openRun });
      if (options.newRun) {
        // AC16: the flag starts a fresh run and records the run it replaced,
        // whether or not that run is stale; a stale one is never resumed.
        item.supersededRunId = openRun.runId;
        item.runId = null;
        if (stale) item.staleRun = { ...stale, superseded: true };
        say(options, stale
          ? `[sdw-batch] Open run "${stale.runId}" for ${item.slug} is ${stale.classification}: base ${stale.baseCommit} is not an ancestor of the refreshed lane commit ${stale.laneCommit}; superseded by --new-run.`
          : `[sdw-batch] Open run "${openRun.runId}" for ${item.slug} superseded by --new-run.`);
        saveManifest(config, manifest);
      } else if (stale) {
        item.staleRun = stale;
        saveManifest(config, manifest);
        return haltOnStaleRun(manifest, config, item, stale, options);
      } else if (!item.runId) {
        // A run whose base commit is an ancestor is not stale: resume it as today.
        item.runId = openRun.runId;
        saveManifest(config, manifest);
      }
    }

    manifest.currentIndex = i;
    item.status = 'in_progress';
    saveManifest(config, manifest);

    say(options, `\n[sdw-batch] [${item.index + 1}/${manifest.total}] Delegating ${item.slug} to sdw-orch (single run)`);
    const started = Date.now();
    const prior = readRunState(config, item.runId);
    const resumable = prior && (prior.status === 'paused' || prior.status === 'in_progress');
    let exitCode = 0;
    let failureMessage = null;

    if (prior && prior.status === 'completed') {
      say(options, `[sdw-batch] Run "${item.runId}" already completed; reconciling queue item.`);
      applyRunState(item, prior);
    } else {
      const runId = item.runId || generateRunId(item.slug);
      item.runId = runId;
      try {
        exitCode = options._invoke
          ? options._invoke({
              config,
              runId,
              specPath: item.spec,
              resume: Boolean(resumable),
              runState: prior,
              newRun: Boolean(options.newRun)
            })
          : invokeOrchestrator({
              config,
              runId,
              specPath: item.spec,
              resume: Boolean(resumable),
              newRun: Boolean(options.newRun)
            });
      } catch (err) {
        exitCode = 1;
        failureMessage = err.message;
      }
      applyRunState(item, readRunState(config, item.runId));
    }

    item.durationMs = (item.durationMs || 0) + (Date.now() - started);

    if (exitCode === 0) {
      const finalState = readRunState(config, item.runId);
      if (!finalState || finalState.status !== 'completed') {
        anyFailed = true;
        const halt = finishFailure(manifest, config, item, 1, `Run "${item.runId}" exited 0 without completing`, options, continueOnError);
        if (halt !== null) return halt;
        continue;
      }
      applyRunState(item, finalState);
      item.status = 'completed';
      item.error = null;
      applyRetroFollowUp({ config, manifest, item, options, deps: options._retroDeps });
      applyMerge({ config, manifest, item, options });
      const followUp = item.retroFollowUp || {};
      const queued = Array.isArray(followUp.queued) ? followUp.queued.length : 0;
      const failures = Array.isArray(followUp.failures) ? followUp.failures.length : 0;
      if (queued > 0) {
        say(options, `[sdw-batch] Queued ${queued} retro follow-up specification(s) after the remaining items.`);
      }
      if (failures > 0) {
        say(options, `[sdw-batch] ${failures} retro follow-up specification(s) failed; see the summary.`);
      }
      say(options, `[sdw-batch] "${item.slug}" completed in ${(item.durationMs / 1000).toFixed(1)}s.`);
      saveManifest(config, manifest);
      if (syncIndex) triggerSpecSync(config);
    } else if (PAUSE_STATUS[exitCode]) {
      item.status = PAUSE_STATUS[exitCode];
      item.error = null;
      manifest.status = 'paused';
      saveManifest(config, manifest);
      say(options, `\n[sdw-batch] "${item.slug}" paused with ${item.status} (sdw-orch exit code ${exitCode}).`);
      // AC12: the paused run continues from its delivery stage; no new run starts.
      say(options, `[sdw-batch] Continue that run, then resume the queue with: sdw-batch resume ${manifest.batchId}`);
      printSummary(manifest, options);
      return exitCode;
    } else {
      anyFailed = true;
      const halt = finishFailure(manifest, config, item, exitCode, failureMessage, options, continueOnError);
      if (halt !== null) return halt;
    }
  }

  // A resume can begin past items that already failed, so the terminal status is
  // derived from the whole queue, not only from failures observed this pass.
  const stillFailed = manifest.queue.some(item => item.status === 'failed');
  manifest.status = (anyFailed || stillFailed) ? 'completed_with_errors' : 'completed';
  saveManifest(config, manifest);
  printSummary(manifest, options);
  return manifest.status === 'completed' ? 0 : 1;
}

function validateSpecs(specs, config) {
  const resolved = [];
  for (const specInput of specs) {
    const specPath = resolveSpec(specInput, config);
    if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
      return { valid: false, missing: specInput, resolved: [] };
    }
    resolved.push(specPath);
  }
  return { valid: true, missing: null, resolved };
}

function runBatch(specs, options = {}) {
  const config = loadConfig(options.root);
  if (!specs || specs.length === 0) {
    console.error('Error: No specifications provided.');
    return 1;
  }
  const validation = validateSpecs(specs, config);
  if (!validation.valid) {
    console.error(`Error: Batch pre-flight failed: specification not found: "${validation.missing}"`);
    console.error('Batch rejected before any specification executed.');
    return 1;
  }
  if (options.dryRun) {
    const implemented = implementedStatuses(config);
    console.log(`\n[sdw-batch] Dry-run plan (${validation.resolved.length} specification(s)):`);
    validation.resolved.forEach((specPath, index) => {
      const slug = inferSlug(specPath);
      const registryStatus = implemented.get(slug);
      const note = registryStatus ? ` - skipped: already implemented (${registryStatus})` : '';
      console.log(`  ${index + 1}. ${slug} (${normalizePath(specPath)})${note}`);
    });
    console.log('No specification executed (--dry-run).\n');
    return 0;
  }
  const manifest = createManifest({ specs: validation.resolved, options, config });
  say(options, `[sdw-batch] Initialized "${manifest.batchId}" with ${manifest.total} specification(s).`);
  say(options, `Policy: continueOnError=${manifest.policy.continueOnError}, syncIndex=${manifest.policy.syncIndex}`);
  return executeQueue(manifest, config, options);
}

function resumeBatch(batchId, options = {}) {
  const config = loadConfig(options.root);
  const manifest = loadManifest(config, batchId);
  if (!manifest) {
    console.error(`Error: No batch manifest found (${batchId || 'latest'}).`);
    return 1;
  }
  if (manifest.status === 'completed' || manifest.status === 'completed_with_errors') {
    const ok = manifest.status === 'completed';
    say(options, `[sdw-batch] Batch "${manifest.batchId}" is already finished (${manifest.status}).`);
    printSummary(manifest, options);
    return ok ? 0 : 1;
  }
  manifest.status = 'in_progress';
  saveManifest(config, manifest);
  const recovered = recoverFollowUps(manifest, config, options, options._retroDeps);
  if (recovered > 0) {
    say(options, `[sdw-batch] Recovered ${recovered} interrupted retro follow-up specification(s).`);
  }
  say(options, `[sdw-batch] Resuming "${manifest.batchId}" (${manifest.currentIndex + 1}/${manifest.total})...`);
  return executeQueue(manifest, config, options);
}

function formatStatus(manifest) {
  if (!manifest) return 'No batch manifest found.';
  const lines = [
    `Batch ID: ${manifest.batchId}`,
    `Status:   ${manifest.status}`,
    `Progress: ${manifest.currentIndex + 1}/${manifest.total}`,
    'Queue:'
  ];
  manifest.queue.forEach(item => {
    lines.push(`  [${item.index + 1}] ${item.slug}: ${item.status}${item.runId ? ` (${item.runId})` : ''}`);
  });
  return lines.join('\n');
}

module.exports = {
  applyRetroFollowUp,
  classifyStaleRun,
  createManifest,
  executeQueue,
  formatStatus,
  generateRunId,
  inferSlug,
  invokeOrchestrator,
  loadConfig,
  loadManifest,
  manifestFilePath,
  openRunsForSpec,
  orchestratorArgs,
  printSummary,
  readRunState,
  recoverFollowUps,
  resolveOpenRun,
  resolveSpec,
  resumeBatch,
  runBatch,
  saveManifest,
  triggerSpecSync,
  validateSpecs
};
