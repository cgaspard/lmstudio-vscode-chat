// Integration tests for the reasoning-block collapse and the generation stat
// (v0.15). Drives the live webview by injecting the same events OpenCode emits.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, count, text, attr, waitFor } = helpers;

const MSG = 'msg_gen_1';
const REASON_PART = 'prt_reason_1';
const TEXT_PART = 'prt_text_1';

const ev = (event: Record<string, unknown>) => post({ type: 'event', event } as never);

/** Stream a part's text the way OpenCode does: upsert, then deltas. */
async function streamPart(id: string, type: string, chunks: string[]) {
  await ev({ type: 'message.part.updated', properties: { part: { id, messageID: MSG, type, text: '' } } });
  let acc = '';
  for (const c of chunks) {
    acc += c;
    await ev({ type: 'message.part.delta', properties: { partID: id, field: 'text', delta: c } });
  }
  return acc;
}

describe('generation stat + reasoning collapse', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await post({
      type: 'init',
      models: [],
      currentModel: null,
      agent: 'build',
      cwd: '/tmp',
      serverReady: true,
      lmStudioConnected: true,
      minContext: 32768,
      defaultEffort: 'auto',
    });
    await post({ type: 'busy', busy: true });
    await ev({ type: 'message.updated', properties: { info: { id: MSG, role: 'assistant' } } });
    await streamPart(REASON_PART, 'reasoning', ['Let me think. ', 'Considering the options. ']);
    await streamPart(TEXT_PART, 'text', ['The answer is 12.']);
  });

  it('the reasoning block streams open, so you can watch it think', async () => {
    await waitFor('.part-reasoning details.reasoning[open]', (n) => n === 1);
    assert.match((await text('.reasoning-label'))!, /Thinking/);
  });

  it('exact usage from the assistant message is preferred over the estimate', async () => {
    // OpenCode reports usage on the message; `output` includes `reasoning`.
    await ev({
      type: 'message.updated',
      properties: {
        info: {
          id: MSG,
          role: 'assistant',
          agent: 'build',
          tokens: { input: 20, output: 876, reasoning: 776, total: 896, cache: { read: 0, write: 0 } },
        },
      },
    });
    await ev({ type: 'session.idle', properties: {} });
    await waitFor('.gen-stat', (n) => n === 1);
    const stat = (await text('.gen-stat'))!;
    // Exact numbers, no "~" prefix, and the thinking share is broken out.
    assert.match(stat, /876 out \(776 thinking\)/, `unexpected stat: ${stat}`);
    assert.ok(!stat.startsWith('~'), `exact usage should not be marked approximate: ${stat}`);
    assert.match(stat, /tok\/s/);
  });

  it('the stat reports the whole cost of the turn, not just what was generated', async () => {
    // A turn can be mostly prompt — 8k in for 2 tokens out is normal on a long
    // conversation — so output alone hides what the turn actually cost.
    const stat = (await text('.gen-stat'))!;
    assert.match(stat, /20 in/, `input tokens should be shown: ${stat}`);
    assert.match(stat, /896 total/, `input+output total should be shown: ${stat}`);
  });

  it('names the agent that ran the turn', async () => {
    // Confirms the picker selection actually took effect for this turn.
    assert.match((await text('.gen-stat'))!, /^build ·/);
  });

  it('the reasoning block auto-collapses when the turn ends', async () => {
    await waitFor('.part-reasoning details.reasoning[open]', (n) => n === 0);
    assert.strictEqual(await count('.part-reasoning details.reasoning'), 1, 'block still present, just closed');
  });

  it('the collapsed label reports how long the model thought', async () => {
    const label = (await text('.reasoning-label'))!;
    assert.match(label, /Thought for [\d.]+s/, `unexpected label: ${label}`);
    // Single reasoning block + exact usage -> the real reasoning count is used.
    assert.match(label, /776 tokens/, `should use exact reasoning tokens: ${label}`);
  });

  it('the summary is still a real control after collapsing', async () => {
    // It must remain focusable/clickable — collapsing is only useful if you can
    // get back in.
    assert.strictEqual(await count('.part-reasoning details.reasoning > summary'), 1);
    const cls = await attr('.part-reasoning details.reasoning', 'class');
    assert.match(cls!, /reasoning/);
  });
});
