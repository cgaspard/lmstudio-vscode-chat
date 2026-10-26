// The agent: real tools with cards, edits with diffs, todos, plan mode,
// streaming markdown, reasoning blocks and the effort control, the context
// meter and tok/s.
import * as assert from 'node:assert';
import { assistantText, ask, freshChat, h, lmStudioModels, read, REASONING_MODEL, until } from './lib';

/** Whether LM Studio reports the reasoning model as one that can think. */
async function reasons(): Promise<boolean> {
  return !!(await lmStudioModels()).find((m) => m.key === REASONING_MODEL)?.reasoning;
}

describe('e2e · the agent', function () {
  it('reads a file with a tool and answers from it', async () => {
    await freshChat();
    const reply = await ask('Use the read tool on src/app.txt and tell me the codeword it contains.');
    assert.match(reply, /BANANA-17/);
    const tools = await h.allText('.msg.assistant .part-tool');
    assert.ok(tools.some((t) => /app\.txt/.test(t)), `a tool card names the file (cards: ${tools.join(' | ')})`);
    assert.ok((await h.count('.part-tool .tool-line.status-completed')) > 0, 'the tool card rendered as completed');
  });

  it('edits a file and shows the diff on its card', async () => {
    await freshChat();
    await ask('Use the edit tool to change "version = v1" to "version = v2" in src/app.txt. Change nothing else.');
    assert.match(read('src', 'app.txt'), /version = v2/);
    assert.match(read('src', 'app.txt'), /codeword = BANANA-17/, 'the rest of the file is intact');
    // Expand the edit card: its diff comes from the tool's patch metadata.
    const names = await h.allText('.msg.assistant .part-tool .tool-name');
    const edit = names.lastIndexOf('edit');
    assert.ok(edit >= 0, `an edit card (cards: ${names.join(', ')})`);
    await h.click('.msg.assistant .part-tool .tool-line', edit);
    await until(async () => (await h.count('.tool-diff')) > 0, 5000, 'the diff to render');
    assert.match(String(await h.text('.tool-diff')), /v2/);
  });

  it('keeps a live todo list', async () => {
    await freshChat();
    await ask(
      'Use the todo tool to write a plan with exactly three items: "alpha", "beta", "gamma". Then mark "alpha" completed with the todo tool. Then reply with the word PLANNED.',
    );
    await until(async () => (await h.count('.todo-card')) > 0, 10_000, 'the todo card');
    const items = (await h.allText('.todo-card .todo-text')).join(' ');
    assert.match(items, /alpha/);
    assert.match(items, /gamma/);
    const progress = String(await h.text('.todo-card .todo-count'));
    assert.match(progress, /1\s*\/\s*3/, `progress counts the completed item (${progress}; items: ${items})`);
  });

  it('plan mode stays read-only', async () => {
    await freshChat({ agent: 'plan' });
    await ask('Create a file named plan-should-not-write.txt containing hello.');
    const fs = await import('node:fs');
    const { ws } = await import('./lib');
    assert.ok(!fs.existsSync(ws('plan-should-not-write.txt')), 'the plan agent must not write files');
  });

  it('streams markdown with code blocks', async () => {
    await freshChat();
    await ask('Reply with a fenced ```js code block containing exactly: console.log(42)');
    assert.ok((await h.count('.msg.assistant pre code')) > 0, 'a rendered code block');
    assert.match(String(await h.text('.msg.assistant pre code')), /console\.log\(42\)/);
  });

  it('a reasoning model shows its thinking in a collapsible block', async () => {
    await freshChat({ model: REASONING_MODEL });
    await ask('What is 17 * 23? Think it through, then answer with just the number.', 600_000);
    assert.match(await assistantText(), /391/);
    if (await reasons()) {
      assert.ok((await h.count('.part-reasoning')) > 0, 'a thinking block rendered');
    } else {
      // The test model reports no reasoning: no thinking block may appear
      // (point E2E_REASONING_MODEL at a reasoning model to see one).
      assert.strictEqual(await h.count('.part-reasoning'), 0, 'no thinking block for a model that does not reason');
    }
  });

  it('/effort follows what the model reports: off silences a reasoning model, a plain one has no control', async () => {
    await freshChat({ model: REASONING_MODEL });
    if (!(await reasons())) {
      await h.setInput('/effort');
      await h.keydown('Enter');
      await until(async () => (await h.allText('.sys-chip')).some((t) => /no reasoning support/i.test(t)), 10_000, 'the no-reasoning chip');
      return;
    }
    await h.setInput('/effort off');
    await h.keydown('Enter');
    await until(async () => (await h.allText('.sys-chip')).some((t) => /effort set to Off/i.test(t)), 10_000, 'the effort chip');
    await ask('What is 6 * 7? Answer with just the number.', 600_000);
    assert.match(await assistantText(), /42/);
    assert.strictEqual(await h.count('.part-reasoning'), 0, 'no thinking block with effort off');
    // Back to the model's own default for the rest of the run.
    await h.setInput('/effort auto');
    await h.keydown('Enter');
  });

  it('reports generation speed and fills the context meter', async () => {
    await freshChat();
    // Long enough to stream as many deltas: a one-chunk reply has no rate.
    await ask('Count from 1 to 40, separated by spaces.');
    await until(async () => (await h.count('.msg.assistant .gen-stat')) > 0, 10_000, 'the generation stat');
    const meter = String(await h.attr('#ctx-meter .ctx-fill', 'style'));
    assert.match(meter, /width:\s*[1-9]/, `the context meter moved (${meter})`);
  });
});
