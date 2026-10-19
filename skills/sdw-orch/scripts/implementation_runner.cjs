'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const stateManager = require('./state_manager.cjs');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Renders task prompt markdown file for a DAG task.
 */
function renderTaskPrompt(options) {
  const { targetRoot, specSlug, runId, stateDir, task, specAcs, useWorktrees, taskWorktreeRel } = options;
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const absStateDir = stateDir ? (path.isAbsolute(stateDir) ? stateDir : path.resolve(root, stateDir)) : path.join(root, '.sdw', 'state');
  const taskPromptDir = path.join(absStateDir, specSlug, runId);

  if (!fs.existsSync(taskPromptDir)) {
    fs.mkdirSync(taskPromptDir, { recursive: true });
  }

  const promptFileAbs = path.join(taskPromptDir, `task-${task.id}.prompt.md`);
  const evidenceFileAbs = path.join(taskPromptDir, `task-${task.id}.evidence.json`);

  const promptFileRel = normalizePath(path.relative(root, promptFileAbs));
  const evidenceFileRel = normalizePath(path.relative(root, evidenceFileAbs));

  const workingDirRel = (useWorktrees && taskWorktreeRel) ? normalizePath(taskWorktreeRel) : '.';
  const workingDirAbs = path.resolve(root, workingDirRel);

  const coveredAcs = task.coveredAcs || [];
  const acList = [];
  if (Array.isArray(specAcs)) {
    for (const a of specAcs) {
      const id = typeof a === 'string' ? a : a.id;
      const text = typeof a === 'string' ? '' : a.text;
      if (coveredAcs.includes(id)) {
        acList.push(`- **${id}**: ${text || '(see specification)'}`);
      }
    }
  }

  let prompt = `# Implementation Task Prompt: ${task.id} (${specSlug})\n\n`;
  prompt += `## Task Context\n`;
  prompt += `- **Task ID:** ${task.id}\n`;
  prompt += `- **Task Title:** ${task.title || task.id}\n`;
  prompt += `- **Specification Slug:** ${specSlug}\n`;
  prompt += `- **Run ID:** ${runId}\n`;
  prompt += `- **Assigned Working Directory:** \`${workingDirRel}\`\n`;
  prompt += `- **Evidence File Destination:** \`${evidenceFileRel}\`\n\n`;

  prompt += `## Description\n`;
  prompt += `${task.description || 'Implement the assigned requirements in accordance with the specification.'}\n\n`;

  if (acList.length > 0) {
    prompt += `## Assigned Acceptance Criteria\n`;
    prompt += `${acList.join('\n')}\n\n`;
  }

  if (task.targetFiles && task.targetFiles.length > 0) {
    prompt += `## Target Files\n`;
    task.targetFiles.forEach(f => {
      prompt += `- \`${normalizePath(f)}\`\n`;
    });
    prompt += `\n`;
  }

  if (task.contextPrompt) {
    prompt += `## Architectural Guidance\n`;
    prompt += `${task.contextPrompt}\n\n`;
  }

  prompt += `## Implementation Constraints & Rules (sdw-rules)\n`;
  prompt += `1. **Simplicity First:** Write the minimum necessary code to fulfill the assigned acceptance criteria. Avoid speculative abstractions.\n`;
  prompt += `2. **Surgical Changes:** Modify only target files and direct dependencies. Do not perform unrelated refactoring.\n`;
  prompt += `3. **Do NOT Git Commit:** Do not run \`git commit\` directly in the product repository. The orchestrator will verify evidence, commit, and integrate changes automatically.\n`;
  prompt += `4. **Provide Evidence:** Once implementation is complete, create the evidence JSON file at \`${evidenceFileRel}\` conforming to the schema below, then execute the finish command.\n\n`;

  prompt += `## Task Evidence Schema (\`${evidenceFileRel}\`)\n`;
  prompt += `\`\`\`json\n`;
  prompt += JSON.stringify({
    taskId: task.id,
    acIds: coveredAcs,
    filesChanged: task.targetFiles || [],
    tests: [
      { name: `Verifies ${task.id} requirements`, status: 'passed', command: 'npm test' }
    ],
    summary: `Completed implementation of ${task.id}.`
  }, null, 2) + `\n`;
  prompt += `\`\`\`\n\n`;

  prompt += `## Task Finish Command\n`;
  prompt += `\`\`\`bash\n`;
  prompt += `node skills/sdw-orch/scripts/sdw_orch.cjs task finish --run-id ${runId} --task ${task.id} --evidence ${evidenceFileRel}\n`;
  prompt += `\`\`\`\n`;

  fs.writeFileSync(promptFileAbs, prompt, 'utf8');

  return {
    promptFileAbs,
    promptFileRel,
    evidenceFileAbs,
    evidenceFileRel,
    workingDirRel,
    workingDirAbs
  };
}

/**
 * Checks if all DAG dependencies for a task are completed.
 */
