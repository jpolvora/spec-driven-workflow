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
