'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseAcceptanceCriteria } = require('./dag_planner.cjs');

function getTouchedFiles(baseCommit, projectRoot) {
  const cwd = projectRoot || process.cwd();
  const fileSet = new Set();
  try {
    if (baseCommit) {
      // Check uncommitted changes vs baseCommit
      const diffUncommitted = execSync(`git diff --name-only ${baseCommit}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      diffUncommitted.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(f));

      // Check committed changes between baseCommit and HEAD
      const diffCommitted = execSync(`git diff --name-only ${baseCommit} HEAD`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      diffCommitted.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(f));
    }

    // Also include currently modified or untracked files
    const statusOut = execSync('git status --porcelain', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    statusOut.split('\n')
      .map(l => l.trim().replace(/^[A-Z?]{1,2}\s+/, ''))
      .filter(Boolean)
      .forEach(f => fileSet.add(f));
  } catch (err) {
    // Git errors ignored
  }
  return Array.from(fileSet);
}

function getDiffContent(baseCommit, projectRoot) {
  const cwd = projectRoot || process.cwd();
  let content = '';
  try {
    if (baseCommit) {
      content += execSync(`git diff ${baseCommit}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      content += '\n' + execSync(`git diff ${baseCommit} HEAD`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } else {
      content = execSync('git diff HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
  } catch (err) {
    // ignore
  }
  return content;
}

function evaluateScore(specContent, options) {
  const minScore = (options && options.minScore !== undefined) ? options.minScore : 8;
  const projectRoot = (options && options.projectRoot) || process.cwd();
  const baseCommit = (options && options.baseCommit) || null;

  const acs = parseAcceptanceCriteria(specContent);
  if (acs.length === 0) {
    return {
      score: 10,
      passed: true,
      minScore,
      totalAcs: 0,
      verifiedCount: 0,
      failingCount: 0,
      verifiedAcs: [],
      failingAcs: [],
      touchedFiles: [],
      feedback: 'No explicit acceptance criteria found in spec. Default score assigned.'
    };
  }

  const touchedFiles = getTouchedFiles(baseCommit, projectRoot);
  const diffContent = getDiffContent(baseCommit, projectRoot);

  // Combine diff content with full file contents of touched and explicit target files
  let combinedContent = diffContent;
  const filesToCheck = new Set([...touchedFiles, ...((options && options.targetFiles) || [])]);
  
  // Include targetFiles from DAG decomposition
  try {
    const { generateDagPlan } = require('./dag_planner.cjs');
    const dag = generateDagPlan(specContent, options);
    if (dag && dag.tasks) {
      for (const t of dag.tasks) {
        if (t.targetFiles) {
          t.targetFiles.forEach(f => filesToCheck.add(f));
        }
      }
    }
  } catch (e) {}

  // Also check skills/ and .sdw/ default locations if targetFiles still empty
  if (filesToCheck.size === 0) {
    const defaultSearchDirs = ['skills/sdw-implement/scripts', 'skills/sdw-implement', '.sdw'];
    for (const d of defaultSearchDirs) {
      const fullDir = path.resolve(projectRoot, d);
      if (fs.existsSync(fullDir)) {
        try {
          const entries = fs.readdirSync(fullDir);
          for (const entry of entries) {
            const rel = path.join(d, entry).replace(/\\/g, '/');
            if (fs.statSync(path.resolve(projectRoot, rel)).isFile()) {
              filesToCheck.add(rel);
            }
          }
        } catch (e) {}
      }
    }
  }

  for (const relPath of filesToCheck) {
    const fullPath = path.resolve(projectRoot, relPath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      try {
        combinedContent += '\n' + fs.readFileSync(fullPath, 'utf8');
      } catch (e) {}
    }
  }

  const haystack = combinedContent.toLowerCase();
  const stopWords = new Set(['shall', 'when', 'while', 'where', 'then', 'the', 'system', 'that', 'with', 'from', 'each', 'this', 'after', 'into', 'over', 'under']);

  const verifiedAcs = [];
  const failingAcs = [];

  for (const ac of acs) {
    // Replace non-alphanumeric chars with spaces to handle hyphenated words cleanly
    const words = ac.text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    let matches = 0;
    for (const w of words) {
      if (haystack.includes(w)) {
        matches++;
      }
    }

    const coverageRatio = words.length > 0 ? matches / words.length : 1;
    // Require at least 40% keyword match across the implementation
    if (coverageRatio >= 0.4 || words.length === 0) {
      verifiedAcs.push({ id: ac.id, text: ac.text, coverageRatio });
    } else {
      failingAcs.push({
        id: ac.id,
        text: ac.text,
        coverageRatio,
        missingKeywords: words.filter(w => !haystack.includes(w))
      });
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
    touchedFiles: Array.from(filesToCheck),
    feedback
  };
}

module.exports = {
  getTouchedFiles,
  getDiffContent,
  evaluateScore
};
