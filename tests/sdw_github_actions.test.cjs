'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const githubDir = path.join(repoRoot, '.github');
const workflowsDir = path.join(githubDir, 'workflows');

const ciYmlPath = path.join(workflowsDir, 'ci.yml');
const reviewYmlPath = path.join(workflowsDir, 'agentic-code-review.yml');
const releaseYmlPath = path.join(workflowsDir, 'release.yml');
const promptMdPath = path.join(githubDir, 'agentic-code-reviewers-prompt.md');
const readmeMdPath = path.join(githubDir, 'README.md');

test('AC1 & AC15: GitHub Actions workflow files exist and use official actions only', () => {
  assert.ok(fs.existsSync(ciYmlPath), 'ci.yml must exist');
  assert.ok(fs.existsSync(reviewYmlPath), 'agentic-code-review.yml must exist');
  assert.ok(fs.existsSync(releaseYmlPath), 'release.yml must exist');

  const files = [ciYmlPath, reviewYmlPath, releaseYmlPath];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const actionUses = content.match(/uses:\s*([^\s]+)/g) || [];
    for (const useLine of actionUses) {
      const actionName = useLine.replace(/uses:\s*/, '').trim();
      assert.ok(
        actionName.startsWith('actions/checkout') ||
        actionName.startsWith('actions/setup-node') ||
        actionName.startsWith('actions/upload-artifact') ||
        actionName.startsWith('actions/download-artifact'),
        `Workflow ${path.basename(file)} must only use official GitHub actions, found: ${actionName}`
      );
    }
  }
});

test('AC2, AC3, AC4 & AC5: Continuous Integration workflow specification (ci.yml)', () => {
  const content = fs.readFileSync(ciYmlPath, 'utf8');

  // AC2: Pull request triggers and authoring mode validation
  assert.ok(content.includes('pull_request:'), 'Must trigger on pull_request');
  assert.ok(content.includes('opened') && content.includes('synchronize') && content.includes('reopened'), 'Must trigger on PR opened, synchronize, reopened');
  assert.ok(content.includes('--mode=authoring'), 'Must validate specs in authoring mode');
  assert.ok(content.includes('.sdw/specs'), 'Must target .sdw/specs');

  // AC3: Unit test execution
  assert.ok(content.includes('npm test'), 'Must execute npm test');

  // AC4: Packaging verification execution guarded by script presence
  assert.ok(content.includes('scripts/verify_skills.cjs'), 'Must reference packaging verification script');

  // AC5: Node.js 22 runtime
  assert.ok(content.includes('node-version: 22') || content.includes('node-version: "22"'), 'Must specify Node.js 22');
});

test('AC6, AC7, AC8, AC9, AC10, AC16, AC17 & AC20: Agentic Code Review workflow', () => {
  const content = fs.readFileSync(reviewYmlPath, 'utf8');

  // AC6: Agentic reviewer execution
  assert.ok(content.includes('agentic-code-reviewers'), 'Must invoke agentic code reviewer');

  // AC7: Variables with documented fallback defaults
  assert.ok(content.includes('vars.SDW_CODE_REVIEW_ENGINE'), 'Must check SDW_CODE_REVIEW_ENGINE');
  assert.ok(content.includes("'opencode'"), 'Default engine must be opencode');
  assert.ok(content.includes('vars.SDW_CODE_REVIEW_MODEL'), 'Must check SDW_CODE_REVIEW_MODEL');
  assert.ok(content.includes("'opencode-go/deepseek-v4.1-flash'"), 'Default model must be opencode-go/deepseek-v4.1-flash');
  assert.ok(content.includes('vars.SDW_CODE_REVIEW_VARIANT'), 'Must check SDW_CODE_REVIEW_VARIANT');
  assert.ok(content.includes("'medium'"), 'Default variant must be medium');

  // AC8 & AC20: Credential check, skip notice and fork safety
  assert.ok(content.includes('Review skipped: no OPENCODE_API_KEY or CURSOR_API_KEY secret configured'), 'Must emit standardized skip notice');

  // AC9: Unresolved thread blocking
  assert.ok(content.includes('reviewThreads'), 'Must query reviewThreads via GraphQL');
  assert.ok(content.includes('isResolved == false and .isOutdated == false'), 'Must filter unresolved and non-outdated threads');
  assert.ok(content.includes('unresolved review thread(s)'), 'Must block merge with actionable error when threads exist');

  // AC10: Review prompt asset usage
  assert.ok(content.includes('--stack Custom'), 'Must use Custom stack');
  assert.ok(content.includes('--custom-prompt .github/agentic-code-reviewers-prompt.md'), 'Must pass review prompt asset');

  // AC16: Minimal permissions
  assert.ok(content.includes('contents: read'), 'Must request contents: read');
  assert.ok(content.includes('pull-requests: write'), 'Must request pull-requests: write');

  // AC17: Manual PR dispatch resolution
  assert.ok(content.includes('workflow_dispatch:'), 'Must support workflow_dispatch');
  assert.ok(content.includes('gh pr view'), 'Must resolve PR metadata using gh CLI');
});

