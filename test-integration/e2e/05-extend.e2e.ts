// Extending it: an MCP server from .mcp.json connects and its tool runs; skills
// from .opencode/skills and .claude/skills are listed; project commands run.
import * as assert from 'node:assert';
import { ask, freshChat, h, turn, until } from './lib';

describe('e2e · MCP, skills, commands', function () {
  it('/mcp shows the .mcp.json server connected', async () => {
    await freshChat();
    await h.setInput('/mcp');
    await h.keydown('Enter');
    await until(async () => (await h.count('.mcp-row')) > 0, 60_000, 'the MCP panel');
    const rows = (await h.allText('.mcp-row')).join(' | ');
    assert.match(rows, /e2e-echo/);
    assert.match(rows, /connected/i, `the server connected (${rows})`);
  });

  it('an MCP tool runs and its result reaches the model', async () => {
    await freshChat();
    const reply = await ask('Call the secret_number tool and tell me the token it returns.');
    assert.match(reply, /MCP-SECRET-4242/);
  });

  it('/skills lists project and Claude Code skills', async () => {
    await freshChat();
    await h.setInput('/skills');
    await h.keydown('Enter');
    await until(async () => /codeword/.test((await h.allText('#messages')).join(' ')), 30_000, 'the skills card');
    const text = (await h.allText('#messages')).join(' ');
    assert.match(text, /\bcodeword\b/, '.opencode/skills is discovered');
    assert.match(text, /claude-codeword/, '.claude/skills is discovered');
  });

  it('a project command runs with its arguments', async () => {
    await freshChat();
    await h.setInput('/hello world');
    await h.keydown('Enter');
    await turn();
    assert.match((await h.allText('.msg.assistant .part-text')).join(' '), /HELLO-world/);
  });
});
