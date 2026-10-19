# Review Policy: spec-driven-workflow (SDW)

Report only findings that change behavior. Maximum 6 findings per review.

## Report only if ONE of these is true

1. **Runtime defect:** wrong behavior, crash, unhandled `null`/`undefined`, broken path resolution, race condition, or a state machine that reports success when work failed.
2. **Acceptance criterion violated:** the diff contradicts an `ACn` entry or `## Notes` constraint in `.sdw/specs/`.
3. **Secret exposure:** a credential, token, API key, or private key is committed.
4. **Runtime dependency or harness coupling:** a packaged skill helper (`skills/*/scripts/*.cjs`) adds a non-stdlib dependency (npm package, Python) or depends on a specific agent harness/vendor API.
5. **Unrequested version control mutation:** `git commit` or `git push` outside an authorized `sdw-orch` run.

## Do not report

- Documentation wording, help-text phrasing, template/doc drift, README or inventory consistency.
- The same defect in other locations: collect every `file:line` into ONE thread.
- Style, naming, comments, dead code, or "could also be hardened" speculation.
- Code that is already correct at the reviewed head, or a finding already resolved in this PR.
- Missing tests, unless the missing test is the only thing preventing a stated AC from being unverified.

## Thread shape

- One thread per defect class, anchored at the first occurrence.
- Never populate `relatedOccurrences` (each entry is published as its own thread). List every other affected location inside the comment body instead.
- Body, in this order: one-line defect → `Evidence:` the concrete failing scenario with `file:line` → `Fix:` the minimal diff → `Other locations:` the remaining `file:line` anchors, or `none`.
- No analysis section, no score rationale, no restating the file contents.
