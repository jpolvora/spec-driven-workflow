# Anti-Patterns Catalog: Common LLM Overengineering Traps

This catalog details recurring pitfalls observed in LLM agent code and specifies concrete avoidance criteria.

---

## 1. Speculative Configurability
- **Symptom:** Adding 5 new options to `config.json` that were neither requested nor needed for the immediate acceptance criteria.
- **Why it hurts:** Inflates documentation, demands extra validation logic, increases testing matrix.
- **Directive:** Only add configuration properties explicitly requested in specifications. Default behaviors should be convention-based.

## 2. Inventing Unasked Subcommands / CLI Machinery
- **Symptom:** When asked to write a script that does X, creating an entire interactive CLI framework with 8 subcommands, colors, and spinners.
- **Why it hurts:** Unnecessary lines of code to maintain; breaks agnosticism.
- **Directive:** Implement only the subcommands defined in the specification. Use standard stdout/stderr and exit codes.

## 3. Class Hierarchies for Single-Use Logic
- **Symptom:** Creating `AbstractBaseHandler`, `DefaultHandlerFactory`, `HandlerRegistry` when only a single function is called.
- **Why it hurts:** Obscures data flow, burns tokens during context ingestion, complicates debugging.
- **Directive:** Prefer plain functions and standard CommonJS modules. Introduce abstractions only upon the third distinct concrete use case (Rule of Three).

## 4. Adjacent Code "Refactoring" / Formatting Drift
- **Symptom:** Modifying whitespace, sorting imports, or "modernizing" syntax in unrelated functions in the same file.
- **Why it hurts:** Pollutes `git diff`, makes code review painful, risks regressions in unrelated areas.
- **Directive:** Surgical diffs only. Touch strictly lines relevant to the current task.

## 5. Composite / Vague Acceptance Criteria
- **Symptom:** Authoring acceptance criteria like `The system shall do X, Y, and Z while handling errors gracefully.`
- **Why it hurts:** Hard to score deterministically (0–10); hides failure states.
- **Directive:** Atomic EARS criteria. One condition, one response, one verification method.
