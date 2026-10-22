'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPORT_SUFFIX = '-report.md';

function normalizePath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

function escapeCell(value) {
  return String(value == null ? '' : value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function toProjectRelative(root, absPath) {
  const relative = normalizePath(path.relative(root, absPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return normalizePath(path.basename(absPath));
  }
  return relative;
}

/**
 * Spec 00054 AC1: the report is the companion file beside the specification,
 * named `{specFileNameWithoutExtension}-report.md`.
 */
function resolveReportPath(targetRoot, specPath) {
  if (!specPath) return null;
  const root = path.resolve(targetRoot || process.cwd());
  const absSpec = path.isAbsolute(specPath) ? specPath : path.resolve(root, specPath);
  const extension = path.extname(absSpec);
  const baseName = extension ? path.basename(absSpec, extension) : path.basename(absSpec);
  return path.join(path.dirname(absSpec), `${baseName}${REPORT_SUFFIX}`);
}

function resolveNowIso(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  if (typeof now === 'string' && now.trim()) {
    const parsed = new Date(now.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function formatDuration(durationMs) {
  if (durationMs === null || durationMs === undefined) return 'n/a';
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) return 'n/a';
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function durationBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function readSpecTitle(targetRoot, specPath, fallbackSlug) {
  try {
    if (!specPath) return fallbackSlug;
    const absSpec = path.isAbsolute(specPath) ? specPath : path.resolve(targetRoot, specPath);
    const raw = fs.readFileSync(absSpec, 'utf8');
    const frontMatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontMatter) {
      const titleLine = frontMatter[1].match(/^title:\s*(.+)$/m);
      if (titleLine && titleLine[1].trim()) {
        return titleLine[1].trim().replace(/^["']|["']$/g, '');
      }
    }
    const heading = raw.match(/^#\s+(.+)$/m);
    if (heading && heading[1].trim()) return heading[1].trim();
  } catch (e) {
    // Fall through to the slug: a missing title must not stop the report.
  }
  return fallbackSlug || 'Untitled specification';
}

function runGit(root, args) {
  try {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.status !== 0) return null;
    return String(result.stdout || '');
  } catch (e) {
    return null;
  }
}

function collectCommits(root, baseCommit) {
  if (!baseCommit) return null;
  const output = runGit(root, ['log', '--format=%h%x09%s', `${baseCommit}..HEAD`]);
  if (output === null) return null;
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const separator = line.indexOf('\t');
      return separator === -1
        ? { sha: line.trim(), subject: '' }
        : { sha: line.slice(0, separator).trim(), subject: line.slice(separator + 1).trim() };
    });
}

function resolveCommitSubject(root, sha) {
  const output = runGit(root, ['show', '-s', '--format=%s', sha]);
  return output ? output.split(/\r?\n/)[0].trim() : '';
}

/**
 * Raw `git diff --name-status` entries. Renames keep `previousPath` so the
 * breaking-change detector can cite the layout change.
 */
function collectGitChanges(root, baseCommit) {
  if (!baseCommit) return null;
  const output = runGit(root, ['diff', '--name-status', `${baseCommit}..HEAD`]);
  if (output === null) return null;
  const entries = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const rawCode = String(fields[0] || '').charAt(0);
    if ((rawCode === 'R' || rawCode === 'C') && fields[1] && fields[2]) {
      entries.push({
        code: rawCode === 'R' ? 'D' : 'A',
        path: normalizePath(fields[1]),
        previousPath: rawCode === 'R' ? normalizePath(fields[1]) : null,
        renamedTo: normalizePath(fields[2])
      });
      entries.push({
        code: 'A',
        path: normalizePath(fields[2]),
        previousPath: rawCode === 'R' ? normalizePath(fields[1]) : null,
        renamedTo: null
      });
      continue;
    }
    if (fields[1]) {
      entries.push({ code: rawCode || 'M', path: normalizePath(fields[1]), previousPath: null, renamedTo: null });
    }
  }
  return entries;
}

function changeTypeForCode(code) {
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  return 'modified';
}

function collectChangedFiles(root, baseCommit, changes) {
  const entries = changes || collectGitChanges(root, baseCommit);
  if (!entries) return null;
  const files = new Map();
  for (const entry of entries) {
    if (!files.has(entry.path)) files.set(entry.path, changeTypeForCode(entry.code));
  }
  return files;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

function flattenJsonKeys(value, prefix, result) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        flattenJsonKeys(child, nextPrefix, result);
      } else {
        result[nextPrefix] = JSON.stringify(child);
      }
    }
    return result;
  }
  if (prefix) result[prefix] = JSON.stringify(value);
  return result;
}

function readGitFile(root, baseCommit, relPath) {
  return runGit(root, ['show', `${baseCommit}:${relPath}`]);
}

function readWorkingFile(root, relPath) {
  try {
    return fs.readFileSync(path.resolve(root, relPath), 'utf8');
  } catch (e) {
    return null;
  }
}

function extractCliFlags(content) {
  const flags = new Set();
  if (!content) return flags;
  for (const match of String(content).matchAll(/--[a-zA-Z0-9][a-zA-Z0-9-]*/g)) {
    flags.add(match[0]);
  }
  return flags;
}

function isSkillsScript(relPath) {
  return /^skills\/.+\/scripts\/[^/]+\.cjs$/.test(normalizePath(relPath));
}

/**
 * Spec 00054 AC7: deterministic, citation-based candidates. No prose inference:
 * every candidate comes from a diff path and the values found on each side.
 */
function detectBreakingChanges(root, baseCommit, changes) {
  const entries = changes || collectGitChanges(root, baseCommit);
  if (!entries) return { available: false, candidates: [] };

  const candidates = [];
  const changedPaths = new Set(entries.map((entry) => normalizePath(entry.path)));

  for (const relPath of ['.sdw/config.json', '.sdw/config.schema.json']) {
    if (!changedPaths.has(relPath)) continue;
    const isSchema = relPath.endsWith('.schema.json');
    const beforeRaw = readGitFile(root, baseCommit, relPath);
    const afterRaw = readWorkingFile(root, relPath);
    if (beforeRaw === null || afterRaw === null) continue;
    const before = flattenJsonKeys(parseJson(beforeRaw), '', {});
    const after = flattenJsonKeys(parseJson(afterRaw), '', {});
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of allKeys) {
      const hadKey = Object.prototype.hasOwnProperty.call(before, key);
      const hasKey = Object.prototype.hasOwnProperty.call(after, key);
      if (!hadKey && hasKey) {
        candidates.push({
          kind: isSchema ? 'Configuration schema' : 'Configuration key',
          path: relPath,
          detail: `\`${key}\` added with value ${after[key]}`
        });
      } else if (hadKey && !hasKey) {
        candidates.push({
          kind: isSchema ? 'Configuration schema' : 'Configuration key',
          path: relPath,
          detail: `\`${key}\` removed (was ${before[key]})`
        });
      } else if (before[key] !== after[key]) {
        candidates.push({
          kind: isSchema ? 'Configuration schema' : 'Configuration key',
          path: relPath,
          detail: `\`${key}\` changed from ${before[key]} to ${after[key]}`
        });
      }
    }
  }

  for (const relPath of changedPaths) {
    if (!isSkillsScript(relPath)) continue;
    const beforeRaw = readGitFile(root, baseCommit, relPath);
    const afterRaw = readWorkingFile(root, relPath);
    if (beforeRaw === null || afterRaw === null) continue;
    const beforeFlags = extractCliFlags(beforeRaw);
    const afterFlags = extractCliFlags(afterRaw);
    for (const flag of [...afterFlags].sort()) {
      if (!beforeFlags.has(flag)) {
        candidates.push({ kind: 'CLI flag', path: relPath, detail: `\`${flag}\` added` });
      }
    }
    for (const flag of [...beforeFlags].sort()) {
      if (!afterFlags.has(flag)) {
        candidates.push({ kind: 'CLI flag', path: relPath, detail: `\`${flag}\` removed` });
      }
    }
  }

  for (const entry of entries) {
    if (!isSkillsScript(entry.path) && !isSkillsScript(entry.previousPath || '')) continue;
    if (entry.code === 'D' && !entry.renamedTo) {
      candidates.push({ kind: 'File layout', path: entry.path, detail: 'file deleted' });
    }
    if (entry.renamedTo && entry.previousPath) {
      candidates.push({
        kind: 'File layout',
        path: entry.renamedTo,
        detail: `file renamed from \`${entry.previousPath}\``
      });
    }
  }

  const seen = new Set();
  const unique = candidates.filter((candidate) => {
    const key = `${candidate.kind}|${candidate.path}|${candidate.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail));
  return { available: true, candidates: unique };
}

function getDagTaskOrder(state) {
  const dagTasks = Array.isArray(state.dagTasks) ? state.dagTasks : [];
  const order = new Map();
  dagTasks.forEach((task, index) => order.set(task.id, index));
  return order;
}

function getAcceptedTasks(state) {
  const taskMap = (state.steps && state.steps[4] && state.steps[4].tasks) || {};
  const order = getDagTaskOrder(state);
  return Object.entries(taskMap)
    .filter(([, task]) => task && task.status === 'completed')
    .sort(([idA], [idB]) => {
      const indexA = order.has(idA) ? order.get(idA) : Number.MAX_SAFE_INTEGER;
      const indexB = order.has(idB) ? order.get(idB) : Number.MAX_SAFE_INTEGER;
      return indexA - indexB || String(idA).localeCompare(String(idB));
    })
    .map(([id, task]) => ({ id, ...task }));
}

function deriveTaskTimeline(state, tasks) {
  const step3 = (state.steps && state.steps[3]) || {};
  const step4 = (state.steps && state.steps[4]) || {};
  const fallbackStart = step4.startedAt || step3.completedAt || state.createdAt || null;
  let previousCompletedAt = null;
  const rows = tasks.map((task) => {
    const startedAt = task.dispatchedAt || task.startedAt || previousCompletedAt || fallbackStart;
    const completedAt = task.completedAt || null;
    const durationMs = durationBetween(startedAt, completedAt);
    if (completedAt) previousCompletedAt = completedAt;
    return { task, startedAt, completedAt, durationMs };
  });
  const start = rows.length > 0 ? rows[0].startedAt : fallbackStart;
  const end = rows.length > 0
    ? rows[rows.length - 1].completedAt
    : (step4.completedAt || null);
  return { rows, start, end, durationMs: durationBetween(start, end) };
}

function deriveStepWindows(state) {
  const steps = state.steps || {};
  const windows = [];
  let previousEnd = state.createdAt || null;
  for (let stepNumber = 1; stepNumber <= 8; stepNumber++) {
    const step = steps[stepNumber] || {};
    const status = step.status || 'pending';
    const completedAt = step.completedAt || null;
    const startedAt = step.startedAt || (status === 'pending' ? null : previousEnd);
    windows.push({
      step: stepNumber,
      name: step.name || `step_${stepNumber}`,
      status,
      startedAt,
      completedAt,
      durationMs: durationBetween(startedAt, completedAt)
    });
    if (completedAt) previousEnd = completedAt;
  }
  return windows;
}

function collectTaskTestTotals(root, tasks) {
  const totals = { total: 0, passed: 0, failed: 0, skipped: 0, tasksWithEvidence: 0 };
  for (const task of tasks) {
    if (!task.evidencePath) continue;
    const absEvidence = path.isAbsolute(task.evidencePath)
      ? task.evidencePath
      : path.resolve(root, task.evidencePath);
    let evidence = null;
    try {
      evidence = JSON.parse(fs.readFileSync(absEvidence, 'utf8'));
    } catch (e) {
      continue;
    }
    if (!evidence || !Array.isArray(evidence.tests)) continue;
    totals.tasksWithEvidence += 1;
    for (const testCase of evidence.tests) {
      totals.total += 1;
      const testStatus = testCase && testCase.status;
      if (testStatus === 'passed') totals.passed += 1;
      else if (testStatus === 'failed') totals.failed += 1;
      else if (testStatus === 'skipped') totals.skipped += 1;
    }
  }
  return totals;
}

function renderKeyValueTable(rows) {
  let markdown = '| Field | Value |\n|---|---|\n';
  for (const [field, value] of rows) {
    markdown += `| ${escapeCell(field)} | ${escapeCell(value)} |\n`;
  }
  return markdown;
}

function renderMetadataSection(context) {
  const { state, specRelativePath, minScore, timeline, stepWindows, nowIso } = context;
  const scoreText = state.score === null || state.score === undefined
    ? `(not scored; scoreMin ${minScore})`
    : `${state.score}/10 (scoreMin ${minScore})`;
  const rows = [
    ['Specification file', specRelativePath ? `\`${specRelativePath}\`` : '(not recorded)'],
    ['Specification slug', state.specSlug || '(not recorded)'],
    ['Run ID', state.runId || '(not recorded)'],
    ['Run status', state.status || '(not recorded)'],
    ['Branch', state.branch ? `\`${state.branch}\`` : '(not recorded)'],
    ['Base branch', state.baseBranch ? `\`${state.baseBranch}\`` : '(not recorded)'],
    ['Base commit', state.baseCommit ? `\`${state.baseCommit}\`` : '(not recorded)'],
    ['Delivery commit', state.deliveryCommit ? `\`${state.deliveryCommit}\`` : '(not recorded)'],
    ['Ship status', state.shipStatus || 'pending'],
    ['Score', scoreText],
    ['Implementation start', timeline.start || '(not recorded)'],
    ['Implementation end', timeline.end || '(not recorded)'],
    ['Total wall-clock duration', formatDuration(timeline.durationMs)],
    ['Generated at', nowIso]
  ];
  for (const window of stepWindows) {
    rows.push([
      `Step ${window.step}: ${window.name} (${window.status})`,
      formatDuration(window.durationMs)
    ]);
  }
  return `## Metadata\n\n${renderKeyValueTable(rows)}`;
}

