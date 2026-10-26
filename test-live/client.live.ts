// Live check of OpencodeV2Client against the embedded engine and a real local
// model. Not part of `npm test`: it needs opencode-sdk/ built and LM Studio up.
//
//   npm run test:live            (builds, then runs under VS Code's own runtime)
//
// Env: LIVE_BASE_URL (default http://127.0.0.1:1234/v1), LIVE_MODEL (default
// qwen/qwen3-vl-4b).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toEngineProviderID } from '../src/core/providerIds';
import { createHost } from '../src/opencode/embedded';
import type { OpencodeEvent } from '../src/opencode/protocol';
import { OpencodeV2Client } from '../src/opencode/v2client';

const REPO = path.resolve(__dirname, '..');
const BASE_URL = process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3-vl-4b';
// The id the panel uses. It is reserved by OpenCode 2's built-in LM Studio
// plugin, so the config declares it under its engine id (see providerIds.ts)
// and the client maps it back.
const PROVIDER = 'lmstudio';
const ENGINE_PROVIDER = toEngineProviderID(PROVIDER);

const results: boolean[] = [];
function check(name: string, ok: boolean, detail: unknown = ''): void {
  results.push(ok);
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? `  — ${d.slice(0, 220)}` : ''}`);
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-live-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-live-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const config = {
    permission: { question: 'allow' },
    enabled_providers: [ENGINE_PROVIDER],
    provider: {
      [ENGINE_PROVIDER]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'LM Studio (local)',
        options: { baseURL: BASE_URL, includeUsage: true },
        models: {
          [MODEL]: {
            name: MODEL,
            attachment: true,
            reasoning: true,
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 32768, output: 8192 },
            variants: { off: { reasoningEffort: 'none' }, high: { reasoningEffort: 'high' } },
          },
        },
      },
    },
  };

  const host = await createHost(REPO, { root }, JSON.stringify(config));
  const client = new OpencodeV2Client(host, ws, '2.1.4');
  const events: OpencodeEvent[] = [];
  const ac = new AbortController();
  void client.subscribeEvents((e) => events.push(e), ac.signal);
  const waitFor = async (pred: (e: OpencodeEvent) => boolean, ms: number, from = 0) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    return undefined;
  };
  const sid = (e: OpencodeEvent) => (e.properties as any).sessionID;
  const idle = (id: string, from: number, ms = 240000) => waitFor((e) => e.type === 'session.idle' && sid(e) === id, ms, from);
  const model = { providerID: PROVIDER, modelID: MODEL };

  try {
    // -- catalog --------------------------------------------------------------
    const providers = await client.listProviders();
    const mine = providers.providers.find((p) => p.id === PROVIDER);
    check('listProviders includes the configured local provider', !!mine?.models[MODEL], providers.providers.map((p) => p.id));
    check('enabled_providers keeps auto-detected providers out', providers.providers.every((p) => p.id === PROVIDER || p.id === 'opencode'), providers.providers.map((p) => p.id));
    // The built-in LM Studio plugin would list every model on the server under
    // the raw `lmstudio` id; only the one declared model may appear.
    check('the built-in LM Studio plugin stays out of the panel provider', !!mine && mine.name === 'LM Studio (local)' && Object.keys(mine.models).length === 1, mine && { name: mine.name, models: Object.keys(mine.models) });
    check('model carries variants + vision + limit', !!mine && Object.keys(mine.models[MODEL].variants ?? {}).length === 2 && !!mine.models[MODEL].capabilities?.input?.image && mine.models[MODEL].limit?.context === 32768);
    const agents = await client.listAgents();
    check('listAgents has build + plan by id', ['build', 'plan'].every((n) => agents.some((a) => a.name === n)), agents.map((a) => `${a.name}:${a.mode}${a.hidden ? ':hidden' : ''}`));
    check('internal agents are flagged hidden', ['compaction', 'title', 'summary'].every((n) => agents.find((a) => a.name === n)?.hidden !== false), agents.filter((a) => !a.hidden).map((a) => a.name));
    check('listCommands answers', Array.isArray(await client.listCommands()));
    check('listSkills answers', Array.isArray(await client.listSkills()));
    check('listMcp answers', typeof (await client.listMcp()) === 'object');

    // -- a tool-using turn ----------------------------------------------------
    const s = await client.createSession('live');
    check('createSession', !!s.id && s.title === 'live', s);
    let mark = events.length;
    await client.promptAsync(s.id, {
      model,
      agent: 'build',
      variant: 'off',
      system: 'The secret codeword is PINEAPPLE-42. End every final answer with the codeword.',
      parts: [{ type: 'text', text: 'Use the write tool to create live.txt containing exactly: embedded ok. Then reply with one short sentence.' }],
    });
    check('turn reaches idle', !!(await idle(s.id, mark)));
    const written = fs.existsSync(path.join(ws, 'live.txt')) ? fs.readFileSync(path.join(ws, 'live.txt'), 'utf8') : '';
    check('write tool ran', written.includes('embedded ok'), written);
    const tys = new Set(events.slice(mark).map((e) => e.type));
    check('1.x events flow (user bubble, deltas, tool part, idle)', ['inbox.delivered', 'message.updated', 'message.part.delta', 'message.part.updated', 'session.idle'].every((t) => tys.has(t)), [...tys]);
    const msgs = await client.getMessages(s.id);
    const lastText = msgs.filter((m) => m.info.role === 'assistant').flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p: any) => p.text).join(' ');
    check('getMessages returns the turn once, oldest-first', msgs[0]?.info.role === 'user' && msgs.filter((m) => m.info.role === 'user').length === 1 && msgs.some((m) => m.parts.some((p) => p.type === 'tool')), msgs.map((m) => m.info.role));
    // Whether a model appends the codeword to a tool turn is up to the model;
    // asking for it directly shows the instruction reached it.
    mark = events.length;
    await client.promptAsync(s.id, { model, agent: 'build', parts: [{ type: 'text', text: 'What is the secret codeword? Answer with the codeword only.' }] });
    await idle(s.id, mark);
    const answer = (await client.getMessages(s.id)).filter((m) => m.info.role === 'assistant').flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p: any) => p.text).join(' ');
    check('system instructions reached the model', /PINEAPPLE-42/.test(lastText) || /PINEAPPLE-42/.test(answer), answer.slice(-120));

    // -- steering: queue while busy, flip to steer, cancel another --------------
    mark = events.length;
    await client.promptAsync(s.id, { model, agent: 'build', parts: [{ type: 'text', text: 'Count slowly from 1 to 40, one number per line, then stop.' }] });
    await waitFor((e) => e.type === 'message.part.delta' && sid(e) === s.id, 120000, mark);
    await client.promptAsync(s.id, { model, agent: 'build', delivery: 'queue', parts: [{ type: 'text', text: 'Now reply with the single word QUEUED-OK.' }] });
    await client.promptAsync(s.id, { model, agent: 'build', delivery: 'queue', parts: [{ type: 'text', text: 'Reply with CANCEL-ME.' }] });
    const enq = await waitFor((e) => e.type === 'inbox.enqueued' && /CANCEL-ME/.test((e.properties as any).text), 30000, mark);
    const pending = client.pendingInbox(s.id);
    check('busy session holds queued prompts as pending', pending.length >= 2 && pending.every((p) => p.delivery === 'queue'), pending.map((p) => `${p.delivery}:${p.text.slice(0, 20)}`));
    if (enq) {
      await client.cancelPending(s.id, (enq.properties as any).inboxID);
      check('cancelPending withdraws it', !!(await waitFor((e) => e.type === 'inbox.cancelled', 15000, mark)));
    }
    const q = client.pendingInbox(s.id).find((p) => /QUEUED-OK/.test(p.text));
    if (q) {
      await client.setDelivery(s.id, q.inboxID, 'steer');
      check('setDelivery switches queue → steer', !!(await waitFor((e) => e.type === 'inbox.changed' && (e.properties as any).delivery === 'steer', 15000, mark)));
    }
    await waitFor((e) => e.type === 'inbox.delivered' && (e.properties as any).inboxID === q?.inboxID, 240000, mark);
    await idle(s.id, events.length - 1);
    await waitFor((e) => e.type === 'session.idle' && sid(e) === s.id, 240000, mark);
    const after = (await client.getMessages(s.id)).flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p: any) => p.text).join(' ');
    check('steered prompt was answered', /QUEUED-OK/.test(after) && (after.match(/QUEUED-OK/g) ?? []).length <= 3, after.slice(-160));
    check('cancelled prompt never reached the model', !/CANCEL-ME/.test(after.replace('Reply with CANCEL-ME.', '')));

    // -- stop, compact, rename, delete --------------------------------------------
    mark = events.length;
    await client.promptAsync(s.id, { model, agent: 'plan', parts: [{ type: 'text', text: 'Write a 1200-word essay about compilers.' }] });
    await waitFor((e) => e.type === 'message.part.delta' && sid(e) === s.id, 120000, mark);
    await client.abort(s.id);
    const stop = await waitFor((e) => e.type === 'session.error' && sid(e) === s.id, 60000, mark);
    check('abort surfaces as a stop', (stop?.properties as any)?.error?.name === 'MessageAbortedError');
    await idle(s.id, mark, 60000);
    mark = events.length;
    await client.summarize(s.id, PROVIDER, MODEL);
    check('summarize waits for compaction', events.slice(mark).some((e) => e.type === 'session.compacted'));
    const hist = await client.getMessages(s.id);
    check('compaction appears in history as marker + summary', hist.some((m) => m.parts.some((p) => p.type === 'compaction')));
    await client.updateSession(s.id, { title: 'renamed' });
    check('updateSession + listSessions', (await client.listSessions()).some((x) => x.id === s.id && x.title === 'renamed'));
    await client.deleteSession(s.id);
    check('deleteSession', !(await client.listSessions()).some((x) => x.id === s.id));
  } catch (err) {
    check('unexpected exception', false, String((err as Error)?.stack ?? err));
  } finally {
    ac.abort();
    client.dispose();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

void main();
