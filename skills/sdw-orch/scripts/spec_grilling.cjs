'use strict';

const fs = require('fs');
const path = require('path');

const DECISION_DIMENSIONS = [
  {
    name: 'input_validation',
    question: 'How should invalid or malformed inputs be handled?',
    check: (content) => /invalid|malformed|bounds|validation|sanitiz/i.test(content),
    options: [
      '(Recommended) Fail-fast with descriptive error message and non-zero exit code',
      'Ignore invalid input and continue with safe defaults',
      'Prompt user interactively to correct the input'
    ]
  },
  {
    name: 'error_recovery',
    question: 'What strategy should be used when an unrecoverable failure occurs in a task?',
    check: (content) => /unrecoverable|failure|fallback|abort|rollback/i.test(content),
    options: [
      '(Recommended) Persist failure state to run state file and halt execution immediately',
      'Roll back changes to base commit and exit',
      'Skip the failing task and proceed to next task'
    ]
  },
  {
    name: 'concurrency_and_ordering',
    question: 'How should task execution ordering be scheduled?',
    check: (content) => /concurrency|parallel|paralel|sequential|ordering|dependency|single execution unit/i.test(content),
    options: [
      '(Recommended) Execute sequentially by default, parallelizing only independent DAG tasks',
      'Execute all tasks sequentially without parallelization',
      'Execute all tasks concurrently with independent workers'
    ]
  },
  {
    name: 'state_persistence',
    question: 'Where should session state be persisted across runs?',
    check: (content) => /\.sdw\/state|state file|session state|\.state\.json/i.test(content),
    options: [
      '(Recommended) Persist to .sdw/state/{runId}.state.json',
      'Store ephemeral state in memory without writing to disk',
      'Persist state to repo root .state.json'
    ]
  }
];

function extractTargetFiles(specContent) {
  if (!specContent) return [];
  const files = new Set();
  const matches = specContent.matchAll(/`([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]{1,5})`/g);
  for (const m of matches) {
    const p = m[1].replace(/\\/g, '/');
    if (p.includes('/') || p.endsWith('.json') || p.endsWith('.cjs') || p.endsWith('.js') || p.endsWith('.md')) {
      if (!p.startsWith('http') && !p.includes('*') && !p.includes('{') && !p.includes('schema#')) {
        files.add(p);
      }
    }
  }
  return Array.from(files);
}

function extractArchitecturalApproach(specContent) {
  if (!specContent) return 'Implement canonical architecture conforming strictly to specification acceptance criteria.';
  const designIntentMatch = specContent.match(/### Design Intent\s*\r?\n([\s\S]*?)(?=\r?\n## |\r?\n$)/);
  if (designIntentMatch && designIntentMatch[1].trim()) {
    return designIntentMatch[1].trim().split('\n')[0].trim();
  }
  const descMatch = specContent.match(/## Description\s*\r?\n([\s\S]*?)(?=\r?\n### |\r?\n## |\r?\n$)/);
  if (descMatch && descMatch[1].trim()) {
    return descMatch[1].trim().split('\n')[0].trim();
  }
  return 'Implement canonical architecture conforming strictly to specification acceptance criteria.';
}

function extractTestPlan(specContent) {
  if (!specContent) return 'Execute native automated test suite verifying all acceptance criteria and negative failure scenarios.';
  const negMatch = specContent.match(/### Negative & Failing Test Scenarios\s*\r?\n([\s\S]*?)(?=\r?\n## |\r?\n$)/);
  if (negMatch && negMatch[1].trim()) {
    return negMatch[1].trim().split('\n')[0].replace(/^[-*+]\s+/, '').trim();
  }
  return 'Execute native automated test suite verifying all acceptance criteria and negative failure scenarios.';
}

function generateRefinementBlueprint(specContent, options = {}) {
  let targetFiles = options.targetFiles || extractTargetFiles(specContent);
  if (!targetFiles || targetFiles.length === 0) {
    const slugMatch = specContent ? specContent.match(/slug:\s*([^\r\n]+)/) : null;
    const slug = options.slug || (slugMatch ? slugMatch[1].trim() : 'spec');
    if (slug.includes('orch')) {
      targetFiles = ['skills/sdw-orch/scripts/sdw_orch.cjs', 'skills/sdw-orch/scripts/dag_planner.cjs'];
    } else {
      targetFiles = [`skills/${slug}/scripts/${slug}.cjs`];
    }
  }

  return {
    targetFiles,
    architecturalApproach: extractArchitecturalApproach(specContent),
    testPlan: extractTestPlan(specContent)
  };
}

function analyzeSpecificationGaps(specContent, options = {}) {
  const gaps = [];

  for (const dim of DECISION_DIMENSIONS) {
    const covered = dim.check(specContent);
    if (!covered) {
      gaps.push({
        dimension: dim.name,
        question: dim.question,
        options: dim.options,
        defaultChoice: dim.options[0]
      });
    }
  }

  const blueprint = generateRefinementBlueprint(specContent, options);

  return {
    hasGaps: gaps.length > 0,
    gapsCount: gaps.length,
    gaps,
    blueprint,
    decisionTreeWalk: {
      totalDimensionsChecked: DECISION_DIMENSIONS.length,
      coveredDimensions: DECISION_DIMENSIONS.length - gaps.length
    }
  };
}

function applyDecision(specContent, dimension, chosenOption) {
  const decisionNote = `\n<!-- Decision Gate: [${dimension}] -> ${chosenOption} -->\n`;
  if (specContent.includes('## Assumptions & Open Questions')) {
    return specContent.replace(
      '## Assumptions & Open Questions',
      `## Assumptions & Open Questions\n| ${dimension} | ${chosenOption.replace(/^\(Recommended\)\s*/, '')} | Grilling decision confirmed | y |\n`
    );
  }
  return specContent + decisionNote;
}

module.exports = {
  DECISION_DIMENSIONS,
  analyzeSpecificationGaps,
  applyDecision,
  generateRefinementBlueprint,
  extractTargetFiles
};
