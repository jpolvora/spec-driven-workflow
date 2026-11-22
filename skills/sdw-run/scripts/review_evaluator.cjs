'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_MODE = 'subagent';
const DEFAULT_MAX_ITERATIONS = 5;
const ALLOWED_MODES = ['subagent', 'cli', 'command'];
const SEVERITIES = ['critical', 'warning', 'info'];

function normalizePath(p) {
  return p ? p.replace(/\\/g, '/') : '';
}

function normOpt(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

/**
 * Resolves codeReview configuration settings (Spec 00076 AC1, AC2, AC16).
 */
function resolveReviewConfig(config = {}, cliOverrides = {}) {
  const codeReview = (cliOverrides && typeof cliOverrides.codeReview === 'object' && cliOverrides.codeReview)
    ? cliOverrides.codeReview
    : ((config && typeof config.codeReview === 'object' && config.codeReview) ? config.codeReview : {});
  const rawMode = typeof codeReview.mode === 'string' ? codeReview.mode.trim().toLowerCase() : null;
  const mode = ALLOWED_MODES.includes(rawMode) ? rawMode : DEFAULT_MODE;

  let maxIterations = DEFAULT_MAX_ITERATIONS;
  if (cliOverrides && cliOverrides.reviewMaxIterations !== undefined) {
    const parsed = Number(cliOverrides.reviewMaxIterations);
    if (!isNaN(parsed) && parsed >= 1) maxIterations = Math.floor(parsed);
  } else if (codeReview.maxIterations !== undefined) {
    const parsed = Number(codeReview.maxIterations);
    if (!isNaN(parsed) && parsed >= 1) maxIterations = Math.floor(parsed);
  }

  return {
    mode,
    maxIterations,
    command: normOpt(codeReview.command),
    model: normOpt(codeReview.model),
    effort: normOpt(codeReview.effort)
  };
}

/**
 * Resolves directory and file paths for Step 7 code review and local fix loops.
 */
function resolveReviewPaths(options = {}) {
  const { slug, runId, targetRoot, stateDir, iteration = 1 } = options;
  const baseDir = stateDir ? path.resolve(targetRoot, stateDir) : path.resolve(targetRoot, '.sdw', 'state');
  const reviewDir = slug && runId
    ? path.join(baseDir, slug, runId)
    : baseDir;

  const promptFile = path.join(reviewDir, `step-7-review-round-${iteration}.prompt.md`);
  const reportFile = path.join(reviewDir, `step-7-review-round-${iteration}.report.json`);
  const fixPromptFile = path.join(reviewDir, `step-7-fix-round-${iteration}.prompt.md`);
  const fixEvidenceFile = path.join(reviewDir, `step-7-fix-round-${iteration}.evidence.json`);

  return {
    dir: reviewDir,
    promptFileAbs: promptFile,
    reportFileAbs: reportFile,
    promptFileRel: normalizePath(path.relative(targetRoot, promptFile)),
    reportFileRel: normalizePath(path.relative(targetRoot, reportFile)),
    fixPromptFileAbs: fixPromptFile,
    fixEvidenceFileAbs: fixEvidenceFile,
    fixPromptFileRel: normalizePath(path.relative(targetRoot, fixPromptFile)),
    fixEvidenceFileRel: normalizePath(path.relative(targetRoot, fixEvidenceFile))
  };
}

/**
 * Builds the dispatch envelope for the fresh-context reviewer subagent (Spec 00076 AC3-AC5).
 */
function buildReviewerEnvelope(options = {}) {
  const { slug, runId, targetRoot, stateDir, skillsRoot, reviewConfig = {}, iteration = 1 } = options;
  const paths = resolveReviewPaths({ slug, runId, targetRoot, stateDir, iteration });
  const resolvedSkillsRoot = skillsRoot || 'skills';

  return {
    type: 'review',
    role: 'code_reviewer',
    permissions: 'read_only',
    slug,
    runId,
    iteration,
    model: reviewConfig.model || null,
    effort: reviewConfig.effort || null,
    skillsRoot: resolvedSkillsRoot,
    promptFile: paths.promptFileRel,
    reportFile: paths.reportFileRel,
    submitCommand: `node "${resolvedSkillsRoot}/sdw-run/scripts/sdw_run.cjs" review submit --run-id ${runId} --report ${paths.reportFileRel}`
  };
}

/**
 * Synthesizes the reviewer prompt with read-only fencing, repository instructions,
 * memory traps, sdw-rules, and defect-class aggregation guidance (Spec 00076 AC4-AC7).
 */
function buildReviewerPrompt(options = {}) {
  const {
    slug,
    runId,
    skillsRoot = 'skills',
    diff = {},
    touchedFiles = [],
    acs = [],
    instructions = '',
    traps = [],
    iteration = 1
  } = options;

  const lines = [];
  lines.push(`# Code Review Brief: ${slug} (Round ${iteration})`);
  lines.push('');
  lines.push(`- **Run ID:** ${runId || 'unknown'}`);
  lines.push('- **Review Mode:** fresh_context_subagent');
  lines.push('- **Access Level:** strictly read-only (zero file mutations permitted)');
  lines.push('');
  lines.push('## Fenced Context & Security Guardrails');
  lines.push('You are an impartial, fresh-context code reviewer. You have no prior conversation turns or implementation transcript.');
  lines.push('- **PROHIBITION:** You are strictly forbidden from modifying, creating, or deleting files in the workspace.');
  lines.push('- **PROHIBITION:** Running `git commit`, `git push`, `git checkout`, or any mutating git commands is strictly prohibited.');
  lines.push('- You must inspect the code diff and touched files against project standards and acceptance criteria.');
  lines.push('');

  if (instructions && instructions.trim()) {
    lines.push('## Repository Instructions (Project Authority)');
    lines.push(instructions.trim());
    lines.push('');
  }

  lines.push('## Quality Standards & Harness Guardrails (sdw-rules)');
  lines.push(`Load and apply \`${skillsRoot}/sdw-rules/SKILL.md\` (or \`.agents/skills/sdw-rules/SKILL.md\`) and its anti-patterns reference.`);
  lines.push('Enforce:');
  lines.push('1. Architectural simplicity (strict YAGNI, no speculative abstractions, no premature generalizations).');
  lines.push('2. Surgical scope adherence (only files required for the feature should be touched).');
  lines.push('3. Implementation soundness, correctness, and edge-case handling.');
  lines.push('4. Performance efficiency and computational overhead elimination.');
  lines.push('');

  if (Array.isArray(traps) && traps.length > 0) {
    lines.push('## Active Project Traps & Invariants (sdw-memory)');
    traps.forEach(trap => {
      lines.push(`- **[${trap.slug || 'trap'}]:** ${trap.scenario || ''} -> ${trap.recommendation || trap.rule || ''}`);
    });
    lines.push('');
  }

  if (Array.isArray(acs) && acs.length > 0) {
    lines.push('## Specification Acceptance Criteria');
    acs.forEach(ac => lines.push(`- ${ac.id}: ${ac.text}`));
    lines.push('');
  }

  lines.push(`## Code Diff (${(diff.files || []).length} file(s), ${diff.bytes || 0} bytes)`);
  if (touchedFiles.length > 0) {
    lines.push('### Touched Files');
    touchedFiles.forEach(f => lines.push(`- ${f}`));
    lines.push('');
  }
  lines.push('```diff');
  lines.push(diff.text || '(empty diff)');
  lines.push('```');
  lines.push('');

  lines.push('## Defect Aggregation & Reporting Policy');
  lines.push('Align with `.github/agentic-code-reviewers-prompt.md`:');
  lines.push('- Aggregate all occurrences of the same underlying defect class into a single finding thread (do not duplicate issues across files).');
  lines.push('- Maximum 6 findings per review round.');
  lines.push('- Each finding must provide: primary file:line coordinate, concrete evidence, minimal suggested fix diff, severity, and otherLocations list.');
  lines.push('');
  lines.push('## Output Contract');
  lines.push('Write your review verdict JSON to the designated report file. Output JSON only, no surrounding markdown:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "passed": true,');
  lines.push('  "blockingCount": 0,');
  lines.push('  "findings": [');
  lines.push('    {');
  lines.push('      "id": "CR-001",');
  lines.push('      "defectClass": "defect-category-identifier",');
  lines.push('      "file": "path/to/file.js",');
  lines.push('      "line": 10,');
  lines.push('      "evidence": "Concrete description of the failing behavior",');
  lines.push('      "suggestedFix": "- old\\n+ new",');
  lines.push('      "otherLocations": ["path/to/sibling.js:25"],');
  lines.push('      "severity": "critical"');
  lines.push('    }');
  lines.push('  ],');
  lines.push('  "summary": "Summary of findings or clean review approval."');
  lines.push('}');
  lines.push('```');

  return lines.join('\n');
}

/**
 * Validates the reviewer report JSON (Spec 00076 AC6, AC7).
 */
function validateReviewReport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Review report must be a non-null object.'], data: null };
  }

  const errors = [];
  if (typeof raw.passed !== 'boolean') {
    errors.push('Report "passed" must be a boolean.');
  }

  const blockingCount = Number(raw.blockingCount);
  if (!Number.isInteger(blockingCount) || blockingCount < 0) {
    errors.push('Report "blockingCount" must be a non-negative integer.');
  }

  if (typeof raw.passed === 'boolean' && Number.isInteger(blockingCount) && blockingCount >= 0) {
    if (raw.passed && blockingCount > 0) {
      errors.push(`Contradictory report: "passed" is true but "blockingCount" is ${blockingCount} (> 0).`);
    } else if (!raw.passed && blockingCount === 0) {
      errors.push('Contradictory report: "passed" is false but "blockingCount" is 0.');
    }
  }

  if (!Array.isArray(raw.findings)) {
    errors.push('Report "findings" must be an array.');
  } else {
    if (raw.findings.length > 6) {
      errors.push(`Report exceeds the maximum allowed 6 findings per round (got ${raw.findings.length}).`);
    }

    raw.findings.forEach((finding, idx) => {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        errors.push(`Finding at index ${idx} must be an object.`);
        return;
      }
      if (!finding.id || typeof finding.id !== 'string') {
        errors.push(`Finding at index ${idx} must contain a string "id".`);
      }
      if (!finding.defectClass || typeof finding.defectClass !== 'string' || !finding.defectClass.trim()) {
        errors.push(`Finding at index ${idx} must contain a non-empty string "defectClass".`);
      }
      if (!finding.file || typeof finding.file !== 'string' || !finding.file.trim()) {
        errors.push(`Finding at index ${idx} must contain a non-empty string "file".`);
      }
      if (typeof finding.line !== 'number' || isNaN(finding.line)) {
        errors.push(`Finding at index ${idx} must contain a numeric "line".`);
      }
      if (!finding.evidence || typeof finding.evidence !== 'string' || !finding.evidence.trim()) {
        errors.push(`Finding at index ${idx} must contain a non-empty string "evidence".`);
      }
      if (!Array.isArray(finding.otherLocations)) {
        errors.push(`Finding at index ${idx} must contain an "otherLocations" array.`);
      }
      if (!finding.severity || !SEVERITIES.includes(String(finding.severity).trim().toLowerCase())) {
        errors.push(`Finding at index ${idx} severity must be one of: ${SEVERITIES.join(', ')}.`);
      }
    });
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    data: valid ? {
      passed: raw.passed,
      blockingCount,
      findings: raw.findings.map(f => ({
        id: String(f.id).trim(),
        defectClass: String(f.defectClass).trim(),
        file: normalizePath(String(f.file).trim()),
        line: Number(f.line),
        evidence: String(f.evidence).trim(),
        suggestedFix: f.suggestedFix ? String(f.suggestedFix) : null,
        otherLocations: (f.otherLocations || []).map(loc => normalizePath(String(loc).trim())),
        severity: String(f.severity).trim().toLowerCase()
      })),
      summary: raw.summary ? String(raw.summary).trim() : null
    } : null
  };
}

