// Integration tests for per-server API keys (v0.12): the add-form key field,
// the per-row edit button, the edit overlay's keep/replace/remove affordances,
// and the key badge. Driven against the live webview via the test hook; the
// server list is injected, so no LM Studio or real registry state is needed.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, count, click, attr, waitFor } = helpers;

const SERVERS = [
  { id: 'srv_a', name: 'Local', url: 'http://127.0.0.1:1234/v1', hasApiKey: false },
  { id: 'srv_b', name: 'Workstation', url: 'https://lm.example.com/v1', hasApiKey: true },
];

function postServers() {
  return post({ type: 'servers', servers: SERVERS, activeId: 'srv_a', connected: true });
}

describe('server API keys', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await post({ type: 'init', models: [], currentModel: null, agent: 'build', cwd: '/tmp', serverReady: true, lmStudioConnected: true, minContext: 32768 });
    await postServers();
    // The menu list only renders while the menu is open.
    assert.ok(await click('#model-btn'), 'model & server menu button should be clickable');
    await waitFor('#model-menu:not(.hidden)', (n) => n === 1);
    await postServers(); // re-render rows now that the menu is open
  });

  it('add-server form has a password-type API key field', async () => {
    assert.strictEqual(await count('#server-add-key'), 1, 'key input should exist');
    assert.strictEqual(await attr('#server-add-key', 'type'), 'password', 'key input must be masked');
  });

  it('shows a key badge only on servers with a stored key', async () => {
    await waitFor('#server-menu-list .model-row', (n) => n === 2);
    assert.strictEqual(await count('.server-key-badge'), 1, 'exactly one server has a key');
  });

  it('every server row has an edit button', async () => {
    assert.strictEqual(await count('#server-menu-list .server-edit'), 2);
  });

  it('edit opens the overlay prefilled, with keep-key placeholder for a keyed server', async () => {
    // srv_b (second row) has a key.
    const rows = await count('#server-menu-list .model-row');
    assert.strictEqual(rows, 2);
    assert.ok(await click('#server-menu-list .model-row:nth-child(2) .server-edit'), 'edit click should land');
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await attr('#server-edit-name', 'value'), 'Workstation');
    assert.strictEqual(await attr('#server-edit-url', 'value'), 'https://lm.example.com/v1');
    assert.strictEqual(await attr('#server-edit-key', 'value'), '', 'key field must start empty — the key never reaches the webview');
    assert.match((await attr('#server-edit-key', 'placeholder'))!, /unchanged/i, 'placeholder explains an empty field keeps the key');
    assert.strictEqual(await count('#server-edit-remove-row:not(.hidden)'), 1, 'remove-key option visible for keyed server');
  });

  it('cancel closes the overlay', async () => {
    assert.ok(await click('#server-edit-cancel'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 0);
  });

  it('editing a keyless server hides the remove-key option', async () => {
    assert.ok(await click('#server-menu-list .model-row:nth-child(1) .server-edit'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 1);
    assert.strictEqual(await count('#server-edit-remove-row:not(.hidden)'), 0, 'no remove option without a stored key');
    assert.doesNotMatch((await attr('#server-edit-key', 'placeholder'))!, /unchanged/i);
    assert.ok(await click('#server-edit-close'));
    await waitFor('#server-edit-overlay:not(.hidden)', (n) => n === 0);
  });

  it('a 401 from LM Studio shows the auth banner, not "can\'t reach"', async () => {
    await post({ type: 'init', models: [], currentModel: null, agent: 'build', cwd: '/tmp', serverReady: false, lmStudioConnected: false, lmStudioAuthRequired: true, minContext: 32768 });
    await waitFor('.conn-title', (n) => n === 1);
    assert.match((await helpers.text('.conn-title'))!, /requires an API key/i);
    assert.match((await helpers.text('.conn-sub'))!, /401/, 'sub line should name the rejection');
    // keyless offline still reads as unreachable
    await post({ type: 'init', models: [], currentModel: null, agent: 'build', cwd: '/tmp', serverReady: false, lmStudioConnected: false, minContext: 32768 });
    await waitFor('.conn-title', (n) => n === 1);
    assert.match((await helpers.text('.conn-title'))!, /can't reach/i);
    // restore the connected state for any suite that runs after this one
    await post({ type: 'init', models: [], currentModel: null, agent: 'build', cwd: '/tmp', serverReady: true, lmStudioConnected: true, minContext: 32768 });
  });
});
