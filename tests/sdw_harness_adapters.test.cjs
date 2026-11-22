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

  // Antigravity detection via env vars
  assert.equal(harnessAdapters.detectHarness({ ANTIGRAVITY_APP: '1' }), 'antigravity');
  assert.equal(harnessAdapters.detectHarness({ AGY_SESSION_ID: 'session-123' }), 'antigravity');

  // Antigravity detection via filesystem marker ~/.gemini/antigravity
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fake-home-'));
  fs.mkdirSync(path.join(fakeHome, '.gemini', 'antigravity'), { recursive: true });
  assert.equal(harnessAdapters.detectHarness({ HOME: fakeHome }), 'antigravity');
  assert.equal(harnessAdapters.detectHarness({}, { homedir: fakeHome }), 'antigravity');

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

test('AC7: Specification frontmatter model and effort override harness config defaults', () => {
  assert.ok(harnessAdapters, 'harness_adapters module must be available');

  const configDefaults = {
    adapter: 'antigravity',
    subagent: {
      defaultModel: 'flash',
      defaultEffort: 'low'
    }
  };

  // 1. Task without frontmatter override uses config defaults
  const taskNoOverride = {
    taskId: 'task-1-impl',
    role: 'implementation',
    promptFile: '.sdw/state/00078/task-task-1-impl.prompt.md',
    model: configDefaults.subagent.defaultModel,
    effort: configDefaults.subagent.defaultEffort
  };
  const dispatchDefault = harnessAdapters.formatDispatch('antigravity', taskNoOverride, {});
  assert.equal(dispatchDefault.envelope.Model, 'flash');
  assert.equal(dispatchDefault.envelope.Effort, 'low');

  // 2. Task with frontmatter overrides
  const frontmatterOverrides = {
    model: 'pro',
    effort: 'high'
  };
  const taskWithOverride = {
    taskId: 'task-1-impl',
    role: 'implementation',
    promptFile: '.sdw/state/00078/task-task-1-impl.prompt.md',
    model: frontmatterOverrides.model,
    effort: frontmatterOverrides.effort
  };
  const dispatchOverride = harnessAdapters.formatDispatch('antigravity', taskWithOverride, {});
  assert.equal(dispatchOverride.envelope.Model, 'pro', 'Frontmatter model must override default');
  assert.equal(dispatchOverride.envelope.Effort, 'high', 'Frontmatter effort must override default');
});

test('AC8: Unrecognized harness adapter logs actionable warning and falls back to generic', () => {
  assert.ok(harnessAdapters, 'harness_adapters module must be available');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const taskContext = {
      taskId: 'task-1-impl',
      role: 'implementation',
      promptFile: '.sdw/state/00078/task-task-1-impl.prompt.md'
    };
    const dispatch = harnessAdapters.formatDispatch('unsupported_harness_xyz', taskContext, {});
    assert.equal(dispatch.harness, 'generic', 'Must fall back to generic harness');
    assert.equal(dispatch.mode, 'instruction');
    assert.ok(dispatch.instruction.includes(taskContext.promptFile));
    assert.ok(warnings.some(w => w.includes('Unrecognized harness adapter') && w.includes('generic')),
      `Warning must be logged: ${JSON.stringify(warnings)}`);
  } finally {
    console.warn = originalWarn;
  }
});

test('AC8b: formatDispatch falls back to config.harness.subagent defaults when taskContext lacks overrides', () => {
  const config = {
    harness: {
      adapter: 'generic',
      subagent: {
        defaultModel: 'custom-model',
        defaultEffort: 'high'
      }
    }
  };

  const dispatch = harnessAdapters.formatDispatch('generic', { taskId: 'task-test' }, { config });
  assert.equal(dispatch.model, 'custom-model');
  assert.equal(dispatch.effort, 'high');
  assert.equal(dispatch.mode, 'instruction');
});

test('AC9: User confirmation modality selects based on active harness adapter', () => {
  assert.ok(harnessAdapters, 'harness_adapters module must be available');
  assert.equal(typeof harnessAdapters.formatConfirmation, 'function');

  // Antigravity selects ask_question modality
  const confAgy = harnessAdapters.formatConfirmation('antigravity', {
    question: 'Proceed with implementation?',
    options: ['Yes', 'No']
  });
  assert.equal(confAgy.harness, 'antigravity');
  assert.equal(confAgy.modality, 'ask_question');
  assert.equal(confAgy.question, 'Proceed with implementation?');

  // Generic / terminal selects readline modality
  const confGen = harnessAdapters.formatConfirmation('generic', {
    question: 'Proceed with implementation?'
  });
  assert.equal(confGen.harness, 'generic');
  assert.equal(confGen.modality, 'readline');
});

