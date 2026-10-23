'use strict';

/**
 * Spec 00062: the two remote mirroring directions.
 *
 * `sync-up` pushes local specifications to the registered SCM provider and
 * `sync-down` pulls remote tracker state back into the local registry. Both
 * refuse to run without a registered, installed, and authenticated provider, so
 * the refusal always precedes any provider call or local write. `--dry-run`
 * plans from local files only: it probes no CLI, constructs no provider, and
 * executes no provider command.
 */

const fs = require('fs');
const path = require('path');

const {
  resolvePaths,
  readIndex,
  parseFrontmatter,
  isSpecificationFile,
  updateSpecStatus,
  registerSpec
} = require('./spec_index.cjs');
const {
  createScmProvider,
  resolveScmProvider,
  checkScmCapability,
  providerSourceName
} = require('./scm_provider_contract.cjs');
const { getNextPrefix, slugify, synthesizeCanonicalSpec } = require('./spec_creator.cjs');

// One status table, read by both directions.
const LOCAL_TO_REMOTE_STATE = {
  pending: 'open',
  completed: 'closed',
  archived: 'closed'
};

const REMOTE_TO_LOCAL_STATUS = {
  open: 'pending',
  closed: 'completed'
};

// Delivery evidence already closed these rows; a remote `open` never reopens them.
const CLOSED_LOCAL_STATUSES = ['completed', 'archived'];

// AC11: the first line of every issue body written by sync-up. It is an HTML
// comment, so it disappears when rendered and gives sync-down an exact slug
// lookup before any title fallback.
const SLUG_MARKER = /^\s*<!--\s*sdw-spec:\s*([^\s>]+)\s*-->/;

function slugMarker(slug) {
  return `<!-- sdw-spec: ${slug} -->`;
}

function issueBody(spec) {
  return `${slugMarker(spec.slug)}\n\n${String(spec.content || '').trimEnd()}\n`;
}

function parseSlugMarker(body) {
  const match = String(body || '').replace(/\r\n?/g, '\n').match(SLUG_MARKER);
  return match ? match[1].trim() : null;
}

