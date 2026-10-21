const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const fixer = require('../skills/sdw-fixer/scripts/sdw_fixer.cjs');

// Keep knowledge-backend tests hermetic by default; the live vault test opts back in.
process.env.SDW_FIXER_NO_MEMO = '1';
process.env.SDW_MEMORY_NO_MEMO = '1';

function setupRoot(withTraps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fixer-test-'));
  fs.mkdirSync(path.join(root, '.sdw', 'memory'), { recursive: true });
  if (withTraps) {
    fs.writeFileSync(
      path.join(root, '.sdw', 'memory', 'traps.md'),
      [
        '# Anti-Regression Traps Log',
        '',
        'Central repository log of behavioral and engineering traps to prevent repeating mistakes.',
        '',
        '| Slug | Title | Layer | Avoid | Action | Date |',
        '|---|---|---|---|---|---|',
        ''
      ].join('\n'),
      'utf8'
    );
  }
  fs.writeFileSync(path.join(root, 'buggy.js'), 'const a = 1;\ndebugger;\nmodule.exports = a;\n', 'utf8');
  return root;
}

function writeFindings(root, batchId = 'test-batch') {
  const p = path.join(root, 'findings.json');
  fs.writeFileSync(p, JSON.stringify({
    batchId,
    findings: [{ file: 'buggy.js', line: 2, rule: 'no_debugger_statements', evidence: 'test evidence' }]
  }), 'utf8');
  return p;
}

