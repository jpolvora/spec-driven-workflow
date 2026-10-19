const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function assertSafeRef(ref, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(String(ref)) || String(ref).includes('..')) {
    throw new Error(`Invalid ${label} branch name "${ref}".`);
  }
}

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

  async createPullRequest(options = {}) {
    throw new Error('createPullRequest must be implemented by provider.');
  }

  async createPr(options = {}) {
    return this.createPullRequest(options);
  }

  async listReviewThreads(prIdentifier) {
    throw new Error('listReviewThreads must be implemented by provider.');
  }

  async resolveReviewThread(options = {}) {
    throw new Error('resolveReviewThread must be implemented by provider.');
  }

  async checkPrStatus(prIdentifier) {
    throw new Error('checkPrStatus must be implemented by provider.');
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
    if (!itemId || !/^\d+$/.test(String(itemId).trim())) {
      throw new Error(`Item identifier must be a valid numeric ID for GitHub fetchWorkItem: ${itemId}`);
    }

    try {
      const safeId = String(itemId).trim();
      const cmd = `gh issue view ${safeId} --json number,title,body,url,state,labels`;
      const stdout = this.executor(cmd);
      const data = JSON.parse(stdout);

      const body = data.body || '';
      const acceptanceCriteria = extractAcceptanceCriteria(body);
      const labels = Array.isArray(data.labels) ? data.labels.map(l => (typeof l === 'string' ? l : l.name)) : [];

      return {
        id: String(data.number || safeId),
        title: data.title || '',
        description: body,
        acceptanceCriteria,
        source: 'github',
        url: data.url || `https://github.com/issues/${safeId}`,
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
      const stateFlag = query.state ? `--state ${String(query.state).replace(/[^a-zA-Z]/g, '')}` : '';
      const limit = query.limit && /^\d+$/.test(String(query.limit)) ? query.limit : 20;
      const limitFlag = `--limit ${limit}`;
      const cmd = `gh issue list ${stateFlag} ${limitFlag} --json number,title,body,url,state,labels`.trim().replace(/\s+/g, ' ');
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

  async createPullRequest(options = {}) {
    const { title, body = '', head, base, draft = false, dryRun = false } = options;
    if (!title || !head) {
      throw new Error('title and head branch are required for GitHub createPullRequest.');
    }
    assertSafeRef(head, 'head');
    if (base) assertSafeRef(base, 'base');

    let existing;
    try {
      const baseFlag = base ? `--base "${base}"` : '';
      const checkCmd = `gh pr list --head "${head}" ${baseFlag} --state open --json number,url,title,headRefName,baseRefName`;
      const stdout = this.executor(checkCmd);
      existing = JSON.parse(stdout || '[]');
    } catch (err) {
      if (dryRun) {
        existing = [];
      } else {
        throw new Error(`Unable to verify existing pull request before creation: ${err.message}`);
      }
    }

    if (Array.isArray(existing) && existing.length > 0) {
      const pr = existing[0];
      return {
        number: String(pr.number),
        url: pr.url,
        head: pr.headRefName || head,
        base: pr.baseRefName || (base || 'main'),
        title: pr.title || title,
        reused: true,
        dryRun: Boolean(dryRun)
      };
    }

    if (dryRun) {
      return {
        number: null,
        url: null,
        head,
        base: base || 'main',
        title,
        body,
        reused: false,
        dryRun: true,
        command: `gh pr create --head "${head}" ${base ? `--base "${base}"` : ''} --title "${title}"`
      };
    }

    let tempBodyFile = null;
    try {
      let bodyArg = '';
      if (body) {
        const tmpDir = os.tmpdir();
        tempBodyFile = path.join(tmpDir, `sdw-pr-body-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
        fs.writeFileSync(tempBodyFile, body, 'utf8');
        bodyArg = `--body-file "${tempBodyFile.replace(/\\/g, '/')}"`;
      }
      const baseArg = base ? `--base "${base}"` : '';
      const draftArg = draft ? '--draft' : '';
      const cleanTitle = title.replace(/["`$\\]/g, '\\$&');
      const cmd = `gh pr create --head "${head}" ${baseArg} --title "${cleanTitle}" ${bodyArg} ${draftArg}`.trim().replace(/\s+/g, ' ');
      const prUrl = this.executor(cmd).trim();

      const numMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNumber = numMatch ? numMatch[1] : null;

      return {
        number: prNumber ? String(prNumber) : null,
        url: prUrl,
        head,
        base: base || 'main',
        title,
        reused: false,
        dryRun: false
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub SCM Provider failed to create PR: ${errMsg}`);
    } finally {
      if (tempBodyFile && fs.existsSync(tempBodyFile)) {
        try { fs.unlinkSync(tempBodyFile); } catch (e) {}
      }
    }
  }

  async checkPrStatus(prIdentifier) {
    if (!prIdentifier) {
      throw new Error('prIdentifier is required for GitHub checkPrStatus.');
    }
    try {
      const cmd = `gh pr checks ${prIdentifier} --json name,state,bucket,link`;
      let stdout = '';
      try {
        stdout = this.executor(cmd);
      } catch (execErr) {
        // gh pr checks exits with 1 (failing) or 8 (pending), but still emits valid JSON on stdout.
        const output = execErr && execErr.stdout
          ? (typeof execErr.stdout === 'string' ? execErr.stdout : execErr.stdout.toString('utf8'))
          : '';
        const stderr = execErr && execErr.stderr
          ? (typeof execErr.stderr === 'string' ? execErr.stderr : execErr.stderr.toString('utf8'))
          : '';
        const message = execErr && execErr.message ? String(execErr.message) : '';
        if (output.trim()) {
          stdout = output;
        } else if (/no checks reported/i.test(stderr) || /no checks reported/i.test(message)) {
          // The branch has no check runs yet (for example between a push and workflow scheduling).
          stdout = '[]';
        } else {
          throw execErr;
        }
      }
      let checks = [];
      try {
        checks = JSON.parse(stdout || '[]');
      } catch (parseErr) {
        const lines = (stdout || '').split('\n').filter(l => l.trim());
        checks = lines.map(line => {
          const parts = line.split(/\s+/);
          return { name: parts[0] || 'check', state: parts[1] || 'unknown', bucket: parts[1] || 'unknown' };
        });
      }
      const pendingStates = new Set(['pending', 'in_progress', 'queued', 'waiting']);
      const failedStates = new Set([
        'fail',
        'failure',
        'cancelled',
        'cancel',
        'timed_out',
        'action_required',
        'startup_failure'
      ]);
      const checkState = c => String(c.state || '').toLowerCase();
      const checkBucket = c => String(c.bucket || '').toLowerCase();

      const pendingCount = checks.filter(c => pendingStates.has(checkState(c)) || pendingStates.has(checkBucket(c))).length;
      // A cancelled check is not a passing check: count it as failed so allPassed cannot become true.
      const failedCount = checks.filter(c => failedStates.has(checkState(c)) || failedStates.has(checkBucket(c))).length;
      const allPassed = checks.length > 0 && pendingCount === 0 && failedCount === 0;

      return {
        checks,
        allPassed,
        pendingCount,
        failedCount,
        completed: checks.length > 0 && pendingCount === 0
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub checkPrStatus failed: ${errMsg}`);
    }
  }

  async listReviewThreads(prIdentifier) {
    if (!prIdentifier) {
      throw new Error('prIdentifier is required for GitHub listReviewThreads.');
    }

    // Attempt GraphQL first for native threads and PRRT_ IDs
    try {
      const repoOut = this.executor('gh repo view --json owner,name');
      const repoData = JSON.parse(repoOut || '{}');
      const owner = repoData.owner ? (repoData.owner.login || repoData.owner) : null;
      const name = repoData.name;
      if (owner && name) {
        let tempGqlFile = null;
        try {
          const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 50) { nodes { id isResolved path line comments(first: 50) { nodes { id databaseId body author { login } createdAt } } } } } } }`;
          const payload = JSON.stringify({
            query,
            variables: {
              owner,
              name,
              number: Number(prIdentifier)
            }
          });
          const tmpDir = os.tmpdir();
          tempGqlFile = path.join(tmpDir, `sdw-gql-list-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
          fs.writeFileSync(tempGqlFile, payload, 'utf8');

          const stdout = this.executor(`gh api graphql --input "${tempGqlFile.replace(/\\/g, '/')}"`);
          const data = JSON.parse(stdout || '{}');
          const rawThreads = data.data && data.data.repository && data.data.repository.pullRequest && data.data.repository.pullRequest.reviewThreads && data.data.repository.pullRequest.reviewThreads.nodes;
          if (Array.isArray(rawThreads)) {
            const threads = rawThreads.map(t => {
              const comments = (t.comments && t.comments.nodes ? t.comments.nodes : []).map(c => ({
                id: String(c.id),
                databaseId: c.databaseId ? String(c.databaseId) : null,
                body: c.body || '',
                author: c.author ? c.author.login : 'unknown',
                createdAt: c.createdAt || ''
              }));
              // GitHub's isResolved is authoritative. A resolution reply marker does not
              // resolve the thread for branch protection, so it must not be treated as resolved.
              return {
                id: String(t.id),
                path: t.path,
                line: t.line,
                isResolved: Boolean(t.isResolved),
                comments
              };
            });
            return {
              threads,
              activeCount: threads.filter(t => !t.isResolved).length
            };
          }
        } finally {
          if (tempGqlFile && fs.existsSync(tempGqlFile)) {
            try { fs.unlinkSync(tempGqlFile); } catch (e) {}
          }
        }
      }
    } catch (gqlErr) {
      // Fallback to REST comments
    }

    try {
      const cmd = `gh api repos/:owner/:repo/pulls/${prIdentifier}/comments`;
      const stdout = this.executor(cmd);
      const comments = JSON.parse(stdout || '[]');
      
      const threadMap = new Map();
      for (const c of comments) {
        const threadId = c.in_reply_to_id ? String(c.in_reply_to_id) : String(c.id);
        if (!threadMap.has(threadId)) {
          threadMap.set(threadId, {
            id: threadId,
            path: c.path,
            line: c.line,
            isResolved: false,
            comments: []
          });
        }
        threadMap.get(threadId).comments.push({
          id: String(c.id),
          databaseId: String(c.id),
          body: c.body,
          author: c.user ? c.user.login : 'unknown',
          createdAt: c.created_at
        });
      }

      // REST comments do not expose review-thread resolution state. Keep them active so the
      // caller never reports convergence from a marker that branch protection does not honor.
      const threads = Array.from(threadMap.values());
      const activeCount = threads.filter(t => !t.isResolved).length;

      return {
        threads,
        activeCount
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub listReviewThreads failed: ${errMsg}`);
    }
  }

  async resolveReviewThread(options = {}) {
    const { prNumber, threadId, commentId, comment, model, dryRun = false } = options;
    if (!comment) {
      throw new Error('comment describing resolution is required for resolveReviewThread.');
    }

    if (dryRun) {
      return {
        resolved: true,
        dryRun: true,
        threadId: threadId || commentId,
        comment
      };
    }

    const note = model ? `${comment}\n\n---\nLLM model: ${model}` : comment;
    // Idempotent: cmdResolveThread already prefixes the marker, so only add it when absent.
    const bodyWithMarker = comment.includes('<!-- resolution-reply -->') ? note : `<!-- resolution-reply -->\n${note}`;

    try {
      if (threadId && String(threadId).startsWith('PRRT_')) {
        let tempGqlFile = null;
        try {
          const mutation = `mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }`;
          const payload = JSON.stringify({
            query: mutation,
            variables: {
              threadId: String(threadId),
              body: bodyWithMarker
            }
          });
          const tmpDir = os.tmpdir();
          tempGqlFile = path.join(tmpDir, `sdw-gql-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
          fs.writeFileSync(tempGqlFile, payload, 'utf8');

          const stdout = this.executor(`gh api graphql --input "${tempGqlFile.replace(/\\/g, '/')}"`);
          let response = {};
          try {
            response = JSON.parse(stdout || '{}');
          } catch (parseErr) {
            throw new Error(`GitHub resolveReviewThread returned invalid JSON: ${parseErr.message}`);
          }
          if (Array.isArray(response.errors) && response.errors.length > 0) {
            const messages = response.errors.map(e => (e && e.message) || JSON.stringify(e)).join('; ');
            throw new Error(`GraphQL mutation failed: ${messages}`);
          }
          const confirmed = response.data
            && response.data.resolveReviewThread
            && response.data.resolveReviewThread.thread
            && response.data.resolveReviewThread.thread.isResolved === true;
          if (!confirmed) {
            throw new Error('GitHub resolveReviewThread mutation did not confirm resolution.');
          }
          return {
            resolved: true,
            dryRun: false,
            threadId,
            comment: bodyWithMarker
          };
        } finally {
          if (tempGqlFile && fs.existsSync(tempGqlFile)) {
            try { fs.unlinkSync(tempGqlFile); } catch (e) {}
          }
        }
      }

      const targetId = commentId || threadId;
      if (!targetId || !prNumber) {
        throw new Error('prNumber and either threadId or commentId are required to reply/resolve.');
      }

      const cmd = `gh api repos/:owner/:repo/pulls/${prNumber}/comments/${targetId}/replies -f body="${bodyWithMarker.replace(/"/g, '\\"')}"`;
      this.executor(cmd);
      // A REST reply cannot resolve a GitHub review thread. Report the truth so the
      // convergence loop does not mark the PR as delivered while branch protection blocks it.
      return {
        resolved: false,
        dryRun: false,
        threadId: String(targetId),
        comment: bodyWithMarker,
        reason: 'GitHub REST replies cannot resolve a review thread; a PRRT_ thread id is required.'
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub resolveReviewThread failed: ${errMsg}`);
    }
  }
}

/**
 * Azure DevOps Provider Implementation
 */
class AzureDevOpsProvider extends ScmProvider {
  async fetchWorkItem(itemId) {
    if (!itemId || !/^\d+$/.test(String(itemId).trim())) {
      throw new Error(`Item identifier must be a valid numeric ID for Azure DevOps fetchWorkItem: ${itemId}`);
    }

    try {
      const safeId = String(itemId).trim();
      const cmd = `az boards work-item show --id ${safeId} --output json`;
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
        id: String(data.id || safeId),
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
        const stateClause = query.state ? `WHERE [System.State] = '${String(query.state).replace(/[^a-zA-Z0-9_\s]/g, '')}'` : '';
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

  async createPullRequest(options = {}) {
    const { title, body = '', head, base, draft = false, dryRun = false, workItems = [] } = options;
    if (!title || !head) {
      throw new Error('title and head branch are required for Azure DevOps createPullRequest.');
    }
    assertSafeRef(head, 'head');
    if (base) assertSafeRef(base, 'base');

    let existing;
    try {
      const baseFlag = base ? `--target-branch "${base}"` : '';
      const checkCmd = `az repos pr list --source-branch "${head}" ${baseFlag} --status active --output json`;
      const stdout = this.executor(checkCmd);
      existing = JSON.parse(stdout || '[]');
    } catch (err) {
      if (dryRun) {
        existing = [];
      } else {
        throw new Error(`Unable to verify existing pull request before creation: ${err.message}`);
      }
    }

    if (Array.isArray(existing) && existing.length > 0) {
      const pr = existing[0];
      return {
        number: String(pr.pullRequestId || pr.id),
        url: pr.url || (pr._links && pr._links.web && pr._links.web.href) || '',
        head: pr.sourceRefName ? pr.sourceRefName.replace('refs/heads/', '') : head,
        base: pr.targetRefName ? pr.targetRefName.replace('refs/heads/', '') : (base || 'main'),
        title: pr.title || title,
        reused: true,
        dryRun: Boolean(dryRun)
      };
    }

    if (dryRun) {
      return {
        number: null,
        url: null,
        head,
        base: base || 'main',
        title,
        body,
        reused: false,
        dryRun: true,
        command: `az repos pr create --source-branch "${head}" ${base ? `--target-branch "${base}"` : ''} --title "${title}"`
      };
    }

    let tempBodyFile = null;
    try {
      const baseArg = base ? `--target-branch "${base}"` : '';
      const draftArg = draft ? '--draft true' : '';
      const cleanTitle = title.replace(/["`$\\]/g, '\\$&');
      let descArg = '';
      if (body) {
        // `az repos pr create --description` takes literal values and does not expand `@file`.
        // Pass each body line as its own quoted argument; Azure CLI joins them with newlines.
        const quoteArg = value => `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
        const bodyLines = String(body).split(/\r?\n/);
        descArg = `--description ${bodyLines.map(quoteArg).join(' ')}`;
      }
      const validWorkItems = Array.isArray(workItems)
        ? workItems.map(id => String(id).trim()).filter(id => /^\d+$/.test(id))
        : [];
      const workItemsArg = validWorkItems.length > 0 ? `--work-items ${validWorkItems.join(' ')}` : '';
      const cmd = `az repos pr create --source-branch "${head}" ${baseArg} --title "${cleanTitle}" ${descArg} ${draftArg} ${workItemsArg} --output json`.trim().replace(/\s+/g, ' ');
      const stdout = this.executor(cmd);
      const data = JSON.parse(stdout);

      return {
        number: String(data.pullRequestId || data.id),
        url: data.url || (data._links && data._links.web && data._links.web.href) || '',
        head,
        base: base || 'main',
        title,
        reused: false,
        dryRun: false
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`Azure DevOps SCM Provider failed to create PR: ${errMsg}`);
    } finally {
      if (tempBodyFile && fs.existsSync(tempBodyFile)) {
        try { fs.unlinkSync(tempBodyFile); } catch (e) {}
      }
    }
  }

  async checkPrStatus(prIdentifier) {
    if (!prIdentifier) {
      throw new Error('prIdentifier is required for Azure DevOps checkPrStatus.');
    }
    try {
      const cmd = `az repos pr policy list --id ${prIdentifier} --output json`;
      const stdout = this.executor(cmd);
      let policies = [];
      try {
        policies = JSON.parse(stdout || '[]');
      } catch (e) {
        policies = [];
      }

      const pendingCount = policies.filter(p => {
        const s = String(p.status || '').toLowerCase();
        return s === 'running' || s === 'queued' || s === 'in_progress';
      }).length;

      const failedCount = policies.filter(p => {
        const s = String(p.status || '').toLowerCase();
        return s === 'rejected' || s === 'broken' || s === 'failed';
      }).length;

      let allPassed = policies.length > 0 && pendingCount === 0 && failedCount === 0;

      // If no explicit policies, verify PR is active
      if (policies.length === 0) {
        try {
          const showCmd = `az repos pr show --id ${prIdentifier} --output json`;
          const showStdout = this.executor(showCmd);
          const prData = JSON.parse(showStdout || '{}');
          const status = String(prData.status || '').toLowerCase();
          allPassed = status === 'active';
        } catch (e) {
          throw new Error(`Azure DevOps checkPrStatus could not verify PR ${prIdentifier}: ${e.message}`);
        }
      }

      return {
        checks: policies.map(p => ({
          name: (p.configuration && p.configuration.type && p.configuration.type.displayName) || String(p.id || 'policy'),
          state: p.status || 'unknown',
          status: p.status || 'unknown'
        })),
        allPassed,
        pendingCount,
        failedCount,
        completed: pendingCount === 0
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`Azure DevOps checkPrStatus failed: ${errMsg}`);
    }
  }

  async listReviewThreads(prIdentifier) {
    if (!prIdentifier) {
      throw new Error('prIdentifier is required for Azure DevOps listReviewThreads.');
    }
    try {
      const cmd = `az devops invoke --area git --resource pullRequestThreads --route-parameters pullRequestId=${prIdentifier} --http-method GET -o json`;
      const stdout = this.executor(cmd);
      const res = JSON.parse(stdout || '{"value":[]}');
      const rawThreads = Array.isArray(res) ? res : (res.value || []);

      const threads = rawThreads.map(t => {
        const status = String(t.status || 'active').toLowerCase();
        const comments = (t.comments || []).map(c => ({
          id: String(c.id),
          databaseId: String(c.id),
          body: c.content || '',
          author: (c.author && (c.author.displayName || c.author.uniqueName)) || 'unknown',
          createdAt: c.publishedDate || ''
        }));
        // Azure DevOps thread status is authoritative. A resolution reply marker must not
        // hide an active thread that branch policy still blocks.
        const isResolved = status === 'fixed' || status === 'closed' || status === 'bydesign' || status === 'wontfix';

        return {
          id: String(t.id),
          status: t.status,
          isResolved,
          comments
        };
      });

      const activeCount = threads.filter(t => !t.isResolved).length;
      return {
        threads,
        activeCount
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`Azure DevOps listReviewThreads failed: ${errMsg}`);
    }
  }

  async resolveReviewThread(options = {}) {
    const { prNumber, threadId, comment, model, dryRun = false } = options;
    if (!comment) {
      throw new Error('comment describing resolution is required for resolveReviewThread.');
    }
    if (!threadId || !prNumber) {
      throw new Error('prNumber and threadId are required for Azure DevOps resolveReviewThread.');
    }

    if (dryRun) {
      return {
        resolved: true,
        dryRun: true,
        threadId: String(threadId),
        comment
      };
    }

    const note = model ? `${comment}\n\n---\nLLM model: ${model}` : comment;
    const bodyWithMarker = `<!-- resolution-reply -->\n${note}`;

    let tempFile = null;
    try {
      // 1. Add reply comment to the review thread
      const commentPayload = JSON.stringify({
        content: bodyWithMarker,
        parentCommentId: 1,
        commentType: 1
      });
      const tmpDir = os.tmpdir();
      tempFile = path.join(tmpDir, `sdw-ado-thread-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(tempFile, commentPayload, 'utf8');

      const addCommentCmd = `az devops invoke --area git --resource pullRequestThreadComments --route-parameters pullRequestId=${prNumber} threadId=${threadId} --http-method POST --in-file "${tempFile.replace(/\\/g, '/')}" -o json`;
      this.executor(addCommentCmd);

      // 2. Update thread status to 'fixed' (code 2 in ADO: 1=active, 2=fixed, 3=wontFix, 4=closed)
      const threadPatchPayload = JSON.stringify({
        status: 2
      });
      fs.writeFileSync(tempFile, threadPatchPayload, 'utf8');
      const updateThreadCmd = `az devops invoke --area git --resource pullRequestThreads --route-parameters pullRequestId=${prNumber} threadId=${threadId} --http-method PATCH --in-file "${tempFile.replace(/\\/g, '/')}" -o json`;
      this.executor(updateThreadCmd);

      return {
        resolved: true,
        dryRun: false,
        threadId: String(threadId),
        comment: bodyWithMarker
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`Azure DevOps resolveReviewThread failed: ${errMsg}`);
    } finally {
      if (tempFile && fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (e) {}
      }
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