function renderTasksSection(context) {
  const { timeline } = context;
  if (!timeline.rows.length) return '## Tasks\n\nNo accepted tasks recorded.';
  let markdown = '## Tasks\n\n';
  markdown += '| ID | Title | Status | Covered ACs | Checkpoint commit | Started | Completed | Duration |\n';
  markdown += '|---|---|---|---|---|---|---|---|\n';
  for (const row of timeline.rows) {
    const task = row.task;
    const acs = Array.isArray(task.acIds) && task.acIds.length > 0
      ? task.acIds.join(', ')
      : (Array.isArray(task.coveredAcs) && task.coveredAcs.length > 0 ? task.coveredAcs.join(', ') : '(none recorded)');
    const commit = task.commitSha ? `\`${task.commitSha}\`` : '(none)';
    markdown += `| ${escapeCell(task.id)} | ${escapeCell(task.title || '(untitled task)')} | ${escapeCell(task.status)} | ${escapeCell(acs)} | ${escapeCell(commit)} | ${escapeCell(row.startedAt || '(not recorded)')} | ${escapeCell(row.completedAt || '(not recorded)')} | ${escapeCell(formatDuration(row.durationMs))} |\n`;
  }
  return markdown.trimEnd();
}

function renderCommitsSection(context) {
  const { state, commits, deliveryCommitSubject } = context;
  if (commits === null) {
    return '## Commits\n\nGit history is unavailable; commits could not be listed.';
  }
  let markdown = '## Commits\n\n';
  const deliverySha = state.deliveryCommit || null;
  const inRange = Boolean(deliverySha) && commits.some((commit) => commit.sha && deliverySha.startsWith(commit.sha));
  const rows = commits.map((commit) => ({ sha: commit.sha, subject: commit.subject, range: 'base..HEAD' }));
  if (deliverySha && !inRange) {
    rows.push({
      sha: deliverySha.slice(0, 7),
      subject: deliveryCommitSubject || '(subject unavailable)',
      range: 'delivery commit (outside base..HEAD)'
    });
  }
  if (rows.length === 0) return `${markdown}No commits recorded between the base commit and HEAD.`;
  markdown += '| SHA | Subject | Range |\n|---|---|---|\n';
  for (const row of rows) {
    markdown += `| \`${escapeCell(row.sha)}\` | ${escapeCell(row.subject)} | ${escapeCell(row.range)} |\n`;
  }
  return markdown.trimEnd();
}

