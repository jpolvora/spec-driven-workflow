'use strict';

const fs = require('fs');
const path = require('path');
const specGrilling = require('./spec_grilling.cjs');
const { isTestFile, DEFAULT_TEST_PATTERNS } = require('./evidence_validator.cjs');

// A plan that resolves no target file promises nothing, so it is refused and
// the author is told the declaration the specification must add.
const NO_TARGET_FILES_DECLARATION = 'name the implementation files in backticks, or declare the files this work creates under a `New files` note';

// The only remaining fallback: a known real-file bucket, named by the skill it
// describes. A bucket file the repository lacks refuses the plan instead of
// dispatching a slice that cannot exist.
const FALLBACK_RULES = [
  {
    rule: 'run',
    matches: (slug) => slug.includes('sdw-run') || slug.includes('implement'),
    files: [
      'skills/sdw-run/scripts/sdw_run.cjs',
      'skills/sdw-run/scripts/state_manager.cjs',
      'skills/sdw-run/scripts/spec_derivation.cjs',
      'skills/sdw-run/scripts/spec_grilling.cjs',
      'skills/sdw-run/scripts/dag_planner.cjs',
      'skills/sdw-run/scripts/score_evaluator.cjs',
      'skills/sdw-code-review/scripts/sdw_code_review.cjs'
    ]
  },
  {
    rule: 'config',
    matches: (slug) => slug.includes('sdw-config'),
    files: ['skills/sdw-config/scripts/sdw_config.cjs']
  },
  {
    rule: 'router',
    matches: (slug) => slug.includes('sdw-router'),
    files: [
      'skills/sdw-router/SKILL.md',
      'skills/sdw-router/references/routing_table.md',
      'skills/sdw-router/references/consumer_agents_setup.md',
      'skills/sdw-router/scripts/sdw_router.cjs'
    ]
  },
  {
    rule: 'spec',
    matches: (slug) => slug.includes('sdw-spec'),
    files: [
      'skills/sdw-spec/SKILL.md',
      'skills/sdw-spec/scripts/sdw_spec.cjs',
      'skills/sdw-spec/scripts/validate_spec.cjs',
      'skills/sdw-spec/scripts/spec_index.cjs',
      'skills/sdw-spec/scripts/spec_creator.cjs',
      'skills/sdw-spec/scripts/scm_provider_contract.cjs',
      'skills/sdw-spec/scripts/spec_sync.cjs',
      'skills/sdw-spec/references/spec_standard.md',
      'skills/sdw-spec/references/scm_contract.md'
    ]
  }
];

/** Resolves the fallback bucket for a slug, or null when no bucket matches. */
function inferFallbackTargetFiles(slug) {
  const value = String(slug || '');
  const bucket = FALLBACK_RULES.find((candidate) => candidate.matches(value));
  if (!bucket) return null;
  return { rule: bucket.rule, targetFiles: bucket.files.slice() };
}

/** Files from the resolved fallback bucket that the target repository lacks. */
function findMissingFallbackFiles(fallback, targetRoot) {
  return fallback.targetFiles.filter((file) => !fs.existsSync(path.join(targetRoot, file)));
}

/**
 * The declared new files reach the plan through the Step 2 blueprint; a caller
 * that already resolved them passes them directly, and a caller that passes
 * neither gets the specification's own declaration.
 */
function readDeclaredNewFiles(opts, specContent) {
  if (opts.blueprint && Array.isArray(opts.blueprint.declaredNewFiles)) {
    return opts.blueprint.declaredNewFiles.slice();
  }
  if (Array.isArray(opts.declaredNewFiles)) return opts.declaredNewFiles.slice();
  return specGrilling.extractDeclaredNewFiles(specContent);
}

function parseAcceptanceCriteria(specContent) {
  const matches = [...specContent.matchAll(/^- (AC\d+):\s*(.+)$/gm)];
  return matches.map(m => ({
    id: m[1],
    text: m[2].trim()
  }));
}