function checkTaskDependencies(dagPlan, taskId, completedTaskIds = new Set()) {
  if (!dagPlan || !Array.isArray(dagPlan.tasks)) {
    return { satisfied: true, missingDependencies: [] };
  }

  const targetTask = dagPlan.tasks.find(t => t.id === taskId);
  if (!targetTask) {
    return { satisfied: true, missingDependencies: [] };
  }

  const dependencies = targetTask.dependencies || [];
  const missing = [];
  for (const depId of dependencies) {
    if (!completedTaskIds.has(depId)) {
      missing.push(depId);
    }
  }

  return {
    satisfied: missing.length === 0,
    missingDependencies: missing
  };
}

/**
 * Creates an isolated git worktree for a task branching from the primary tree HEAD.
 */
function createTaskWorktree(targetRoot, runId, taskId) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const worktreeRel = `.sdw/worktrees/${runId}/${taskId}`;
  const worktreeAbs = path.join(root, worktreeRel);
  const taskBranch = `task/${runId}/${taskId}`;

  const baseCommit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();

  const addProc = spawnSync('git', ['worktree', 'add', worktreeRel, '-b', taskBranch, 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  });

  if (addProc.status !== 0) {
    throw new Error(`Failed to create git worktree at ${worktreeRel}: ${addProc.stderr || 'git worktree add error'}`);
  }

  return {
    worktreeRel: normalizePath(worktreeRel),
    worktreeAbs: normalizePath(worktreeAbs),
    branch: taskBranch,
    baseCommit
  };
}

/**
 * Checks whether changes exist in the task working tree or primary repository.
 */
function checkTaskChanges(targetRoot, taskWorktreeAbs, useWorktrees, filesChanged = []) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();

  if (useWorktrees && taskWorktreeAbs && fs.existsSync(taskWorktreeAbs)) {
    try {
      const statusOut = execSync('git status --porcelain', {
        cwd: taskWorktreeAbs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return Boolean(statusOut);
    } catch (e) {
      return false;
    }
  }

  // Primary-tree mode
  const isGit = fs.existsSync(path.join(root, '.git'));
  if (!isGit) {
    if (filesChanged && filesChanged.length > 0) {
      return filesChanged.every(f => fs.existsSync(path.resolve(root, f)));
    }
    return false;
  }

  try {
    const statusOut = execSync('git status --porcelain', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (statusOut) {
      const changedInStatus = statusOut.split('\n')
        .map(l => l.trim().replace(/^[A-Z?]{1,2}\s+/, '').trim())
        .map(normalizePath);

      for (const f of filesChanged) {
        const normF = normalizePath(f);
        if (changedInStatus.some(cs => cs === normF || cs.endsWith(normF) || normF.endsWith(cs))) {
          return true;
        }
      }
    }

    // Check git diff against HEAD
    const diffOut = execSync('git diff --name-only HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (diffOut) {
      const changedInDiff = diffOut.split('\n').map(l => normalizePath(l.trim()));
      for (const f of filesChanged) {
        const normF = normalizePath(f);
        if (changedInDiff.includes(normF)) {
          return true;
        }
      }
    }

    // Fallback: verify files in filesChanged exist on disk
    if (filesChanged.length > 0) {
      const allExist = filesChanged.every(f => fs.existsSync(path.resolve(root, f)));
      if (allExist && statusOut) return true;
    }
  } catch (e) {}

  return false;
}

/**
 * Commits changes inside task worktree, cherry-picks into primary tree, and cleans up worktree.
 */
function integrateTaskWorktree(options) {
  const { targetRoot, specSlug, taskId, taskWorktreeAbs, taskWorktreeRel, taskBranch } = options;
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();

  // 1. Commit inside task worktree (argv form: no shell interpolation of specSlug/taskId)
  const addProc = spawnSync('git', ['add', '-A'], { cwd: taskWorktreeAbs, stdio: 'ignore' });
  if (addProc.status !== 0) {
    throw new Error(`Failed to stage changes for task ${taskId} in worktree ${taskWorktreeRel}.`);
  }
  const commitProc = spawnSync('git', ['commit', '-m', `task(${specSlug}): ${taskId}`], {
    cwd: taskWorktreeAbs,
    stdio: 'ignore'
  });
  if (commitProc.status !== 0) {
    throw new Error(`Failed to commit changes for task ${taskId} in worktree ${taskWorktreeRel}.`);
  }
  const revProc = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskWorktreeAbs,
    encoding: 'utf8'
  });
  if (revProc.status !== 0 || !revProc.stdout) {
    throw new Error(`Failed to resolve task commit SHA for task ${taskId}.`);
  }
  const taskCommitSha = String(revProc.stdout).trim();

  // 2. Cherry-pick into primary tree (argv form: commit SHA passed without shell)
  const cherryProc = spawnSync('git', ['cherry-pick', taskCommitSha], { cwd: root, stdio: 'ignore' });
  if (cherryProc.status !== 0) {
    // Preserves worktree for inspection on conflict
    const conflictErr = new Error(`Cherry-pick conflict during integration of task ${taskId} (commit ${taskCommitSha}). Worktree preserved at ${taskWorktreeRel}.`);
    conflictErr.isConflict = true;
    conflictErr.commitSha = taskCommitSha;
    throw conflictErr;
  }

  // 3. Safe cleanup of worktree and branch (argv form: no shell interpolation)
  try {
    const rmProc = spawnSync('git', ['worktree', 'remove', taskWorktreeRel], { cwd: root, stdio: 'ignore' });
    if (rmProc.status !== 0) throw new Error('git worktree remove failed');
    const delProc = spawnSync('git', ['branch', '-d', taskBranch], { cwd: root, stdio: 'ignore' });
    if (delProc.status !== 0) throw new Error('git branch delete failed');
  } catch (rmErr) {
    console.warn(`[sdw-orch] Warning: Failed to cleanly remove worktree ${taskWorktreeRel}: ${rmErr.message}`);
  }

  return {
    commitSha: taskCommitSha,
    integrated: true
  };
}

