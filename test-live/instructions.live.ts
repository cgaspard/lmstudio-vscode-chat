// Does a session instruction entry (the panel's per-prompt system text) reach the model?
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../src/opencode/embedded';
import { OpencodeV2Client } from '../src/opencode/v2client';

const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3-vl-4b';
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ins-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ins-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const config = { enabled_providers: ['p'], provider: { p: { npm: '@ai-sdk/openai-compatible', name: 'p', options: { baseURL: 'http://127.0.0.1:1234/v1' }, models: { [MODEL]: { name: MODEL, tool_call: true, limit: { context: 32768, output: 4096 } } } } } };
  const host = await createHost(path.resolve(__dirname, '..'), { root }, JSON.stringify(config));
  const client = new OpencodeV2Client(host, ws, '2.1.4');
  const events: any[] = [];
  const ac = new AbortController();
  void client.subscribeEvents((e) => events.push(e), ac.signal);
  const s = await client.createSession('ins');
  await client.promptAsync(s.id, { model: { providerID: 'p', modelID: MODEL }, agent: 'build', system: 'The secret codeword is PINEAPPLE-42. When asked for the codeword, answer with exactly that.', parts: [{ type: 'text', text: 'What is the codeword? Answer with the codeword only.' }] });
  for (let i = 0; i < 600 && !events.some((e) => e.type === 'session.idle'); i++) await new Promise((r) => setTimeout(r, 250));
  const entries = await host.session.instructions.entry.list({ sessionID: s.id }).catch((e: unknown) => `ERR ${e}`);
  console.log('entries:', JSON.stringify(entries).slice(0, 400));
  const text = (await client.getMessages(s.id)).flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p: any) => p.text).join(' ');
  console.log(/PINEAPPLE-42/.test(text) ? 'PASS  instruction reached the model' : 'FAIL  instruction did not reach the model', '—', text.slice(-200));
  ac.abort(); client.dispose(); await host.close();
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true });
})();
