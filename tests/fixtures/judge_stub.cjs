#!/usr/bin/env node
'use strict';

// Test judge stub: implements the `scoring.judgeCommand` contract used by
// Step 5 (Spec 027). It parses the acceptance criteria out of the judge prompt
// and writes a deterministic verdict.
//
// Usage: node judge_stub.cjs <promptFile> <verdictFile> [all|none|first|invalid]
// Modes may also be set via SDW_JUDGE_STUB_MODE.

const fs = require('fs');

const args = process.argv.slice(2);
const promptFile = args[0] || process.env.SDW_JUDGE_PROMPT;
const verdictFile = args[1] || process.env.SDW_JUDGE_VERDICT;
const mode = args[2] || process.env.SDW_JUDGE_STUB_MODE || 'all';

if (!promptFile || !verdictFile) {
  console.error('judge_stub: prompt file and verdict file are required');
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, 'utf8');
const ids = [...new Set([...prompt.matchAll(/^- (AC[1-9][0-9]*):/gm)].map(match => match[1]))];

if (mode === 'invalid') {
  fs.writeFileSync(verdictFile, JSON.stringify({ score: 'high', verdicts: [] }, null, 2), 'utf8');
  process.exit(0);
}

const verdicts = ids.map((id, index) => {
  let verified = true;
  if (mode === 'none') verified = false;
  else if (mode === 'first') verified = index === 0;
  return {
    id,
    verdict: verified ? 'verified' : 'failed',
    evidence: verified ? 'judge-stub: satisfied by the diff' : 'judge-stub: behaviour not present in the diff'
  };
});

const verifiedCount = verdicts.filter(item => item.verdict === 'verified').length;
const score = ids.length === 0 ? 0 : Math.round((verifiedCount / ids.length) * 10);

fs.writeFileSync(verdictFile, JSON.stringify({ score, verdicts, notes: `judge-stub:${mode}` }, null, 2), 'utf8');
process.exit(0);
