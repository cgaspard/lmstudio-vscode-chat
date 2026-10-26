// Sessions: titled history, reopen, delete, restore after the panel reloads,
// several panels at once, and a server restart.
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { ask, freshChat, h, sleep, until } from './lib';

async function openHistory(): Promise<string[]> {
  await h.click('#ta-history'); // the panel's own history button
  await until(async () => (await h.count('.history-row')) > 0, 15_000, 'the history list');
  return h.allText('.history-row .history-title');
}

describe('e2e · sessions', function () {
  it('a conversation is listed in history with its title and can be reopened', async () => {
    await freshChat();
    await ask('Remember the word KIWI-31. Reply with OK.');
    await freshChat();
    await ask('Reply with exactly: SECOND-CHAT');
    const titles = await openHistory();
    const first = titles.findIndex((t) => /KIWI|Remember/i.test(t));
    assert.ok(first >= 0, `the first chat is in history (${titles.join(' | ')})`);
    await h.click(`.history-row:nth-of-type(${first + 1}) .history-open`);
    await until(async () => /KIWI-31/.test((await h.allText('.msg.user')).join(' ')), 15_000, 'the old chat to load');
    assert.match(await ask('What word did I ask you to remember? Answer with just the word.'), /KIWI-31/);
  });

  it('a deleted conversation leaves history', async () => {
    await freshChat();
    await ask('Reply with exactly: DELETE-ME-77');
    await freshChat();
    let titles = await openHistory();
    const i = titles.findIndex((t) => /DELETE-ME|Reply with exactly/i.test(t));
    assert.ok(i >= 0, `listed before delete (${titles.join(' | ')})`);
    const before = titles.length;
    await h.click(`.history-row:nth-of-type(${i + 1}) .history-del`);
    await until(async () => (await h.count('.history-row')) === before - 1, 15_000, 'the row to go');
    titles = await h.allText('.history-row .history-title');
    assert.ok(!titles.some((t) => /DELETE-ME/.test(t)));
    await h.click('.history-close');
  });

  it('the last conversation is restored when the panel comes back', async () => {
    await freshChat();
    await ask('Reply with exactly: RESTORE-ME-12');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await sleep(1000);
    await h.openPanel();
    await until(async () => /RESTORE-ME-12/.test((await h.allText('.msg')).join(' ')), 30_000, 'the conversation to be restored');
  });

  it('a second panel works alongside the first, on the same engine', async () => {
    await freshChat();
    await ask('Reply with exactly: FIRST-PANEL');
    await h.openPanel(); // a second editor-tab panel; the test hook now drives it
    await freshChat();
    assert.match(await ask('Reply with exactly: TAB-OK'), /TAB-OK/);
  });

  it('keeps working after "Restart OpenCode Server"', async () => {
    await vscode.commands.executeCommand('lmstudioCode.restartServer');
    await sleep(2000);
    await freshChat();
    assert.match(await ask('Reply with exactly: AFTER-RESTART'), /AFTER-RESTART/);
  });
});
