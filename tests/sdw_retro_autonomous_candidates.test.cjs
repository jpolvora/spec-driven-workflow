'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const RETRO_SCRIPT = path.join(REPO_ROOT, 'skills', 'sdw-retro', 'scripts', 'retro.cjs');
const VALIDATOR_SCRIPT = path.join(REPO_ROOT, 'skills', 'sdw-retro', 'scripts', 'validate_candidates.cjs');
const FINDER_SCRIPT = path.join(REPO_ROOT, 'skills', 'sdw-retro', 'scripts', 'find_session_transcript.cjs');
const SKILL_MD_PATH = path.join(REPO_ROOT, 'skills', 'sdw-retro', 'SKILL.md');

const retro = require('../skills/sdw-retro/scripts/retro.cjs');
const validateCandidates = require('../skills/sdw-retro/scripts/validate_candidates.cjs');

function makeWorkspace(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-retro-cand-'));
  const sdwDir = path.join(dir, '.sdw');
  const stateDir = path.join(sdwDir, 'state');
  const specsDir = path.join(sdwDir, 'specs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(specsDir, { recursive: true });

  const config = {
    specsDir: '{projectRoot}/.sdw/specs',
    stateDir: '{projectRoot}/.sdw/state',
    ...options.config
  };
  fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  return { root: dir, sdwDir, stateDir, specsDir };
}

function writeSampleState(root, runId, slug, extra = {}) {
  const artifactsDir = `.sdw/state/${slug}/${runId}`;
  const fullArtifactsDir = path.join(root, artifactsDir);
  fs.mkdirSync(fullArtifactsDir, { recursive: true });

  const state = {
    orchestrator: 'sdw-run',
    runId,
    specSlug: slug,
    status: 'completed',
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T01:00:00.000Z',
    scoreIteration: 2,
    reviewIteration: 1,
    artifactsDir,
    steps: {
      '1': { name: 'derivation', status: 'skipped', artifact: null },
      '2': { name: 'refinement', status: 'completed', artifact: `${artifactsDir}/${slug}-step-2.md` },
      '3': { name: 'dag_generation', status: 'completed', artifact: `${artifactsDir}/${slug}-step-3.md` },
      '4': {
        name: 'implementation',
        status: 'completed',
        artifact: `${artifactsDir}/${slug}-step-4.md`,
        tasks: {
          'task-1': { status: 'completed' },
          'task-2': { status: 'completed' }
        },
        gates: { test: { status: 'passed', exitCode: 0, durationMs: 120 } },
        dispatch: {
          abandonments: [
            { taskId: 'task-1', reason: 'subagent hung waiting for lock', at: '2026-11-22T00:20:00.000Z' }
          ]
        }
      },
      '5': {
        name: 'scoring',
        status: 'completed',
        artifact: `${artifactsDir}/${slug}-step-5.md`,
        output: { score: 9, minScore: 8, passed: true, judge: { reportedScore: 9, deductions: ['Missing edge case test in task 1'] } }
      },
      '6': { name: 'delivery_commit', status: 'completed', artifact: null },
      '7': {
        name: 'code_review',
        status: 'completed',
        artifact: `${artifactsDir}/${slug}-step-7.md`,
        output: {
          findings: [{ id: 'CR-001', severity: 'warning', path: 'skills/sample.cjs', line: 15, status: 'open', message: 'Potential unhandled error' }],
          blockingCount: 0
        }
      },
      '8': {
        name: 'pr_preparation',
        status: 'completed',
        artifact: `${artifactsDir}/${slug}-step-8.md`,
        output: {
          reviewConvergence: {
            rounds: 1,
            activeThreads: 0,
            resolvedThreads: 1
          }
        }
      }
    },
    ...extra
  };

  // Write step markdown files
  for (const stepNum of ['2', '3', '4', '5', '7', '8']) {
    const artRel = state.steps[stepNum].artifact;
    if (artRel) {
      const artAbs = path.join(root, artRel);
      fs.mkdirSync(path.dirname(artAbs), { recursive: true });
      fs.writeFileSync(artAbs, `# Step ${stepNum} Artifact\n\nContent for step ${stepNum}.\nLine 4: review thread reference.\n`, 'utf8');
    }
  }

  // Write task prompts and task evidence
  const taskPromptFile = path.join(fullArtifactsDir, 'task-task-1.prompt.md');
  fs.writeFileSync(taskPromptFile, '# Task Prompt for task-1\nImplement core feature.\n', 'utf8');

  const taskEvidenceFile = path.join(fullArtifactsDir, 'task-task-1.evidence.json');
  fs.writeFileSync(taskEvidenceFile, JSON.stringify({
    taskId: 'task-1',
    status: 'failed',
    acIds: ['AC1'],
    filesChanged: ['skills/sample.cjs'],
    tests: [{ name: 'node --test tests/sample.test.cjs', status: 'failed', output: 'ReferenceError: sample is not defined' }],
    summary: 'Task 1 failed during compiler check'
  }, null, 2), 'utf8');

  const statePath = path.join(root, '.sdw', 'state', `${runId}.state.json`);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

  return { state, statePath, fullArtifactsDir };
}

function runFinder(env, args = [], cwd = REPO_ROOT) {
  const preload = path.join(os.tmpdir(), `sdw-finder-env-${process.pid}-${crypto.randomUUID()}.cjs`);
  fs.writeFileSync(preload, [
    "'use strict';",
    'const supplied = JSON.parse(process.env.SDW_FINDER_ENV);',
    'for (const key of Object.keys(process.env)) delete process.env[key];',
    'Object.assign(process.env, supplied);',
    ''
  ].join('\n'), 'utf8');

  const childEnv = { SDW_FINDER_ENV: JSON.stringify(env) };
  if (process.platform === 'win32') {
    childEnv.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR) childEnv.WINDIR = process.env.WINDIR;
    if (process.env.ComSpec) childEnv.ComSpec = process.env.ComSpec;
    if (process.env.PATHEXT) childEnv.PATHEXT = process.env.PATHEXT;
  }
  childEnv.NODE_OPTIONS = `--require "${preload.replace(/\\/g, '/')}"`;

  try {
    const result = spawnSync(process.execPath, [FINDER_SCRIPT, ...args], {
      cwd,
      env: childEnv,
      encoding: 'utf8',
      timeout: 10000
    });
    return result;
  } finally {
    try {
      fs.unlinkSync(preload);
    } catch {
      // Best-effort cleanup
    }
  }
}

