'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let sdwConfig;
let sdwRun;
let stateManager;
let reviewEvaluator;

try {
  sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
} catch (e) {
  sdwConfig = null;
}

try {
  sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');
} catch (e) {
  sdwRun = null;
}

try {
  stateManager = require('../skills/sdw-run/scripts/state_manager.cjs');
} catch (e) {
  stateManager = null;
}

try {
  reviewEvaluator = require('../skills/sdw-run/scripts/review_evaluator.cjs');
} catch (e) {
  reviewEvaluator = null;
}

const SAMPLE_SPEC = `---
slug: sample-review-spec
title: Sample Review Spec
status: draft
---
# Sample Review Spec
## Acceptance Criteria
- AC1: The system shall record run state.
- AC2: The system shall provide fresh-context code review.
`;

function setupRepo(specContent = SAMPLE_SPEC) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-review-test-'));
  const specsDir = path.join(root, '.sdw', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, 'sample-review-spec.md'), specContent);

  // Initialize git repo
  execSync('git init -q', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "SDW Test"', { cwd: root, stdio: 'ignore' });

  // Baseline AGENTS.md instructions
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Project Instructions\n- Enforce strict YAGNI\n');
  fs.writeFileSync(path.join(root, 'index.cjs'), '// initial base\n');
  execSync('git add .sdw AGENTS.md index.cjs', { cwd: root, stdio: 'ignore' });
  execSync('git commit -qm "baseline"', { cwd: root, stdio: 'ignore' });
  return root;
}

test('AC1, AC2: codeReview config defaults to mode "subagent" and maxIterations 5', () => {
  assert.ok(reviewEvaluator, 'review_evaluator module must exist');
  assert.equal(typeof reviewEvaluator.resolveReviewConfig, 'function', 'resolveReviewConfig must be exported');

  // Default when omitted
  const confDefault = reviewEvaluator.resolveReviewConfig({});
  assert.equal(confDefault.mode, 'subagent', 'Default codeReview.mode must be "subagent"');
  assert.equal(confDefault.maxIterations, 5, 'Default codeReview.maxIterations must be 5');

  // Explicit values
  const confExplicit = reviewEvaluator.resolveReviewConfig({
    codeReview: {
      mode: 'cli',
      maxIterations: 3
    }
  });
  assert.equal(confExplicit.mode, 'cli');
  assert.equal(confExplicit.maxIterations, 3);

  const confCommand = reviewEvaluator.resolveReviewConfig({
    codeReview: {
      mode: 'command',
      command: 'npm run lint'
    }
  });
  assert.equal(confCommand.mode, 'command');
  assert.equal(confCommand.command, 'npm run lint');
});

test('AC3, AC4: Step 7 dispatches fresh-context reviewer subagent with read-only fence and no prior transcripts', () => {
  assert.ok(reviewEvaluator, 'review_evaluator module must exist');
  assert.equal(typeof reviewEvaluator.buildReviewerEnvelope, 'function', 'buildReviewerEnvelope must be exported');

  const envelope = reviewEvaluator.buildReviewerEnvelope({
    slug: 'sample-review-spec',
    runId: 'run-test-cr-001',
    targetRoot: process.cwd(),
    baseCommit: 'HEAD~1',
    headCommit: 'HEAD',
    diff: { text: '+ const x = 1;', files: ['index.cjs'], bytes: 15 },
    skillsRoot: 'skills',
    reviewConfig: { mode: 'subagent', maxIterations: 5 }
  });

  assert.equal(envelope.type, 'review', 'Envelope type must be "review"');
  assert.equal(envelope.role, 'code_reviewer', 'Envelope role must be "code_reviewer"');
  assert.equal(envelope.permissions, 'read_only', 'AC4: Reviewer subagent permissions must be strictly read_only');
  assert.ok(envelope.promptFile, 'Envelope must reference promptFile');
  assert.ok(envelope.reportFile, 'Envelope must reference reportFile');
  assert.ok(envelope.submitCommand, 'Envelope must provide submitCommand');
  assert.ok(!envelope.submitCommand.includes('undefined'), 'submitCommand must not have undefined tokens');
});

