// MCP through the embedded engine: status shape, and whether a model can call
// a stdio server's tool (directly, or through v2's Code Mode `execute`).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../src/opencode/embedded';
import type { OpencodeEvent } from '../src/opencode/protocol';
import { OpencodeV2Client } from '../src/opencode/v2client';

const BASE_URL = process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3-vl-4b';
const CODEMODE = process.env.MCP_CODEMODE; // unset = engine default; 'false' = direct tools

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcp-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcp-ws-'));
  fs.cpSync(path.resolve(__dirname, '..', 'test-integration', 'e2e', 'workspace', 'tools'), path.join(ws, 'tools'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const log = path.join(root, 'mcp-echo.log');
  const server: Record<string, unknown> = { type: 'local', command: ['node', path.join(ws, 'tools', 'mcp-echo.js')], environment: { MCP_ECHO_LOG: log } };
  const config = {
    permission: { '*': 'allow' },
    enabled_providers: ['p'],
    provider: { p: { npm: '@ai-sdk/openai-compatible', name: 'p', options: { baseURL: BASE_URL }, models: { [MODEL]: { name: MODEL, tool_call: true, limit: { context: 32768, output: 4096 } } } } },
    // As the extension sends it: native shape, Code Mode off unless MCP_CODEMODE says otherwise.
    mcp: { servers: { 'e2e-echo': CODEMODE === 'true' ? { ...server, codemode: true } : { ...server, codemode: false } } },
  };
  const host = await createHost(path.resolve(__dirname, '..'), { root }, JSON.stringify(config));
  const client = new OpencodeV2Client(host, ws, 'live');
  let raw: any;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    raw = await host.mcp.list({ location: { directory: ws } });
    if ((raw?.data ?? []).length) break;
  }
  console.log('RAW mcp.list:', JSON.stringify(raw?.data ?? raw).slice(0, 600));
  console.log('server saw:', fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').map((l) => l.slice(0, 160)).join('\n           ') : '(nothing)');
  const cfg = await host.config.get?.({ location: { directory: ws } }).catch((e: unknown) => String(e));
  console.log('config.mcp:', JSON.stringify(cfg?.data?.mcp ?? cfg?.mcp ?? cfg).slice(0, 400));
  console.log('client.listMcp:', JSON.stringify(await client.listMcp()).slice(0, 300));
  const events: OpencodeEvent[] = [];
  const ac = new AbortController();
  void client.subscribeEvents((e) => events.push(e), ac.signal);
  const s = await client.createSession('mcp');
  await client.promptAsync(s.id, { model: { providerID: 'p', modelID: MODEL }, agent: 'build', parts: [{ type: 'text', text: 'Call the secret_number tool and tell me the token it returns.' }] });
  for (let i = 0; i < 600 && !events.some((e) => e.type === 'session.idle'); i++) await new Promise((r) => setTimeout(r, 200));
  const tools = events.filter((e) => e.type === 'message.part.updated' && (e.properties as any).part.type === 'tool').map((e) => `${(e.properties as any).part.tool}:${(e.properties as any).part.state.status}`);
  console.log('tool parts:', [...new Set(tools)].join(' '));
  console.log('idle:', events.some((e) => e.type === 'session.idle'), 'errors:', JSON.stringify(events.filter((e) => e.type === 'session.error').map((e) => e.properties)).slice(0, 300));
  const text = (await client.getMessages(s.id)).flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p: any) => p.text).join(' ');
  console.log(/MCP-SECRET-4242/.test(text) ? 'PASS  MCP tool result reached the model' : 'FAIL  no MCP result', '—', text.slice(-160));
  // Compaction on the same session.
  const t0 = Date.now();
  const mark = events.length;
  await client.summarize(s.id, 'p', MODEL).catch((e) => console.log('summarize threw:', String(e)));
  console.log(`compaction events (${Date.now() - t0}ms):`, events.slice(mark).map((e) => e.type).filter((t) => /compact|error|idle/.test(t)).join(' '));
  ac.abort();
  client.dispose();
  await host.close();
})();
