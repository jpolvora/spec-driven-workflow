'use strict';

const fs = require('fs');
const path = require('path');
const { resolvePaths, registerSpec, isSpecificationFile } = require('./spec_index.cjs');
const { createScmProvider, resolveScmProvider, checkScmCapability } = require('./scm_provider_contract.cjs');
const { validateFile } = require('./validate_spec.cjs');

function getNextPrefix(specsDir) {
  if (!fs.existsSync(specsDir)) {
    return '00001';
  }

  const files = fs.readdirSync(specsDir);
  const prefixes = [];

  for (const f of files) {
    // Spec 00060 AC6: a delivery report companion consumes no prefix, so the
    // allocator scans specifications only.
    if (!isSpecificationFile(f)) continue;
    const m = f.match(/^(\d{5})-.*\.md$/);
    if (m) {
      prefixes.push(parseInt(m[1], 10));
    }
  }

  if (prefixes.length === 0) {
    return '00001';
  }

  const highest = Math.max(...prefixes);
  return String(highest + 1).padStart(5, '0');
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'spec';
}

const EARS_PATTERNS = [
  /^the\s+.+\s+shall\s+.+/i,
  /^when\s+.+,\s*the\s+.+\s+shall\s+.+/i,
  /^while\s+.+,\s*the\s+.+\s+shall\s+.+/i,
  /^where\s+.+,\s*the\s+.+\s+shall\s+.+/i,
  /^if\s+.+,\s*then\s+the\s+.+\s+shall\s+.+/i,
];

function toEarsCriterion(text) {
  const trimmed = text.trim().replace(/^[-*+]\s+/, '').replace(/^AC\d+:\s*/i, '').trim();
  for (const p of EARS_PATTERNS) {
    if (p.test(trimmed)) {
      return trimmed;
    }
  }

  // Convert "When X, system will Y" or "When X then Y"
  if (/^when\s+/i.test(trimmed)) {
    const whenMatch = trimmed.match(/^when\s+([^,]+)(?:,\s*|\s+then\s+)(.+)$/i);
    if (whenMatch) {
      const condition = whenMatch[1].trim();
      let outcome = whenMatch[2].trim().replace(/^the\s+system\s+(?:shall|should|will|must)\s+/i, '');
      return `When ${condition}, the system shall ${outcome}`;
    }
  }

  // Convert "If X then Y"
  if (/^if\s+/i.test(trimmed)) {
    const ifMatch = trimmed.match(/^if\s+([^,]+)(?:,\s*|\s+then\s+)(.+)$/i);
    if (ifMatch) {
      const condition = ifMatch[1].trim();
      let outcome = ifMatch[2].trim().replace(/^the\s+system\s+(?:shall|should|will|must)\s+/i, '');
      return `If ${condition}, then the system shall ${outcome}`;
    }
  }

  // Convert imperative: "Create ...", "Validate ...", "Support ..."
  const cleanedAction = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  return `The system shall ${cleanedAction}`;
}

function synthesizeCanonicalSpec(options) {
  const {
    id = null,
    slug,
    title,
    source = 'local',
    specDate = new Date().toISOString().slice(0, 10),
    description = '',
    acceptanceCriteria = [],
    isTracker = false
  } = options;

  const acLines = (acceptanceCriteria.length > 0 ? acceptanceCriteria : [
    `The system shall implement ${title} in accordance with architectural standards.`
  ]).map((ac, idx) => `- AC${idx + 1}: ${toEarsCriterion(ac)}`).join('\n');

  const priorWorkSweep = isTracker
    ? `\n### Prior Work Sweep\n\nReviewed existing workspace implementations and tracker references prior to specification formulation.\n`
    : '';

  // Spec 00051 AC2: an imported specification names its source item in Notes.
  const importNote = id !== null && source && source !== 'local'
    ? `- Imported from ${source} as item #${id}.\n`
    : '';

  return `---
id: ${id !== null ? JSON.stringify(id) : 'null'}
slug: ${slug}
title: ${JSON.stringify(title)}
source: ${source}
status: draft
specDate: ${specDate}
---

# Specification — ${title}

## Description

${description || `Implementation and lifecycle specification for ${title}.`}

### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for ${title}.
${priorWorkSweep}
## Acceptance Criteria

${acLines}

## Notes

${importNote}- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of ${slug} |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Workspace directory standards | Follow canonical .sdw workspace guidelines | Consistent developer ergonomics across projects | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | Run validate_spec.cjs in authoring mode |
| Directory layout | Target workspace directories exist and are writable | File system check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Deterministic command execution logs and structured console progress reports.
- Non-zero exit codes returned upon validation or verification failures.

### Negative & Failing Test Scenarios

- Input rejection test case: the system must reject invalid inputs or malformed options with descriptive error messages.
`;
}