test('AC4, AC5: Reviewer prompt strictly enforces read-only access and injects AGENTS.md, sdw-memory traps, and sdw-rules', () => {
  assert.ok(reviewEvaluator, 'review_evaluator module must exist');
  assert.equal(typeof reviewEvaluator.buildReviewerPrompt, 'function', 'buildReviewerPrompt must be exported');

  const prompt = reviewEvaluator.buildReviewerPrompt({
    slug: 'sample-review-spec',
    runId: 'run-test-cr-001',
    targetRoot: process.cwd(),
    instructions: '# Project Instructions\n- Enforce strict YAGNI\n',
    traps: [
      { slug: 'avoid-regex-parsing', scenario: 'Parsing JSON with regex', recommendation: 'Use JSON.parse' }
    ],
    skillsRoot: 'skills',
    diff: { text: '+ const x = 1;', files: ['index.cjs'], bytes: 15 },
    touchedFiles: ['index.cjs'],
    acs: [{ id: 'AC1', text: 'The system shall record run state.' }]
  });

  // AC4: Read-only restrictions
  assert.ok(/read-only/i.test(prompt), 'AC4: Prompt must state read-only access restriction');
  assert.ok(/zero file mutations/i.test(prompt) || /forbidden.*file edit/i.test(prompt) || /prohibited.*mutation/i.test(prompt), 'AC4: Zero file mutations prohibited');
  assert.ok(/git commit/i.test(prompt), 'AC4: Explicitly forbids git commit');

  // AC5: Injected rules and memory
  assert.ok(prompt.includes('Enforce strict YAGNI'), 'AC5: Injects repository instructions (AGENTS.md)');
  assert.ok(prompt.includes('avoid-regex-parsing'), 'AC5: Injects sdw-memory trap slug');
  assert.ok(prompt.includes('sdw-rules'), 'AC5: Injects sdw-rules reference');

  // AC3: No transcript pollution
  assert.ok(!prompt.includes('transcript.jsonl'), 'AC3: No prior conversation transcript in fresh reviewer prompt');
  assert.ok(!/implementer conversation/i.test(prompt), 'AC3: No implementation turn context in fresh reviewer prompt');
});

test('AC6, AC7: Review report validation requires defect-class aggregation, primary file:line, and otherLocations', () => {
  assert.ok(reviewEvaluator, 'review_evaluator module must exist');
  assert.equal(typeof reviewEvaluator.validateReviewReport, 'function', 'validateReviewReport must be exported');

  const validReport = {
    passed: false,
    blockingCount: 1,
    findings: [
      {
        id: 'CR-001',
        defectClass: 'unhandled-null-rejection',
        file: 'skills/sdw-run/scripts/sdw_run.cjs',
        line: 240,
        evidence: 'Null dereference when options.scoring is undefined',
        suggestedFix: '- if (options.scoring.mode)\n+ if (options.scoring && options.scoring.mode)',
        otherLocations: [
          'skills/sdw-run/scripts/score_evaluator.cjs:112'
        ],
        severity: 'critical'
      }
    ],
    summary: '1 blocking defect class identified across 2 locations.'
  };

  const validation = reviewEvaluator.validateReviewReport(validReport);
  assert.equal(validation.valid, true, 'Valid aggregated report passes validation');
  assert.equal(validation.data.findings[0].defectClass, 'unhandled-null-rejection');
  assert.deepEqual(validation.data.findings[0].otherLocations, ['skills/sdw-run/scripts/score_evaluator.cjs:112']);

  // Missing defectClass or otherLocations should fail validation
  const missingClassReport = {
    passed: false,
    blockingCount: 1,
    findings: [
      {
        id: 'CR-001',
        file: 'skills/sdw-run/scripts/sdw_run.cjs',
        line: 240,
        evidence: 'Null dereference',
        severity: 'critical'
      }
    ]
  };
  const invalidValidation = reviewEvaluator.validateReviewReport(missingClassReport);
  assert.equal(invalidValidation.valid, false, 'Report missing defectClass must fail validation');

  // More than 6 findings per round must be rejected per aggregation policy
  const tooManyFindings = {
    passed: false,
    blockingCount: 7,
    findings: Array.from({ length: 7 }, (_, i) => ({
      id: `CR-00${i + 1}`,
      defectClass: `defect-${i + 1}`,
      file: 'index.cjs',
      line: i + 1,
      evidence: 'evidence',
      otherLocations: [],
      severity: 'warning'
    }))
  };
  const overLimitValidation = reviewEvaluator.validateReviewReport(tooManyFindings);
  assert.equal(overLimitValidation.valid, false, 'More than 6 findings per round must be rejected per policy');
});

