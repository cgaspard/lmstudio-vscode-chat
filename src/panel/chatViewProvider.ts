import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ChatBridge, BridgeDeps } from './bridge';

function nonceStr(): string {
  // 32 bytes → ~43 base64 chars; strip non-alphanumerics and keep 32 so the
  // nonce is always full-length and CSP-safe. Math.random() is not a
  // cryptographic RNG and has no place generating a CSP nonce.
  return randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = nonceStr();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'),
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>LM Studio Code</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Sidebar (Activity Bar) webview view. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lmstudioCode.chat';
  private bridge: ChatBridge | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: BridgeDeps,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = getHtml(view.webview, this.extensionUri);
    // A view can be re-resolved (moved between sidebars, hide/show, layout
    // changes). Dispose any prior bridge first so we never leave a second
    // onDidReceiveMessage handler attached — otherwise one "send" fans out to
    // multiple prompt requests (duplicate replies).
    this.bridge?.dispose();
    const bridge = new ChatBridge(view.webview, this.deps);
    this.bridge = bridge;
    bridge.setTitleSink((t) => {
      view.title = t;
    });
    // Hidden views keep running (retainContextWhenHidden) — tell the bridge so
    // it can skip model refreshes while nobody is looking, and catch up on show.
    bridge.setVisible(view.visible);
    view.onDidChangeVisibility(() => bridge.setVisible(view.visible));
    view.onDidDispose(() => bridge.dispose()); // capture THIS bridge, not this.bridge
  }

  newChat(): void {
    void this.bridge?.requestNewChat();
  }

  showHistory(): void {
    this.bridge?.sendCommand('history');
  }
}

/** Open the chat as an editor tab (parallel conversation). */
export function openChatPanel(extensionUri: vscode.Uri, deps: BridgeDeps): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'lmstudioCode.chatPanel',
    'LM Studio Code',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],
    },
  );
  panel.webview.html = getHtml(panel.webview, extensionUri);
  const bridge = new ChatBridge(panel.webview, deps);
  bridge.setTitleSink((t) => {
    panel.title = t ? `LM Studio · ${t}` : 'LM Studio Code';
  });
  bridge.setVisible(panel.visible);
  panel.onDidChangeViewState(() => bridge.setVisible(panel.visible));
  panel.onDidDispose(() => bridge.dispose());
  return panel;
}
