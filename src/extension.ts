import * as vscode from 'vscode';
import { getConfig } from './config';
import { ServerRegistry } from './connection';
import { LMStudioClient } from './lmstudio/client';
import { initLogger, log, showLogs } from './logger';
import { OpencodeServerManager } from './opencode/serverManager';
import { BridgeDeps } from './panel/bridge';
import { attachTestWebview, registerTestCommands } from './test-integration/testHook';
import { ChatViewProvider, openChatPanel } from './panel/chatViewProvider';

// Injected by esbuild `define`: true in test builds, false (dead-code-stripped)
// in production.
declare const __TEST__: boolean;

let server: OpencodeServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  log('activating LM Studio Code');

  const cfg = getConfig();
  const servers = new ServerRegistry(context, cfg.lmStudioBaseUrl);
  const lmStudio = new LMStudioClient(servers.active().url);
  // Bundled binary lives under the extension dir; the managed server's on-disk
  // state is sandboxed under globalStorage so it never collides with a user's
  // own OpenCode install.
  const dataDir = vscode.Uri.joinPath(context.globalStorageUri, 'opencode').fsPath;
  server = new OpencodeServerManager(cfg, lmStudio, context.extensionPath, dataDir);

  const deps: BridgeDeps = { context, server, lmStudio, servers };

  // The `secondarySidebar` viewsContainers slot needs VS Code >= 1.106. On
  // older builds, flip this context key so the activitybar fallback shows
  // instead (same approach the Claude Code / Codex extensions use).
  const [major, minor] = vscode.version.split('.').map((n) => Number(n));
  const supportsSecondarySidebar = major > 1 || (major === 1 && minor >= 106);
  if (!supportsSecondarySidebar) {
    void vscode.commands.executeCommand(
      'setContext',
      'lmstudioCode:doesNotSupportSecondarySidebar',
      true,
    );
  }

  // Register a provider for both the activitybar fallback view and the
  // secondary-sidebar view; only one is active at a time via `when` clauses.
  const providerPrimary = new ChatViewProvider(context.extensionUri, deps);
  const providerSecondary = new ChatViewProvider(context.extensionUri, deps);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('lmstudioCode.chat', providerPrimary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('lmstudioCode.chatSecondary', providerSecondary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  const provider = { newChat: () => { providerPrimary.newChat(); providerSecondary.newChat(); }, showHistory: () => { providerPrimary.showHistory(); providerSecondary.showHistory(); } };

  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudioCode.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('lmstudioCode.history', () => provider.showHistory()),
    vscode.commands.registerCommand('lmstudioCode.focus', () =>
      vscode.commands.executeCommand('lmstudioCode.chat.focus'),
    ),
    vscode.commands.registerCommand('lmstudioCode.openInTab', () =>
      openChatPanel(context.extensionUri, deps),
    ),
    vscode.commands.registerCommand('lmstudioCode.showLogs', () => showLogs()),
    vscode.commands.registerCommand('lmstudioCode.restartServer', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restarting OpenCode server…' },
        async () => {
          try {
            await server!.restart();
            vscode.window.showInformationMessage('LM Studio Code: OpenCode server restarted.');
          } catch (err) {
            vscode.window.showErrorMessage(
              `LM Studio Code: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      );
    }),
  );

  // Restart the server if relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('lmstudioCode.lmStudioBaseUrl') ||
        e.affectsConfiguration('lmstudioCode.opencodePath') ||
        e.affectsConfiguration('lmstudioCode.serverPort') ||
        // MCP servers are baked into the injected config at spawn time, so a
        // change to ours — or VS Code's shared `mcp` setting — needs a respawn
        // to take effect. (On-disk .mcp.json / .vscode/mcp.json edits are picked
        // up by the "Restart OpenCode Server" command.)
        e.affectsConfiguration('lmstudioCode.mcpServers') ||
        e.affectsConfiguration('mcp')
      ) {
        log('relevant configuration changed; restarting server on next use');
        server?.dispose();
      }
    }),
  );

  // Integration-test seam (stripped from production builds via __TEST__).
  // Opens a chat panel on demand and exposes it to the test commands so the
  // suite can drive + inspect the live webview.
  if (__TEST__) {
    registerTestCommands(context);
    context.subscriptions.push(
      vscode.commands.registerCommand('lmstudioCode._test.openPanel', () => {
        const panel = openChatPanel(context.extensionUri, deps);
        attachTestWebview(panel.webview);
      }),
    );
  }
}

export function deactivate(): void {
  server?.dispose();
}
