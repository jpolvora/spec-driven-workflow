# Changelog

### [2026-10-21 19:53] Agent: agent
- **Prompt**: Run spec 044: add .gitattributes and per-task checkpoint save in sdw-orch DAG
- **Done**: Added repo-root .gitattributes with text=auto and eol=lf pins, normalized the worktree to zero w/mixed, added a per-task scoped checkpoint commit plus sdw-checkpoint-{runId}-{taskId} tag on accepted task finish with --no-task-checkpoint opt-out, gated the save behind the pre-commit secret scan over the correct tree, and updated orchestrator_protocol.md, SKILL.md, and tests
- **Result**: Delivered in PR #34 (delivery commit 32571de, score 10/10, review converged); suite 405/405

### [2026-10-25 21:16] Agent: deepseek-v4.1-flash
- **Prompt**: Roll the product back to its optimal feature set after scoring the 20 latest specs (option A: reset to the lean point and replay the keeps)
- **Done**: Reset develop to c7b56fa (2026-10-22, PR #38), replayed spec 00059 and 00063, ported the spec 00069 target-file rule onto the lean planner, archived 12 reverted specs in the registry, and pinned markdown to LF so text assertions run on Windows
- **Result**: 68,176 to 35,750 lines in skills and tests (-48%), 814 to 442 tests, suite 442/442 in 47s, doctor PASS with 0 warnings; dropped the reporting, telemetry, fresh-verify, AC-ledger, batch-merge, per-role-model, issue-sync, and DAG-classifier clusters; pre-cut state at tag pre-cut-2026-10-25
### [2026-10-26 08:06] Agent: deepseek-v4.1-flash
- **Prompt**: Collapse the duplicate buildCommand/testCommand config keys to verification.*
- **Done**: Removed the flat keys from both schemas, config defaults, validation and every gate; sdw-orch and sdw-ship-pr now read erification.buildCommand and erification.testCommand only; loadConfig throws on a legacy flat key naming the replacement; config spec, orchestrator protocol and FEATURES updated
- **Result**: Promoted in PR #76 (merge a992a76, review thread on the silent legacy-key fallback fixed in d89af6d); suite 443/443
### [2026-10-27 09:48] Agent: deepseek-v4.1-flash
- **Prompt**: Rename the sdw-orch skill to sdw-run
- **Done**: Moved the skill to skills/sdw-run with the sdw_run.cjs entry script, rewrote 63 live files (610 mentions), dropped the orch, sdw-orchestrator, and implement aliases, moved the DAG fallback bucket to run, updated router, doctor, batch, config schema descriptions, docs, and directory structure, renamed 7 test files, and added a guard test that fails on any live reference to the retired name
- **Result**: Merged in PR #78 (merge 60ca9fa, delivery commit bc169a4, review converged with 0 threads); suite 446/446 in 51s, both doctors PASS