test('AC10: Harness configuration properties registered in .sdw/config.schema.json with validation rules', () => {
  const schemaPath = path.join(__dirname, '..', '.sdw', 'config.schema.json');
  assert.ok(fs.existsSync(schemaPath), 'config.schema.json must exist');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  assert.ok(schema.properties.harness, 'Schema must define harness property');
  assert.ok(schema.properties.harness.properties.adapter, 'Schema must define harness.adapter');
  assert.deepEqual(schema.properties.harness.properties.adapter.enum,
    ['auto', 'antigravity', 'claude-code', 'opencode', 'cursor', 'generic']);
  assert.ok(schema.properties.harness.properties.subagent, 'Schema must define harness.subagent');

  // Also verify sdw_config.DEFAULT_SCHEMA has harness property
  assert.ok(sdwConfig.DEFAULT_SCHEMA.properties.harness, 'DEFAULT_SCHEMA must define harness property');
  assert.deepEqual(sdwConfig.DEFAULT_SCHEMA.properties.harness.properties.adapter.enum,
    ['auto', 'antigravity', 'claude-code', 'opencode', 'cursor', 'generic']);
});

test('AC11: Reference documentation defines harness adapter interface and dispatch protocol', () => {
  const root = path.resolve(__dirname, '..');
  
  // 1. orchestrator_protocol.md mentions harness adapters
  const orchProto = fs.readFileSync(path.join(root, 'skills', 'sdw-run', 'references', 'orchestrator_protocol.md'), 'utf8');
  assert.ok(/Harness Adapter Layer/i.test(orchProto) || /harness_adapters\.cjs/i.test(orchProto),
    'orchestrator_protocol.md must document Harness Adapter Layer');

  // 2. sdw-rules SKILL.md or references acknowledge agnosticism
  const sdwRules = fs.readFileSync(path.join(root, 'skills', 'sdw-rules', 'SKILL.md'), 'utf8');
  assert.ok(/agnostic/i.test(sdwRules) || /anti-overengineering/i.test(sdwRules),
    'sdw-rules must acknowledge agnosticism and simplicity');
});

test('AC12: Comprehensive automated unit test coverage for harness adapters', () => {
  assert.ok(harnessAdapters);
  assert.equal(typeof harnessAdapters.detectHarness, 'function');
  assert.equal(typeof harnessAdapters.formatDispatch, 'function');
  assert.equal(typeof harnessAdapters.formatConfirmation, 'function');
  assert.ok(Array.isArray(harnessAdapters.VALID_ADAPTERS));
});

test('AC13: sdw_run dispatchNextTask attaches harness dispatch envelope', () => {
  const sdwRun = require('../skills/sdw-run/scripts/sdw_run.cjs');
  assert.equal(typeof sdwRun.dispatchNextTask, 'function');

  const ws = setupWorkspace({
    harness: {
      adapter: 'generic'
    }
  });

  const state = {
    runId: 'run-test-123',
    specSlug: 'test-spec',
    specPath: path.join(ws.tmpDir, '.sdw', 'specs', '00001-test.md'),
    steps: {
      4: {
        status: 'pending',
        tasks: {}
      }
    }
  };

  const dagPlan = {
    tasks: [
      {
        id: 'task-1-impl',
        role: 'implementation',
        title: 'Test Implementation Task',
        coveredAcs: ['AC1'],
        dependencies: []
      }
    ]
  };

  const result = sdwRun.dispatchNextTask({
    targetRoot: ws.tmpDir,
    state,
    dagPlan,
    specAcs: [{ id: 'AC1', text: 'Test AC' }],
    specSlug: 'test-spec',
    specPath: state.specPath,
    options: {}
  });

  assert.ok(result.ok, 'Dispatch must succeed');
  assert.ok(result.envelope.harness, 'Envelope must contain harness dispatch payload');
  assert.equal(result.envelope.harness.harness, 'generic');
  assert.equal(result.envelope.harness.mode, 'instruction');
});
