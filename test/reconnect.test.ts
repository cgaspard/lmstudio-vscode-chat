import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectResult, ReconnectEffects, SelfHealer } from '../src/core/reconnect';

// A controllable harness: a fake clock plus call counters, so every self-heal
// scenario is exercised deterministically without timers or real I/O.
type Maybe<T> = T | (() => T);
const val = <T>(v: Maybe<T>): T => (typeof v === 'function' ? (v as () => T)() : v);

function harness(opts: {
  reachable?: Maybe<boolean>;
  serverHealthy?: Maybe<boolean>;
  connected?: Maybe<boolean>;
  connectResult?: Maybe<ConnectResult>;
  refreshEvery?: number;
  start?: number;
}) {
  const calls = { goOffline: 0, connect: 0, reloadModels: 0 };
  let clock = opts.start ?? 1000;
  const fx: ReconnectEffects = {
    upstreamReachable: async () => val(opts.reachable ?? true),
    serverHealthy: () => val(opts.serverHealthy ?? true),
    isConnected: () => val(opts.connected ?? true),
    goOffline: () => void calls.goOffline++,
    connect: async () => {
      calls.connect++;
      return val(opts.connectResult ?? 'connected');
    },
    reloadModels: async () => void calls.reloadModels++,
  };
  const healer = new SelfHealer(fx, {
    refreshEvery: opts.refreshEvery ?? 3,
    backoff: { base: 1000, factor: 2, max: 30000 },
    now: () => clock,
  });
  return {
    healer,
    calls,
    setClock: (t: number) => (clock = t),
    advance: (d: number) => (clock += d),
  };
}

test('upstream going away shows the offline banner once, then stays quiet', async () => {
  const h = harness({ reachable: false, connected: true });
  assert.equal(await h.healer.tick(), 'go-offline');
  assert.equal(h.calls.goOffline, 1);

  const off = harness({ reachable: false, connected: false });
  assert.equal(await off.healer.tick(), 'none');
  assert.equal(off.calls.goOffline, 0);
});

test('reconnects + reloads models immediately when upstream returns', async () => {
  const h = harness({ reachable: true, connected: false, connectResult: 'connected' });
  assert.equal(await h.healer.tick(), 'reconnect');
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.reloadModels, 1); // <-- reload happens right after the reconnect
});

test('reconnects when the OpenCode server dies while upstream is up', async () => {
  const h = harness({ reachable: true, connected: true, serverHealthy: false, connectResult: 'connected' });
  assert.equal(await h.healer.tick(), 'reconnect');
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.reloadModels, 1);
});

test('reconnect() reloads models on success but not on failure', async () => {
  const ok = harness({ connectResult: 'connected' });
  assert.equal(await ok.healer.reconnect(), true);
  assert.equal(ok.calls.reloadModels, 1);

  const bad = harness({ connectResult: 'failed' });
  assert.equal(await bad.healer.reconnect(), false);
  assert.equal(bad.calls.reloadModels, 0);
});

test('failed reconnects back off and gate further attempts', async () => {
  const h = harness({ reachable: true, connected: false, connectResult: 'failed', start: 1000 });
  await h.healer.tick(); // attempt 1 @1000 -> nextAt = 1000 + 1000 = 2000
  assert.equal(h.calls.connect, 1);
  assert.equal(h.healer.nextReconnectAt, 2000);

  h.setClock(1500); // still inside the backoff window
  assert.equal(await h.healer.tick(), 'none');
  assert.equal(h.calls.connect, 1); // no new attempt

  h.setClock(2000); // window elapsed
  await h.healer.tick(); // attempt 2 -> nextAt = 2000 + 2000 = 4000
  assert.equal(h.calls.connect, 2);
  assert.equal(h.healer.nextReconnectAt, 4000);
});

test('backoff grows exponentially across consecutive failures', async () => {
  const h = harness({ connectResult: 'failed', start: 0 });
  await h.healer.reconnect();
  assert.equal(h.healer.reconnectAttempts, 1);
  assert.equal(h.healer.nextReconnectAt, 1000); // base
  await h.healer.reconnect();
  assert.equal(h.healer.nextReconnectAt, 2000); // base*2
  await h.healer.reconnect();
  assert.equal(h.healer.nextReconnectAt, 4000); // base*4
});

test('a successful reconnect clears the backoff', async () => {
  let attempt = 0;
  const h = harness({ connectResult: () => (++attempt <= 2 ? 'failed' : 'connected') });
  await h.healer.reconnect(); // fail 1
  await h.healer.reconnect(); // fail 2
  assert.ok(h.healer.reconnectAttempts > 0);
  await h.healer.reconnect(); // success
  assert.equal(h.healer.reconnectAttempts, 0);
  assert.equal(h.healer.nextReconnectAt, 0);
});

test('an upstream-down reconnect applies no backoff (poll recovers for free)', async () => {
  const h = harness({ connectResult: 'upstream-down' });
  assert.equal(await h.healer.reconnect(), false);
  assert.equal(h.healer.reconnectAttempts, 0);
  assert.equal(h.healer.nextReconnectAt, 0);
  assert.equal(h.calls.reloadModels, 0);
});

test('a connect() that throws is treated as a failure', async () => {
  const calls = { n: 0 };
  const fx: ReconnectEffects = {
    upstreamReachable: async () => true,
    serverHealthy: () => false,
    isConnected: () => false,
    goOffline: () => {},
    connect: async () => {
      calls.n++;
      throw new Error('boom');
    },
    reloadModels: async () => {},
  };
  const healer = new SelfHealer(fx, { now: () => 0, backoff: { base: 1000 } });
  assert.equal(await healer.reconnect(), false);
  assert.equal(calls.n, 1);
  assert.equal(healer.reconnectAttempts, 1);
});

test('allowImmediate() bypasses an active backoff window', async () => {
  const h = harness({ reachable: true, connected: false, connectResult: 'failed', start: 1000 });
  await h.healer.tick(); // nextAt -> 2000
  h.setClock(1500);
  assert.equal(await h.healer.tick(), 'none'); // gated
  h.healer.allowImmediate(); // nextAt -> 1500 (now)
  assert.equal(await h.healer.tick(), 'reconnect');
});

test('models refresh only on the cadence tick while healthy', async () => {
  const h = harness({ refreshEvery: 3 });
  assert.equal(await h.healer.tick(), 'none'); // 1
  assert.equal(await h.healer.tick(), 'none'); // 2
  assert.equal(await h.healer.tick(), 'refresh-models'); // 3
  assert.equal(h.calls.reloadModels, 1);
  assert.equal(await h.healer.tick(), 'none'); // 4
  assert.equal(await h.healer.tick(), 'none'); // 5
  assert.equal(await h.healer.tick(), 'refresh-models'); // 6
  assert.equal(h.calls.reloadModels, 2);
});

test('refreshEvery=0 disables periodic refresh', async () => {
  const h = harness({ refreshEvery: 0 });
  for (let i = 0; i < 5; i++) {
    assert.equal(await h.healer.tick(), 'none');
  }
  assert.equal(h.calls.reloadModels, 0);
});

test('offline takes priority over the refresh cadence', async () => {
  const h = harness({ reachable: false, connected: true, refreshEvery: 3 });
  await h.healer.tick();
  await h.healer.tick();
  assert.equal(await h.healer.tick(), 'go-offline'); // tick 3 would refresh, but upstream is down
  assert.equal(h.calls.reloadModels, 0);
});
