'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ScmProvider,
  assertSafeRef,
  htmlToMarkdown,
  assertResolutionComment,
  extractAcceptanceCriteria,
  cliFailure
} = require('./base.cjs');

// Spec 00062: Azure DevOps states are process-specific. `Closed` and `Done`
// both mean finished; every other work-item state is open. The mirroring
// contract speaks `open`/`closed`, so the adapter translates at the CLI edge.
function isAdoClosedState(state) {
  const norm = String(state || '').toLowerCase();
  return norm === 'closed' || norm === 'done';
}

function adoMirrorState(state) {
  return isAdoClosedState(state) ? 'closed' : 'open';
}

// Spec 00062 AC16: `all` is a mirroring scope, never a work-item state, so it
// must not become a WIQL equality. Open and closed also span the process
// template's terminal-state vocabulary.
function adoStateClause(state) {
  const norm = String(state === undefined || state === null ? 'all' : state).toLowerCase().trim();
  if (!norm || norm === 'all') return '';
  if (norm === 'closed') return "WHERE ([System.State] = 'Closed' OR [System.State] = 'Done')";
  if (norm === 'open') return "WHERE ([System.State] <> 'Closed' AND [System.State] <> 'Done')";
  return `WHERE [System.State] = '${String(state).replace(/[^a-zA-Z0-9_\s]/g, '')}'`;
}

