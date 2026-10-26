import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionConfig, getConfig } from '../config';
import { opencodeContextLimit } from '../core/context';
import { variantsForModel } from '../core/effort';
import { augmentedPath, toEngineMcp, withLocalEnvironment } from '../core/mcp';
import { opencodePermission } from '../core/permission';
import { toEngineProviderID } from '../core/providerIds';
import { LMStudioClient } from '../lmstudio/client';
import { log, logError } from '../logger';
import { discoverMcpServers } from '../mcp/discovery';
import { createHost, type SdkHost } from './embedded';
import { BUILD_PROMPT, PLAN_PROMPT } from './prompts';
import { OpencodeV2Client } from './v2client';

/** The provider id the panel (and its history, settings and agents) uses for LM Studio. */
export const LMSTUDIO_PROVIDER_ID = 'lmstudio';

export interface ServerStartResult {
  /** Where the engine runs, for logs only: there is no network address. */
  baseUrl: string;
  client: OpencodeV2Client;
}

export interface Disposable {
  dispose(): void;
}

/** Shown in logs where a server URL used to be. */
const EMBEDDED_URL = 'embedded://opencode';

/**
 * Owns the embedded OpenCode engine (OpenCode 2, running in-process through
 * @opencode/sdk), configured to talk to the local LM Studio server. Config is
 * handed to the engine in memory, so nothing is written to the user's
 * workspace or global config.
 *
 * Still named a "server" manager: the bridge's lifecycle (start, stale-config
 * restart, dispose) is unchanged, only what it starts is.
 */
export class OpencodeServerManager {
  private host: SdkHost | undefined;
  private client: OpencodeV2Client | undefined;
  private starting: Promise<ServerStartResult> | undefined;
  /**
   * The previous engine's shutdown. A new host must not open the same database
   * and folders while the old one is still closing (two engines in one
   * process over one SQLite file), so a start waits for this first.
   */
  private closing: Promise<void> = Promise.resolve();
  /**
   * The (LM Studio baseUrl, apiKey) pair the running engine's config was built
   * from. The config is baked into the host at creation, so if either changes
   * afterwards (server switch, key edit) the running instance is stale and
   * start() must recreate it instead of reusing it.
   */
  private bakedIdentity: string | undefined;
  private readonly exitListeners = new Set<() => void>();

  constructor(
    private readonly cfg: ExtensionConfig,
    private readonly lmStudio: LMStudioClient,
    /** Extension install dir — holds the bundled engine in `opencode-sdk/`. */
    private readonly extensionPath: string,
    /** Private data dir for the engine, isolated from the user's own OpenCode. */
    private readonly dataDir: string,
  ) {}

  get isRunning(): boolean {
    return !!this.client;
  }

  /**
   * Whether `client` is the running engine's client. After a restart a new
   * engine is running (isRunning is true again) but a panel can still hold
   * the old, stopped client.
   */
  isCurrent(client: OpencodeV2Client | undefined): boolean {
    return !!client && client === this.client;
  }

  /**
   * Register a callback fired whenever the engine stops unexpectedly.
   * Multiple bridges (sidebar + secondary + editor tabs) share one manager, so
   * each registers its own listener and disposes it on teardown.
   */
  addExitListener(cb: () => void): Disposable {
    this.exitListeners.add(cb);
    return { dispose: () => this.exitListeners.delete(cb) };
  }

  private currentIdentity(): string {
    // permissionMode is part of the identity for the same reason as url/key:
    // it's baked into the config at creation, so a running instance with a
    // different mode is stale and must be recreated on the next start().
    return JSON.stringify([
      this.lmStudio.getBaseUrl(),
      this.lmStudio.getApiKey() ?? null,
      getConfig().permissionMode,
    ]);
  }

