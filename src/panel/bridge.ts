import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ServerRegistry } from '../connection';
import { clampContext } from '../core/context';
import { humanizeError, isConnectionError } from '../core/errors';
import { pickModel } from '../core/models';
import { ConnectResult, SelfHealer } from '../core/reconnect';
import { deriveTitle } from '../core/title';
import { LMStudioClient } from '../lmstudio/client';
import { log, logError } from '../logger';
import { discoverMcpServers } from '../mcp/discovery';
import { OpencodeClient } from '../opencode/client';
import { OpencodeEvent, PromptBody } from '../opencode/protocol';
import { Disposable, OpencodeServerManager } from '../opencode/serverManager';
import { HostToWebview, UiImage, UiMcpServer, UiModel, UiSession, WebviewToHost } from '../shared';

/** How often the health poll runs (ms). */
const HEALTH_INTERVAL_MS = 5000;
/** Refresh the model list every N health ticks while connected. */
const REFRESH_EVERY_TICKS = 3;

export interface BridgeDeps {
  context: vscode.ExtensionContext;
  server: OpencodeServerManager;
  lmStudio: LMStudioClient;
  servers: ServerRegistry;
}

/**
 * Connects one webview (sidebar view or editor tab) to the OpenCode server.
 * Owns the conversation state for that webview and relays the SSE event stream.
 */
export class ChatBridge {
  private client: OpencodeClient | undefined;
  private currentSessionID: string | null = null;
  private currentModel: string | null = null;
  private agent: 'build' | 'plan';
  private eventAbort: AbortController | undefined;
  private disposed = false;
  private connected = false;
  private connecting = false;
  private currentTitle = '';
  private agentsWarned = false;
  private activeFile: { abs: string; rel: string; chars: number } | null = null;
  private editorSub: vscode.Disposable | undefined;
  private messageSub: vscode.Disposable | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private titleSink: ((t: string) => void) | undefined;
  private lastModels: UiModel[] = [];
  private serverExitSub: Disposable | undefined;
  /** Pure self-heal policy (reconnect timing, backoff, reload-after-reconnect). */
  private readonly healer: SelfHealer = new SelfHealer(
    {
      upstreamReachable: () => this.deps.lmStudio.checkConnection(),
      serverHealthy: () => this.deps.server.isRunning && !!this.client,
      isConnected: () => this.connected,
      goOffline: () => this.markOffline(),
      connect: () => this.init(),
      reloadModels: () => this.refreshModelsToWebview(),
    },
    { refreshEvery: REFRESH_EVERY_TICKS, backoff: { base: 2000, max: 30000 } },
  );

