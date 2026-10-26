# Changelog

### [2026-10-21 19:53] Agent: agent
- **Prompt**: Run spec 044: add .gitattributes and per-task checkpoint save in sdw-orch DAG
- **Done**: Added repo-root .gitattributes with text=auto and eol=lf pins, normalized the worktree to zero w/mixed, added a per-task scoped checkpoint commit plus sdw-checkpoint-{runId}-{taskId} tag on accepted task finish with --no-task-checkpoint opt-out, gated the save behind the pre-commit secret scan over the correct tree, and updated orchestrator_protocol.md, SKILL.md, and tests
- **Result**: Delivered in PR #34 (delivery commit 32571de, score 10/10, review converged); suite 405/405

### [2026-10-25 21:16] Agent: deepseek-v4.1-flash
- **Prompt**: Roll the product back to its optimal feature set after scoring the 20 latest specs (option A: reset to the lean point and replay the keeps)
- **Done**: Reset develop to c7b56fa (2026-10-22, PR #38), replayed spec 00059 and 00063, ported the spec 00069 target-file rule onto the lean planner, archived 12 reverted specs in the registry, and pinned markdown to LF so text assertions run on Windows
- **Result**: 68,176 to 35,750 lines in skills and tests (-48%), 814 to 442 tests, suite 442/442 in 47s, doctor PASS with 0 warnings; dropped the reporting, telemetry, fresh-verify, AC-ledger, batch-merge, per-role-model, issue-sync, and DAG-classifier clusters; pre-cut state at tag pre-cut-2026-10-25