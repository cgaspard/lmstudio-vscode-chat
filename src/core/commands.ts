/**
 * Slash-command logic shared by the bridge (mapping the server's command list)
 * and the webview (merging + matching the slash menu, parsing typed input).
 * Pure and dependency-free so it can be unit-tested without vscode or the DOM.
 */

/**
 * Whether a command template takes arguments, inferred from its `hints` (the
 * placeholders OpenCode reports, e.g. ["$ARGUMENTS"] or ["$1"]). A command that
 * takes args should let the user type them before it fires.
 */
export function commandTakesArgs(hints: unknown): boolean {
  return Array.isArray(hints) && hints.some((h) => typeof h === 'string' && /\$ARGUMENTS|\$\d/.test(h));
}

/** Minimal shape needed to merge/dedupe — anything with a `name`. */
export interface NamedCommand {
  name: string;
}

/**
 * Merge built-in (local) commands with server-provided ones, de-duplicated by
 * name: a local command wins over a server command of the same name (so our own
 * /compact, /clear etc. are never shadowed). Local commands come first, then the
 * remaining server commands in their given order.
 */
export function mergeSlashCommands<L extends NamedCommand, S extends NamedCommand>(
  local: L[],
  server: S[],
): Array<L | S> {
  const seen = new Set(local.map((c) => c.name));
  return [...local, ...server.filter((c) => !seen.has(c.name))];
}

/**
 * Filter a command list to those whose name starts with the current `/token`.
 * Returns [] unless the input is a bare `/word` (no whitespace yet) — once the
 * user types a space (moving on to arguments or a real prompt) we stop
 * suggesting, so a normal message that happens to start with "/" isn't hijacked.
 * Matching is case-insensitive.
 */
export function matchSlashPrefix<T extends NamedCommand>(input: string, commands: T[]): T[] {
  if (!input.startsWith('/') || /\s/.test(input)) {
    return [];
  }
  const q = input.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * Split a typed slash line into its command name (lowercased, leading token) and
 * the trailing argument string. `"/fib  make it fast"` → { name: "/fib",
 * args: "make it fast" }. Returns null when the text isn't a slash line.
 */
export function parseSlashInput(text: string): { name: string; args: string } | null {
  if (!text.startsWith('/')) {
    return null;
  }
  const name = text.split(/\s+/, 1)[0].toLowerCase();
  const args = text.slice(name.length).trim();
  return { name, args };
}
