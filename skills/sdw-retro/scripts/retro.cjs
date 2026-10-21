#!/usr/bin/env node
'use strict';

// retro.cjs — human-invoked retrospective over a completed sdw-orch run.
//
// Inputs are the run state file and the step artifacts that state declares.
// Host transcripts and agent chat logs are excluded by construction: the
// scanner never enumerates host log locations, and any declared path that
// looks like a transcript, session log, or chat log is skipped and reported
// as an excluded input. Missing declared artifacts are reported as absences;
// their content is never synthesized.
//
// `retro run` writes <runId>.retro.md and <runId>.retro.json inside the run
// artifact directory. It never writes anywhere else and never touches git.

const fs = require('fs');
const path = require('path');

const STATE_DIR = '.sdw/state';
const USAGE = 'Usage: retro.cjs run [--run-id <id>] [--root <path>] [--json]';

const CANDIDATE_FIELDS = Object.freeze(['id', 'title', 'severity', 'category', 'evidence', 'proposedChange']);
const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const CATEGORIES = Object.freeze([
  'memory',
  'harness-directive',
  'reviewer-standard',
  'automated-check',
  'navigation-pointer',
  'no-op-deletion'
]);

// Host-owned inputs that retro must never read (AC3).
const HOST_LOG_PATTERNS = Object.freeze([
  /(^|\/)(transcripts?|sessions?|chats?|chat[-_]?logs?|conversations?|agent[-_]?logs?)(\/|$)/i,
  /(^|\/)(transcript|session|chat)[-_.]/i,
  /\.(jsonl|chat|transcript)$/i
]);

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isHostLogPath(value) {
  const normalized = normalizePath(value);
  return HOST_LOG_PATTERNS.some((pattern) => pattern.test(normalized));
}

function findProjectRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, '.sdw'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function isInside(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveDeclared(root, declared) {
  const absolute = path.isAbsolute(declared) ? path.normalize(declared) : path.resolve(root, declared);
  return {
    absolute,
    relative: normalizePath(path.relative(root, absolute)),
    inside: isInside(root, absolute)
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRunId(value) {
  return String(value || '').trim().replace(/\.state\.json$/i, '');
}

function matchesRunId(entry, wanted) {
  const runId = String(entry.state.runId || '').trim();
  const fileName = entry.name.replace(/\.state\.json$/i, '');
  if (runId === wanted || fileName === wanted) return true;
  if (runId.startsWith(`${wanted}-`) || runId.startsWith(`run-${wanted}-`)) return true;
  if (runId.endsWith(`-${wanted}`)) return true;
  return false;
}

function runSortValue(entry) {
  const stamp = entry.state.updatedAt || entry.state.completedAt || entry.state.createdAt;
  const parsed = Date.parse(stamp);
  if (Number.isFinite(parsed)) return parsed;
  try {
    return fs.statSync(entry.file).mtimeMs;
  } catch (error) {
    return 0;
  }
}

function readStateFiles(root) {
  const stateDir = path.join(root, STATE_DIR);
  if (!fs.existsSync(stateDir) || !fs.statSync(stateDir).isDirectory()) {
    throw new Error(`state directory not found: ${STATE_DIR}`);
  }
  const entries = [];
  for (const name of fs.readdirSync(stateDir)) {
    if (!name.endsWith('.state.json') || isHostLogPath(name)) continue;
    const file = path.join(stateDir, name);
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state && typeof state === 'object' && !Array.isArray(state)) {
        entries.push({ name, file, state });
      }
    } catch (error) {
      // A malformed state file is not a retro input; the run is simply not selectable.
    }
  }
  return entries;
}

function selectRun(root, wantedRunId) {
  const entries = readStateFiles(root);
  let candidates = entries;
  if (wantedRunId) {
    const wanted = normalizeRunId(wantedRunId);
    candidates = entries.filter((entry) => matchesRunId(entry, wanted));
    if (candidates.length === 0) throw new Error(`run not found: ${wantedRunId}`);
  } else {
    candidates = entries.filter((entry) => entry.state.status === 'completed');
    if (candidates.length === 0) {
      throw new Error(`no completed run found under ${STATE_DIR}`);
    }
  }
  candidates.sort((a, b) => runSortValue(b) - runSortValue(a)
    || String(b.state.runId || b.name).localeCompare(String(a.state.runId || a.name)));
  return candidates[0];
}

function artifactDirectory(root, state) {
  const declared = typeof state.artifactsDir === 'string' && state.artifactsDir.trim()
    ? state.artifactsDir.trim()
    : `${STATE_DIR}/${state.specSlug || 'unknown-spec'}/${state.runId || 'unknown-run'}`;
  const resolved = resolveDeclared(root, declared);
  if (!resolved.inside) {
    throw new Error(`run artifact directory escapes the project root: ${declared}`);
  }
  return resolved.absolute;
}

// Every path the run state declares as an artifact is expected. The state is
// authoritative: retro never invents paths that the state does not name.
function collectExpectedArtifacts(state) {
  const expected = [];
  const seen = new Set();
  const add = (declared, expectedBy) => {
    if (typeof declared !== 'string' || declared.trim() === '') return;
    const key = normalizePath(declared.trim());
    if (seen.has(key)) return;
    seen.add(key);
    expected.push({ path: key, expectedBy });
  };

  const steps = state.steps && typeof state.steps === 'object' ? state.steps : {};
  for (const key of Object.keys(steps)) {
    const step = steps[key];
    if (step && typeof step === 'object') add(step.artifact, `steps.${key}.artifact`);
  }

  const step4 = steps['4'] && typeof steps['4'] === 'object' ? steps['4'] : null;
  const tasks = step4 && step4.tasks && typeof step4.tasks === 'object' ? step4.tasks : {};
  for (const taskId of Object.keys(tasks)) {
    const task = tasks[taskId];
    if (!task || typeof task !== 'object') continue;
    add(task.promptPath, `steps.4.tasks.${taskId}.promptPath`);
    add(task.evidencePath, `steps.4.tasks.${taskId}.evidencePath`);
  }

  const step5Output = steps['5'] && steps['5'].output && typeof steps['5'].output === 'object'
    ? steps['5'].output
    : {};
  add(step5Output.judgePromptPath, 'steps.5.output.judgePromptPath');
  add(step5Output.judgeVerdictPath, 'steps.5.output.judgeVerdictPath');

  return expected;
}

function inspectArtifacts(root, expected) {
  const artifacts = [];
  const missingArtifacts = [];
  const excludedInputs = [];
  const inputs = [];

  for (const item of expected) {
    const resolved = resolveDeclared(root, item.path);
    if (!resolved.inside) {
      excludedInputs.push({ path: item.path, reason: 'outside-project-root' });
      continue;
    }
    if (isHostLogPath(resolved.relative)) {
      excludedInputs.push({ path: resolved.relative, reason: 'host-log' });
      continue;
    }
    let stats = null;
    try {
      stats = fs.statSync(resolved.absolute);
    } catch (error) {
      stats = null;
    }
    if (!stats || !stats.isFile()) {
      missingArtifacts.push({ path: resolved.relative, expectedBy: item.expectedBy, present: false });
      artifacts.push({ path: resolved.relative, expectedBy: item.expectedBy, exists: false });
      continue;
    }
    try {
      const content = fs.readFileSync(resolved.absolute, 'utf8');
      inputs.push(resolved.relative);
      artifacts.push({
        path: resolved.relative,
        expectedBy: item.expectedBy,
        exists: true,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: content === '' ? 0 : content.split(/\r?\n/).length
      });
    } catch (error) {
      missingArtifacts.push({ path: resolved.relative, expectedBy: item.expectedBy, present: true, readable: false });
      artifacts.push({ path: resolved.relative, expectedBy: item.expectedBy, exists: true, read: false });
    }
  }

  return { artifacts, missingArtifacts, excludedInputs, inputs };
}

function durationBetween(start, end) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, to - from);
}

