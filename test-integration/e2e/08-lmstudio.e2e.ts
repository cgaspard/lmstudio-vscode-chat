// LM Studio itself: load and eject from the model picker, the "Context on
// load" presets, the automatic context reload before a prompt, and several
// LM Studio servers with their own API keys. Everything that loads or ejects
// uses SMALL_MODEL (by default the suite's one small model), only ever through
// the panel.
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import {
  ask,
  cfg,
  closeModelMenu,
  freshChat,
  h,
  lmStudioModels,
  modelRow,
  openModelMenu,
  selectModel,
  sleep,
  SMALL_MODEL,
  until,
} from './lib';

async function small(): Promise<{ loaded: boolean; context: number }> {
  const m = (await lmStudioModels()).find((x) => x.key === SMALL_MODEL);
  assert.ok(m, `LM Studio has ${SMALL_MODEL}`);
  return m;
}

/** The small model's row action button (Load / Eject) in the open model menu. */
async function smallAction(): Promise<{ index: number; label: string }> {
  const index = await modelRow(SMALL_MODEL);
  await openModelMenu();
  const labels = await h.allText('#model-menu-list .model-row .model-action');
  return { index, label: labels[index] ?? '' };
}

/** The activity line while the panel loads, grows or ejects a model. */
async function busyStatus(): Promise<boolean> {
  return /Loading|Unloading/.test(String(await h.text('#activity .activity-label')));
}

const setMinContext = (tokens: number | undefined) =>
  cfg().update('minContextLength', tokens, vscode.ConfigurationTarget.Workspace);

