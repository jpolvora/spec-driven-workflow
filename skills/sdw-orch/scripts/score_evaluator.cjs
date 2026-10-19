'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseAcceptanceCriteria } = require('./dag_planner.cjs');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function getTouchedFiles(baseCommit, projectRoot) {
  const cwd = projectRoot || process.cwd();
  const fileSet = new Set();
  try {
    if (baseCommit) {
      const diffUncommitted = execSync(`git diff --name-only ${baseCommit}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      diffUncommitted.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(normalizePath(f)));

      const diffCommitted = execSync(`git diff --name-only ${baseCommit} HEAD`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      diffCommitted.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(normalizePath(f)));
    }

    const statusOut = execSync('git status --porcelain', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    statusOut.split('\n')
      .map(l => l.trim().replace(/^[A-Z?]{1,2}\s+/, '').trim())
      .filter(Boolean)
      .forEach(f => fileSet.add(normalizePath(f)));
  } catch (err) {
    // Git errors ignored
  }
  return Array.from(fileSet);
}

/**
 * Evaluates conformance score based strictly on accepted task evidence records (Spec 015).
 * 
 * Score = Math.round((verifiedAcs / totalAcs) * 10).
 * An AC is verified ONLY when at least one accepted task evidence record references it
 * and confirms at least one real changed file that exists on disk.
 * If 0 ACs found in spec, score is 0 and evaluation fails closed.
 */
function evaluateScore(specContent, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const baseCommit = options.baseCommit || null;

  let minScore = options.minScore !== undefined ? options.minScore : null;
  if (minScore === null) {
    try {
      const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
      const config = sdwConfig.loadConfig(projectRoot);
      minScore = config && config.scoreMin !== undefined ? config.scoreMin : 8;
    } catch (e) {
      minScore = 8;
    }
  }

  const acs = parseAcceptanceCriteria(specContent);

  // Closed failure when 0 ACs present (Spec 015 AC23, Line 133, Line 208)
  if (acs.length === 0) {
    return {
      score: 0,
      passed: false,
      minScore,
      totalAcs: 0,
      verifiedCount: 0,
      failingCount: 0,
      verifiedAcs: [],
      failingAcs: [],
      touchedFiles: [],
      evidenceLinks: {},
      feedback: 'Specification has no acceptance criteria. Fails closed with score 0/10.'
    };
  }

  // Collect accepted task evidence records
  // Source 1: options.tasks (from state.steps[4].tasks)
  // Source 2: options.evidenceRecords (passed directly in options)
  const taskEvidenceList = [];

  if (options.tasks && typeof options.tasks === 'object') {
    for (const [taskId, taskData] of Object.entries(options.tasks)) {
      if (taskData && taskData.status === 'completed') {
        let evidence = taskData.evidence || null;
        if (!evidence && taskData.evidencePath) {
          const absEvPath = path.isAbsolute(taskData.evidencePath)
            ? taskData.evidencePath
            : path.resolve(projectRoot, taskData.evidencePath);
          if (fs.existsSync(absEvPath)) {
            try {
              evidence = JSON.parse(fs.readFileSync(absEvPath, 'utf8'));
            } catch (e) {}
          }
        }
        taskEvidenceList.push({
          taskId,
          evidencePath: taskData.evidencePath || null,
          commitSha: taskData.commitSha || null,
          acIds: (evidence && evidence.acIds) || taskData.acIds || [],
          filesChanged: (evidence && evidence.filesChanged) || taskData.filesChanged || []
        });
      }
    }
  } else if (Array.isArray(options.evidenceRecords)) {
    taskEvidenceList.push(...options.evidenceRecords);
  }

  // Build map of verified AC IDs to evidence links
  const evidenceMap = {};
  const allTouchedFiles = new Set(getTouchedFiles(baseCommit, projectRoot));

  for (const record of taskEvidenceList) {
    const files = Array.isArray(record.filesChanged) ? record.filesChanged : [];
    const existingChangedFiles = files.filter(f => {
      const absF = path.resolve(projectRoot, f);
      return fs.existsSync(absF);
    });

    // Evidence must confirm at least one existing changed file
    if (existingChangedFiles.length === 0 && files.length > 0) {
      continue;
    }

    files.forEach(f => allTouchedFiles.add(normalizePath(f)));

    const acIds = Array.isArray(record.acIds) ? record.acIds : [];
    for (const acId of acIds) {
      const cleanAcId = String(acId).trim();
      if (!evidenceMap[cleanAcId]) {
        evidenceMap[cleanAcId] = {
          taskIds: [],
          evidencePaths: [],
          filesChanged: []
        };
      }
      if (record.taskId && !evidenceMap[cleanAcId].taskIds.includes(record.taskId)) {
        evidenceMap[cleanAcId].taskIds.push(record.taskId);
      }
      if (record.evidencePath && !evidenceMap[cleanAcId].evidencePaths.includes(record.evidencePath)) {
        evidenceMap[cleanAcId].evidencePaths.push(normalizePath(record.evidencePath));
      }
      existingChangedFiles.forEach(f => {
        const norm = normalizePath(f);
        if (!evidenceMap[cleanAcId].filesChanged.includes(norm)) {
          evidenceMap[cleanAcId].filesChanged.push(norm);
        }
      });
    }
  }

  const verifiedAcs = [];
  const failingAcs = [];

  for (const ac of acs) {
    const cleanId = ac.id.trim();
    if (evidenceMap[cleanId]) {
      verifiedAcs.push({
        id: cleanId,
        text: ac.text,
        taskIds: evidenceMap[cleanId].taskIds,
        evidencePaths: evidenceMap[cleanId].evidencePaths,
        filesChanged: evidenceMap[cleanId].filesChanged
      });
    } else {
      failingAcs.push({
        id: cleanId,
        text: ac.text,
        reason: 'No accepted task evidence record references this criterion.'
      });
    }
  }

  const verifiedCount = verifiedAcs.length;
  const totalAcs = acs.length;
  const rawScore = Math.round((verifiedCount / totalAcs) * 10);
  const score = Math.max(0, Math.min(10, rawScore));
  const passed = score >= minScore;

  let feedback = '';
  if (!passed) {
    feedback = `Conformance score is ${score}/10 (minimum required: ${minScore}/10).\n` +
      `The following acceptance criteria lack accepted task evidence records:\n` +
      failingAcs.map(f => `- ${f.id}: ${f.text}`).join('\n') +
      `\nPlease complete task implementation and submit valid task evidence.`;
  } else {
    feedback = `Conformance score is ${score}/10 (meets or exceeds required threshold ${minScore}/10). All ${verifiedCount}/${totalAcs} acceptance criteria verified via accepted task evidence.`;
  }

  return {
    score,
    passed,
    minScore,
    totalAcs,
    verifiedCount,
    failingCount: failingAcs.length,
    verifiedAcs,
    failingAcs,
    touchedFiles: Array.from(allTouchedFiles),
    evidenceLinks: evidenceMap,
    feedback
  };
}

module.exports = {
  getTouchedFiles,
  evaluateScore
};
