// Loads the embedded OpenCode engine (opencode-sdk/sdk.mjs, built by
// scripts/build-opencode-sdk.js) and creates hosts from it. OpenCode runs inside
// the extension host: no server process, no port, no password.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rearmLegacyMigration } from '../core/legacy';
import { log, logError } from '../logger';

/**
 * The per-extension symbol sdk.mjs reads its global roots from (patched in at
 * build time). Must match ROOTS_KEY in scripts/build-opencode-sdk.js. Each
 * sibling extension bundles its own copy of the engine and uses its own key, so
 * two extensions in one host never share state.
 */
export const SDK_ROOTS_KEY = 'lmstudioCode.roots';

/** The subset of the SDK host this extension calls. The SDK has no CJS types we can import. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkHost = any;

interface SdkModule {
  OpenCode: { create(options?: unknown, embed?: unknown): Promise<SdkHost> };
}

export interface EmbeddedPaths {
  /** Private root for everything the engine writes (config, data, cache, state, db). */
  root: string;
}

let loaded: Promise<SdkModule> | undefined;

/**
 * Import sdk.mjs once. Its global roots are captured at module evaluation, so
 * they must be in place before the first import and are fixed for the lifetime
 * of the extension host — which is why they derive from the (stable) private
 * data dir rather than anything that can change at runtime.
 */
function loadSdk(extensionPath: string, paths: EmbeddedPaths): Promise<SdkModule> {
  if (!loaded) {
    const file = path.join(extensionPath, 'opencode-sdk', 'sdk.mjs');
    if (!fs.existsSync(file)) {
      return Promise.reject(
        new Error(`The embedded OpenCode engine is missing (${file}). Reinstall the extension.`),
      );
    }
    (globalThis as Record<symbol, unknown>)[Symbol.for(SDK_ROOTS_KEY)] = rootsFor(paths);
    // A non-literal specifier keeps esbuild from rewriting this into require(),
    // which cannot load an ES module.
    const url = pathToFileURL(file).href;
    loaded = (import(url) as Promise<SdkModule>).catch((err) => {
      loaded = undefined; // let a later start retry (e.g. after a reinstall)
      throw err;
    });
  }
  return loaded;
}

/**
 * Re-arm OpenCode 2's 1.x migration when 1.x wrote sessions it has not seen
 * (see src/core/legacy.ts). Runs before the engine opens the file. Best effort:
 * a failure here costs history, never the panel.
 */
function resyncLegacyHistory(dbPath: string): void {
  if (!fs.existsSync(dbPath)) {
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const outcome = rearmLegacyMigration(db);
      if (outcome === 'rearmed') {
        log('1.x sessions changed since the last sync; OpenCode will re-import them');
      }
    } finally {
      db.close();
    }
  } catch (err) {
    logError('could not check 1.x session history', err);
  }
}

function rootsFor(paths: EmbeddedPaths): Record<string, string> {
  return {
    data: path.join(paths.root, 'data'),
    cache: path.join(paths.root, 'cache'),
    config: path.join(paths.root, 'config'),
    state: path.join(paths.root, 'state'),
  };
}

/**
 * Create an embedded OpenCode host with this extension's config.
 *
 * Isolation from the user's own OpenCode install:
 *  - `config.directory` points the global config dir at our private folder, so
 *    ~/.config/opencode/opencode.json (its MCP servers, providers) never loads;
 *  - the database and every global path live under `paths.root`.
 * What the panel deliberately shares, as it always has: the workspace's own
 * `.opencode/` (agents, commands, skills) via `config.project`, and Claude
 * Code's `.claude/` skills (global and project) via `config.claude`.
 */
export async function createHost(
  extensionPath: string,
  paths: EmbeddedPaths,
  configContent: string,
): Promise<SdkHost> {
  const sdk = await loadSdk(extensionPath, paths);
  const roots = rootsFor(paths);
  for (const dir of Object.values(roots)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The same file the 1.x server used (it ran with XDG_DATA_HOME=<root>/data).
  // OpenCode 2 migrates 1.x sessions found in it, so chat history survives the
  // upgrade; a fresh path would silently start everyone from empty.
  const dbPath = path.join(roots.data, 'opencode', 'opencode.db');
  // OpenCode creates the database file (to restrict it to the owner) while it
  // is still creating its own data folder, concurrently: on a first start the
  // file can lose that race and fail with ENOENT. Make the folder first.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  resyncLegacyHistory(dbPath);
  return sdk.OpenCode.create({
    app: { name: 'lmstudio-vscode-chat' },
    database: { path: dbPath },
    config: {
      content: configContent,
      directory: path.join(roots.config, 'opencode'),
      project: true,
      claude: true,
    },
  });
}
