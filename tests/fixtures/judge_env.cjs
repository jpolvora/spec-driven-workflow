'use strict';

// Spec 027: Step 5 scoring is delegated to a judge. End-to-end tests that run
// past Step 4 wire this deterministic stub through SDW_JUDGE_COMMAND so the
// workflow runs unattended instead of pausing with exit code 5.

const path = require('path');

const JUDGE_STUB = path.resolve(__dirname, 'judge_stub.cjs');

function installJudgeEnv(mode = 'all') {
  process.env.SDW_JUDGE_COMMAND = `node "${JUDGE_STUB}" {promptFile} {verdictFile} ${mode}`;
  return process.env.SDW_JUDGE_COMMAND;
}

function clearJudgeEnv() {
  delete process.env.SDW_JUDGE_COMMAND;
}

module.exports = { JUDGE_STUB, installJudgeEnv, clearJudgeEnv };
