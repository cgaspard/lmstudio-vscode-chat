# Sample Workspace

A throwaway Node.js project for trying out **LM Studio Code**. When you press
F5 in the extension repo, the Extension Development Host opens *this* folder so
the agent has real files to read, edit, and run.

It contains:

- [`app.js`](./app.js) — a tiny program (`greet` + a naive recursive `fib`) with
  ideas in the comments for things to ask the agent.
- [`AGENTS.md`](./AGENTS.md) — project rules the agent auto-loads (OpenCode reads
  `AGENTS.md` / `CLAUDE.md` automatically).
- `.vscode/` — a launch config + task so `app.js` can be run/debugged.

Run it:

```bash
node app.js   # or: npm start
```

Try asking the panel: *"explain app.js"*, *"memoize fib and show the speedup"*,
or *"add a CLI flag to choose how many Fibonacci numbers to print"*.