test('sdw-fixer - fixes defect-class siblings across files and records unpatched siblings', () => {
  const root = setupRoot(true);
  try {
    fs.writeFileSync(path.join(root, 'sibling.js'), 'function x() {\ndebugger;\n}\n', 'utf8');
    fs.writeFileSync(path.join(root, 'mentions.js'), '// note: the debugger keyword appears here but no statement to remove\n', 'utf8');
    const reportPath = path.join(root, 'result.json');
    const r = fixer.cmdRun({ root, findings: writeFindings(root), report: reportPath });
    assert.strictEqual(r.exit, 0);
    assert.strictEqual(r.report.status, 'completed');
    const fixedFiles = r.report.fixed.map(f => f.file).sort();
    assert.deepStrictEqual(fixedFiles, ['buggy.js', 'sibling.js']);
    assert.ok(!fs.readFileSync(path.join(root, 'buggy.js'), 'utf8').includes('debugger;'));
    assert.ok(!fs.readFileSync(path.join(root, 'sibling.js'), 'utf8').includes('debugger;'));
    const mentionSkip = r.report.skipped.find(s => s.file === 'mentions.js');
    assert.ok(mentionSkip, 'unpatched sibling file must be recorded as skipped');
    assert.match(mentionSkip.reason, /pattern mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-fixer - duplicate findings on an already-fixed line report covered, not skipped', () => {
  const root = setupRoot(true);
  try {
    const p = path.join(root, 'findings.json');
    fs.writeFileSync(p, JSON.stringify({
      batchId: 'dup-batch',
      findings: [
        { file: 'buggy.js', line: 2, rule: 'no_debugger_statements', evidence: 'reviewer A' },
        { file: 'buggy.js', line: 2, rule: 'no_debugger_statements', evidence: 'reviewer B' }
      ]
    }), 'utf8');
    const reportPath = path.join(root, 'result.json');
    const r = fixer.cmdRun({ root, findings: p, report: reportPath });
    assert.strictEqual(r.exit, 0);
    assert.strictEqual(r.report.status, 'completed');
    assert.strictEqual(r.report.fixed.length, 1);
    assert.strictEqual(r.report.covered.length, 1);
    assert.deepStrictEqual(r.report.covered[0], { file: 'buggy.js', line: 2, defectClass: 'no_debugger_statements' });
    assert.ok(!r.report.skipped.some(s => s.file === 'buggy.js' && /pattern mismatch/.test(s.reason || '')),
      'duplicate anchor must not be reported as pattern mismatch');
    assert.ok(!fs.readFileSync(path.join(root, 'buggy.js'), 'utf8').includes('debugger'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-fixer - learn registers a trap row for the fixed defect class', () => {
  const root = setupRoot(true);
  try {
    const reportPath = path.join(root, 'result.json');
    const r = fixer.cmdRun({ root, findings: writeFindings(root), report: reportPath });
    assert.strictEqual(r.exit, 0);
    assert.strictEqual(r.report.status, 'completed');
    assert.strictEqual(r.report.fixed.length, 1);
    assert.strictEqual(r.report.learned.length, 1);
    assert.strictEqual(r.report.learned[0].slug, 'no-debugger-statements');
    assert.strictEqual(r.report.learned[0].recorded, true);
    const traps = fs.readFileSync(path.join(root, '.sdw', 'memory', 'traps.md'), 'utf8');
    assert.match(traps, /\| no-debugger-statements \|/);
    assert.ok(!fs.readFileSync(path.join(root, 'buggy.js'), 'utf8').includes('debugger'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-fixer - learn deduplicates an already registered trap slug', () => {
  const root = setupRoot(true);
  try {
    const first = path.join(root, 'r1.json');
    fixer.cmdRun({ root, findings: writeFindings(root, 'b1'), report: first });
    fs.writeFileSync(path.join(root, 'buggy.js'), 'const a = 1;\ndebugger;\nmodule.exports = a;\n', 'utf8');
    const second = path.join(root, 'r2.json');
    const r = fixer.cmdRun({ root, findings: writeFindings(root, 'b2'), report: second });
    assert.strictEqual(r.exit, 0);
    assert.strictEqual(r.report.learned.length, 1);
    assert.strictEqual(r.report.learned[0].recorded, false);
    assert.match(r.report.learned[0].reason, /already registered/);
    const rows = fs.readFileSync(path.join(root, '.sdw', 'memory', 'traps.md'), 'utf8')
      .split('\n').filter(l => l.includes('| no-debugger-statements |'));
    assert.strictEqual(rows.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-fixer - learn creates traps.md when missing and skips on dry-run', () => {
  const root = setupRoot(false);
  try {
    assert.ok(!fs.existsSync(path.join(root, '.sdw', 'memory', 'traps.md')));
    const dry = path.join(root, 'dry.json');
    const r = fixer.cmdRun({ root, findings: writeFindings(root), report: dry, dryRun: true });
    assert.strictEqual(r.exit, 0);
    assert.deepStrictEqual(r.report.learned, []);
    assert.ok(!fs.existsSync(path.join(root, '.sdw', 'memory', 'traps.md')));
    const real = path.join(root, 'real.json');
    const r2 = fixer.cmdRun({ root, findings: writeFindings(root, 'b2'), report: real });
    assert.strictEqual(r2.exit, 0);
    assert.strictEqual(r2.report.learned[0].recorded, true);
    const traps = fs.readFileSync(path.join(root, '.sdw', 'memory', 'traps.md'), 'utf8');
    assert.match(traps, /^# Anti-Regression Traps Log/m);
    assert.match(traps, /\| Slug \| Title \| Layer \| Avoid \| Action \| Date \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-fixer - queries memory files for related knowledge before fixing', () => {
  const root = setupRoot(true);
  try {
    fs.writeFileSync(
      path.join(root, 'MEMORY.md'),
      '# Memory\n\n- debugger statements left in committed code break CI lint gates; remove them before review.\n',
      'utf8'
    );
    const reportPath = path.join(root, 'result.json');
    const r = fixer.cmdRun({ root, findings: writeFindings(root), report: reportPath });
    assert.strictEqual(r.exit, 0);
    const d = r.report.details[0];
    assert.ok(d.sourcesConsulted.some(s => s.startsWith('memory-files:') && !s.includes('consult-skipped')), JSON.stringify(d.sourcesConsulted));
    assert.strictEqual(d.memoryFileHints.length, 1);
    assert.match(d.memoryFileHints[0].source, /MEMORY\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-fixer - records spec-memo consult status before fixing', () => {
  delete process.env.SDW_FIXER_NO_MEMO;
  delete process.env.SDW_MEMORY_NO_MEMO;
  try {
    const root = setupRoot(true);
    try {
      const reportPath = path.join(root, 'result.json');
      const r = fixer.cmdRun({ root, findings: writeFindings(root), report: reportPath });
      assert.strictEqual(r.exit, 0);
      const d = r.report.details[0];
      assert.ok(d.sourcesConsulted.some(s => /^spec-memo:(consult-skipped|\d+ hints)$/.test(s)), JSON.stringify(d.sourcesConsulted));
      assert.ok(Array.isArray(d.specMemoHints));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    process.env.SDW_FIXER_NO_MEMO = '1';
    process.env.SDW_MEMORY_NO_MEMO = '1';
  }
});

test('sdw-fixer - honors SDW_FIXER_NO_MEMO opt-out', () => {
  const root = setupRoot(true);
  try {
    const reportPath = path.join(root, 'result.json');
    const r = fixer.cmdRun({ root, findings: writeFindings(root), report: reportPath });
    assert.strictEqual(r.exit, 0);
    const d = r.report.details[0];
    assert.ok(d.sourcesConsulted.includes('spec-memo:consult-skipped'), JSON.stringify(d.sourcesConsulted));
    assert.deepStrictEqual(d.specMemoHints, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('sdw-fixer - learn honors --no-learn and failed verification', () => {
  const root = setupRoot(true);
  try {
    const p1 = path.join(root, 'r1.json');
    const r1 = fixer.cmdRun({ root, findings: writeFindings(root, 'b1'), report: p1, learn: false });
    assert.strictEqual(r1.exit, 0);
    assert.deepStrictEqual(r1.report.learned, []);
    assert.ok(!fs.readFileSync(path.join(root, '.sdw', 'memory', 'traps.md'), 'utf8').includes('no-debugger-statements'));

    fs.writeFileSync(path.join(root, 'buggy.js'), 'const a = 1;\ndebugger;\nmodule.exports = a;\n', 'utf8');
    const p2 = path.join(root, 'r2.json');
    const r2 = fixer.cmdRun({ root, findings: writeFindings(root, 'b2'), report: p2, verify: 'node -e "process.exit(1)"' });
    assert.strictEqual(r2.exit, 1);
    assert.strictEqual(r2.report.status, 'verify-failed');
    assert.deepStrictEqual(r2.report.learned, []);
    assert.ok(!fs.readFileSync(path.join(root, '.sdw', 'memory', 'traps.md'), 'utf8').includes('no-debugger-statements'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sdw-fixer - emits resolution comments, an amendment log, and a markdown report', () => {
  const root = setupRoot(true);
  try {
    const findings = path.join(root, 'findings.json');
    fs.writeFileSync(findings, JSON.stringify({
      batchId: 'collab-batch',
      findings: [
        { file: 'buggy.js', line: 2, rule: 'no_debugger_statements', evidence: 'thread', threadId: 'PRRT_1', severityHint: 'high' },
        { file: 'buggy.js', line: 3, rule: 'custom_rule', evidence: 'thread', threadId: 'PRRT_2', severityHint: 'low' }
      ]
    }), 'utf8');
    const reportPath = path.join(root, 'result.json');
    const markdownPath = path.join(root, 'round.md');
    const res = fixer.cmdRun({ findings, report: reportPath, markdown: markdownPath, root, learn: false });
    assert.strictEqual(res.exit, 0);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.strictEqual(report.comments.length, 1, 'one comment per fixed thread');
    assert.strictEqual(report.comments[0].threadId, 'PRRT_1', 'the comment keeps the thread mapping');
    assert.match(report.comments[0].comment, /resolution-reply/);
    assert.match(report.comments[0].comment, /buggy\.js:2/);
    assert.ok(report.amendments.some(a => a.to === 'skipped' && a.rule === 'custom_rule'), 'skips are recorded as amendments');
    assert.ok(fs.existsSync(markdownPath), 'the markdown round report exists');
    assert.strictEqual(report.markdownPath, 'round.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
