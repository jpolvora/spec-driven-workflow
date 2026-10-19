# sdw-orch Orchestrator Protocol & Architecture Reference

This reference details the internal lifecycle and contracts of the `sdw-orch` orchestrator.

## 1. Run State Lifecycle (`.sdw/state/{runId}.state.json`)

Each execution session is completely isolated within a dedicated JSON state file.

```json
{
  "orchestrator": "sdw-orch",
  "runId": "run-1729300000-feature",
  "specSlug": "feature",
  "specPath": ".sdw/specs/feature.spec.md",
  "projectRoot": "L:/source/project",
  "status": "in_progress",
  "currentStep": 1,
  "totalSteps": 8,
  "createdAt": "2026-10-18T23:00:00.000Z",
  "updatedAt": "2026-10-18T23:05:00.000Z",
  "baseCommit": "38a7c1...",
  "deliveryCommit": null,
  "score": 9,
  "scoreIteration": 1,
  "reviewIteration": 1,
  "dagTasks": [],
  "steps": {
    "1": { "name": "derivation", "status": "completed", "output": {} },
    "2": { "name": "grilling", "status": "completed", "output": {} },
    "3": { "name": "dag_generation", "status": "completed", "output": {} },
    "4": { "name": "implementation", "status": "completed", "output": {} },
    "5": { "name": "scoring", "status": "completed", "output": {} },
    "6": { "name": "delivery_commit", "status": "completed", "output": {} },
    "7": { "name": "code_review", "status": "completed", "output": {} },
    "8": { "name": "pr_preparation", "status": "completed", "output": {} }
  },
  "handoffs": {},
  "errors": []
}
```

## 2. 8-Step State Machine

1. **Derivation:** Identifies whether the spec is already agent-ready (EARS ACs, DoR, YAML frontmatter). Skips derivation if ready; otherwise reformulates human stories.
2. **Grilling:** Walks the decision tree covering input bounds, failure scenarios, and concurrency. Auto-resolves known gaps or prompts user via `ask_question` with recommended defaults.
3. **DAG Generation:** Analyzes complexity (file count, touchpoints) and decomposes requirements into 1 or more atomic tasks.
4. **Implementation Dispatch:** Builds isolated prompts for subagents, preventing context pollution.
5. **Conformance Scoring:** Compares diffs against AC requirements. If score < threshold (default 8/10), attaches feedback and triggers re-implementation loop.
6. **Delivery Commit:** Creates an atomic, structured git commit for verified code.
7. **Automated Code Review:** Compares current branch changes to `baseCommit`, verifying rule invariants and clean syntax in an iterative loop.
8. **PR Preparation:** Assembles pull request metadata, marks the spec completed, and provides PR review resolution polling.
