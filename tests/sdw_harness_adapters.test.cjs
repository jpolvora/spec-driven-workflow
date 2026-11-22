'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

function setupWorkspace(configOverride = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-harness-test-'));
  const sdwDir = path.join(tmpDir, '.sdw');
  fs.mkdirSync(sdwDir, { recursive: true });
  const config = {
    specsDir: '{projectRoot}/.sdw/specs',
    stateDir: '{projectRoot}/.sdw/state',
    ...configOverride
  };
  fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  return { tmpDir, sdwDir };
}

// Module under test (will be implemented in task-1-impl)
let harnessAdapters;
try {
  harnessAdapters = require('../skills/sdw-run/scripts/harness_adapters.cjs');
} catch (e) {
  harnessAdapters = null;
}

let sdwConfig;
try {
  sdwConfig = require('../skills/sdw-config/scripts/sdw_config.cjs');
} catch (e) {
  sdwConfig = null;
}

test('AC1: harness.adapter configuration defaults to auto and supports valid enum values', () => {
  assert.ok(sdwConfig, 'sdw_config module must be available');
  
  // 1. Default to auto when unspecified
  const ws1 = setupWorkspace();
  const cfg1 = sdwConfig.loadConfig(ws1.tmpDir);
  assert.ok(cfg1.harness, 'config.harness must be populated');
  assert.equal(cfg1.harness.adapter, 'auto', 'Default adapter must be auto');

  // 2. Explicit valid enum values
  const validAdapters = ['auto', 'antigravity', 'claude-code', 'opencode', 'cursor', 'generic'];
  for (const adapter of validAdapters) {
    const ws = setupWorkspace({ harness: { adapter } });
    const cfg = sdwConfig.loadConfig(ws.tmpDir);
    assert.equal(cfg.harness.adapter, adapter, `Must load configured adapter "${adapter}"`);
  }
});

test('AC2: detectHarness detects active agent harness from environment variables', () => {
  assert.ok(harnessAdapters, 'harness_adapters module must be available');
  assert.equal(typeof harnessAdapters.detectHarness, 'function');

  // Antigravity detection
  assert.equal(harnessAdapters.detectHarness({ ANTIGRAVITY_APP: '1' }), 'antigravity');
  assert.equal(harnessAdapters.detectHarness({ AGY_SESSION_ID: 'session-123' }), 'antigravity');

  // Claude Code detection
  assert.equal(harnessAdapters.detectHarness({ CLAUDE_CODE: '1' }), 'claude-code');
  assert.equal(harnessAdapters.detectHarness({ CLAUDE_PROJECT_DIR: '/project' }), 'claude-code');

  // OpenCode detection
  assert.equal(harnessAdapters.detectHarness({ OPENCODE_API_KEY: 'test-key' }), 'opencode');
  assert.equal(harnessAdapters.detectHarness({ OPENCODE_RUN: '1' }), 'opencode');

  // Cursor detection
  assert.equal(harnessAdapters.detectHarness({ CURSOR_PROJECT_DIR: '/project' }), 'cursor');

  // Generic fallback when no env markers match
  assert.equal(harnessAdapters.detectHarness({}), 'generic');
  assert.equal(harnessAdapters.detectHarness({ SOME_OTHER_VAR: 'value' }), 'generic');
});

test('AC3: Antigravity dispatch emits invoke_subagent envelope with Model and Role', () => {
  assert.ok(harnessAdapters, 'harness_adapters module must be available');
  assert.equal(typeof harnessAdapters.formatDispatch, 'function');

  const taskContext = {
    taskId: 'task-1-impl',
    title: 'Implement Core Feature',
    role: 'implementation',
    promptFile: '.sdw/state/00078/task-task-1-impl.prompt.md',
    promptContent: 'Implement the feature as described.',
    model: 'flash',
    effort: 'low'
  };

  const dispatch = harnessAdapters.formatDispatch('antigravity', taskContext, {});
  assert.equal(dispatch.harness, 'antigravity');
  assert.equal(dispatch.mode, 'invoke_subagent');
  assert.ok(dispatch.envelope, 'Must provide dispatch envelope');
  assert.equal(dispatch.envelope.Role, 'Implementation Worker');
  assert.equal(dispatch.envelope.Model, 'flash');
  assert.ok(dispatch.envelope.Prompt.includes(taskContext.promptFile));
});

test('AC4: OpenCode dispatch emits opencode CLI command with designated model flags', () => {
  assert.ok(harnessAdapters, 'harness_adapters module must be available');

  const taskContext = {
    taskId: 'task-1-impl',
    title: 'Implement Core Feature',
    role: 'implementation',
    promptFile: '.sdw/state/00078/task-task-1-impl.prompt.md',
    promptContent: 'Implement the feature as described.',
    model: 'opencode/deepseek-v4.1-flash-free',
    effort: 'medium'
  };

  const dispatch = harnessAdapters.formatDispatch('opencode', taskContext, {});
  assert.equal(dispatch.harness, 'opencode');
  assert.equal(dispatch.mode, 'cli');
  assert.ok(dispatch.command, 'Must provide CLI command');
  assert.ok(dispatch.command.includes('opencode run'), `Command should invoke opencode run: ${dispatch.command}`);
  assert.ok(dispatch.command.includes('-m opencode/deepseek-v4.1-flash-free') || dispatch.command.includes('--model opencode/deepseek-v4.1-flash-free'),
    `Command should specify model: ${dispatch.command}`);
});

test('AC5: Claude Code dispatch emits task instructions formatted for Claude Code execution', () => {
  assert.ok(harnessAdapters, 'harness_adapters module must be available');

  const taskContext = {
    taskId: 'task-1-impl',
    title: 'Implement Core Feature',
    role: 'implementation',
    promptFile: '.sdw/state/00078/task-task-1-impl.prompt.md',
    promptContent: 'Implement the feature as described.',
    model: 'claude-3-5-sonnet',
    effort: 'high'
  };

  const dispatch = harnessAdapters.formatDispatch('claude-code', taskContext, {});
  assert.equal(dispatch.harness, 'claude-code');
  assert.ok(dispatch.instruction || dispatch.command, 'Must provide instruction or command');
  const text = dispatch.instruction || dispatch.command;
  assert.ok(text.includes(taskContext.promptFile) || text.includes('task-1-impl'),
    `Instruction should reference prompt file or taskId: ${text}`);
});

test('AC6: Configurable subagent model and effort defaults under harness.subagent in .sdw/config.json', () => {
  assert.ok(sdwConfig, 'sdw_config module must be available');

  // Default subagent settings
  const ws1 = setupWorkspace();
  const cfg1 = sdwConfig.loadConfig(ws1.tmpDir);
  assert.ok(cfg1.harness && cfg1.harness.subagent, 'harness.subagent must be defined');
  assert.equal(cfg1.harness.subagent.defaultModel, 'flash');
  assert.equal(cfg1.harness.subagent.defaultEffort, 'low');

  // Custom subagent settings
  const ws2 = setupWorkspace({
    harness: {
      adapter: 'antigravity',
      subagent: {
        defaultModel: 'pro',
        defaultEffort: 'medium'
      }
    }
  });
  const cfg2 = sdwConfig.loadConfig(ws2.tmpDir);
  assert.equal(cfg2.harness.subagent.defaultModel, 'pro');
  assert.equal(cfg2.harness.subagent.defaultEffort, 'medium');
});