function resolveTaskFileType(root, filePath, changedFiles) {
  if (changedFiles && changedFiles.has(filePath)) return changedFiles.get(filePath);
  return fs.existsSync(path.resolve(root, filePath)) ? 'modified' : 'deleted';
}

function renderFilesChangedSection(context) {
  const { root, changedFiles, tasks } = context;
  const groups = new Map();
  for (const task of tasks) {
    const files = Array.isArray(task.filesChanged) ? task.filesChanged.map(normalizePath) : [];
    for (const filePath of files) {
      if (!groups.has(task.id)) groups.set(task.id, { title: task.title || task.id, files: [] });
      groups.get(task.id).files.push(filePath);
    }
  }

  const attributed = new Set();
  for (const group of groups.values()) {
    for (const filePath of group.files) attributed.add(filePath);
  }
  const unattributed = [];
  if (changedFiles) {
    for (const filePath of changedFiles.keys()) {
      if (!attributed.has(filePath)) unattributed.push(filePath);
    }
  }

  if (!changedFiles && groups.size === 0) {
    return '## Files Changed\n\nNo changed files recorded.';
  }

  let markdown = '## Files Changed\n\n';
  if (groups.size === 0 && unattributed.length === 0) {
    return `${markdown}No changed files recorded.`;
  }

  for (const [taskId, group] of groups) {
    markdown += `### ${escapeCell(taskId)}: ${escapeCell(group.title)}\n\n`;
    markdown += '| File | Change |\n|---|---|\n';
    const seen = new Set();
    for (const filePath of group.files) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      markdown += `| \`${escapeCell(filePath)}\` | ${escapeCell(resolveTaskFileType(root, filePath, changedFiles))} |\n`;
    }
    markdown += '\n';
  }

  if (unattributed.length > 0) {
    markdown += '### Unattributed changes\n\n';
    markdown += '| File | Change |\n|---|---|\n';
    for (const filePath of unattributed) {
      markdown += `| \`${escapeCell(filePath)}\` | ${escapeCell(resolveTaskFileType(root, filePath, changedFiles))} |\n`;
    }
  }
  return markdown.trimEnd();
}