function createNewSpec(inputText, options = {}) {
  const { specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
  }

  const prefix = getNextPrefix(specsDir);
  const text = String(inputText || options.text || '').trim();
  if (!text) {
    throw new Error('Input text or requirements description is required to create a new specification.');
  }

  // Derive title from options or first line of text
  const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').trim();
  const title = options.title || firstLine || `Feature ${prefix}`;
  const rawSlug = options.slug || slugify(title);
  const slug = `${prefix}-${rawSlug.replace(/^\d{5}-/, '')}`;

  // Extract raw criteria or bullets if present
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const bullets = lines.filter(l => /^[-*+]\s+/.test(l) || /^AC\d+:\s*/i.test(l));

  const criteria = bullets.length > 0
    ? bullets.map(b => b.replace(/^[-*+]\s+/, '').replace(/^AC\d+:\s*/i, ''))
    : [firstLine];

  const specContent = synthesizeCanonicalSpec({
    id: null,
    slug,
    title,
    source: 'local',
    description: text,
    acceptanceCriteria: criteria,
    isTracker: false
  });

  const targetFile = path.join(specsDir, `${slug}.md`);
  if (fs.existsSync(targetFile) && !options.force) {
    throw new Error(`Specification file already exists at ${targetFile}. Use --force to overwrite.`);
  }

  fs.writeFileSync(targetFile, specContent, 'utf8');

  // Register in index.specs.md (AC12)
  registerSpec({
    prefix,
    slug,
    title,
    status: 'pending',
    source: 'local',
    specDate: new Date().toISOString().slice(0, 10),
    validation: 'PASS'
  }, options);

  return {
    filePath: targetFile,
    prefix,
    slug,
    title,
    content: specContent
  };
}

async function importRemoteSpec(options = {}) {
  const { root, specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
  }

  const itemId = options.id;
  if (!itemId) {
    throw new Error('Item identifier (--id <itemId>) is required for import.');
  }

  // Load project config if not supplied
  let config = options.config;
  if (!config) {
    const cfgPath = path.join(root, '.sdw', 'config.json');
    if (fs.existsSync(cfgPath)) {
      try {
        config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch (e) {}
    }
  }

  // Resolve provider from explicit argument or config (AC7, AC8, AC9)
  const resolution = resolveScmProvider({ config, explicit: options.provider });
  if (resolution.disabled || resolution.provider === 'none') {
    throw new Error('SCM import disabled: set scmProvider to "github" or "ado" in .sdw/config.json or pass --provider <github|ado>.');
  }

  const providerName = resolution.provider;

  // Check capability: CLI must be installed and authenticated (AC10, AC11)
  if (!options.scmProvider) {
    const capability = checkScmCapability(providerName, options);
    if (!capability.installed) {
      throw new Error(`SCM Import Failed: Provider CLI "${capability.bin}" is not installed or not found on PATH. Please install "${capability.bin}" to enable ${providerName} imports.`);
    }
    if (!capability.authenticated) {
      throw new Error(`SCM Import Failed: Provider CLI "${capability.bin}" is not authenticated. Detail: ${capability.error}`);
    }
  }

  const provider = options.scmProvider || createScmProvider(providerName, options);

  // Retrieve remote work item using SCM provider contract (AC14, AC16)
  let item;
  try {
    item = await provider.fetchWorkItem(itemId);
  } catch (err) {
    throw new Error(`SCM Import Failed: Unable to retrieve work item #${itemId} from ${providerName}. Detail: ${err.message}`);
  }

  if (!item || !item.id) {
    throw new Error(`SCM Import Failed: Provider returned empty or invalid data for item #${itemId}.`);
  }

  // Check if a spec already exists for this remote work item (AC17)
  const existingFiles = fs.readdirSync(specsDir).filter(f => f.endsWith('.md') && f !== 'index.specs.md');
  for (const f of existingFiles) {
    const fullPath = path.join(specsDir, f);
    const content = fs.readFileSync(fullPath, 'utf8');
    const fmMatch = content.match(/id:\s*(["']?[^"'\r\n]+["']?)/);
    if (fmMatch) {
      const existingId = fmMatch[1].replace(/['"]/g, '').trim();
      if (existingId === String(item.id)) {
        if (!options.force) {
          throw new Error(`Specification for remote work item #${item.id} already exists on disk (${f}). Overwrite rejected without --force.`);
        }
      }
    }
  }

  const prefix = getNextPrefix(specsDir);
  const title = options.title || item.title || `Work Item ${item.id}`;
  const cleanTitleSlug = slugify(item.title || `us-${item.id}`);
  const slug = `${prefix}-us-${item.id}-${cleanTitleSlug}`.slice(0, 45).replace(/-+$/, '');

  const acceptanceCriteria = item.acceptanceCriteria && item.acceptanceCriteria.length > 0
    ? item.acceptanceCriteria
    : [`The system shall deliver requirements for remote work item #${item.id}: ${item.title}`];

  const specContent = synthesizeCanonicalSpec({
    id: String(item.id),
    slug,
    title,
    source: item.source,
    description: item.description || `Imported remote item #${item.id} from ${item.source}.`,
    acceptanceCriteria,
    isTracker: true
  });

  const targetFile = path.join(specsDir, `${slug}.md`);
  fs.writeFileSync(targetFile, specContent, 'utf8');

  // Register in index.specs.md (AC12)
  registerSpec({
    prefix,
    slug,
    title,
    status: 'pending',
    source: item.source,
    specDate: new Date().toISOString().slice(0, 10),
    validation: 'PASS'
  }, options);

  return {
    filePath: targetFile,
    prefix,
    slug,
    title,
    item,
    content: specContent
  };
}

module.exports = {
  getNextPrefix,
  slugify,
  toEarsCriterion,
  synthesizeCanonicalSpec,
  createNewSpec,
  importRemoteSpec
};
