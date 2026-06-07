/**
 * The self-healing reconnect state machine, extracted as a pure controller so
 * every reliability scenario is unit-testable without vscode, timers, or real
 * I/O. The bridge supplies the side-effects (measure reachability, connect,
 * reload models, show the offline banner); this owns the *policy*: when to
 * reconnect, how to back off, and the guarantee that models reload immediately
 * after a reconnect.
 */
import { BackoffOptions, nextDelay } from './backoff';
import { decideHealthAction, HealthAction } from './health';

/**
 * Outcome of a connect attempt:
 * - `connected`    — fully live (upstream reachable + OpenCode server healthy)
 * - `upstream-down`— LM Studio / Ollama itself is unreachable (no backoff; the
 *                    poll retries for free the moment it returns)
 * - `failed`       — upstream was reachable but bringing up OpenCode failed
 *                    (apply backoff so we don't respawn a broken server in a loop)
 */
export type ConnectResult = 'connected' | 'upstream-down' | 'failed';

export interface ReconnectEffects {
  /** Is the upstream (LM Studio / Ollama) reachable right now? */
  upstreamReachable(): Promise<boolean>;
  /** Is the OpenCode server process alive AND do we hold a client for it? */
  serverHealthy(): boolean;
  /** Whether we currently consider ourselves connected. */
  isConnected(): boolean;
  /** Show the offline banner (upstream went away). */
  goOffline(): void;
  /** (Re)establish the full connection; resolves to the outcome. */
  connect(): Promise<ConnectResult>;
  /** Push a fresh model list to the UI. */
  reloadModels(): Promise<void>;
}

export interface ReconnectConfig {
  /** Refresh the model list every N healthy ticks (0 disables). */
  refreshEvery?: number;
  /** Backoff curve for failed reconnects. */
  backoff?: BackoffOptions;
  /** Injectable clock (defaults to Date.now) so tests are deterministic. */
  now?: () => number;
}

export class SelfHealer {
  private attempts = 0;
  private nextAt = 0;
  private tickCount = 0;

  constructor(
    private readonly fx: ReconnectEffects,
    private readonly cfg: ReconnectConfig = {},
  ) {}

  /** Earliest time (ms) a backoff-gated reconnect is allowed again. */
  get nextReconnectAt(): number {
    return this.nextAt;
  }

  /** Number of consecutive failed reconnects (0 when healthy). */
  get reconnectAttempts(): number {
    return this.attempts;
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  /** Clear the backoff window after a clean connect / deliberate user action. */
  noteConnected(): void {
    this.attempts = 0;
    this.nextAt = 0;
  }

  /** Permit an immediate reconnect attempt (e.g. after an unexpected exit). */
  allowImmediate(): void {
    this.nextAt = this.now();
  }

  /**
   * Run one health-poll tick: measure reachability, decide via the pure policy,
   * and apply the side-effect. Returns the action taken (handy for tests/logs).
   */
  async tick(): Promise<HealthAction> {
    let reachable = false;
    try {
      reachable = await this.fx.upstreamReachable();
    } catch {
      reachable = false;
    }
    const action = decideHealthAction({
      lmStudioOk: reachable,
      connected: this.fx.isConnected(),
      serverHealthy: this.fx.serverHealthy(),
      now: this.now(),
      nextReconnectAt: this.nextAt,
      tick: ++this.tickCount,
      refreshEvery: this.cfg.refreshEvery ?? 3,
    });
    switch (action) {
      case 'go-offline':
        this.fx.goOffline();
        break;
      case 'reconnect':
        await this.reconnect();
        break;
      case 'refresh-models':
        await this.safeReload();
        break;
      case 'none':
        break;
    }
    return action;
  }

  /**
   * Attempt a (re)connect. On success: reset backoff and reload models
   * immediately. On a server failure: advance the backoff window. An
   * upstream-down result applies no backoff (the poll recovers for free).
   * Returns whether we ended up connected.
   */
  async reconnect(): Promise<boolean> {
    let result: ConnectResult;
    try {
      result = await this.fx.connect();
    } catch {
      result = 'failed';
    }
    if (result === 'connected') {
      this.attempts = 0;
      this.nextAt = 0;
      await this.safeReload(); // reload models immediately after a reconnect
      return true;
    }
    if (result === 'failed') {
      this.attempts++;
      this.nextAt = this.now() + nextDelay(this.attempts, this.cfg.backoff);
    }
    return false;
  }

  private async safeReload(): Promise<void> {
    try {
      await this.fx.reloadModels();
    } catch {
      /* a refresh failure is never fatal */
    }
  }
}
