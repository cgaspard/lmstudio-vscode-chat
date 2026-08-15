// Integration tests for user-defined agents (v0.15): the picker is populated
// from the server roster rather than a hardcoded build/plan pair, and the
// /agents panel shows both audiences — the agents you select, and the ones only
// the model can reach by delegating.
//
// Named zz-* so this suite runs after the injection-driven ones: it re-inits the
// shared webview several times (including a deliberately disconnected state) and
// would otherwise reset panel state out from under them.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, count, text, waitFor } = helpers;

// Shaped like a real GET /agent response with two agents defined on disk.
const PICKABLE = [
  { name: 'build', mode: 'primary', native: true, description: 'The default agent.' },
  { name: 'plan', mode: 'primary', native: true, description: 'Plan mode. Disallows all edit tools.' },
  { name: 'reviewer', mode: 'all', native: false, description: 'Reviews a diff.' },
];
const DELEGATABLE = [
  { name: 'dbexpert', mode: 'subagent', native: false, description: 'Postgres specialist.' },
  { name: 'explore', mode: 'subagent', native: true, description: 'Fast codebase exploration.' },
  { name: 'general', mode: 'subagent', native: true, description: 'General-purpose agent.' },
  { name: 'reviewer', mode: 'all', native: false, description: 'Reviews a diff.' },
];

describe('user-defined agents', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await post({
      type: 'init',
      models: [],
      currentModel: null,
      agent: 'build',
      agents: PICKABLE,
      cwd: '/tmp',
      serverReady: true,
      lmStudioConnected: true,
      minContext: 32768,
      defaultEffort: 'auto',
    });
  });

  after(async () => {
    // The webview is shared across suites. The last test here deliberately puts
    // the panel in a disconnected state; leave it connected so later suites
    // start from a healthy panel.
    await post({
      type: 'init',
      models: [],
      currentModel: null,
      agent: 'build',
      agents: PICKABLE,
      cwd: '/tmp',
      serverReady: true,
      lmStudioConnected: true,
      minContext: 32768,
      defaultEffort: 'auto',
    });
    // `post` resolves when the message is dispatched, not when the webview has
    // rendered it — without this wait the init can land *after* the next
    // suite's setup and clobber its state.
    await waitFor('#agent-menu-list .model-row', (n) => n === 3);
  });

  it('the picker is populated from the server, not hardcoded', async () => {
    await waitFor('#agent-menu-list .model-row', (n) => n === 3);
    assert.strictEqual(await text('#agent-menu-list .model-row:nth-child(1) .model-name'), 'build');
    assert.strictEqual(await text('#agent-menu-list .model-row:nth-child(2) .model-name'), 'plan');
    // User-defined agents are badged so they're distinguishable from built-ins.
    assert.strictEqual(await text('#agent-menu-list .model-row:nth-child(3) .model-name'), 'reviewer (custom)');
  });

  it('subagents never appear in the picker', async () => {
    // They are delegation-only; selecting one as the driver is meaningless and
    // OpenCode itself refuses it.
    const opts = await count('#agent-menu-list .model-row');
    assert.strictEqual(opts, 3, 'only the pickable set should be listed');
    for (const name of ['dbexpert', 'explore', 'general']) {
      assert.strictEqual(
        await count(`#agent-menu-list .model-row[data-agent="${name}"]`),
        0,
        `${name} is a subagent and must not be selectable`,
      );
    }
  });

  it('/agents shows both audiences, and explains the difference', async () => {
    await post({ type: 'agents', agents: PICKABLE, delegatable: DELEGATABLE });
    await waitFor('.mcp-panel', (n) => n >= 1);
    const panel = (await text('.mcp-panel'))!;
    assert.match(panel, /Agents you can select/);
    assert.match(panel, /Agents the model can delegate to/);
    assert.match(panel, /dbexpert/, 'delegation-only agents must be visible somewhere');
    // mode:'all' is genuinely in both lists — that overlap is the whole point.
    assert.ok(panel.indexOf('reviewer') !== panel.lastIndexOf('reviewer'));
    assert.match(panel, /\.opencode\/agent/, 'the panel should say where to define one');
  });

  it('a stale stored agent falls back instead of pointing at nothing', async () => {
    // Simulates an agent deleted or renamed on disk since it was chosen.
    await post({
      type: 'init',
      models: [],
      currentModel: null,
      agent: 'deleted-agent',
      agents: PICKABLE,
      cwd: '/tmp',
      serverReady: true,
      lmStudioConnected: true,
      minContext: 32768,
      defaultEffort: 'auto',
    });
    await waitFor('#agent-menu-list .model-row', (n) => n === 3);
    assert.strictEqual(await helpers.text('#agent-menu-list .model-row.active .model-name'), 'build');
  });

  it('falls back to the built-in pair before the server has answered', async () => {
    await post({
      type: 'init',
      models: [],
      currentModel: null,
      agent: 'build',
      agents: [],
      cwd: '/tmp',
      serverReady: false,
      lmStudioConnected: false,
      minContext: 32768,
      defaultEffort: 'auto',
    });
    // The control must never be empty, or the composer looks broken on startup.
    await waitFor('#agent-menu-list .model-row', (n) => n === 2);
  });
});
