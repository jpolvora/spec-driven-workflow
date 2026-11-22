'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const VALID_ADAPTERS = ['auto', 'antigravity', 'claude-code', 'opencode', 'cursor', 'generic'];
const VALID_EFFORTS = ['low', 'medium', 'high'];

/**
 * Detects the active runtime agent harness by inspecting environment variables and process markers (AC2).
 * 
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {string} One of: 'antigravity', 'claude-code', 'opencode', 'cursor', 'generic'
 */
function detectHarness(env = process.env, options = {}) {
  if (!env || typeof env !== 'object') {
    return 'generic';
  }

  // Antigravity environment detection (env vars or filesystem marker)
  if (env.ANTIGRAVITY_APP || env.AGY_SESSION_ID) {
    return 'antigravity';
  }

  const homedir = options.homedir || (env === process.env ? os.homedir() : (env.HOME || env.USERPROFILE));
  if (homedir) {
    try {
      if (fs.existsSync(path.join(homedir, '.gemini', 'antigravity'))) {
        return 'antigravity';
      }
    } catch (_) {
      // ignore fs errors
    }
  }

  // Claude Code environment detection
  if (env.CLAUDE_CODE || env.CLAUDE_PROJECT_DIR) {
    return 'claude-code';
  }

  // OpenCode environment detection
  if (env.OPENCODE_API_KEY || env.OPENCODE_RUN) {
    return 'opencode';
  }

  // Cursor environment detection
  if (env.CURSOR_PROJECT_DIR) {
    return 'cursor';
  }

  return 'generic';
}

function resolveRoleName(role) {
  if (role === 'implementation') return 'Implementation Worker';
  if (role === 'test_author') return 'Test Author Worker';
  if (role === 'conformance_judge') return 'Conformance Judge';
  if (role === 'code_reviewer') return 'Code Reviewer';
  return role || 'Task Worker';
}

/**
 * Formats a task dispatch envelope or command tailored to the targeted harness adapter (AC3, AC4, AC5).
 *
 * @param {string} adapterName - Configured or detected adapter name
 * @param {object} taskContext - Task metadata (taskId, title, role, promptFile, promptContent, model, effort)
 * @param {object} [options={}] - Additional execution options
 * @returns {object} Dispatch envelope
 */
function formatDispatch(adapterName, taskContext = {}, options = {}) {
  let target = adapterName;
  if (!target || target === 'auto') {
    target = detectHarness(options.env || process.env, options);
  }

  if (!VALID_ADAPTERS.includes(target)) {
    console.warn(`[sdw-harness] Warning: Unrecognized harness adapter "${target}". Falling back to generic.`);
    target = 'generic';
  }

  const roleName = resolveRoleName(taskContext.role);
  const promptFile = taskContext.promptFile || '';
  const promptText = promptFile
    ? `Read ${promptFile} and execute it exactly as written, then report back per its report contract.`
    : (taskContext.promptContent || '');
  const subagentDefaults = (options.config && options.config.harness && options.config.harness.subagent) || {};
  const model = taskContext.model || subagentDefaults.defaultModel || 'flash';
  const effort = taskContext.effort || subagentDefaults.defaultEffort || 'low';

  switch (target) {
    case 'antigravity':
      return {
        harness: 'antigravity',
        mode: 'invoke_subagent',
        envelope: {
          TypeName: taskContext.typeName || 'self',
          Role: roleName,
          Prompt: promptText,
          Model: model,
          Effort: effort
        }
      };

    case 'opencode': {
      const modelFlag = model ? `-m ${model}` : '';
      const command = `opencode run ${modelFlag} "${promptFile || promptText}"`.trim();
      return {
        harness: 'opencode',
        mode: 'cli',
        command,
        model,
        effort
      };
    }

    case 'claude-code': {
      const instruction = `claude agent --prompt "Read ${promptFile || taskContext.taskId} and execute it."`;
      return {
        harness: 'claude-code',
        mode: 'instruction',
        instruction,
        promptFile,
        model,
        effort
      };
    }

    case 'cursor': {
      const instruction = `Cursor subagent task for ${taskContext.taskId}: read ${promptFile} and execute.`;
      return {
        harness: 'cursor',
        mode: 'instruction',
        instruction,
        promptFile
      };
    }

    case 'generic':
    default: {
      const instruction = promptFile
        ? `Read ${promptFile} and execute it exactly as written, then report back per its report contract.`
        : (promptText || `Execute task: ${taskContext.taskId || 'unspecified'}`);
      return {
        harness: 'generic',
        mode: 'instruction',
        instruction,
        promptFile,
        model,
        effort
      };
    }
  }
}

/**
 * Returns user confirmation modality based on harness adapter (AC9).
 *
 * @param {string} adapterName
 * @param {object} [promptContext={}]
 * @param {object} [options={}]
 * @returns {object}
 */
function formatConfirmation(adapterName, promptContext = {}, options = {}) {
  let target = adapterName;
  if (!target || target === 'auto') {
    target = detectHarness(options.env || process.env, options);
  }

  if (target === 'antigravity') {
    return {
      harness: 'antigravity',
      modality: 'ask_question',
      question: promptContext.question,
      options: promptContext.options
    };
  }

  if (target === 'generic' || target === 'claude-code' || target === 'opencode' || target === 'cursor') {
    return {
      harness: target,
      modality: 'readline',
      prompt: promptContext.question
    };
  }

  return {
    harness: 'generic',
    modality: 'default'
  };
}

module.exports = {
  VALID_ADAPTERS,
  VALID_EFFORTS,
  detectHarness,
  formatDispatch,
  formatConfirmation
};
