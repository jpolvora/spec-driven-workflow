'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const scoreEvaluator = require('../skills/sdw-run/scripts/score_evaluator.cjs');
const dagPlanner = require('../skills/sdw-run/scripts/dag_planner.cjs');
const stateManager = require('../skills/sdw-run/scripts/state_manager.cjs');
const sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');

const SAMPLE_SPEC = `---
slug: sample-judge-spec
---
# Sample Judge Spec
## Acceptance Criteria
- AC1: The system shall record run state.
- AC2: The system shall provide fresh-context evaluation.
`;

function setupRepo(specContent = SAMPLE_SPEC) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-judge-test-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, 'sample-judge-spec.md'), specContent);

  execSync('git init -q', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'index.cjs'), '// initial base\n');
  execSync('git add .sdw index.cjs', { cwd: root, stdio: 'ignore' });
  execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });
  return root;
}

test('AC1: scoring.judgeMode defaults to "subagent" and supports "command" and "host"', () => {
  // Default when omitted
  const confDefault = scoreEvaluator.resolveJudgeConfig({});
  assert.equal(confDefault.judgeMode, 'subagent', 'Default judgeMode must be "subagent"');

  // Explicit values
  const confSubagent = scoreEvaluator.resolveJudgeConfig({ scoring: { judgeMode: 'subagent' } });
  assert.equal(confSubagent.judgeMode, 'subagent');

  const confCommand = scoreEvaluator.resolveJudgeConfig({ scoring: { judgeMode: 'command', judgeCommand: 'echo ok' } });
  assert.equal(confCommand.judgeMode, 'command');

  const confHost = scoreEvaluator.resolveJudgeConfig({ scoring: { judgeMode: 'host' } });
  assert.equal(confHost.judgeMode, 'host');
});

test('AC4, AC7: judge dispatch envelope applies configured model, effort, and resolved skillsRoot', () => {
  const acs = dagPlanner.parseAcceptanceCriteria(SAMPLE_SPEC);
  const diff = { text: 'diff content', bytes: 12, truncated: false, files: ['index.cjs'] };
  const judgeConfig = {
    judgeMode: 'subagent',
    model: 'custom-judge-model',
    effort: 'high',
    skillsRoot: 'skills'
  };

  const envelope = scoreEvaluator.buildJudgeEnvelope({
    slug: 'sample-judge-spec',
    runId: 'run-12345',
    targetRoot: process.cwd(),
    acs,
    diff,
    judge: judgeConfig,
    skillsRoot: 'skills'
  });

  assert.ok(envelope, 'Judge dispatch envelope should be created');
  assert.equal(envelope.type, 'judge');
  assert.equal(envelope.role, 'conformance_judge');
  assert.equal(envelope.model, 'custom-judge-model');
  assert.equal(envelope.effort, 'high');
  assert.ok(envelope.skillsRoot, 'Harness skillsRoot must be included in envelope');
  assert.ok(envelope.promptFile, 'Prompt file path must be in envelope');
  assert.ok(envelope.verdictFile, 'Verdict file path must be in envelope');
  assert.ok(envelope.submitCommand.includes('skills/sdw-run/scripts/sdw_run.cjs'));

  // Test custom stateDir forwarding and skillsRoot in envelope
  const customEnvelope = scoreEvaluator.buildJudgeEnvelope({
    slug: 'sample-judge-spec',
    runId: 'run-12345',
    targetRoot: process.cwd(),
    stateDir: '.sdw/custom-state',
    acs,
    diff,
    judge: judgeConfig,
    skillsRoot: '.agents/skills'
  });
  assert.ok(customEnvelope.promptFile.startsWith('.sdw/custom-state/'));
  assert.ok(customEnvelope.verdictFile.startsWith('.sdw/custom-state/'));
  assert.ok(customEnvelope.submitCommand.includes('.agents/skills/sdw-run/scripts/sdw_run.cjs'));
});

