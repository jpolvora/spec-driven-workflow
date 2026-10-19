#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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
  specsDir: '{projectRoot}/.sdw/specs'
};

const DEFAULT_DIRECTORY_STRUCTURE = `rules for directory structure

specs/
config.json
`;

function cmdInit(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const sdwDir = path.join(targetRoot, '.sdw');
  const specsDir = path.join(sdwDir, 'specs');
  const configFile = path.join(sdwDir, 'config.json');
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
  showHelp
};
