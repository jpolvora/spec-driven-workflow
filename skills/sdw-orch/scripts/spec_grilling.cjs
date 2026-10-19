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

function analyzeSpecificationGaps(specContent) {
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

  return {
    hasGaps: gaps.length > 0,
    gapsCount: gaps.length,
    gaps,
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
  applyDecision
};