function renderGate(label, gate) {
  if (!gate) return `- ${label}: not recorded`;
  const parts = [`status \`${gate.status || 'unknown'}\``];
  if (gate.exitCode !== undefined && gate.exitCode !== null) parts.push(`exit code \`${gate.exitCode}\``);
  if (gate.durationMs !== undefined && gate.durationMs !== null) parts.push(`duration ${formatDuration(gate.durationMs)}`);
  if (gate.error) parts.push(`error: ${escapeCell(gate.error)}`);
  return `- ${label}: ${parts.join(', ')}`;
}

function readVerificationGates(state) {
  const step4 = (state.steps && state.steps[4]) || {};
  const topLevel = step4.gates || {};
  if (Object.keys(topLevel).length > 0) return topLevel;
  return (step4.output && step4.output.gates) || {};
}

function renderVerificationSection(context) {
  const { state } = context;
  const gates = readVerificationGates(state);
  const gateNames = Object.keys(gates);
  let markdown = '## Verification\n\n';
  if (gateNames.length === 0) {
    markdown += 'No verification gates recorded.\n';
  } else {
    for (const gateName of gateNames) {
      markdown += `${renderGate(`${gateName} gate`, gates[gateName])}\n`;
    }
  }
  const step8 = state.steps && state.steps[8];
  if (step8 && step8.status && step8.status !== 'pending') {
    markdown += `- Step 8 delivery: \`${step8.status}\`${state.shipStatus ? ` (ship status \`${state.shipStatus}\`)` : ''}\n`;
  }
  return markdown.trimEnd();
}

function countFindings(findings) {
  const counts = { error: 0, warning: 0, suggestion: 0, info: 0 };
  for (const finding of findings || []) {
    const severity = String((finding && finding.severity) || 'info').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, severity)) counts[severity] += 1;
    else counts.info += 1;
  }
  return counts;
}

function summarizeReview(state) {
  const step7 = (state.steps && state.steps[7]) || {};
  const report = step7.output || {};
  const counts = countFindings(report.findings);
  return {
    step7,
    report,
    errorCount: report.errorCount !== undefined ? report.errorCount : counts.error,
    warningCount: report.warningCount !== undefined ? report.warningCount : counts.warning,
    suggestionCount: report.suggestionCount !== undefined ? report.suggestionCount : counts.suggestion,
    blockingCount: report.blockingCount
  };
}

function renderCodeReviewSection(context) {
  const { state } = context;
  const { step7, report, errorCount, warningCount, suggestionCount } = summarizeReview(state);
  let markdown = '## Code Review\n\n';
  if (!step7.status || step7.status === 'pending') {
    return `${markdown}No code review recorded.`;
  }
  markdown += `- Status: \`${step7.status}\`\n`;
  if (step7.status === 'skipped') {
    const reason = (report && report.reason) || 'not recorded';
    return `${markdown}- Reason: ${escapeCell(reason)}`;
  }
  markdown += `- Result: ${report.passed === true ? 'passed' : 'failed'}\n`;
  markdown += `- Findings: ${errorCount} error, ${warningCount} warning, ${suggestionCount} suggestion\n`;
  if (report.blockingCount !== undefined) {
    markdown += `- Blocking findings: ${report.blockingCount}\n`;
  }
  if (step7.artifact) {
    markdown += `- Report: \`${escapeCell(step7.artifact)}\`\n`;
  }
  return markdown.trimEnd();
}

function renderBreakingChangesSection(breaking) {
  let markdown = '## Breaking Changes\n\n';
  if (!breaking.available) {
    return `${markdown}Git history is unavailable; breaking-change candidates could not be detected.`;
  }
  if (breaking.candidates.length === 0) {
    return `${markdown}None detected.`;
  }
  for (const candidate of breaking.candidates) {
    markdown += `- **${candidate.kind}** ${candidate.detail} in \`${candidate.path}\`\n`;
  }
  return markdown.trimEnd();
}

function renderQualitySection(context) {
  const { state, minScore, testTotals } = context;
  const scoring = (state.steps && state.steps[5] && state.steps[5].output) || {};
  const verdicts = (scoring.verdict && Array.isArray(scoring.verdict.verdicts)) ? scoring.verdict.verdicts : null;
  let markdown = '## Quality\n\n';
  const score = state.score !== null && state.score !== undefined
    ? state.score
    : (scoring.score !== null && scoring.score !== undefined ? scoring.score : null);
  markdown += `- Conformance score: ${score === null ? '(not scored)' : `${score}/10`} (scoreMin ${minScore})\n`;
  if (verdicts && verdicts.length > 0) {
    let verified = 0;
    let failed = 0;
    for (const verdict of verdicts) {
      if (verdict && verdict.status === 'verified') verified += 1;
      else if (verdict && verdict.status === 'failed') failed += 1;
    }
    markdown += `- Judge verdicts: ${verified} verified, ${failed} failed (${verdicts.length} judged)\n`;
  } else {
    markdown += '- Judge verdicts: (not judged)\n';
  }

  const review = summarizeReview(state);
  markdown += `- Review findings: ${review.errorCount} error, ${review.warningCount} warning, ${review.suggestionCount} suggestion\n`;
  if (review.blockingCount !== undefined) markdown += `- Blocking findings: ${review.blockingCount}\n`;

  if (testTotals.total === 0) {
    markdown += '- Executed tests: none recorded\n';
  } else {
    markdown += `- Executed tests: ${testTotals.total} recorded across ${testTotals.tasksWithEvidence} accepted task(s) (${testTotals.passed} passed, ${testTotals.failed} failed, ${testTotals.skipped} skipped)\n`;
  }

  const gates = readVerificationGates(state);
  const gateNames = Object.keys(gates);
  markdown += gateNames.length > 0
    ? `- Verification gates: ${gateNames.map((name) => `${name} ${gates[name].status || 'unknown'}`).join(', ')}\n`
    : '- Verification gates: none configured\n';
  return markdown.trimEnd();
}

function renderSpecObservationsSection(context) {
  const { state } = context;
  const step2 = (state.steps && state.steps[2] && state.steps[2].output) || {};
  const observations = Array.isArray(step2.specObservations) ? step2.specObservations : [];
  let markdown = '## Spec Observations\n\n';
  if (observations.length === 0) {
    return `${markdown}None.`;
  }
  markdown += '| Kind | Other specification | Evidence | Severity |\n|---|---|---|---|\n';
  for (const observation of observations) {
    markdown += `| ${escapeCell(observation && observation.kind)} | ${escapeCell(observation && observation.otherSpec)} | ${escapeCell(observation && observation.evidence)} | ${escapeCell(observation && observation.severity)} |\n`;
  }
  return markdown.trimEnd();
}

function renderNotesSection(context) {
  const { state, changedFiles } = context;
  const notes = [];
  const errors = Array.isArray(state.errors) ? state.errors : [];
  for (const error of errors) {
    const label = error && error.warning ? 'Warning' : 'Error';
    notes.push(`${label} (step ${error && error.step}, ${error && error.timestamp}): ${error && error.error}`);
  }

  const steps = state.steps || {};
  for (let stepNumber = 1; stepNumber <= 8; stepNumber++) {
    const step = steps[stepNumber];
    if (!step || step.status !== 'skipped') continue;
    const reason = (step.output && (step.output.reason || step.output.mode)) || 'not recorded';
    notes.push(`Step ${stepNumber} (${step.name || 'step'}) skipped: ${reason}`);
  }

  const dispatch = (steps[4] && steps[4].dispatch) || {};
  for (const abandonment of (dispatch.abandonments || [])) {
    notes.push(`Task ${abandonment.taskId} abandoned at ${abandonment.at || 'unknown time'}: ${abandonment.reason || 'no reason recorded'}`);
  }
  const taskMap = (steps[4] && steps[4].tasks) || {};
  for (const [taskId, task] of Object.entries(taskMap)) {
    if (task && task.status === 'completed' && Number(task.sequence) > 1) {
      notes.push(`Task ${taskId} accepted after re-dispatch (sequence ${task.sequence})`);
    }
  }

  if (state.securityGate && state.securityGate.bypassed) {
    notes.push(`Security gate bypassed: ${state.securityGate.reason || 'no reason recorded'}`);
  }

  const environment = [];
  const changedFileCount = changedFiles ? changedFiles.size : null;
  environment.push(changedFileCount === null ? 'workspace: git history unavailable' : `workspace: ${changedFileCount} changed file(s) in base..HEAD`);
  if (state.branchReused) environment.push('feature branch reused');
  if (state.worktreeSkipReason) environment.push(`worktrees skipped: ${state.worktreeSkipReason}`);
  if (state.sandbox && state.sandbox.enabled) {
    const sandboxPath = state.sandbox.path ? toProjectRelative(context.root, state.sandbox.path) : '(not recorded)';
    environment.push(`sandbox enabled at \`${sandboxPath}\``);
  }
  if (state.runtimeOverrides) {
    environment.push(`runtime overrides: ${JSON.stringify(state.runtimeOverrides)}`);
  }
  if (state.scm) {
    environment.push(`SCM provider: ${state.scm.provider || 'none'}${state.scm.skipped ? ` (skipped: ${state.scm.skipReason || 'not recorded'})` : ''}`);
  }
  if (state.scoreIteration) environment.push(`score iterations: ${state.scoreIteration}`);
  if (state.reviewIteration) environment.push(`review iterations: ${state.reviewIteration}`);
  notes.push(`Environment: ${environment.join('; ')}`);

  return `## Notes\n\n${notes.map((note) => `- ${note}`).join('\n')}`;
}

function renderOutcomeSection(context) {
  const { state, timeline } = context;
  let markdown = '## Outcome\n\n';
  markdown += `- Result: \`${state.status || 'unknown'}\`\n`;
  markdown += `- Delivery commit: ${state.deliveryCommit ? `\`${state.deliveryCommit}\`` : '(not recorded)'}\n`;
  markdown += `- Ship status: \`${state.shipStatus || 'pending'}\`\n`;
  markdown += `- Duration: ${formatDuration(timeline.durationMs)}\n`;
  return markdown.trimEnd();
}

