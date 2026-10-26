// Turn control: steer, queue, stop, answer the agent's questions, and the
// autonomous goal loop.
import * as assert from 'node:assert';
import { assistantText, ask, busy, freshChat, h, send, turn, until } from './lib';

describe('e2e · steering, stopping, questions, goals', function () {
  it('a message sent mid-turn steers the running task', async () => {
    await freshChat();
    // Steering lands at the agent's next step, so the task must take several
    // steps that cannot be batched: each file names the next one (steps/1..5,
    // with a short sleep between), ten tool calls in all.
    await send('Use the read tool on steps/1.txt and do what it says.');
    await until(async () => (await h.count('.msg.assistant .part-tool')) > 0, 240_000, 'the first tool call');
    await send('Stop. Run no more commands and read no more files. Reply with exactly: STEERED-OK');
    await until(async () => /STEERED-OK/.test(await assistantText()), 240_000, 'the steer to take effect');
    await turn();
    const tools = await h.count('.msg.assistant .part-tool');
    assert.ok(tools < 10, `the steer cut the task short (${tools} of 10 tool calls)`);
    assert.doesNotMatch(await assistantText(), /ALL-FIVE-DONE/);
  });

  it('Alt+Enter queues a message for after the turn', async () => {
    await freshChat();
    // Plain text, no tools: a small model otherwise reaches for a tool (and an
    // approval) to "count".
    await send('Do not use any tools. In your reply, write the numbers from 1 to 30, one per line.');
    await until(busy, 60_000, 'the turn to start');
    await send('Then reply with exactly: QUEUED-RAN', { queue: true });
    await until(
      async () => {
        // Should it still ask for something, deny it: the queue is under test.
        if ((await h.count('.perm-card:not(.resolved)')) > 0) {
          await h.click('.perm-card:not(.resolved) .perm-btn.reject');
        }
        return /QUEUED-RAN/.test(await assistantText());
      },
      300_000,
      'the queued message to run',
    );
    await turn();
    assert.strictEqual(await h.count('.inbox-item'), 0);
  });

  it('the stop button stops a turn with one quiet "Stopped" chip', async () => {
    await freshChat();
    // Plain text, no tools or questions: a small model otherwise loads a skill or
    // asks what to focus on, and never streams the essay.
    await send('Do not use any tools, skills or questions. Directly in your reply, write a 1500-word essay about the history of compilers.');
    await until(async () => (await assistantText()).length > 40, 240_000, 'streaming to begin');
    await h.click('#send'); // the send button is the stop button while busy
    await until(async () => !(await busy()), 60_000, 'the turn to stop');
    const chips = (await h.allText('.sys-chip')).filter((t) => /Stopped/.test(t));
    assert.strictEqual(chips.length, 1, 'exactly one Stopped chip');
    assert.strictEqual(await h.count('.error-bubble'), 0, 'no error bubble for a stop');
  });

  it('the agent can ask a question and gets the picked answer', async () => {
    await freshChat();
    await send('Use the question tool to ask me to choose between the options "Red" and "Blue". After I answer, reply with "You chose" followed by my choice.');
    await until(async () => (await h.count('.question-card .question-opt')) > 0, 240_000, 'the question card');
    const opts = await h.allText('.question-card .question-opt');
    const blue = opts.findIndex((o) => /Blue/.test(o));
    assert.ok(blue >= 0, `Blue is offered (${opts.join(', ')})`);
    await h.click(`.question-card .question-opt:nth-of-type(${blue + 1})`);
    if ((await h.count('.question-card .question-submit')) > 0) {
      await h.click('.question-card .question-submit');
    }
    await turn();
    assert.match(await assistantText(), /You chose.*Blue/i);
  });

  it('/goal runs until the judge says the goal is met', async () => {
    await freshChat();
    await h.setInput('/goal Reply in the chat with the exact word GOAL-REACHED.');
    await h.keydown('Enter');
    await until(async () => !/hidden/.test(String(await h.attr('#goal-bar', 'class'))), 30_000, 'the goal bar');
    await until(async () => (await h.allText('.sys-chip')).some((t) => /Goal met/.test(t)), 600_000, 'the goal to be met');
    assert.match(await assistantText(), /GOAL-REACHED/);
  });

  it('answers keep flowing after all of that', async () => {
    await freshChat();
    assert.match(await ask('Reply with exactly: STILL-OK'), /STILL-OK/);
  });
});
