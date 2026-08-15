// True end-to-end tests for the issue #7 polling redesign: a fake LM Studio
// HTTP server runs in-process, the extension connects to it for real (including
// starting the bundled OpenCode server), and the assertions run against the
// fake's request log and the live webview.
//
// Named zz-* so this suite runs LAST: it drives a real connection whose health
// loop keeps running afterwards, and must not disturb the injection-driven
// suites.
import * as assert from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import * as helpers from './helpers';

const { openPanel, count, click, waitFor } = helpers;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Mode = 'ok' | 'hang';

/** Minimal LM Studio stand-in: greeting + model endpoints + a request log. */
class FakeLmStudio {
  private server: http.Server | undefined;
  private sockets = new Set<import('node:net').Socket>();
  private hung: http.ServerResponse[] = [];
  mode: Mode = 'ok';
  port = 0;
  log: { path: string; at: number }[] = [];

  async start(port = 0): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    this.log.push({ path, at: Date.now() });
    if (this.mode === 'hang') {
      this.hung.push(res); // never answer — the client's timeout must fire
      return;
    }
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    switch (path) {
      case '/lmstudio-greeting':
        return json({ lmstudio: true });
      case '/api/v1/models':
        return json({
          models: [
            {
              key: 'e2e/fake-model',
              type: 'llm',
              max_context_length: 8192,
              capabilities: { trained_for_tool_use: true },
              loaded_instances: [{ config: { context_length: 4096 } }],
            },
          ],
        });
      case '/api/v0/models':
        return json({ data: [] });
      case '/v1/models':
        return json({ data: [{ id: 'e2e/fake-model' }] });
      default:
        res.statusCode = 404;
        return void res.end('{}');
    }
  }

  /** Requests for `path` since `since` (ms timestamp). */
  countSince(path: string, since: number): number {
    return this.log.filter((e) => e.path === path && e.at >= since).length;
  }

  /** Release any hung responses (sockets die, in-flight fetches error out). */
  releaseHung(): void {
    for (const res of this.hung.splice(0)) {
      res.destroy();
    }
  }

  /** Stop listening AND sever pooled keep-alive sockets → ECONNREFUSED next. */
  async stop(): Promise<void> {
    this.releaseHung();
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) {
      s.destroy();
    }
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('polling e2e (issue #7)', function () {
  // Real connections, real OpenCode boot, real timers — generous budgets.
  this.timeout(120_000);

  const fake = new FakeLmStudio();
  let restore: { id: string; prevActiveId: string } | undefined;

  before(async function () {
    this.timeout(90_000);
    // Earlier suites leave their editor-tab panels (and thus bridges + health
    // loops) alive; their probes share this client's cache and would skew the
    // cadence assertions. Close them so exactly ONE bridge is polling.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(500);
    await fake.start();
    // 5s connected cadence (the minimum) so cadence assertions run fast.
    await vscode.workspace
      .getConfiguration('lmstudioCode')
      .update('healthCheckSeconds', 5, vscode.ConfigurationTarget.Global);
    restore = await vscode.commands.executeCommand(
      'lmstudioCode._test.useServer',
      `http://127.0.0.1:${fake.port}/v1`,
    );
    await openPanel();
    // Full real connect: upstream probe → OpenCode server boot → model load.
    await waitUntil(
      () => fake.countSince('/api/v1/models', 0) >= 1,
      60_000,
      'the extension to list models from the fake server (is bin/opencode present?)',
    );
    await waitFor('#model-btn', (n) => n === 1, 10_000);
  });

  after(async () => {
    if (restore) {
      await vscode.commands.executeCommand('lmstudioCode._test.restoreServer', restore);
    }
    await vscode.workspace
      .getConfiguration('lmstudioCode')
      .update('healthCheckSeconds', undefined, vscode.ConfigurationTarget.Global);
    // Leave the fake server running: the panel's health loop lives until the
    // host exits, and a dead upstream would spam reconnect churn into teardown.
  });

  it('connects using the auth-aware /v1/models probe', () => {
    assert.ok(
      fake.countSince('/v1/models', 0) >= 1,
      'doInit must validate via the OpenAI-compat models endpoint (auth-aware)',
    );
  });

  it('probes the cheap greeting endpoint on the configured cadence while idle', async () => {
    const since = Date.now();
    await sleep(13_000);
    const greetings = fake.countSince('/lmstudio-greeting', since);
    const authProbes = fake.countSince('/v1/models', since);
    assert.ok(greetings >= 2, `expected >=2 greeting probes in 13s at a 5s cadence, saw ${greetings}`);
    assert.strictEqual(authProbes, 0, 'a healthy connection must not re-probe /v1/models');
  });

  it('keeps the periodic model refresh far below the old 5s cadence', async () => {
    const since = Date.now();
    await sleep(16_000);
    const lists = fake.countSince('/api/v1/models', since);
    // Refresh runs every 3rd healthy tick (15s here) and is diff-guarded; the
    // old behavior was a listing every 15s PLUS a /v1/models every 5s.
    assert.ok(lists <= 2, `expected <=2 model listings in 16s, saw ${lists}`);
  });

  it('fast-polls the model list only while the picker is open', async () => {
    const openSince = Date.now();
    // Ensure-open rather than assume-toggle: a prior suite may have left the
    // menu open, in which case the first click closes it.
    assert.ok(await click('#model-btn'), 'model button should be clickable');
    try {
      await waitFor('#model-menu:not(.hidden)', (n) => n === 1, 1_500);
    } catch {
      assert.ok(await click('#model-btn'), 'model button should be clickable (retry)');
      await waitFor('#model-menu:not(.hidden)', (n) => n === 1, 5_000);
    }
    await sleep(9_500);
    const during = fake.countSince('/api/v1/models', openSince);
    assert.ok(during >= 2, `picker-open fast poll should list every ~4s, saw ${during} in 9.5s`);

    assert.ok(await click('#model-btn'), 'model button should close the menu');
    await waitFor('#model-menu:not(.hidden)', (n) => n === 0, 5_000);
    const closedSince = Date.now();
    await sleep(6_500);
    const after = fake.countSince('/api/v1/models', closedSince);
    assert.ok(after <= 1, `closing the picker must stop the fast poll, saw ${after} in 6.5s`);
  });

  it('tolerates slow probes without flipping offline (timeout hysteresis)', async function () {
    this.timeout(90_000);
    fake.mode = 'hang';
    await sleep(7_000);
    assert.strictEqual(
      await count('.conn-title'),
      0,
      'one or two slow probes must NOT pop the offline banner (issue #7 hiccup)',
    );
    // Three consecutive timeouts (~3s each on a 5s cadence) flip it eventually.
    await waitFor('.conn-title', (n) => n >= 1, 45_000);
  });

  it('recovers automatically once the server answers again', async function () {
    this.timeout(60_000);
    fake.mode = 'ok';
    fake.releaseHung();
    await waitFor('.conn-title', (n) => n === 0, 30_000);
  });

  it('flips offline promptly on a refused connection and recovers on restart', async function () {
    this.timeout(60_000);
    const port = fake.port;
    await fake.stop();
    // Refused (not slow) — no hysteresis, and the offline cadence is 5s.
    await waitFor('.conn-title', (n) => n >= 1, 20_000);
    await fake.start(port);
    await waitFor('.conn-title', (n) => n === 0, 30_000);
  });
});
