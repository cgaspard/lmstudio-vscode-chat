import * as vscode from 'vscode';
import { ChatBridge, BridgeDeps } from './bridge';

function nonceStr(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
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
    this.bridge = new ChatBridge(view.webview, this.deps);
    this.bridge.setTitleSink((t) => {
      view.title = t;
    });
    view.onDidDispose(() => this.bridge?.dispose());
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
  panel.onDidDispose(() => bridge.dispose());
  return panel;
}