function collectSignals(state, inspection) {
  const steps = state.steps && typeof state.steps === 'object' ? state.steps : {};
  const stepKeys = Object.keys(steps).sort((a, b) => toNumber(a) - toNumber(b));
  const step4 = steps['4'] && typeof steps['4'] === 'object' ? steps['4'] : {};
  const step5Output = steps['5'] && steps['5'].output && typeof steps['5'].output === 'object'
    ? steps['5'].output
    : {};
  const step7Output = steps['7'] && steps['7'].output && typeof steps['7'].output === 'object'
    ? steps['7'].output
    : {};
  const step8Output = steps['8'] && steps['8'].output && typeof steps['8'].output === 'object'
    ? steps['8'].output
    : {};
  const convergence = step8Output.reviewConvergence
    && typeof step8Output.reviewConvergence === 'object'
    && !Array.isArray(step8Output.reviewConvergence)
    ? step8Output.reviewConvergence
    : null;

  const dispatch = step4.dispatch && typeof step4.dispatch === 'object' ? step4.dispatch : {};
  const abandonments = toArray(dispatch.abandonments);

  const timestamps = {
    createdAt: state.createdAt || null,
    updatedAt: state.updatedAt || null,
    durationMs: durationBetween(state.createdAt, state.updatedAt),
    steps: stepKeys.map((key) => {
      const step = steps[key] && typeof steps[key] === 'object' ? steps[key] : {};
      return {
        step: toNumber(key),
        name: step.name || null,
        status: step.status || null,
        startedAt: step.startedAt || null,
        completedAt: step.completedAt || null
      };
    })
  };

  const scoreIterations = toNumber(state.scoreIteration);
  const reviewIterations = toNumber(state.reviewIteration);
  const reviewRounds = convergence ? toNumber(convergence.rounds) : 0;
  const retries = {
    scoreIterations,
    reviewIterations,
    reviewRounds,
    dispatchAbandonments: abandonments.length,
    total: scoreIterations + reviewIterations + reviewRounds + abandonments.length
  };

  const abandonedDispatches = abandonments.map((item, index) => ({
    taskId: item && item.taskId ? item.taskId : null,
    reason: item && item.reason ? item.reason : null,
    at: item && item.at ? item.at : null,
    ref: `#steps.4.dispatch.abandonments[${index}]`
  }));

  const scoreSignals = {
    score: step5Output.score !== undefined ? step5Output.score : null,
    minScore: step5Output.minScore !== undefined ? step5Output.minScore : null,
    passed: typeof step5Output.passed === 'boolean' ? step5Output.passed : null,
    judgeScore: step5Output.judge && typeof step5Output.judge === 'object'
      && step5Output.judge.reportedScore !== undefined
      ? step5Output.judge.reportedScore
      : null,
    iteration: scoreIterations,
    ref: '#steps.5.output'
  };

  const gates = [];
  const seenGates = new Set();
  const gateSources = [
    { values: step4.gates, prefix: 'steps.4.gates' },
    { values: step4.output && step4.output.gates, prefix: 'steps.4.output.gates' }
  ];
  for (const source of gateSources) {
    if (!source.values || typeof source.values !== 'object' || Array.isArray(source.values)) continue;
    for (const name of Object.keys(source.values)) {
      const gate = source.values[name] && typeof source.values[name] === 'object' ? source.values[name] : {};
      const key = `${name}|${gate.status || ''}|${gate.exitCode === undefined ? '' : gate.exitCode}`;
      if (seenGates.has(key)) continue;
      seenGates.add(key);
      gates.push({
        gate: name,
        status: gate.status || null,
        exitCode: gate.exitCode === undefined ? null : gate.exitCode,
        durationMs: gate.durationMs === undefined ? null : gate.durationMs,
        ref: `#${source.prefix}.${name}`
      });
    }
  }
  const gateRepairs = gates.filter((gate) => gate.status !== 'passed'
    || (gate.exitCode !== null && gate.exitCode !== 0));

  const rawFindings = toArray(step7Output.findings);
  const findings = rawFindings.map((finding, index) => ({
    id: finding && finding.id ? finding.id : null,
    severity: finding && finding.severity ? finding.severity : null,
    path: finding && finding.path ? finding.path : null,
    line: finding && finding.line !== undefined ? finding.line : null,
    status: finding && finding.status ? finding.status : null,
    ref: `#steps.7.output.findings[${index}]`
  }));
  const bySeverity = {};
  for (const finding of findings) {
    const severity = finding.severity || 'unknown';
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
  }
  const reviewFindings = {
    total: findings.length,
    open: findings.filter((finding) => finding.status === 'open').length,
    bySeverity,
    blockingCount: step7Output.blockingCount !== undefined ? step7Output.blockingCount : null,
    findings
  };

  const pendingThreads = toArray(convergence && convergence.pendingThreads).map((thread, index) => ({
    threadId: thread && thread.threadId ? thread.threadId : null,
    path: thread && thread.path ? thread.path : null,
    line: thread && thread.line !== undefined ? thread.line : null,
    ref: `#steps.8.output.reviewConvergence.pendingThreads[${index}]`
  }));
  const unresolvedThreads = {
    available: Boolean(convergence),
    active: convergence && convergence.activeThreads !== undefined ? convergence.activeThreads : null,
    resolved: convergence && convergence.resolvedThreads !== undefined ? convergence.resolvedThreads : null,
    pending: pendingThreads
  };

  return {
    timestamps,
    retries,
    abandonedDispatches,
    scoreIterations: scoreSignals,
    gateRepairs,
    reviewFindings,
    unresolvedThreads,
    missingArtifacts: inspection.missingArtifacts
  };
}