// =========================================================================
// AC1: Autonomous Candidate Evaluation Mode Trigger
// =========================================================================
test('AC1: retro.cjs provides autonomous candidate evaluation mode via --generate-candidates flag and retro.candidateMode config', (t) => {
  // 1. parseArgs recognizes --generate-candidates
  assert.ok(typeof retro.parseArgs === 'function', 'parseArgs must be a function');
  const parsed = retro.parseArgs(['run', '--generate-candidates']);
  assert.equal(
    parsed.generateCandidates,
    true,
    'parseArgs must parse --generate-candidates flag and set generateCandidates: true'
  );

  // 2. parseArgs accepts --candidate-mode=<mode>
  const parsedMode = retro.parseArgs(['run', '--candidate-mode=subagent']);
  assert.equal(parsedMode.candidateMode, 'subagent', 'parseArgs must accept --candidate-mode=subagent');

  // 3. Workspace config retro.candidateMode activates candidate evaluation mode
  const ws = makeWorkspace(t, {
    config: {
      retro: {
        enabled: true,
        candidateMode: 'subagent'
      }
    }
  });
  const runId = 'run-20261122-00001';
  writeSampleState(ws.root, runId, '00079-test-feature');

  const result = retro.runRetro({
    root: ws.root,
    runId,
    json: true
  });

  assert.ok(result && result.report, 'runRetro must return a report');
  assert.ok(
    result.report.candidateMode === 'subagent' || result.report.candidateEvaluation !== undefined,
    'retro report must record candidateMode or candidateEvaluation when configured in config.json'
  );
});

