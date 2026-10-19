# Karpathy Rules & Core Engineering Principles

This reference documents the architectural rationale, best practices, and code comparisons that embody the four foundational pillars of `sdw-rules`.

---

## 1. Think & Ask Before Acting

### Philosophy
LLM agents frequently hallucinate missing requirements or unilaterally introduce speculative architecture (e.g. inventing installer tools, complex plugin frameworks, or extra configuration toggles).

### Directive
When an architectural opportunity, potential abstraction, or unrequested enhancement is detected:
- **Never infer or implement silently.**
- Halt and query the user using the host's question prompt mechanism (`ask_question` where available, or structured chat).
- Always present explicit options with the **minimal requested scope** as the recommended default.

---

## 2. Simplicity First (YAGNI — You Aren't Gonna Need It)

### Philosophy
Every extra line of code is liability, potential bug surface, and cognitive overhead.
- No features beyond what was explicitly asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- If a solution takes 50 lines but could be done in 20, choose 20.

### Code Comparison

#### ❌ Overengineered Solution (50+ Lines)
```javascript
// Complex factory with registry, polymorphism, and unused configurability
class StrategyRegistry {
  constructor() {
    this.strategies = new Map();
  }
  register(name, strategy) {
    this.strategies.set(name, strategy);
  }
  resolve(name) {
    if (!this.strategies.has(name)) {
      throw new Error(`Strategy ${name} not found`);
    }
    return this.strategies.get(name);
  }
}

class BaseTransformer {
  transform(input) {
    throw new Error('Not implemented');
  }
}

class PrefixTransformer extends BaseTransformer {
  constructor(prefix) {
    super();
    this.prefix = prefix;
  }
  transform(input) {
    return `${this.prefix}:${input}`;
  }
}

const registry = new StrategyRegistry();
registry.register('prefix', new PrefixTransformer('v1'));
const result = registry.resolve('prefix').transform('data');
```

#### ✅ Minimal Viable Solution (2 Lines)
```javascript
// Simple, direct, solves the exact requirement
function addPrefix(input, prefix = 'v1') {
  return `${prefix}:${input}`;
}
const result = addPrefix('data');
```

---

## 3. Surgical Scope Enclosure

### Philosophy
Agents should not act like runaway brooms cleaning up untouched parts of a house.
- Do not "improve" adjacent code, comments, or formatting.
- Do not refactor things that aren't broken.
- Match existing style.
- Clean up only your own mess: remove variables/imports that YOUR changes made unused. Pre-existing dead code should only be removed if explicitly requested.

---

## 4. Empirical Goal-Driven Verification

### Philosophy
Subjective claims ("I verified it works") are forbidden.
- Transform every requirement into a verifiable check, test, or empirical pass/fail signal.
- Multi-step tasks must define verifiable success criteria:
  ```
  1. [Step] -> verify: [command / test]
  2. [Step] -> verify: [command / test]
  ```
- Tests must pass before considering any task complete.
