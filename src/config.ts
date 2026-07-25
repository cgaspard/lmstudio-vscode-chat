import * as vscode from 'vscode';

// Re-exported from the pure core module so existing importers keep working
// while the implementation stays unit-testable without vscode.
export { lmStudioRestRoot } from './core/url';
import { ALL_LEVELS, type EffortLevel } from './core/effort';

/** Settings.json is hand-editable, so an unknown level must not reach the wire. */
function normalizeEffort(value: unknown): EffortLevel {
  return typeof value === 'string' && (ALL_LEVELS as string[]).includes(value)
    ? (value as EffortLevel)
    : 'auto';
}

export interface ExtensionConfig {
  lmStudioBaseUrl: string;
  opencodePath: string;
  serverPort: number;
  defaultModel: string;
  /** Default agent name. Free-form: user-defined agents are discovered at runtime. */
  agent: string;
  autoEnsureContext: boolean;
  minContextLength: number;
  gpuOffload: string;
  /** Connected-state health/model poll cadence, seconds (clamped 5–600). */
  healthCheckSeconds: number;
  /** Starting reasoning effort for models with no per-model choice stored. */
  defaultThinkingEffort: EffortLevel;
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
    agent: (cfg.get<string>('agent') ?? 'build').trim() || 'build',
    autoEnsureContext: cfg.get<boolean>('autoEnsureContext') ?? true,
    minContextLength: cfg.get<number>('minContextLength') ?? 32768,
    gpuOffload: (cfg.get<string>('gpuOffload') ?? 'max').trim(),
    healthCheckSeconds: clampSeconds(cfg.get<number>('healthCheckSeconds'), 30, 5, 600),
    defaultThinkingEffort: normalizeEffort(cfg.get<string>('defaultThinkingEffort')),
  };
}

/**
 * Clamp a user-supplied seconds value. `get<number>()` does not validate — a
 * hand-edited settings.json can deliver a string/NaN, and NaN sailing through
 * Math.min/max would become setTimeout(cb, NaN) ≈ a 1ms hot loop.
 */
function clampSeconds(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}