// =========================================================================
// AC2: Evaluates Run State, Step Artifacts, Prompts, Evidence, Review, Transcripts
// =========================================================================
test('AC2: candidate evaluation analyzes run state, step artifacts, dispatch prompts, task evidence, review threads, and transcripts to identify execution friction', (t) => {
  const ws = makeWorkspace(t);
  const runId = 'run-20261122-00002';
  const { fullArtifactsDir } = writeSampleState(ws.root, runId, '00079-test-feature');

  // Add transcript with command slip
  const transcriptFile = path.join(fullArtifactsDir, 'session-transcript.jsonl');
  fs.writeFileSync(transcriptFile, [
    JSON.stringify({ type: 'tool_call', command: 'node sdw_run.cjs run --spec 00079-test-feature' }),
    JSON.stringify({ type: 'tool_call', command: 'node sdw_run.cjs run --spec 00079-test-feature' })
  ].join('\n'), 'utf8');

  // Run retro in candidate evaluation mode
  assert.ok(typeof retro.runRetro === 'function', 'runRetro must be exported');
  const result = retro.runRetro({
    root: ws.root,
    runId,
    generateCandidates: true,
    transcripts: [transcriptFile]
  });

  // Verify that candidate evaluation extracts friction points across the required sources:
  // run state, step artifacts, dispatch prompts, task evidence, review threads, and transcripts
  assert.ok(result.report, 'Report must be produced');
  const evaluation = result.report.candidateEvaluation || result.report.candidateContext;
  assert.ok(evaluation, 'Report must contain candidateEvaluation or candidateContext');

  // Friction sources analyzed
  assert.ok(evaluation.sources, 'candidate evaluation must detail analyzed sources');
  assert.ok(evaluation.sources.runState, 'must analyze run state friction');
  assert.ok(evaluation.sources.stepArtifacts, 'must analyze step artifacts');
  assert.ok(evaluation.sources.dispatchPrompts, 'must analyze dispatch prompts');
  assert.ok(evaluation.sources.taskEvidence, 'must analyze task evidence diagnostics');
  assert.ok(evaluation.sources.reviewThreads, 'must analyze code review threads');
  assert.ok(evaluation.sources.transcripts, 'must analyze session transcripts');
});

