#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, '.sdw'))) {
      return curr;
    }
    if (fs.existsSync(path.join(curr, '.git'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

function parseArgs(args) {
  const result = {
    subcommand: null,
    root: null,
    force: false,
    json: false,
    key: null,
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') {
      result.force = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--root') {
      result.root = args[++i];
    } else if (arg === '--key') {
      result.key = args[++i];
    } else if (arg.startsWith('--root=')) {
      result.root = arg.slice(7);
    } else if (arg.startsWith('--key=')) {
      result.key = arg.slice(6);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  result.subcommand = positional[0] || null;
  return result;
}

const DEFAULT_CONFIG = {
  $schema: './config.schema.json',
  specsDir: '{projectRoot}/.sdw/specs',
  scoreMin: 8,
  scmCodeReviewEnabled: false,
  pushDelivery: false,
  stateDir: '{projectRoot}/.sdw/state',
  autoResolveGaps: true,
  securityChecksEnabled: false,
  useWorktrees: false,
  useFeatureBranches: false,
  scmProvider: 'none',
  requiredBuild: false,
  buildCommand: 'npm run build',
  runAllTests: false,
  testCommand: 'npm test',
  prePrCommand: '',
  prePrInstructions: ''
};

const DEFAULT_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://spec-driven-workflow.org/schemas/config.schema.json",
  "title": "SDW Configuration Schema",
  "description": "Configuration schema for Spec-Driven Workflow (.sdw/config.json).",
  "type": "object",
  "required": ["specsDir"],
  "properties": {
    "$schema": {
      "type": "string",
      "description": "Relative path or URL to the JSON schema definition file."
    },
    "specsDir": {
      "type": "string",
      "description": "Path to the directory containing feature specifications. Supports token {projectRoot}.",
      "default": "{projectRoot}/.sdw/specs"
    },
    "scoreMin": {
      "type": "integer",
      "description": "Minimum conformance score (0-10) required before creating delivery commits.",
      "minimum": 0,
      "maximum": 10,
      "default": 8
    },
    "scmCodeReviewEnabled": {
      "type": "boolean",
      "description": "Enable remote pull request review polling loop and automated review comment resolution.",
      "default": false
    },
    "pushDelivery": {
      "type": "boolean",
      "description": "Automatically push the delivery commit and branch to remote origin upon workflow completion.",
      "default": false
    },
    "stateDir": {
      "type": "string",
      "description": "Path to the directory storing run session state files. Supports token {projectRoot}.",
      "default": "{projectRoot}/.sdw/state"
    },
    "autoResolveGaps": {
      "type": "boolean",
      "description": "Automatically apply recommended defaults for unhandled grilling gaps when running non-interactively.",
      "default": true
    },
    "securityChecksEnabled": {
      "type": "boolean",
      "description": "Enable pre-commit secrets and credentials leak scanning.",
      "default": false
    },
    "useWorktrees": {
      "type": "boolean",
      "description": "Enable per-task isolated git worktrees for dispatched subagents under .sdw/worktrees/{runId}/.",
      "default": false
    },
    "useFeatureBranches": {
      "type": "boolean",
      "description": "Automatically create and activate an isolated feature branch derived from specification slug.",
      "default": false
    },
    "scmProvider": {
      "type": "string",
      "enum": ["none", "ado", "github"],
      "default": "none",
      "description": "Configured SCM provider for issues, work items, and pull requests. Allowed: none, ado, github."
    },
    "requiredBuild": {
      "type": "boolean",
      "description": "Enforce successful build verification in Step 8 before creating delivery commit or PR.",
      "default": false
    },
    "buildCommand": {
      "type": "string",
      "description": "Command to execute for build verification.",
      "default": "npm run build"
    },
    "runAllTests": {
      "type": "boolean",
      "description": "Enforce passing all test suites in Step 8 before creating delivery commit or PR.",
      "default": false
    },
    "testCommand": {
      "type": "string",
      "description": "Command to execute for test verification pass.",
      "default": "npm test"
    },
    "prePrCommand": {
      "type": "string",
      "description": "Optional project-specific shell command to execute before PR preparation (e.g. version bump, lint).",
      "default": ""
    },
    "prePrInstructions": {
      "type": "string",
      "description": "Optional project-specific instructions or checklist for agents to verify prior to PR submission.",
      "default": ""
    }
  },
  "additionalProperties": true
};

const DEFAULT_DIRECTORY_STRUCTURE = `# SDW Directory Structure & Guidelines

Baseline directory layout for consumer projects adopting Spec-Driven Workflow:

\`\`\`text
{projectRoot}/
└── .sdw/
    ├── config.json              # Main project workflow configuration
    ├── config.schema.json       # JSON Schema definition for config.json validation
    ├── directory-structure.md   # Structural guidelines and layout rules
    ├── specs/                   # Target directory for canonical specifications
    ├── state/                   # Ephemeral execution run state files (*.state.json)
    │   └── {slug}/{runId}/      # Human-auditable intermediate step artifacts ({slug}-step-{N}.md)
    ├── traps.md                 # Central anti-regression trap log
    └── worktrees/               # Ephemeral per-task git worktrees for isolated subagents
\`\`\`
`;

function validateConfigSchema(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['Configuration must be a JSON object.'] };
  }

  // Required properties
  if (!('specsDir' in config)) {
    errors.push('Missing required property "specsDir".');
  } else if (typeof config.specsDir !== 'string' || config.specsDir.trim().length === 0) {
    errors.push('Property "specsDir" must be a non-empty string.');
  }

  // scoreMin
  if ('scoreMin' in config) {
    if (typeof config.scoreMin !== 'number' || !Number.isInteger(config.scoreMin) || config.scoreMin < 0 || config.scoreMin > 10) {
      errors.push('Property "scoreMin" must be an integer between 0 and 10.');
    }
  }

  // scmCodeReviewEnabled
  if ('scmCodeReviewEnabled' in config) {
    if (typeof config.scmCodeReviewEnabled !== 'boolean') {
      errors.push('Property "scmCodeReviewEnabled" must be a boolean.');
    }
  }

  // stateDir
  if ('stateDir' in config) {
    if (typeof config.stateDir !== 'string' || config.stateDir.trim().length === 0) {
      errors.push('Property "stateDir" must be a string.');
    }
  }

  // autoResolveGaps
  if ('autoResolveGaps' in config) {
    if (typeof config.autoResolveGaps !== 'boolean') {
      errors.push('Property "autoResolveGaps" must be a boolean.');
    }
  }

  // securityChecksEnabled
  if ('securityChecksEnabled' in config) {
    if (typeof config.securityChecksEnabled !== 'boolean') {
      errors.push('Property "securityChecksEnabled" must be a boolean.');
    }
  }

  // useWorktrees
  if ('useWorktrees' in config) {
    if (typeof config.useWorktrees !== 'boolean') {
      errors.push('Property "useWorktrees" must be a boolean.');
    }
  }

  // useFeatureBranches
  if ('useFeatureBranches' in config) {
    if (typeof config.useFeatureBranches !== 'boolean') {
      errors.push('Property "useFeatureBranches" must be a boolean.');
    }
  }

  // scmProvider (AC1, AC2)
  if ('scmProvider' in config) {
    const allowed = ['none', 'ado', 'github'];
    if (typeof config.scmProvider !== 'string' || !allowed.includes(config.scmProvider)) {
      errors.push(`Property "scmProvider" must be one of: ${allowed.join(', ')}.`);
    }
  }

  // pushDelivery
  if ('pushDelivery' in config) {
    if (typeof config.pushDelivery !== 'boolean') {
      errors.push('Property "pushDelivery" must be a boolean.');
    }
  }

  // requiredBuild
  if ('requiredBuild' in config) {
    if (typeof config.requiredBuild !== 'boolean') {
      errors.push('Property "requiredBuild" must be a boolean.');
    }
  }

  // buildCommand
  if ('buildCommand' in config) {
    if (typeof config.buildCommand !== 'string') {
      errors.push('Property "buildCommand" must be a string.');
    }
  }

  // runAllTests
  if ('runAllTests' in config) {
    if (typeof config.runAllTests !== 'boolean') {
      errors.push('Property "runAllTests" must be a boolean.');
    }
  }

  // testCommand
  if ('testCommand' in config) {
    if (typeof config.testCommand !== 'string') {
      errors.push('Property "testCommand" must be a string.');
    }
  }

  // prePrCommand
  if ('prePrCommand' in config) {
    if (typeof config.prePrCommand !== 'string') {
      errors.push('Property "prePrCommand" must be a string.');
    }
  }

  // prePrInstructions
  if ('prePrInstructions' in config) {
    if (typeof config.prePrInstructions !== 'string') {
      errors.push('Property "prePrInstructions" must be a string.');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function loadConfig(targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : findProjectRoot(process.cwd());
  const normalizedRoot = normalizePath(root);
  const configFile = path.join(root, '.sdw', 'config.json');

  let rawConfig = {};
  if (fs.existsSync(configFile)) {
    try {
      rawConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      // Fallback
    }
  }

  const merged = { ...DEFAULT_CONFIG, ...rawConfig };
  const resolved = {};

  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') {
      resolved[key] = value.replace(/\{projectRoot\}/g, normalizedRoot);
    } else {
      resolved[key] = value;
    }
  }

  return {
    ...resolved,
    projectRoot: normalizedRoot,
    raw: rawConfig,
    resolved
  };
}

function cmdInit(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const sdwDir = path.join(targetRoot, '.sdw');
  const specsDir = path.join(sdwDir, 'specs');
  const stateDir = path.join(sdwDir, 'state');
  const configFile = path.join(sdwDir, 'config.json');
  const schemaFile = path.join(sdwDir, 'config.schema.json');
  const structureFile = path.join(sdwDir, 'directory-structure.md');

  const created = [];
  const skipped = [];

  if (!fs.existsSync(sdwDir)) {
    fs.mkdirSync(sdwDir, { recursive: true });
    created.push('.sdw/');
  }

  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
    created.push('.sdw/specs/');
  }

  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
    created.push('.sdw/state/');
  }

  if (!fs.existsSync(schemaFile) || options.force) {
    fs.writeFileSync(schemaFile, JSON.stringify(DEFAULT_SCHEMA, null, 2) + '\n', 'utf8');
    created.push('.sdw/config.schema.json');
  } else {
    skipped.push('.sdw/config.schema.json (already exists)');
  }

  if (!fs.existsSync(configFile) || options.force) {
    fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    created.push('.sdw/config.json');
  } else {
    skipped.push('.sdw/config.json (already exists)');
  }

  if (!fs.existsSync(structureFile) || options.force) {
    fs.writeFileSync(structureFile, DEFAULT_DIRECTORY_STRUCTURE, 'utf8');
    created.push('.sdw/directory-structure.md');
  } else {
    skipped.push('.sdw/directory-structure.md (already exists)');
  }

  const result = {
    success: true,
    root: normalizePath(targetRoot),
    created,
    skipped
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[sdw-config init] Initialized .sdw at ${normalizePath(targetRoot)}`);
    if (created.length > 0) {
      console.log('Created:');
      created.forEach(f => console.log(`  + ${f}`));
    }
    if (skipped.length > 0) {
      console.log('Skipped (use --force to overwrite):');
      skipped.forEach(f => console.log(`  = ${f}`));
    }
  }

  return 0;
}

function cmdCheck(options) {
  const targetRoot = options.root ? path.resolve(options.root) : findProjectRoot(process.cwd());
  const sdwDir = path.join(targetRoot, '.sdw');
  const configFile = path.join(sdwDir, 'config.json');
  const structureFile = path.join(sdwDir, 'directory-structure.md');

  const checks = [];
  const errors = [];
  let valid = true;

  // 1. Check .sdw directory
  const sdwExists = fs.existsSync(sdwDir) && fs.statSync(sdwDir).isDirectory();
  checks.push({
    name: 'sdw_directory_exists',
    target: '.sdw/',
    passed: sdwExists
  });
  if (!sdwExists) {
    valid = false;
    errors.push('Missing .sdw directory. Run "sdw-config init" to create it.');
  }

  // 2. Check config.json exists
  const configExists = fs.existsSync(configFile);
  checks.push({
    name: 'config_file_exists',
    target: '.sdw/config.json',
    passed: configExists
  });
  if (!configExists) {
    valid = false;
    errors.push('Missing .sdw/config.json file.');
  }

  // 3. Parse config.json if it exists
  let parsedConfig = null;
  if (configExists) {
    try {
      const raw = fs.readFileSync(configFile, 'utf8');
      parsedConfig = JSON.parse(raw);
      checks.push({
        name: 'config_json_valid_syntax',
        target: '.sdw/config.json',
        passed: true
      });
    } catch (err) {
      valid = false;
      checks.push({
        name: 'config_json_valid_syntax',
        target: '.sdw/config.json',
        passed: false,
        detail: err.message
      });
      errors.push(`.sdw/config.json syntax error: ${err.message}`);
    }
  }

  // 3.5 Check config.schema.json exists
  const schemaFile = path.join(sdwDir, 'config.schema.json');
  const schemaExists = fs.existsSync(schemaFile);
  checks.push({
    name: 'config_schema_file_exists',
    target: '.sdw/config.schema.json',
    passed: schemaExists
  });
  if (!schemaExists) {
    valid = false;
    errors.push('Missing .sdw/config.schema.json schema file.');
  }

  // 3.6 Validate parsed config.json against schema
  if (parsedConfig) {
    const schemaValidation = validateConfigSchema(parsedConfig);
    checks.push({
      name: 'config_schema_validation',
      target: '.sdw/config.json',
      passed: schemaValidation.valid,
      detail: schemaValidation.errors.length > 0 ? schemaValidation.errors.join('; ') : undefined
    });
    if (!schemaValidation.valid) {
      valid = false;
      errors.push(...schemaValidation.errors);
    }
  }

  // 4. Validate specsDir key and path
  if (parsedConfig) {
    const hasSpecsDir = typeof parsedConfig.specsDir === 'string' && parsedConfig.specsDir.trim().length > 0;
    checks.push({
      name: 'specs_dir_property_present',
      target: 'specsDir in config.json',
      passed: hasSpecsDir
    });

    if (!hasSpecsDir) {
      valid = false;
      errors.push('config.json missing required string property "specsDir".');
    } else {
      const resolvedSpecs = parsedConfig.specsDir.replace(/\{projectRoot\}/g, normalizePath(targetRoot));
      const specsExists = fs.existsSync(resolvedSpecs) && fs.statSync(resolvedSpecs).isDirectory();
      checks.push({
        name: 'specs_dir_exists_on_disk',
        target: resolvedSpecs,
        passed: specsExists
      });
      if (!specsExists) {
        valid = false;
        errors.push(`Configured specsDir does not exist on disk: ${resolvedSpecs}`);
      }
    }

    // 4.5 Validate scmProvider CLI presence and authentication status (AC16)
    const provider = parsedConfig.scmProvider || 'none';
    if (provider === 'none') {
      checks.push({
        name: 'scm_provider_status',
        target: 'scmProvider: none',
        passed: true,
        detail: 'SCM integration disabled (none)'
      });
    } else {
      const binName = provider === 'github' ? 'gh' : 'az';
      let installed = false;
      try {
        const probeCmd = process.platform === 'win32' ? `where ${binName}` : `command -v ${binName}`;
        const out = execSync(probeCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        installed = Boolean(out && out.trim());
      } catch (e) {
        installed = false;
      }
      checks.push({
        name: `scm_cli_presence_${binName}`,
        target: `CLI: ${binName}`,
        passed: installed,
        detail: installed ? `${binName} is installed on PATH` : `${binName} is NOT installed on PATH`
      });
      if (!installed) {
        valid = false;
        errors.push(`Configured SCM provider "${provider}" requires CLI "${binName}", but it is not installed on PATH.`);
      } else {
        let authenticated = false;
        try {
          const authCmd = binName === 'gh' ? 'gh auth status' : 'az account show';
          execSync(authCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          authenticated = true;
        } catch (e) {
          authenticated = false;
        }
        checks.push({
          name: `scm_cli_authenticated_${binName}`,
          target: `CLI auth: ${binName}`,
          passed: authenticated,
          detail: authenticated ? `${binName} is authenticated` : `${binName} is NOT authenticated`
        });
        if (!authenticated) {
          valid = false;
          errors.push(`Configured SCM provider "${provider}" CLI "${binName}" is not authenticated.`);
        }
      }
    }
  }

  // 5. Check directory-structure.md exists
  const structureExists = fs.existsSync(structureFile);
  checks.push({
    name: 'directory_structure_doc_exists',
    target: '.sdw/directory-structure.md',
    passed: structureExists
  });
  if (!structureExists) {
    valid = false;
    errors.push('Missing .sdw/directory-structure.md documentation.');
  }

  const result = {
    valid,
    root: normalizePath(targetRoot),
    checks,
    errors
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[sdw-config check] Target root: ${normalizePath(targetRoot)}`);
    console.log(`Status: ${valid ? 'PASS' : 'FAIL'}`);
    console.log('\nChecks:');
    checks.forEach(c => {
      const mark = c.passed ? '[PASS]' : '[FAIL]';
      console.log(`  ${mark} ${c.name} (${c.target})`);
      if (c.detail) console.log(`         Detail: ${c.detail}`);
    });
    if (errors.length > 0) {
      console.log('\nErrors:');
      errors.forEach(e => console.log(`  ! ${e}`));
    }
  }

  return valid ? 0 : 1;
}

