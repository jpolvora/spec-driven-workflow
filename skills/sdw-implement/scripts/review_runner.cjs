'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runAutomatedReview(options) {
  const projectRoot = (options && options.projectRoot) || process.cwd();
  const baseCommit = (options && options.baseCommit) || null;

  const findings = [];

  let touchedFiles = [];
  try {
    let cmd = 'git status --porcelain';
    if (baseCommit) {
      cmd = `git diff --name-only ${baseCommit}`;
    }
    const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    touchedFiles = output
      .split('\n')
      .map(l => l.trim().replace(/^..\s+/, ''))
      .filter(Boolean);
  } catch (err) {
    // git error or not committed
  }

  // Rule 1: No .py files inside skills/
  for (const f of touchedFiles) {
    if (f.startsWith('skills/') && f.endsWith('.py')) {
      findings.push({
        file: f,
        severity: 'error',
        rule: 'no_python_in_skills',
        message: 'Skills must only use Node.js CommonJS (.cjs) helpers. Python scripts are prohibited.'
      });
    }

    // Rule 2: Check for potential committed secrets
    if (/token|secret|password|credential|private_key/i.test(f) && !f.includes('test') && !f.includes('example')) {
      findings.push({
        file: f,
        severity: 'warning',
        rule: 'potential_secret_leak',
        message: `File name "${f}" suggests sensitive credential or token data.`
      });
    }

    // Rule 3: Inspect content of newly added/modified scripts
    const fullPath = path.join(projectRoot, f);
    if (fs.existsSync(fullPath) && (f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.ts'))) {
      try {
        const text = fs.readFileSync(fullPath, 'utf8');
        if (text.includes('debugger;')) {
          findings.push({
            file: f,
            severity: 'error',
            rule: 'no_debugger_statements',
            message: 'Found active "debugger;" statement.'
          });
        }
        if (text.includes('// TODO') || text.includes('/* TODO')) {
          findings.push({
            file: f,
            severity: 'warning',
            rule: 'unresolved_todos',
            message: 'Unresolved TODO comment detected in implementation code.'
          });
        }
      } catch (e) {
        // file reading error
      }
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

module.exports = {
  runAutomatedReview
};
