#!/usr/bin/env node
'use strict';
/**
 * sdw-fixer Tier-3 helper (stdlib only: fs, path, child_process).
 * Validates findings, scores them, sweeps defect-class siblings via grep,
 * injects .sdw/traps.md memory hints, applies deterministic trivial patches,
 * and writes a JSON result report.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SEVERITY_SCORE = { critical: 100, high: 75, medium: 50, low: 25 };
const RULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CORE_MODULES = new Set(['fs', 'path', 'os', 'child_process', 'util']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_PREFIXES = ['.sdw/state', '.sdw/sandbox'];
const MAX_FILE_BYTES = 256 * 1024;
const MAX_HITS = 50;
const MAX_SCANNED_FILES = 2000;
const SNIPPET_LEN = 160;

const TRIVIAL_RULES = {
  no_debugger_statements: {
    tokens: ['debugger'],
    linePattern: /^\s*debugger\s*;?\s*$/
  }
};

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, '.sdw')) ||
        fs.existsSync(path.join(curr, '.git')) ||
        fs.existsSync(path.join(curr, 'skills')) ||
        fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

function parseArgs(args) {
  const o = { subcommand: null, findings: null, report: null, dryRun: false, json: false, verify: null, root: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--findings') o.findings = args[++i];
    else if (a.startsWith('--findings=')) o.findings = a.slice(11);
    else if (a === '--report') o.report = args[++i];
    else if (a.startsWith('--report=')) o.report = a.slice(9);
    else if (a === '--verify') o.verify = args[++i];
    else if (a.startsWith('--verify=')) o.verify = a.slice(9);
    else if (a === '--root') o.root = args[++i];
    else if (a.startsWith('--root=')) o.root = a.slice(7);
    else if (!a.startsWith('-')) positional.push(a);
  }
  o.subcommand = positional[0] || null;
  return o;
}

function isUnsafePath(file) {
  if (typeof file !== 'string' || file.trim() === '') return 'empty file path';
  const f = file.trim();
  if (path.isAbsolute(f) || /^[A-Za-z]:[\\/]/.test(f) || f.startsWith('/')) return 'absolute paths are rejected';
  if (f.split(/[\\/]/).includes('..')) return '".." traversal is rejected';
  return null;
}

function loadFindings(findingsPath, root) {
  const resolved = path.isAbsolute(findingsPath) ? findingsPath : path.resolve(root, findingsPath);
  if (!fs.existsSync(resolved)) return { error: `Findings file not found: ${findingsPath}` };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    return { error: `Findings file is not valid JSON: ${e.message}` };
  }
  const batchId = (data && typeof data === 'object' && !Array.isArray(data) && data.batchId) || `fix-${Date.now()}`;
  const list = Array.isArray(data) ? data : data.findings;
  if (!Array.isArray(list)) return { error: 'Findings payload must be an array or { batchId, findings: [...] }' };
  return { batchId, list };
}

function validateFinding(entry, idx) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return [`finding[${idx}]: entry must be an object`];
  const pathProblem = isUnsafePath(entry.file);
  if (pathProblem) errors.push(`finding[${idx}]: invalid file (${pathProblem})`);
  if (typeof entry.rule !== 'string' || entry.rule.trim() === '' || !RULE_PATTERN.test(entry.rule.trim())) {
    errors.push(`finding[${idx}]: rule must match ${RULE_PATTERN}`);
  }
  if (typeof entry.evidence !== 'string' || entry.evidence.trim() === '') {
    errors.push(`finding[${idx}]: evidence reference is required`);
  }
  if (entry.line !== undefined && entry.line !== null &&
      (!Number.isInteger(entry.line) || entry.line < 1)) {
    errors.push(`finding[${idx}]: line must be a positive integer when present`);
  }
  return errors;
}

function scoreOf(finding) {
  const hint = String(finding.severityHint || 'medium').toLowerCase();
  return SEVERITY_SCORE[hint] !== undefined ? SEVERITY_SCORE[hint] : SEVERITY_SCORE.medium;
}

function ruleKeywords(rule) {
  return String(rule).toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'with'].includes(w));
}

function tokensForRule(rule) {
  if (TRIVIAL_RULES[rule]) return TRIVIAL_RULES[rule].tokens;
  return [rule];
}

function shouldSkipFile(relPath, stat) {
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return true;
  const parts = relPath.split('/');
  if (parts.some(p => SKIP_DIRS.has(p))) return true;
  if (SKIP_PREFIXES.some(p => relPath === p || relPath.startsWith(p + '/'))) return true;
  return false;
}

function grepSiblings(root, rule) {
  const tokens = tokensForRule(rule);
  const hits = [];
  let scanned = 0;
  const stack = [root];
  while (stack.length > 0 && hits.length < MAX_HITS && scanned < MAX_SCANNED_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (hits.length >= MAX_HITS || scanned >= MAX_SCANNED_FILES) break;
      const abs = path.join(dir, entry.name);
      const rel = norm(path.relative(root, abs));
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else {
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch (e) {
          continue;
        }
        if (shouldSkipFile(rel, stat)) continue;
        scanned += 1;
        let content;
        try {
          content = fs.readFileSync(abs, 'utf8');
        } catch (e) {
          continue;
        }
        if (content.indexOf('\0') !== -1) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const matched = tokens.some(t => lines[i].includes(t));
          if (matched) {
            hits.push({ file: rel, line: i + 1, snippet: lines[i].trim().slice(0, SNIPPET_LEN) });
            if (hits.length >= MAX_HITS) break;
          }
        }
      }
    }
  }
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { hits, scanned };
}

function readMemoryHints(root, rule) {
  const trapsPath = path.join(root, '.sdw', 'traps.md');
  if (!fs.existsSync(trapsPath)) return { hints: [], skipped: true };
  let content;
  try {
    content = fs.readFileSync(trapsPath, 'utf8');
  } catch (e) {
    return { hints: [], skipped: true };
  }
  const ruleLower = String(rule).toLowerCase();
  const keywords = ruleKeywords(rule);
  const hints = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter((c, i, arr) => i > 0 && i < arr.length);
    if (cells.length < 5 || /^slugs?$/i.test(cells[0]) || /^-+$/.test(cells[0])) continue;
    const rowLower = cells.join(' ').toLowerCase();
    const matched = rowLower.includes(ruleLower) || keywords.some(k => rowLower.includes(k));
    if (matched) {
      hints.push({ slug: cells[0], title: cells[1], action: cells[3] });
      if (hints.length >= 5) break;
    }
  }
  return { hints, skipped: false };
}

function applyTrivialFix(root, finding, siblingHits, dryRun) {
  const catalog = TRIVIAL_RULES[finding.rule];
  const file = finding.file.trim();
  if (!catalog) return { status: 'skipped', reason: 'non-trivial: requires agent reasoning' };
  const abs = path.resolve(root, file);
  if (!fs.existsSync(abs)) return { status: 'skipped', reason: 'file-not-found on disk' };
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { status: 'skipped', reason: `unreadable file: ${e.message}` };
  }
  const lines = content.split('\n');
  const siblingLines = new Set(
    siblingHits.filter(h => h.file === norm(file)).map(h => h.line)
  );
  const targets = new Set();
  if (finding.line && lines[finding.line - 1] !== undefined &&
      catalog.linePattern.test(lines[finding.line - 1])) {
    targets.add(finding.line);
  }
  for (const ln of siblingLines) {
    if (lines[ln - 1] !== undefined && catalog.linePattern.test(lines[ln - 1])) targets.add(ln);
  }
  if (targets.size === 0) {
    return { status: 'skipped', reason: 'pattern mismatch at cited line and sibling lines' };
  }
  const removed = Array.from(targets).sort((a, b) => a - b);
  if (!dryRun) {
    const next = lines.filter((_, i) => !targets.has(i + 1)).join('\n');
    fs.writeFileSync(abs, next, 'utf8');
  }
  return { status: dryRun ? 'simulated' : 'fixed', removed };
}

function runVerification(root, command) {
  if (!command) {
    return { exitCode: null, status: 'skipped', reason: 'no --verify command given' };
  }
  const res = spawnSync(command, { cwd: root, shell: true, timeout: 600000, encoding: 'utf8' });
  return {
    exitCode: res.status !== null && res.status !== undefined ? res.status : 1,
    status: res.status === 0 ? 'passed' : 'failed',
    command,
    tail: norm(((res.stdout || '') + (res.stderr || '')).slice(-2000))
  };
}

function cmdRun(options) {
  const root = path.resolve(options.root || findProjectRoot());
  if (!options.findings) return { exit: 1, error: 'run requires --findings <path>' };
  if (!options.report) return { exit: 1, error: 'run requires --report <path>' };

  const loaded = loadFindings(options.findings, root);
  if (loaded.error) return { exit: 1, error: loaded.error };

  const errors = [];
  loaded.list.forEach((entry, idx) => errors.push(...validateFinding(entry, idx)));
  if (errors.length > 0) return { exit: 1, error: errors.join('; ') };

  const scored = loaded.list.map((f, i) => ({ finding: f, index: i, score: scoreOf(f) }));
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  console.log(`[sdw-fixer] Scoring ${scored.length} findings`);

  const fixed = [];
  const skipped = [];
  const wouldFix = [];
  const details = [];

  for (const { finding, score } of scored) {
    const file = finding.file.trim();
    const { hits, scanned } = grepSiblings(root, finding.rule.trim());
    const mem = readMemoryHints(root, finding.rule.trim());
    console.log(`[sdw-fixer] Memory hints for ${finding.rule.trim()}: ${mem.hints.length} hit(s)`);
    const sourcesConsulted = [
      `code-grep:${hits.length} hits/${scanned} files`,
      mem.skipped ? 'memory-traps:consult-skipped' : `memory-traps:${mem.hints.length} hints`,
      'pr-context:consult-skipped'
    ];
    const outcome = applyTrivialFix(root, finding, hits, options.dryRun);
    const detail = {
      file, line: finding.line || null, rule: finding.rule.trim(),
      score, sourcesConsulted, siblingHits: hits,
      memoryHints: mem.hints, outcome: outcome.status
    };
    if (outcome.status === 'fixed') {
      for (const ln of outcome.removed) fixed.push({ file, line: ln, defectClass: finding.rule.trim() });
    } else if (outcome.status === 'simulated') {
      for (const ln of outcome.removed) wouldFix.push({ file, line: ln, defectClass: finding.rule.trim() });
      detail.simulatedLines = outcome.removed;
    } else {
      skipped.push({ file, reason: outcome.reason });
      detail.skipReason = outcome.reason;
    }
    details.push(detail);
  }

  const verification = runVerification(root, options.verify);
  const status = verification.status === 'failed' ? 'verify-failed'
    : loaded.list.length === 0 ? 'no-op' : 'completed';
  const report = {
    batchId: loaded.batchId,
    status,
    fixed,
    skipped,
    wouldFix,
    verification: { exitCode: verification.exitCode, status: verification.status,
      ...(verification.reason ? { reason: verification.reason } : {}),
      ...(verification.command ? { command: verification.command } : {}) },
    reportPath: options.report,
    details
  };
  const reportAbs = path.isAbsolute(options.report) ? options.report : path.resolve(root, options.report);
  fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
  fs.writeFileSync(reportAbs, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`[sdw-fixer] Report written to ${norm(path.relative(root, reportAbs))}`);

  if (options.json) console.log(JSON.stringify({ batchId: report.batchId, status, fixed, skipped, wouldFix, verification: report.verification }, null, 2));
  else console.log(`[sdw-fixer] Batch ${report.batchId}: ${fixed.length} fixed, ${skipped.length} skipped${options.dryRun ? `, ${wouldFix.length} would-fix (dry-run)` : ''}, verification ${verification.status}`);

  return { exit: verification.status === 'failed' ? 1 : 0, report };
}

function cmdDoctor(options) {
  const root = path.resolve(options.root || findProjectRoot());
  const issues = [];
  const skillDir = path.join(root, 'skills', 'sdw-fixer');

  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    issues.push('SKILL.md missing');
  } else {
    const content = fs.readFileSync(skillMd, 'utf8');
    const lineCount = content.split(/\r?\n/).length;
    if (lineCount > 120) issues.push(`SKILL.md exceeds 120 lines (${lineCount})`);
    if (!/>\s*When this skill is loaded,\s*output/i.test(content)) issues.push('SKILL.md missing announcement banner');
    if (!/sdw-rules/i.test(content)) issues.push('SKILL.md missing sdw-rules reference');
  }
  if (!fs.existsSync(path.join(skillDir, 'references', 'fixer_protocol.md'))) {
    issues.push('references/fixer_protocol.md missing');
  }
  const selfCheck = spawnSync(process.execPath, ['--check', __filename], { encoding: 'utf8' });
  if (selfCheck.status !== 0) issues.push(`script syntax check failed: ${(selfCheck.stderr || '').trim()}`);
  try {
    const src = fs.readFileSync(__filename, 'utf8');
    const requires = Array.from(src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map(m => m[1]);
    const external = requires.filter(r => !CORE_MODULES.has(r) && !r.startsWith('.') && !r.startsWith('/'));
    if (external.length > 0) issues.push(`external runtime dependencies: ${external.join(', ')}`);
  } catch (e) {
    issues.push(`cannot self-inspect requires: ${e.message}`);
  }

  const passed = issues.length === 0;
  const result = { passed, skill: 'sdw-fixer', issues,
    summary: passed ? 'sdw-fixer doctor passed.' : `sdw-fixer doctor failed: ${issues.join('; ')}` };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sdw-fixer doctor] ${result.summary}`);
  return { exit: passed ? 0 : 1, result };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.subcommand || options.subcommand === 'help' || options.subcommand === '--help') {
    console.log(`sdw-fixer — shared findings intake and surgical remediation
Usage:
  node sdw_fixer.cjs run --findings <path> --report <path> [--dry-run] [--json] [--verify <cmd>] [--root <path>]
  node sdw_fixer.cjs doctor [--json] [--root <path>]`);
    process.exit(0);
  }
  if (options.subcommand === 'run') {
    const r = cmdRun(options);
    if (r.error) console.error(`[sdw-fixer] Error: ${r.error}`);
    process.exit(r.exit);
  }
  if (options.subcommand === 'doctor') {
    const r = cmdDoctor(options);
    process.exit(r.exit);
  }
  console.error(`[sdw-fixer] Unknown subcommand "${options.subcommand}". Use run or doctor.`);
  process.exit(1);
}

module.exports = {
  findProjectRoot, loadFindings, validateFinding, scoreOf,
  grepSiblings, readMemoryHints, applyTrivialFix, cmdRun, cmdDoctor
};

if (require.main === module) main();
