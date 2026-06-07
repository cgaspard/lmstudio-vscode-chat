// A tiny playground program for trying the LM Studio Code agent.
//
// Open the LM Studio panel and ask things like:
//   • "explain what app.js does"
//   • "add a reverseString(s) function and call it in main"
//   • "write a quick test for fib() and run it"
//   • "refactor main() to print a table"

function greet(name) {
  return `Hello, ${name}!`;
}

// Naive recursive Fibonacci — great for asking the agent to memoize/optimize.
function fib(n) {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

function main() {
  for (const name of ['Ada', 'Alan', 'Grace']) {
    console.log(greet(name));
  }
  for (let i = 0; i < 8; i++) {
    console.log(`fib(${i}) = ${fib(i)}`);
  }
}

main();
