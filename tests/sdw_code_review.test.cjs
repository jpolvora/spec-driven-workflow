'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const codeReview = require('../skills/sdw-code-review/scripts/sdw_code_review.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(REPO_ROOT, 'skills', 'sdw-code-review');
const CLI = path.join(SKILL_DIR, 'scripts', 'sdw_code_review.cjs');

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function initRepoWithMain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-cr-'));
  git(dir, 'init -b main');
  git(dir, 'config user.email "test@example.com"');
  git(dir, 'config user.name "Test"');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n', 'utf8');
  git(dir, 'add README.md');
  git(dir, 'commit -m "init"');
  return dir;
}

test('AC1: Standalone skill adheres to 3-Tier standard (SKILL.md <= 120 lines)', () => {
  const skillMd = path.join(SKILL_DIR, 'SKILL.md');
  assert.ok(fs.existsSync(skillMd), 'SKILL.md exists');
  const content = fs.readFileSync(skillMd, 'utf8');
  const lines = content.split(/\r?\n/);
  assert.ok(lines.length <= 120, `SKILL.md must be <= 120 lines (got ${lines.length})`);
  assert.ok(content.includes('> When this skill is loaded, output "sdw-code-review loaded."'), 'banner required');
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, 'frontmatter present');
  assert.ok(/name:\s*sdw-code-review/.test(content), 'frontmatter name');
  assert.ok(/invocation_names:/.test(content), 'invocation_names present');
  assert.ok(content.includes('sdw-code-review run') || content.includes('`run'), 'documents run subcommand');
  assert.ok(content.includes('fix'), 'documents fix subcommand');
  assert.ok(content.includes('doctor'), 'documents doctor subcommand');
  assert.ok(fs.existsSync(path.join(SKILL_DIR, 'references', 'code_review_rules.md')), 'Tier-2 reference exists');
  assert.ok(fs.existsSync(CLI), 'Tier-3 script exists');
});

test('AC2: Zero external runtime dependencies (Node stdlib only)', () => {
  const code = fs.readFileSync(CLI, 'utf8');
  const reqs = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const allowed = new Set(['fs', 'path', 'child_process', 'os', 'module']);
  for (const r of reqs) {
    if (r.startsWith('.') || r.startsWith('/')) continue;
    const bare = r.replace(/^node:/, '').split('/')[0];
    assert.ok(allowed.has(bare) || allowed.has(r), `Only stdlib allowed, found "${r}"`);
  }
  assert.ok(!code.includes('axios') && !code.includes('express'), 'no external deps');
});

test('AC3: CLI entrypoint supports base, target, report, fix, and JSON options', () => {
  const parsed = codeReview.parseArgs(['run', '--base', 'main', '--target', '/tmp/x', '--report', '/tmp/r.md', '--fix', '--dry-run', '--json', '--max-iterations', '2']);
  assert.equal(parsed.subcommand, 'run');
  assert.equal(parsed.base, 'main');
  assert.equal(parsed.target, '/tmp/x');
  assert.equal(parsed.report, '/tmp/r.md');
  assert.equal(parsed.fix, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.maxIterations, 2);

  const parsedFix = codeReview.parseArgs(['fix', '--target', '/tmp/x']);
  assert.equal(parsedFix.subcommand, 'fix');
  assert.equal(parsedFix.fix, true);

  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--base') && help.stdout.includes('--target') && help.stdout.includes('--report') && help.stdout.includes('--fix') && help.stdout.includes('--json'));

  const doctor = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { encoding: 'utf8' });
  assert.equal(doctor.status, 0);
  const docJson = JSON.parse(doctor.stdout);
  assert.equal(docJson.passed, true);
});

