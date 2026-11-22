# Anti-Regression Traps Log

Central repository log of behavioral and engineering traps to prevent repeating mistakes.

| Slug | Title | Layer | Avoid | Action | Date |
|---|---|---|---|---|---|
| no-unrequested-installers | Avoid inferring unrequested native installers | architecture | Adding native installer tooling without user prompt | Clarify via ask_question with minimal scope default | 2026-10-19 |
| single-use-abstractions | Prohibit speculative class factories | implementation | Creating complex registries or factories for single implementations | Use plain functions and CommonJS modules | 2026-10-19 |
| surgical-diff-hygiene | Avoid reformatting adjacent code | quality | Reformatting untouched functions or sorting unrelated imports | Confine diff strictly to lines required by task | 2026-10-19 |
| ship-pr-needs-gh-json-checks | sdw-ship-pr review polling needs gh >= 2.60 | tooling | Relying on distro gh (Debian trixie ships 2.46) for 'gh pr checks --json' | Upgrade gh to >= 2.60 before --poll-pr; 2.46 aborts convergence with 'unknown flag: --json' | 2026-11-04 |