/**
 * Executes implementation command in command mode with token substitution and environment allowlist.
 */
function executeTaskCommand(options) {
  const { config, task, promptFile, evidenceFile, targetRoot, worktreeDir, specSlug } = options;
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const cwd = worktreeDir ? (path.isAbsolute(worktreeDir) ? worktreeDir : path.resolve(root, worktreeDir)) : root;

  const implConfig = (config && config.implementation) || {};
  const rawCommand = implConfig.command;
  if (!rawCommand || typeof rawCommand !== 'string') {
    return {
      success: false,
      exitCode: 1,
      error: 'Missing implementation.command configuration in command mode.'
    };
  }

  const absPromptFile = normalizePath(path.resolve(root, promptFile));
  const absEvidenceFile = normalizePath(path.resolve(root, evidenceFile));
  const absWorkingDir = normalizePath(cwd);
  const absTargetRoot = normalizePath(root);

  // Token substitutions (AC22)
  const substituted = rawCommand
    .replace(/\{taskId\}/g, task.id)
    .replace(/\{promptFile\}/g, absPromptFile)
    .replace(/\{evidenceFile\}/g, absEvidenceFile)
    .replace(/\{workingDir\}/g, absWorkingDir)
    .replace(/\{targetRoot\}/g, absTargetRoot)
    .replace(/\{cwd\}/g, absWorkingDir)
    .replace(/\{slug\}/g, specSlug);

  // Environment allowlist (AC23)
  const defaultAllowlist = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'NODE_PATH', 'LANG', 'LC_ALL'];
  const allowlist = implConfig.envAllowlist || defaultAllowlist;
  const filteredEnv = {};
  for (const key of allowlist) {
    const foundKey = Object.keys(process.env).find(k => k.toUpperCase() === key.toUpperCase());
    if (foundKey) {
      filteredEnv[key] = process.env[foundKey];
    }
  }

  // SDW variables (AC23)
  filteredEnv.SDW_TASK_ID = task.id;
  filteredEnv.SDW_PROMPT_FILE = absPromptFile;
  filteredEnv.SDW_EVIDENCE_FILE = absEvidenceFile;
  filteredEnv.SDW_WORKING_DIR = absWorkingDir;
  filteredEnv.SDW_TARGET_ROOT = absTargetRoot;
  filteredEnv.SDW_SPEC_SLUG = specSlug;

  const timeoutMs = implConfig.timeoutMs || 1800000;

  console.log(`[Step 4: Command Mode] Executing task command for ${task.id}...`);
  const proc = spawnSync(substituted, {
    cwd,
    shell: true,
    env: filteredEnv,
    timeout: timeoutMs,
    encoding: 'utf8'
  });

  if (proc.error && proc.error.code === 'ETIMEDOUT') {
    console.error(`[Step 4: Command Mode] Command exceeded timeout of ${timeoutMs}ms for task ${task.id}.`);
    return {
      success: false,
      timedOut: true,
      exitCode: 1,
      error: `Implementation command timed out after ${timeoutMs}ms.`
    };
  }

  if (proc.status !== 0) {
    const errMsg = proc.stderr ? proc.stderr.trim() : `Command exited with status ${proc.status}`;
    console.error(`[Step 4: Command Mode] Implementation command failed for task ${task.id}: ${errMsg}`);
    return {
      success: false,
      exitCode: proc.status || 1,
      error: errMsg
    };
  }

  return {
    success: true,
    exitCode: 0,
    output: proc.stdout
  };
}

module.exports = {
  renderTaskPrompt,
  checkTaskDependencies,
  createTaskWorktree,
  checkTaskChanges,
  integrateTaskWorktree,
  executeTaskCommand
};
