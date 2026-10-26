// OpenCode 2's built-in local plugins take over a provider declared under their
// id (`lmstudio`, `ollama`, `vllm`): once they discover models they drop the
// declared ones and their variants. LM Studio Code's one provider is `lmstudio`,
// so the panel suffixes it at the engine boundary (src/core/providerIds.ts).
// This shows the takeover on the raw id and that the mapped id survives it,
// against a real LM Studio.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toEngineProviderID } from '../src/core/providerIds';
import { createHost } from '../src/opencode/embedded';
import { OpencodeV2Client } from '../src/opencode/v2client';

const BASE_URL = process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.LIVE_MODEL ?? 'qwen3-vl-30b-a3b-instruct-mlx';
const RESERVED = 'lmstudio';
const DISCOVERY_WAIT_MS = 40_000; // the plugins refresh every 30s

async function variantsAfterDiscovery(engineId: string): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-res-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-res-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const config = {
    enabled_providers: [engineId],
    provider: {
      [engineId]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'LM Studio (local)',
        options: { baseURL: BASE_URL },
        models: { [MODEL]: { name: MODEL, tool_call: true, limit: { context: 32768, output: 4096 }, variants: { off: { reasoningEffort: 'none' }, high: { reasoningEffort: 'high' } } } },
      },
    },
  };
  const host = await createHost(path.resolve(__dirname, '..'), { root }, JSON.stringify(config));
  const client = new OpencodeV2Client(host, ws, 'live');
  try {
    await new Promise((r) => setTimeout(r, DISCOVERY_WAIT_MS));
    const providers = await client.listProviders();
    const p = providers.providers.find((x) => x.id === RESERVED);
    return Object.keys(p?.models[MODEL]?.variants ?? {});
  } finally {
    client.dispose();
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

(async () => {
  const raw = await variantsAfterDiscovery(RESERVED);
  console.log(`${raw.length === 0 ? 'PASS' : 'NOTE'}  raw "${RESERVED}" id after discovery keeps variants: [${raw.join(', ')}] (the takeover this guards against)`);
  const mapped = await variantsAfterDiscovery(toEngineProviderID(RESERVED));
  const ok = mapped.includes('off') && mapped.includes('high');
  console.log(`${ok ? 'PASS' : 'FAIL'}  mapped id keeps the declared variants: [${mapped.join(', ')}]`);
  process.exitCode = ok ? 0 : 1;
})();
