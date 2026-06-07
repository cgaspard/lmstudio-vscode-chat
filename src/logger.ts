import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel('LM Studio Code');
  context.subscriptions.push(channel);
  return channel;
}

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  channel?.appendLine(line);
}

export function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err ? String(err) : '';
  log(`ERROR: ${message}${detail ? ` :: ${detail}` : ''}`);
}

export function showLogs(): void {
  channel?.show(true);
}
