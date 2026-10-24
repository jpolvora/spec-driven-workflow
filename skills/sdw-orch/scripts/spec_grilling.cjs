'use strict';

const fs = require('fs');
const path = require('path');

const DECISION_DIMENSIONS = [
  {
    name: 'input_validation',
    question: 'How should invalid or malformed inputs be handled?',
    check: (content) => /invalid|malformed|bounds|validation|sanitiz/i.test(content),
    options: [
      '(Recommended) Fail-fast with descriptive error message and non-zero exit code',
      'Ignore invalid input and continue with safe defaults',
      'Prompt user interactively to correct the input'
    ]
  },
  {
    name: 'error_recovery',
    question: 'What strategy should be used when an unrecoverable failure occurs in a task?',
    check: (content) => /unrecoverable|failure|fallback|abort|rollback/i.test(content),
    options: [
      '(Recommended) Persist failure state to run state file and halt execution immediately',
      'Roll back changes to base commit and exit',
      'Skip the failing task and proceed to next task'
    ]
  },
  {
    name: 'concurrency_and_ordering',
    question: 'How should task execution ordering be scheduled?',
    check: (content) => /concurrency|parallel|paralel|sequential|ordering|dependency|single execution unit/i.test(content),
    options: [
      '(Recommended) Execute sequentially by default, parallelizing only independent DAG tasks',
      'Execute all tasks sequentially without parallelization',
      'Execute all tasks concurrently with independent workers'
    ]
  },
  {
    name: 'state_persistence',
    question: 'Where should session state be persisted across runs?',
    check: (content) => /\.sdw\/state|state file|session state|\.state\.json/i.test(content),
    options: [
      '(Recommended) Persist to .sdw/state/{runId}.state.json',
      'Store ephemeral state in memory without writing to disk',
      'Persist state to repo root .state.json'
    ]
  }
];

