/**
 * Exponential backoff for reconnect attempts. Pure + deterministic (no jitter
 * by default) so the self-healing policy is easy to unit-test. Callers that
 * want jitter can add it on top.
 */

export interface BackoffOptions {
  /** Delay for the first attempt, in ms. */
  base?: number;
  /** Growth multiplier per attempt. */
  factor?: number;
  /** Hard cap, in ms. */
  max?: number;
}

/**
 * Delay (ms) before reconnect attempt `attempt` (1-based). attempt <= 1 returns
 * `base`; each subsequent attempt multiplies by `factor`, capped at `max`.
 */
export function nextDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.base ?? 1000;
  const factor = opts.factor ?? 2;
  const max = opts.max ?? 30000;
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const delay = base * Math.pow(factor, n - 1);
  if (!Number.isFinite(delay)) {
    return max;
  }
  return Math.min(max, Math.round(delay));
}
