'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getFilesToReview(baseCommit, projectRoot) {
  const fileSet = new Set();
  try {
    if (baseCommit) {
      const diffCommitted = execSync(`git diff --name-only ${baseCommit} HEAD`, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      diffCommitted.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(f));

      const diffUncommitted = execSync(`git diff --name-only ${baseCommit}`, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      diffUncommitted.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(f));
    }
    const statusOut = execSync('git status --porcelain', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    statusOut.split('\n').map(l => l.trim().replace(/^..\s+/, '')).filter(Boolean).forEach(f => fileSet.add(f));
  } catch (err) {
    // ignore
  }
  return Array.from(fileSet);
}

function runAutomatedReview(options) {
  const projectRoot = (options && options.projectRoot) || process.cwd();
  const baseCommit = (options && options.baseCommit) || null;

  const findings = [];
  const touchedFiles = getFilesToReview(baseCommit, projectRoot);

  // Rule 1: No .py files inside skills/
  for (const f of touchedFiles) {
    if (f.startsWith('skills/') && f.endsWith('.py')) {
      findings.push({
        file: f,
        severity: 'error',
        rule: 'no_python_in_skills',
        message: 'Skills must only use Node.js CommonJS (.cjs) helpers. Python scripts are prohibited.',
        fixable: false
      });
    }

    // Rule 2: Check for potential committed secrets
    if (/token|secret|password|credential|private_key/i.test(f) && !f.includes('test') && !f.includes('example')) {
      findings.push({
        file: f,
        severity: 'warning',
        rule: 'potential_secret_leak',
        message: `File name "${f}" suggests sensitive credential or token data.`,
        fixable: false
      });
    }

    // Rule 3: Inspect content of newly added/modified implementation scripts (excluding tests)
    const isTestFile = f.includes('test') || f.includes('.spec.');
    const isReviewTool = f.includes('review_runner');
    const fullPath = path.join(projectRoot, f);

    if (!isTestFile && !isReviewTool && fs.existsSync(fullPath) && (f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.ts'))) {
      try {
        const text = fs.readFileSync(fullPath, 'utf8');
        // Match actual standalone debugger statements, not string literals
        if (/^\s*debugger\s*(?:;|$)/m.test(text)) {
          findings.push({
            file: f,
            severity: 'error',
            rule: 'no_debugger_statements',
            message: 'Found active "debugger;" statement.',
            fixable: true
          });
        }
        if (/\/\/\s*TODO\b|\/\*\s*TODO\b/.test(text)) {
          findings.push({
            file: f,
            severity: 'warning',
            rule: 'unresolved_todos',
            message: 'Unresolved TODO comment detected in implementation code.',
            fixable: false
          });
        }
        if (/@unrequested\b|@speculative\b|\/\/\s*UNREQUESTED\b|\/\*\s*UNREQUESTED\b/i.test(text)) {
          findings.push({
            file: f,
            severity: 'error',
            rule: 'unrequested_scope_expansion',
            message: 'Unrequested feature or speculative code expansion detected without user confirmation.',
            fixable: false
          });
        }
      } catch (e) {
        // file reading error
      }
    }
  }

  // Rule 4: sdw-rules compliance check if skills files were touched
  const skillsTouched = touchedFiles.some(f => f.startsWith('skills/'));
  if (skillsTouched) {
    try {
      const sdwRules = require('../../sdw-rules/scripts/sdw_rules.cjs');
      if (sdwRules && typeof sdwRules.cmdDoctor === 'function') {
        const doctorRes = sdwRules.cmdDoctor({ root: projectRoot });
        if (!doctorRes.passed) {
          for (const v of doctorRes.violations) {
            findings.push({
              file: `skills/${v.skill}/SKILL.md`,
              severity: 'error',
              rule: `sdw_rules_${v.rule}`,
              message: `[sdw-rules] ${v.message}`,
              fixable: false
            });
          }
        }
      }
    } catch (e) {
      // ignore if sdw-rules is not resolvable
    }
  }

  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warningCount = findings.filter(f => f.severity === 'warning').length;
  const passed = errorCount === 0;

  return {
    passed,
    errorCount,
    warningCount,
    totalFindings: findings.length,
    findings,
    summary: passed
      ? (warningCount === 0 ? 'Code review passed with zero findings.' : `Code review passed with ${warningCount} advisory warnings.`)
      : `Code review failed with ${errorCount} blocking errors.`
  };
}

function applyAutoFixes(findings, projectRoot) {
  const fixedFiles = [];
  for (const finding of findings) {
    if (finding.rule === 'no_debugger_statements' && finding.fixable) {
      const fullPath = path.join(projectRoot, finding.file);
      if (fs.existsSync(fullPath)) {
        try {
          let text = fs.readFileSync(fullPath, 'utf8');
          text = text.replace(/^\s*debugger;\s*$/gm, '');
          fs.writeFileSync(fullPath, text, 'utf8');
          fixedFiles.push(finding.file);
        } catch (e) {}
      }
    }
  }
  return fixedFiles;
}

module.exports = {
  getFilesToReview,
  runAutomatedReview,
  applyAutoFixes
};