/**
 * Builds the dispatch envelope for the fresh-context fixer subagent (Spec 00076 AC10, AC11).
 */
function buildFixerEnvelope(options = {}) {
  const { slug, runId, targetRoot, stateDir, iteration = 1, findings = [], skillsRoot } = options;
  const paths = resolveReviewPaths({ slug, runId, targetRoot, stateDir, iteration });
  const resolvedSkillsRoot = skillsRoot || 'skills';

  // Derive target files from findings primary files and otherLocations
  const targetFilesSet = new Set();
  findings.forEach(f => {
    if (f.file) targetFilesSet.add(normalizePath(f.file));
    if (Array.isArray(f.otherLocations)) {
      f.otherLocations.forEach(loc => {
        const filePart = loc.split(':')[0].trim();
        if (filePart) targetFilesSet.add(normalizePath(filePart));
      });
    }
  });
  const targetFiles = Array.from(targetFilesSet);

  return {
    type: 'fix',
    role: 'review_fixer',
    slug,
    runId,
    iteration,
    targetFiles,
    skillsRoot: resolvedSkillsRoot,
    promptFile: paths.fixPromptFileRel,
    evidenceFile: paths.fixEvidenceFileRel,
    finishCommand: `node "${resolvedSkillsRoot}/sdw-run/scripts/sdw_run.cjs" review fix-finish --run-id ${runId} --evidence ${paths.fixEvidenceFileRel}`
  };
}

