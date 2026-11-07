// Integration tests for the wrong-scheme banner (v0.35): a server saved as
// https:// when LM Studio only serves http. Driven against the live webview via
// the test hook; the server list and connect result are injected, so no LM
// Studio is needed.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, count, click, text, posted, waitFor } = helpers;

const HTTPS_URL = 'https://192.168.1.50:1234/v1';
const HTTP_URL = 'http://192.168.1.50:1234/v1';

function servers(hasApiKey: boolean, url = HTTPS_URL) {
  return post({
    type: 'servers',
    servers: [
      { id: 'srv_local', name: 'Local', url: 'http://127.0.0.1:1234/v1', hasApiKey: false },
      { id: 'srv_tank', name: 'Tank5', url, hasApiKey },
    ],
    activeId: 'srv_tank',
    connected: false,
  });
}

function initOffline(fix?: { from: string; to: string }) {
  return post({
    type: 'init',
    models: [],
    currentModel: null,
    agent: 'build',
    cwd: '/tmp',
    serverReady: false,
    lmStudioConnected: false,
    ...(fix ? { lmStudioSchemeFix: fix } : {}),
    minContext: 32768,
  });
}

describe('wrong-scheme banner', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
  });

  after(async () => {
    // Leave the shared webview connected for the suites that follow.
    await post({ type: 'servers', servers: [], activeId: '', connected: true });
  });

  it('names the scheme problem and offers the working URL', async () => {
    await servers(false);
    await initOffline({ from: HTTPS_URL, to: HTTP_URL });
    await waitFor('#conn-fix-scheme', (n) => n === 1);
    assert.match((await text('#conn-banner .conn-title'))!, /answers over http, not https/);
    const sub = (await text('#conn-banner .conn-sub'))!;
    assert.ok(sub.includes(HTTPS_URL) && sub.includes(HTTP_URL), `sub should show both URLs: ${sub}`);
    assert.doesNotMatch(sub, /unencrypted/, 'no key, so no plaintext warning');
    assert.strictEqual(await text('#conn-fix-scheme'), 'Use http');
  });

  it('"Use http" saves the http URL on the same server, keeping its name and key', async () => {
    const before = (await posted('updateServer')).length;
    assert.ok(await click('#conn-fix-scheme'), 'fix button should be clickable');
    const sent = await posted('updateServer');
    assert.strictEqual(sent.length, before + 1, 'exactly one updateServer');
    const msg = sent[sent.length - 1];
    assert.strictEqual(msg.id, 'srv_tank');
    assert.strictEqual(msg.name, 'Tank5');
    assert.strictEqual(msg.url, HTTP_URL);
    assert.strictEqual(msg.apiKey, undefined, 'an omitted key means keep the stored one');
  });

  it('warns that a stored key would travel unencrypted over http', async () => {
    await servers(true);
    await initOffline({ from: HTTPS_URL, to: HTTP_URL });
    await waitFor('#conn-fix-scheme', (n) => n === 1);
    assert.match((await text('#conn-banner .conn-sub'))!, /unencrypted/);
  });

  it('ignores a fix diagnosed for a URL that is no longer the active one', async () => {
    await servers(false, HTTP_URL); // user already edited the URL
    await initOffline({ from: HTTPS_URL, to: HTTP_URL });
    await waitFor('#conn-banner .conn-title', (n) => n === 1);
    assert.strictEqual(await count('#conn-fix-scheme'), 0);
    assert.match((await text('#conn-banner .conn-title'))!, /Can't reach LM Studio/);
  });

  it('a plain unreachable server keeps the generic banner', async () => {
    await servers(false);
    await initOffline();
    await waitFor('#conn-banner .conn-title', (n) => n === 1);
    assert.strictEqual(await count('#conn-fix-scheme'), 0);
    assert.match((await text('#conn-banner .conn-title'))!, /Can't reach LM Studio/);
  });
});