// =========================================================================
// AC3: Candidate Schema Strictly Complies with Schema Including targetScope
// =========================================================================
test('AC3: candidate schema validates id, title, severity, category, targetScope, evidence, and proposedChange', (t) => {
  const ws = makeWorkspace(t);
  const runId = 'run-20261122-00003';
  const { statePath } = writeSampleState(ws.root, runId, '00079-test-feature');
  const relState = path.relative(ws.root, statePath).replace(/\\/g, '/');

  // CANDIDATE_FIELDS must include targetScope
  assert.ok(
    retro.CANDIDATE_FIELDS.includes('targetScope'),
    'retro.CANDIDATE_FIELDS must include targetScope'
  );
  assert.ok(
    validateCandidates.CANDIDATE_FIELDS.includes('targetScope'),
    'validateCandidates.CANDIDATE_FIELDS must include targetScope'
  );

  // 1. Missing targetScope is rejected
  const missingScope = {
    id: 'CAND-001',
    title: 'Missing target scope candidate',
    severity: 'high',
    category: 'automated-check',
    evidence: {
      artifact: relState,
      ref: '#steps.4.output'
    },
    proposedChange: {
      target: '.sdw/specs/00080-fix.md'
    }
  };
  const resMissing = validateCandidates.validateCandidate(missingScope, { root: ws.root });
  assert.equal(resMissing.valid, false, 'Candidate without targetScope must be rejected');
  assert.ok(
    resMissing.errors.some(e => e.field === 'targetScope' || e.code === 'missing-field' || e.code === 'missing-target-scope'),
    'Rejection error must name targetScope'
  );

  // 2. Invalid targetScope value is rejected
  const invalidScope = {
    ...missingScope,
    targetScope: 'invalid-scope'
  };
  const resInvalid = validateCandidates.validateCandidate(invalidScope, { root: ws.root });
  assert.equal(resInvalid.valid, false, 'Candidate with invalid targetScope must be rejected');
  assert.ok(
    resInvalid.errors.some(e => e.field === 'targetScope' || e.code === 'invalid-target-scope'),
    'Rejection error must identify invalid targetScope'
  );

  // 3. Valid targetScope: 'consumer' and 'upstream' are accepted
  const validConsumer = {
    ...missingScope,
    id: 'CAND-002',
    targetScope: 'consumer'
  };
  const resConsumer = validateCandidates.validateCandidate(validConsumer, { root: ws.root });
  assert.equal(resConsumer.valid, true, `Valid consumer candidate must be accepted: ${JSON.stringify(resConsumer.errors)}`);

  const validUpstream = {
    ...missingScope,
    id: 'CAND-003',
    targetScope: 'upstream'
  };
  const resUpstream = validateCandidates.validateCandidate(validUpstream, { root: ws.root });
  assert.equal(resUpstream.valid, true, `Valid upstream candidate must be accepted: ${JSON.stringify(resUpstream.errors)}`);
});

// =========================================================================
// AC4: Memory Candidates Require sdw-memory Draft with Scenario / Context, DO NOT, INSTEAD DO
// =========================================================================
test('AC4: memory candidate requires sdw-memory draft formatted with Scenario / Context, DO NOT, and INSTEAD DO structured fields', (t) => {
  const ws = makeWorkspace(t);
  const runId = 'run-20261122-00004';
  const { statePath } = writeSampleState(ws.root, runId, '00079-test-feature');
  const relState = path.relative(ws.root, statePath).replace(/\\/g, '/');

  // 1. Missing structured fields (missing scenario / context, doNot, insteadDo)
  const incompleteMemory = {
    id: 'MEM-001',
    title: 'Avoid retry slip',
    severity: 'medium',
    category: 'memory',
    targetScope: 'consumer',
    evidence: {
      artifact: relState,
      ref: '#steps.4.output'
    },
    proposedChange: {
      target: 'sdw-memory',
      memoryRecord: {
        kind: 'trap',
        title: 'Avoid retry slip'
        // Missing scenario, doNot, insteadDo
      }
    }
  };

  const resIncomplete = validateCandidates.validateCandidate(incompleteMemory, { root: ws.root });
  assert.equal(resIncomplete.valid, false, 'Memory candidate without Scenario, DO NOT, and INSTEAD DO must be rejected');
  assert.ok(
    resIncomplete.errors.some(e =>
      e.code === 'invalid-memory-draft' ||
      e.message.includes('Scenario') ||
      e.message.includes('DO NOT') ||
      e.message.includes('INSTEAD DO') ||
      e.field.includes('scenario') ||
      e.field.includes('doNot') ||
      e.field.includes('insteadDo')
    ),
    'Rejection must cite missing structured memory fields'
  );

  // 2. Complete structured fields accepted
  const completeMemory = {
    id: 'MEM-002',
    title: 'Avoid retry slip without abandon',
    severity: 'medium',
    category: 'memory',
    targetScope: 'consumer',
    evidence: {
      artifact: relState,
      ref: '#steps.4.output'
    },
    proposedChange: {
      target: 'sdw-memory',
      memoryRecord: {
        kind: 'trap',
        title: 'Avoid retry slip without abandon',
        scenario: 'When subagent dispatch stalls during implementation step',
        doNot: 'Re-invoke sdw-run without abandoning the stalled dispatch',
        insteadDo: 'Abandon the active task with a reason before re-dispatching'
      }
    }
  };

  const resComplete = validateCandidates.validateCandidate(completeMemory, { root: ws.root });
  assert.equal(resComplete.valid, true, `Complete structured memory candidate must be accepted: ${JSON.stringify(resComplete.errors)}`);
});

