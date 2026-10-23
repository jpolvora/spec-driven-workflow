# SDW Glossary — Concepts & Vocabulary

Spec-Driven Workflow is **opinionated**: the words below mean what this project says they mean, even when the software industry uses the same word differently. When a term is ambiguous, this file wins. Industry synonyms are listed for recognition only — they are not interchangeable.

> **The one rule that matters most:** a specification is a document, not an order. Registering a spec, describing it, reviewing it, or planning it never authorizes implementation. Only an explicit user instruction to implement does.

---

## 1. Documents & Lifecycle

| Term | SDW meaning | Also called / not to be confused with |
|---|---|---|
| **Spec-Driven Workflow (SDW)** | This framework: skills, specifications, deterministic tooling, and the 8-step orchestrator that turn written requirements into delivered code. | *SDW*. Not a generic "AI workflow" and not a ticket system. |
| **Specification (spec)** | A single canonical Markdown file at `.sdw/specs/NNNNN-<slug>.md` containing YAML frontmatter, Description, Design Intent, EARS acceptance criteria, Notes, Out of Scope, Assumptions, Definition of Ready, and Validation notes. | *Spec*, *feature spec*. Not a user story, not an issue, not a PRD page in a wiki. |
| **Spec slug** | The stable identifier `NNNNN-kebab-case-name` used in the file name, index row, run state, and branch names. | *Slug*, *spec id*. Not a ticket number. |
| **Spec prefix** | The zero-padded five-digit number (`00001`, `00002`, …) that orders specs and prefixes the slug. | *Number*, *NNNNN*. |
| **Backlog (SDW)** | **The specification registry file** `.sdw/specs/index.specs.md`. It keeps every spec stored on the filesystem and its metadata: slug, title, status, source, spec date, validation health, archival date. | *Spec index*, *registry*, *catalog*, *spec ledger*. Not a sprint backlog or capacity queue (ranking by priority is supported via `sdw-spec list-by-priority`). |
| **In the backlog / registered** | The spec file exists on disk **and** has a row in the registry. Registering is a filing action: it schedules nothing and authorizes nothing. | *Registered*, *indexed*, *filed*. Not "queued for delivery". |
| **Deferred spec** | A registered spec the maintainer does not intend to implement now. Deferral is expressed in prose or in the spec's Notes; it is not a lifecycle status. | *Parked*, *backlog idea*, *tracked but not scheduled*. Not "cancelled". |
| **Registry status** | The lifecycle value in the registry row. Supported values are `pending` (authored, not delivered), `completed` (implemented, verified, PR prepared), and `archived` (retired). | *Index status*, *lifecycle state*. Not a priority, not an authorization, and not the spec header status. |
| **Spec status** | The `status:` value in a spec's YAML frontmatter: `draft` (needs refinement), `awaiting-approval` (grilled, awaiting sign-off), `ready-to-implement` (approved, may be ordered), `implemented` (delivered), `abandoned` (dropped but kept). | *Header status*, *authoring status*. Not the registry status and never an implementation authorization. |
| **Archived spec** | A completed spec retired from active development. It stays on disk and in the registry but `sdw-orch run` refuses it unless overridden. | *Retired*. Not deleted and not "done twice". |
| **Acceptance Criterion (AC)** | One atomic, testable requirement written in EARS form (`AC1`, `AC2`, …). The AC list is the contract the orchestrator scores and the reviewer checks. | *AC*, *criterion*, *requirement*. Not an "acceptance test" (the test is the evidence, the AC is the promise). |
| **EARS** | Easy Approach to Requirements Syntax: the five allowed sentence patterns for ACs — ubiquitous, event-driven, state-driven, optional-feature, unwanted-behavior. | *EARS syntax*. Not plain prose requirements. |
| **Definition of Ready (DoR)** | A table stating what must be true before the spec can be executed, with a verification method per item. | *DoR*, *readiness gates*. Not a Definition of Done. |
| **Out of Scope** | A `Feature` / `Reason` table that names what the spec deliberately does **not** include. | *Non-goals*, *exclusions*. Not a wish list. |
| **Assumptions & Open Questions** | A table of defaults the spec depends on, why they were chosen, and whether the maintainer confirmed them. | *Assumptions*, *open questions*. Not decisions already made elsewhere. |
| **Validation & Observation Notes** | The spec section holding telemetry/observable signals and at least one negative or failing test scenario. | *Observation notes*, *negative scenarios*. Not a test plan for the whole repo. |
| **Spec validator** | The deterministic checker (`validate_spec.cjs`) that enforces frontmatter, section order, EARS form, and required tables. `--mode=authoring` is the standard gate. | *Validator*, *lint*. Not an LLM review. |
| **Spec authoring** | Writing, importing, validating, indexing, or archiving specifications. Pure documentation work. | *Spec work*, *registration*. **Never** implementation authorization. |