function candidateContract() {
  return {
    fields: [...CANDIDATE_FIELDS],
    severity: [...SEVERITIES],
    category: [...CATEGORIES]
  };
}

// Candidate record shape (AC7) and value restrictions (AC8). Evidence
// completeness and artifact resolution belong to the candidate validator.
function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, errors: [{ code: 'invalid-candidate', message: 'candidate must be an object' }] };
  }
  const errors = [];
  for (const field of CANDIDATE_FIELDS) {
    if (!(field in candidate) || candidate[field] === undefined || candidate[field] === null
      || String(candidate[field]).trim() === '') {
      errors.push({ code: 'missing-field', field });
    }
  }
  if (candidate.severity !== undefined && !SEVERITIES.includes(candidate.severity)) {
    errors.push({ code: 'invalid-severity', field: 'severity', allowed: [...SEVERITIES] });
  }
  if (candidate.category !== undefined && !CATEGORIES.includes(candidate.category)) {
    errors.push({ code: 'invalid-category', field: 'category', allowed: [...CATEGORIES] });
  }
  return { valid: errors.length === 0, errors };
}

function buildReport(options) {
  const candidates = [];
  for (const candidate of toArray(options.candidates)) {
    const result = validateCandidate(candidate);
    if (!result.valid) {
      throw new Error(`invalid candidate: ${result.errors.map((error) => error.code).join(', ')}`);
    }
    candidates.push(candidate);
  }
  return {
    runId: options.state.runId || options.runIdFallback || null,
    specSlug: options.state.specSlug || null,
    status: options.state.status || null,
    statePath: options.statePath,
    artifactsDir: options.artifactsDir,
    generatedAt: new Date().toISOString(),
    inputs: [...options.inspection.inputs],
    excludedInputs: [...options.inspection.excludedInputs],
    artifacts: [...options.inspection.artifacts],
    signals: options.signals,
    candidates,
    candidateContract: candidateContract()
  };
}