  constructor(
    private readonly webview: vscode.Webview,
    private readonly deps: BridgeDeps,
  ) {
    this.agent = getConfig().agent;
    // Keep the subscription so dispose() can detach it — a re-resolved view
    // would otherwise leave a second handler alive, fanning one send out to
    // multiple prompt requests (duplicate replies).
    this.messageSub = webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m));
    this.editorSub = vscode.window.onDidChangeActiveTextEditor((e) => this.updateActiveFile(e));
    // Self-heal when the shared OpenCode server dies unexpectedly.
    this.serverExitSub = this.deps.server.addExitListener(() => this.onServerExit());
  }

  dispose(): void {
    this.disposed = true;
    this.messageSub?.dispose();
    this.eventAbort?.abort();
    this.editorSub?.dispose();
    this.serverExitSub?.dispose();
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  /**
   * Poll so the panel self-heals. The policy (when to reconnect, how to back
   * off, when to reload models) lives in the pure, unit-tested `SelfHealer`;
   * this shell just drives it on a timer.
   */
  private startHealthPoll(): void {
    if (this.healthTimer || this.disposed) {
      return;
    }
    this.healthTimer = setInterval(() => void this.runHealthTick(), HEALTH_INTERVAL_MS);
  }

  private async runHealthTick(): Promise<void> {
    if (this.disposed || this.connecting) {
      return;
    }
    await this.healer.tick();
  }

  /** LM Studio went away — keep the live OpenCode server, just show the banner. */
  private markOffline(): void {
    this.connected = false;
    this.postServers(false);
    this.post({
      type: 'status',
      text: 'Lost connection to LM Studio — reconnecting…',
      kind: 'warn',
    });
  }

  /** The shared OpenCode server crashed: drop our stale client + stream, reconnect. */
  private onServerExit(): void {
    if (this.disposed) {
      return;
    }
    log('opencode server exited unexpectedly — reconnecting');
    this.teardownConnection(false); // server is already gone
    this.healer.allowImmediate(); // permit an immediate reconnect
    this.post({ type: 'status', text: 'Reconnecting…', kind: 'warn' });
    void this.healer.reconnect(); // reconnects + reloads models on success
  }

  /**
   * Abort the event stream and drop the client so a fresh connect re-subscribes
   * cleanly. Only dispose the *shared* server when asked (and when it is ours to
   * dispose) — other panels may still be using it.
   */
  private teardownConnection(disposeServer: boolean): void {
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    this.client = undefined;
    if (disposeServer) {
      this.deps.server.dispose();
    }
  }

  /** True when LM Studio is reachable and we have a live OpenCode client. */
  private isLive(): boolean {
    return this.connected && !!this.client && this.deps.server.isRunning;
  }

  /**
   * Re-establish the connection after a transient failure. If the OpenCode
   * process is gone we fully re-init (which respawns it); otherwise we just
   * re-verify LM Studio and reuse the running server. The healer reloads models
   * on success. Returns whether we are live afterwards.
   */
  private async reconnect(): Promise<boolean> {
    if (!this.deps.server.isRunning) {
      this.teardownConnection(false);
    }
    return this.healer.reconnect();
  }

  private updateActiveFile(editor: vscode.TextEditor | undefined): void {
    // Keep the last real file when focus moves to the webview/panel.
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const abs = editor.document.uri.fsPath;
    this.activeFile = {
      abs,
      rel: vscode.workspace.asRelativePath(abs),
      chars: editor.document.getText().length,
    };
    this.post({ type: 'activeFile', path: this.activeFile.rel, chars: this.activeFile.chars });
  }

  /** Start a fresh conversation (invoked by the New Chat command). */
  async requestNewChat(): Promise<void> {
    if (this.client) {
      await this.newSession();
    }
  }

  /** Ask the webview to run a UI command (e.g. open history overlay). */
  sendCommand(command: 'history' | 'newChat' | 'focusInput'): void {
    this.post({ type: 'command', command });
  }

  /** Provide a callback that sets the host view/tab title (the session name). */
  setTitleSink(fn: (t: string) => void): void {
    this.titleSink = fn;
  }

  private updateTitle(title: string): void {
    this.currentTitle = title || 'New chat';
    this.titleSink?.(this.currentTitle);
  }

  private post(msg: HostToWebview): void {
    if (!this.disposed) {
      void this.webview.postMessage(msg);
    }
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    if (this.disposed) {
      return; // a superseded bridge must not handle messages
    }
    try {
      switch (msg.type) {
        case 'ready':
          await this.init();
          break;
        case 'send':
          await this.handleSend(msg.text, msg.thinking, msg.images ?? [], msg.includeActiveFile ?? false);
          break;
        case 'selectModel':
          this.currentModel = msg.modelID;
          await this.deps.context.workspaceState.update('lmstudioCode.model', msg.modelID);
          break;
        case 'loadModel':
          await this.handleLoadModel(msg.modelID);
          break;
        case 'unloadModel':
          await this.handleUnloadModel(msg.modelID);
          break;
        case 'setContextSize':
          await this.setContextSize(msg.tokens);
          break;
        case 'refreshModels':
          await this.refreshModelsToWebview();
          break;
        case 'listServers':
          this.postServers(this.connected);
          break;
        case 'addServer':
          await this.deps.servers.add(msg.name, msg.url);
          this.postServers(this.connected);
          break;
        case 'updateServer':
          await this.deps.servers.update(msg.id, msg.name, msg.url);
          if (this.deps.servers.active().id === msg.id) {
            await this.switchServer(msg.id);
          } else {
            this.postServers(this.connected);
          }
          break;
        case 'removeServer': {
          const wasActive = this.deps.servers.active().id === msg.id;
          await this.deps.servers.remove(msg.id);
          if (wasActive) {
            await this.switchServer(this.deps.servers.active().id);
          } else {
            this.postServers(this.connected);
          }
          break;
        }
        case 'switchServer':
          await this.switchServer(msg.id);
          break;
        case 'selectAgent':
          this.agent = msg.agent;
          break;
        case 'newChat':
          await this.newSession();
          break;
        case 'loadSessions':
          await this.sendSessions();
          break;
        case 'loadSession':
          await this.loadSession(msg.sessionID);
          break;
        case 'deleteSession': {
          const wasCurrent = msg.sessionID === this.currentSessionID;
          await this.client?.deleteSession(msg.sessionID);
          if (wasCurrent) {
            this.currentSessionID = null;
            await this.newSession(false);
          }
          await this.sendSessions();
          break;
        }
        case 'clearAllSessions':
          await this.clearAllSessions();
          break;
        case 'compact':
          await this.compactSession();
          break;
        case 'abort':
          if (this.currentSessionID) {
            await this.client?.abort(this.currentSessionID);
          }
          break;
        case 'permission':
          await this.client?.respondPermission(msg.sessionID, msg.permissionID, msg.response);
          break;
        case 'questionReply':
          await this.client?.replyQuestion(msg.requestID, msg.answers);
          break;
        case 'questionReject':
          await this.client?.rejectQuestion(msg.requestID);
          break;
        case 'openFile':
          await this.openFile(msg.path);
          break;
        case 'requestMcpStatus':
          await this.sendMcpStatus();
          break;
        case 'retryConnect':
          await this.init();
          break;
      }
    } catch (err) {
      logError(`handling ${msg.type}`, err);
      this.post({ type: 'error', message: humanizeError(err, { subject: 'LM Studio' }) });
      this.post({ type: 'busy', busy: false });
    }
  }

  private async init(): Promise<ConnectResult> {
    this.startHealthPoll();
    if (this.connecting) {
      return this.isLive() ? 'connected' : 'upstream-down';
    }
    this.connecting = true;
    try {
      return await this.doInit();
    } finally {
      this.connecting = false;
    }
  }

  private async doInit(): Promise<ConnectResult> {
    const cfg = getConfig();
    const active = this.deps.servers.active();
    this.deps.lmStudio.setBaseUrl(active.url);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    this.post({ type: 'status', text: `Connecting to ${active.name}…` });
    this.connected = await this.deps.lmStudio.checkConnection();
    this.postServers(this.connected);

    // Offline: show the connection screen and wait for retry / switch. The
    // healer applies no backoff for this — the poll recovers the moment LM
    // Studio is reachable again.
    if (!this.connected) {
      this.post({
        type: 'init',
        models: [],
        currentModel: null,
        agent: this.agent,
        cwd,
        serverReady: false,
        lmStudioConnected: false,
        minContext: cfg.minContextLength,
      });
      this.post({ type: 'status', text: `Can't reach LM Studio at ${active.url}`, kind: 'warn' });
      return 'upstream-down';
    }

    this.post({ type: 'status', text: 'Starting OpenCode server…' });
    let started;
    try {
      started = await this.deps.server.start();
    } catch (err) {
      // Upstream is fine but OpenCode failed to come up — report 'failed' so the
      // healer backs off instead of respawning a broken server every tick.
      logError('opencode server failed to start', err);
      this.post({ type: 'error', message: humanizeError(err, { subject: 'OpenCode' }) });
      this.post({
        type: 'init',
        models: [],
        currentModel: null,
        agent: this.agent,
        cwd,
        serverReady: false,
        lmStudioConnected: true,
        minContext: cfg.minContextLength,
      });
      return 'failed';
    }
    this.client = started.client;

    const models = await this.loadModels();
    const stored = this.deps.context.workspaceState.get<string>('lmstudioCode.model');
    this.currentModel =
      pickModel([cfg.defaultModel, stored ?? '', this.currentModel ?? ''], models) ?? null;

    this.startEventStream();

    this.post({
      type: 'init',
      models,
      currentModel: this.currentModel,
      agent: this.agent,
      cwd,
      serverReady: true,
      lmStudioConnected: true,
      minContext: cfg.minContextLength,
    });

    await this.sendSessions();
    if (!this.currentSessionID) {
      await this.newSession(false);
    }
    this.updateActiveFile(vscode.window.activeTextEditor);
    this.warnIfAgentsLarge();
    // Clean connect — clear any reconnect backoff held by the healer.
    this.healer.noteConnected();
    this.post({ type: 'status', text: '' });
    return 'connected';
  }

  /** Warn once if AGENTS.md/CLAUDE.md (auto-loaded by OpenCode) is large. */
  private warnIfAgentsLarge(): void {
    if (this.agentsWarned) {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    let bytes = 0;
    const found: string[] = [];
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const st = fs.statSync(path.join(root, name));
        if (st.isFile()) {
          bytes += st.size;
          found.push(name);
        }
      } catch {
        // not present
      }
    }
    if (!found.length) {
      return;
    }
    const estTokens = Math.round(bytes / 4);
    const win = getConfig().minContextLength;
    if (estTokens >= win * 0.4) {
      this.agentsWarned = true;
      const pct = Math.round((estTokens / win) * 100);
      const over = estTokens >= win;
      vscode.window.showWarningMessage(
        `LM Studio Code: ${found.join(' + ')} is ~${Math.round(estTokens / 1000)}k tokens (~${pct}% of your ${Math.round(win / 1000)}k context)${over ? ' — larger than the context window' : ''}. It's auto-included on every request and may crowd out the conversation. Consider trimming it or raising lmstudioCode.minContextLength.`,
      );
    }
  }

  /**
   * Gather MCP server status for the `/mcp` panel: the live connection state
   * from the server (GET /mcp) cross-referenced with the discovered config so
   * each row also shows its transport + command/url — even a failed or disabled
   * server the live map might report tersely. Posts an `mcpStatus` message;
   * `servers: []` means none are configured.
   */
  private async sendMcpStatus(): Promise<void> {
    // Configured servers (for transport + detail), keyed by name.
    let configured: ReturnType<typeof discoverMcpServers>['map'] = {};
    try {
      configured = discoverMcpServers().map;
    } catch (err) {
      logError('mcp discovery for /mcp panel', err);
    }

    // Live status from the running server, if reachable. Failure to fetch
    // (server down) just means we show the configured set without live state.
    let live: Record<string, { status?: string; error?: string }> = {};
    if (this.client) {
      try {
        live = (await this.client.listMcp()) as typeof live;
      } catch (err) {
        logError('GET /mcp failed', err);
      }
    }

    // Union the two key sets so a configured-but-not-yet-reported server still
    // shows, and a live server we somehow didn't configure isn't hidden.
    const names = new Set<string>([...Object.keys(configured), ...Object.keys(live)]);
    const servers: UiMcpServer[] = [...names].sort().map((name) => {
      const cfg = configured[name];
      const transport: 'local' | 'remote' | undefined = cfg
        ? cfg.type === 'remote'
          ? 'remote'
          : 'local'
        : undefined;
      let detail: string | undefined;
      if (cfg?.type === 'remote') {
        detail = cfg.url;
      } else if (cfg?.type === 'local') {
        detail = cfg.command.join(' ');
      }
      // A configured-but-disabled server may not appear in the live map; reflect
      // its config state so the panel still shows it as disabled.
      const status = live[name]?.status ?? (cfg?.enabled === false ? 'disabled' : 'pending');
      return { name, status, error: live[name]?.error, transport, detail };
    });

    this.post({ type: 'mcpStatus', servers });
  }

  private postServers(connected: boolean): void {
    this.connected = connected;
    this.post({
      type: 'servers',
      servers: this.deps.servers.list().map((s) => ({ id: s.id, name: s.name, url: s.url })),
      activeId: this.deps.servers.active().id,
      connected,
    });
  }

  /** Switch the active LM Studio server: tear down OpenCode and re-initialize. */
  private async switchServer(id: string): Promise<void> {
    await this.deps.servers.setActive(id);
    this.currentSessionID = null;
    this.healer.allowImmediate(); // a deliberate switch shouldn't wait on backoff
    this.teardownConnection(true);
    this.post({ type: 'cleared' });
    await this.init();
  }

  private async refreshModelsToWebview(): Promise<void> {
    const models = await this.loadModels();
    this.post({ type: 'models', models, currentModel: this.currentModel });
  }

  private async handleLoadModel(modelID: string): Promise<void> {
    const cfg = getConfig();
    this.post({ type: 'status', text: `Loading ${modelID}…` });
    const result = await this.deps.lmStudio.ensureContext(
      modelID,
      cfg.minContextLength,
      cfg.gpuOffload,
      (m) => this.post({ type: 'status', text: m }),
    );
    if (result.note) {
      this.post({ type: 'status', text: result.note, kind: 'warn' });
      setTimeout(() => this.post({ type: 'status', text: '' }), 4000);
    } else {
      this.post({ type: 'status', text: '' });
    }
    await this.refreshModelsToWebview();
  }

  /** Persist a new context window and restart OpenCode so it takes effect. */
  private async setContextSize(tokens: number): Promise<void> {
    // Never persist more context than the selected model actually supports.
    const model = this.lastModels.find((m) => m.id === this.currentModel);
    const clamped = clampContext(tokens, model?.maxContextLength);
    try {
      await vscode.workspace
        .getConfiguration('lmstudioCode')
        .update('minContextLength', clamped, vscode.ConfigurationTarget.Global);
    } catch (err) {
      logError('update minContextLength', err);
    }
    this.post({
      type: 'status',
      text: `Setting context to ${Math.round(clamped / 1024)}K — restarting…`,
    });
    // Restart the OpenCode server so num_ctx / limit.context rebuild; keep the
    // current session (sessions persist on disk).
    this.teardownConnection(true);
    await this.init();
    this.post({ type: 'status', text: '' });
  }

  private async handleUnloadModel(modelID: string): Promise<void> {
    this.post({ type: 'status', text: `Unloading ${modelID}…` });
    try {
      await this.deps.lmStudio.unloadModel(modelID);
    } catch (err) {
      logError(`unload ${modelID}`, err);
    }
    this.post({ type: 'status', text: '' });
    await this.refreshModelsToWebview();
  }

  private async loadModels(): Promise<UiModel[]> {
    const list = await this.deps.lmStudio.listModels();
    this.lastModels = list.map((m) => ({
      id: m.id,
      name: m.displayName,
      loaded: m.state === 'loaded',
      contextLength: m.loadedContextLength,
      maxContextLength: m.maxContextLength,
      toolUse: m.toolUse,
      vision: m.vision,
      publisher: m.publisher,
      quantization: m.quantization,
      format: m.format,
    }));
    return this.lastModels;
  }

  private async newSession(announce = true): Promise<void> {
    const session = await this.client!.createSession('New chat');
    this.currentSessionID = session.id;
    this.updateTitle('New chat');
    this.post({ type: 'cleared' });
    if (announce) {
      await this.sendSessions();
    }
  }

  private async sendSessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    const sessions = await this.client.listSessions();
    const ui: UiSession[] = sessions.map((s) => ({
      id: s.id,
      title: s.title || 'Untitled',
      updated: s.time?.updated ?? 0,
    }));
    const current = ui.find((s) => s.id === this.currentSessionID);
    if (current) {
      this.updateTitle(current.title);
    }
    this.post({ type: 'sessions', sessions: ui, currentSessionID: this.currentSessionID });
  }

  private async clearAllSessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.post({ type: 'status', text: 'Clearing sessions…' });
    const sessions = await this.client.listSessions();
    for (const s of sessions) {
      await this.client.deleteSession(s.id).catch(() => undefined);
    }
    this.currentSessionID = null;
    await this.newSession(false);
    this.post({ type: 'cleared' });
    this.post({ type: 'status', text: '' });
    await this.sendSessions();
  }

  /**
   * Compact the current conversation via OpenCode's summarize endpoint — the
   * `/compact` slash command. Blocks input for the duration (`compacting`),
   * then hands the webview the summary text OpenCode produced so it can be shown
   * in the compaction chip. The reduced token count only lands on the next real
   * turn (the summarizer turn reports no usable usage), so we don't fake it here.
   */
  private async compactSession(): Promise<void> {
    if (!this.client || !this.currentSessionID) {
      this.post({ type: 'status', text: 'Nothing to compact yet.', kind: 'warn' });
      return;
    }
    if (!this.currentModel) {
      this.post({ type: 'status', text: 'Select a model before compacting.', kind: 'warn' });
      return;
    }
    this.post({ type: 'compacting', active: true });
    this.post({ type: 'status', text: 'Compacting conversation…' });
    let summary = '';
    try {
      await this.client.summarize(this.currentSessionID, 'lmstudio', this.currentModel);
      summary = await this.latestSummary(this.currentSessionID);
    } finally {
      // Always release the input, even if summarize threw (onMessage's catch
      // surfaces the error). A stuck "compacting" lock would be worse.
      this.post({ type: 'compacting', active: false, summary });
      this.post({ type: 'status', text: '' });
    }
  }

  /**
   * The summary text from the most recent compaction: the assistant turn that
   * immediately follows a `compaction`-part message. Empty string if none found.
   */
  private async latestSummary(sessionID: string): Promise<string> {
    try {
      const messages = await this.client!.getMessages(sessionID);
      let pending = false;
      let summary = '';
      for (const m of messages) {
        const isMarker = (m.parts ?? []).some((part) => part.type === 'compaction');
        if (isMarker) {
          pending = true;
          continue;
        }
        if (pending && m.info.role === 'assistant') {
          summary = (m.parts ?? [])
            .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
            .map((part) => (part as { text?: string }).text ?? '')
            .join('')
            .trim();
          pending = false;
        }
      }
      return summary;
    } catch {
      return '';
    }
  }

  private async loadSession(sessionID: string): Promise<void> {
    if (!this.client) {
      return;
    }
    this.currentSessionID = sessionID;
    const messages = await this.client.getMessages(sessionID);
    const sessions = await this.client.listSessions();
    const title = sessions.find((s) => s.id === sessionID)?.title ?? 'Chat';
    this.updateTitle(title);
    this.post({ type: 'sessionLoaded', sessionID, title, messages });
  }

  private async handleSend(
    text: string,
    thinking: boolean,
    images: UiImage[],
    includeActiveFile: boolean,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    if (!this.currentModel) {
      throw new Error('No LM Studio model selected.');
    }
    if (!this.currentSessionID) {
      await this.newSession(false);
    }
    const cfg = getConfig();

    if (cfg.autoEnsureContext) {
      const result = await this.deps.lmStudio.ensureContext(
        this.currentModel,
        cfg.minContextLength,
        cfg.gpuOffload,
        (m) => this.post({ type: 'status', text: m }),
      );
      if (result.note) {
        log(`ensureContext: ${result.note}`);
      }
      if (result.reloaded) {
        const models = await this.loadModels();
        this.post({ type: 'models', models, currentModel: this.currentModel });
      }
      this.post({ type: 'status', text: '' });
    }

    // Identity: OpenCode's base prompt makes the model call itself "opencode".
    // Our system text is appended, so this overrides the user-facing identity.
    let system =
      'You are "LM Studio Code", an agentic coding assistant running on the user\'s machine against their local LM Studio models. If asked your name or what you are, identify as "LM Studio Code". Never identify yourself as "opencode".';

    // Thinking control. Qwen-family models honor the `/no_think` soft switch
    // (consumed by the chat template); for others fall back to a system hint.
    let promptText = text;
    if (!thinking) {
      if (/qwen/i.test(this.currentModel)) {
        promptText = `${text}\n\n/no_think`;
      } else {
        system += '\n\nAnswer directly and concisely. Do not produce private chain-of-thought or <think> reasoning blocks.';
      }
    }

    const parts: PromptBody['parts'] = [{ type: 'text', text: promptText }];
    for (const img of images) {
      parts.push({ type: 'file', mime: img.mime, url: img.dataUrl, filename: img.name });
    }
    // Attach the currently open file as context (excludable from the UI).
    if (includeActiveFile && this.activeFile) {
      try {
        const MAX = 80 * 1024;
        let content = fs.readFileSync(this.activeFile.abs, 'utf8');
        if (content.length > MAX) {
          content = content.slice(0, MAX) + '\n\n…[truncated]';
        }
        parts.push({
          type: 'file',
          mime: 'text/plain',
          filename: this.activeFile.rel,
          url: `file://${this.activeFile.abs}`,
          source: { type: 'file', path: this.activeFile.abs, text: { value: content, start: 0, end: content.length } },
        });
      } catch (err) {
        logError('attach active file failed', err);
      }
    }

    this.post({ type: 'busy', busy: true });
    await this.sendPrompt({
      model: { providerID: 'lmstudio', modelID: this.currentModel },
      agent: this.agent,
      ...(system ? { system } : {}),
      parts,
    });

    // Auto-name the session from the first user prompt.
    if ((this.currentTitle === 'New chat' || this.currentTitle === '') && text.trim()) {
      const title = deriveTitle(text);
      if (title) {
        try {
          await this.client.updateSession(this.currentSessionID!, { title });
        } catch (err) {
          logError('auto-title failed', err);
        }
        this.updateTitle(title);
        await this.sendSessions();
      }
    }
  }

  /**
   * Send a prompt with one transparent self-heal: if the request fails because
   * the OpenCode server is unreachable, reconnect (respawning it if it died)
   * and retry once before surfacing a friendly error.
   */
  private async sendPrompt(body: PromptBody): Promise<void> {
    try {
      await this.client!.promptAsync(this.currentSessionID!, body);
    } catch (err) {
      if (!isConnectionError(err)) {
        throw err;
      }
      logError('prompt failed on a connection error — reconnecting and retrying', err);
      this.post({ type: 'status', text: 'Reconnecting…', kind: 'warn' });
      const live = await this.reconnect();
      if (live && this.client && this.currentSessionID) {
        await this.client.promptAsync(this.currentSessionID, body);
        this.post({ type: 'status', text: '' });
        return;
      }
      throw new Error(
        'Lost connection to LM Studio. It looks offline — start it and try again; I’ll keep reconnecting in the background.',
      );
    }
  }

  private startEventStream(): void {
    if (this.eventAbort || !this.client) {
      return;
    }
    this.eventAbort = new AbortController();
    void this.client.subscribeEvents((event) => this.relayEvent(event), this.eventAbort.signal);
  }

  /** Forward only events that belong to the active session (plus globals). */
  private relayEvent(event: OpencodeEvent): void {
    const sid = sessionIdOf(event);
    // Drop a session-scoped event unless it's for the active session. Also drop
    // it when no session is active yet (sid set, currentSessionID null) so a
    // stray event mid-init can't leak into the webview.
    if (sid && sid !== this.currentSessionID) {
      return;
    }
    this.post({ type: 'event', event });
  }

  private async openFile(p: string): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      logError(`openFile ${abs}`, err);
    }
  }
}

function sessionIdOf(event: OpencodeEvent): string | undefined {
  const p = event.properties as any;
  return (
    p?.sessionID ??
    p?.info?.sessionID ??
    p?.part?.sessionID ??
    undefined
  );
}
