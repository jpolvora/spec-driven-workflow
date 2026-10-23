'use strict';

// Spec 00030 AC3-AC6: acceptance-count bands plus the touchpoint escalation.
const LOW_MAX_ACS = 4;
const STANDARD_MAX_ACS = 10;
const ESCALATION_MIN_ACS = 7;
const ESCALATION_MIN_TOUCHPOINTS = 3;

// Spec 00030 AC9-AC13: fan-out bounds. A plan needing more than the cap is
// refused instead of merged into coarse tasks.
const MIN_COMPLEX_TASKS = 3;
const MAX_TASKS_PER_SPEC = 5;
const ACS_PER_TASK = 4;
const FILES_PER_TASK = 3;

function parseAcceptanceCriteria(specContent) {
  const matches = [...String(specContent || '').matchAll(/^- (AC\d+):\s*(.+)$/gm)];
  return matches.map(m => ({
    id: m[1],
    text: m[2].trim()
  }));
}

/**
 * Keeps the first declaration of each criterion. A derived specification can
 * repeat its acceptance criteria in the embedded source and the derived
 * section; the same id is one criterion and must be assigned to one task
 * (spec 00030 AC12).
 */
function uniqueAcceptanceCriteria(acs) {
  const seen = new Set();
  const unique = [];
  for (const ac of acs) {
    if (seen.has(ac.id)) continue;
    seen.add(ac.id);
    unique.push(ac);
  }
  return unique;
}

function detectTouchpoints(specContent) {
  const content = String(specContent || '');
  const touchpoints = [];

  if (/cli|command|subcommand|flags/i.test(content)) touchpoints.push('cli');
  if (/state|persistence|json|database|store/i.test(content)) touchpoints.push('state');
  if (/git|commit|review|diff/i.test(content)) touchpoints.push('vcs');
  if (/pr|pull request|comments/i.test(content)) touchpoints.push('pr');
  if (/ui|view|frontend|component/i.test(content)) touchpoints.push('ui');

  return touchpoints;
}

/**
 * Reads the Step 2 blueprint target files (spec 00030 AC2). Falls back to an
 * explicit targetFiles option for callers that already resolved the blueprint.
 */
function readBlueprintTargetFiles(options) {
  const opts = options || {};
  const blueprintFiles = opts.blueprint && Array.isArray(opts.blueprint.targetFiles)
    ? opts.blueprint.targetFiles
    : [];
  if (blueprintFiles.length > 0) return blueprintFiles.slice();
  if (Array.isArray(opts.targetFiles) && opts.targetFiles.length > 0) return opts.targetFiles.slice();
  return [];
}

/**
 * Classifies the refined specification from its declared acceptance criteria
 * plus the Step 2 blueprint target files (spec 00030 AC1-AC6).
 */
function analyzeComplexity(specContent, options) {
  const content = String(specContent || '');
  const acs = uniqueAcceptanceCriteria(parseAcceptanceCriteria(content));
  const touchpoints = detectTouchpoints(content);
  const targetFiles = readBlueprintTargetFiles(options);

  const escalated = acs.length >= ESCALATION_MIN_ACS && touchpoints.length >= ESCALATION_MIN_TOUCHPOINTS;
  let level;
  if (acs.length > STANDARD_MAX_ACS || escalated) {
    level = 'complex';
  } else if (acs.length <= LOW_MAX_ACS) {
    level = 'low';
  } else {
    level = 'standard';
  }

  return {
    acCount: acs.length,
    touchpoints,
    targetFileCount: targetFiles.length,
    level,
    isComplex: level === 'complex'
  };
}

/**
 * Splits items into contiguous, balanced chunks that preserve their order. Used
 * for both acceptance criteria (declaration order) and target files (blueprint
 * order).
 */