function cmdParse(options) {
  const targetRoot = options.root ? path.resolve(options.root) : findProjectRoot(process.cwd());
  const sdwDir = path.join(targetRoot, '.sdw');
  const configFile = path.join(sdwDir, 'config.json');

  if (!fs.existsSync(configFile)) {
    const err = { error: `Missing config file at ${normalizePath(configFile)}` };
    if (options.json) {
      console.log(JSON.stringify(err, null, 2));
    } else {
      console.error(`[sdw-config parse] Error: ${err.error}`);
    }
    return 1;
  }

  let rawConfig;
  try {
    rawConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    const errorRes = { error: `Invalid JSON in ${normalizePath(configFile)}: ${err.message}` };
    if (options.json) {
      console.log(JSON.stringify(errorRes, null, 2));
    } else {
      console.error(`[sdw-config parse] Error: ${errorRes.error}`);
    }
    return 1;
  }

  const normalizedRoot = normalizePath(targetRoot);
  const resolved = {};

  for (const [key, value] of Object.entries(rawConfig)) {
    if (typeof value === 'string') {
      resolved[key] = value.replace(/\{projectRoot\}/g, normalizedRoot);
    } else {
      resolved[key] = value;
    }
  }

  if (options.key) {
    if (options.key in resolved) {
      if (options.json) {
        console.log(JSON.stringify({ [options.key]: resolved[options.key] }, null, 2));
      } else {
        console.log(resolved[options.key]);
      }
      return 0;
    } else {
      const err = { error: `Key "${options.key}" not found in config` };
      if (options.json) {
        console.log(JSON.stringify(err, null, 2));
      } else {
        console.error(`[sdw-config parse] Error: ${err.error}`);
      }
      return 1;
    }
  }

  const output = {
    projectRoot: normalizedRoot,
    raw: rawConfig,
    resolved
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`[sdw-config parse] Project Root: ${normalizedRoot}`);
    console.log('\nResolved Configuration:');
    for (const [k, v] of Object.entries(resolved)) {
      console.log(`  ${k}: ${v}`);
    }
  }

  return 0;
}

