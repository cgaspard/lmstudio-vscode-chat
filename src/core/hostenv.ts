/**
 * The host environment we hand back to commands the agent runs.
 *
 * `serverManager.buildEnv` pins OpenCode's XDG_* dirs under our private dataDir
 * so this managed instance can never share session/auth/state with a user's own
 * OpenCode install. Those variables are then inherited by every process the
 * agent's `bash` tool spawns — and that silently breaks any XDG-respecting CLI:
 *
 *   - `gh` reads $XDG_CONFIG_HOME/gh/hosts.yml to learn which hosts exist
 *     *before* it consults the keychain, so with the pin in place
 *     `gh auth status` reports "not logged into any GitHub hosts" on a
 *     perfectly authenticated machine.
 *   - `helm` relocates HELM_CONFIG_HOME/CACHE/DATA, so repo lists and chart
 *     caches come back empty.
 *
 * The fix is `opencode-plugin/xdg-passthrough.js`, a bundled OpenCode plugin
 * whose `shell.env` hook puts the host's real values back for child processes
 * only. OpenCode reads XDG_* once at startup, so its own isolation is
 * untouched. This module produces the snapshot that plugin consumes.
 *
 * Pure so it is unit-testable without vscode.
 */

/** The variables `buildEnv` overrides, and therefore the ones to hand back. */
export const HOST_XDG_VARS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const;

/**
 * Env var carrying the snapshot to the plugin. The plugin is plain JS loaded by
 * OpenCode's own runtime and cannot import this module, so it hardcodes the
 * same name — the two must be changed together.
 */
export const HOST_XDG_ENV = 'LMSTUDIO_CODE_HOST_XDG';

/** A host value, or null when the variable was unset before we pinned ours. */
export type HostXdgSnapshot = Record<string, string | null>;

/**
 * Capture the host's XDG_* values. Must be called BEFORE the pinned values are
 * applied, i.e. against the extension host's own `process.env`.
 *
 * `null` (rather than an omitted key, or '') records "unset on the host", which
 * the plugin turns back into a *deleted* key. That distinction is load-bearing:
 * an empty XDG_CONFIG_HOME is not the same as an absent one — a tool that joins
 * it blindly would look in `/gh` instead of `~/.config/gh`. An explicitly empty
 * host value is preserved as '' for the same reason.
 */
export function snapshotHostXdg(env: NodeJS.ProcessEnv): HostXdgSnapshot {
  const out: HostXdgSnapshot = {};
  for (const name of HOST_XDG_VARS) {
    out[name] = env[name] ?? null;
  }
  return out;
}

// ---- stdio MCP servers -----------------------------------------------------
// The plugin above only covers the `bash`/pty paths. OpenCode spawns stdio MCP
// servers separately, and they inherit the pinned dirs too. The lever there is
// the per-server `environment` map, which was verified to MERGE with the
// server's environment rather than replace it (PATH and HOME survive), so
// setting it cannot strip a server's environment.

/** Fallback locations from the XDG base directory spec. */
const XDG_DEFAULTS: Record<(typeof HOST_XDG_VARS)[number], string[]> = {
  XDG_DATA_HOME: ['.local', 'share'],
  XDG_CONFIG_HOME: ['.config'],
  XDG_CACHE_HOME: ['.cache'],
  XDG_STATE_HOME: ['.local', 'state'],
};

/**
 * Concrete XDG values to hand to stdio MCP servers.
 *
 * Unlike the shell snapshot this cannot express "unset" — `environment` is a
 * map of strings — so an unset (or empty) host variable becomes the spec's own
 * default, which is what a compliant tool resolves it to anyway. The spec
 * treats empty and absent identically, so we do too.
 *
 * `join` is injected so this stays free of `node:path` and testable on any
 * platform's separator.
 */
export function hostXdgForChildren(
  env: NodeJS.ProcessEnv,
  home: string,
  join: (...parts: string[]) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HOST_XDG_VARS) {
    const value = env[name];
    out[name] = value ? value : join(home, ...XDG_DEFAULTS[name]);
  }
  return out;
}

/**
 * Layer those values onto every stdio MCP server in a discovered map.
 *
 * A server's own `environment` wins: if someone deliberately pointed an MCP
 * server at a different XDG dir, that is a choice, not the pin leaking through.
 * Remote servers are untouched — they are not processes we spawn.
 */
export function withHostXdg<T extends { type: string; environment?: Record<string, string> }>(
  servers: Record<string, T>,
  xdg: Record<string, string>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [name, server] of Object.entries(servers)) {
    out[name] =
      server.type === 'local'
        ? { ...server, environment: { ...xdg, ...(server.environment ?? {}) } }
        : server;
  }
  return out;
}
