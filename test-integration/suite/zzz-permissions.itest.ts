// Integration tests for the permission-mode picker and the single-"Stopped"
// abort notice. Named zzz-* to run LAST: switching the mode writes the real
// `lmstudioCode.permissionMode` workspace setting, which disposes the managed
// OpenCode server (by design — the ruleset is baked into the config at spawn).
// Running after every other suite means nothing downstream has to self-heal.
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import * as helpers from './helpers';

const { openPanel, post, count, attr, allText, text, click, waitFor } = helpers;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) {
      return;
    }
    await sleep(150);
  }
  throw new Error('waitUntil timed out');
}

describe('permission mode + abort notice', function () {
  this.timeout(60000);

  before(async () => {
    await openPanel();
    // Own precondition: the permissions section exists with its three modes.
    await waitFor('#perm-menu-list .model-row', (n) => n === 3);
  });

  after(async () => {
    // Remove whatever override the bypass test wrote so reruns start clean.
    // The bridge targets Workspace when a folder is open and Global otherwise;
    // this harness runs VS Code with no workspace, so Global is the one that
    // matters — but clear both to stay correct if the harness ever changes.
    const cfg = vscode.workspace.getConfiguration('lmstudioCode');
    await cfg.update('permissionMode', undefined, vscode.ConfigurationTarget.Global);
    if (vscode.workspace.workspaceFolders?.length) {
      await cfg.update('permissionMode', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  /** The value the extension actually resolves, wherever the bridge wrote it. */
  const effectiveMode = () =>
    vscode.workspace.getConfiguration('lmstudioCode').get<string>('permissionMode');

  it('offers the three modes and starts on the default', async () => {
    const labels = await allText('#perm-menu-list .model-row .model-name');
    assert.deepStrictEqual(labels, ['Auto', 'Manual', 'Bypass']);
    assert.strictEqual(await text('#perm-menu-list .model-row.active .model-name'), 'Auto');
  });

  it('switching to bypass persists the setting, acks with a chip, and flags the picker', async () => {
    const chipsBefore = await count('.sys-chip');
    assert.ok(await click('#perm-menu-list .model-row[data-mode="bypass"]'));

    // The bridge writes the real setting and acks; the ack renders the chip.
    await waitUntil(async () => (await count('.sys-chip')) > chipsBefore);
    const chips = await allText('.sys-chip');
    const chip = chips[chips.length - 1];
    assert.ok(/Permissions: Bypass/.test(chip), `unexpected chip: ${chip}`);

    assert.strictEqual(effectiveMode(), 'bypass');

    // The behavior chip itself carries the reminder that bypass is on.
    await waitFor('#behavior-btn.bypass', (n) => n === 1);
    assert.strictEqual(await text('#behavior-btn-label'), 'Bypass');
  });

  it('switching back to default clears the bypass flag and persists', async () => {
    assert.ok(await click('#perm-menu-list .model-row[data-mode="default"]'));
    await waitUntil(async () => effectiveMode() === 'default');
    await waitFor('#behavior-btn.bypass', (n) => n === 0);
    assert.strictEqual(await text('#behavior-btn-label'), 'Auto');
  });

  it('an abort renders exactly one muted Stopped chip, never red error bubbles', async () => {
    const stoppedBefore = (await allText('.sys-chip')).filter((t) => t.includes('Stopped')).length;
    const bubblesBefore = await count('.error-bubble');

    // A real stop surfaces through BOTH the message error and session.error —
    // exactly the double-report that used to render two red "Aborted" banners.
    await post({ type: 'busy', busy: true }); // new turn: resets error dedup
    await post({
      type: 'event',
      event: {
        type: 'message.updated',
        properties: {
          info: { id: 'msg_zzz_abort', role: 'assistant', error: { name: 'MessageAbortedError', data: {} } },
        },
      },
    });
    await post({
      type: 'event',
      event: { type: 'session.error', properties: { error: { data: { message: 'Aborted' } } } },
    });

    await waitUntil(async () => {
      const chips = (await allText('.sys-chip')).filter((t) => t.includes('Stopped')).length;
      return chips > stoppedBefore;
    });
    const stoppedAfter = (await allText('.sys-chip')).filter((t) => t.includes('Stopped')).length;
    assert.strictEqual(stoppedAfter, stoppedBefore + 1, 'both abort reports must collapse to ONE chip');
    assert.strictEqual(await count('.error-bubble'), bubblesBefore, 'an abort must not add red error bubbles');
  });

  it('a stop takes the approval and question cards still waiting with it', async () => {
    const event = (type: string, properties: Record<string, unknown>) => post({ type: 'event', event: { type, properties } });
    await post({ type: 'busy', busy: true });
    await event('permission.asked', { id: 'perm_zzz_stop', sessionID: 's', permission: 'read', patterns: ['/tmp/x'], metadata: { filePath: '/tmp/x' } });
    await event('question.asked', {
      id: 'q_zzz_stop',
      sessionID: 's',
      questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], custom: false }],
    });
    await waitFor('.perm-card', (n) => n >= 1);
    await waitFor('.question-card', (n) => n >= 1);
    // A stop ends the run with session.idle, and nothing replies to the approval.
    await event('session.idle', { sessionID: 's' });
    await waitFor('.perm-card, .question-card', (n) => n === 0);
  });

  it('a question the model printed as text outlives the end of its turn', async () => {
    const event = (type: string, properties: Record<string, unknown>) => post({ type: 'event', event: { type, properties } });
    const blob = JSON.stringify({ questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], custom: false }] });
    await post({ type: 'busy', busy: true });
    await event('message.updated', { info: { id: 'msg_zzz_q', role: 'assistant', time: { created: Date.now() } } });
    await event('message.part.updated', { part: { id: 'part_zzz_q', messageID: 'msg_zzz_q', sessionID: 's', type: 'text', text: blob } });
    await waitFor('.question-card', (n) => n === 1);
    await event('session.idle', { sessionID: 's' });
    // Checked straight away: the webview handles messages in order, and the
    // host may reset the chat shortly after (the mode switches above restart it).
    assert.strictEqual(await count('.question-card'), 1, 'it is answered after its turn, so it stays');
    await click('.question-card .question-skip');
  });
});
