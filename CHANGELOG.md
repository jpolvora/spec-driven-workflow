# Changelog

### [2026-10-21 19:53] Agent: agent
- **Prompt**: Run spec 044: add .gitattributes and per-task checkpoint save in sdw-orch DAG
- **Done**: Added repo-root .gitattributes with text=auto and eol=lf pins, normalized the worktree to zero w/mixed, added a per-task scoped checkpoint commit plus sdw-checkpoint-{runId}-{taskId} tag on accepted task finish with --no-task-checkpoint opt-out, gated the save behind the pre-commit secret scan over the correct tree, and updated orchestrator_protocol.md, SKILL.md, and tests
- **Result**: Delivered in PR #34 (delivery commit 32571de, score 10/10, review converged); suite 405/405
