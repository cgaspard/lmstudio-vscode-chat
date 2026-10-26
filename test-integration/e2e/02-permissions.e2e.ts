// Approvals: Auto asks before leaving the workspace and before .env reads,
// Manual asks for everything, Bypass asks for nothing; Allow once / always /
// Deny all reach the agent.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { cfg, freshChat, h, send, sleep, turn, until } from './lib';

async function setMode(mode: 'default' | 'strict' | 'bypass'): Promise<void> {
  await cfg().update('permissionMode', mode === 'default' ? undefined : mode, vscode.ConfigurationTarget.Workspace);
  await sleep(1500); // the engine is recreated with the new rules on the next request
}

/** Approval cards still waiting for an answer (answered ones stay, marked resolved). */
const card = () => h.count('.perm-card:not(.resolved)');
const anyCard = () => h.count('.perm-card');

describe('e2e · permissions', function () {
  const outside = path.join(os.tmpdir(), `lms-e2e-outside-${process.pid}.txt`);

  before(() => fs.writeFileSync(outside, 'OUTSIDE-TOKEN-55\n'));
  after(async () => {
    fs.rmSync(outside, { force: true });
    await setMode('default');
  });

  it('Auto asks before reading a .env file, and Allow once lets it through', async () => {
    await setMode('default');
    await freshChat();
    await send('Use the read tool to read the .env file in the workspace root and tell me the value of E2E_SECRET.');
    await until(async () => (await card()) > 0, 180_000, 'the approval card');
    await h.click('.perm-card:not(.resolved) .perm-btn.allow-once');
    await turn();
    assert.match((await h.allText('.msg.assistant .part-text')).join(' '), /do-not-read-me/);
  });

  it('Auto asks before reading outside the workspace, and Deny stops it', async () => {
    await freshChat();
    await send(`Use the read tool to read ${outside} and tell me the token in it.`);
    await until(async () => (await card()) > 0, 180_000, 'the approval card');
    await h.click('.perm-card:not(.resolved) .perm-btn.reject');
    await turn();
    assert.doesNotMatch((await h.allText('.msg.assistant .part-text')).join(' '), /OUTSIDE-TOKEN-55/, 'denied content never reached the model');
  });

  it('Manual asks even for an ordinary read', async () => {
    await setMode('strict');
    await freshChat();
    await send('Use the read tool to read src/app.txt and tell me the codeword.');
    await until(async () => (await card()) > 0, 180_000, 'the approval card');
    await h.click('.perm-card:not(.resolved) .perm-btn.allow-once');
    await turn();
    assert.match((await h.allText('.msg.assistant .part-text')).join(' '), /BANANA-17/);
  });

  it('Bypass never asks', async () => {
    await setMode('bypass');
    await freshChat();
    await send('Use the read tool to read the .env file in the workspace root and tell me the value of E2E_SECRET.');
    await turn();
    assert.strictEqual(await anyCard(), 0, 'no approval card in bypass');
    assert.match((await h.allText('.msg.assistant .part-text')).join(' '), /do-not-read-me/);
  });
});