test('AC8: Review report with zero blocking findings marks Step 7 completed', () => {
  const passingReport = {
    passed: true,
    blockingCount: 0,
    findings: [],
    summary: 'Zero blocking issues discovered.'
  };

  const validation = reviewEvaluator.validateReviewReport(passingReport);
  assert.equal(validation.valid, true);
  assert.equal(validation.data.passed, true);
  assert.equal(validation.data.blockingCount, 0);
});

test('AC9, AC10, AC11: Initiating remediation round dispatches fresh fixer subagent scoped to target files', () => {
  assert.ok(reviewEvaluator, 'review_evaluator module must exist');
  assert.equal(typeof reviewEvaluator.buildFixerEnvelope, 'function', 'buildFixerEnvelope must be exported');
  assert.equal(typeof reviewEvaluator.buildFixerPrompt, 'function', 'buildFixerPrompt must be exported');

  const findings = [
    {
      id: 'CR-001',
      defectClass: 'unhandled-null-dereference',
      file: 'skills/sdw-run/scripts/sdw_run.cjs',
      line: 240,
      evidence: 'Null dereference when options.scoring is undefined',
      suggestedFix: '- if (options.scoring.mode)\n+ if (options.scoring && options.scoring.mode)',
      otherLocations: [
        'skills/sdw-run/scripts/score_evaluator.cjs:112'
      ],
      severity: 'critical'
    }
  ];

  const envelope = reviewEvaluator.buildFixerEnvelope({
    slug: 'sample-review-spec',
    runId: 'run-test-cr-001',
    targetRoot: process.cwd(),
    iteration: 1,
    findings,
    skillsRoot: 'skills'
  });

  assert.equal(envelope.type, 'fix', 'Envelope type must be "fix"');
  assert.equal(envelope.role, 'review_fixer', 'Envelope role must be "review_fixer"');
  // AC11: targetFiles derived from finding.file and otherLocations
  assert.ok(envelope.targetFiles.includes('skills/sdw-run/scripts/sdw_run.cjs'));
  assert.ok(envelope.targetFiles.includes('skills/sdw-run/scripts/score_evaluator.cjs'));

  const prompt = reviewEvaluator.buildFixerPrompt({
    slug: 'sample-review-spec',
    runId: 'run-test-cr-001',
    iteration: 1,
    findings,
    targetFiles: envelope.targetFiles,
    skillsRoot: 'skills',
    instructions: '# Project Instructions\n- Enforce strict YAGNI\n',
    traps: []
  });

  // AC11, AC12: Scoped write access fence in prompt
  assert.ok(/scope fence/i.test(prompt) || /target files/i.test(prompt), 'AC11: Fixer prompt contains scope fence');
  assert.ok(prompt.includes('skills/sdw-run/scripts/sdw_run.cjs'), 'AC11: Lists primary finding file in scope');
  assert.ok(prompt.includes('skills/sdw-run/scripts/score_evaluator.cjs'), 'AC11: Lists otherLocations in scope');
  assert.ok(/prohibited.*outside/i.test(prompt) || /forbidden.*outside/i.test(prompt), 'AC12: Prohibits modifying files outside scope fence');
});