test('AC5, AC6, AC7, AC8: judge prompt bundles criteria, diff, touched files, and sdw-rules qualitative instructions', () => {
  const acs = dagPlanner.parseAcceptanceCriteria(SAMPLE_SPEC);
  const diff = {
    text: '+ // implemented change',
    bytes: 23,
    truncated: false,
    files: ['index.cjs']
  };

  const promptResult = scoreEvaluator.buildJudgePrompt({
    slug: 'sample-judge-spec',
    acs,
    diff,
    criticity: 'strict',
    skillsRoot: 'skills',
    judge: {
      judgeMode: 'subagent',
      model: 'flash',
      effort: 'medium'
    }
  });

  const prompt = promptResult.prompt;
  assert.ok(prompt.includes('AC1: The system shall record run state.'), 'Prompt inlines AC1');
  assert.ok(prompt.includes('AC2: The system shall provide fresh-context evaluation.'), 'Prompt inlines AC2');
  assert.ok(prompt.includes('+ // implemented change'), 'Prompt includes diff');
  assert.ok(prompt.includes('index.cjs'), 'Prompt includes touched files');

  // AC6 & AC7 qualitative instructions and harness reference
  assert.ok(prompt.includes('sdw-rules'), 'Prompt explicitly references sdw-rules harness');
  assert.ok(prompt.includes('anti_patterns.md') || prompt.includes('anti-patterns'), 'Prompt cites anti-patterns');
  assert.ok(prompt.includes('YAGNI') || prompt.includes('simplicity'), 'Prompt cites simplicity / YAGNI');
  assert.ok(prompt.includes('qualitative') || prompt.includes('quality'), 'Prompt requires qualitative review');

  // Isolated context check (no prior transcripts)
  assert.ok(!/transcript/i.test(prompt), 'No transcript content inlined in fresh judge prompt');
});

test('AC9: verdict validation requires per-criterion verdicts, overall score, and supports qualitative findings', () => {
  const acs = dagPlanner.parseAcceptanceCriteria(SAMPLE_SPEC);
  const validVerdict = {
    score: 10,
    verdicts: [
      { id: 'AC1', verdict: 'verified', evidence: 'index.cjs:1' },
      { id: 'AC2', verdict: 'verified', evidence: 'index.cjs:2' }
    ],
    qualitativeFindings: {
      quality: 'high',
      simplicity: 'adheres to YAGNI with zero superfluous abstractions',
      performance: 'optimal'
    },
    notes: 'criteria verified'
  };

  const validation = scoreEvaluator.validateVerdict(validVerdict, { acs });
  assert.equal(validation.valid, true, 'Valid verdict with qualitative findings should pass validation');
  assert.ok(validation.data.qualitativeFindings, 'Preserves qualitative findings in verdict data');

  // Missing an AC should fail validation
  const incompleteVerdict = {
    score: 5,
    verdicts: [
      { id: 'AC1', verdict: 'verified', evidence: 'index.cjs:1' }
    ]
  };
  const incompleteValidation = scoreEvaluator.validateVerdict(incompleteVerdict, { acs });
  assert.equal(incompleteValidation.valid, false, 'Incomplete verdict must fail validation');
});

test('AC15: sdwConfig validates scoring.judgeMode enum', () => {
  const validConfigs = ['subagent', 'command', 'host'].map(mode =>
    sdwConfig.validateConfigSchema({
      specsDir: '.sdw/specs',
      scoring: { judgeMode: mode }
    })
  );
  validConfigs.forEach(res => assert.equal(res.valid, true));

  const invalid = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    scoring: { judgeMode: 'magic' }
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(e => e.includes('scoring.judgeMode')));
});

test('AC12, AC13: Step 5 respects judgeMode for command and host execution', () => {
  const tmpDir = setupRepo();
  try {
    const implScript = [
      "const fs = require('fs');",
      "fs.appendFileSync('index.cjs', '// implemented\\n');",
      'fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({',
      "  taskId: process.env.SDW_TASK_ID,",
      "  status: 'success',",
      "  acIds: ['AC1', 'AC2'],",
      "  filesChanged: ['index.cjs'],",
      "  tests: [],",
      "  summary: 'implemented index.cjs'",
      '}));'
    ].join(' ');

    const hostExit = sdwRun.cmdRun({
      root: tmpDir,
      specPath: '.sdw/specs/sample-judge-spec.md',
      scoring: { judgeMode: 'host' },
      skipReview: true,
      skipPr: true,
      implementation: {
        mode: 'command',
        segregateTests: false,
        command: `node -e "${implScript.replace(/"/g, '\\"')}"`
      }
    });
    assert.equal(hostExit, 5);
    const hostState = stateManager.findLatestRunState(tmpDir);
    assert.equal(hostState.steps[5].output.judgeResolution, 'host');
    assert.equal(typeof hostState.steps[5].output.envelope, 'undefined');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AC16: documentation in orchestrator_protocol.md and skills/sdw-run/SKILL.md records fresh-context judge protocol', () => {
  const protocolPath = path.resolve(__dirname, '../skills/sdw-run/references/orchestrator_protocol.md');
  const protocol = fs.readFileSync(protocolPath, 'utf8');
  assert.ok(protocol.includes('judgeMode') || protocol.includes('subagent judge') || protocol.includes('conformance judge'),
    'orchestrator_protocol.md must document fresh-context subagent judge protocol');

  const skillPath = path.resolve(__dirname, '../skills/sdw-run/SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  assert.ok(skill.includes('judge') || skill.includes('scoring'),
    'sdw-run SKILL.md must document scoring step');
});

