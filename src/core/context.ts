/**
 * Context-window math shared by the bridge (server-side clamping), the OpenCode
 * server config, and the webview (presets + meter). Pure so it is unit-testable
 * and browser-safe.
 */

/**
 * Clamp a requested context window to a model's real maximum, so we never ask
 * LM Studio to load — or tell OpenCode to assume — more context than the model
 * actually supports. Falls back gracefully when either value is missing.
 */
export function clampContext(requested: number, modelMax?: number): number {
  const req = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  const cap = modelMax && Number.isFinite(modelMax) && modelMax > 0 ? Math.floor(modelMax) : 0;
  if (!req) {
    return cap;
  }
  if (!cap) {
    return req;
  }
  return Math.max(1, Math.min(req, cap));
}

const BASE_PRESETS = [8192, 16384, 32768, 65536, 131072, 262144];

/**
 * Context-window presets to offer in the picker, filtered to the model's max
 * (and always including the exact max). Sorted ascending, de-duplicated. When
 * the max is unknown we assume a generous 128K so the picker still works.
 */
export function contextPresets(modelMax?: number): number[] {
  const max = modelMax && Number.isFinite(modelMax) && modelMax > 0 ? Math.floor(modelMax) : 131072;
  const set = new Set(BASE_PRESETS.filter((v) => v <= max));
  set.add(max);
  return [...set].sort((a, b) => a - b);
}

/** 1024-base token formatting: 32768 -> "32K", 131072 -> "128K", 1.5M -> "1.5M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }
  if (n >= 1024 * 1024) {
    return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (n >= 1024) {
    return Math.round(n / 1024) + 'K';
  }
  return String(Math.round(n));
}

export interface WindowModel {
  /** The loaded context window, when the model is currently loaded. */
  contextLength?: number;
  /** The model's own maximum context window. */
  maxContextLength?: number;
}

/**
 * The context window to display in the meter: the loaded window if the model is
 * loaded, otherwise the window we would load it at — min(configured, model max)
 * — so it tracks the selected model rather than a single hard-coded number.
 */
export function computeWindow(model: WindowModel | undefined, minContext: number): number {
  const min = Number.isFinite(minContext) && minContext > 0 ? minContext : 0;
  if (!model) {
    return min;
  }
  if (model.contextLength && model.contextLength > 0) {
    return model.contextLength;
  }
  if (model.maxContextLength && model.maxContextLength > 0) {
    return Math.min(min || model.maxContextLength, model.maxContextLength);
  }
  return min;
}