describe('e2e · LM Studio', function () {
  after(async () => {
    await closeModelMenu().catch(() => undefined);
    await setMinContext(undefined);
  });

  it('Load in the model picker loads the model at the requested window', async () => {
    await freshChat();
    // Ask for 16K through the picker's own "Context on load" control. The
    // selected (big, already loaded) model has more than that, so nothing
    // reloads; the request applies to the next load.
    await openModelMenu();
    await until(async () => (await h.count('#ctx-presets .ctx-preset[data-tokens="16384"]')) > 0, 10_000, 'the presets');
    await h.click('#ctx-presets .ctx-preset[data-tokens="16384"]');
    await until(async () => cfg().get('minContextLength') === 16384, 10_000, 'the 16K request to be saved');
    await closeModelMenu();
    if ((await small()).loaded) {
      // Someone left it loaded: eject it through the picker first.
      const { index } = await smallAction();
      await h.click('#model-menu-list .model-row .model-action', index);
      await until(async () => !(await small()).loaded, 60_000, 'the small model to unload');
    }
    const { index, label } = await smallAction();
    assert.match(label, /Load/, `the row offers Load (${label})`);
    await h.click('#model-menu-list .model-row .model-action', index);
    // LM Studio lists an instance while it is still loading; the picker closes
    // itself once the load has really finished.
    await until(async () => (await h.count('#model-menu:not(.hidden)')) === 0, 300_000, 'the load to finish (the menu closes)');
    await until(async () => !(await busyStatus()), 300_000, 'the loading status to clear');
    assert.ok((await small()).loaded, 'LM Studio has the model loaded');
    assert.strictEqual((await small()).context, 16384, 'loaded with the window asked for');
    // Loading a model also makes it the active one: the chip names it with its window.
    await until(async () => /16K/.test(String(await h.text('#model-btn .model-btn-label'))), 30_000, 'the chip to show 16K');
    await openModelMenu();
    await until(async () => /Eject/.test((await h.allText('#model-menu-list .model-row .model-action'))[index] ?? ''), 30_000, 'the row to offer Eject');
    const meta = (await h.allText('#model-menu-list .model-row .model-meta'))[index];
    assert.match(meta, /loaded/, `the row reads as loaded (${meta})`);
    await closeModelMenu();
  });

  it('a "Context on load" preset grows the loaded model right away', async () => {
    await selectModel(SMALL_MODEL);
    await openModelMenu();
    await until(async () => (await h.count('#ctx-presets .ctx-preset[data-tokens="32768"]')) > 0, 10_000, 'the presets');
    await h.click('#ctx-presets .ctx-preset[data-tokens="32768"]');
    await until(async () => (await small()).context === 32768 && !(await busyStatus()), 300_000, 'LM Studio to reload at 32K');
    assert.strictEqual(cfg().get('minContextLength'), 32768, 'the choice is saved');
    await until(async () => /\bactive\b/.test(String(await h.attr('#ctx-presets .ctx-preset[data-tokens="32768"]', 'class'))), 10_000, 'the preset to read as active');
    await closeModelMenu();
  });

  it('a window too small for the agent is reloaded before the prompt goes out', async () => {
    // Raise the floor without touching the model: only a send applies it.
    await setMinContext(49152);
    await sleep(500);
    assert.strictEqual((await small()).context, 32768, 'still loaded at 32K before the prompt');
    await freshChat({ model: SMALL_MODEL });
    assert.match(await ask('Reply with exactly: CONTEXT-OK'), /CONTEXT-OK/);
    assert.ok((await small()).context >= 49152, `reloaded to at least 48K (${(await small()).context})`);
    await until(async () => /48K/.test(String(await h.text('#model-btn .model-btn-label'))), 30_000, 'the chip to show 48K');
  });

  it('Eject in the model picker unloads the model', async () => {
    const { index, label } = await smallAction();
    assert.match(label, /Eject/, `the row offers Eject (${label})`);
    await h.click('#model-menu-list .model-row .model-action', index);
    await until(async () => !(await small()).loaded, 60_000, 'LM Studio to unload the model');
    await until(async () => /Load/.test((await h.allText('#model-menu-list .model-row .model-action'))[index] ?? ''), 30_000, 'the row to offer Load again');
    await closeModelMenu();
    await setMinContext(undefined);
  });

  it('a second LM Studio server, added with an API key, serves the chat', async () => {
    await freshChat();
    await openModelMenu();
    const before = await h.count('#server-menu-list .model-row');
    await h.click('#server-add-toggle');
    await h.setSelect('#server-add-name', 'E2E Second');
    await h.setSelect('#server-add-url', 'http://localhost:1234');
    await h.setSelect('#server-add-key', 'e2e-secret-key-31');
    await h.click('#server-add-btn');
    await until(async () => (await h.count('#server-menu-list .model-row')) === before + 1, 15_000, 'the new server row');
    const rows = await h.allText('#server-menu-list .model-row');
    const second = rows.findIndex((r) => /E2E Second/.test(r));
    assert.ok(second >= 0, `the server is listed (${rows.join(' | ')})`);
    assert.strictEqual(await h.count('#server-menu-list .model-row .server-key-badge'), 1, 'it shows that a key is stored');
    // Switching servers recreates the engine with that server's URL and key.
    await h.click('#server-menu-list .model-row', second);
    await until(async () => /E2E Second\s*·\s*active/.test((await h.allText('#server-menu-list .model-row'))[second] ?? ''), 60_000, 'the switch');
    await closeModelMenu();
    await freshChat();
    assert.match(await ask('Reply with exactly: SECOND-SERVER-OK'), /SECOND-SERVER-OK/);
    // The key never reaches the webview.
    const everything = (await h.allText('body')).join(' ');
    assert.doesNotMatch(everything, /e2e-secret-key-31/);

    // Back to the first server, and remove the second.
    await openModelMenu();
    const first = (await h.allText('#server-menu-list .model-row')).findIndex((r) => /E2E Fake/.test(r));
    await h.click('#server-menu-list .model-row', first);
    await until(async () => /E2E Fake\s*·\s*active/.test((await h.allText('#server-menu-list .model-row'))[first] ?? ''), 60_000, 'the switch back');
    const idx = (await h.allText('#server-menu-list .model-row')).findIndex((r) => /E2E Second/.test(r));
    await h.click('#server-menu-list .model-row .eject', idx);
    await until(async () => (await h.count('#server-menu-list .model-row')) === before, 15_000, 'the server to be removed');
    await closeModelMenu();
    await freshChat();
    assert.match(await ask('Reply with exactly: FIRST-SERVER-OK'), /FIRST-SERVER-OK/);
  });
});
