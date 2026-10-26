// /compact as the bridge does it: summarize, then read history back and find
// the marker and the summary that follows it (src/panel/bridge.ts compactionState).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../src/opencode/embedded';
import type { OpencodeEvent } from '../src/opencode/protocol';
import { OpencodeV2Client } from '../src/opencode/v2client';

const BASE_URL = process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3-vl-4b';

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cp-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cp-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const config = { enabled_providers: ['p'], provider: { p: { npm: '@ai-sdk/openai-compatible', name: 'p', options: { baseURL: BASE_URL }, models: { [MODEL]: { name: MODEL, tool_call: true, limit: { context: 32768, output: 4096 } } } } } };
  const host = await createHost(path.resolve(__dirname, '..'), { root }, JSON.stringify(config));
  const client = new OpencodeV2Client(host, ws, 'live');
  const events: OpencodeEvent[] = [];
  const ac = new AbortController();
  void client.subscribeEvents((e) => events.push(e), ac.signal);
  const s = await client.createSession('compact');
  await client.promptAsync(s.id, { model: { providerID: 'p', modelID: MODEL }, agent: 'build', parts: [{ type: 'text', text: 'Remember this: the launch code is ZEBRA-9. Reply OK.' }] });
  for (let i = 0; i < 600 && !events.some((e) => e.type === 'session.idle'); i++) await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  await client.summarize(s.id, 'p', MODEL);
  console.log(`summarize returned after ${Date.now() - t0}ms; live events: ${events.filter((e) => /compact/.test(e.type) || (e.type === 'message.part.updated' && (e.properties as any).part.type === 'compaction')).map((e) => e.type).join(' ')}`);
  const raw = await host.message.list({ sessionID: s.id, order: 'asc', limit: 200 });
  console.log('raw compaction rows:', JSON.stringify((raw.data ?? []).filter((m: any) => m.type === 'compaction')).slice(0, 400));
  const msgs = await client.getMessages(s.id);
  console.log('history:', msgs.map((m) => `${m.info.role}[${m.parts.map((p) => p.type).join(',')}]`).join(' '));
  let pending = false;
  let summary = '';
  for (const m of msgs) {
    if (m.parts.some((p) => p.type === 'compaction')) { pending = true; continue; }
    if (pending && m.info.role === 'assistant') { summary = m.parts.filter((p) => p.type === 'text').map((p: any) => p.text).join(''); pending = false; }
  }
  console.log(/ZEBRA-9|launch/i.test(summary) ? 'PASS  the bridge finds the summary after the marker' : `FAIL  summary the bridge would show: ${JSON.stringify(summary.slice(0, 200))}`);
  ac.abort(); client.dispose(); await host.close();
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true });
})();