/**
 * Synthesizes the fixer subagent prompt with surgical target file scope fencing (Spec 00076 AC11, AC12).
 */
function buildFixerPrompt(options = {}) {
  const {
    slug,
    runId,
    iteration = 1,
    findings = [],
    targetFiles = [],
    skillsRoot = 'skills',
    instructions = '',
    traps = []
  } = options;

  const lines = [];
  lines.push(`# Code Review Remediation Brief: ${slug} (Round ${iteration})`);
  lines.push('');
  lines.push(`- **Run ID:** ${runId || 'unknown'}`);
  lines.push('- **Role:** review_fixer (surgical remediation subagent)');
  lines.push('');
  lines.push('## Scope Fence & Target Files');
  lines.push('Your modifications are strictly enclosed by the scope fence below:');
  lines.push('- **Permitted target files:**');
  targetFiles.forEach(f => lines.push(`  - \`${f}\``));
  lines.push('');
  lines.push('- **FORBIDDEN:** Modifying any files outside the target files list is strictly prohibited.');
  lines.push('- **FORBIDDEN:** Do not run `git commit`, `git push`, or direct version control mutations.');
  lines.push('');

  if (instructions && instructions.trim()) {
    lines.push('## Repository Instructions (Project Authority)');
    lines.push(instructions.trim());
    lines.push('');
  }

  lines.push('## Quality Standards (sdw-rules)');
  lines.push(`Load and apply \`${skillsRoot}/sdw-rules/SKILL.md\`. Apply the minimal, surgical fix that resolves the findings without overengineering.`);
  lines.push('');

  if (Array.isArray(traps) && traps.length > 0) {
    lines.push('## Project Memory Traps (sdw-memory)');
    traps.forEach(trap => {
      lines.push(`- **[${trap.slug || 'trap'}]:** ${trap.scenario || ''} -> ${trap.recommendation || trap.rule || ''}`);
    });
    lines.push('');
  }

  lines.push('## Findings to Remediate');
  findings.forEach(f => {
    lines.push(`### [${f.id}] ${f.defectClass} (Severity: ${f.severity})`);
    lines.push(`- **Location:** \`${f.file}:${f.line}\``);
    if (f.otherLocations && f.otherLocations.length > 0) {
      lines.push(`- **Other locations:** ${f.otherLocations.map(l => `\`${l}\``).join(', ')}`);
    }
    lines.push(`- **Evidence:** ${f.evidence}`);
    if (f.suggestedFix) {
      lines.push('- **Suggested Fix:**');
      lines.push('```diff');
      lines.push(f.suggestedFix);
      lines.push('```');
    }
    lines.push('');
  });

  lines.push('## Instructions');
  lines.push('1. Surgically edit only the permitted target files to resolve the reported findings.');
  lines.push('2. Run verification checks to confirm fixes are correct and no regressions exist.');
  lines.push('3. Write the evidence JSON with changed files, verification results, and remediation summary.');

  return lines.join('\n');
}

