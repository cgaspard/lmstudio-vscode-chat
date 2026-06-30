/**
 * Filesystem + VS Code settings loader for MCP servers. This is the thin,
 * side-effecting layer: it reads the on-disk / settings sources, hands them to
 * the pure `core/mcp` normalizer, resolves `${VAR}` references against the
 * extension-host environment, and returns the OpenCode `mcp` map to inject.
 *
 * Discovered sources (precedence low -> high; later wins on name collision):
 *   1. `<workspace>/.mcp.json`        — Claude Code project format ({ mcpServers })
 *   2. `<workspace>/.vscode/mcp.json` — VS Code workspace format  ({ servers })
 *   3. VS Code user setting `mcp`     — VS Code user format        ({ servers })
 *   4. `lmstudioCode.mcpServers`      — our own explicit override   (map or {servers})
 *
 * Sources 1–3 mean a user who already configured MCP for Claude Code or VS Code
 * Copilot gets those servers for free, with nothing to re-enter.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildMcpConfig,
  countEnabled,
  DiscoveredSources,
  OpencodeMcpMap,
  resolveMapVars,
} from '../core/mcp';
import { log, logError } from '../logger';

/** Parse a JSON file, returning undefined if it's missing or malformed. */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined; // not present — normal
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // Present but invalid — warn so the user knows their MCP file was ignored,
    // rather than silently dropping their servers.
    logError(`mcp: ${file} is not valid JSON — ignoring`, err);
    vscode.window.showWarningMessage(
      `LM Studio Code: ${vscode.workspace.asRelativePath(file)} is not valid JSON; its MCP servers were ignored.`,
    );
    return undefined;
  }
}

export interface McpDiscovery {
  /** The merged, var-resolved OpenCode `mcp` map (empty if nothing configured). */
  map: OpencodeMcpMap;
  /** Number of servers that will actually be started (enabled !== false). */
  enabledCount: number;
}

/**
 * Gather MCP servers from every supported source for the active workspace and
 * return the OpenCode `mcp` map to merge into OPENCODE_CONFIG_CONTENT. Reads are
 * best-effort: a missing or malformed source is skipped, never fatal.
 */
export function discoverMcpServers(): McpDiscovery {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const sources: DiscoveredSources = {};

  if (root) {
    sources.claudeProject = readJson(path.join(root, '.mcp.json'));
    sources.vscodeWorkspace = readJson(path.join(root, '.vscode', 'mcp.json'));
  }

  // VS Code stores user-level MCP servers under the `mcp` settings key
  // ({ servers: {...} }). Reading it via getConfiguration keeps us agnostic to
  // whether it lives in settings.json or the user mcp.json profile file.
  try {
    sources.vscodeUser = vscode.workspace.getConfiguration().get('mcp');
  } catch {
    // setting absent on older VS Code — fine
  }

  // Our own explicit setting (highest precedence): a map of name -> entry, or a
  // { servers: {...} } / { mcpServers: {...} } wrapper.
  try {
    sources.explicit = vscode.workspace.getConfiguration('lmstudioCode').get('mcpServers');
  } catch {
    // absent — fine
  }

  const merged = buildMcpConfig(sources);
  // Resolve ${VAR} references to literals: OPENCODE_CONFIG_CONTENT is not
  // token-substituted by OpenCode, so secrets in env/headers must be expanded
  // here against the extension-host environment.
  const map = resolveMapVars(merged, process.env);
  const enabledCount = countEnabled(map);

  const names = Object.keys(map);
  if (names.length) {
    log(`mcp: discovered ${names.length} server(s) [${names.join(', ')}], ${enabledCount} enabled`);
  }
  return { map, enabledCount };
}
