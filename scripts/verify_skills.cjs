#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const builtinModules = require('module').builtinModules;

const ALLOWED_BUILTINS = new Set(builtinModules.map(m => m.replace(/^node:/, '')));

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, 'skills')) && fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    if (fs.existsSync(path.join(curr, 'skills')) && fs.existsSync(path.join(curr, '.sdw'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

function parseFrontmatter(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return null;
  const values = {};
  for (const line of match[1].split('\n')) {
    const item = line.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (item) {
      let val = item[2].trim().replace(/^['"]|['"]$/g, '');
      values[item[1]] = val;
    }
  }
  return values;
}

function extractReferences(content, dirName) {
  const refs = new Set();
  const re = new RegExp(dirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/([^\\s\\)\\]\\}\'"`]+)', 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    let ref = m[1].replace(/[.,;:]+$/, '');
    ref = ref.split('#')[0].split('?')[0];
    if (ref) refs.add(ref);
  }
  return [...refs];
}

function scanRequires(jsCode) {
  const reqs = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(jsCode)) !== null) {
    reqs.push(m[1]);
  }
  const impRe = /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
  while ((m = impRe.exec(jsCode)) !== null) {
    reqs.push(m[1]);
  }
  return reqs;
}

function verifySkills(options = {}) {
  const root = path.resolve(options.root || findProjectRoot(process.cwd()));
  const skillsDir = path.join(root, 'skills');
  const errors = [];
  const skills = [];

  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return {
      ok: false,
      root: root.replace(/\\/g, '/'),
      skillsChecked: 0,
      skills: [],
      errors: [{ skill: '(skills)', message: 'skills/ directory not found' }]
    };
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  if (entries.length === 0) {
    return {
      ok: false,
      root: root.replace(/\\/g, '/'),
      skillsChecked: 0,
      skills: [],
      errors: [{ skill: '(skills)', message: 'no distributable skills found under skills/' }]
    };
  }

  for (const skillName of entries) {
    const skillDir = path.join(skillsDir, skillName);
    const skillRel = 'skills/' + skillName;
    const info = { name: skillName, lineCount: 0, references: 0, scripts: 0 };
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      errors.push({ skill: skillName, message: 'Missing Tier 1 entrypoint: ' + skillRel + '/SKILL.md' });
      continue;
    }

    const content = fs.readFileSync(skillMdPath, 'utf8');
    const lines = content.split(/\r?\n/);
    info.lineCount = lines.length;

    const fm = parseFrontmatter(content);
    if (!fm) {
      errors.push({ skill: skillName, message: 'Broken frontmatter: missing or invalid YAML frontmatter in SKILL.md' });
      continue;
    }
    if (!fm.name || !String(fm.name).trim()) {
      errors.push({ skill: skillName, message: 'Broken frontmatter: missing required "name" in SKILL.md' });
    }
    if (!fm.description || !String(fm.description).trim()) {
      errors.push({ skill: skillName, message: 'Broken frontmatter: missing required "description" in SKILL.md' });
    }

    if (!/>\s*When this skill is loaded,\s*output/i.test(content)) {
      errors.push({ skill: skillName, message: 'Tier 1 violation: missing announcement header (> When this skill is loaded, output "... loaded.")' });
    }

    if (lines.length > 120) {
      errors.push({ skill: skillName, message: 'Tier 1 violation: SKILL.md exceeds 120 lines (' + lines.length + ' lines)' });
    }

    const refsDir = path.join(skillDir, 'references');
    if (!fs.existsSync(refsDir) || !fs.statSync(refsDir).isDirectory()) {
      errors.push({ skill: skillName, message: 'Tier 2 violation: missing references/ directory in ' + skillRel });
    } else {
      const refFiles = extractReferences(content, 'references');
      for (const ref of refFiles) {
        const refPath = path.join(refsDir, ref);
        if (!fs.existsSync(refPath)) {
          errors.push({ skill: skillName, message: 'Tier 2 violation: referenced file missing: ' + skillRel + '/references/' + ref });
        }
      }
      info.references = refFiles.length;
    }

    const scriptsDir = path.join(skillDir, 'scripts');
    if (!fs.existsSync(scriptsDir) || !fs.statSync(scriptsDir).isDirectory()) {
      errors.push({ skill: skillName, message: 'Tier 3 violation: missing scripts/ directory in ' + skillRel });
    } else {
      const scriptRefs = extractReferences(content, 'scripts').filter(f => f.endsWith('.cjs'));
      for (const ref of scriptRefs) {
        const refPath = path.join(scriptsDir, ref);
        if (!fs.existsSync(refPath)) {
          errors.push({ skill: skillName, message: 'Tier 3 violation: referenced script missing: ' + skillRel + '/scripts/' + ref });
        }
      }
      const onDiskScripts = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.cjs'));
      info.scripts = onDiskScripts.length;
      for (const scriptFile of onDiskScripts) {
        const code = fs.readFileSync(path.join(scriptsDir, scriptFile), 'utf8');
        const reqs = scanRequires(code);
        for (const req of reqs) {
          if (req.startsWith('.') || req.startsWith('/') || req.startsWith('node:')) {
            const bare = req.replace(/^node:/, '');
            if (req.startsWith('.') || req.startsWith('/')) continue;
            if (ALLOWED_BUILTINS.has(bare) || ALLOWED_BUILTINS.has(req)) continue;
          }
          const bare = req.replace(/^node:/, '').split('/')[0];
          if (!ALLOWED_BUILTINS.has(bare) && !ALLOWED_BUILTINS.has(req)) {
            errors.push({ skill: skillName, message: 'Zero-dependency violation: external module "' + req + '" required by ' + skillRel + '/scripts/' + scriptFile });
          }
        }
      }
    }

    skills.push(info);
  }

  return {
    ok: errors.length === 0,
    root: root.replace(/\\/g, '/'),
    skillsChecked: skills.length + errors.filter(e => !skills.find(s => s.name === e.skill)).length,
    skills,
    errors
  };
}

function printUsage() {
  console.log('Usage: node scripts/verify_skills.cjs [verify] [--verify] [--root <dir>] [--json]');
  console.log('');
  console.log('Deterministic packaging verification for npx skills (vercel-labs/skills) compatibility.');
  console.log('Validates three-tier architecture (SKILL.md / references/ / scripts/) with zero external deps.');
}

function main() {
  const argv = process.argv.slice(2);
  let root = null;
  let json = false;
  let showHelp = false;
  let subcommand = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') showHelp = true;
    else if (arg === '--root') root = argv[++i];
    else if (arg.startsWith('--root=')) root = arg.slice(7);
    else if (arg === '--verify' || arg === 'verify') subcommand = 'verify';
    else if (!arg.startsWith('-') && !subcommand) subcommand = arg;
    else {
      console.error('Unknown argument: ' + arg);
      process.exit(1);
    }
  }

  if (showHelp) {
    printUsage();
    process.exit(0);
  }

  if (subcommand && subcommand !== 'verify') {
    console.error('Unknown subcommand: "' + subcommand + '". Did you mean "verify"?');
    process.exit(1);
  }

  const result = verifySkills({ root });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('[verify_skills] Audited ' + result.skillsChecked + ' skill(s) under skills/:');
    for (const s of result.skills) {
      console.log('  + ' + s.name + ' (SKILL.md: ' + s.lineCount + ' lines, refs: ' + s.references + ', scripts: ' + s.scripts + ')');
    }
    if (result.ok) {
      console.log('[verify_skills] PASS: all skills adhere to the three-tier architecture with zero external dependencies.');
    } else {
      for (const e of result.errors) {
        console.error('[verify_skills] ERROR [' + e.skill + ']: ' + e.message);
      }
      console.error('[verify_skills] FAIL: ' + result.errors.length + ' violation(s) found.');
    }
  }

  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  verifySkills,
  findProjectRoot,
  parseFrontmatter
};