test('AC4: Auto-detects base branch (config, tracking remote, local fallback)', () => {
  const dir = initRepoWithMain();
  try {
    const resolved = codeReview.resolveBaseRef({ projectRoot: dir });
    assert.ok(resolved.base, 'base resolved');
    assert.ok(['main', 'refs/heads/main'].includes(resolved.base), `expected main, got ${resolved.base}`);
    assert.equal(resolved.source, 'local');

    fs.mkdirSync(path.join(dir, '.sdw'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sdw', 'config.json'), JSON.stringify({ baseBranch: 'main' }), 'utf8');
    const viaConfig = codeReview.resolveBaseRef({ projectRoot: dir });
    assert.equal(viaConfig.source, 'config');

    const explicit = codeReview.resolveBaseRef({ projectRoot: dir, base: 'main' });
    assert.equal(explicit.base, 'main');
    assert.equal(explicit.source, 'explicit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC5: Inspects both committed branch diffs and uncommitted working tree changes', () => {
  const dir = initRepoWithMain();
  try {
    git(dir, 'checkout -b feature');
    fs.writeFileSync(path.join(dir, 'committed.cjs'), '// committed\nconst a = 1;\n// TODO: fix committed\n', 'utf8');
    git(dir, 'add committed.cjs');
    git(dir, 'commit -m "add committed"');
    fs.writeFileSync(path.join(dir, 'uncommitted.cjs'), 'function x() {\n  debugger;\n}\nmodule.exports = { x };\n', 'utf8');

    const report = codeReview.runCodeReview({ projectRoot: dir, base: 'main', report: path.join(dir, 'r.md'), fix: false, dryRun: false, maxIterations: 1 });
    const files = report.reviewedFiles;
    assert.ok(files.includes('committed.cjs'), 'includes committed diff file');
    assert.ok(files.includes('uncommitted.cjs'), 'includes uncommitted file');
    const rules = report.findings.map(f => `${f.file}:${f.rule}`);
    assert.ok(rules.some(r => r.startsWith('committed.cjs:unresolved_todos')), 'flags committed TODO');
    assert.ok(rules.some(r => r.startsWith('uncommitted.cjs:no_debugger_statements')), 'flags uncommitted debugger');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC6 & AC7: Evaluates simplicity anti-patterns and hygiene (debugger, TODO, secrets)', () => {
  const dir = initRepoWithMain();
  try {
    fs.writeFileSync(path.join(dir, 'bad.cjs'), 'function f() {\n  debugger;\n  // TODO: remove me\n  const key = "AKIAIOSFODNN7EXAMPLE";\n}\nmodule.exports = { f };\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'demo', 'helper.py'), 'print("hi")\n', 'utf8');

    const report = codeReview.runCodeReview({ projectRoot: dir, base: 'HEAD', report: path.join(dir, 'r2.md'), fix: false, dryRun: false, maxIterations: 1 });
    const byRule = {};
    for (const f of report.findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
    assert.ok(byRule.no_debugger_statements >= 1, 'detects debugger');
    assert.ok(byRule.unresolved_todos >= 1, 'detects TODO');
    assert.ok(byRule.hardcoded_secret >= 1, 'detects hardcoded secret');
    assert.ok(byRule.no_python_in_skills >= 1, 'detects python in skills');
    const dbg = report.findings.find(f => f.rule === 'no_debugger_statements');
    assert.equal(dbg.severity, 'critical');
    const todo = report.findings.find(f => f.rule === 'unresolved_todos');
    assert.equal(todo.severity, 'warning');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC8: Findings carry stable IDs, severity, file:line, rule, and fix prescription', () => {
  const dir = initRepoWithMain();
  try {
    fs.writeFileSync(path.join(dir, 'a.cjs'), 'function a() {\n  debugger;\n}\nmodule.exports = { a };\n', 'utf8');
    const r1 = codeReview.runCodeReview({ projectRoot: dir, base: 'HEAD', report: path.join(dir, 'r.md'), fix: false, dryRun: false, maxIterations: 1 });
    assert.ok(r1.findings.length >= 1);
    for (const f of r1.findings) {
      assert.match(f.id, /^CR-\d{3}$/);
      assert.ok(['critical', 'warning', 'suggestion'].includes(f.severity));
      assert.match(f.path, /^.+:\d+$/);
      assert.ok(f.rule && f.rule.length > 0);
      assert.ok(f.fix && f.fix.length > 10, 'actionable fix prescription');
      assert.ok(f.message && f.message.length > 0);
      assert.ok(f.hunk !== undefined);
      assert.ok(['open', 'fixed', 'planned'].includes(f.status));
    }
    const ids1 = r1.findings.map(f => f.id).join(',');
    const r2 = codeReview.runCodeReview({ projectRoot: dir, base: 'HEAD', report: path.join(dir, 'r.md'), fix: false, dryRun: false, maxIterations: 1 });
    assert.equal(r2.findings.map(f => f.id).join(','), ids1, 'IDs stable across runs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC9: Structured report artifact doubles as executable fix plan', () => {
  const dir = initRepoWithMain();
  try {
    fs.writeFileSync(path.join(dir, 'plan.cjs'), 'function p() {\n  debugger;\n}\nmodule.exports = { p };\n', 'utf8');
    const reportPath = path.join(dir, '.sdw', 'state', 'code-review.report.md');
    const report = codeReview.runCodeReview({ projectRoot: dir, base: 'HEAD', report: reportPath, fix: false, dryRun: false, maxIterations: 1 });
    assert.ok(fs.existsSync(reportPath), 'markdown report persisted');
    const md = fs.readFileSync(reportPath, 'utf8');
    assert.ok(md.includes('# Code Review Report'), 'header present');
    assert.ok(md.includes('Target Branch') && md.includes('Base Branch'), 'branch header');
    assert.ok(md.includes('| ID | Severity | Path | Rule | Status |'), 'findings table');
    assert.ok(md.includes('## Detailed Findings'), 'detailed section');
    assert.ok(md.includes('## Fix Plan'), 'fix plan section');
    assert.ok(md.includes('CR-'), 'finding IDs in plan');
    assert.ok(report.reportPath.endsWith('code-review.report.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC10: Automated fix executes surgical fixes up to iteration ceiling', () => {
  const dir = initRepoWithMain();
  try {
    const target = path.join(dir, 'fixme.cjs');
    fs.writeFileSync(target, 'function f() {\n  debugger;\n  return 1;\n}\nmodule.exports = { f };\n', 'utf8');
    const report = codeReview.runCodeReview({ projectRoot: dir, base: 'HEAD', report: path.join(dir, 'r.md'), fix: true, dryRun: false, maxIterations: 3 });
    assert.ok(report.fixedFiles.includes('fixme.cjs'), 'records fixed file');
    assert.ok(report.fixedCount >= 1);
    const after = fs.readFileSync(target, 'utf8');
    assert.ok(!after.includes('debugger'), 'debugger removed surgically');
    assert.ok(after.includes('return 1'), 'surrounding code preserved');
    assert.equal(report.passed, true, 'passes after fixable resolved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC11: Dry-run simulates fixes without modifying files', () => {
  const dir = initRepoWithMain();
  try {
    const target = path.join(dir, 'dry.cjs');
    const before = 'function d() {\n  debugger;\n  return 2;\n}\nmodule.exports = { d };\n';
    fs.writeFileSync(target, before, 'utf8');
    const report = codeReview.runCodeReview({ projectRoot: dir, base: 'HEAD', report: path.join(dir, 'r.md'), fix: true, dryRun: true, maxIterations: 3 });
    assert.equal(report.dryRun, true);
    assert.ok(report.plannedFixes.length >= 1, 'reports planned fixes');
    assert.equal(fs.readFileSync(target, 'utf8'), before, 'file untouched in dry-run');
    const md = fs.readFileSync(path.join(dir, 'r.md'), 'utf8');
    assert.ok(md.includes('dry-run') || md.includes('Dry-run'), 'report notes dry-run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC12, AC13 & AC14: Orchestrator Step 7 delegates to sdw-code-review as sole authority', () => {
  const orchSkill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-orch', 'SKILL.md'), 'utf8');
  assert.ok(orchSkill.includes('sdw-code-review'), 'SKILL.md Step 7 references sdw-code-review');
  assert.ok(orchSkill.includes('sole code review authority') || orchSkill.includes('sole review authority'), 'sole authority stated');

  const protocol = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-orch', 'references', 'orchestrator_protocol.md'), 'utf8');
  assert.ok(protocol.includes('sdw-code-review'), 'protocol references delegation');
  assert.ok(protocol.includes('sdw_code_review.cjs'), 'protocol names CLI runner');

  const orchCode = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs'), 'utf8');
  assert.ok(orchCode.includes('sdw-code-review/scripts/sdw_code_review.cjs'), 'orchestrator delegates via CLI');
  assert.ok(orchCode.includes('Delegated Review') || orchCode.includes('Delegated Code Review'), 'delegation logging');
  assert.ok(!orchCode.includes("require('./review_runner.cjs')"), 'duplicated internal review removed from orchestrator');

  const wrapper = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-orch', 'scripts', 'review_runner.cjs'), 'utf8');
  assert.ok(wrapper.includes('sdw-code-review'), 'legacy runner delegates to sdw-code-review');

  const dagCode = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-orch', 'scripts', 'dag_planner.cjs'), 'utf8');
  assert.ok(dagCode.includes('sdw-code-review/scripts/sdw_code_review.cjs'), 'DAG fallback targets new skill');
});

test('AC15: Router registers sdw-code-review intents and slash commands', () => {
  const sdwRouter = require('../skills/sdw-router/scripts/sdw_router.cjs');
  const res = sdwRouter.routePrompt('run a deep code review on my working tree changes');
  assert.equal(res.matched, true);
  assert.equal(res.targetSkill, 'sdw-code-review');

  const explicit = sdwRouter.routePrompt('/sdw-code-review run');
  assert.equal(explicit.matched, true);
  assert.equal(explicit.targetSkill, 'sdw-code-review');
  assert.equal(explicit.confidence, 1.0);

  assert.ok(sdwRouter.INTENT_RULES['sdw-code-review'], 'INTENT_RULES includes skill');
  const table = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'sdw-router', 'references', 'routing_table.md'), 'utf8');
  assert.ok(table.includes('sdw-code-review'), 'routing table documents skill');
});

test('AC16: Blocking findings return non-zero exit with unresolved report', () => {
  const dir = initRepoWithMain();
  try {
    fs.writeFileSync(path.join(dir, 'blocked.cjs'), '// TODO: must fix\nconst x = 1;\nmodule.exports = { x };\n', 'utf8');
    const proc = spawnSync(process.execPath, [CLI, 'run', '--target', dir, '--base', 'HEAD', '--json'], { encoding: 'utf8' });
    assert.notEqual(proc.status, 0, 'exits non-zero when warnings remain');
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.passed, false);
    assert.ok((parsed.warningCount + parsed.errorCount) > 0);
    assert.ok(parsed.findings.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Negative: invalid base, invalid target, and non-git workspace fail closed', () => {
  const dir = initRepoWithMain();
  try {
    const badBase = spawnSync(process.execPath, [CLI, 'run', '--target', dir, '--base', 'no-such-ref-xyz', '--json'], { encoding: 'utf8' });
    assert.equal(badBase.status, 1);
    assert.ok((JSON.parse(badBase.stdout).error || '').toLowerCase().includes('base'));

    const badTarget = spawnSync(process.execPath, [CLI, 'run', '--target', path.join(dir, 'missing'), '--json'], { encoding: 'utf8' });
    assert.equal(badTarget.status, 1);

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-cr-plain-'));
    try {
      const noGit = spawnSync(process.execPath, [CLI, 'run', '--target', plain, '--json'], { encoding: 'utf8' });
      assert.equal(noGit.status, 1);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
