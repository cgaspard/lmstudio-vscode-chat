import * as vscode from 'vscode';

// Re-exported from the pure core module so existing importers keep working
// while the implementation stays unit-testable without vscode.
export { lmStudioRestRoot } from './core/url';

export interface ExtensionConfig {
  lmStudioBaseUrl: string;
  opencodePath: string;
  serverPort: number;
  defaultModel: string;
  agent: 'build' | 'plan';
  autoEnsureContext: boolean;
  minContextLength: number;
  gpuOffload: string;
}

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('lmstudioCode');
  let baseUrl = (cfg.get<string>('lmStudioBaseUrl') ?? 'http://127.0.0.1:1234/v1').trim();
  baseUrl = baseUrl.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(baseUrl)) {
    baseUrl = `${baseUrl}/v1`;
  }
  return {
    lmStudioBaseUrl: baseUrl,
    opencodePath: (cfg.get<string>('opencodePath') ?? '').trim(),
    serverPort: cfg.get<number>('serverPort') ?? 0,
    defaultModel: (cfg.get<string>('defaultModel') ?? '').trim(),
    agent: (cfg.get<string>('agent') as 'build' | 'plan') ?? 'build',
    autoEnsureContext: cfg.get<boolean>('autoEnsureContext') ?? true,
    minContextLength: cfg.get<number>('minContextLength') ?? 32768,
    gpuOffload: (cfg.get<string>('gpuOffload') ?? 'max').trim(),
  };
}
