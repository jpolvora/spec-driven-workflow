'use strict';

const { execSync } = require('child_process');

/**
 * Base SCM Provider Contract
 */
class ScmProvider {
  constructor(options = {}) {
    this.options = options;
    this.executor = options.executor || this.defaultExecutor.bind(this);
  }

  defaultExecutor(command, execOptions = {}) {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...execOptions
    });
  }

  async fetchWorkItem(itemId) {
    throw new Error('fetchWorkItem must be implemented by provider.');
  }

  async queryWorkItems(query) {
    throw new Error('queryWorkItems must be implemented by provider.');
  }
}

/**
 * Helper to strip HTML tags and normalize whitespace
 */
function htmlToMarkdown(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * Helper to extract acceptance criteria from description or raw text
 */
function extractAcceptanceCriteria(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const acs = [];

  let inAcSection = false;
  for (const line of lines) {
    if (/^#+\s*acceptance\s*criteria\b/i.test(line)) {
      inAcSection = true;
      continue;
    }
    if (inAcSection && /^#+\s+[a-z0-9]/i.test(line)) {
      inAcSection = false;
    }

    if (inAcSection || /^-?\s*\[[ xX]\]\s*/.test(line) || /^-\s*AC\d+:\s*/i.test(line)) {
      const cleaned = line
        .replace(/^-\s*\[[ xX]\]\s*/, '')
        .replace(/^-\s*AC\d+:\s*/i, '')
        .replace(/^[-*+]\s+/, '')
        .trim();
      if (cleaned) {
        acs.push(cleaned);
      }
    }
  }

  return acs;
}

/**
 * GitHub Provider Implementation
 */
class GitHubProvider extends ScmProvider {
  async fetchWorkItem(itemId) {
    if (!itemId) {
      throw new Error('Item identifier is required for GitHub fetchWorkItem.');
    }

    try {
      const cmd = `gh issue view ${itemId} --json number,title,body,url,state,labels`;
      const stdout = this.executor(cmd);
      const data = JSON.parse(stdout);

      const body = data.body || '';
      const acceptanceCriteria = extractAcceptanceCriteria(body);
      const labels = Array.isArray(data.labels) ? data.labels.map(l => (typeof l === 'string' ? l : l.name)) : [];

      return {
        id: String(data.number || itemId),
        title: data.title || '',
        description: body,
        acceptanceCriteria,
        source: 'github',
        url: data.url || `https://github.com/issues/${itemId}`,
        state: (data.state || 'open').toLowerCase(),
        tags: labels
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub SCM Provider failed to retrieve issue #${itemId}: ${errMsg}`);
    }
  }

  async queryWorkItems(query = {}) {
    try {
      const stateFlag = query.state ? `--state ${query.state}` : '';
      const limitFlag = query.limit ? `--limit ${query.limit}` : '--limit 20';
      const cmd = `gh issue list ${stateFlag} ${limitFlag} --json number,title,body,url,state,labels`;
      const stdout = this.executor(cmd);
      const items = JSON.parse(stdout);

      return items.map(data => {
        const body = data.body || '';
        return {
          id: String(data.number),
          title: data.title || '',
          description: body,
          acceptanceCriteria: extractAcceptanceCriteria(body),
          source: 'github',
          url: data.url || '',
          state: (data.state || 'open').toLowerCase(),
          tags: Array.isArray(data.labels) ? data.labels.map(l => (typeof l === 'string' ? l : l.name)) : []
        };
      });
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub SCM Provider failed to query issues: ${errMsg}`);
    }
  }
}

/**
 * Azure DevOps Provider Implementation
 */
class AzureDevOpsProvider extends ScmProvider {
  async fetchWorkItem(itemId) {
    if (!itemId) {
      throw new Error('Item identifier is required for Azure DevOps fetchWorkItem.');
    }

    try {
      const cmd = `az boards work-item show --id ${itemId} --output json`;
      const stdout = this.executor(cmd);
      const data = JSON.parse(stdout);
      const fields = data.fields || {};

      const title = fields['System.Title'] || '';
      const rawDesc = fields['System.Description'] || '';
      const rawAc = fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
      const state = (fields['System.State'] || 'New').toLowerCase();
      const rawTags = fields['System.Tags'] || '';

      const description = htmlToMarkdown(rawDesc);
      const acFromField = htmlToMarkdown(rawAc);
      let acceptanceCriteria = extractAcceptanceCriteria(acFromField);
      if (acceptanceCriteria.length === 0 && acFromField) {
        acceptanceCriteria = acFromField.split('\n').map(l => l.replace(/^[-*+]\s+/, '').trim()).filter(Boolean);
      }
      if (acceptanceCriteria.length === 0) {
        acceptanceCriteria = extractAcceptanceCriteria(description);
      }

      const tags = rawTags.split(';').map(t => t.trim()).filter(Boolean);

      return {
        id: String(data.id || itemId),
        title,
        description,
        acceptanceCriteria,
        source: 'azure-devops',
        url: data.url || (data._links && data._links.html && data._links.html.href) || '',
        state,
        tags
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`Azure DevOps SCM Provider failed to retrieve work item #${itemId}: ${errMsg}`);
    }
  }

  async queryWorkItems(query = {}) {
    try {
      let wiql = query.wiql;
      if (!wiql) {
        const stateClause = query.state ? `WHERE [System.State] = '${query.state}'` : '';
        wiql = `SELECT [System.Id], [System.Title], [System.State] FROM WorkItems ${stateClause} ORDER BY [System.Id] DESC`;
      }
      const cmd = `az boards query --wiql "${wiql.replace(/"/g, '\\"')}" --output json`;
      const stdout = this.executor(cmd);
      const items = JSON.parse(stdout);

      const results = [];
      for (const item of items) {
        const fullItem = await this.fetchWorkItem(item.id);
        results.push(fullItem);
      }
      return results;
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`Azure DevOps SCM Provider failed to query work items: ${errMsg}`);
    }
  }
}

/**
 * Factory function to retrieve SCM provider instance
 */
function createScmProvider(providerName, options = {}) {
  const norm = String(providerName || '').toLowerCase().trim();
  if (norm === 'github' || norm === 'gh') {
    return new GitHubProvider(options);
  }
  if (norm === 'azure-devops' || norm === 'ado' || norm === 'azure_devops' || norm === 'az') {
    return new AzureDevOpsProvider(options);
  }
  throw new Error(`Unsupported SCM provider: "${providerName}". Supported providers are 'github' and 'azure-devops'.`);
}

/**
 * Resolves SCM provider from explicit options or workspace configuration (AC1, AC7, AC8)
 */
function resolveScmProvider({ config, explicit } = {}) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const norm = String(explicit).toLowerCase().trim();
    if (norm === 'github' || norm === 'gh') {
      return { provider: 'github', name: 'github', resolvedFrom: 'explicit', disabled: false };
    }
    if (norm === 'ado' || norm === 'azure-devops' || norm === 'azure_devops' || norm === 'az') {
      return { provider: 'ado', name: 'ado', resolvedFrom: 'explicit', disabled: false };
    }
    if (norm === 'none') {
      return { provider: 'none', name: 'none', resolvedFrom: 'explicit', disabled: true };
    }
    throw new Error(`Invalid SCM provider "${explicit}". Allowed values are 'none', 'ado', 'github'.`);
  }

  if (config && config.scmProvider !== undefined && config.scmProvider !== null) {
    const norm = String(config.scmProvider).toLowerCase().trim();
    if (norm === 'github' || norm === 'ado' || norm === 'none') {
      return { provider: norm, name: norm, resolvedFrom: 'config', disabled: norm === 'none' };
    }
    throw new Error(`Invalid SCM provider "${config.scmProvider}". Allowed values are 'none', 'ado', 'github'.`);
  }

  return { provider: 'none', name: 'none', resolvedFrom: 'default', disabled: true };
}