function renderMarkdown(report) {
  const lines = [];
  const signals = report.signals;
  lines.push(`# Run Retrospective: ${report.runId}`, '');
  lines.push(`- **Specification:** ${report.specSlug || 'unknown'}`);
  lines.push(`- **Run status:** ${report.status || 'unknown'}`);
  lines.push(`- **State file:** \`${report.statePath}\``);
  lines.push(`- **Artifact directory:** \`${report.artifactsDir}\``);
  lines.push(`- **Generated at:** ${report.generatedAt}`);
  lines.push('');

  lines.push('## Inputs', '');
  if (report.inputs.length === 0) {
    lines.push('No declared artifacts were read.');
  } else {
    for (const input of report.inputs) lines.push(`- \`${input}\``);
  }
  lines.push('');

  lines.push('## Signals', '');
  lines.push('### Timestamps', '');
  lines.push('| Step | Name | Status | Started | Completed |');
  lines.push('|---|---|---|---|---|');
  for (const step of signals.timestamps.steps) {
    lines.push(`| ${step.step} | ${step.name || '-'} | ${step.status || '-'} | ${step.startedAt || '-'} | ${step.completedAt || '-'} |`);
  }
  if (signals.timestamps.steps.length === 0) lines.push('| - | - | - | - | - |');
  lines.push('');

  lines.push('### Retries', '');
  lines.push(`- Score iterations: ${signals.retries.scoreIterations}`);
  lines.push(`- Review iterations: ${signals.retries.reviewIterations}`);
  lines.push(`- Review rounds: ${signals.retries.reviewRounds}`);
  lines.push(`- Dispatch abandonments: ${signals.retries.dispatchAbandonments}`);
  lines.push('');

  lines.push('### Abandoned Dispatches', '');
  if (signals.abandonedDispatches.length === 0) {
    lines.push('None recorded.');
  } else {
    for (const item of signals.abandonedDispatches) {
      lines.push(`- \`${item.taskId || 'unknown task'}\` at ${item.at || 'unknown time'}: ${item.reason || 'no reason'} (${item.ref})`);
    }
  }
  lines.push('');

  lines.push('### Score Iterations', '');
  lines.push(`- Score: ${signals.scoreIterations.score === null ? 'not recorded' : signals.scoreIterations.score}`);
  lines.push(`- Minimum score: ${signals.scoreIterations.minScore === null ? 'not recorded' : signals.scoreIterations.minScore}`);
  lines.push(`- Passed: ${signals.scoreIterations.passed === null ? 'not recorded' : signals.scoreIterations.passed}`);
  lines.push(`- Iterations: ${signals.scoreIterations.iteration}`);
  lines.push('');

  lines.push('### Gate Repairs', '');
  if (signals.gateRepairs.length === 0) {
    lines.push('None recorded.');
  } else {
    for (const gate of signals.gateRepairs) {
      lines.push(`- Gate \`${gate.gate}\`: status ${gate.status || 'unknown'}, exit ${gate.exitCode === null ? 'unknown' : gate.exitCode} (${gate.ref})`);
    }
  }
  lines.push('');

  lines.push('### Review Findings', '');
  lines.push(`- Total: ${signals.reviewFindings.total}`);
  lines.push(`- Open: ${signals.reviewFindings.open}`);
  for (const item of signals.reviewFindings.findings) {
    lines.push(`- \`${item.id || 'finding'}\` (${item.severity || 'unknown'}, ${item.status || 'unknown'}) at ${item.path || 'unknown path'}${item.line === null ? '' : `:${item.line}`} (${item.ref})`);
  }
  lines.push('');

  lines.push('### Unresolved Threads', '');
  if (!signals.unresolvedThreads.available) {
    lines.push('Step 8 did not report review convergence.');
  } else {
    lines.push(`- Active: ${signals.unresolvedThreads.active === null ? 'not recorded' : signals.unresolvedThreads.active}`);
    lines.push(`- Resolved: ${signals.unresolvedThreads.resolved === null ? 'not recorded' : signals.unresolvedThreads.resolved}`);
    for (const thread of signals.unresolvedThreads.pending) {
      lines.push(`- \`${thread.threadId || 'thread'}\` at ${thread.path || 'unknown path'}${thread.line === null ? '' : `:${thread.line}`} (${thread.ref})`);
    }
  }
  lines.push('');

  lines.push('### Missing Artifacts', '');
  if (signals.missingArtifacts.length === 0) {
    lines.push('Every declared artifact is present.');
  } else {
    for (const item of signals.missingArtifacts) {
      lines.push(`- \`${item.path}\` (expected by \`${item.expectedBy}\`): absent. Content was not read or synthesized.`);
    }
  }
  lines.push('');

  lines.push('## Candidates', '');
  if (report.candidates.length === 0) {
    lines.push('No candidates recorded. A report with signals and no candidates is valid.');
  } else {
    for (const candidate of report.candidates) {
      lines.push(`- \`${candidate.id}\` (${candidate.severity}, ${candidate.category}): ${candidate.title}`);
    }
  }
  const contract = report.candidateContract;
  lines.push('');
  lines.push(`Candidate contract: fields ${contract.fields.map((field) => `\`${field}\``).join(', ')}; severity ${contract.severity.join('|')}; category ${contract.category.join('|')}.`);
  lines.push('');

  lines.push('## Excluded Inputs', '');
  if (report.excludedInputs.length === 0) {
    lines.push('None.');
  } else {
    for (const item of report.excludedInputs) {
      lines.push(`- \`${item.path}\` (${item.reason})`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function writeReports(root, artifactsDirectoryPath, report) {
  fs.mkdirSync(artifactsDirectoryPath, { recursive: true });
  const markdownPath = path.join(artifactsDirectoryPath, `${report.runId}.retro.md`);
  const jsonPath = path.join(artifactsDirectoryPath, `${report.runId}.retro.json`);
  const outputs = {
    markdown: normalizePath(path.relative(root, markdownPath)),
    json: normalizePath(path.relative(root, jsonPath))
  };
  report.outputs = outputs;
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
  return outputs;
}

