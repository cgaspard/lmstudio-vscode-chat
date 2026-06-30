/**
 * MCP (Model Context Protocol) server discovery + normalization.
 *
 * OpenCode supports MCP servers natively via the `mcp` key of its config, which
 * we already inject through OPENCODE_CONFIG_CONTENT. The job of this module is to
 * gather servers the user has *already* declared elsewhere — so they don't have
 * to re-enter them — and normalize every source into OpenCode's exact shape:
 *
 *   mcp: {
 *     "<name>": { type: "local",  command: [cmd, ...args], environment?, enabled? }
 *     "<name>": { type: "remote", url, headers?, enabled? }
 *   }
 *
 * Sources, in increasing precedence (later overrides earlier on name collision):
 *   1. `.mcp.json` at the workspace root      — the Claude Code project format
 *   2. `.vscode/mcp.json` at the workspace     — the VS Code workspace format
 *   3. VS Code user settings `mcp.servers`     — the VS Code user format
 *   4. `lmstudioCode.mcpServers` setting       — our own explicit override
 *
 * This file is pure (no vscode / no fs / no logger): it takes already-read
 * source objects and returns the merged OpenCode map, so it is fully
 * unit-testable. The thin filesystem/settings loader lives in
 * `src/mcp/discovery.ts`.
 */

// ---- OpenCode's target shape (a subset of its config schema) -------------

export interface OpencodeLocalMcp {
  type: 'local';
  /** Full argv: [executable, ...args]. */
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

export interface OpencodeRemoteMcp {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export type OpencodeMcp = OpencodeLocalMcp | OpencodeRemoteMcp;

export type OpencodeMcpMap = Record<string, OpencodeMcp>;

// ---- Source shapes we accept and normalize -------------------------------
// We accept the union of the Claude Code (.mcp.json), VS Code (.vscode/mcp.json
// + settings), and native-OpenCode field names, and coerce them all. Anything
// unrecognized is dropped (logged), never injected, so a malformed entry can't
// crash the server spawn.

/** One server entry in any supported source format. Intentionally loose. */
export interface RawMcpEntry {
  // discriminators / transport
  type?: string; // "local" | "remote" | "stdio" | "http" | "sse" (any source)
  // stdio (Claude Code / VS Code): command is a STRING, args separate
  command?: string | string[];
  args?: string[];
  env?: Record<string, string>;
  environment?: Record<string, string>; // OpenCode-native name
  cwd?: string;
  // remote
  url?: string;
  headers?: Record<string, string>;
  // common
  enabled?: boolean;
  [k: string]: unknown;
}

export interface DiscoveredSources {
  /** Parsed `.mcp.json` (Claude Code): `{ mcpServers: {...} }`. */
  claudeProject?: unknown;
  /** Parsed `.vscode/mcp.json` (VS Code workspace): `{ servers: {...} }`. */
  vscodeWorkspace?: unknown;
  /** VS Code user setting `mcp` value: `{ servers: {...} }` (or just a map). */
  vscodeUser?: unknown;
  /** Our own `lmstudioCode.mcpServers` setting: a map of name -> entry. */
  explicit?: unknown;
}

/** Pull the `{ name: entry }` map out of a source object, tolerating shapes. */
function entriesOf(source: unknown, key?: 'mcpServers' | 'servers'): Record<string, RawMcpEntry> {
  if (!source || typeof source !== 'object') {
    return {};
  }
  const obj = source as Record<string, unknown>;
  // Prefer the wrapped key when present (mcpServers / servers); otherwise treat
  // the object itself as the map (our explicit setting form).
  let map: unknown = obj;
  if (key && obj[key] && typeof obj[key] === 'object') {
    map = obj[key];
  } else if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    map = obj.mcpServers;
  } else if (obj.servers && typeof obj.servers === 'object') {
    map = obj.servers;
  }
  if (!map || typeof map !== 'object') {
    return {};
  }
  const out: Record<string, RawMcpEntry> = {};
  for (const [name, val] of Object.entries(map as Record<string, unknown>)) {
    if (val && typeof val === 'object') {
      out[name] = val as RawMcpEntry;
    }
  }
  return out;
}

/** True for the remote/http/sse transports; everything else is treated local. */
function isRemote(entry: RawMcpEntry): boolean {
  const t = (entry.type ?? '').toLowerCase();
  if (t === 'remote' || t === 'http' || t === 'sse') {
    return true;
  }
  if (t === 'local' || t === 'stdio') {
    return false;
  }
  // No explicit type: infer from fields. A `url` with no `command` is remote.
  return !!entry.url && !entry.command;
}

function cleanStringMap(m: unknown): Record<string, string> | undefined {
  if (!m || typeof m !== 'object') {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else if (v != null) {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Normalize one source entry (any supported format) into OpenCode's shape, or
 * null if it's too malformed to inject (e.g. a local server with no command, a
 * remote with no url). `enabled: false` is preserved so a disabled server is
 * declared-but-off, matching OpenCode's own semantics.
 */
export function normalizeEntry(name: string, entry: RawMcpEntry): OpencodeMcp | null {
  if (isRemote(entry)) {
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!url) {
      return null; // remote server with no url — unusable, drop it
    }
    const out: OpencodeRemoteMcp = { type: 'remote', url };
    const headers = cleanStringMap(entry.headers);
    if (headers) {
      out.headers = headers;
    }
    if (entry.enabled === false) {
      out.enabled = false;
    }
    return out;
  }

  // Local / stdio. Build a single argv array from either `command` (string or
  // array) plus optional `args`. OpenCode wants the executable and its args in
  // one `command` array.
  let command: string[];
  if (Array.isArray(entry.command)) {
    command = entry.command.filter((x): x is string => typeof x === 'string');
  } else if (typeof entry.command === 'string' && entry.command.trim()) {
    command = [entry.command.trim()];
  } else {
    command = [];
  }
  if (Array.isArray(entry.args)) {
    command = command.concat(entry.args.filter((x): x is string => typeof x === 'string'));
  }
  if (!command.length) {
    return null; // local server with no command — unusable, drop it
  }
  const out: OpencodeLocalMcp = { type: 'local', command };
  // Accept both `env` (Claude Code / VS Code) and `environment` (OpenCode).
  const environment = cleanStringMap(entry.environment ?? entry.env);
  if (environment) {
    out.environment = environment;
  }
  if (typeof entry.cwd === 'string' && entry.cwd.trim()) {
    out.cwd = entry.cwd.trim();
  }
  if (entry.enabled === false) {
    out.enabled = false;
  }
  return out;
}

/**
 * Merge all discovered sources into a single OpenCode `mcp` map. Later sources
 * override earlier ones on a name collision (explicit setting wins). Returns an
 * empty object when nothing is configured (caller then omits the `mcp` key).
 */
export function buildMcpConfig(sources: DiscoveredSources): OpencodeMcpMap {
  const ordered: Array<Record<string, RawMcpEntry>> = [
    entriesOf(sources.claudeProject, 'mcpServers'),
    entriesOf(sources.vscodeWorkspace, 'servers'),
    entriesOf(sources.vscodeUser, 'servers'),
    entriesOf(sources.explicit),
  ];
  const merged: OpencodeMcpMap = {};
  for (const group of ordered) {
    for (const [name, entry] of Object.entries(group)) {
      const normalized = normalizeEntry(name, entry);
      if (normalized) {
        merged[name] = normalized; // later source overrides earlier
      }
    }
  }
  return merged;
}

/** Count of enabled (i.e. not explicitly disabled) servers, for status/logging. */
export function countEnabled(map: OpencodeMcpMap): number {
  return Object.values(map).filter((s) => s.enabled !== false).length;
}

/**
 * Expand `${VAR}` / `$VAR` references in a string against an env map. The
 * Claude Code `.mcp.json` and VS Code `mcp.json` formats let users reference
 * environment variables in `env` values and remote `headers` (e.g. an API key).
 *
 * Why this matters here: OpenCode normally resolves `{env:VAR}` tokens itself,
 * but only for config read from DISK — config injected via OPENCODE_CONFIG_CONTENT
 * is NOT token-substituted (OpenCode #13219). Since we inject in-memory, we must
 * resolve these to literals ourselves before handing the JSON to the server, or
 * an MCP server's auth header / env would arrive as the literal text `${VAR}`.
 *
 * Unknown variables expand to '' (matching shell semantics) so a missing secret
 * fails loudly at the server rather than leaking the token name into a request.
 */
export function expandVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
    const name = braced ?? bare;
    return env[name] ?? '';
  });
}

