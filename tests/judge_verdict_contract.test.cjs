'use strict';

// Spec 00065: the judge verdict contract forbids `partial`. This module owns the
// AC4 prompt and submission contract plus the AC5 evidence for both paths at the
// helper boundary and at the CLI boundary (`score submit`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const stateManager = require('../skills/sdw-orch/scripts/state_manager.cjs');
const dagPlanner = require('../skills/sdw-orch/scripts/dag_planner.cjs');
const scoreEvaluator = require('../skills/sdw-orch/scripts/score_evaluator.cjs');
const acLedger = require('../skills/sdw-orch/scripts/ac_ledger.cjs');

const ORCH_CLI = path.resolve(__dirname, '..', 'skills', 'sdw-orch', 'scripts', 'sdw_orch.cjs');
const SPEC_SLUG = 'judge-contract-spec';
const SPEC_REL = `.sdw/specs/${SPEC_SLUG}.md`;
const SPEC_BODY = `---
slug: ${SPEC_SLUG}
---
# Judge Contract Spec

## Acceptance Criteria
- AC1: The system shall record a run state file.
- AC2: The system shall resume from that file.
`;

function fixtureAcs() {
  return dagPlanner.parseAcceptanceCriteria(SPEC_BODY);
}

/**
 * A run that finished Step 4 and waits for the judge, owning an anchored
 * acceptance criteria ledger so a rejected submission can prove it wrote neither
 * the run state nor the ledger.
 */
function setupAwaitingJudgment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-verdict-contract-'));
  const specFile = path.join(root, SPEC_REL);
  fs.mkdirSync(path.dirname(specFile), { recursive: true });
  fs.writeFileSync(specFile, SPEC_BODY);

  const created = stateManager.createRunState({ root, specPath: SPEC_REL, slug: SPEC_SLUG });
  for (const step of [1, 2, 3, 4]) {
    stateManager.updateStepState(root, created.runId, step, 'completed', {});
  }
  stateManager.updateStepState(root, created.runId, 5, 'awaiting_judgment', {});

  const ledger = acLedger.initLedger({
    root,
    artifactsDir: created.artifactsDir,
    runId: created.runId,
    specSlug: created.specSlug,
    specContent: SPEC_BODY
  });
  const state = stateManager.loadRunState(root, created.runId);
  state.acLedgerPath = path.relative(root, ledger.ledgerPath).replace(/\\/g, '/');
  state.acLedgerSha256 = acLedger.hashLedgerFile(ledger.ledgerPath);
  stateManager.saveRunState(root, state);

  return {
    root,
    runId: created.runId,
    stateFile: path.join(root, '.sdw', 'state', `${created.runId}.state.json`),
    ledgerFile: ledger.ledgerPath,
    acIds: fixtureAcs().map(ac => ac.id)
  };
}

function submitViaCli(context, verdictFile, extraArgs = []) {
  return spawnSync(process.execPath, [
    ORCH_CLI,
    'score',
    'submit',
    '--root', context.root,
    '--run-id', context.runId,
    '--verdict', verdictFile,
    ...extraArgs
  ], { encoding: 'utf8' });
}

function writeVerdict(root, name, verdict) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(verdict, null, 2));
  return file;
}