// Azure DevOps stores System.Description as HTML. Encode line breaks as <br>
// so a multi-line Markdown body survives a single CLI argument and round-trips
// through fetchWorkItem's htmlToMarkdown.
function adoDescription(markdown) {
  return String(markdown)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

function quoteCliArgument(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

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
      const state = adoMirrorState(fields['System.State'] || 'New');
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
        const stateClause = adoStateClause(query.state);
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

  /**
   * Spec 00062: creates a tracker work item for a specification. Azure DevOps
   * starts every item in the process's initial state, so a finished
   * specification is moved to Closed after creation instead of being created
   * directly in a terminal state.
   */
  async createWorkItem(options = {}) {
    const { title, body = '', state = 'open', dryRun = false } = options;
    if (!title) {
      throw new Error('title is required for Azure DevOps createWorkItem.');
    }
    const cleanTitle = String(title).replace(/["`$\\]/g, '\\$&');
    const descriptionArg = body ? `--description ${quoteCliArgument(adoDescription(body))}` : '';

    if (dryRun) {
      return {
        id: null,
        url: null,
        state,
        dryRun: true,
        command: `az boards work-item create --title "${cleanTitle}" --type Issue ${descriptionArg}`.trim()
      };
    }

    try {
      const createCmd = `az boards work-item create --title "${cleanTitle}" --type Issue ${descriptionArg} --output json`.trim();
      const data = JSON.parse(this.executor(createCmd) || '{}');
      const id = String(data.id || '');
      if (!id) {
        throw new Error('az boards work-item create returned no work item id.');
      }

      let finalState = 'New';
      if (isAdoClosedState(state)) {
        this.executor(`az boards work-item update --id ${id} --state "Closed" --output json`);
        finalState = 'Closed';
      }

      return {
        id,
        url: data.url || (data._links && data._links.html && data._links.html.href) || '',
        state: finalState,
        dryRun: false
      };
    } catch (err) {
      throw cliFailure('Azure DevOps createWorkItem', err);
    }
  }

  /**
   * Spec 00062: writes the local title, body, and state onto an existing work
   * item. The current state is read first so a close or reopen is only issued
   * when the finished/open nature actually changes.
   */
  async updateWorkItem(options = {}) {
    const { id, title, body, state, dryRun = false } = options;
    if (!id || !/^\d+$/.test(String(id).trim())) {
      throw new Error(`Item identifier must be a valid numeric ID for Azure DevOps updateWorkItem: ${id}`);
    }
    const safeId = String(id).trim();
    const desiredClosed = state === undefined || state === null ? null : isAdoClosedState(state);

    if (dryRun) {
      return {
        id: safeId,
        url: null,
        from: null,
        state: state === undefined ? null : state,
        dryRun: true,
        command: `az boards work-item update --id ${safeId}`
      };
    }

    try {
      const current = await this.fetchWorkItem(safeId);
      const currentState = String(current.state || '').toLowerCase();
      const currentClosed = isAdoClosedState(currentState);

      const args = [`--id ${safeId}`];
      if (title) args.push(`--title ${quoteCliArgument(title)}`);
      if (body !== undefined && body !== null) args.push(`--description ${quoteCliArgument(adoDescription(body))}`);

      let nextState = current.state || null;
      if (desiredClosed !== null && desiredClosed !== currentClosed) {
        nextState = desiredClosed ? 'Closed' : 'New';
        args.push(`--state "${nextState}"`);
      }

      if (args.length > 1) {
        this.executor(`az boards work-item update ${args.join(' ')} --output json`);
      }

      return {
        id: safeId,
        url: current.url || null,
        from: current.state || null,
        state: nextState,
        dryRun: false
      };
    } catch (err) {
      throw cliFailure('Azure DevOps updateWorkItem', err);
    }
  }

  async findActivePullRequest(options = {}) {
    const { head, base } = options;
    if (!head) throw new Error('head branch is required for Azure DevOps findActivePullRequest.');
    assertSafeRef(head, 'head');
    if (base) assertSafeRef(base, 'base');

    const baseFlag = base ? `--target-branch "${base}"` : '';
    const checkCmd = `az repos pr list --source-branch "${head}" ${baseFlag} --status active --output json`;
    const stdout = this.executor(checkCmd);
    const existing = JSON.parse(stdout || '[]');
    if (Array.isArray(existing) && existing.length > 0) {
      const pr = existing[0];
      return {
        number: String(pr.pullRequestId || pr.id),
        url: pr.url || (pr._links && pr._links.web && pr._links.web.href) || '',
        head: pr.sourceRefName ? pr.sourceRefName.replace('refs/heads/', '') : head,
        base: pr.targetRefName ? pr.targetRefName.replace('refs/heads/', '') : (base || 'main'),
        title: pr.title || '',
        state: 'active'
      };
    }
    return null;
  }

  async createPullRequest(options = {}) {
    const { title, body = '', head, base, draft = false, dryRun = false, workItems = [] } = options;
    if (!title || !head) {
      throw new Error('title and head branch are required for Azure DevOps createPullRequest.');
    }
    assertSafeRef(head, 'head');
    if (base) assertSafeRef(base, 'base');

    try {
      const activePr = await this.findActivePullRequest({ head, base });
      if (activePr) {
        return {
          number: activePr.number,
          url: activePr.url,
          head: activePr.head,
          base: activePr.base,
          title: activePr.title || title,
          reused: true,
          dryRun: Boolean(dryRun)
        };
      }
    } catch (err) {
      if (!dryRun) {
        throw new Error(`Unable to verify existing pull request before creation: ${err.message}`);
      }
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
      const existingMatch = errMsg.match(/(?:existing pull request is|already exists[^\d]*)(\d+)/i);
      if (existingMatch) {
        const existingId = existingMatch[1];
        return {
          number: String(existingId),
          url: '',
          head,
          base: base || 'main',
          title,
          reused: true,
          dryRun: false
        };
      }
      throw new Error(`Azure DevOps SCM Provider failed to create PR: ${errMsg}`);
    } finally {
      if (tempBodyFile && fs.existsSync(tempBodyFile)) {
        try { fs.unlinkSync(tempBodyFile); } catch (e) {}
      }
    }
  }

  async updatePullRequest(options = {}) {
    const { prNumber, title, body, appendBody = true, dryRun = false } = options;
    if (!prNumber) {
      throw new Error('prNumber is required for Azure DevOps updatePullRequest.');
    }

    if (dryRun) {
      return {
        number: String(prNumber),
        updated: true,
        dryRun: true
      };
    }

    let finalBody = body;
    if (appendBody && body) {
      try {
        const viewCmd = `az repos pr show --id ${prNumber} --query description -o tsv`;
        const currentBody = (this.executor(viewCmd) || '').trim();
        if (currentBody && !currentBody.includes(body.trim())) {
          finalBody = `${currentBody}\n\n---\n\n${body.trim()}`;
        } else if (currentBody) {
          finalBody = currentBody;
        }
      } catch (e) {
        throw new Error(`Failed to read existing pull request #${prNumber} description for append: ${e.message}`);
      }
    }

    try {
      let descArg = '';
      if (finalBody) {
        const quoteArg = value => `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
        const bodyLines = String(finalBody).split(/\r?\n/);
        descArg = `--description ${bodyLines.map(quoteArg).join(' ')}`;
      }
      const titleArg = title ? `--title "${title.replace(/["`$\\]/g, '\\$&')}"` : '';
      if (descArg || titleArg) {
        this.executor(`az repos pr update --id ${prNumber} ${titleArg} ${descArg}`.trim());
      }
      return {
        number: String(prNumber),
        updated: true,
        dryRun: false
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`Azure DevOps SCM Provider failed to update PR: ${errMsg}`);
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
      throw cliFailure('Azure DevOps checkPrStatus', err);
    }
  }

  // Merge observation: an accepted merge command is not proof that the pull
  // request completed, so the caller re-reads the provider state.
  async isPullRequestMerged(prIdentifier) {
    if (!prIdentifier) return false;
    try {
      const status = String(this.executor(`az repos pr show --id ${prIdentifier} --query status -o tsv`) || '').trim();
      return status.toLowerCase() === 'completed';
    } catch (e) {
      return false;
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
      throw cliFailure('Azure DevOps listReviewThreads', err);
    }
  }

  async resolveReviewThread(options = {}) {
    const { prNumber, threadId, comment, model, dryRun = false } = options;
    assertResolutionComment(comment);
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
      throw cliFailure('Azure DevOps resolveReviewThread', err);
    } finally {
      if (tempFile && fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (e) {}
      }
    }
  }

  /**
   * Completes a pull request with the Azure CLI. Callers treat the outcome as
   * advisory: policies and permissions are outside this contract.
   */
  async mergePullRequest(options = {}) {
    const { prNumber, deleteSourceBranch = false, dryRun = false } = options;
    if (!prNumber) {
      throw new Error('prNumber is required to complete an Azure DevOps pull request.');
    }
    if (!/^\d+$/.test(String(prNumber))) {
      throw new Error(`prNumber must be numeric for Azure DevOps merge: ${prNumber}`);
    }
    if (dryRun) {
      return { merged: true, dryRun: true, prNumber: Number(prNumber) };
    }
    const deleteFlag = deleteSourceBranch ? ' --delete-source-branch true' : '';
    try {
      this.executor(`az repos pr update --id ${prNumber} --status completed${deleteFlag}`);
      return { merged: true, dryRun: false, prNumber: Number(prNumber) };
    } catch (err) {
      throw cliFailure('Azure DevOps mergePullRequest', err);
    }
  }
}

/**
 * Factory function to retrieve SCM provider instance
 */
module.exports = { AzureDevOpsProvider };