function analyzeComplexity(specContent) {
  const acs = parseAcceptanceCriteria(specContent);
  const touchpoints = [];

  if (/cli|command|subcommand|flags/i.test(specContent)) touchpoints.push('cli');
  if (/state|persistence|json|database|store/i.test(specContent)) touchpoints.push('state');
  if (/git|commit|review|diff/i.test(specContent)) touchpoints.push('vcs');
  if (/pr|pull request|comments/i.test(specContent)) touchpoints.push('pr');
  if (/ui|view|frontend|component/i.test(specContent)) touchpoints.push('ui');

  const isComplex = acs.length > 5 || touchpoints.length >= 3;
  return {
    acCount: acs.length,
    touchpoints,
    level: isComplex ? 'complex' : 'simple',
    isComplex
  };
}

function generateDagPlan(specContent, options) {
  const opts = options || {};
  const targetRoot = path.resolve(opts.targetRoot || '.');
  const complexity = analyzeComplexity(specContent);
  const acs = parseAcceptanceCriteria(specContent);
  const slugMatch = specContent ? specContent.match(/slug:\s*([^\r\n]+)/) : null;
  const slug = opts.slug || (slugMatch ? slugMatch[1].trim() : 'task');

  const tasks = [];

  // Ingest technical blueprint from Step 2 (AC3)
  let defaultTargetFiles = [];
  let architecturalApproach = null;
  let testPlan = null;
  const declaredNewFiles = readDeclaredNewFiles(opts, specContent);

  if (opts.blueprint && Array.isArray(opts.blueprint.targetFiles) && opts.blueprint.targetFiles.length > 0) {
    defaultTargetFiles = opts.blueprint.targetFiles.slice();
    architecturalApproach = opts.blueprint.architecturalApproach;
    testPlan = opts.blueprint.testPlan;
  } else if (Array.isArray(opts.targetFiles) && opts.targetFiles.length > 0) {
    defaultTargetFiles = opts.targetFiles.slice();
  } else {
    // Missing blueprint or pathless specification: fall back to the paths the
    // specification names, then to a known real-file bucket used only when every
    // file it names exists. A missing bucket file refuses the plan instead of
    // planning it.
    console.warn('[Step 3: DAG Generation] Warning: Step 2 refinement blueprint missing or has no targetFiles; falling back to heuristic file inference.');
    const fallback = inferFallbackTargetFiles(slug);
    if (fallback) {
      const missingFiles = findMissingFallbackFiles(fallback, targetRoot);
      if (missingFiles.length > 0) {
        return {
          refused: true,
          reason: 'missing-target-file',
          fallbackRule: fallback.rule,
          missingFiles,
          specSlug: slug,
          complexity,
          totalTasks: 0,
          tasks: []
        };
      }
      defaultTargetFiles = fallback.targetFiles.slice();
    } else {
      // The specification's own named paths (or the files it declares new) are
      // still its promise, so a path-naming specification is planned instead of
      // being refused as pathless.
      const namedFiles = specGrilling.extractTargetFiles(specContent || '');
      defaultTargetFiles = [...new Set([...namedFiles, ...declaredNewFiles])];
    }
  }

  // A specification that names no path and declares no new file plans no file
  // fence: the warning is recorded and the slice stays runnable, but no path is
  // ever synthesized from the slug.
  if (defaultTargetFiles.length === 0) {
    console.warn('[Step 3: DAG Generation] Warning: the specification names no target file and declares no new file; the plan carries no file fence.');
  }

  const hasTestingConfig = (opts.enableTestingFeatures !== undefined) ||
    (opts.config && opts.config.enableTestingFeatures !== undefined);

  const enableTestingFeatures = hasTestingConfig
    ? (opts.enableTestingFeatures !== undefined
      ? Boolean(opts.enableTestingFeatures)
      : Boolean(opts.config.enableTestingFeatures))
    : true;

  if (!enableTestingFeatures) {
    console.log('[Step 3: DAG Generation] Testing features disabled (enableTestingFeatures: false); skipping test task generation.');
  }

  const rawSegregate = opts.segregateTests !== undefined
    ? Boolean(opts.segregateTests)
    : (opts.config && opts.config.implementation && opts.config.implementation.segregateTests !== undefined
      ? Boolean(opts.config.implementation.segregateTests)
      : true);

  const segregateTests = enableTestingFeatures && rawSegregate;

  const testPatterns = (Array.isArray(opts.testPatterns) && opts.testPatterns.length > 0)
    ? opts.testPatterns
    : ((opts.config && opts.config.implementation && Array.isArray(opts.config.implementation.testPatterns))
      ? opts.config.implementation.testPatterns
      : DEFAULT_TEST_PATTERNS);

  const testTargetFiles = defaultTargetFiles.filter(f => isTestFile(f, testPatterns));
  const prodTargetFiles = defaultTargetFiles.filter(f => !isTestFile(f, testPatterns));

  if (!complexity.isComplex || acs.length <= 3) {
    if (segregateTests) {
      let testPrompt = `You are authoring tests for the feature "${slug}". Write failing tests strictly asserting assigned acceptance criteria without modifying production code:\n` +
        acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (architecturalApproach) testPrompt += `\n\nArchitectural Approach:\n${architecturalApproach}`;
      if (testPlan) testPrompt += `\n\nTest Plan:\n${testPlan}`;

      tasks.push({
        id: 'task-1-test',
        role: 'test_author',
        title: `Author Tests for ${slug}`,
        description: 'Write failing tests strictly asserting assigned acceptance criteria without modifying production code.',
        coveredAcs: acs.map(a => a.id),
        dependencies: [],
        status: 'pending',
        targetFiles: testTargetFiles,
        testPatterns,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: testPrompt
      });

      let implPrompt = `You are implementing the feature "${slug}". Satisfy the existing test suite for the following acceptance criteria without modifying test files:\n` +
        acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (architecturalApproach) implPrompt += `\n\nArchitectural Approach:\n${architecturalApproach}`;
      if (testPlan) implPrompt += `\n\nTest Plan:\n${testPlan}`;

      tasks.push({
        id: 'task-1-impl',
        role: 'implementation',
        title: `Implement ${slug}`,
        description: 'Execute implementation to satisfy the test suite for all specified acceptance criteria without modifying test files.',
        coveredAcs: acs.map(a => a.id),
        dependencies: ['task-1-test'],
        status: 'pending',
        targetFiles: prodTargetFiles,
        testPatterns,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: implPrompt
      });
    } else {
      // Single execution unit
      let prompt = `You are implementing the feature "${slug}". Focus strictly on the following acceptance criteria:\n` +
        acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (architecturalApproach) prompt += `\n\nArchitectural Approach:\n${architecturalApproach}`;
      if (testPlan) prompt += `\n\nTest Plan:\n${testPlan}`;

      tasks.push({
        id: 'task-1',
        title: `Implement ${slug}`,
        description: 'Execute implementation for all specified acceptance criteria in an isolated unit.',
        coveredAcs: acs.map(a => a.id),
        dependencies: [],
        status: 'pending',
        targetFiles: defaultTargetFiles,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: prompt
      });
    }
  } else {
    // Multi-task DAG decomposition. Both execution units may touch any file the
    // specification names: the AC split, not an arbitrary file slice, defines
    // ownership, and a later task often needs to extend a file the first created.
    // Task 1: Core foundation / state / data models
    const t1Acs = acs.slice(0, Math.ceil(acs.length / 2));
    const t2Acs = acs.slice(Math.ceil(acs.length / 2));

    if (segregateTests) {
      let tp1 = `You are authoring tests for Task 1 (Core Logic) of "${slug}". Write failing tests strictly asserting assigned acceptance criteria without modifying production code:\n` +
        t1Acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (architecturalApproach) tp1 += `\n\nArchitectural Approach:\n${architecturalApproach}`;
      if (testPlan) tp1 += `\n\nTest Plan:\n${testPlan}`;

      tasks.push({
        id: 'task-1-test',
        role: 'test_author',
        title: `${slug} — Test Authoring (Core Logic & Foundation)`,
        description: 'Author failing tests strictly asserting core logic acceptance criteria without modifying production code.',
        coveredAcs: t1Acs.map(a => a.id),
        dependencies: [],
        status: 'pending',
        targetFiles: testTargetFiles,
        testPatterns,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: tp1
      });

      let ip1 = `You are implementing Task 1 (Core Logic) for "${slug}". Satisfy the existing test suite without modifying test files. Focus strictly on:\n` +
        t1Acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (architecturalApproach) ip1 += `\n\nArchitectural Approach:\n${architecturalApproach}`;

      tasks.push({
        id: 'task-1-impl',
        role: 'implementation',
        title: `${slug} — Core Logic & Foundation`,
        description: 'Implement core modules, state management, and baseline logic to satisfy test suite without modifying test files.',
        coveredAcs: t1Acs.map(a => a.id),
        dependencies: ['task-1-test'],
        status: 'pending',
        targetFiles: prodTargetFiles,
        testPatterns,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: ip1
      });

      let tp2 = `You are authoring tests for Task 2 (Workflows & Integration) of "${slug}". Write failing tests strictly asserting assigned acceptance criteria without modifying production code:\n` +
        t2Acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (testPlan) tp2 += `\n\nTest Plan:\n${testPlan}`;

      tasks.push({
        id: 'task-2-test',
        role: 'test_author',
        title: `${slug} — Test Authoring (Workflows & Integration)`,
        description: 'Author failing tests strictly asserting downstream workflow and integration criteria without modifying production code.',
        coveredAcs: t2Acs.map(a => a.id),
        dependencies: ['task-1-impl'],
        status: 'pending',
        targetFiles: testTargetFiles,
        testPatterns,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: tp2
      });

      let ip2 = `You are implementing Task 2 (Workflows & Integration) for "${slug}". Satisfy the existing test suite without modifying test files. Focus strictly on:\n` +
        t2Acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (testPlan) ip2 += `\n\nTest Plan:\n${testPlan}`;

      tasks.push({
        id: 'task-2-impl',
        role: 'implementation',
        title: `${slug} — Workflows, Verification & PR Integration`,
        description: 'Implement downstream workflow loops, reviews, and integrations to satisfy test suite without modifying test files.',
        coveredAcs: t2Acs.map(a => a.id),
        dependencies: ['task-2-test'],
        status: 'pending',
        targetFiles: prodTargetFiles,
        testPatterns,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: ip2
      });
    } else {
      let p1 = `You are implementing Task 1 (Core Logic) for "${slug}". Focus strictly on:\n` +
        t1Acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (architecturalApproach) p1 += `\n\nArchitectural Approach:\n${architecturalApproach}`;

      tasks.push({
        id: 'task-1',
        title: `${slug} — Core Logic & Foundation`,
        description: 'Implement core modules, state management, and baseline logic.',
        coveredAcs: t1Acs.map(a => a.id),
        dependencies: [],
        status: 'pending',
        targetFiles: defaultTargetFiles,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: p1
      });

      let p2 = `You are implementing Task 2 (Workflows & Integration) for "${slug}". Focus strictly on:\n` +
        t2Acs.map(a => `- ${a.id}: ${a.text}`).join('\n');
      if (testPlan) p2 += `\n\nTest Plan:\n${testPlan}`;

      tasks.push({
        id: 'task-2',
        title: `${slug} — Workflows, Verification & PR Integration`,
        description: 'Implement downstream workflow loops, reviews, and integrations.',
        coveredAcs: t2Acs.map(a => a.id),
        dependencies: ['task-1'],
        status: 'pending',
        targetFiles: defaultTargetFiles,
        architecturalApproach: architecturalApproach || undefined,
        testPlan: testPlan || undefined,
        contextPrompt: p2
      });
    }
  }

  return {
    complexity,
    totalTasks: tasks.length,
    tasks
  };
}

module.exports = {
  NO_TARGET_FILES_DECLARATION,
  FALLBACK_RULES,
  inferFallbackTargetFiles,
  findMissingFallbackFiles,
  readDeclaredNewFiles,
  parseAcceptanceCriteria,
  analyzeComplexity,
  generateDagPlan
};
