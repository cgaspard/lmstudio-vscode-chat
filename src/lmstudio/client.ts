import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lmStudioRestRoot } from '../config';
import { log, logError } from '../logger';

export interface LMStudioModel {
  id: string;
  displayName: string;
  type: string; // llm | vlm | embedding | ...
  state?: string; // loaded | not-loaded
  maxContextLength?: number;
  loadedContextLength?: number;
  toolUse?: boolean;
  vision?: boolean;
  quantization?: string;
  arch?: string;
  publisher?: string; // e.g. "unsloth", "lmstudio-community" — disambiguates same-named models
  format?: string; // runtime format, e.g. "MLX" or "GGUF" (from compatibility_type)
}

/** Discovery + lifecycle helper for a local LM Studio server. */
export class LMStudioClient {
  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private get rest(): string {
    return lmStudioRestRoot(this.baseUrl);
  }

  async checkConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(4000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * List chat-capable models (embeddings filtered out), richest metadata first.
   *
   * Primary source is `/api/v1/models`: it's the *canonical* keyed list (one
   * entry per model, keyed by e.g. "unsloth/qwen3.6-27b-mlx"), which LM Studio's
   * own UI uses. `/api/v0/models` is avoided as the primary because it can
   * surface a phantom duplicate of a loaded model under its bare instance id
   * (e.g. both "qwen3.6-27b-mlx" and "unsloth/qwen3.6-27b-mlx"). The `key`
   * doubles as the model id everywhere — LM Studio accepts it for load and for
   * `/v1/chat/completions` inference, resolving it to the loaded instance.
   */
  async listModels(): Promise<LMStudioModel[]> {
    try {
      const res = await fetch(`${this.rest}/api/v1/models`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = (await res.json()) as { models?: any[] };
        const arr = json.models ?? [];
        return arr
          .filter(
            (m) => m && typeof m.key === 'string' && !/embed/i.test(m.type ?? '') && !/embed/i.test(m.key),
          )
          .map((m): LMStudioModel => {
            const instance = (m.loaded_instances ?? [])[0];
            const caps = m.capabilities ?? {};
            return {
              id: m.key,
              displayName: prettyName(m.key),
              type: m.type ?? 'llm',
              state: instance ? 'loaded' : 'not-loaded',
              maxContextLength: m.max_context_length,
              loadedContextLength: instance?.config?.context_length,
              toolUse: !!(caps.trained_for_tool_use ?? caps.tool_use),
              vision: !!caps.vision,
              quantization: typeof m.quantization === 'object' ? m.quantization?.name : m.quantization,
              arch: m.architecture ?? m.arch,
              publisher: m.publisher,
              format: prettyFormat(m.format),
            };
          });
      }
    } catch (err) {
      logError('listModels via /api/v1/models failed, falling back to /api/v0/models', err);
    }
    // Fallback: the v0 rich endpoint (may include phantom dup rows, but still
    // carries metadata) when v1 is unavailable on an older LM Studio.
    try {
      const res = await fetch(`${this.rest}/api/v0/models`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = (await res.json()) as { data?: any[] };
        const arr = json.data ?? [];
        return arr
          .filter((m) => m && !/embed/i.test(m.type ?? '') && !/embed/i.test(m.id ?? ''))
          .map((m): LMStudioModel => ({
            id: m.id,
            displayName: prettyName(m.id),
            type: m.type ?? 'llm',
            state: m.state,
            maxContextLength: m.max_context_length,
            loadedContextLength: m.loaded_context_length,
            toolUse: Array.isArray(m.capabilities) ? m.capabilities.includes('tool_use') : undefined,
            vision: m.type === 'vlm',
            quantization: m.quantization,
            arch: m.arch,
            publisher: m.publisher,
            format: prettyFormat(m.compatibility_type),
          }));
      }
    } catch (err) {
      logError('listModels via /api/v0/models failed, falling back to /v1/models', err);
    }
    // Last resort: OpenAI-compatible endpoint (no rich metadata).
    try {
      const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = (await res.json()) as { data?: any[] };
        return (json.data ?? [])
          .filter((m) => m && !/embed/i.test(m.id))
          .map((m): LMStudioModel => ({ id: m.id, displayName: prettyName(m.id), type: 'llm' }));
      }
    } catch (err) {
      logError('listModels via /v1/models failed', err);
    }
    return [];
  }

  /** Find a single model's current metadata. */
  async getModel(modelId: string): Promise<LMStudioModel | undefined> {
    const models = await this.listModels();
    return models.find((m) => m.id === modelId);
  }

  /**
   * Ensure `modelId` is loaded with at least `minContext` tokens of context.
   * Uses LM Studio's native REST API (`/api/v1/models/load|unload`); falls back
   * to the `lms` CLI only if REST is unavailable. Never throws.
   */
  async ensureContext(
    modelId: string,
    minContext: number,
    gpu: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ reloaded: boolean; context?: number; note?: string }> {
    try {
      const model = await this.getModel(modelId);
      if (!model) {
        return { reloaded: false, note: 'model not found in LM Studio' };
      }
      const cap = model.maxContextLength ?? minContext;
      const target = Math.min(minContext, cap);
      const ctx = model.loadedContextLength ?? 0;
      if (model.state === 'loaded' && ctx >= target) {
        return { reloaded: false, context: ctx };
      }
      onProgress?.(`Loading ${prettyName(modelId)} with ${target.toLocaleString()} context…`);
      // Prefer the native REST API (no external CLI dependency).
      try {
        const instances = await this.loadedInstanceIds(modelId);
        for (const id of instances) {
          await this.unloadInstance(id).catch(() => undefined);
        }
        const loaded = await this.loadModel(modelId, target);
        return { reloaded: true, context: loaded.contextLength ?? target };
      } catch (restErr) {
        logError('REST model load failed, trying lms CLI fallback', restErr);
      }
      const lms = await resolveLmsCli();
      if (!lms) {
        return {
          reloaded: false,
          context: ctx || undefined,
          note: 'REST load failed and lms CLI not found; relying on JIT loading',
        };
      }
      log(`ensureContext: lms load ${modelId} -c ${target} --gpu ${gpu} -y`);
      await runLms(lms, ['load', modelId, '-c', String(target), '--gpu', gpu, '-y']);
      return { reloaded: true, context: target };
    } catch (err) {
      logError('ensureContext failed', err);
      return { reloaded: false, note: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Load a model with a context window via REST. Returns the instance id. */
  async loadModel(
    modelId: string,
    contextLength: number,
  ): Promise<{ instanceId?: string; contextLength?: number }> {
    const res = await fetch(`${this.rest}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        context_length: contextLength,
        flash_attention: true,
        echo_load_config: true,
      }),
      signal: AbortSignal.timeout(600000),
    });
    if (!res.ok) {
      throw new Error(`models/load ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const j = (await res.json()) as { instance_id?: string; load_config?: { context_length?: number } };
    return { instanceId: j.instance_id, contextLength: j.load_config?.context_length };
  }

  /** Unload a specific loaded instance via REST. */
  async unloadInstance(instanceId: string): Promise<void> {
    const res = await fetch(`${this.rest}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instance_id: instanceId }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`models/unload ${res.status}`);
    }
  }

  /** Unload every loaded instance of a model (by model key). */
  async unloadModel(modelId: string): Promise<void> {
    const ids = await this.loadedInstanceIds(modelId);
    for (const id of ids) {
      await this.unloadInstance(id).catch(() => undefined);
    }
  }

  /**
   * Return the loaded instance ids for a model (empty if none / unsupported).
   * `modelId` (from /api/v0/models) can be a bare id like "qwen3.6-27b-mlx"
   * while /api/v1/models keys the same model as "unsloth/qwen3.6-27b-mlx" and
   * exposes the bare id only on the loaded *instance*. So match on the model
   * `key`/`id` OR any loaded instance id — otherwise an eject silently no-ops.
   */
  async loadedInstanceIds(modelId: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.rest}/api/v1/models`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        return [];
      }
      const j = (await res.json()) as { models?: any[]; data?: any[] };
      const arr = j.models ?? j.data ?? [];
      const ids: string[] = [];
      for (const x of arr) {
        const instances = (x?.loaded_instances ?? []) as Array<{ id?: string }>;
        const keyMatches = x.key === modelId || x.id === modelId;
        for (const inst of instances) {
          if (!inst?.id) {
            continue;
          }
          // Take the instance if its model matches, or the instance id itself is
          // the one we were asked to unload (the bare-id case).
          if (keyMatches || inst.id === modelId) {
            ids.push(inst.id);
          }
        }
      }
      return ids;
    } catch {
      return [];
    }
  }
}

function prettyName(id: string): string {
  if (!id) {
    return 'unknown';
  }
  const base = id.split('/').pop() ?? id;
  return base;
}

// LM Studio's `compatibility_type` (e.g. "mlx", "gguf") → a clean badge label.
// Unknown values are upper-cased as-is so new runtimes still surface something.
function prettyFormat(compatibilityType?: string): string | undefined {
  if (!compatibilityType) {
    return undefined;
  }
  const known: Record<string, string> = { mlx: 'MLX', gguf: 'GGUF' };
  return known[compatibilityType.toLowerCase()] ?? compatibilityType.toUpperCase();
}

/** Run `lms` with args, capturing output; rejects on non-zero exit. */
function runLms(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`lms exited ${code}: ${err || out}`));
      }
    });
    // Safety timeout: 10 minutes for very large model loads.
    setTimeout(() => {
      child.kill();
      reject(new Error('lms load timed out'));
    }, 600000);
  });
}

let cachedLms: string | null | undefined;

/** Locate the LM Studio `lms` CLI across platforms. */
export async function resolveLmsCli(): Promise<string | null> {
  if (cachedLms !== undefined) {
    return cachedLms;
  }
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'LM Studio', 'resources', 'bin', 'lms.exe')]
      : [
          path.join(home, '.lmstudio', 'bin', 'lms'),
          path.join(home, '.cache', 'lm-studio', 'bin', 'lms'),
          '/Applications/LM Studio.app/Contents/Resources/lms',
        ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedLms = c;
      return c;
    }
  }
  // Fall back to PATH.
  cachedLms = await new Promise<string | null>((resolve) => {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(which, ['lms']);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().split('\n')[0] : null));
  });
  return cachedLms;
}