/**
 * Checks CLI presence and authentication for the configured SCM provider (AC10, AC11, AC16)
 */
function checkScmCapability(providerName, options = {}) {
  const norm = String(providerName || '').toLowerCase().trim();
  if (norm === 'none') {
    return { provider: 'none', bin: null, installed: false, authenticated: false, available: false, error: null, reason: 'SCM provider is disabled (none)' };
  }

  const bin = (norm === 'github' || norm === 'gh') ? 'gh' : ((norm === 'ado' || norm === 'az' || norm === 'azure-devops' || norm === 'azure_devops') ? 'az' : null);
  if (!bin) {
    return { provider: norm, bin: null, installed: false, authenticated: false, available: false, error: `Unsupported SCM provider "${providerName}".` };
  }

  const executor = options.executor || ((cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

  let installed = false;
  try {
    const probeCmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    const out = executor(probeCmd);
    installed = Boolean(out && out.trim());
  } catch (e) {
    installed = false;
  }

  if (!installed) {
    return {
      provider: norm,
      bin,
      installed: false,
      authenticated: false,
      available: false,
      error: `CLI "${bin}" is not installed or not found on PATH.`
    };
  }

  let authenticated = false;
  try {
    const authCmd = bin === 'gh' ? 'gh auth status' : 'az account show';
    executor(authCmd);
    authenticated = true;
  } catch (e) {
    authenticated = false;
  }

  return {
    provider: norm,
    bin,
    installed: true,
    authenticated,
    available: authenticated,
    error: authenticated ? null : `CLI "${bin}" is not authenticated. Please run "${bin === 'gh' ? 'gh auth login' : 'az login'}".`
  };
}

module.exports = {
  ScmProvider,
  GitHubProvider,
  AzureDevOpsProvider,
  createScmProvider,
  resolveScmProvider,
  checkScmCapability,
  extractAcceptanceCriteria,
  htmlToMarkdown
};

