---
id: "48"
slug: 00061-us-48-brainstorm-multi-agent-parallel-f
title: "Brainstorm: multi-agent parallel features via sandboxes plus a coordinator merge to develop"
source: github
status: draft
specDate: 2026-10-23
---

# Specification — Brainstorm: multi-agent parallel features via sandboxes plus a coordinator merge to develop

## Description

Brainstorm: how can multiple agents implement several unrelated features concurrently, like multiple users working on different machines? Can sandbox mode achieve this?

## Current state

- `sdw-orch run --sandbox` clones committed `HEAD` to `{sandboxDir}/{runId}/repo` on branch `sdw-sandbox/{runId}`, removes the clone origin, and runs every step against that clone. Delivery is forced off (no push, no PR).
- `sdw-batch` runs specs sequentially through single `sdw-orch` runs in one session.
- Step 4 dispatch is strictly sequential, one task at a time (spec 00028).

## Idea under discussion

1. Run one batch item (or single spec) per sandbox: spec A in sandbox-1, spec B in sandbox-2, each in its own agent session, fully isolated.
2. When each sandbox run completes, a coordinator agent collects the finished sandboxes, brings their changes back to the main `develop` branch, and validates plus integrates them before pushing.
3. Open coordination questions:
   - Who detects completion (poll `sandbox report --run-id`, file watch, explicit signal)?
   - Merge strategy onto `develop`: sequential rebase/cherry-pick of each sandbox delivery commit vs. octopus merge; conflict ownership when two sandboxes touch the same file.
   - Validation gate before push: run each sandbox test suite, then an integrated suite on the merged tree; scoring/review reuse vs. re-run.
   - Sandbox lifecycle: who runs `sandbox clean`, when, and what metadata/report is kept.
   - Relation to parallelizable DAG flags (issue #47 / spec 00030): cross-spec parallelism at sandbox level vs. within-spec task parallelism.
   - Relation to `ws-spec-to-pr-distributed` baton runs (multi-CLI): reuse or separate mechanism?

## Goal of this issue

Collect the design direction only. No implementation until an explicit spec is authored and approved.


### Design Intent

Establish deterministic architectural standards, test criteria, and automated verification boundaries for Brainstorm: multi-agent parallel features via sandboxes plus a coordinator merge to develop.

### Prior Work Sweep

Reviewed existing workspace implementations and tracker references prior to specification formulation.

## Acceptance Criteria

- AC1: The system shall deliver requirements for remote work item #48: Brainstorm: multi-agent parallel features via sandboxes plus a coordinator merge to develop

## Notes

- Imported from github as item #48.
- All helper scripts and tooling anchors must use Node.js CommonJS (.cjs) using standard library modules only.
- Adhere strictly to the 3-Tier skill authoring standard and EARS acceptance criteria conventions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated architecture refactoring | Scope is strictly bounded to the requirements of 00061-us-48-brainstorm-multi-agent-parallel-f |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Workspace directory standards | Follow canonical .sdw workspace guidelines | Consistent developer ergonomics across projects | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification schema | YAML frontmatter and EARS acceptance criteria valid | Run validate_spec.cjs in authoring mode |
| Directory layout | Target workspace directories exist and are writable | File system check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Deterministic command execution logs and structured console progress reports.
- Non-zero exit codes returned upon validation or verification failures.

### Negative & Failing Test Scenarios

- Input rejection test case: the system must reject invalid inputs or malformed options with descriptive error messages.
