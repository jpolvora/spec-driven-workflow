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

test('AC12: validateFixScope prohibits fixer subagent from modifying files outside target finding scope fence', () => {
  assert.ok(reviewEvaluator, 'review_evaluator module must exist');
  assert.equal(typeof reviewEvaluator.validateFixScope, 'function', 'validateFixScope must be exported');

  const targetFiles = ['skills/sdw-run/scripts/sdw_run.cjs', 'skills/sdw-run/scripts/score_evaluator.cjs'];

  // In-scope changes
  const inScope = reviewEvaluator.validateFixScope(
    ['skills/sdw-run/scripts/sdw_run.cjs'],
    targetFiles
  );
  assert.equal(inScope.allowed, true);
  assert.equal(inScope.violations.length, 0);

  // Out-of-scope changes
  const outOfScope = reviewEvaluator.validateFixScope(
    ['skills/sdw-run/scripts/sdw_run.cjs', 'package.json'],
    targetFiles
  );
  assert.equal(outOfScope.allowed, false, 'Modifying package.json outside targetFiles must be rejected');
  assert.ok(outOfScope.violations.includes('package.json'));
});

test('AC13: formatFixCommitMessage formats conventional commit message for remediation rounds', () => {
  assert.ok(reviewEvaluator, 'review_evaluator module must exist');
  assert.equal(typeof reviewEvaluator.formatFixCommitMessage, 'function', 'formatFixCommitMessage must be exported');

  const msg = reviewEvaluator.formatFixCommitMessage('my-feature', 2);
  assert.equal(msg, 'fix(my-feature): address code review findings (round 2)');
});

test('AC15, AC16: iteration ceiling is enforced and overridable via CLI flag', () => {
  assert.ok(reviewEvaluator, 'review_evaluator module must exist');

  // Configured default vs CLI override
  const conf1 = reviewEvaluator.resolveReviewConfig({ codeReview: { maxIterations: 5 } });
  assert.equal(conf1.maxIterations, 5);

  const conf2 = reviewEvaluator.resolveReviewConfig(
    { codeReview: { maxIterations: 5 } },
    { reviewMaxIterations: 2 }
  );
  assert.equal(conf2.maxIterations, 2, 'CLI flag --review-max-iterations must override config');

  assert.equal(typeof reviewEvaluator.isMaxIterationsReached, 'function');
  assert.equal(reviewEvaluator.isMaxIterationsReached(1, 2), false);
  assert.equal(reviewEvaluator.isMaxIterationsReached(2, 2), true);
  assert.equal(reviewEvaluator.isMaxIterationsReached(3, 2), true);
});

test('AC19: sdwConfig validates codeReview configuration schema bounds and types', () => {
  // Valid configuration
  const valid = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    codeReview: {
      mode: 'subagent',
      maxIterations: 3,
      command: 'npm run lint',
      model: 'test-model',
      effort: 'high'
    }
  });
  assert.equal(valid.valid, true, 'Valid codeReview config passes validation');

  // Invalid mode
  const invalidMode = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    codeReview: { mode: 'invalid-mode' }
  });
  assert.equal(invalidMode.valid, false);
  assert.ok(invalidMode.errors.some(e => e.includes('codeReview.mode')));

  // Invalid maxIterations (< 1)
  const invalidMax = sdwConfig.validateConfigSchema({
    specsDir: '.sdw/specs',
    codeReview: { maxIterations: 0 }
  });
  assert.equal(invalidMax.valid, false);
  assert.ok(invalidMax.errors.some(e => e.includes('codeReview.maxIterations')));
});

test('AC20: documentation records fresh-subagent code review and local fix loop protocol', () => {
  const protocolPath = path.resolve(__dirname, '../skills/sdw-run/references/orchestrator_protocol.md');
  const skillPath = path.resolve(__dirname, '../skills/sdw-code-review/SKILL.md');

  assert.ok(fs.existsSync(protocolPath), 'orchestrator_protocol.md exists');
  assert.ok(fs.existsSync(skillPath), 'sdw-code-review/SKILL.md exists');

  const protocolContent = fs.readFileSync(protocolPath, 'utf8');
  assert.ok(/codeReview\.mode/i.test(protocolContent) || /codeReview/i.test(protocolContent));
  assert.ok(/subagent/i.test(protocolContent));

  const skillContent = fs.readFileSync(skillPath, 'utf8');
  assert.ok(/subagent/i.test(skillContent) || /fresh-context/i.test(skillContent));
});

