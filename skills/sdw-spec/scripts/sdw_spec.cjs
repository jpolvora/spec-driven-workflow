#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initIndex, listIndex, archiveSpec, resolvePaths } = require('./spec_index.cjs');
const { createNewSpec, importRemoteSpec } = require('./spec_creator.cjs');
const { syncIndex } = require('./spec_sync.cjs');
const { validateFile, SPEC_STATUSES } = require('./validate_spec.cjs');

const SPEC_STATUS_TRANSITIONS = {
  draft: ['awaiting-approval', 'abandoned'],
  'awaiting-approval': ['ready-to-implement', 'draft', 'abandoned'],
  'ready-to-implement': ['implemented', 'awaiting-approval', 'abandoned'],
  implemented: [],
  abandoned: ['draft']
};

function parseArgs(args) {
  const result = {
    subcommand: null,
    target: null,
    root: null,
    status: null,
    provider: null,
    id: null,
    title: null,
    slug: null,
    from: null,
    apply: false,
    force: false,
    json: false,
    dryRun: false,
    mode: 'authoring'
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--force') result.force = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--root') result.root = args[++i];
    else if (arg.startsWith('--root=')) result.root = arg.slice(7);
    else if (arg === '--status') result.status = args[++i];
    else if (arg.startsWith('--status=')) result.status = arg.slice(9);
    else if (arg === '--provider') result.provider = args[++i];
    else if (arg.startsWith('--provider=')) result.provider = arg.slice(11);
    else if (arg === '--id') result.id = args[++i];
    else if (arg.startsWith('--id=')) result.id = arg.slice(5);
    else if (arg === '--title') result.title = args[++i];
    else if (arg.startsWith('--title=')) result.title = arg.slice(8);
    else if (arg === '--slug') result.slug = args[++i];
    else if (arg.startsWith('--slug=')) result.slug = arg.slice(7);
    else if (arg === '--from') result.from = args[++i] || null;
    else if (arg.startsWith('--from=')) result.from = arg.slice(7) || null;
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--mode') result.mode = args[++i];
    else if (arg.startsWith('--mode=')) result.mode = arg.slice(7);
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  result.subcommand = positional[0] || null;
  result.target = positional.slice(1).join(' ') || null;
  return result;
}

function showHelp() {
  console.log(`Usage: node sdw_spec.cjs <subcommand> [args] [options]

Subcommands:
  init                     Bootstrap {specsDir}/index.specs.md with standard headers and inventory
  list                     Display registered specifications with status and validation health
  new <requirements>      Synthesize canonical specification with autoincremented numerical prefix
  import                   Import remote tracker item from GitHub or Azure DevOps
  sync                     Reconcile index.specs.md against on-disk files and orchestrator run states
  validate <specPath>      Validate frontmatter, section hierarchy, and strict EARS syntax
  status <slug> <status>   Change the spec header status with defined transitions
  update                   Propose a drift entry from changed files named by the specification
  archive <slug>           Transition completed specification to archived in index.specs.md
  help                     Show this help documentation

Spec statuses:
  draft | awaiting-approval | ready-to-implement | implemented | abandoned

Options:
  --root <path>            Target project workspace root directory
  --status <status>        Filter specifications by status (pending, completed, archived)
  --provider <name>        SCM provider for import (github, azure-devops)
  --id <id>                Work item or issue ID for remote import
  --title <title>          Explicit title for newly synthesized specification
  --slug <slug>            Specification slug ("new" and "update" subcommands)
  --from <commit>          Base commit for drift comparison in "update" (default: HEAD)
  --apply                  Write the proposed drift insertion into the specification
  --mode <mode>            Validation mode (authoring | compat, default: authoring)
  --force                  Force overwrite or allow archiving incomplete specifications
  --dry-run                Preview synchronization transitions without modifying disk
  --json                   Output responses in structured JSON format
  -h, --help               Show help message
`);
}