// AC10: bodies are compared after the marker, line endings, and trailing
// whitespace are normalized, so a sync-up round trip never reads as drift.
function normalizeBody(body) {
  return String(body || '')
    .replace(/\r\n?/g, '\n')
    .replace(SLUG_MARKER, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function bodiesAgree(localContent, remoteBody) {
  return normalizeBody(localContent) === normalizeBody(remoteBody);
}

function normalizeTitle(title) {
  return String(title || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function readProjectConfig(root) {
  const configPath = path.join(root, '.sdw', 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${configPath}: ${err.message}`);
  }
}

/**
 * AC12: the provider name alone, resolved from configuration or `--provider`.
 * A dry-run needs it for its report and must never pay for the capability
 * probes, so they stay in `resolveSyncProvider`.
 */
function resolveProviderName(options = {}) {
  const { root } = resolvePaths(options.root);
  const config = options.config || readProjectConfig(root);
  const resolution = resolveScmProvider({ config, explicit: options.provider });

  if (resolution.disabled || resolution.provider === 'none') {
    throw new Error('SCM provider is disabled (none); set scmProvider to "github" or "azure-devops" in .sdw/config.json or pass --provider <github|azure-devops>.');
  }

  return resolution.provider;
}

/**
 * Resolves the registered provider and proves it can be used. Returns the
 * provider name and an instance; throws with the missing capability otherwise.
 */
function resolveSyncProvider(options = {}) {
  const providerName = resolveProviderName(options);
  const capability = checkScmCapability(providerName, options);
  if (!capability.installed) {
    throw new Error(`SCM provider CLI "${capability.bin}" is not installed or not found on PATH; ${providerName} sync needs it.`);
  }
  if (!capability.authenticated) {
    throw new Error(`SCM provider CLI "${capability.bin}" is not authenticated; run "${providerName === 'ado' ? 'az login' : 'gh auth login'}".`);
  }

  return {
    providerName,
    provider: options.scmProvider || createScmProvider(providerName, options)
  };
}

function readLocalSpecifications(options = {}) {
  const { specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(specsDir)) return [];

  const statusBySlug = new Map(
    readIndex({ root: options.root }).entries.map((entry) => [entry.slug, String(entry.status || 'pending').toLowerCase()])
  );

  const specs = [];
  for (const name of fs.readdirSync(specsDir).sort()) {
    if (!isSpecificationFile(name)) continue;
    const filePath = path.join(specsDir, name);
    if (!fs.statSync(filePath).isFile()) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    const slug = frontmatter.slug || path.basename(name, '.md');
    const prefixMatch = name.match(/^(\d{5})-/);
    specs.push({
      slug,
      localSpecId: prefixMatch ? prefixMatch[1] : '',
      title: frontmatter.title || slug,
      source: frontmatter.source || 'local',
      // The legacy `id` key stays readable as scmSpecId.
      scmSpecId: frontmatter.scmSpecId || frontmatter.id || null,
      registryStatus: statusBySlug.get(slug) || 'pending',
      filePath,
      content
    });
  }
  return specs;
}

// Both directions and the dry-run planner order specifications the same way.
function readSortedSpecifications(options = {}) {
  return readLocalSpecifications(options).sort(
    (left, right) => left.localSpecId.localeCompare(right.localSpecId) || left.slug.localeCompare(right.slug)
  );
}

function isSyncableSource(spec, providerSource) {
  return spec.source === 'local' || providerSourceName(spec.source) === providerSource;
}

// Writes the reported remote identity onto the created specification, so a
// second run updates instead of creating a duplicate.
function writeScmLink(spec, providerName, scmSpecId) {
  const content = fs.readFileSync(spec.filePath, 'utf8');
  const frontmatter = content.match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!frontmatter) return;

  let block = frontmatter[2];
  const setField = (key, value) => {
    const line = `${key}: ${value}`;
    const pattern = new RegExp(`^${key}:.*$`, 'm');
    block = pattern.test(block) ? block.replace(pattern, () => line) : `${block}\n${line}`;
  };
  setField('scmSpecId', JSON.stringify(String(scmSpecId)));
  setField('source', providerName);

  fs.writeFileSync(spec.filePath, `${frontmatter[1]}${block}${frontmatter[3]}${content.slice(frontmatter[0].length)}`, 'utf8');
}

/**
 * AC8: creates the local specification a remote item proves exists. The remote
 * id lands in the legacy `id` key that the current authoring validator still
 * requires; every reader already treats it as scmSpecId (AC18).
 */
function createLocalSpecification(item, providerSource, options = {}) {
  const { specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });

  const prefix = getNextPrefix(specsDir);
  const remoteId = String(item.id);
  const title = item.title || `Work Item ${remoteId}`;
  const source = providerSourceName(item.source || providerSource);
  const slug = `${prefix}-us-${remoteId}-${slugify(title)}`.slice(0, 45).replace(/-+$/, '');
  const content = synthesizeCanonicalSpec({
    id: remoteId,
    slug,
    title,
    source,
    description: item.description || `Imported remote item #${remoteId} from ${source}.`,
    acceptanceCriteria: item.acceptanceCriteria || [],
    isTracker: true
  });
  const filePath = path.join(specsDir, `${slug}.md`);
  fs.writeFileSync(filePath, content, 'utf8');

  registerSpec({
    prefix,
    slug,
    title,
    status: 'pending',
    source,
    specDate: new Date().toISOString().slice(0, 10),
    validation: 'PASS'
  }, options);

  return { prefix, slug, title, source, scmSpecId: remoteId, registryStatus: 'pending', filePath, content };
}

/**
 * AC1: mirrors local specifications to the registered provider. A specification
 * without a remote identity is created; one with an identity is updated.
 */
async function syncUp(options = {}) {
  const { providerName, provider } = resolveSyncProvider(options);
  const providerSource = providerSourceName(providerName);
  const specs = readSortedSpecifications(options);
  const transitions = [];

  for (const spec of specs) {
    if (!isSyncableSource(spec, providerSource)) {
      transitions.push({
        direction: 'sync-up',
        action: 'skipped',
        slug: spec.slug,
        id: spec.scmSpecId,
        from: spec.source,
        to: null,
        reason: `source "${spec.source}" is not the registered provider "${providerName}"`
      });
      continue;
    }

    const state = LOCAL_TO_REMOTE_STATE[spec.registryStatus] || 'open';
    // AC11: the issue body always starts with the slug marker.
    const body = issueBody(spec);
    if (!spec.scmSpecId) {
      const created = await provider.createWorkItem({ title: spec.title, body, state });
      writeScmLink(spec, providerSource, created.id);
      transitions.push({
        direction: 'sync-up',
        action: 'created',
        slug: spec.slug,
        id: created.id,
        from: null,
        to: created.state || state,
        reason: `created ${providerName} item ${created.id}`
      });
    } else {
      const updated = await provider.updateWorkItem({ id: spec.scmSpecId, title: spec.title, body, state });
      transitions.push({
        direction: 'sync-up',
        action: 'updated',
        slug: spec.slug,
        id: spec.scmSpecId,
        from: updated.from || null,
        to: updated.state || state,
        reason: `updated ${providerName} item ${spec.scmSpecId}`
      });
    }
  }

  return { direction: 'sync-up', provider: providerName, transitions };
}

/**
 * AC9: resolves the remote item to a local specification in the documented
 * order, scmSpecId (legacy id already folded in) then slug marker then exact
 * title. Marker and title only claim specifications that carry no remote
 * identity yet, so a linked row is never rebound to a different item.
 */
function matchLocalSpecification(item, indexes) {
  const byId = indexes.byScmSpecId.get(String(item.id));
  if (byId) return byId;

  const markerSlug = parseSlugMarker(item.description);
  const byMarker = markerSlug ? indexes.bySlug.get(markerSlug) : null;
  if (byMarker) return byMarker;

  return indexes.byTitle.get(normalizeTitle(item.title)) || null;
}

/**
 * AC2, AC8, AC9, AC10: mirrors remote tracker state into local specifications.
 * A remote item with no local match creates one carrying its scmSpecId and
 * source; a matched item updates its registry row from the remote state and a
 * closed remote item never regresses a completed row. A body disagreement is
 * reported as drift and neither body is written.
 */
async function syncDown(options = {}) {
  const { providerName, provider } = resolveSyncProvider(options);
  const providerSource = providerSourceName(providerName);
  const items = await provider.queryWorkItems({ state: options.state || 'all' });

  const byScmSpecId = new Map();
  const bySlug = new Map();
  const byTitle = new Map();
  for (const spec of readLocalSpecifications(options)) {
    if (spec.scmSpecId) {
      byScmSpecId.set(String(spec.scmSpecId), spec);
      continue;
    }
    bySlug.set(spec.slug, spec);
    const title = normalizeTitle(spec.title);
    if (!byTitle.has(title)) byTitle.set(title, spec);
  }

  const transitions = [];
  const drift = [];
  for (const item of items) {
    const spec = matchLocalSpecification(item, { byScmSpecId, bySlug, byTitle });
    if (!spec) {
      const created = createLocalSpecification(item, providerSource, options);
      // Keep the in-run index current so duplicate remote identities never
      // produce a second file in the same run.
      byScmSpecId.set(String(item.id), created);
      transitions.push({
        direction: 'sync-down',
        action: 'created',
        slug: created.slug,
        id: item.id,
        from: null,
        to: created.registryStatus,
        reason: `created local specification for ${providerName} item ${item.id}`
      });
      continue;
    }

    // AC10: body content is only ever reported. sync-down writes no body on
    // either side, so a disagreement leaves both bodies untouched.
    if (!bodiesAgree(spec.content, item.description)) {
      drift.push({
        direction: 'sync-down',
        action: 'drift',
        slug: spec.slug,
        id: item.id,
        from: spec.registryStatus,
        to: null,
        reason: 'remote body differs from the local specification; neither body changed'
      });
    }

    const nextStatus = REMOTE_TO_LOCAL_STATUS[String(item.state || '').toLowerCase()];
    if (!nextStatus) {
      transitions.push({
        direction: 'sync-down',
        action: 'skipped',
        slug: spec.slug,
        id: item.id,
        from: spec.registryStatus,
        to: null,
        reason: `remote state "${item.state}" maps to no registry status`
      });
      continue;
    }
    if (nextStatus === 'pending' && CLOSED_LOCAL_STATUSES.includes(spec.registryStatus)) {
      transitions.push({
        direction: 'sync-down',
        action: 'skipped',
        slug: spec.slug,
        id: item.id,
        from: spec.registryStatus,
        to: nextStatus,
        reason: `remote state "open" does not reopen a ${spec.registryStatus} row`
      });
      continue;
    }
    if (nextStatus === spec.registryStatus) {
      transitions.push({
        direction: 'sync-down',
        action: 'unchanged',
        slug: spec.slug,
        id: item.id,
        from: spec.registryStatus,
        to: nextStatus,
        reason: `already ${nextStatus}`
      });
      continue;
    }

    updateSpecStatus(spec.slug, nextStatus, { root: options.root });
    transitions.push({
      direction: 'sync-down',
      action: 'updated',
      slug: spec.slug,
      id: item.id,
      from: spec.registryStatus,
      to: nextStatus,
      reason: `${providerName} item ${item.id} is ${item.state}`
    });
  }

  return { direction: 'sync-down', provider: providerName, transitions, drift };
}

/**
 * AC12: the sync-up dry-run plan. Every fact comes from local files, so the
 * planner never constructs a provider or executes a provider command.
 */
function planSyncUp(options = {}) {
  const providerName = resolveProviderName(options);
  const providerSource = providerSourceName(providerName);
  const transitions = [];

  for (const spec of readSortedSpecifications(options)) {
    if (!isSyncableSource(spec, providerSource)) {
      transitions.push({
        direction: 'sync-up',
        action: 'skipped',
        slug: spec.slug,
        id: spec.scmSpecId,
        from: spec.source,
        to: null,
        reason: `source "${spec.source}" is not the registered provider "${providerName}"`
      });
      continue;
    }

    const state = LOCAL_TO_REMOTE_STATE[spec.registryStatus] || 'open';
    transitions.push({
      direction: 'sync-up',
      action: spec.scmSpecId ? 'update' : 'create',
      slug: spec.slug,
      id: spec.scmSpecId || null,
      from: spec.registryStatus,
      to: state,
      planned: true,
      reason: spec.scmSpecId
        ? `remote state ${state} for item ${spec.scmSpecId}`
        : `remote state ${state} for a new item`
    });
  }

  return { direction: 'sync-up', provider: providerName, dryRun: true, transitions };
}

/**
 * AC12: sync-down changes are driven by remote state, and a dry-run must not
 * contact the provider, so the plan names the linked rows a live run would
 * reconcile and states that no remote state was read.
 */
function planSyncDown(options = {}) {
  const providerName = resolveProviderName(options);
  const transitions = readSortedSpecifications(options)
    .filter((spec) => spec.scmSpecId)
    .map((spec) => ({
      direction: 'sync-down',
      action: 'reconcile',
      slug: spec.slug,
      id: spec.scmSpecId,
      from: spec.registryStatus,
      to: null,
      planned: true,
      reason: 'remote state is not queried under --dry-run'
    }));

  return { direction: 'sync-down', provider: providerName, dryRun: true, transitions };
}

function formatPlanTransition(transition) {
  const slug = transition.slug || `item ${transition.id}`;
  if (transition.action === 'create') {
    return `create issue for ${slug} (remote state ${transition.to})`;
  }
  if (transition.action === 'update') {
    return `update issue #${transition.id} for ${slug} (remote state ${transition.to})`;
  }
  if (transition.action === 'reconcile') {
    return `reconcile ${slug} (#${transition.id}): ${transition.reason}`;
  }
  return `skip ${slug}: ${transition.reason}`;
}

const DIRECTIONS = {
  'sync-up': syncUp,
  'sync-down': syncDown
};

function formatTransition(transition) {
  const subject = transition.slug || `item ${transition.id}`;
  const identity = transition.slug && transition.id ? ` (#${transition.id})` : '';
  const reason = transition.reason ? `: ${transition.reason}` : '';
  return `  * [${subject}] ${transition.action}${identity}${reason}`;
}

/**
 * CLI entry point: runs one direction, prints its report, and returns the exit
 * code the command propagates. Refusals and failures exit non-zero.
 */
async function runSyncDirection(direction, options = {}) {
  const runner = DIRECTIONS[direction];
  if (!runner) {
    console.error(`[sdw-spec] Unknown sync direction "${direction}".`);
    return 1;
  }

  try {
    if (options.dryRun) {
      const plan = direction === 'sync-up' ? planSyncUp(options) : planSyncDown(options);
      if (options.json) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log(`[${direction} dry-run] provider ${plan.provider}: ${plan.transitions.length} planned transition(s)`);
        plan.transitions.forEach((transition) => console.log(`[${direction} dry-run] ${formatPlanTransition(transition)}`));
        console.log(`[${direction} dry-run] no provider calls, no files modified`);
      }
      return 0;
    }

    const report = await runner(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[sdw-spec ${direction}] ${report.provider}: ${report.transitions.length} transition(s)`);
      report.transitions.forEach((transition) => console.log(formatTransition(transition)));
      if (report.drift && report.drift.length > 0) {
        console.log(`[sdw-spec ${direction}] body drift ${report.drift.length}:`);
        report.drift.forEach((entry) => console.log(formatTransition(entry)));
      }
    }
    return 0;
  } catch (err) {
    console.error(`[sdw-spec ${direction}] Error: ${err.message}`);
    return 1;
  }
}

module.exports = {
  LOCAL_TO_REMOTE_STATE,
  REMOTE_TO_LOCAL_STATUS,
  CLOSED_LOCAL_STATUSES,
  resolveSyncProvider,
  readLocalSpecifications,
  syncUp,
  syncDown,
  runSyncDirection
};