---

## 2. Orchestration & Delivery

| Term | SDW meaning | Also called / not to be confused with |
|---|---|---|
| **Orchestrator (`sdw-orch`)** | The skill and CLI that drives a spec through the 8-step pipeline using deterministic state transitions. | *Orch*, *pipeline runner*. Not an autonomous agent that decides on its own to start. |
| **Run** | One orchestrated execution of one specification, identified by `run-<timestamp>-<slug>` and persisted in `.sdw/state/<runId>.state.json`. | *Execution*, *session*. Not a chat conversation. |
| **Step** | One of the eight fixed pipeline stages: 1 derivation, 2 refinement, 3 DAG generation, 4 implementation, 5 scoring, 6 delivery commit, 7 code review, 8 PR preparation. | *Stage*, *phase*. Not a task. |
| **Refinement (grilling)** | Step 2's decision-tree walk that surfaces gaps (input bounds, failure recovery, persistence) and either resolves them with defaults or asks the user. | *Grilling*, *gap analysis*, *blueprint*. Not code review. |
| **Second pass (refinement)** | An explicit re-run of a delivered specification (`--second-pass`, alias `--refine`) that audits every acceptance criterion against the delivered code, tests, configuration, and documentation, implements what is missing or drifted, then simplifies inside the same scope. | *Refine*, *revisit*. Not Step 2 grilling, not a re-implementation, and never part of a batch. |
| **DAG** | The directed acyclic graph of implementation tasks generated in Step 3 from the spec's acceptance criteria and target files. | *Task graph*, *execution plan*. Not a workflow diagram of the 8 steps. |
| **Task** | One unit of implementation work inside the DAG (`task-1`, `task-2`, …), with its own title, covered ACs, target files, and dependencies. | *Work item*, *slice*. Not a step, not a subtask of a step. |
| **Dispatch** | Handing exactly one ready task to exactly one worker, emitting a self-sufficient prompt and evidence path. | *Hand-off*, *envelope emission*. Not parallel execution. |
| **Envelope** | The dispatch record printed by `task next`: run id, task id, prompt path, evidence path, AC ids, dependencies, worker brief, finish command. | *Brief*, *dispatch record*. Not the prompt itself. |
| **Worker / subagent** | The agent instance that implements one dispatched task and returns an evidence file. | *Worker*, *subagent*, *implementer*. Not the orchestrator. |
| **Host agent** | The agent the human talks to. It runs the CLI, spawns one worker per envelope, and submits evidence. | *Parent agent*, *host*. Not a vendor-specific runtime. |
| **Evidence** | The JSON report a worker writes for its task: `taskId`, required `status`, covered `acIds`, `filesChanged`, executed `tests`, `summary`. Only `success` is accepted. | *Task evidence*, *worker report*. Not a test log and not a transcript. |
| **Corroboration / baseline** | Verifying that a task's claimed files actually changed after the dispatch, using a content hash baseline captured at dispatch. | *Baseline check*, *staleness check*. Not a trust statement. |
| **Gate** | A deterministic quality check that must pass before advancing: build, test suite, secret scan, evidence validation. | *Quality gate*, *verification gate*. Not a code review opinion. |
| **Conformance score** | A 0–10 judgment of how well the delivered diff satisfies the acceptance criteria, produced by an LLM judge fenced to the ACs plus the diff. | *Score*, *conformance*. Not test coverage and not a percentage of ACs. |
| **Judge** | The model invocation that returns the score plus per-AC verdicts. Configurable through `scoring.*`; fails closed at 0/10 when unavailable. | *LLM judge*, *evaluator*. Not the reviewer. |
| **Re-implementation loop** | The Step 5 cycle that re-runs implementation when the score is below `scoreMin` (default 8/10). | *Score loop*, *retry loop*. Not an infinite retry. |
| **Delivery commit** | The Step 6 commit (`feat(<slug>): …`) containing only the accepted files plus the spec index update, after gates and the secret scan pass. | *Delivery*, *scoped commit*. Not a merge. |
| **Delivery report** | The companion markdown file `{spec}-report.md` committed beside the specification before PR shipping, capturing run metadata, tasks, commits, diffs, observations, and quality metrics. | *Companion report*, *run report*. Not a step artifact. |
| **Task changelog** | The append-only delivery record in `CHANGELOG.md` written by `sdw-changelog` summarizing prompt intent, work performed, and verified outcome. | *Delivery record*, *task history*. Not the git log. |
| **Retrospective** | The post-delivery analysis executed by `sdw-retro` reviewing completed runs for friction signals, transcript slips, and improvement candidates. | *Retro*, *run retro*. Not Step 2 grilling or code review. |
| **Ship / shipping** | The `sdw-ship-pr` skill: pre-PR gates, branch push, PR creation or reuse, review convergence, and optional merge. | *PR shipping*, *delivery*. Not the same as the delivery commit. |
| **Review convergence** | Polling CI and review threads, fixing findings, pushing, and resolving threads with a comment that cites the fix commit. | *Review loop*, *thread resolution*. Not a re-review by the author. |
| **Fixer (`sdw-fixer`)** | The shared remediation skill: validates a findings batch, scores it, consults defect-class knowledge through `sdw-memory`, applies surgical edits at finding and verified sibling lines, and reports fixed, skipped, and learned. | *Remediator*, *auto-fix*. Not the reviewer; it never self-approves. |
| **Findings batch** | The JSON array passed to `sdw-fixer`: `file`, `line`, `rule`, `evidence`, optional `severityHint`. Built from review threads, review findings, or verification failures. | *Fix batch*, *findings file*. Not a report and not an evidence file. |
| **Run state** | The JSON file recording step status, tasks, evidence, scores, delivery, and errors for one run. | *State file*, *run record*. Not the spec index. |
| **Artifact** | A human-readable Markdown file persisted under the run's state directory for steps 2, 3, 5, 7, and dispatch prompts. | *Step artifact*, *report*. Not a build artifact. |

