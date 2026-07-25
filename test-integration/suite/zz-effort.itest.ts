// Integration tests for the reasoning-effort control (v0.15). Driven against
// the live webview via the test hook, with models injected.
//
// Named zz-* so this suite runs after the injection-driven ones: opening the
// model picker posts `modelMenu: {open:true}`, which makes the HOST fast-poll
// the real LM Studio. Those responses land asynchronously and would otherwise
// race the earlier suites' model-picker assertions.
//
// The behavior worth protecting here is that the offered levels are DERIVED from
// what each model reports, never hardcoded: most local reasoning models are
// on/off only, so showing a low/medium/high slider for them would be a lie.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, count, text, click, classes, waitFor } = helpers;

const BINARY = { allowedOptions: ['off', 'on'], default: 'on' };
const GRANULAR = { allowedOptions: ['low', 'medium', 'high'], default: 'medium' };

const MODELS = [
  // What every reasoning model in LM Studio looks like today.
  { id: 'qwen/qwen3.6-27b', name: 'Qwen3.6 27B', loaded: true, maxContextLength: 32768, reasoning: BINARY },
  // The one family that genuinely differentiates depth.
  { id: 'openai/gpt-oss-20b', name: 'gpt-oss 20B', loaded: true, maxContextLength: 32768, reasoning: GRANULAR },
  // Explicitly reports no reasoning support.
  { id: 'qwen/qwen3-vl-8b', name: 'Qwen3 VL 8B', loaded: true, maxContextLength: 32768, reasoning: null },
];

function postModels(currentModel: string) {
  return post({ type: 'models', models: MODELS, currentModel, reason: 'action' });
}

async function openModelMenu() {
  if ((await count('#model-menu:not(.hidden)')) === 0) {
    await click('#model-btn');
    await waitFor('#model-menu:not(.hidden)', (n) => n === 1);
  }
}

describe('reasoning effort', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await post({
      type: 'init',
      models: MODELS,
      currentModel: 'qwen/qwen3.6-27b',
      agent: 'build',
      cwd: '/tmp',
      serverReady: true,
      lmStudioConnected: true,
      minContext: 32768,
      defaultEffort: 'auto',
    });
    await openModelMenu();
    await postModels('qwen/qwen3.6-27b');
    // Wait for THIS suite's own state to render before asserting on it. The
    // webview is shared, so inheriting a previous suite's models would silently
    // change which levels the picker derives.
    await waitFor('#effort-presets .ctx-preset', (n) => n === 3);
  });

  after(async () => {
    // The webview is shared across suites, and later ones assume the model menu
    // starts closed (their #model-btn click would otherwise toggle it shut).
    // Leave the panel as we found it.
    if ((await count('#model-menu:not(.hidden)')) === 1) {
      await click('#model-btn');
      await waitFor('#model-menu:not(.hidden)', (n) => n === 0);
    }
  });

  it('a binary model offers Auto/Off/On — not a low/medium/high slider', async () => {
    await waitFor('#effort-presets .ctx-preset', (n) => n > 0);
    const labels = await classes('#effort-presets .ctx-preset');
    assert.strictEqual(labels.length, 3, 'binary models get exactly three levels');
    assert.strictEqual(await text('#effort-presets .ctx-preset:nth-child(1)'), 'Auto');
    assert.strictEqual(await text('#effort-presets .ctx-preset:nth-child(2)'), 'Off');
    // "On", never "High" — the model cannot deliver a depth distinction.
    assert.strictEqual(await text('#effort-presets .ctx-preset:nth-child(3)'), 'On');
  });

  it('explains the on/off limitation rather than silently collapsing it', async () => {
    assert.match((await text('#effort-note'))!, /on\/off/i);
  });

  it('a granular model offers the levels it actually declares', async () => {
    await postModels('openai/gpt-oss-20b');
    await waitFor('#effort-presets .ctx-preset', (n) => n === 5);
    assert.strictEqual(await text('#effort-presets .ctx-preset:nth-child(3)'), 'Low');
    assert.strictEqual(await text('#effort-presets .ctx-preset:nth-child(4)'), 'Med');
    assert.strictEqual(await text('#effort-presets .ctx-preset:nth-child(5)'), 'High');
    assert.strictEqual(await text('#effort-note'), '', 'no caveat needed for a granular model');
  });

  it('a model reporting no reasoning support hides the control entirely', async () => {
    await postModels('qwen/qwen3-vl-8b');
    await waitFor('#effort-foot:not(.hidden)', (n) => n === 0);
    // ...and the composer pill goes with it, rather than becoming a dead toggle.
    await waitFor('#btn-think:not(.hidden)', (n) => n === 0);
  });

  it('selecting a level marks it active', async () => {
    await postModels('openai/gpt-oss-20b');
    await waitFor('#effort-presets .ctx-preset', (n) => n === 5);
    assert.ok(await click('#effort-presets .ctx-preset:nth-child(5)'), 'High should be clickable');
    await waitFor('#effort-presets .ctx-preset.active', (n) => n === 1);
    assert.strictEqual(await text('#effort-presets .ctx-preset.active'), 'High');
  });

  it('effort is remembered per model, and clamped when it does not carry over', async () => {
    // High was just chosen on the granular model. The binary model has no
    // equivalent, so it must degrade rather than send a meaningless level.
    await postModels('qwen/qwen3.6-27b');
    await waitFor('#effort-presets .ctx-preset', (n) => n === 3);
    const active = await text('#effort-presets .ctx-preset.active');
    assert.ok(active === 'Auto' || active === 'On', `unexpected clamped level: ${active}`);
    // Back to the granular model: its own choice survived the round trip.
    await postModels('openai/gpt-oss-20b');
    await waitFor('#effort-presets .ctx-preset', (n) => n === 5);
    assert.strictEqual(await text('#effort-presets .ctx-preset.active'), 'High');
  });

  it('the composer pill reflects the current level', async () => {
    await postModels('openai/gpt-oss-20b');
    await waitFor('#btn-think:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await text('#btn-think'), 'High');
  });

  it('the pill names the Auto state "Auto", not "Thinking"', async () => {
    // "Thinking" sitting next to "On" read as a third on-state instead of
    // "let the model decide", which is what Auto actually means.
    await postModels('qwen/qwen3.6-27b');
    await waitFor('#effort-presets .ctx-preset', (n) => n === 3);
    assert.ok(await click('#effort-presets .ctx-preset:nth-child(1)'), 'Auto should be clickable');
    await waitFor('#btn-think:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await text('#btn-think'), 'Auto');
  });
});