function splitContiguous(items, parts) {
  const list = Array.isArray(items) ? items : [];
  const count = Math.max(1, parts || 1);
  const base = Math.floor(list.length / count);
  const extra = list.length % count;
  const chunks = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    const size = base + (index < extra ? 1 : 0);
    chunks.push(list.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

function renderAcceptanceCriteria(acs) {
  return acs.map(ac => `- ${ac.id}: ${ac.text}`).join('\n');
}

function appendGuidance(prompt, guidance) {
  let text = prompt;
  if (guidance && guidance.architecturalApproach) text += `\n\nArchitectural Approach:\n${guidance.architecturalApproach}`;
  if (guidance && guidance.testPlan) text += `\n\nTest Plan:\n${guidance.testPlan}`;
  return text;
}

function createTask(options) {
  const { id, title, description, acs, dependencies, targetFiles, prompt, architecturalApproach, testPlan } = options;
  return {
    id,
    title,
    description,
    coveredAcs: acs.map(ac => ac.id),
    dependencies: (dependencies || []).slice(),
    status: 'pending',
    targetFiles: (targetFiles || []).slice(),
    architecturalApproach: architecturalApproach || undefined,
    testPlan: testPlan || undefined,
    contextPrompt: prompt
  };
}

function inferFallbackTargetFiles(slug) {
  if (slug.includes('orch') || slug.includes('implement')) {
    return [
      'skills/sdw-orch/scripts/sdw_orch.cjs',
      'skills/sdw-orch/scripts/state_manager.cjs',
      'skills/sdw-orch/scripts/spec_derivation.cjs',
      'skills/sdw-orch/scripts/spec_grilling.cjs',
      'skills/sdw-orch/scripts/dag_planner.cjs',
      'skills/sdw-orch/scripts/score_evaluator.cjs',
      'skills/sdw-code-review/scripts/sdw_code_review.cjs'
    ];
  }
  if (slug.includes('config')) {
    return ['skills/sdw-config/scripts/sdw_config.cjs'];
  }
  if (slug.includes('router')) {
    return [
      'skills/sdw-router/SKILL.md',
      'skills/sdw-router/references/routing_table.md',
      'skills/sdw-router/references/consumer_agents_setup.md',
      'skills/sdw-router/scripts/sdw_router.cjs'
    ];
  }
  if (slug.includes('spec')) {
    return [
      'skills/sdw-spec/SKILL.md',
      'skills/sdw-spec/scripts/sdw_spec.cjs',
      'skills/sdw-spec/scripts/validate_spec.cjs',
      'skills/sdw-spec/scripts/spec_index.cjs',
      'skills/sdw-spec/scripts/spec_creator.cjs',
      'skills/sdw-spec/scripts/scm_provider_contract.cjs',
      'skills/sdw-spec/scripts/spec_sync.cjs',
      'skills/sdw-spec/references/spec_standard.md',
      'skills/sdw-spec/references/scm_contract.md'
    ];
  }
  return [];
}

/** Low complexity: exactly one task carrying every criterion (AC7). */
function buildSingleTaskPlan(context) {
  const { slug, acs, complexity, targetFiles, architecturalApproach, testPlan } = context;
  const prompt = appendGuidance(
    `You are implementing the feature "${slug}". Focus strictly on the following acceptance criteria:\n` +
      renderAcceptanceCriteria(acs),
    { architecturalApproach, testPlan }
  );

  return {
    complexity,
    totalTasks: 1,
    tasks: [createTask({
      id: 'task-1',
      title: `Implement ${slug}`,
      description: 'Execute implementation for all specified acceptance criteria in an isolated unit.',
      acs,
      dependencies: [],
      targetFiles,
      prompt,
      architecturalApproach,
      testPlan
    })]
  };
}

/** Standard complexity: the foundation-plus-integration two-task split (AC8). */
function buildStandardPlan(context) {
  const { slug, acs, complexity, targetFiles, architecturalApproach, testPlan } = context;
  const [foundationAcs, integrationAcs] = splitContiguous(acs, 2);

  const foundationPrompt = appendGuidance(
    `You are implementing Task 1 (Core Logic) for "${slug}". Focus strictly on:\n` +
      renderAcceptanceCriteria(foundationAcs),
    { architecturalApproach }
  );
  const integrationPrompt = appendGuidance(
    `You are implementing Task 2 (Workflows & Integration) for "${slug}". Focus strictly on:\n` +
      renderAcceptanceCriteria(integrationAcs),
    { testPlan }
  );

  return {
    complexity,
    totalTasks: 2,
    tasks: [
      createTask({
        id: 'task-1',
        title: `${slug} — Core Logic & Foundation`,
        description: 'Implement core modules, state management, and baseline logic.',
        acs: foundationAcs,
        dependencies: [],
        targetFiles,
        prompt: foundationPrompt,
        architecturalApproach,
        testPlan
      }),
      createTask({
        id: 'task-2',
        title: `${slug} — Workflows, Verification & PR Integration`,
        description: 'Implement downstream workflow loops, reviews, and integrations.',
        acs: integrationAcs,
        dependencies: ['task-1'],
        targetFiles,
        prompt: integrationPrompt,
        architecturalApproach,
        testPlan
      })
    ]
  };
}

/**
 * Complex complexity: three to five slices of at most four acceptance criteria
 * each (declaration order) and three target files each (blueprint order). A
 * decomposition that needs more than the cap is refused (AC9-AC13).
 */
function buildComplexPlan(context) {
  const { slug, acs, complexity, targetFiles, architecturalApproach, testPlan } = context;
  const acGroupsNeeded = Math.ceil(acs.length / ACS_PER_TASK);
  const fileSlicesNeeded = Math.ceil(targetFiles.length / FILES_PER_TASK);
  const tasksNeeded = Math.max(MIN_COMPLEX_TASKS, acGroupsNeeded, fileSlicesNeeded);

  if (tasksNeeded > MAX_TASKS_PER_SPEC) {
    return {
      refused: true,
      reason: 'split-required',
      complexity,
      tasksNeeded,
      cap: MAX_TASKS_PER_SPEC,
      totalTasks: 0,
      tasks: []
    };
  }

  const acGroups = splitContiguous(acs, tasksNeeded);
  const fileSlices = targetFiles.length > 0 ? splitContiguous(targetFiles, tasksNeeded) : acGroups.map(() => []);

  const tasks = acGroups.map((group, index) => {
    const id = `task-${index + 1}`;
    const prompt = appendGuidance(
      `You are implementing Task ${index + 1} (Slice ${index + 1} of ${tasksNeeded}) for "${slug}". Focus strictly on:\n` +
        renderAcceptanceCriteria(group),
      {
        architecturalApproach: index === 0 ? architecturalApproach : null,
        testPlan: index === tasksNeeded - 1 ? testPlan : null
      }
    );

    return createTask({
      id,
      title: `${slug} — Slice ${index + 1} of ${tasksNeeded}`,
      description: 'Implement the assigned acceptance criteria on this file slice.',
      acs: group,
      dependencies: index === 0 ? [] : [`task-${index}`],
      targetFiles: fileSlices[index] || [],
      prompt,
      architecturalApproach,
      testPlan
    });
  });

  return { complexity, totalTasks: tasks.length, tasks };
}

function generateDagPlan(specContent, options) {
  const opts = options || {};
  const content = String(specContent || '');
  const acs = uniqueAcceptanceCriteria(parseAcceptanceCriteria(content));
  const slugMatch = content.match(/slug:\s*([^\r\n]+)/);
  const slug = opts.slug || (slugMatch ? slugMatch[1].trim() : 'task');

  // Ingest the technical blueprint from Step 2 (AC2).
  let targetFiles = [];
  let architecturalApproach = null;
  let testPlan = null;

  if (opts.blueprint && Array.isArray(opts.blueprint.targetFiles) && opts.blueprint.targetFiles.length > 0) {
    targetFiles = opts.blueprint.targetFiles.slice();
    architecturalApproach = opts.blueprint.architecturalApproach;
    testPlan = opts.blueprint.testPlan;
  } else if (Array.isArray(opts.targetFiles) && opts.targetFiles.length > 0) {
    targetFiles = opts.targetFiles.slice();
  } else {
    // Missing blueprint in Step 2: log observable warning and fall back to heuristic file inference.
    console.warn('[Step 3: DAG Generation] Warning: Step 2 refinement blueprint missing or has no targetFiles; falling back to heuristic file inference.');
    targetFiles = inferFallbackTargetFiles(slug);
  }

  const complexity = analyzeComplexity(content, { targetFiles });
  const context = { slug, acs, complexity, targetFiles, architecturalApproach, testPlan };

  if (complexity.level === 'complex') return buildComplexPlan(context);
  if (complexity.level === 'standard') return buildStandardPlan(context);
  return buildSingleTaskPlan(context);
}

module.exports = {
  parseAcceptanceCriteria,
  analyzeComplexity,
  generateDagPlan
};