async function cmdInit(options) {
  try {
    const entries = initIndex(options);
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', initialized: true, count: entries.length, entries }, null, 2));
    } else {
      console.log(`[sdw-spec init] Successfully bootstrapped specification index with ${entries.length} detected specification(s).`);
      entries.forEach(e => {
        console.log(`  + [${e.prefix}] ${e.slug} (${e.status.toUpperCase()}) - ${e.validation}`);
      });
    }
    return 0;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[sdw-spec init] Error: ${err.message}`);
    }
    return 1;
  }
}

function cmdList(options) {
  try {
    const list = listIndex(options);
    if (options.json) {
      console.log(JSON.stringify(list, null, 2));
    } else {
      console.log(`[sdw-spec list] Registered specifications (${list.length}${options.status ? ` filtered by status="${options.status}"` : ''}):\n`);
      if (list.length === 0) {
        console.log('  (no specifications found matching query)');
      } else {
        const pPad = Math.max(6, ...list.map(l => (l.prefix || '').length));
        const sPad = Math.max(10, ...list.map(l => (l.slug || '').length));
        const stPad = 11;
        const vPad = 8;
        console.log(`${'PREFIX'.padEnd(pPad)} | ${'SLUG'.padEnd(sPad)} | ${'STATUS'.padEnd(stPad)} | ${'HEALTH'.padEnd(vPad)} | TITLE`);
        console.log(`${'-'.repeat(pPad)}-|-|${'-'.repeat(sPad)}-|-|${'-'.repeat(stPad)}-|-|${'-'.repeat(vPad)}-|-${'-'.repeat(30)}`);
        for (const item of list) {
          const pref = (item.prefix || '').padEnd(pPad);
          const slug = (item.slug || '').padEnd(sPad);
          const stat = (item.status || 'pending').padEnd(stPad);
          const val = (item.validation || 'PASS').padEnd(vPad);
          console.log(`${pref} | ${slug} | ${stat} | ${val} | ${item.title}`);
        }
      }
    }
    return 0;
  } catch (err) {
    console.error(`[sdw-spec list] Error: ${err.message}`);
    return 1;
  }
}

function cmdNew(options) {
  try {
    const text = options.target;
    if (!text) {
      console.error('Error: free-text requirements input is required for "new" subcommand.');
      return 1;
    }

    const created = createNewSpec(text, options);
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', ...created }, null, 2));
    } else {
      console.log(`[sdw-spec new] Successfully created canonical specification "${created.slug}":`);
      console.log(`  File:   ${created.filePath}`);
      console.log(`  Prefix: ${created.prefix}`);
      console.log(`  Title:  ${created.title}`);
      console.log(`  Status: draft (registered as pending in index.specs.md)`);
    }
    return 0;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[sdw-spec new] Error: ${err.message}`);
    }
    return 1;
  }
}

