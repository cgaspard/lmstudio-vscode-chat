// Integration tests for the v0.5.2 webview features, driven against a real
// (headless) VS Code + the live webview via the test hook. A fake OpenCode
// event stream is injected so the tests are deterministic and need no LM Studio.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, text, count, classes, click, attr, waitFor } = helpers;

const MODELS = [
  { id: 'qwen/qwen3-27b', name: 'qwen3-27b', loaded: false, maxContextLength: 262144, publisher: 'qwen', format: 'MLX', quantization: '8bit' },
  { id: 'unsloth/llama-70b', name: 'llama-70b', loaded: false, maxContextLength: 131072, publisher: 'unsloth', format: 'GGUF', quantization: 'Q8_0' },
];

function init() {
  return post({ type: 'init', models: MODELS, currentModel: null, agent: 'build', cwd: '/tmp', serverReady: true, lmStudioConnected: true, minContext: 32768 });
}

// Stream `chars` characters of assistant text over the fake event stream, then
// go idle — exercising the tokens/sec path end to end.
async function streamAssistant(messageID: string, chars: number, partId = 'p1') {
  await post({ type: 'event', event: { type: 'message.updated', properties: { info: { id: messageID, role: 'assistant', time: { created: Date.now() } } } } });
  await post({ type: 'event', event: { type: 'message.part.updated', properties: { part: { id: partId, messageID, sessionID: 's', type: 'text', text: '' } } } });
  const chunk = 'x'.repeat(20);
  for (let i = 0; i < chars; i += 20) {
    await post({ type: 'event', event: { type: 'message.part.delta', properties: { partID: partId, field: 'text', delta: chunk } } });
  }
  await post({ type: 'event', event: { type: 'session.idle', properties: { sessionID: 's' } } });
}

describe('v0.5.2 webview features', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await init();
  });

  describe('tokens/sec', () => {
    it('shows an estimated gen-stat under a finished assistant turn', async () => {
      await post({ type: 'busy', busy: true }); // turn starts → counters reset
      await streamAssistant('m1', 400); // 400 chars ≈ 100 tokens
      await waitFor('.gen-stat', (n) => n >= 1);
      const stat = await text('.gen-stat');
      assert.ok(stat, 'gen-stat should be present');
      assert.match(stat!, /tok\/s/, 'stat should report a token rate');
      assert.match(stat!, /^~/, 'estimate should be prefixed with ~');
      assert.match(stat!, /~100 tokens/, 'should estimate ~100 tokens from 400 chars');
    });

    it('shows NO gen-stat for a tool-only turn (no streamed text)', async () => {
      await post({ type: 'busy', busy: true });
      await post({ type: 'event', event: { type: 'message.updated', properties: { info: { id: 'm2', role: 'assistant', time: { created: Date.now() } } } } });
      // a tool part, no text deltas
      await post({ type: 'event', event: { type: 'message.part.updated', properties: { part: { id: 'tp', messageID: 'm2', sessionID: 's', type: 'tool', tool: 'read', state: { status: 'completed' } } } } });
      await post({ type: 'event', event: { type: 'session.idle', properties: { sessionID: 's' } } });
      // the previous turn's stat (m1) still exists, but m2 must not get one
      const total = await count('.gen-stat');
      assert.strictEqual(total, 1, 'only the earlier text turn should have a gen-stat');
    });
  });

  describe('model picker', () => {
    it('disambiguates models and shows the identity line', async () => {
      await click('#model-btn'); // open the menu
      await waitFor('.model-row', (n) => n >= 2);
      const idents = await classes('.model-ident'); // present when publisher/format/quant exist
      assert.ok(idents.length >= 1, 'identity lines should render');
      const firstIdent = await text('.model-ident');
      assert.match(firstIdent!, /MLX|GGUF/, 'identity line should include the format');
    });

    it('Load selects the model as active', async () => {
      // both unloaded; click Load on the first row's action button
      const ok = await click('.model-row .model-action.load');
      assert.ok(ok, 'a load button should be clickable');
      // the webview optimistically sets currentModel + shows the spinner ("busy")
      await waitFor('.model-action.busy', (n) => n >= 1);
      const busyText = await text('.model-action.busy');
      assert.match(busyText!, /Loading/, 'the clicked action shows a loading spinner');
    });

    it('Load button is not a disabled element (so its spinner can animate)', async () => {
      const disabled = await attr('.model-action.busy', 'disabled');
      assert.strictEqual(disabled, null, 'busy action must not carry the disabled attribute');
      const ariaBusy = await attr('.model-action.busy', 'aria-busy');
      assert.strictEqual(ariaBusy, 'true', 'busy action should mark aria-busy=true');
    });

    it('closes the menu once the load returns', async () => {
      // menu is currently open with a load in flight; the 'models' message
      // (load returned) should dismiss it.
      const openBefore = await count('#model-menu:not(.hidden)');
      assert.strictEqual(openBefore, 1, 'menu should be open during load');
      await post({ type: 'models', models: MODELS.map((m, i) => ({ ...m, loaded: i === 0 })), currentModel: 'qwen/qwen3-27b' });
      await waitFor('#model-menu:not(.hidden)', (n) => n === 0);
      assert.strictEqual(await count('#model-menu:not(.hidden)'), 0, 'menu should close after load returns');
    });
  });
});
