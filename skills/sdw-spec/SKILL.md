---
name: sdw-spec
description: Specification lifecycle, authoring, synchronization, and formatting manager integrated with sdw-orch.
version: 0.1.0
invocation_names:
  - sdw-spec
  - sdw-spec init
  - sdw-spec list
  - sdw-spec new
  - sdw-spec import
  - sdw-spec sync
  - sdw-spec validate
  - sdw-spec archive
---
# sdw-spec

> When this skill is loaded, output "sdw-spec loaded."

Specification lifecycle, authoring, synchronization, and formatting manager integrated directly with the orchestrator.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md); authoring, validating, registering, or archiving a spec never authorizes implementation.

## Subcommands

- `init`: Bootstraps `{specsDir}/index.specs.md` with standard tables and status definitions.
- `list`: Displays registered specifications with statuses and validation health.
- `new <text>`: Synthesizes a canonical specification with autoincremented numerical prefix from free-text requirements.
- `import`: Imports remote tracker items from GitHub issues or Azure DevOps work items using unified SCM contract.
- `sync`: Reconciles `index.specs.md` against on-disk specification files and orchestrator run state files.
- `validate <specPath>`: Enforces validation against YAML frontmatter, section hierarchy, and EARS syntax rules.
- `archive <slug>`: Transitions completed specifications to `archived` in `index.specs.md`.

## Steps

1. **Bootstrap or Inspect Specification Index**
   Ensure `{specsDir}/index.specs.md` exists and is synchronized.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs init` (or `sync`)
   - Done when: `index.specs.md` exists and lists all current specifications with accurate lifecycle statuses.

2. **Author or Import New Specification**
   Create a new specification with an autoincremented 3-digit prefix (`NNN`) from free-text or remote SCM issue. When formulating or editing specifications, apply `sdw-rules` for scope enclosure; never infer unprompted features without a user-gate.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs new "<requirements>"` or `node skills/sdw-spec/scripts/sdw_spec.cjs import --provider <github|azure-devops> --id <id>`
   - Done when: Canonical `.sdw/specs/NNN-{slug}.md` file is created and registered with status `pending`.

3. **Validate Specification Syntax & Quality Gates**
   Verify YAML frontmatter, required section hierarchy, EARS acceptance criteria conformance, and closure tables.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs validate <specPath> --mode=authoring`
   - Done when: Validation script exits with code `0` and outputs `PASS`.

4. **Synchronize & Reconcile Lifecycle States**
   Reconcile orchestrator run states and delivery evidence with specification index.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs sync`
   - Done when: Completed runs are marked `completed`, active runs are marked `pending`, and validation health is updated.

5. **Archive Completed Specification**
   Retire delivered specifications from active execution.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs archive <slug>`
   - Done when: Specification status is updated to `archived` in `index.specs.md`.

## References

- Specification standard & EARS syntax: [`references/spec_standard.md`](references/spec_standard.md)
- Unified SCM provider contract: [`references/scm_contract.md`](references/scm_contract.md)
