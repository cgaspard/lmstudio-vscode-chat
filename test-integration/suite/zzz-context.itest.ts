// True end-to-end test for the context window, against the REAL LM Studio on
// this machine. It needs a running LM Studio with at least one model and FAILS
// (rather than skips) without one — a green run has to mean the round trip
// really happened. CI only runs `npm test`, so this never runs there.
//
// Background: the picker used to offer context sizes, and picking one was a
// lie in two layers. The click never reached LM Studio at all (it persisted a
// setting and restarted OpenCode), and even when it did, LM Studio ignored it:
// `context_length` on /api/v1/models/load is accepted and then dropped on
// 0.3.3x — verified here by loading with `lms load -c 4096` and completing a
// 12,010-token prompt on it. The size control is gone; LM Studio owns the
// window, and everything downstream reports what it actually holds.
//
// Named zzz-* so it runs last (see the zz-* convention in zz-polling.itest.ts):
// it drives a real connection, which no injection-driven suite should have to
// share a webview with.
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { formatTokens } from '../../src/core/context';
import * as helpers from './helpers';

const { openPanel, count, text, click, waitFor } = helpers;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LiveModel {
  key: string;
  /** Last path segment — what the webview shows as the model name. */
  name: string;
  maxContext: number;
  loaded: boolean;
  /** The loaded instance's window (0 when not loaded). */
  context: number;
}

/** The REST root of the configured LM Studio (`/v1` stripped), e.g. :1234. */
function restRoot(): string {
  const raw = (
    vscode.workspace.getConfiguration('lmstudioCode').get<string>('lmStudioBaseUrl') ??
    'http://127.0.0.1:1234/v1'
  ).trim();
  return raw.replace(/\/+$/, '').replace(/\/v\d+$/, '');
}

/** Ask LM Studio directly — this is the source of truth the test asserts on. */
async function listLive(): Promise<LiveModel[]> {
  let json: { models?: any[] };
  try {
    const res = await fetch(`${restRoot()}/api/v1/models`, { signal: AbortSignal.timeout(8000) });
    assert.ok(res.ok, `LM Studio answered ${res.status} for /api/v1/models`);
    json = (await res.json()) as { models?: any[] };
  } catch (err) {
    throw new Error(
      `This suite talks to a live LM Studio at ${restRoot()} and could not reach it ` +
        `(${err instanceof Error ? err.message : String(err)}). Start LM Studio's server ` +
        `(with a model available) and re-run.`,
    );
  }
  return (json.models ?? [])
    .filter(
      (m) => m && typeof m.key === 'string' && !/embed/i.test(m.type ?? '') && !/embed/i.test(m.key),
    )
    .map((m) => {
      const instance = (m.loaded_instances ?? [])[0];
      return {
        key: m.key as string,
        name: (m.key as string).split('/').pop()!,
        maxContext: m.max_context_length ?? 0,
        loaded: !!instance,
        context: instance?.config?.context_length ?? 0,
      };
    });
}

describe('context window e2e (live LM Studio)', function () {
  // A cold model load can be slow; everything else here is cheap.
  this.timeout(300_000);

  let target: LiveModel;
  let prevDefaultModel: string | undefined;

  before(async function () {
    this.timeout(360_000);
    // Earlier suites leave editor-tab panels (and their bridges + health loops)
    // alive on a shared webview. Close them so exactly one bridge is driving.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(500);

    const live = await listLive();
    assert.ok(live.length > 0, `LM Studio at ${restRoot()} reports no non-embedding models.`);
    const loaded = live.find((m) => m.loaded);
    assert.ok(
      loaded,
      `No model is loaded in LM Studio. Load one (any size — LM Studio picks the ` +
        `window) and re-run; this suite asserts the UI matches the loaded window.`,
    );
    target = loaded;

    const cfg = vscode.workspace.getConfiguration('lmstudioCode');
    prevDefaultModel = cfg.get<string>('defaultModel');
    // A fresh panel resolves its model from defaultModel, so the bridge comes up
    // pointed at our target without any click-the-right-row guesswork.
    await cfg.update('defaultModel', target.key, vscode.ConfigurationTarget.Global);

    await openPanel();
    // Full real connect: LM Studio probe → OpenCode boot → model list.
    await waitFor('#model-btn', (n) => n === 1, 60_000);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await text('.model-btn-label'))?.startsWith(target.name)) {
      await sleep(500);
    }
    assert.ok(
      (await text('.model-btn-label'))?.startsWith(target.name),
      `the panel should come up on ${target.name} (is bin/opencode present?), ` +
        `got "${await text('.model-btn-label')}"`,
    );
  });

  after(async () => {
    await vscode.workspace
      .getConfiguration('lmstudioCode')
      .update('defaultModel', prevDefaultModel, vscode.ConfigurationTarget.Global);
  });

  it('the picker offers no context sizes — LM Studio owns the window', async () => {
    if ((await count('#model-menu:not(.hidden)')) === 0) {
      assert.ok(await click('#model-btn'), 'model button should be clickable');
      await waitFor('#model-menu:not(.hidden)', (n) => n === 1, 10_000);
    }
    // The reasoning-effort control shares the .ctx-preset class and must stay.
    await waitFor('#effort-presets .effort-dot', (n) => n > 0, 10_000);
    assert.strictEqual(await count('#ctx-presets'), 0, 'the context-size picker should be gone');
    assert.strictEqual(await count('#ctx-note'), 0, 'and with it the mismatch note');
    assert.strictEqual(await count('#ctx-presets .ctx-preset'), 0);
  });

  it('the model pill reports the window LM Studio actually holds', async () => {
    const applied = (await listLive()).find((m) => m.key === target.key)!.context;
    assert.ok(
      (await text('.model-btn-label'))?.endsWith(`· ${formatTokens(applied)}`),
      `pill should end with "· ${formatTokens(applied)}", got "${await text('.model-btn-label')}"`,
    );
  });

  it('the context meter measures against that same window', async () => {
    const applied = (await listLive()).find((m) => m.key === target.key)!.context;
    assert.match(
      (await text('.ctx-label')) ?? '',
      new RegExp(`/ ${formatTokens(applied)} · `),
      'the meter denominator must be the loaded window, not a configured number',
    );
  });
});