  /** Start (or return the in-flight start of) the engine. Idempotent. */
  async start(): Promise<ServerStartResult> {
    if (this.client) {
      if (this.bakedIdentity === this.currentIdentity()) {
        return { baseUrl: EMBEDDED_URL, client: this.client };
      }
      // The LM Studio url/key changed since this instance was configured
      // (e.g. a key edit, or a start that raced ahead of key hydration) —
      // reusing it would send chat requests with stale credentials.
      log('opencode config is stale (LM Studio url/key changed) — recreating the engine');
      this.dispose();
    }
    if (this.starting) {
      return this.starting;
    }
    const starting: Promise<ServerStartResult> = this.doStart().finally(() => {
      // Only clear our own start: a dispose() + start() may have replaced it.
      if (this.starting === starting) {
        this.starting = undefined;
      }
    });
    this.starting = starting;
    return starting;
  }

  private async doStart(): Promise<ServerStartResult> {
    await this.closing;
    const starting = this.starting;
    const bakedIdentity = this.currentIdentity();
    const configContent = await this.buildConfigContent();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const version = this.engineVersion();
    log(`starting embedded opencode ${version} (cwd=${cwd})`);
    const host = await createHost(this.extensionPath, { root: this.dataDir }, configContent);
    if (this.starting !== starting) {
      // dispose() ran while the engine was being created: this start is stale
      // and its host must not outlive it.
      await host.close().catch((err: unknown) => logError('closing a superseded engine', err));
      throw new Error('OpenCode engine stopped');
    }
    this.host = host;
    this.client = new OpencodeV2Client(host, cwd, version);
    this.bakedIdentity = bakedIdentity;
    log('embedded opencode ready');
    return { baseUrl: EMBEDDED_URL, client: this.client };
  }

  /** The bundled engine's version, from the stamp the build writes. */
  private engineVersion(): string {
    try {
      return fs.readFileSync(path.join(this.extensionPath, 'opencode-sdk', 'version'), 'utf8').split('\n')[0].trim();
    } catch {
      return 'unknown';
    }
  }