/**
 * Builds the Markdown delivery report (spec 00054 AC1-AC10). The function is
 * read-only: it renders what run state, git, and the evidence files already
 * record and never re-runs a gate or a review.
 */
function buildDeliveryReport(options) {
  const root = path.resolve(options.targetRoot || process.cwd());
  const state = options.state || {};
  const minScore = options.minScore !== undefined && options.minScore !== null
    ? options.minScore
    : (state.scoreMin !== undefined && state.scoreMin !== null ? state.scoreMin : 8);
  const nowIso = resolveNowIso(options.now);
  const specPath = state.specPath || null;
  const specRelativePath = specPath
    ? toProjectRelative(root, path.isAbsolute(specPath) ? specPath : path.resolve(root, specPath))
    : null;
  const specTitle = readSpecTitle(root, specPath, state.specSlug || 'Untitled specification');

  const changes = collectGitChanges(root, state.baseCommit);
  const changedFiles = collectChangedFiles(root, state.baseCommit, changes);
  const commits = collectCommits(root, state.baseCommit);
  const breaking = detectBreakingChanges(root, state.baseCommit, changes);
  const tasks = getAcceptedTasks(state);
  const timeline = deriveTaskTimeline(state, tasks);
  const stepWindows = deriveStepWindows(state);
  const testTotals = collectTaskTestTotals(root, tasks);
  const deliveryCommitSubject = state.deliveryCommit
    ? resolveCommitSubject(root, state.deliveryCommit)
    : '';

  const context = {
    root,
    state,
    minScore,
    nowIso,
    specRelativePath,
    changedFiles,
    commits,
    breaking,
    tasks,
    timeline,
    stepWindows,
    testTotals,
    deliveryCommitSubject
  };

  const sections = [
    `# Delivery Report — ${specTitle}`,
    renderMetadataSection(context),
    renderTasksSection(context),
    renderCommitsSection(context),
    renderFilesChangedSection(context),
    renderVerificationSection(context),
    renderCodeReviewSection(context),
    renderBreakingChangesSection(breaking),
    renderQualitySection(context),
    renderSpecObservationsSection(context),
    renderNotesSection(context),
    renderOutcomeSection(context)
  ];
  return `${sections.join('\n\n')}\n`;
}

/**
 * Writes the report to its companion path, overwriting any previous copy so a
 * resumed run never appends. Returns null when the file cannot be written; the
 * caller records the warning and continues the delivery (AC16).
 */
function writeDeliveryReport(options) {
  const root = path.resolve(options.targetRoot || process.cwd());
  const state = options.state || {};
  const reportPath = resolveReportPath(root, state.specPath);
  if (!reportPath) {
    console.warn('[sdw-orch] Warning: Could not write the delivery report: run state has no specification path.');
    return null;
  }
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, buildDeliveryReport({ ...options, targetRoot: root, state }), 'utf8');
    return { reportPath, relPath: toProjectRelative(root, reportPath) };
  } catch (err) {
    console.warn(`[sdw-orch] Warning: Could not write the delivery report at "${toProjectRelative(root, reportPath)}": ${err.message}`);
    return null;
  }
}

module.exports = {
  REPORT_SUFFIX,
  resolveReportPath,
  formatDuration,
  detectBreakingChanges,
  buildDeliveryReport,
  writeDeliveryReport
};