test('AC11: Review prompt asset encoding SDW conformance checks', () => {
  assert.ok(fs.existsSync(promptMdPath), 'Prompt markdown file must exist');
  const content = fs.readFileSync(promptMdPath, 'utf8');

  // Architectural rules
  assert.ok(content.includes('Agent and Harness Agnosticism'), 'Must check agent agnosticism');
  assert.ok(content.includes('Zero External Runtime Dependencies'), 'Must check zero external dependencies');
  assert.ok(content.includes('Breaking Changes Encouraged'), 'Must check breaking changes policy');
  assert.ok(content.includes('No Unrequested Version Control Operations'), 'Must check version control operations safety');

  // Skill line budget & 3-tier standard
  assert.ok(content.includes('~120 lines') || content.includes('120 lines'), 'Must enforce Tier 1 line budget');
  assert.ok(content.includes('Done when:'), 'Must check Done when gates');

  // EARS acceptance criteria syntax
  assert.ok(content.includes('EARS'), 'Must enforce EARS acceptance criteria syntax');

  // Score threshold
  assert.ok(content.includes('score_min: 5') || content.includes('>= 5'), 'Must enforce score threshold >= 5');
});

test('AC12, AC13, AC14 & AC18: Release and distribution workflow', () => {
  const content = fs.readFileSync(releaseYmlPath, 'utf8');

  // AC12: Trigger on v*.*.* tags
  assert.ok(content.includes("'v*.*.*'"), 'Must trigger on semantic version tags');
  assert.ok(content.includes('--mode=authoring'), 'Must validate specifications');
  assert.ok(content.includes('npm test'), 'Must execute unit test suite');
  assert.ok(content.includes('scripts/verify_skills.cjs'), 'Must check packaging verification');

  // AC13: Manual dispatch with verify_only option
  assert.ok(content.includes('workflow_dispatch:'), 'Must support manual dispatch');
  assert.ok(content.includes('verify_only'), 'Must provide verify_only input');

  // AC18: Distribution via npx skills without build artifacts
  assert.ok(content.includes('gh release create'), 'Must create GitHub release');
  assert.ok(!content.includes('upload-artifact') || !content.includes('dist/'), 'Must not publish build artifacts for npx skills distribution');
});

test('AC19: Documentation asset (.github/README.md)', () => {
  assert.ok(fs.existsSync(readmeMdPath), 'README.md must exist in .github/');
  const content = fs.readFileSync(readmeMdPath, 'utf8');

  assert.ok(content.includes('ci.yml'), 'Must document ci.yml');
  assert.ok(content.includes('agentic-code-review.yml'), 'Must document agentic-code-review.yml');
  assert.ok(content.includes('release.yml'), 'Must document release.yml');
  assert.ok(content.includes('SDW_CODE_REVIEW_ENGINE'), 'Must document review engine variable');
  assert.ok(content.includes('OPENCODE_API_KEY') && content.includes('CURSOR_API_KEY'), 'Must document required secrets');
  assert.ok(content.includes('Branch Protection'), 'Must document branch protection recommendations');
  assert.ok(content.includes('npx skills'), 'Must document skills distribution via npx skills');
});