async function cmdImport(options) {
  try {
    const imported = await importRemoteSpec(options);
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', ...imported }, null, 2));
    } else {
      console.log(`[sdw-spec import] Successfully imported remote item #${imported.item.id} (${imported.item.source}):`);
      console.log(`  File:   ${imported.filePath}`);
      console.log(`  Prefix: ${imported.prefix}`);
      console.log(`  Slug:   ${imported.slug}`);
      console.log(`  Title:  ${imported.title}`);
      console.log(`  Status: draft (registered as pending in index.specs.md)`);
    }
    return 0;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[sdw-spec import] ${err.message}`);
    }
    return 1;
  }
}

function cmdSync(options) {
  try {
    const report = syncIndex(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const modeLabel = report.dryRun ? ' [DRY-RUN]' : '';
      console.log(`[sdw-spec sync${modeLabel}] Reconciled ${report.totalEntries} specification(s) with ${report.transitionsCount} transition(s):`);
      if (report.transitions.length === 0) {
        console.log('  (all specification statuses and index entries are up to date)');
      } else {
        report.transitions.forEach(t => {
          console.log(`  * [${t.slug}] ${t.field}: "${t.from || 'none'}" -> "${t.to}" (${t.reason})`);
        });
      }
    }
    return 0;
  } catch (err) {
    console.error(`[sdw-spec sync] Error: ${err.message}`);
    return 1;
  }
}

function cmdValidate(options) {
  if (!options.target) {
    console.error('Error: target specification path is required for "validate" subcommand.');
    return 1;
  }

  const { root, specsDir } = resolvePaths(options.root);
  let targetPath = path.resolve(root, options.target);
  if (!fs.existsSync(targetPath)) {
    const inSpecs = path.resolve(specsDir, options.target);
    if (fs.existsSync(inSpecs)) {
      targetPath = inSpecs;
    } else if (fs.existsSync(inSpecs + '.md')) {
      targetPath = inSpecs + '.md';
    }
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`Error: Specification file not found: ${targetPath}`);
    return 1;
  }

  try {
    const result = validateFile(targetPath, { mode: options.mode });
    if (options.json) {
      console.log(JSON.stringify({ file: targetPath.replace(/\\/g, '/'), ...result }, null, 2));
    } else {
      for (const warning of result.warnings) {
        console.warn(`WARN: ${warning.message}`);
      }
      for (const error of result.errors) {
        console.error(`ERROR: ${error.ac ? `${error.ac}: ` : ''}${error.message}`);
      }
      if (result.ok) {
        console.log(`PASS: ${path.basename(targetPath)} (${result.acceptanceCriteria.length} ACs)`);
      }
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return 1;
  }
}

function cmdArchive(options) {
  if (!options.target) {
    console.error('Error: specification slug or prefix is required for "archive" subcommand.');
    return 1;
  }

  try {
    const archived = archiveSpec(options.target, options);
    if (options.json) {
      console.log(JSON.stringify({ status: 'ok', archived }, null, 2));
    } else {
      console.log(`[sdw-spec archive] Specification "${archived.slug}" successfully marked archived.`);
      console.log(`  Archival Date: ${archived.archivalDate}`);
    }
    return 0;
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: err.message }, null, 2));
    } else {
      console.error(`[sdw-spec archive] Error: ${err.message}`);
    }
    return 1;
  }
}

function findSpecFile(specsDir, key) {
  const direct = path.join(specsDir, `${key}.md`);
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(specsDir)) return null;
  const files = fs.readdirSync(specsDir).filter(name => /^\d{5}-.*\.md$/.test(name));
  const match = files.find(name => {
    const base = name.replace(/\.md$/, '');
    return base === key || base.startsWith(`${key}-`) || base.includes(key);
  });
  return match ? path.join(specsDir, match) : null;
}

function cmdStatus(options) {
  const parts = String(options.target || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) {
    console.error('Error: usage is "status <slug> <status>".');
    console.error(`  Allowed statuses: ${SPEC_STATUSES.join(', ')}`);
    return 1;
  }
  const [key, nextStatus] = parts;
  if (!SPEC_STATUSES.includes(nextStatus)) {
    console.error(`Error: unknown status "${nextStatus}". Allowed: ${SPEC_STATUSES.join(', ')}.`);
    return 1;
  }

  const { root, specsDir } = resolvePaths(options.root);
  const specFile = findSpecFile(specsDir, key);
  if (!specFile) {
    console.error(`Error: specification not found for "${key}" under ${specsDir}.`);
    return 1;
  }

  const content = fs.readFileSync(specFile, 'utf8');
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) {
    console.error(`Error: ${path.basename(specFile)} has no YAML frontmatter.`);
    return 1;
  }

  const currentMatch = fmMatch[1].match(/^status:\s*(.*)$/m);
  const currentStatus = currentMatch ? currentMatch[1].trim() : null;
  if (currentStatus === nextStatus) {
    console.log(`[sdw-spec status] ${path.basename(specFile)} is already ${nextStatus}.`);
    return 0;
  }

  const allowed = currentStatus ? (SPEC_STATUS_TRANSITIONS[currentStatus] || []) : SPEC_STATUSES;
  if (!options.force && currentStatus && !allowed.includes(nextStatus)) {
    console.error(`[sdw-spec status] Refused: ${currentStatus} -> ${nextStatus} is not a defined transition.`);
    console.error(`  Allowed from ${currentStatus}: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}. Use --force to override.`);
    return 1;
  }

  const nextBlock = currentMatch
    ? fmMatch[1].replace(/^status:\s*.*$/m, `status: ${nextStatus}`)
    : fmMatch[1].replace(/^(source:\s*.*)$/m, `$1\nstatus: ${nextStatus}`);
  const updated = content.replace(fmMatch[0], `---\n${nextBlock}\n---\n`);
  fs.writeFileSync(specFile, updated, 'utf8');

  const rel = path.relative(root, specFile).replace(/\\/g, '/');
  if (options.json) {
    console.log(JSON.stringify({ status: 'ok', file: rel, from: currentStatus, to: nextStatus }, null, 2));
  } else {
    console.log(`[sdw-spec status] ${rel}: ${currentStatus || '(none)'} -> ${nextStatus}`);
  }
  return 0;
}

// Drift repair (spec 00038) never rewrites history or lifecycle: it only proposes a
// Notes entry for files the specification already names.

const DRIFT_EXCLUDED_PREFIXES = ['.git/', '.sdw/state/', '.sdw/sandbox/', '.sdw/worktrees/'];

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

function resolveCommitRef(root, ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: root,
    encoding: 'utf8'
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function normalizeProjectPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function isDriftExcluded(relPath) {
  return DRIFT_EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

// AC2, AC3, AC4: tracked working-tree and index changes against <base>, plus untracked
// non-ignored files, minus ephemeral run-state, sandbox, worktree, and .git paths.
function collectDriftFiles(root, baseRef) {
  const changed = new Set();

  // -z keeps non-ASCII, quoted, and backslash paths unquoted; --no-renames makes
  // the output strict status/path pairs, so a rename is a delete plus an add and
  // both paths stay in the drift set. --relative makes diff paths relative to
  // the project root, matching `ls-files --others` when the root sits below the
  // git top level.
  const tracked = runGit(root, ['diff', '--name-status', '--no-renames', '--relative', '-z', baseRef, '--', '.']);
  const fields = tracked.split('\0').filter((field) => field !== '');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const relPath = fields[i + 1].trim();
    if (relPath) changed.add(normalizeProjectPath(relPath));
  }

  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const field of untracked.split('\0')) {
    if (field.trim()) changed.add(normalizeProjectPath(field.trim()));
  }

  return [...changed].filter((relPath) => relPath && !isDriftExcluded(relPath)).sort();
}

// AC5: only an exact project-relative path mention makes a file in scope. A
// trailing period that ends a sentence is not part of the path, while a period
// followed by a word character continues a longer filename and stays rejected.
// An optional `./` prefix is accepted, because the changed-path side strips it
// through normalizeProjectPath and both sides must normalize alike.
function specMentionsPath(specContent, relPath) {
  const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_.\\/-])(?:\\.\\/)?${escaped}(?![A-Za-z0-9_\\/-]|\\.\\w)`).test(specContent);
}

