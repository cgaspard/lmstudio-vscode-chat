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
    assert.deepStrictEqual(labels, ['Ask: risky only', 'Ask: always', 'Bypass all']);
    assert.strictEqual(await text('#perm-menu-list .model-row.active .model-name'), 'Ask: risky only');
  });

  it('switching to bypass persists the setting, acks with a chip, and flags the picker', async () => {
    const chipsBefore = await count('.sys-chip');
    assert.ok(await click('#perm-menu-list .model-row[data-mode="bypass"]'));

    // The bridge writes the real setting and acks; the ack renders the chip.
    await waitUntil(async () => (await count('.sys-chip')) > chipsBefore);
    const chips = await allText('.sys-chip');
    const chip = chips[chips.length - 1];
    assert.ok(/Permissions: Never ask \(bypass\)/.test(chip), `unexpected chip: ${chip}`);

    assert.strictEqual(effectiveMode(), 'bypass');

    // The behavior chip itself carries the reminder that bypass is on.
    await waitFor('#behavior-btn.bypass', (n) => n === 1);
    assert.strictEqual(await text('#behavior-btn-label'), 'Bypass');
  });

  it('switching back to default clears the bypass flag and persists', async () => {
    assert.ok(await click('#perm-menu-list .model-row[data-mode="default"]'));
    await waitUntil(async () => effectiveMode() === 'default');
    await waitFor('#behavior-btn.bypass', (n) => n === 0);
    assert.strictEqual(await text('#behavior-btn-label'), 'Ask risky');
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
});