/** Apply expandVars across every string value of a `Record<string,string>`. */
function expandMap(
  m: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!m) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    out[k] = expandVars(v, env);
  }
  return out;
}

/**
 * Resolve `${VAR}` references in a normalized server's env/headers/command to
 * literal values, so the injected OPENCODE_CONFIG_CONTENT carries real secrets
 * rather than unresolved tokens. Returns a new object; does not mutate input.
 */
export function resolveServerVars(
  server: OpencodeMcp,
  env: Record<string, string | undefined>,
): OpencodeMcp {
  if (server.type === 'remote') {
    return {
      ...server,
      url: expandVars(server.url, env),
      ...(server.headers ? { headers: expandMap(server.headers, env)! } : {}),
    };
  }
  return {
    ...server,
    command: server.command.map((c) => expandVars(c, env)),
    ...(server.environment ? { environment: expandMap(server.environment, env)! } : {}),
    ...(server.cwd ? { cwd: expandVars(server.cwd, env) } : {}),
  };
}

/** Resolve `${VAR}` references across an entire MCP map. */
export function resolveMapVars(
  map: OpencodeMcpMap,
  env: Record<string, string | undefined>,
): OpencodeMcpMap {
  const out: OpencodeMcpMap = {};
  for (const [name, server] of Object.entries(map)) {
    out[name] = resolveServerVars(server, env);
  }
  return out;
}

/**
 * Augment a PATH string with the common locations where `node`/`npx`/`uvx`/
 * `bunx` live, so stdio MCP servers can be spawned even when the VS Code
 * extension host was launched from a GUI context with a minimal PATH (the #1
 * reason `command: ["npx", ...]` MCP servers fail to start). Pure: takes the
 * current PATH + a home dir, returns the augmented PATH (de-duplicated, existing
 * entries kept first so a user's own toolchain still wins).
 */
export function augmentedPath(
  currentPath: string | undefined,
  home: string,
  sep: string,
  extra: string[] = [],
): string {
  const common =
    sep === ';'
      ? [`${home}\\AppData\\Roaming\\npm`, `${home}\\.bun\\bin`, `${home}\\.local\\bin`]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          `${home}/.local/bin`,
          `${home}/.bun/bin`,
          `${home}/.cargo/bin`,
          `${home}/.nvm/current/bin`,
          `${home}/.volta/bin`,
        ];
  const existing = (currentPath ?? '').split(sep).filter(Boolean);
  const seen = new Set(existing);
  const added: string[] = [];
  for (const dir of [...extra, ...common]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      added.push(dir);
    }
  }
  return [...existing, ...added].join(sep);
}
