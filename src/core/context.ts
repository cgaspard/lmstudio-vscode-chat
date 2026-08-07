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

/**
 * The context limit to declare to OpenCode for a model, so it compacts before
 * LM Studio overflows.
 *
 * The loaded window wins whenever we know it, because LM Studio — not us —
 * decides it: `context_length` on `/api/v1/models/load` is accepted and then
 * ignored on some builds (0.3.3x loads every model at its maximum, and so does
 * `lms load -c`). Declaring the window we *asked* for would have OpenCode
 * compacting against a number the server never agreed to. `configured` is only
 * the fallback for a model that isn't loaded yet.
 */
export function opencodeContextLimit(model: LoadedWindow, configured: number): number {
  const loaded = model.loadedContextLength;
  if (loaded && Number.isFinite(loaded) && loaded > 0) {
    return Math.floor(loaded);
  }
  return clampContext(configured, model.maxContextLength);
}

export interface LoadedWindow {
  loadedContextLength?: number;
  maxContextLength?: number;
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

export interface LoadedModelState {
  /** Whether LM Studio currently holds an instance of this model. */
  loaded: boolean;
  /** The loaded instance's context window (absent/0 when unknown). */
  loadedContext?: number;
  /** The model's own maximum context window. */
  maxContext?: number;
}

export interface ContextDecision {
  /** 'load' = load the model at `target`; 'none' = leave LM Studio alone. */
  action: 'load' | 'none';
  /** The window to ask for — always clamped to the model's real maximum. */
  target: number;
  reason: 'not-loaded' | 'below-floor' | 'satisfied' | 'no-target';
}

/**
 * Decide whether to (re)load a model before prompting it (`autoEnsureContext`).
 *
 * A floor — "at least this much" — never a setpoint. It loads an unloaded model
 * and grows a too-small one, but never shrinks: the window a model comes up
 * with is LM Studio's decision (its load API ignores `context_length` on some
 * builds), and treating it as ours would mean unloading the user's model before
 * every send to chase a number the server won't honor anyway.
 */
export function decideContextLoad(model: LoadedModelState, requested: number): ContextDecision {
  const target = clampContext(requested, model.maxContext);
  if (target <= 0) {
    // Neither a usable request nor a known maximum — nothing to ask for.
    return { action: 'none', target, reason: 'no-target' };
  }
  if (!model.loaded) {
    return { action: 'load', target, reason: 'not-loaded' };
  }
  const ctx = model.loadedContext && model.loadedContext > 0 ? model.loadedContext : 0;
  return ctx >= target
    ? { action: 'none', target, reason: 'satisfied' }
    : { action: 'load', target, reason: 'below-floor' };
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