/**
 * Validates that all modified files stay within the target finding scope fence (Spec 00076 AC11, AC12).
 */
function validateFixScope(modifiedFiles = [], targetFiles = []) {
  const allowedSet = new Set(targetFiles.map(normalizePath));
  const violations = [];
  modifiedFiles.forEach(file => {
    const normalized = normalizePath(file);
    if (!allowedSet.has(normalized)) {
      violations.push(normalized);
    }
  });
  return {
    allowed: violations.length === 0,
    violations
  };
}

/**
 * Formats the conventional commit message for a review remediation round (Spec 00076 AC13).
 */
function formatFixCommitMessage(slug, iteration = 1) {
  return `fix(${slug}): address code review findings (round ${iteration})`;
}

/**
 * Checks if the review-and-fix loop has reached its iteration ceiling (Spec 00076 AC15).
 */
function isMaxIterationsReached(iteration, maxIterations = DEFAULT_MAX_ITERATIONS) {
  return Number(iteration) >= Number(maxIterations);
}

module.exports = {
  DEFAULT_MODE,
  DEFAULT_MAX_ITERATIONS,
  ALLOWED_MODES,
  resolveReviewConfig,
  resolveReviewPaths,
  buildReviewerEnvelope,
  buildReviewerPrompt,
  validateReviewReport,
  buildFixerEnvelope,
  buildFixerPrompt,
  validateFixScope,
  formatFixCommitMessage,
  isMaxIterationsReached
};