function driftTimestamp(now) {
  const date = now instanceof Date ? now : new Date();
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function driftRevisionLine(matchedFiles) {
  return `${matchedFiles.length} changed file(s) named by this specification: ${matchedFiles.join(', ')}`;
}

function buildDriftInsertion(matchedFiles, baseLabel, timestamp) {
  const lines = [`### Drift Update (${timestamp}; base ${baseLabel})`];
  for (const relPath of matchedFiles) {
    lines.push(`- \`${relPath}\`: named by this specification and changed in the working set`);
  }
  lines.push(`- Revision: ${driftRevisionLine(matchedFiles)}`);
  return lines.join('\n');
}

// Inserts the reviewed block at the end of ## Notes; every other byte is preserved.
function appendDriftInsertion(specContent, insertion) {
  const notes = specContent.match(/^## Notes[ \t]*$/m);
  if (!notes) return null;

  const bodyStart = notes.index + notes[0].length;
  const rest = specContent.slice(bodyStart);
  const nextSection = rest.search(/^## /m);
  const insertAt = nextSection === -1 ? specContent.length : bodyStart + nextSection;
  const head = specContent.slice(0, insertAt);
  const tail = specContent.slice(insertAt);
  const separator = head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n';

  return tail
    ? `${head}${separator}${insertion}\n\n${tail}`
    : `${head}${separator}${insertion}\n`;
}

function cmdUpdate(options) {
  const slug = options.slug ? String(options.slug).trim() : '';
  if (!slug) {
    console.error('Error: --slug <slug> is required for "update" subcommand.');
    return 1;
  }

  const { root, specsDir } = resolvePaths(options.root);
  const specFile = findSpecFile(specsDir, slug);
  if (!specFile) {
    console.error(`Error: no specification file found for slug "${slug}" under ${specsDir.replace(/\\/g, '/')}.`);
    return 1;
  }

  const specContent = fs.readFileSync(specFile, 'utf8');
  if (!/^## Notes[ \t]*$/m.test(specContent)) {
    console.error(`Error: ${path.basename(specFile)} has no "## Notes" section; no drift entry can be proposed.`);
    return 1;
  }

  const baseLabel = options.from ? String(options.from) : 'HEAD';
  const baseCommit = resolveCommitRef(root, baseLabel);
  if (!baseCommit) {
    console.error(`Error: unresolved reference "${baseLabel}": it does not resolve to a commit.`);
    return 1;
  }

  let changedFiles;
  try {
    changedFiles = collectDriftFiles(root, baseCommit);
  } catch (err) {
    console.error(`[sdw-spec update] Error: ${err.message}`);
    return 1;
  }

  const matchedFiles = [];
  const unmatchedFiles = [];
  for (const relPath of changedFiles) {
    (specMentionsPath(specContent, relPath) ? matchedFiles : unmatchedFiles).push(relPath);
  }

  const specRelPath = path.relative(root, specFile).replace(/\\/g, '/');

  if (matchedFiles.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ slug, base: baseLabel, matchedFiles, unmatchedFiles, insertion: '', revisionLine: '' }, null, 2));
    } else {
      console.log('No specification drift found');
    }
    return 0;
  }

  const revisionLine = driftRevisionLine(matchedFiles);
  const insertion = buildDriftInsertion(matchedFiles, baseLabel, driftTimestamp(options.now));

  if (options.apply) {
    fs.writeFileSync(specFile, appendDriftInsertion(specContent, insertion), 'utf8');
    if (options.json) {
      console.log(JSON.stringify({ slug, base: baseLabel, matchedFiles, unmatchedFiles, insertion, revisionLine, applied: true, file: specRelPath }, null, 2));
    } else {
      console.log(`[sdw-spec update] Applied drift entry to ${specRelPath}.`);
      console.log(`  Base: ${baseLabel}`);
      console.log(`  Matched files: ${matchedFiles.length}`);
      console.log(`  Revision line: ${revisionLine}`);
    }
    return 0;
  }

  if (options.json) {
    console.log(JSON.stringify({ slug, base: baseLabel, matchedFiles, unmatchedFiles, insertion, revisionLine }, null, 2));
    return 0;
  }

  console.log(`[sdw-spec update] ${specRelPath} (base ${baseLabel})`);
  console.log(`Matched files (${matchedFiles.length}):`);
  matchedFiles.forEach((relPath) => console.log(`  - ${relPath}`));
  console.log(`Unmatched files (${unmatchedFiles.length}):`);
  unmatchedFiles.forEach((relPath) => console.log(`  - ${relPath}`));
  console.log('Proposed insertion:');
  console.log(insertion);
  console.log('');
  console.log(`Revision line: ${revisionLine}`);
  console.log('No files modified. Re-run with --apply to write this insertion.');
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.subcommand || options.subcommand === 'help' || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(args.includes('-h') || args.includes('--help') || options.subcommand === 'help' ? 0 : 1);
  }

  let code = 0;
  switch (options.subcommand) {
    case 'init':
      code = await cmdInit(options);
      break;
    case 'list':
      code = cmdList(options);
      break;
    case 'new':
      code = cmdNew(options);
      break;
    case 'import':
      code = await cmdImport(options);
      break;
    case 'sync':
      code = cmdSync(options);
      break;
    case 'validate':
      code = cmdValidate(options);
      break;
    case 'archive':
      code = cmdArchive(options);
      break;
    case 'status':
      code = cmdStatus(options);
      break;
    case 'update':
      code = cmdUpdate(options);
      break;
    default:
      console.error(`Unknown subcommand: "${options.subcommand}". Run with --help for usage.`);
      code = 1;
      break;
  }

  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  cmdInit,
  cmdList,
  cmdNew,
  cmdImport,
  cmdSync,
  cmdValidate,
  cmdArchive,
  cmdStatus,
  cmdUpdate,
  collectDriftFiles,
  specMentionsPath,
  buildDriftInsertion,
  appendDriftInsertion,
  SPEC_STATUS_TRANSITIONS
};