function looksLikeProjectPath(rawToken) {
  const token = String(rawToken || '').replace(/^[("'`\[]+/, '').replace(/[)"'`\],.;:]+$/, '');
  if (!token) return null;
  if (/\s/.test(token)) return null;
  if (token.includes('*') || token.includes('{') || token.includes('<') || token.includes('>')) return null;
  if (/^(https?:|git@)/i.test(token)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(token)) return null;
  if (token.startsWith('/') || token.startsWith('-') || token.startsWith('~')) return null;
  const normalized = token.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.includes('/')) return null;
  if (!/\.[a-zA-Z0-9]{1,6}$/.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

function extractTargetFiles(specContent) {
  if (!specContent) return [];
  const files = new Set();
  const push = (raw) => {
    const candidate = looksLikeProjectPath(raw);
    if (candidate) files.add(candidate);
  };

  // Backticked spans hold either one path or a command line that names paths.
  for (const match of specContent.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1].trim();
    push(span);
    for (const token of span.split(/\s+/)) push(token);
  }
  // Fenced code blocks hold CLI contracts and path templates.
  for (const match of specContent.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const token of match[1].split(/\s+/)) push(token);
  }
  return Array.from(files);
}

function extractArchitecturalApproach(specContent) {
  if (!specContent) return 'Implement canonical architecture conforming strictly to specification acceptance criteria.';
  const designIntentMatch = specContent.match(/### Design Intent\s*\r?\n([\s\S]*?)(?=\r?\n## |\r?\n$)/);
  if (designIntentMatch && designIntentMatch[1].trim()) {
    return designIntentMatch[1].trim().split('\n')[0].trim();
  }
  const descMatch = specContent.match(/## Description\s*\r?\n([\s\S]*?)(?=\r?\n### |\r?\n## |\r?\n$)/);
  if (descMatch && descMatch[1].trim()) {
    return descMatch[1].trim().split('\n')[0].trim();
  }
  return 'Implement canonical architecture conforming strictly to specification acceptance criteria.';
}

function extractTestPlan(specContent) {
  if (!specContent) return 'Execute native automated test suite verifying all acceptance criteria and negative failure scenarios.';
  const negMatch = specContent.match(/### Negative & Failing Test Scenarios\s*\r?\n([\s\S]*?)(?=\r?\n## |\r?\n$)/);
  if (negMatch && negMatch[1].trim()) {
    return negMatch[1].trim().split('\n')[0].replace(/^[-*+]\s+/, '').trim();
  }
  return 'Execute native automated test suite verifying all acceptance criteria and negative failure scenarios.';
}

/**
 * Spec 00069 AC3: a `New files` note declares paths the author intends to
 * create. The declaration is a promise, not a check: the path is carried into
 * the plan even though it does not exist yet.
 */
function extractDeclaredNewFiles(specContent) {
  const files = new Set();
  const collect = (text) => {
    for (const match of String(text || '').matchAll(/`([^`\n]+)`/g)) {
      for (const token of match[1].trim().split(/\s+/)) {
        const candidate = looksLikeProjectPath(token);
        if (candidate) files.add(candidate);
      }
    }
  };
  let mode = null;
  for (const line of String(specContent || '').split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      mode = /^new files\b/i.test(heading[1].trim()) ? 'section' : null;
      if (mode) collect(line);
      continue;
    }
    if (/^\s*(?:[-*+]\s+)?New files\b/i.test(line)) {
      mode = 'inline';
      collect(line);
      continue;
    }
    if (mode === 'section') {
      collect(line);
      continue;
    }
    if (mode === 'inline') {
      if (!line.trim()) {
        mode = null;
      } else if (/^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line) || /^\s+\S/.test(line)) {
        collect(line);
      } else {
        mode = null;
      }
    }
  }
  return [...files];
}

/**
 * Spec 00069 AC1/AC3: the blueprint carries only paths the specification names
 * explicitly plus the new files it declares. A pathless specification resolves
 * no target file here: the caller falls back to a verified bucket or refuses
 * instead of synthesizing a path from the slug.
 */
function generateRefinementBlueprint(specContent, options = {}) {
  const named = options.targetFiles || extractTargetFiles(specContent);
  const declaredNewFiles = extractDeclaredNewFiles(specContent);
  const targetFiles = [...new Set([...named, ...declaredNewFiles])];

  return {
    targetFiles,
    declaredNewFiles,
    architecturalApproach: extractArchitecturalApproach(specContent),
    testPlan: extractTestPlan(specContent)
  };
}

function analyzeSpecificationGaps(specContent, options = {}) {
  const gaps = [];

  for (const dim of DECISION_DIMENSIONS) {
    const covered = dim.check(specContent);
    if (!covered) {
      gaps.push({
        dimension: dim.name,
        question: dim.question,
        options: dim.options,
        defaultChoice: dim.options[0]
      });
    }
  }

  const blueprint = generateRefinementBlueprint(specContent, options);

  return {
    hasGaps: gaps.length > 0,
    gapsCount: gaps.length,
    gaps,
    blueprint,
    decisionTreeWalk: {
      totalDimensionsChecked: DECISION_DIMENSIONS.length,
      coveredDimensions: DECISION_DIMENSIONS.length - gaps.length
    }
  };
}

function applyDecision(specContent, dimension, chosenOption) {
  const decisionNote = `\n<!-- Decision Gate: [${dimension}] -> ${chosenOption} -->\n`;
  if (specContent.includes('## Assumptions & Open Questions')) {
    return specContent.replace(
      '## Assumptions & Open Questions',
      `## Assumptions & Open Questions\n| ${dimension} | ${chosenOption.replace(/^\(Recommended\)\s*/, '')} | Grilling decision confirmed | y |\n`
    );
  }
  return specContent + decisionNote;
}

// Spec 00054 AC11-AC14: advisory observations read other specifications and
// record what they provably say. Nothing here rewrites a specification, and no
// observation can block a run: every failure degrades to "no observation".
const DELIVERED_STATUSES = new Set(['completed', 'implemented']);
const SUPERSESSION_PHRASES = [
  'superseded by',
  'abandoned in favor of',
  'will not implement',
  'supersedes',
  'replaces',
  'replaced by'
];
const OBSERVATION_ORDER = ['overlap', 'superseded', 'conflict'];
const MAX_EVIDENCE_LENGTH = 240;

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function frontMatterValue(specContent, key) {
  const frontMatter = String(specContent || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontMatter) return null;
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = frontMatter[1].match(new RegExp(`^${escapedKey}:\\s*(.+)$`, 'm'));
  if (!line) return null;
  const value = line[1].trim().replace(/^["']|["']$/g, '');
  return value || null;
}

function specIdentity(specContent, filePath) {
  const slug = frontMatterValue(specContent, 'slug')
    || path.basename(filePath, path.extname(filePath));
  const rawId = frontMatterValue(specContent, 'id');
  const id = rawId && rawId !== 'null' ? rawId : null;
  const prefixMatch = String(slug).match(/^\d{3,}/);
  return {
    slug,
    id,
    numericPrefix: prefixMatch ? prefixMatch[0] : null
  };
}

function parseRegistryStatuses(indexContent) {
  const statuses = new Map();
  for (const line of String(indexContent || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const slug = cells[1];
    const status = cells[3];
    if (!slug || !status) continue;
    if (/^slug$/i.test(slug) || /^:?-{3,}:?$/.test(slug)) continue;
    statuses.set(slug, status.toLowerCase());
  }
  return statuses;
}

function listSpecFiles(specsDir) {
  try {
    return fs.readdirSync(specsDir)
      .filter((name) => name.endsWith('.md'))
      .filter((name) => name !== 'index.specs.md' && !name.endsWith('-report.md'))
      .map((name) => path.join(specsDir, name));
  } catch (e) {
    return [];
  }
}

function flattenConfigKeys(value, prefix, result) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        flattenConfigKeys(child, nextPrefix, result);
      } else {
        result.push(nextPrefix);
      }
    }
  } else if (prefix) {
    result.push(prefix);
  }
  return result;
}

function readConfigKeys(configPath) {
  const raw = readTextFile(configPath);
  if (raw === null) return [];
  try {
    return flattenConfigKeys(JSON.parse(raw), '', []);
  } catch (e) {
    return [];
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A declaration is the key immediately followed by `:` or `=`. Prose mentions
// ("see scoreMin in the configuration") stay unrecorded: the value is the proof.
function extractDeclaredValues(specContent, key) {
  const values = new Set();
  const pattern = new RegExp(`\`?${escapeRegExp(key)}\`?\\s*(?::|=)\\s*\`?([^\`\\s,;|)]+)`, 'gi');
  for (const match of String(specContent || '').matchAll(pattern)) {
    const value = match[1].replace(/^["']|["']$/g, '').replace(/[.,;:]+$/, '');
    if (value) values.add(value);
  }
  return [...values].sort();
}

function matchTargetReference(text, identity) {
  const normalized = String(text || '').toLowerCase();
  if (identity.slug && normalized.includes(identity.slug.toLowerCase())) return identity.slug;
  if (identity.id && normalized.includes(identity.id.toLowerCase())) return identity.id;
  if (identity.numericPrefix && new RegExp(`(^|[^0-9])${identity.numericPrefix}([^0-9]|$)`).test(normalized)) {
    return identity.numericPrefix;
  }
  return null;
}

function truncateEvidence(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > MAX_EVIDENCE_LENGTH ? `${value.slice(0, MAX_EVIDENCE_LENGTH - 1)}…` : value;
}

function observation(kind, otherSpec, evidence, severity) {
  return { kind, otherSpec, evidence: truncateEvidence(evidence), severity };
}

/**
 * Spec 00054 AC11-AC14: file-content heuristics over sibling specifications.
 * Returns [] when the specification directory is unavailable or unreadable; the
 * caller records what came back and never gates the run on the result.
 */
function analyzeSpecObservations(options = {}) {
  const observations = [];
  const root = path.resolve(options.targetRoot || '.');
  const targetFile = options.specPath
    ? (path.isAbsolute(options.specPath) ? options.specPath : path.resolve(root, options.specPath))
    : null;
  const targetContent = options.specContent || (targetFile ? readTextFile(targetFile) : null);
  if (!targetContent) return observations;

  const specsDir = path.resolve(options.specsDir || path.join(root, '.sdw', 'specs'));
  const targetIdentity = specIdentity(targetContent, targetFile || 'spec.md');
  const targetFiles = extractTargetFiles(targetContent);
  const configPath = path.resolve(options.configPath || path.join(root, '.sdw', 'config.json'));
  const configKeys = readConfigKeys(configPath);
  const targetDeclarations = new Map();
  for (const key of configKeys) {
    targetDeclarations.set(key, extractDeclaredValues(targetContent, key));
  }
  const registry = parseRegistryStatuses(readTextFile(path.join(specsDir, 'index.specs.md')));

  for (const otherFile of listSpecFiles(specsDir)) {
    if (targetFile && path.resolve(otherFile) === targetFile) continue;
    const otherContent = readTextFile(otherFile);
    if (!otherContent) continue;
    const otherIdentity = specIdentity(otherContent, otherFile);
    const indexedStatus = registry.get(otherIdentity.slug)
      || registry.get(path.basename(otherFile, path.extname(otherFile)));
    const rawStatus = indexedStatus || frontMatterValue(otherContent, 'status');
    const delivered = Boolean(rawStatus) && DELIVERED_STATUSES.has(String(rawStatus).toLowerCase());
    const otherFiles = extractTargetFiles(otherContent);
    const sharedFiles = targetFiles.filter((file) => otherFiles.includes(file));
    const severity = delivered && sharedFiles.length > 0 ? 'high' : 'medium';

    if (delivered) {
      for (const file of sharedFiles) {
        observations.push(observation(
          'overlap',
          otherIdentity.slug,
          `Specs "${targetIdentity.slug}" and "${otherIdentity.slug}" both name \`${file}\`.`,
          severity
        ));
      }
    }

    for (const line of String(otherContent).split(/\r?\n/)) {
      const lowerLine = line.toLowerCase();
      const phrase = SUPERSESSION_PHRASES.find((candidate) => lowerLine.includes(candidate));
      if (!phrase) continue;
      const matchedReference = matchTargetReference(line, targetIdentity);
      if (!matchedReference) continue;
      observations.push(observation(
        'superseded',
        otherIdentity.slug,
        `Spec "${otherIdentity.slug}" names "${matchedReference}" in a supersession context ("${phrase}"): ${line.trim()}`,
        severity
      ));
    }

    for (const key of configKeys) {
      const targetValues = targetDeclarations.get(key) || [];
      if (targetValues.length === 0) continue;
      const otherValues = extractDeclaredValues(otherContent, key);
      if (otherValues.length === 0) continue;
      const same = otherValues.length === targetValues.length
        && otherValues.every((value) => targetValues.includes(value));
      if (same) continue;
      observations.push(observation(
        'conflict',
        otherIdentity.slug,
        `Spec "${targetIdentity.slug}" declares \`${key}\` as ${targetValues.join(', ')}; spec "${otherIdentity.slug}" declares it as ${otherValues.join(', ')}.`,
        severity
      ));
    }
  }

  const seen = new Set();
  return observations
    .filter((item) => {
      const key = `${item.kind}|${item.otherSpec}|${item.evidence}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const kindDelta = OBSERVATION_ORDER.indexOf(a.kind) - OBSERVATION_ORDER.indexOf(b.kind);
      if (kindDelta !== 0) return kindDelta;
      const specDelta = String(a.otherSpec).localeCompare(String(b.otherSpec));
      if (specDelta !== 0) return specDelta;
      return String(a.evidence).localeCompare(String(b.evidence));
    });
}

module.exports = {
  DECISION_DIMENSIONS,
  analyzeSpecificationGaps,
  applyDecision,
  generateRefinementBlueprint,
  extractTargetFiles,
  extractDeclaredNewFiles,
  analyzeSpecObservations
};
