'use strict';

const { execSync } = require('child_process');
const { parseAcceptanceCriteria } = require('./dag_planner.cjs');

function getTouchedFiles(baseCommit, projectRoot) {
  try {
    const cwd = projectRoot || process.cwd();
    let cmd = 'git status --porcelain';
    if (baseCommit) {
      cmd = `git diff --name-only ${baseCommit}`;
    }
    const output = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output
      .split('\n')
      .map(line => line.trim().replace(/^..\s+/, ''))
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

function getDiffContent(baseCommit, projectRoot) {
  try {
    const cwd = projectRoot || process.cwd();
    let cmd = 'git diff HEAD';
    if (baseCommit) {
      cmd = `git diff ${baseCommit}`;
    }
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    return '';
  }
}

function evaluateScore(specContent, options) {
  const minScore = (options && options.minScore) || 8;
  const projectRoot = (options && options.projectRoot) || process.cwd();
  const baseCommit = (options && options.baseCommit) || null;

  const acs = parseAcceptanceCriteria(specContent);
  if (acs.length === 0) {
    return {
      score: 10,
      passed: true,
      minScore,
      verifiedAcs: [],
      failingAcs: [],
      feedback: 'No explicit acceptance criteria found in spec. Default score assigned.'
    };
  }

  const touchedFiles = getTouchedFiles(baseCommit, projectRoot);
  const diffContent = getDiffContent(baseCommit, projectRoot);

  const verifiedAcs = [];
  const failingAcs = [];

  for (const ac of acs) {
    // Check if key tokens in the AC appear in diff or touched files
    const words = ac.text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['shall', 'when', 'while', 'where', 'then', 'the', 'system', 'that', 'with', 'from', 'each', 'this'].includes(w));

    let matches = 0;
    for (const w of words) {
      if (diffContent.toLowerCase().includes(w) || touchedFiles.some(f => f.toLowerCase().includes(w))) {
        matches++;
      }
    }

    const coverageRatio = words.length > 0 ? matches / words.length : 1;
    // If significant proportion of terms match in the implementation
    if (coverageRatio >= 0.4 || words.length === 0) {
      verifiedAcs.push({ id: ac.id, text: ac.text, coverageRatio });
    } else {
      failingAcs.push({ id: ac.id, text: ac.text, coverageRatio, missingKeywords: words.filter(w => !diffContent.toLowerCase().includes(w)) });
    }
  }

  const rawScore = Math.round((verifiedAcs.length / acs.length) * 10);
  const score = Math.max(0, Math.min(10, rawScore));
  const passed = score >= minScore;

  let feedback = '';
  if (!passed) {
    feedback = `Conformance score is ${score}/10 (minimum required: ${minScore}/10).\n` +
      `The following acceptance criteria lack observable evidence in touched files or diffs:\n` +
      failingAcs.map(f => `- ${f.id}: ${f.text}`).join('\n') +
      `\nPlease re-implement or verify these specific requirements.`;
  } else {
    feedback = `Conformance score is ${score}/10 (exceeds threshold ${minScore}/10). All ${verifiedAcs.length} acceptance criteria pass verification.`;
  }

  return {
    score,
    passed,
    minScore,
    totalAcs: acs.length,
    verifiedCount: verifiedAcs.length,
    failingCount: failingAcs.length,
    verifiedAcs,
    failingAcs,
    touchedFiles,
    feedback
  };
}

module.exports = {
  getTouchedFiles,
  getDiffContent,
  evaluateScore
};
