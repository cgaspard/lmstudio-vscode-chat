import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionConfig, getConfig } from '../config';
import { clampContext } from '../core/context';
import { LMStudioClient } from '../lmstudio/client';
import { log, logError } from '../logger';
import { OpencodeClient } from './client';
import { BUILD_PROMPT, PLAN_PROMPT } from './prompts';

export interface ServerStartResult {
  baseUrl: string;
  client: OpencodeClient;
}

export interface Disposable {
  dispose(): void;
}

/**
 * Owns the lifecycle of a headless `opencode serve` process, configured to talk
 * to the local LM Studio server. Config is injected via OPENCODE_CONFIG_CONTENT
 * so nothing is written to the user's workspace or global config.
 */
export class OpencodeServerManager {
  private proc: ChildProcess | undefined;
  private baseUrl: string | undefined;
  private client: OpencodeClient | undefined;
  private starting: Promise<ServerStartResult> | undefined;
  private readonly exitListeners = new Set<() => void>();
  /** Procs we killed on purpose, so their `exit` doesn't trigger reconnects. */
  private readonly killed = new WeakSet<ChildProcess>();

  constructor(
    private readonly cfg: ExtensionConfig,
    private readonly lmStudio: LMStudioClient,
  ) {}

  get isRunning(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  /**
   * Register a callback fired whenever the server process exits unexpectedly.
   * Multiple bridges (sidebar + secondary + editor tabs) share one manager, so
   * each registers its own listener and disposes it on teardown.
   */
  addExitListener(cb: () => void): Disposable {
    this.exitListeners.add(cb);
    return { dispose: () => this.exitListeners.delete(cb) };
  }

  /** Start (or return the in-flight start of) the server. Idempotent. */
  async start(): Promise<ServerStartResult> {
    if (this.client && this.baseUrl) {
      return { baseUrl: this.baseUrl, client: this.client };
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<ServerStartResult> {
    const bin = await this.resolveBinary();
    if (!bin) {
      throw new Error(
        'opencode binary not found. Install it (e.g. `brew install sst/tap/opencode` or `npm i -g opencode-ai`) or set "lmstudioCode.opencodePath".',
      );
    }

    const configContent = await this.buildConfigContent();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    log(`starting opencode server: ${bin} serve --port ${this.cfg.serverPort} (cwd=${cwd})`);

    const proc = spawn(
      bin,
      ['serve', '--port', String(this.cfg.serverPort), '--hostname', '127.0.0.1'],
      {
        cwd,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: configContent,
          NO_COLOR: '1',
        },
      },
    );
    this.proc = proc;

    const baseUrl = await this.awaitListening(proc);
    this.baseUrl = baseUrl;
    log(`opencode server listening at ${baseUrl}`);

    const client = new OpencodeClient(baseUrl);
    // Confirm health before declaring ready.
    await this.waitHealthy(client);
    this.client = client;

    proc.on('exit', (code, signal) => {
      const intentional = this.killed.has(proc);
      log(`opencode server exited (code=${code}, signal=${signal}${intentional ? ', intentional' : ''})`);
      this.killed.delete(proc);
      if (this.proc === proc) {
        this.proc = undefined;
        this.baseUrl = undefined;
        this.client = undefined;
      }
      // Only notify on an *unexpected* exit so bridges can self-heal; a dispose
      // / restart we triggered ourselves must not kick a reconnect storm.
      if (!intentional) {
        for (const cb of [...this.exitListeners]) {
          try {
            cb();
          } catch (err) {
            logError('exit listener threw', err);
          }
        }
      }
    });

    return { baseUrl, client };
  }

  /** Resolve a URL from the server's stdout/stderr "listening on ..." line. */
  private awaitListening(proc: ChildProcess): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const urlRe = /listening on\s+(https?:\/\/[^\s]+)/i;

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        log(`[opencode] ${text.trimEnd()}`);
        const m = text.match(urlRe);
        if (m && !settled) {
          settled = true;
          cleanup();
          resolve(m[1].replace(/\/+$/, ''));
        }
      };
      const onErr = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };
      const onExit = (code: number | null) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`opencode server exited before listening (code=${code})`));
        }
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('timed out waiting for opencode server to start (30s)'));
        }
      }, 30000);

      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        proc.stderr?.off('data', onData);
        proc.off('error', onErr);
        proc.off('exit', onExit);
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('error', onErr);
      proc.on('exit', onExit);
    });
  }

  private async waitHealthy(client: OpencodeClient): Promise<void> {
    for (let i = 0; i < 20; i++) {
      try {
        const h = await client.health();
        if (h.healthy) {
          return;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('opencode server did not become healthy');
  }

  /** Build the OPENCODE_CONFIG_CONTENT JSON injecting the LM Studio provider. */
  private async buildConfigContent(): Promise<string> {
    const models: Record<string, Record<string, unknown>> = {};
    const ctx = getConfig().minContextLength; // read fresh so context-size changes apply on restart
    try {
      const list = await this.lmStudio.listModels();
      for (const m of list) {
        // OpenCode drops image attachments unless the model is declared with
        // attachment + image modality. Align the context limit with the window
        // we ensure-load so OpenCode compacts before LM Studio overflows — but
        // never declare more context than the model actually supports.
        const perModel = clampContext(ctx, m.maxContextLength);
        models[m.id] = {
          name: m.displayName,
          attachment: !!m.vision,
          reasoning: true,
          tool_call: m.toolUse ?? true,
          modalities: {
            input: m.vision ? ['text', 'image'] : ['text'],
            output: ['text'],
          },
          limit: { context: perModel, output: Math.min(8192, Math.floor(perModel / 2)) },
        };
      }
    } catch (err) {
      logError('could not enumerate LM Studio models for config', err);
    }
    // Override the build/plan agent prompts so the model identifies as
    // "LM Studio Code" instead of OpenCode's built-in "You are opencode…".
    const config = {
      $schema: 'https://opencode.ai/config.json',
      agent: {
        build: { prompt: BUILD_PROMPT },
        plan: { prompt: PLAN_PROMPT },
      },
      provider: {
        lmstudio: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LM Studio (local)',
          options: { baseURL: this.lmStudio.getBaseUrl(), includeUsage: true },
          ...(Object.keys(models).length ? { models } : {}),
        },
      },
    };
    return JSON.stringify(config);
  }

  /** Find the opencode binary: setting -> known install path -> PATH. */
  private async resolveBinary(): Promise<string | null> {
    if (this.cfg.opencodePath && fs.existsSync(this.cfg.opencodePath)) {
      return this.cfg.opencodePath;
    }
    const home = os.homedir();
    const candidates =
      process.platform === 'win32'
        ? [path.join(home, '.opencode', 'bin', 'opencode.exe')]
        : [
            path.join(home, '.opencode', 'bin', 'opencode'),
            '/opt/homebrew/bin/opencode',
            '/usr/local/bin/opencode',
          ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }
    return new Promise<string | null>((resolve) => {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const child = spawn(which, ['opencode']);
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('error', () => resolve(null));
      child.on('close', (code) =>
        resolve(code === 0 && out.trim() ? out.trim().split('\n')[0] : null),
      );
    });
  }

  async restart(): Promise<ServerStartResult> {
    this.dispose();
    return this.start();
  }

  dispose(): void {
    if (this.proc && !this.proc.killed) {
      log('stopping opencode server');
      this.killed.add(this.proc); // mark intentional so exit doesn't trigger reconnect
      this.proc.kill();
    }
    this.proc = undefined;
    this.baseUrl = undefined;
    this.client = undefined;
  }
}