// =========================================================================
// AC5: Agent-Agnostic SKILL.md Instructions for Host Fact Self-Discovery
// =========================================================================
test('AC5: sdw-retro/SKILL.md provides agent-agnostic instructions directing active harness to discover transcript from host facts and supply via --transcript', () => {
  assert.ok(fs.existsSync(SKILL_MD_PATH), 'SKILL.md must exist');
  const skillContent = fs.readFileSync(SKILL_MD_PATH, 'utf8');

  // Verify skill content instructs agent to discover session transcript from host facts
  assert.match(
    skillContent,
    /host facts|environment facts/i,
    'SKILL.md must instruct agent to inspect host facts for session discovery'
  );
  assert.match(
    skillContent,
    /--transcript\s+<path>/,
    'SKILL.md must direct the agent to supply discovered transcript via --transcript <path>'
  );
  assert.match(
    skillContent,
    /transcript|session log/i,
    'SKILL.md must reference session transcript / logs'
  );
  // Verify agent-agnostic guidance across diverse harnesses
  assert.match(
    skillContent,
    /Antigravity|Claude Code|OpenCode|Cursor|Codex/i,
    'SKILL.md must mention agent harnesses for transcript self-discovery'
  );
});

// =========================================================================
// AC6: find_session_transcript.cjs Evaluates Roots up to Depth 6 and Session ID Matching
// =========================================================================
test('AC6: find_session_transcript.cjs searches candidate roots with depth up to 6 and session identifier matching across agent harnesses', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-retro-depth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const sessionId = 'sess-abcdef1234';

  // Create transcript at depth 5: home/d1/d2/d3/d4/d5/session.jsonl
  const depth5Dir = path.join(home, 'd1', 'd2', 'd3', 'd4', `session-${sessionId}`);
  fs.mkdirSync(depth5Dir, { recursive: true });
  const transcript5 = path.join(depth5Dir, 'transcript.jsonl');
  fs.writeFileSync(transcript5, '{"type":"message","content":"depth 5 test"}\n', 'utf8');

  // Create transcript at depth 6: home/d1/d2/d3/d4/d5/d6/session.jsonl
  const depth6Dir = path.join(home, 'd1', 'd2', 'd3', 'd4', 'd5', `session-${sessionId}`);
  fs.mkdirSync(depth6Dir, { recursive: true });
  const transcript6 = path.join(depth6Dir, 'transcript.jsonl');
  fs.writeFileSync(transcript6, '{"type":"message","content":"depth 6 test"}\n', 'utf8');

  // Run finder for depth 5 search
  const res5 = runFinder({
    SDW_FIXTURE_HOME: home,
    SDW_FIXTURE_SESSION_ID: sessionId
  }, ['--root', root], root);

  assert.equal(res5.status, 0, `Finder must exit 0: ${res5.stderr}`);
  const out5 = JSON.parse(res5.stdout.trim());
  assert.equal(out5.found, true, 'Finder must find transcript at depth up to 6');
  assert.equal(out5.sessionId, sessionId, 'Finder must match session ID');
  assert.ok(out5.path.includes(sessionId), 'Found path must include session identifier');
});

