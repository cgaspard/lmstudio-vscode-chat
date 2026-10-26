// Restarting the embedded engine (a settings change, "Restart OpenCode Server")
// must not take the extension host down or wedge it: the old host closes, a new
// one opens on the same data, and prompts keep working. Mirrors what
// OpencodeServerManager does, against a real LM Studio.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost, type SdkHost } from '../src/opencode/embedded';
import type { OpencodeEvent } from '../src/opencode/protocol';
import { OpencodeV2Client } from '../src/opencode/v2client';

const BASE_URL = process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3-vl-4b';

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rs-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rs-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const config = (perm: string) =>
    JSON.stringify({
      permission: perm === 'strict' ? { '*': 'ask', question: 'allow' } : { question: 'allow' },
      enabled_providers: ['p'],
      provider: { p: { npm: '@ai-sdk/openai-compatible', name: 'p', options: { baseURL: BASE_URL }, models: { [MODEL]: { name: MODEL, tool_call: true, limit: { context: 32768, output: 4096 } } } } },
    });
  let failed = 0;
  let closing: Promise<void> = Promise.resolve();
  let host: SdkHost | undefined;
  let client: OpencodeV2Client | undefined;
  const modes = ['default', 'strict', 'default', 'bypass', 'default'];
  for (const [i, mode] of modes.entries()) {
    // What dispose() + start() do: close the old host, wait for it, open a new one.
    if (host) {
      const old = host;
      client?.dispose();
      closing = closing.then(() => old.close());
      // The stale client must fail fast so the bridge reconnects (never hang).
      const t0 = Date.now();
      const stale = await client!.listSessions().then(() => 'answered', (e: Error) => e.message);
      const fast = Date.now() - t0 < 1000 && /engine stopped/i.test(stale);
      console.log(`${fast ? 'PASS' : 'FAIL'}  restart ${i}: the old client fails fast (${stale}, ${Date.now() - t0}ms)`);
      failed += fast ? 0 : 1;
    }
    await closing;
    host = await createHost(path.resolve(__dirname, '..'), { root }, config(mode));
    client = new OpencodeV2Client(host, ws, 'live');
    const events: OpencodeEvent[] = [];
    const ac = new AbortController();
    void client.subscribeEvents((e) => events.push(e), ac.signal);
    const s = await client.createSession(`restart ${i}`);
    await client.promptAsync(s.id, { model: { providerID: 'p', modelID: MODEL }, agent: 'build', parts: [{ type: 'text', text: `Reply with exactly: ROUND-${i}` }] });
    for (let k = 0; k < 600 && !events.some((e) => e.type === 'session.idle'); k++) await new Promise((r) => setTimeout(r, 200));
    const text = (await client.getMessages(s.id)).flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p: any) => p.text).join(' ');
    const ok = new RegExp(`ROUND-${i}`).test(text);
    console.log(`${ok ? 'PASS' : 'FAIL'}  engine ${i} (${mode}) answers after restart`);
    failed += ok ? 0 : 1;
    ac.abort();
  }
  const sessions = await client!.listSessions();
  const kept = sessions.length === modes.length;
  console.log(`${kept ? 'PASS' : 'FAIL'}  every session survived the restarts (${sessions.length}/${modes.length})`);
  failed += kept ? 0 : 1;
  client!.dispose();
  await host!.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})();
