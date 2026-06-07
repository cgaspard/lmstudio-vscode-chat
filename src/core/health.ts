/**
 * The self-healing policy, expressed as a pure decision function so the timing
 * loop in the bridge stays a thin shell and the reliability rules are covered
 * by unit tests.
 *
 * Two failure modes drive everything:
 *   1. LM Studio itself is unreachable (show the offline banner, wait for it).
 *   2. LM Studio is up but the OpenCode server died / we lost our client
 *      (silently restart + reconnect, with backoff so we don't hammer it).
 */

export interface HealthInputs {
  /** LM Studio /models reachable right now. */
  lmStudioOk: boolean;
  /** Whether the bridge currently considers LM Studio connected. */
  connected: boolean;
  /** OpenCode server process alive AND we hold a client for it. */
  serverHealthy: boolean;
  /** Current time (ms). */
  now: number;
  /** Earliest time we are allowed to attempt another reconnect (backoff gate). */
  nextReconnectAt: number;
  /** Poll tick counter (incremented every poll). */
  tick: number;
  /** Refresh the model list every N ticks while healthy (0 disables). */
  refreshEvery: number;
}

export type HealthAction = 'none' | 'go-offline' | 'reconnect' | 'refresh-models';

/**
 * Decide what the health poll should do this tick.
 *
 * - LM Studio down + we thought we were online  -> go-offline (show banner)
 * - LM Studio down + already offline            -> none (keep waiting)
 * - LM Studio up + not connected / server dead  -> reconnect (once backoff allows)
 * - LM Studio up + healthy, on a refresh tick   -> refresh-models
 * - otherwise                                    -> none
 */
export function decideHealthAction(i: HealthInputs): HealthAction {
  if (!i.lmStudioOk) {
    return i.connected ? 'go-offline' : 'none';
  }
  // LM Studio is reachable.
  if (!i.connected || !i.serverHealthy) {
    return i.now >= i.nextReconnectAt ? 'reconnect' : 'none';
  }
  if (i.refreshEvery > 0 && i.tick > 0 && i.tick % i.refreshEvery === 0) {
    return 'refresh-models';
  }
  return 'none';
}
