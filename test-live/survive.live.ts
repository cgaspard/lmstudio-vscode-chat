// The extension host must outlive the engine's child processes: closing an
// engine (which stops its MCP servers) and running shell commands must never
// signal the host process itself.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../src/opencode/embedded';
import type { OpencodeEvent } from '../src/opencode/protocol';
import { OpencodeV2Client } from '../src/opencode/v2client';

const BASE_URL = process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3-vl-4b';
const signals: string[] = [];
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
  process.on(sig, () => signals.push(sig)); // record instead of dying
}
process.on('exit', (code) => console.log(`process exit code=${code} signals=[${signals.join(',')}]`));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sv-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sv-ws-'));
  fs.cpSync(path.resolve(__dirname, '..', 'test-integration', 'e2e', 'workspace', 'tools'), path.join(ws, 'tools'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const config = {
    permission: { '*': 'allow' },
    enabled_providers: ['p'],
    provider: { p: { npm: '@ai-sdk/openai-compatible', name: 'p', options: { baseURL: BASE_URL }, models: { [MODEL]: { name: MODEL, tool_call: true, limit: { context: 32768, output: 4096 } } } } },
    mcp: { servers: { echo: { type: 'local', command: ['node', path.join(ws, 'tools', 'mcp-echo.js')], codemode: false } } },
  };
  for (let round = 0; round < 3; round++) {
    const host = await createHost(path.resolve(__dirname, '..'), { root }, JSON.stringify(config));
    const client = new OpencodeV2Client(host, ws, 'live');
    const events: OpencodeEvent[] = [];
    const ac = new AbortController();
    void client.subscribeEvents((e) => events.push(e), ac.signal);
    await new Promise((r) => setTimeout(r, 4000)); // let the MCP server connect
    const s = await client.createSession(`round ${round}`);
    await client.promptAsync(s.id, { model: { providerID: 'p', modelID: MODEL }, agent: 'build', parts: [{ type: 'text', text: 'Use the shell tool to run `sleep 1; echo SHELL-DONE`, then reply DONE.' }] });
    for (let i = 0; i < 600 && !events.some((e) => e.type === 'session.idle'); i++) await new Promise((r) => setTimeout(r, 200));
    console.log(`round ${round}: turn ${events.some((e) => e.type === 'session.idle') ? 'finished' : 'did not finish'}; signals so far [${signals.join(',')}]`);
    ac.abort();
    client.dispose();
    await host.close(); // stops the MCP server and any shells
    await new Promise((r) => setTimeout(r, 2000));
    console.log(`round ${round}: alive after close; signals so far [${signals.join(',')}]`);
  }
  console.log(signals.length ? `FAIL  the host process was signalled: ${signals.join(',')}` : 'PASS  no signal ever reached the host process');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
})();
