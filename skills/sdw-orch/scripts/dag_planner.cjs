'use strict';

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
  const complexity = analyzeComplexity(specContent);
  const acs = parseAcceptanceCriteria(specContent);
  const slugMatch = specContent ? specContent.match(/slug:\s*([^\r\n]+)/) : null;
  const slug = (options && options.slug) || (slugMatch ? slugMatch[1].trim() : 'task');

  const tasks = [];

  // Ingest technical blueprint from Step 2 (AC3)
  let defaultTargetFiles = [];
  let architecturalApproach = null;
  let testPlan = null;

  if (options && options.blueprint && Array.isArray(options.blueprint.targetFiles) && options.blueprint.targetFiles.length > 0) {
    defaultTargetFiles = options.blueprint.targetFiles;
    architecturalApproach = options.blueprint.architecturalApproach;
    testPlan = options.blueprint.testPlan;
  } else if (options && options.targetFiles && options.targetFiles.length > 0) {
    defaultTargetFiles = options.targetFiles;
  } else {
    // Missing blueprint in Step 2: log observable warning and fallback gracefully to heuristic file inference
    console.warn('[Step 3: DAG Generation] Warning: Step 2 refinement blueprint missing or has no targetFiles; falling back to heuristic file inference.');
    if (slug.includes('orch') || slug.includes('implement')) {
      defaultTargetFiles = [
        'skills/sdw-orch/scripts/sdw_orch.cjs',
        'skills/sdw-orch/scripts/state_manager.cjs',
        'skills/sdw-orch/scripts/spec_derivation.cjs',
        'skills/sdw-orch/scripts/spec_grilling.cjs',
        'skills/sdw-orch/scripts/dag_planner.cjs',
        'skills/sdw-orch/scripts/score_evaluator.cjs',
        'skills/sdw-orch/scripts/review_runner.cjs'
      ];
    } else if (slug.includes('config')) {
      defaultTargetFiles = ['skills/sdw-config/scripts/sdw_config.cjs'];
    } else if (slug.includes('router')) {
      defaultTargetFiles = [
        'skills/sdw-router/SKILL.md',
        'skills/sdw-router/references/routing_table.md',
        'skills/sdw-router/references/consumer_agents_setup.md',
        'skills/sdw-router/scripts/sdw_router.cjs'
      ];
    } else if (slug.includes('spec')) {
      defaultTargetFiles = [
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
  }

  if (!complexity.isComplex || acs.length <= 3) {
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
  } else {
    // Multi-task DAG decomposition
    // Task 1: Core foundation / state / data models
    const t1Acs = acs.slice(0, Math.ceil(acs.length / 2));
    const t2Acs = acs.slice(Math.ceil(acs.length / 2));

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
      targetFiles: defaultTargetFiles.slice(0, 4),
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
      targetFiles: defaultTargetFiles.slice(4),
      architecturalApproach: architecturalApproach || undefined,
      testPlan: testPlan || undefined,
      contextPrompt: p2
    });
  }

  return {
    complexity,
    totalTasks: tasks.length,
    tasks
  };
}

module.exports = {
  parseAcceptanceCriteria,
  analyzeComplexity,
  generateDagPlan
};
