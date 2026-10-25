# Anti-Regression Traps Log

Central repository log of behavioral and engineering traps to prevent repeating mistakes.

| Slug | Title | Layer | Avoid | Action | Date |
|---|---|---|---|---|---|
| no-unrequested-installers | Avoid inferring unrequested native installers | architecture | Adding native installer tooling without user prompt | Clarify via ask_question with minimal scope default | 2026-10-19 |
| single-use-abstractions | Prohibit speculative class factories | implementation | Creating complex registries or factories for single implementations | Use plain functions and CommonJS modules | 2026-10-19 |
| surgical-diff-hygiene | Avoid reformatting adjacent code | quality | Reformatting untouched functions or sorting unrelated imports | Confine diff strictly to lines required by task | 2026-10-19 |
| batch-follow-up-selects-merged-pr | Batch follow-up may select an already merged PR on a reused branch | general | Selecting the first branch pull request whose state is neither closed nor abandoned | Treat merged as unmergeable in the follow-up search and regression-test a merged PR listed ahead of the open follow-up | 2026-10-24 |
| spec-prefix-allocation-races-directory-visibility | Back-to-back spec creation can reuse a prefix | general | Trusting getNextPrefix when several sdw-spec new calls run back to back on a slow or network filesystem | Create one specification per invocation, read the allocated prefix and registry row before the next call, and repair any collision before wr | 2026-10-25 |