  /** Build the engine config declaring the LM Studio provider. */
  private async buildConfigContent(): Promise<string> {
    const models: Record<string, Record<string, unknown>> = {};
    const ctx = getConfig().minContextLength; // read fresh so context-size changes apply on restart
    try {
      const list = await this.lmStudio.listModels();
      for (const m of list) {
        // OpenCode drops image attachments unless the model is declared with
        // attachment + image modality. The context limit follows the window LM
        // Studio actually loaded the model with, so OpenCode compacts against
        // the real window rather than one we merely asked for.
        const perModel = opencodeContextLimit(m, ctx);
        models[m.id] = {
          name: m.displayName,
          attachment: !!m.vision,
          reasoning: true,
          tool_call: m.toolUse ?? true,
          modalities: {
            input: m.vision ? ['text', 'image'] : ['text'],
            output: ['text'],
          },
          // Output budget: generous enough for reasoning models that emit long
          // <think> blocks before answering (8192 truncated them mid-thought),
          // but still a fraction of the window so input isn't crowded out.
          limit: { context: perModel, output: Math.min(32768, Math.floor(perModel / 4)) },
          // Reasoning-effort levels, selectable per message via PromptBody.variant.
          // Declared unconditionally for every model — identical for all of them —
          // so this config never depends on a user setting and changing effort
          // never needs a server restart. Naming a variant the model doesn't
          // support is a verified silent no-op, so over-declaring is free.
          variants: variantsForModel(),
        };
      }
    } catch (err) {
      logError('could not enumerate LM Studio models for config', err);
    }
    // MCP servers discovered from .mcp.json / .vscode/mcp.json / VS Code user
    // settings / our own `lmstudioCode.mcpServers`. Tokens like ${VAR} are
    // already resolved to literals (the injected config is not substituted by
    // OpenCode), so what we inject is ready to spawn as-is. Their tools flow
    // through OpenCode's existing tool-call + permission machinery for free.
    let mcp: ReturnType<typeof discoverMcpServers>['map'] = {};
    try {
      // stdio servers inherit the extension host's environment. When VS Code
      // was launched from a GUI context its PATH can be minimal (the #1 reason
      // npx/uvx-based servers fail to start), so add the usual install
      // locations; existing entries stay first so the user's toolchain wins.
      mcp = withLocalEnvironment(discoverMcpServers().map, {
        PATH: augmentedPath(process.env.PATH, os.homedir(), path.delimiter),
      });
    } catch (err) {
      logError('could not discover MCP servers', err);
    }

    // OpenCode 2's built-in LM Studio plugin owns the `lmstudio` provider id:
    // once it discovers models it replaces everything declared under that id
    // (our context limits, vision flags and reasoning variants). So the
    // provider is declared under its engine id, and mapped back wherever it
    // crosses the boundary (see core/providerIds).
    const providerID = toEngineProviderID(LMSTUDIO_PROVIDER_ID);
    const config = {
      $schema: 'https://opencode.ai/config.json',
      // Only our LM Studio provider. OpenCode would otherwise also enable any
      // provider it can find a key for in the environment (an exported
      // OPENAI_API_KEY) and auto-discover local servers — and its internal
      // title/summary agents could then bill a key the user never gave this
      // extension.
      enabled_providers: [providerID],
      // Tool-approval posture (default / strict / bypass), read fresh so a
      // mode change applies on restart. Every mode keeps the built-in
      // `question` tool at "allow": the picker is the interaction (the bridge
      // relays `question.asked` and replies through the form API), so an
      // approval gate in front of it would be redundant.
      permission: opencodePermission(getConfig().permissionMode),
      // Override the build/plan agent prompts so the model identifies as
      // "LM Studio Code" instead of OpenCode's built-in "You are opencode…".
      agent: {
        build: { prompt: BUILD_PROMPT },
        plan: { prompt: PLAN_PROMPT },
      },
      // OpenCode 2 ships its todo tool behind a flag; the panel's live todo
      // list renders from it.
      experimental: { todo: true },
      provider: {
        [providerID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LM Studio (local)',
          options: {
            baseURL: this.lmStudio.getBaseUrl(),
            includeUsage: true,
            // Same Bearer key discovery uses — for servers behind an auth proxy.
            ...this.apiKeyOption(),
          },
          ...(Object.keys(models).length ? { models } : {}),
        },
      },
      // Native shape, with Code Mode off (see toEngineMcp).
      ...(Object.keys(mcp).length ? { mcp: toEngineMcp(mcp) } : {}),
    };
    return JSON.stringify(config);
  }

  /**
   * Provider `apiKey` option for the injected config. The key is written to a
   * 0600 file in our private dataDir and referenced via OpenCode's
   * `{file:...}` placeholder, substituted when the engine loads the config, so
   * the config text itself never carries a secret. Falls back to the literal
   * only if the file can't be written.
   */
  private apiKeyOption(): Record<string, string> {
    const apiKey = this.lmStudio.getApiKey();
    const keyFile = path.join(this.dataDir, 'lmstudio-api-key');
    if (!apiKey) {
      fs.rmSync(keyFile, { force: true });
      return {};
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(keyFile, apiKey, { mode: 0o600 });
      fs.chmodSync(keyFile, 0o600); // writeFileSync mode only applies on create
      return { apiKey: `{file:${keyFile}}` };
    } catch (err) {
      logError('could not write api key file; passing key inline', err);
      return { apiKey };
    }
  }

  async restart(): Promise<ServerStartResult> {
    this.dispose();
    return this.start();
  }

  dispose(): void {
    if (this.client) {
      log('stopping embedded opencode');
    }
    this.client?.dispose();
    const host = this.host;
    this.host = undefined;
    this.client = undefined;
    this.bakedIdentity = undefined;
    // Drop any in-flight start so a dispose mid-startup (e.g. restart()) can't
    // have its stale promise returned by the next start() — forces a fresh one.
    this.starting = undefined;
    // Closing releases the engine's watchers, MCP children and database. The
    // next start waits for it (see `closing`).
    if (host) {
      const previous = this.closing;
      this.closing = previous
        .then(() => host.close())
        .catch((err: unknown) => logError('closing embedded opencode', err));
    }
  }
}