function showHelp() {
  console.log(`Usage: node sdw_config.cjs <subcommand> [options]

Subcommands:
  init     Scaffold .sdw directory and default files in project root
  check    Verify .sdw directory structure, config syntax, and paths
  parse    Parse and resolve .sdw/config.json with {projectRoot} tokens

Options:
  --root <path>   Explicit project root directory (default: auto-detected)
  --force         Overwrite existing files on init
  --json          Output results in JSON format
  --key <name>    (parse only) Extract a single resolved config key
  -h, --help      Show this help message
`);
}

function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.subcommand || options.subcommand === 'help' || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(args.includes('-h') || args.includes('--help') || options.subcommand === 'help' ? 0 : 1);
  }

  let exitCode = 0;
  switch (options.subcommand) {
    case 'init':
      exitCode = cmdInit(options);
      break;
    case 'check':
      exitCode = cmdCheck(options);
      break;
    case 'parse':
      exitCode = cmdParse(options);
      break;
    default:
      console.error(`Unknown subcommand: "${options.subcommand}". Available: init, check, parse`);
      showHelp();
      exitCode = 1;
      break;
  }

  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = {
  cmdInit,
  cmdCheck,
  cmdParse,
  loadConfig,
  validateConfigSchema,
  DEFAULT_CONFIG,
  DEFAULT_SCHEMA,
  findProjectRoot,
  normalizePath,
  showHelp
};