---

## 3. Isolation, Modes & Execution Styles

| Term | SDW meaning | Also called / not to be confused with |
|---|---|---|
| **Plan-only dry run** | `--dry-run` on `run` or a batch: validate the spec(s) and print the plan; create no state, artifacts, branches, or clones. | *Plan*, *preview*. Not a rehearsal and not a sandbox. |
| **Sandbox** | An isolated shallow single-branch clone under `{sandboxDir}/{runId}/repo` where a full pipeline run executes with push and SCM delivery forced off. | *Isolated run*, *clone*, *jail*. Not a security boundary — it is filesystem and git isolation. |
| **Feature branch** | The opt-in `{branching.featurePrefix}{specSlug}` branch created when `useFeatureBranches` is enabled (default prefix `feature/`). | *Working branch*. Not a sandbox and not a release branch. |
| **Branching strategy** | The `branching.strategy` preset (`trunk`, `github`, `develop`, `gitflow`, `gitlab`) that resolves the work lane, the integration lane, the pre-start update, and the post-merge synchronization; explicit `branching` keys override the preset. | *Branch model*, *branch topology*. Not the `useFeatureBranches` master switch. |
| **Work lane** | `branching.workBranch`: the branch where feature branches start and where the repository returns after delivery. `null`, or a lane equal to the integration lane, means the checked-out branch (trunk behavior). | *Development lane*, *Base lane*. Not the same as the checked-out branch when a distinct lane is configured. |
| **Integration lane** | `branching.integrationBranch`: the branch that receives the pull request merge and the target of `sdw-ship-pr`'s PR base and `sdw-code-review`'s review base. `null` means auto-detect from `origin/HEAD`. | *Target branch*, *PR base*. Not the work lane. |
| **Post-merge sync** | The `sdw-ship-pr` step that switches to the work lane, fast-forwards it to the integration lane, and optionally pushes it after a `MERGED` pull request; its outcome is `branchingSync` (`synced` or `blocked`) in run state. | *Branch sync*, *lane fast-forward*. Not a merge, not a rebase, and never rewrites history. |
| **Worktree** | A second working tree for a task, used only in `implementation.mode: command` when `useWorktrees` is enabled. | *Git worktree*. Not a clone; it shares the repository object database. |
| **Batch queue** | Sequential execution of several specs (`run spec1 spec2 …`) with one manifest, one pause per dispatch, and a failure policy. | *Batch*, *queue*. Not parallel execution. |
| **Unattended mode** | Batch execution that resolves grilling gaps with defaults and never stops between specs. | *Autonomous batch*. Not "no authorization needed". |
| **Implementation mode** | `subagent` (default: host spawns one worker per task) or `command` (the orchestrator runs a configured subprocess per task). | *Execution mode*. Not the implementation itself. |

