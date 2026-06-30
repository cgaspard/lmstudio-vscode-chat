---
name: fibonacci-helper
description: Use when the user asks to optimize, explain, test, or rewrite the Fibonacci function in app.js — or asks about Fibonacci implementations in general (recursive vs iterative vs memoized, time complexity, edge cases).
---

# Fibonacci helper

This sample skill demonstrates how OpenCode skills work in LM Studio Code /
Ollama Code. When the model decides this skill is relevant (based on the
`description` above), it loads this body into context to guide its work.

## What this skill knows

The sample workspace's `app.js` contains a naive recursive `fib(n)`:

```js
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
```

This is **O(2ⁿ)** — it recomputes the same subproblems exponentially. For any
`n` above ~35 it becomes painfully slow.

## How to help

When asked to improve it, prefer these in order:

1. **Memoized** (top-down) — keep the recursive shape, cache results. O(n).
2. **Iterative** (bottom-up) — a simple loop with two rolling values. O(n) time,
   O(1) space. This is usually the best default.
3. **Closed-form** (Binet's formula) — O(1) but loses precision for large `n`;
   only suggest it when the user explicitly wants constant time and accepts
   floating-point limits.

For the full set of ready-to-paste implementations and their trade-offs, read
the bundled `REFERENCE.md` in this skill's directory.

## Guidance

- Always preserve the existing `fib` name and call signature unless asked.
- Add a brief comment noting the complexity of whatever you write.
- If you change `app.js`, verify it still runs (`node app.js`) when practical.