test('PR Review Convergence: validateReviewReport rejects contradictory passed and blockingCount', () => {
  assert.ok(reviewEvaluator);

  // passed: true with blockingCount > 0
  const contradict1 = reviewEvaluator.validateReviewReport({
    passed: true,
    blockingCount: 2,
    findings: [
      { id: 'F1', defectClass: 'bug', file: 'a.js', line: 1, evidence: 'e', otherLocations: [], severity: 'critical' },
      { id: 'F2', defectClass: 'bug', file: 'b.js', line: 2, evidence: 'e', otherLocations: [], severity: 'warning' }
    ]
  });
  assert.equal(contradict1.valid, false);
  assert.ok(contradict1.errors.some(e => e.includes('Contradictory report')));

  // passed: false with blockingCount 0
  const contradict2 = reviewEvaluator.validateReviewReport({
    passed: false,
    blockingCount: 0,
    findings: []
  });
  assert.equal(contradict2.valid, false);
  assert.ok(contradict2.errors.some(e => e.includes('Contradictory report')));
});

test('PR Review Convergence: review subcommands guard Step 7 status and verification results', () => {
  assert.ok(sdwRun);
  const repo = setupRepo();

  // Initialize a dummy run state
  const stateDir = path.join(repo, '.sdw', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const runId = 'run-test-guard-001';
  const statePath = path.join(stateDir, `${runId}.state.json`);
  const baseState = {
    runId,
    specSlug: 'sample-review-spec',
    specPath: '.sdw/specs/sample-review-spec.md',
    status: 'in_progress',
    steps: {
      7: {
        name: 'code_review',
        status: 'pending',
        output: null
      }
    }
  };
  fs.writeFileSync(statePath, JSON.stringify(baseState, null, 2), 'utf8');

  // 1. review submit fails if step 7 is not awaiting_review
  const dummyReportPath = path.join(repo, 'report.json');
  fs.writeFileSync(dummyReportPath, JSON.stringify({ passed: true, blockingCount: 0, findings: [] }), 'utf8');
  const submitExit = sdwRun.cmdReviewSubmit({
    root: repo,
    runId,
    reportPath: dummyReportPath
  });
  assert.equal(submitExit, 1, 'cmdReviewSubmit must fail when step 7 status is not awaiting_review');

  // 2. review fix-finish fails if step 7 is not awaiting_review_fix
  const dummyEvidencePath = path.join(repo, 'evidence.json');
  fs.writeFileSync(dummyEvidencePath, JSON.stringify({ modifiedFiles: [], verification: { passed: true } }), 'utf8');
  const fixExit = sdwRun.cmdReviewFixFinish({
    root: repo,
    runId,
    evidencePath: dummyEvidencePath
  });
  assert.equal(fixExit, 1, 'cmdReviewFixFinish must fail when step 7 status is not awaiting_review_fix');

  // 3. review fix-finish fails if verification.passed is false or missing
  baseState.steps[7].status = 'awaiting_review_fix';
  baseState.steps[7].output = {
    fixerEnvelope: { targetFiles: ['index.cjs'] },
    codeReview: { round: 1, maxIterations: 5 }
  };
  fs.writeFileSync(statePath, JSON.stringify(baseState, null, 2), 'utf8');

  const unverifiedEvidencePath = path.join(repo, 'evidence-unverified.json');
  fs.writeFileSync(unverifiedEvidencePath, JSON.stringify({ modifiedFiles: [], verification: { passed: false } }), 'utf8');
  const unverifiedExit = sdwRun.cmdReviewFixFinish({
    root: repo,
    runId,
    evidencePath: unverifiedEvidencePath
  });
  assert.equal(unverifiedExit, 1, 'cmdReviewFixFinish must fail when evidence verification.passed is false');

  // 4. review fix-finish handles null evidence without crashing
  const nullEvidencePath = path.join(repo, 'evidence-null.json');
  fs.writeFileSync(nullEvidencePath, 'null', 'utf8');
  const nullExit = sdwRun.cmdReviewFixFinish({
    root: repo,
    runId,
    evidencePath: nullEvidencePath
  });
  assert.equal(nullExit, 1, 'cmdReviewFixFinish must fail cleanly without crashing when evidence is null');
});

test('PR Review Context: sdw-memory queryTraps and spec-grilling loadProjectInstructions contract', () => {
  const sdwMemory = require('../skills/sdw-memory/scripts/sdw_memory.cjs');
  const specGrilling = require('../skills/sdw-run/scripts/spec_grilling.cjs');

  assert.equal(typeof sdwMemory.queryTraps, 'function', 'sdwMemory must export queryTraps');
  assert.equal(typeof specGrilling.loadProjectInstructions, 'function', 'specGrilling must export loadProjectInstructions');

  // queryTraps returns an array of structured traps
  const traps = sdwMemory.queryTraps({ slug: '00076-fresh-context-subagent-code-review-fix-loop' });
  assert.ok(Array.isArray(traps), 'queryTraps must return an array');

  // loadProjectInstructions reads from config override or file
  const configInstructions = specGrilling.loadProjectInstructions(process.cwd(), { instructions: 'Custom rule set' });
  assert.equal(configInstructions, 'Custom rule set');

  const fileInstructions = specGrilling.loadProjectInstructions(process.cwd(), {});
  assert.ok(typeof fileInstructions === 'string');
});


