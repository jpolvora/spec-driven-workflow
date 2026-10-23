'use strict';

// Spec 00030 AC3-AC6: acceptance-count bands plus the touchpoint escalation.
const LOW_MAX_ACS = 4;
const STANDARD_MAX_ACS = 10;
const ESCALATION_MIN_ACS = 7;
const ESCALATION_MIN_TOUCHPOINTS = 3;

// Spec 00030 AC9-AC13: fan-out bounds. A plan needing more than the cap is
// refused instead of merged into coarse tasks. Spec 00030 Notes retains
// `maxTasksPerSpec` with a default of five and bounds two to eight.
const MIN_COMPLEX_TASKS = 3;
const TASK_CAP_DEFAULT = 5;
const TASK_CAP_MIN = 2;
const TASK_CAP_MAX = 8;
const ACS_PER_TASK = 4;
const FILES_PER_TASK = 3;

/**
 * Spec 00030 Notes: resolves the effective task cap from `maxTasksPerSpec`
 * (options first, then `options.config`). Absent means the documented default
 * of five; any supplied value clamps to the documented two-to-eight bounds.
 */
function resolveTaskCap(options) {
  const opts = options || {};
  const configured = opts.maxTasksPerSpec !== undefined
    ? opts.maxTasksPerSpec
    : (opts.config && opts.config.maxTasksPerSpec);
  if (configured === undefined || configured === null) return TASK_CAP_DEFAULT;
  const value = Number(configured);
  if (!Number.isFinite(value)) return TASK_CAP_DEFAULT;
  return Math.min(TASK_CAP_MAX, Math.max(TASK_CAP_MIN, Math.trunc(value)));
}

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

  // Word boundaries only: unanchored fragments match unrelated prose ("project"
  // as "pr", "build" as "ui", "client" as "cli") and escalate specs to complex.
  if (/\bcli\b|\bcommands?\b|\bsubcommands?\b|\bflags?\b/i.test(content)) touchpoints.push('cli');
  if (/\bstate\b|\bpersistence\b|\bjson\b|\bdatabase\b|\bstore\b/i.test(content)) touchpoints.push('state');
  if (/\bgit\b|\bcommits?\b|\breview\b|\bdiff\b/i.test(content)) touchpoints.push('vcs');
  if (/\bprs?\b|\bpull requests?\b|\bcomments?\b/i.test(content)) touchpoints.push('pr');
  if (/\bui\b|\bviews?\b|\bfrontend\b|\bcomponents?\b/i.test(content)) touchpoints.push('ui');

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

function disjointPairKey(idA, idB) {
  return [idA, idB].sort().join('|');
}

/**
 * Wave level per task: the longest dependency chain that precedes it.
 */
function computeTaskLevels(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const levels = new Map();
  const resolve = (task, stack) => {
    if (levels.has(task.id)) return levels.get(task.id);
    if (stack.has(task.id)) return 0;
    stack.add(task.id);
    let level = 0;
    for (const depId of task.dependencies || []) {
      const dependency = byId.get(depId);
      if (dependency) level = Math.max(level, resolve(dependency, stack) + 1);
    }
    stack.delete(task.id);
    levels.set(task.id, level);
    return level;
  };
  for (const task of tasks) resolve(task, new Set());
  return levels;
}

/**
 * Spec 00030 AC15: pairwise file disjointness across every task pair.
 */
function computeFileDisjointness(tasks) {
  const pairs = [];
  for (let left = 0; left < tasks.length; left++) {
    for (let right = left + 1; right < tasks.length; right++) {
      const leftFiles = new Set((tasks[left].targetFiles || []).map(file => String(file).replace(/\\/g, '/')));
      const sharedFiles = (tasks[right].targetFiles || [])
        .filter(file => leftFiles.has(String(file).replace(/\\/g, '/')));
      pairs.push({
        pair: [tasks[left].id, tasks[right].id],
        disjoint: sharedFiles.length === 0,
        sharedFiles
      });
    }
  }
  return pairs;
}

/**
 * Spec 00030 AC16/AC17: records `execMode` with wave `levels` plus per-task
 * `level` and `parallelizable` flags. Flags are observable only; dispatch stays
 * one task at a time. A task is parallelizable only when it shares its wave with
 * another task whose file slice is disjoint from its own.
 */
