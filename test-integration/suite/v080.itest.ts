// Integration tests for the v0.8.0 webview features (selection auto-attach,
// composer redesign + attachments/lightbox, floating title-bar cluster, /mcp +
// /skills panels, server slash commands). Driven against a real headless VS Code
// + the live webview via the test hook, with host messages injected directly so
// the tests are deterministic and need no LM Studio / OpenCode.
import * as assert from 'node:assert';
import * as helpers from './helpers';

const { openPanel, post, text, count, classes, click, attr, waitFor, setInput } = helpers;

const MODELS = [{ id: 'qwen/qwen3-27b', name: 'qwen3-27b', loaded: true, maxContextLength: 262144 }];

function init() {
  return post({
    type: 'init',
    models: MODELS,
    currentModel: 'qwen/qwen3-27b',
    agent: 'build',
    cwd: '/work',
    serverReady: true,
    lmStudioConnected: true,
    minContext: 32768,
  });
}

describe('v0.8.0 webview features', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await init();
  });

  describe('floating title-bar action cluster', () => {
    it('renders the new chat / history / open-in-tab buttons in the panel', async () => {
      assert.strictEqual(await count('#titlebar-actions'), 1, 'cluster container should exist');
      assert.strictEqual(await count('#ta-new'), 1, 'new chat button');
      assert.strictEqual(await count('#ta-history'), 1, 'history button');
      assert.strictEqual(await count('#ta-tab'), 1, 'open-in-tab button');
    });

    it('the buttons are clickable', async () => {
      assert.ok(await click('#ta-new'), 'new chat button should be clickable');
    });
  });

  describe('composer attachments row', () => {
    it('is hidden when there are no attachments', async () => {
      const hidden = await classes('#attachments');
      assert.ok(hidden[0]?.includes('hidden'), 'attachments row should start hidden');
    });

    it('shows a quiet inline file reference, not a filled pill', async () => {
      await post({ type: 'activeFile', path: 'src/app.js', chars: 1200 });
      await waitFor('#ctxfile:not(.hidden)', (n) => n === 1);
      assert.strictEqual(await text('#ctxfile-name'), 'app.js', 'shows the basename');
      const cls = await attr('#ctxfile', 'class');
      assert.ok(cls?.includes('ctxref'), 'uses the quiet ctxref style');
      assert.ok(!cls?.includes('tool-pill'), 'is no longer a filled tool-pill');
    });
  });

  describe('/mcp panel', () => {
    it('renders one row per server with status dots and a failure reason', async () => {
      await post({
        type: 'mcpStatus',
        servers: [
          { name: 'everything', status: 'connected', transport: 'local', detail: 'npx -y server' },
          { name: 'offserver', status: 'disabled', transport: 'local' },
          { name: 'remote', status: 'failed', transport: 'remote', detail: 'https://x/mcp', error: 'SSE error: unreachable' },
        ],
      });
      await waitFor('.mcp-row', (n) => n >= 3);
      assert.strictEqual(await count('.mcp-dot.ok'), 1, 'one connected (green) dot');
      assert.strictEqual(await count('.mcp-dot.off'), 1, 'one disabled (yellow) dot');
      assert.strictEqual(await count('.mcp-dot.err'), 1, 'one failed (red) dot');
      const err = await text('.mcp-error');
      assert.match(err!, /SSE error/, 'failed server shows its error reason');
    });

    it('shows an empty-state when no servers are configured', async () => {
      await post({ type: 'cleared' });
      await waitFor('.mcp-empty', (n) => n === 0);
      await post({ type: 'mcpStatus', servers: [] });
      await waitFor('.mcp-empty', (n) => n >= 1);
      const empty = await text('.mcp-empty');
      assert.match(empty!, /No MCP servers/i);
    });
  });

  describe('/skills panel', () => {
    it('renders skills with project / global / built-in source tags', async () => {
      await post({
        type: 'skills',
        skills: [
          { name: 'fibonacci-helper', description: 'Optimize fib', source: 'project', path: '/work/.opencode/skill/fibonacci-helper/SKILL.md', slash: true },
          { name: 'debug-mcp', description: 'Debug MCP', source: 'global', path: '/Users/me/.claude/skills/debug-mcp/SKILL.md', slash: false },
          { name: 'customize-opencode', description: 'Configure', source: 'built-in', slash: false },
        ],
      });
      await waitFor('.mcp-row', (n) => n >= 3);
      const labels = await classes('.mcp-status-label');
      assert.ok(labels.length >= 3, 'each skill has a source label');
      const desc = await text('.skill-desc');
      assert.match(desc!, /Optimize fib/, 'shows the skill description');
      // the project skill shows its path
      const path0 = await text('.skill-path');
      assert.match(path0!, /\.opencode\/skill/, 'shows the SKILL.md path for disk skills');
    });

    it('shows an empty-state when no skills are found', async () => {
      // Clear first so the only panel in the stream is the skills empty-state
      // (earlier tests left an MCP empty-state panel behind).
      await post({ type: 'cleared' });
      await waitFor('.mcp-empty', (n) => n === 0);
      await post({ type: 'skills', skills: [] });
      await waitFor('.mcp-empty', (n) => n >= 1);
      const empty = await text('.mcp-empty');
      assert.match(empty!, /No skills found/i);
    });
  });

  describe('slash menu with server commands + skills', () => {
    before(async () => {
      await post({
        type: 'commands',
        commands: [
          { name: 'fibonacci-helper', description: 'Optimize fib', source: 'skill', takesArgs: false },
          { name: 'review', description: 'review changes', source: 'command', takesArgs: true },
        ],
      });
    });

    it('typing /sk surfaces the local /skills command', async () => {
      await setInput('/sk');
      await waitFor('.slash-item', (n) => n >= 1);
      const name = await text('.slash-name');
      assert.match(name!, /\/skills/, 'the /skills command appears');
    });

    it('typing /fib surfaces the server skill with a skill badge', async () => {
      await setInput('/fib');
      await waitFor('.slash-item', (n) => n >= 1);
      assert.strictEqual(await count('.slash-badge'), 1, 'the skill row carries a skill badge');
      const badge = await text('.slash-badge');
      assert.match(badge!, /skill/i);
    });

    it('clears the menu once the input is empty', async () => {
      await setInput('');
      await waitFor('.slash-item', (n) => n === 0);
      assert.strictEqual(await count('.slash-item'), 0, 'menu closes when the input is cleared');
    });
  });
});