function runRetro(options = {}) {
  const root = path.resolve(options.root || findProjectRoot(process.cwd()));
  const selected = selectRun(root, options.runId);
  const state = selected.state;
  const statePath = normalizePath(path.relative(root, selected.file));
  const artifactsDirectoryPath = artifactDirectory(root, state);
  const artifactsDir = normalizePath(path.relative(root, artifactsDirectoryPath));

  // Tell the operator which run and directory were selected before analysis.
  const announce = (message) => {
    if (options.json) process.stderr.write(`${message}\n`);
    else process.stdout.write(`${message}\n`);
  };
  announce(`retro: run=${state.runId || selected.name} spec=${state.specSlug || 'unknown'} status=${state.status || 'unknown'}`);
  announce(`retro: artifacts=${artifactsDir}`);

  const expected = collectExpectedArtifacts(state);
  const inspection = inspectArtifacts(root, expected);
  const signals = collectSignals(state, inspection);
  const report = buildReport({
    state,
    runIdFallback: selected.name.replace(/\.state\.json$/i, ''),
    statePath,
    artifactsDir,
    inspection,
    signals,
    candidates: options.candidates
  });
  const outputs = writeReports(root, artifactsDirectoryPath, report);
  return { root, artifactsDir, outputs, report };
}

function parseArgs(argv) {
  const options = { subcommand: null, runId: null, root: null, json: false, help: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--run-id') {
      options.runId = argv[++index];
      if (options.runId === undefined) throw new Error('missing value for --run-id');
    } else if (arg.startsWith('--run-id=')) options.runId = arg.slice('--run-id='.length);
    else if (arg === '--root') {
      options.root = argv[++index];
      if (options.root === undefined) throw new Error('missing value for --root');
    } else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    else positional.push(arg);
  }
  options.subcommand = positional[0] || null;
  if (positional.length > 1) throw new Error(`unexpected argument: ${positional[1]}`);
  if (options.runId !== null && String(options.runId).trim() === '') throw new Error('missing value for --run-id');
  if (options.root !== null && String(options.root).trim() === '') throw new Error('missing value for --root');
  return options;
}

function main(argv) {
  let options = null;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.subcommand !== 'run') {
    process.stderr.write(`ERROR: expected subcommand "run"\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = runRetro(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      process.stdout.write(`retro: wrote ${result.outputs.markdown}\n`);
      process.stdout.write(`retro: wrote ${result.outputs.json}\n`);
    }
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  CANDIDATE_FIELDS,
  CATEGORIES,
  SEVERITIES,
  buildReport,
  candidateContract,
  collectExpectedArtifacts,
  collectSignals,
  inspectArtifacts,
  isHostLogPath,
  main,
  parseArgs,
  renderMarkdown,
  runRetro,
  selectRun,
  validateCandidate
};