function applyExecutionMetadata(tasks) {
  const levelsById = computeTaskLevels(tasks);
  const fileDisjointness = computeFileDisjointness(tasks);
  const disjointByPair = new Map(fileDisjointness.map(entry => [disjointPairKey(...entry.pair), entry.disjoint]));
  const waves = new Map();
  for (const task of tasks) {
    const level = levelsById.get(task.id) || 0;
    if (!waves.has(level)) waves.set(level, []);
    waves.get(level).push(task);
  }
  for (const task of tasks) {
    task.level = levelsById.get(task.id) || 0;
    const waveSiblings = waves.get(task.level).filter(sibling => sibling.id !== task.id);
    task.parallelizable = waveSiblings.length > 0
      && waveSiblings.every(sibling => disjointByPair.get(disjointPairKey(task.id, sibling.id)) === true);
  }
  const levels = [...waves.keys()].sort((a, b) => a - b)
    .map(level => waves.get(level).map(task => task.id));
  return { execMode: 'sequential', levels, fileDisjointness };
}

/**
 * Spec 00030 AC14: a plan refused by the cap names two focused specifications,
 * partitioning acceptance criteria and blueprint files in declaration order.
 */
function buildSplitProposal(slug, acs, targetFiles) {
  const suffixes = ['a', 'b'];
  const acHalves = splitContiguous(acs, 2);
  const fileHalves = targetFiles.length > 0 ? splitContiguous(targetFiles, 2) : [[], []];
  return suffixes.map((suffix, index) => ({
    slug: `${slug}-${suffix}`,
    acIds: (acHalves[index] || []).map(ac => ac.id),
    targetFiles: fileHalves[index] || []
  }));
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

  const tasks = [createTask({
    id: 'task-1',
    title: `Implement ${slug}`,
    description: 'Execute implementation for all specified acceptance criteria in an isolated unit.',
    acs,
    dependencies: [],
    targetFiles,
    prompt,
    architecturalApproach,
    testPlan
  })];

  return { complexity, taskCount: tasks.length, ...applyExecutionMetadata(tasks), tasks };
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

  const tasks = [
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
  ];

  return { complexity, taskCount: tasks.length, ...applyExecutionMetadata(tasks), tasks };
}

/**
 * Complex complexity: three to five slices of at most four acceptance criteria
 * each (declaration order) and three target files each (blueprint order). A
 * decomposition that needs more than the cap is refused (AC9-AC13).
 */
function buildComplexPlan(context) {
  const { slug, acs, complexity, targetFiles, architecturalApproach, testPlan, maxTasksPerSpec } = context;
  const acGroupsNeeded = Math.ceil(acs.length / ACS_PER_TASK);
  const fileSlicesNeeded = Math.ceil(targetFiles.length / FILES_PER_TASK);
  const tasksNeeded = Math.max(MIN_COMPLEX_TASKS, acGroupsNeeded, fileSlicesNeeded);

  if (tasksNeeded > maxTasksPerSpec) {
    return {
      refused: true,
      reason: 'split-required',
      complexity,
      tasksNeeded,
      cap: maxTasksPerSpec,
      taskCount: 0,
      execMode: 'sequential',
      levels: [],
      fileDisjointness: [],
      splitProposal: buildSplitProposal(slug, acs, targetFiles),
      tasks: []
    };
  }

  // A plan can never carry a task without criteria to implement, and a wider
  // task list than the criteria (or too many files per task) means the
  // decomposition cannot honour AC10/AC11: refuse and propose a split instead
  // of emitting an empty or oversized task.
  if (tasksNeeded > acs.length || fileSlicesNeeded > Math.min(tasksNeeded, acs.length)) {
    return {
      refused: true,
      reason: 'split-required',
      detail: 'criteria-undersupplied',
      complexity,
      tasksNeeded,
      cap: maxTasksPerSpec,
      acs: acs.length,
      targetFileCount: targetFiles.length,
      taskCount: 0,
      execMode: 'sequential',
      levels: [],
      fileDisjointness: [],
      splitProposal: buildSplitProposal(slug, acs, targetFiles),
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

  return { complexity, taskCount: tasks.length, ...applyExecutionMetadata(tasks), tasks };
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
  const maxTasksPerSpec = resolveTaskCap(opts);
  const context = { slug, acs, complexity, targetFiles, architecturalApproach, testPlan, maxTasksPerSpec };

  if (complexity.level === 'complex') return buildComplexPlan(context);
  if (complexity.level === 'standard') return buildStandardPlan(context);
  return buildSingleTaskPlan(context);
}

module.exports = {
  parseAcceptanceCriteria,
  analyzeComplexity,
  generateDagPlan
};
