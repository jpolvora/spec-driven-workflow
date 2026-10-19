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
8. **PR Preparation & Remote Push:** Assembles pull request metadata, marks the spec completed, pushes the active branch to remote origin (when `--push` or `pushDelivery` enabled), and provides PR review resolution polling.

## 3. Multi-Specification Batch Queue Lifecycle (`.sdw/state/batch-{batchId}.json`)

When multiple specifications are provided to `sdw-orch run <spec1> <spec2> ...`, queue state is managed through a batch manifest:

```json
{
  "batchId": "batch-1792386000000",
  "createdAt": "2026-10-19T00:55:00.000Z",
  "updatedAt": "2026-10-19T00:58:00.000Z",
  "status": "in_progress",
  "policy": {
    "continueOnError": false,
    "syncIndex": true
  },
  "total": 2,
  "currentIndex": 0,
  "queue": [
    {
      "index": 0,
      "spec": ".sdw/specs/001-feature-a.md",
      "slug": "001-feature-a",
      "status": "completed",
      "runId": "run-1792386010000-001-feature-a",
      "branch": null,
      "deliveryCommit": "a1b2c3d",
      "durationMs": 4200,
      "error": null
    },
    {
      "index": 1,
      "spec": ".sdw/specs/002-feature-b.md",
      "slug": "002-feature-b",
      "status": "pending",
      "runId": null,
      "branch": null,
      "deliveryCommit": null,
      "durationMs": null,
      "error": null
    }
  ]
}
```

### Batch Operational Guarantees:
- **Pre-Flight Disk Validation:** Rejects execution before creating manifests if any queued specification file is missing on disk.
- **Side-Effect-Free Dry-Run:** `--dry-run` validates all specifications and emits the execution plan without creating files or writing state.
- **Sequential Context Isolation:** Each specification runs in an independent child run context with its own distinct `runId` and `.state.json` file.
- **Deterministic Resumption:** `resume-batch [batchId]` skips completed items and resumes strictly from the first pending or failed item.
- **Index Synchronization:** Automatically executes `sdw-spec sync` upon each item completion unless `--no-sync` is specified.

## 4. Unattended Multi-Specification Execution Protocol

When multiple specifications are queued (`sdw-orch run spec1 spec2 ...` or `resume-batch`):
- **Unattended Execution Contract:** The orchestrator and executing agent operate strictly in non-interactive, unattended mode. No pauses or conversational confirmation queries are permitted between queue items.
- **Autonomous Decision Resolution:** Grilling/Refinement decision gaps in Step 2 automatically select recommended defaults (`autoResolveGaps: true`, `abortOnGaps: false`), eliminating pauses.
- **Per-Specification Isolation:** Each specification runs in its own child context with isolated run state (`run-*.state.json`), maintaining clean subagent context fencing.
- **Autonomous Delivery & Synchronization:** Upon successful implementation and verification (conformance score ≥ threshold, tests passing, review clean), the orchestrator stages the delivery commit, updates `index.specs.md` to `completed`, syncs via `sdw-spec sync`, and immediately initiates the next queued specification.
- **Halting vs Continuation:** Default policy halts execution on specification failure, saving batch state for `resume-batch`. When `--continue-on-error` is active, errors are logged in the manifest and the queue advances uninterrupted to the next item.
- **Terminal Consolidated Summary:** The orchestrator emits the batch manifest summary report only once all queued items have completed or halted.