test('00065 AC4: the judge prompt enumerates exactly verified and failed and routes a partly met criterion to failed', () => {
  const acs = fixtureAcs();
  const diff = {
    text: 'diff --git a/app.cjs b/app.cjs\n+// implemented',
    bytes: 44,
    truncated: false,
    files: ['app.cjs']
  };
  const { prompt } = scoreEvaluator.buildJudgePrompt({
    slug: SPEC_SLUG,
    acs,
    diff,
    criticity: 'strict',
    judge: {}
  });

  assert.deepEqual(scoreEvaluator.VERDICT_VALUES, ['verified', 'failed'], 'the contract declares exactly two verdict values');

  const contract = prompt.slice(prompt.indexOf('## Output contract'), prompt.indexOf('## Rules'));
  const acceptedLine = contract.split('\n').find(line => line.startsWith('Accepted `verdict` values:'));
  assert.ok(acceptedLine, 'the output contract enumerates the accepted verdict values');
  assert.deepEqual(
    [...acceptedLine.slice(acceptedLine.indexOf(':') + 1).matchAll(/`([^`]+)`/g)].map(match => match[1]),
    ['verified', 'failed'],
    'the accepted values are exactly verified and failed, so partial is never offered'
  );
  assert.match(
    contract,
    /A criterion that is only partly met must be reported as `failed`\./,
    'the prompt tells the judge to report a partly met criterion as failed'
  );
  assert.match(
    contract,
    /Any other value, including `partial`, is rejected by `score submit`\./,
    'the prompt names partial as a rejected value'
  );
  assert.match(
    prompt.slice(prompt.indexOf('## Rules')),
    /one of: `verified`, `failed`\./,
    'the rules repeat exactly the same accepted values'
  );
});

test('00065 AC5: the verdict helper accepts verified and failed, scores them, and rejects partial', () => {
  const acs = fixtureAcs();

  const accepted = scoreEvaluator.validateVerdict({
    score: 5,
    verdicts: [
      { id: 'AC1', verdict: 'verified', evidence: 'app.cjs:1' },
      { id: 'AC2', verdict: 'failed', evidence: 'app.cjs:2' }
    ]
  }, { acs });
  assert.equal(accepted.valid, true, 'the accepted path validates a mixed verified/failed verdict');

  const report = scoreEvaluator.applyVerdict(accepted.data, { acs, minScore: 5 });
  assert.equal(report.score, 5, 'only the verified criterion scores');
  assert.equal(report.verifiedCount, 1);
  assert.equal(report.failingCount, 1);
  assert.equal(report.passed, true);
  assert.deepEqual(report.failingAcs.map(entry => entry.id), ['AC2'], 'the failed criterion stays reported as unmet');

  const rejected = scoreEvaluator.validateVerdict({
    score: 5,
    verdicts: [
      { id: 'AC1', verdict: 'verified', evidence: 'app.cjs:1' },
      { id: 'AC2', verdict: 'partial', evidence: 'app.cjs:2' }
    ]
  }, { acs });
  assert.equal(rejected.valid, false, 'the rejected path fails validation');
  assert.ok(
    rejected.errors.some(error => error.includes('must be one of: verified, failed')),
    'the rejection names the allowed values'
  );
  assert.ok(
    rejected.errors.some(error => error.includes('Use "failed"')),
    'the rejection tells the caller to use failed'
  );
});

test('00065 AC5: score submit accepts verified and failed at the CLI boundary and persists the judged verdict', () => {
  const context = setupAwaitingJudgment();
  try {
    const verdictFile = writeVerdict(context.root, 'verdict-accepted.json', {
      score: 5,
      verdicts: [
        { id: context.acIds[0], verdict: 'verified', evidence: 'app.cjs:1' },
        { id: context.acIds[1], verdict: 'failed', evidence: 'The resume behaviour is absent.' }
      ]
    });

    const cli = submitViaCli(context, verdictFile, ['--min-score', '5']);
    assert.equal(cli.status, 0, `the accepted verdict exits 0 (stderr: ${cli.stderr})`);
    assert.match(cli.stdout, /Score: 5\/10 \(Required: 5\/10\)\. Passed: true/, 'the CLI reports the derived score and the outcome');
    assert.match(cli.stdout, /Verified ACs: 1\/2/, 'the CLI counts the verified criterion');
    assert.match(cli.stdout, /Failing ACs:\s+1\/2/, 'the CLI counts the failed criterion');

    const submitted = stateManager.loadRunState(context.root, context.runId);
    assert.equal(submitted.steps[5].status, 'judged', 'the accepted verdict completes Step 5 scoring');
    assert.equal(submitted.score, 5, 'the run records the derived score');
    assert.equal(submitted.status, 'paused', 'the accepted verdict pauses the run for resume');
    assert.deepEqual(
      submitted.steps[5].output.verdict.verdicts,
      [
        { id: context.acIds[0], verdict: 'verified', evidence: 'app.cjs:1' },
        { id: context.acIds[1], verdict: 'failed', evidence: 'The resume behaviour is absent.' }
      ],
      'the submitted verdicts are persisted verbatim, not rewritten'
    );

    const ledger = acLedger.readLedger(context.ledgerFile);
    assert.deepEqual(
      ledger.criteria.map(record => [record.id, record.status]),
      [[context.acIds[0], 'verified'], [context.acIds[1], 'failed']],
      'the ledger records one verified and one failed criterion'
    );
    assert.equal(acLedger.deriveScore(ledger).score, 5, 'the ledger derives the score from the same verdicts');
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test('00065 AC4 & AC5: score submit rejects partial at the CLI boundary without touching run state or the ledger', () => {
  const context = setupAwaitingJudgment();
  try {
    const before = {
      stateBytes: fs.readFileSync(context.stateFile),
      ledgerBytes: fs.readFileSync(context.ledgerFile),
      state: stateManager.loadRunState(context.root, context.runId),
      ledgerHash: acLedger.hashLedgerFile(context.ledgerFile)
    };

    const verdictFile = writeVerdict(context.root, 'verdict-partial.json', {
      score: 5,
      verdicts: context.acIds.map(id => ({ id, verdict: 'partial', evidence: 'app.cjs:1' }))
    });

    const cli = submitViaCli(context, verdictFile);
    assert.notEqual(cli.status, 0, 'a partial verdict exits non-zero');
    assert.equal(cli.status, 1, 'a partial verdict is a contract rejection, not a below-threshold score');
    assert.match(cli.stderr, /must be one of: verified, failed/, 'the rejection names the allowed values');
    assert.match(cli.stderr, /Allowed per-criterion verdict values: verified, failed\./, 'the rejection repeats the allowed values');
    assert.match(cli.stderr, /A criterion that is only partly met must be submitted as "failed"/, 'the rejection tells the caller to use failed');
    assert.match(cli.stderr, /received: "partial"/, 'the rejection names the offending value');

    assert.deepEqual(fs.readFileSync(context.stateFile), before.stateBytes, 'the rejected submission leaves the run state byte-identical');
    assert.deepEqual(fs.readFileSync(context.ledgerFile), before.ledgerBytes, 'the rejected submission leaves the ledger byte-identical');

    const after = stateManager.loadRunState(context.root, context.runId);
    assert.equal(after.steps[5].status, 'awaiting_judgment', 'the run still awaits a judge verdict');
    assert.equal(after.score, before.state.score, 'the rejected submission changes no score');
    assert.equal(after.revision, before.state.revision, 'the rejected submission advances no revision');
    assert.equal(after.acLedgerSha256, before.ledgerHash, 'the ledger anchor is unchanged');

    const ledger = acLedger.readLedger(context.ledgerFile);
    assert.ok(ledger.criteria.every(record => record.evidence.length === 0), 'the ledger records no review evidence');
    assert.equal(acLedger.deriveScore(ledger).score, 0, 'no criterion is scored from a rejected verdict');
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});