---

## 4. Packaging & Environments

| Term | SDW meaning | Also called / not to be confused with |
|---|---|---|
| **Product** | Everything this project ships under `skills/` — the skills, their `references/`, and their deterministic `scripts/` — as installed by consumers. Product code serves consumers on any harness and must not depend on this repository's development environment. | *SDW product*, *shipped skills*. Not the development harness (`.agents/skills/`, `AGENTS.md`, repository-root docs) and not a consumer's local `.sdw/` workspace. |
| **Canonical repository** | This project's checkout, where `skills/` is the source of truth and `.sdw/` is the consumer template. | *SDW repo*, *upstream*. Not a consumer workspace. |
| **Upstream** | This repository as the canonical SDW source: where skills are authored, validated, and released from. `sdw-doctor` reports `upstream` mode when it runs here. | *Main repo*, *source of truth*, *canonical checkout*. Not a consumer project, not the global install, and not a published release. |
| **Consumer project** | Any repository that installs SDW skills and owns its `.sdw/` workspace. | *Consumer*, *target repo*. Not the canonical repo. |
| **Skills root** | The directory where skills are installed: `{projectRoot}/skills` (canonical), `{projectRoot}/.agents/skills` (project-local), or `$HOME/.agents/skills` (shared). | *Install root*, *skills directory*. |
| **Hybrid mode** | Skills installed once globally under `$HOME/.agents/skills` and shared across projects, while each project keeps its own `.sdw/`. | *Global install*. Not a remote service. |
| **Harness-agnostic** | No dependency on a specific agent runtime, vendor, IDE, or proprietary API; everything works through files, CLI, and standard formats. | *Agent-agnostic*, *vendor-neutral*. Not "works without an agent". |
| **Skill** | A reusable package with `SKILL.md` (Tier 1 instructions), optional `references/*.md` (Tier 2), and deterministic `scripts/*.cjs` (Tier 3). | *Agent skill*. Not a plugin and not a prompt fragment. |
| **Router (`sdw-router`)** | The always-loaded dispatcher that maps intent to a skill or passes through. | *Front door*, *dispatcher*. Not the orchestrator. |
| **Config (`.sdw/config.json`)** | The per-project settings file, validated against `config.schema.json`. | *Workspace config*. Not agent preferences. |

---

## 5. Rules, Memory & Authorization

