#!/usr/bin/env node
'use strict';

// Repository-root entry point for the sdw-changelog append helper.
// The canonical implementation ships with the skill.
const implementation = require('../skills/sdw-changelog/scripts/append_changelog.cjs');

if (require.main === module) {
  implementation.main(process.argv.slice(2));
}

module.exports = implementation;
