# Fibonacci implementations — reference

This file demonstrates **progressive disclosure**: it is *not* loaded with the
skill body. The model reads it on demand (via its `read` tool) only when it
needs the detailed implementations — keeping the always-on context small.

## Iterative (recommended default) — O(n) time, O(1) space

```js
function fib(n) {
  if (n < 2) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    [a, b] = [b, a + b];
  }
  return b;
}
```

## Memoized recursion — O(n) time, O(n) space

```js
function fib(n, memo = new Map()) {
  if (n < 2) return n;
  if (memo.has(n)) return memo.get(n);
  const result = fib(n - 1, memo) + fib(n - 2, memo);
  memo.set(n, result);
  return result;
}
```

## Closed-form (Binet's formula) — O(1), loses precision past n≈70

```js
function fib(n) {
  const phi = (1 + Math.sqrt(5)) / 2;
  return Math.round(phi ** n / Math.sqrt(5));
}
```

## Edge cases to handle

- Negative `n`: decide whether to throw or return 0.
- Non-integer `n`: `Math.floor` or reject.
- Very large `n`: numbers exceed `Number.MAX_SAFE_INTEGER` around n=79; use
  `BigInt` if exactness matters past that.