| Term | SDW meaning | Also called / not to be confused with |
|---|---|---|
| **Rules skill (`sdw-rules`)** | The shared behavioral rules: think before acting, simplicity first, surgical changes, empirical verification, and explicit authorization. | *Behavioral rules*. Not a style guide. |
| **Explicit authorization** | A direct user instruction to implement, edit, delete, move, or otherwise change the project. It is the **only** valid trigger for changes. | *Implementation order*, *go-ahead*. Not a topic statement, not a registered spec, not an approved design, not a passing test. |
| **Plan-before-change (planning mode)** | The default interaction for analysis, opinion, exploration, or ambiguous requests: read-only investigation, then a short plan with options, tradeoffs, and a recommendation, then **explicit confirmation** before any file changes. | *Planning loop*, *proposal*. Not a plan written after the work. |
| **Confirmation gate** | The explicit approval step that closes a plan. Silence, an emoji, or an unrelated "ok" is not approval; approval covers only the plan shown. | *Approval*, *go-ahead*. Not a question the agent answers for itself. |
| **Unattended mode** | Execution of an explicitly invoked skill or command whose own instructions are the approved plan; no per-step confirmation, but uncovered destructive steps still stop for approval. | *Autonomous execution*, *skill mode*. Not permission to widen scope. |
| **User gate / clarification gate** | A deliberate stop that asks the user to choose between explicit options, with a recommended default. | *Question gate*, *approval gate*. Not a retry. |
| **Trap** | A durable, searchable lesson about a mistake that must not repeat: scenario, what not to do, what to do instead. Recorded through `sdw-memory`: the vault when reachable, `.sdw/memory/traps.md` as the offline fallback. | *Anti-regression trap*, *lesson*. Not an in-repo TODO. |
| **Decision** | A durable architecture record: what was chosen, why, the rules that follow, and rejected alternatives. Stored in the memory vault. | *ADR*, *decision record*. Not a commit message. |
| **Memory vault** | Out-of-repo working memory managed through `spec-memo` / `ws-memo` (`bootstrap`, `search`, `upsert`). | *Vault*, *memory*. Not `MEMORY.md`, not `.agents/plans/`. |
| **Memory skill (`sdw-memory`)** | The single contract for product knowledge: `classify`, `query`, `record`, `consolidate`, `doctor` over pluggable backends, with the vault first and the local traps file as offline fallback. | *Knowledge wrapper*, *memory API*. Not the vault itself; it routes to it. |

---

## 6. Words SDW deliberately redefines

| Word | Common industry meaning | SDW meaning (authoritative here) |
|---|---|---|
| **Backlog** | Prioritized list of stories/tickets awaiting a sprint | The registry file `.sdw/specs/index.specs.md`; no priority or sprint semantics |
| **Spec** | A ticket, a product requirement doc, or a QA test plan | A validated Markdown contract with EARS ACs and readiness tables |
| **Task** | Any to-do item | One DAG unit with AC ids, target files, and dependencies |
| **Step** | A generic phase | One of eight fixed pipeline stages with deterministic exit criteria |
| **Gate** | A human approval checkpoint | A deterministic check (build/test/secret scan/evidence) |
| **Evidence** | Any supporting material | A structured JSON report corroborated against a dispatch baseline |
| **Sandbox** | A security boundary or disposable environment | A shallow git clone that keeps the source checkout and remote untouched |
| **Status** | A generic workflow state | Either the registry lifecycle value or the spec header authoring value; neither is an authorization |
| **Worker** | A person or process | An agent instance executing exactly one dispatched task |
| **Ledger** | Accounting book | (Planned, not implemented) an acceptance-criteria evidence record per run |

---

## 7. Rules for using this vocabulary

1. **Do not substitute synonyms silently.** Say "spec index (backlog)" at most once; then use one term consistently.
2. **"Backlog" never means "scheduled".** A registered spec is inert until the maintainer explicitly orders its implementation.
3. **"Pending" never means "approved".** It is a lifecycle value, not an authorization.
4. **"Dry run" never means "rehearsal".** It prints a plan and executes nothing; a real isolated execution is a **sandbox**.
5. **New terms enter through this file.** If a concept needs a name, add it here before using it in specs, skills, or docs.

---

## 8. Maintenance

- Owner: maintainers of the Spec-Driven Workflow repository.
- Update this file in the same change that introduces or renames a concept.
- Keep entries short: one definition, one "also called", one "not to be confused with".
- When this glossary and a skill disagree, the skill's executable contract wins for behavior and this glossary wins for vocabulary; fix both in the same commit.