// =========================================================================
// AC7: In Consumer Workspace, Classify Framework Defects as Upstream Issues and Emit Issue Drafts
// =========================================================================
test('AC7: in consumer workspace, classify framework-scoped defects as upstream issues and emit ready-to-file issue drafts for github.com/jpolvora/spec-driven-workflow/issues', (t) => {
  const ws = makeWorkspace(t);
  const runId = 'run-20261122-00007';
  const { fullArtifactsDir, statePath } = writeSampleState(ws.root, runId, '00079-test-feature');
  const relState = path.relative(ws.root, statePath).replace(/\\/g, '/');

  // Set up vendored skills in consumer project under .agents/skills/
  const vendoredSkillDir = path.join(ws.root, '.agents', 'skills', 'sdw-retro');
  fs.mkdirSync(vendoredSkillDir, { recursive: true });
  fs.writeFileSync(path.join(vendoredSkillDir, 'SKILL.md'), '---\nname: sdw-retro\n---\n# sdw-retro\n', 'utf8');

  // Add a task failure evidence in consumer workspace that touches vendored skill
  const taskEvidenceVendored = path.join(fullArtifactsDir, 'task-task-fw.evidence.json');
  fs.writeFileSync(taskEvidenceVendored, JSON.stringify({
    taskId: 'task-fw',
    status: 'failed',
    acIds: ['AC1'],
    filesChanged: ['.agents/skills/sdw-retro/scripts/retro.cjs'],
    tests: [{ name: 'test', status: 'failed', output: 'SyntaxError in vendored skill' }],
    summary: 'Failure occurred inside vendored skill'
  }, null, 2), 'utf8');

  // 1. Run retro candidate generation in consumer workspace
  const retroResult = retro.runRetro({
    root: ws.root,
    runId,
    generateCandidates: true,
    json: true
  });

  assert.ok(retroResult && retroResult.report, 'Report must be produced');

  // 2. Report must contain upstream issue drafts targeting github.com/jpolvora/spec-driven-workflow/issues
  const upstreamIssues = retroResult.report.upstreamIssues;
  assert.ok(Array.isArray(upstreamIssues), 'retro report must contain upstreamIssues array in consumer workspace');
  assert.ok(upstreamIssues.length > 0, 'Must emit at least one upstream issue draft for framework defect');

  const fwIssue = upstreamIssues[0];
  assert.equal(fwIssue.targetScope, 'upstream', 'Framework defect must be classified as targetScope: upstream');
  assert.ok(fwIssue.issueDraft, 'Upstream issue draft must be present');
  assert.ok(
    fwIssue.issueDraft.repository.includes('github.com/jpolvora/spec-driven-workflow') ||
    fwIssue.issueDraft.url.includes('github.com/jpolvora/spec-driven-workflow/issues'),
    'Issue draft must target github.com/jpolvora/spec-driven-workflow/issues'
  );
  assert.ok(fwIssue.issueDraft.title, 'Issue draft must have a non-empty title');
  assert.ok(fwIssue.issueDraft.body, 'Issue draft must have a ready-to-file markdown body');

  // 3. Rendered markdown report in consumer project must output Upstream Issue Candidates section
  const mdReport = retro.renderMarkdown(retroResult.report);
  assert.match(
    mdReport,
    /Upstream Issue Candidates|github\.com\/jpolvora\/spec-driven-workflow\/issues/i,
    'Rendered markdown report must include Upstream Issue Candidates with link to github.com/jpolvora/spec-driven-workflow/issues'
  );

  // 4. In consumer workspace, validateCandidate rejects candidates proposing local modifications to vendored skills
  const invalidLocalModification = {
    id: 'RETRO-FW-002',
    title: 'Modify vendored skills locally',
    severity: 'high',
    category: 'automated-check',
    targetScope: 'consumer',
    evidence: {
      artifact: relState,
      ref: '#steps.4.output'
    },
    proposedChange: {
      target: '.agents/skills/sdw-retro/scripts/retro.cjs'
    }
  };

  const resMod = validateCandidates.validateCandidate(invalidLocalModification, { root: ws.root });
  assert.equal(resMod.valid, false, 'Modifying vendored skills locally in consumer project must be rejected');
  assert.ok(
    resMod.errors.some(e => e.code === 'skills-requires-spec' || e.code === 'vendored-skills-immutable' || e.message.includes('skills')),
    'Rejection must cite skills modification restriction'
  );
});
