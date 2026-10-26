// Live end-to-end: the real panel, the embedded engine and a real local model.
// Everything else in this suite injects events; this drives the actual path —
// type, Enter, stream, steer mid-turn — against LM Studio.
//
// Opt-in (it needs a model and takes a minute): LIVE_UI=1 npm run test:integration
// Optional: LIVE_BASE_URL (default http://127.0.0.1:1234/v1),
//           LIVE_MODEL (default qwen/qwen3-vl-4b).
//
// Prompts are text-only on purpose: this harness opens VS Code without a
// workspace folder, so the agent's working directory is the home directory.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as helpers from './helpers';

const { openPanel, count, allText, waitFor, setInput, keydown, attr } = helpers;
const LIVE = process.env.LIVE_UI === '1';
const BASE_URL = process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3-vl-4b';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const busy = async () => /busy/.test(String(await attr('#send', 'class')));
const assistantText = async () => (await allText('.msg.assistant .part-text')).join('\n');

(LIVE ? describe : describe.skip)('live: real model through the panel', function () {
  this.timeout(600_000);
  let restore: unknown;
  const cfg = () => vscode.workspace.getConfiguration('lmstudioCode');
  // A chain of instructions, each naming the next, so the steer test's task
  // takes several steps a model cannot batch into one. It lives in a temp dir
  // (this harness has no workspace), read with the shell tool.
  const steps = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-live-steps-'));
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(
      path.join(steps, `${i}.txt`),
      i < 5
        ? `Step ${i} of 5. Use the shell tool to run \`sleep 3; cat ${path.join(steps, `${i + 1}.txt`)}\` and do what it prints.\n`
        : 'Step 5 of 5. Reply with exactly: ALL-FIVE-DONE\n',
    );
  }

  before(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // autoEnsureContext stays on (the default): a model loaded with a window
    // too small for the agent's prompt is reloaded by the panel, as for users.
    await cfg().update('defaultModel', MODEL, vscode.ConfigurationTarget.Global);
    // The step files sit outside the (absent) workspace, which Auto would ask
    // about; nothing here touches anything but them.
    await cfg().update('permissionMode', 'bypass', vscode.ConfigurationTarget.Global);
    restore = await vscode.commands.executeCommand('lmstudioCode._test.useServer', BASE_URL);
    await openPanel();
    await waitFor('#model-btn', (n) => n === 1, 60_000);
    await until(async () => !(await attr('#input', 'disabled')), 60_000, 'the composer');
  });

  after(async () => {
    if (restore) {
      await vscode.commands.executeCommand('lmstudioCode._test.restoreServer', restore);
    }
    await cfg().update('defaultModel', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('permissionMode', undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(steps, { recursive: true, force: true });
  });

  it('a typed prompt streams a reply into the transcript', async () => {
    await setInput('Reply with exactly: LIVE-PANEL-OK');
    await keydown('Enter');
    await waitFor('.msg.user', (n) => n >= 1, 30_000);
    assert.match((await allText('.msg.user')).join(' '), /LIVE-PANEL-OK/, 'the user bubble shows what was sent');
    await until(async () => /LIVE-PANEL-OK/.test(await assistantText()), 240_000, 'the reply');
    await until(async () => !(await busy()), 60_000, 'the turn to end');
  });

  it('a message sent mid-turn steers the running turn', async () => {
    // Steering lands at the agent's next step boundary, so it needs a turn with
    // several steps: five, each a shell call that prints the next instruction.
    const usersBefore = await count('.msg.user');
    const toolsBefore = await count('.msg.assistant .part-tool');
    await setInput(`Use the shell tool to run \`cat ${path.join(steps, '1.txt')}\` and do what it prints.`);
    await keydown('Enter');
    await until(async () => (await count('.msg.assistant .part-tool')) > toolsBefore, 240_000, 'the first tool call');
    await setInput('Stop. Do not run any more commands. Reply with exactly: STEERED-OK');
    await keydown('Enter');
    await until(async () => (await count('.msg.user')) >= usersBefore + 2, 240_000, 'the steered message to be delivered');
    await until(async () => /STEERED-OK/.test(await assistantText()), 240_000, 'the agent to act on the steer');
    await until(async () => !(await busy()), 120_000, 'the turn to end');
    const sleeps = (await count('.msg.assistant .part-tool')) - toolsBefore;
    assert.ok(sleeps < 5, `the steer cut the task short (ran ${sleeps} of 5 steps)`);
    assert.doesNotMatch(await assistantText(), /ALL-FIVE-DONE/, 'the original plan did not run to completion');
    assert.strictEqual(await count('.inbox-item'), 0, 'nothing left pending');
  });

  it('a message queued with Alt+Enter runs after the turn', async () => {
    await setInput('Count from 1 to 40, one number per line.');
    await keydown('Enter');
    await until(busy, 60_000, 'the turn to start');
    await setInput('Then reply with exactly: QUEUED-RAN');
    await keydown('Enter', { altKey: true });
    await waitFor('.inbox-item.queue', (n) => n === 1, 30_000);
    await until(async () => /QUEUED-RAN/.test(await assistantText()), 300_000, 'the queued message to run');
    await until(async () => !(await busy()), 120_000, 'the queue to drain');
    assert.strictEqual(await count('.inbox-item'), 0);
  });
});
