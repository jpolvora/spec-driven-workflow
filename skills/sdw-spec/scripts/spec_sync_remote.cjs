'use strict';

/**
 * Spec 00062: the two remote mirroring directions.
 *
 * `sync-up` pushes local specifications to the registered SCM provider and
 * `sync-down` pulls remote tracker state back into the local registry. Both
 * refuse to run without a registered, installed, and authenticated provider, so
 * the refusal always precedes any provider call or local write.
 */

const fs = require('fs');
const path = require('path');

const {
  resolvePaths,
  readIndex,
  parseFrontmatter,
  isSpecificationFile,
  updateSpecStatus
} = require('./spec_index.cjs');
const {
  createScmProvider,
  resolveScmProvider,
  checkScmCapability
} = require('./scm_provider_contract.cjs');

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
 * Resolves the registered provider and proves it can be used. Returns the
 * provider name and an instance; throws with the missing capability otherwise.
 */
function resolveSyncProvider(options = {}) {
  const { root } = resolvePaths(options.root);
  const config = options.config || readProjectConfig(root);
  const resolution = resolveScmProvider({ config, explicit: options.provider });

  if (resolution.disabled || resolution.provider === 'none') {
    throw new Error('SCM provider is disabled (none); set scmProvider to "github" or "azure-devops" in .sdw/config.json or pass --provider <github|azure-devops>.');
  }

  const capability = checkScmCapability(resolution.provider, options);
  if (!capability.installed) {
    throw new Error(`SCM provider CLI "${capability.bin}" is not installed or not found on PATH; ${resolution.provider} sync needs it.`);
  }
  if (!capability.authenticated) {
    throw new Error(`SCM provider CLI "${capability.bin}" is not authenticated; run "${resolution.provider === 'ado' ? 'az login' : 'gh auth login'}".`);
  }

  return {
    providerName: resolution.provider,
    provider: options.scmProvider || createScmProvider(resolution.provider, options)
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
 * AC1: mirrors local specifications to the registered provider. A specification
 * without a remote identity is created; one with an identity is updated.
 */
async function syncUp(options = {}) {
  const { providerName, provider } = resolveSyncProvider(options);
  const specs = readLocalSpecifications(options)
    .sort((left, right) => left.localSpecId.localeCompare(right.localSpecId) || left.slug.localeCompare(right.slug));
  const transitions = [];

  for (const spec of specs) {
    if (spec.source !== 'local' && spec.source !== providerName) {
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
    if (!spec.scmSpecId) {
      const created = await provider.createWorkItem({ title: spec.title, body: spec.content, state });
      writeScmLink(spec, providerName, created.id);
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
      const updated = await provider.updateWorkItem({ id: spec.scmSpecId, title: spec.title, body: spec.content, state });
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
 * AC2: mirrors remote tracker state into local specifications. Unmatched remote
 * items are reported, never written; a closed remote item never regresses.
 */
async function syncDown(options = {}) {
  const { providerName, provider } = resolveSyncProvider(options);
  const items = await provider.queryWorkItems({ state: options.state || 'all' });

  const byScmSpecId = new Map();
  for (const spec of readLocalSpecifications(options)) {
    if (spec.scmSpecId) byScmSpecId.set(String(spec.scmSpecId), spec);
  }

  const transitions = [];
  for (const item of items) {
    const spec = byScmSpecId.get(String(item.id));
    if (!spec) {
      transitions.push({
        direction: 'sync-down',
        action: 'unmatched',
        slug: null,
        id: item.id,
        from: null,
        to: item.state || null,
        reason: `no local specification matches ${providerName} item ${item.id}`
      });
      continue;
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

  return { direction: 'sync-down', provider: providerName, transitions };
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
  if (options.dryRun) {
    // The dry-run planner is owned by the next slice; refusing keeps this
    // command from writing while that planner is absent.
    console.error(`[sdw-spec ${direction}] Error: --dry-run is not wired for this direction yet.`);
    return 1;
  }

  try {
    const report = await runner(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[sdw-spec ${direction}] ${report.provider}: ${report.transitions.length} transition(s)`);
      report.transitions.forEach((transition) => console.log(formatTransition(transition)));
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
