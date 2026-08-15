import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ServerRegistry } from '../connection';
import { commandTakesArgs } from '../core/commands';
import { type AgentInfo, delegatableAgents, pickableAgents, resolveAgent } from '../core/agents';
import {
  type EffortLevel,
  type ReasoningCapability,
  fallbackPromptText,
  resolveLevel,
  variantForLevel,
} from '../core/effort';
import {
  Goal,
  buildContinuePrompt,
  buildJudgePrompt,
  buildRevisionPrompt,
  decideNext,
  newGoal,
  parseJudgeVerdict,
  parseRevisionVerdict,
} from '../core/goal';
import { humanizeError, isConnectionError } from '../core/errors';
import { pickModel } from '../core/models';
import { type PermissionMode, normalizePermissionMode } from '../core/permission';
import { ConnectResult, SelfHealer } from '../core/reconnect';
import { selectionLabel } from '../core/selection';
import { resolveApiKeyEdit } from '../core/servers';
import { emptySessionCandidates } from '../core/sessions';
import { classifySkills } from '../core/skills';
import { deriveTitle } from '../core/title';
import { LMStudioClient } from '../lmstudio/client';
import { log, logError } from '../logger';
import { discoverMcpServers } from '../mcp/discovery';
import { OpencodeClient } from '../opencode/client';
import { OpencodeAgent, OpencodeEvent, PromptBody } from '../opencode/protocol';
import { Disposable, OpencodeServerManager } from '../opencode/serverManager';
import {
  HostToWebview,
  UiAgent,
  UiCommand,
  UiGoal,
  UiImage,
  UiMcpServer,
  UiModel,
  UiSession,
  UiSkill,
  WebviewToHost,
} from '../shared';

/**
 * Health poll cadence while disconnected (ms). Kept fast so a restarted
 * LM Studio is picked up promptly; the *connected* cadence is the configurable
 * `lmstudioCode.healthCheckSeconds` (default 30s) — issue #7: a healthy idle
 * panel shouldn't flood LM Studio's developer log with model queries.
 */
const OFFLINE_HEALTH_INTERVAL_MS = 5000;
/** Refresh the model list every N health ticks while connected. */
const REFRESH_EVERY_TICKS = 3;
/** Fast model-list refresh cadence while the model picker is open (ms). */
const PICKER_REFRESH_MS = 4000;
/**
 * Consecutive probe timeouts before we believe LM Studio is gone. A single
 * slow probe (server saturated mid-generation) must not pop the offline
 * banner; a refused connection still flips immediately.
 */
const OFFLINE_AFTER_TIMEOUTS = 3;
/** globalState flag: the one-time empty-session migration has already run. */
const PRUNED_EMPTIES_KEY = 'lmstudioCode.prunedEmptySessions';
/** workspaceState key: the last active session, restored on the next launch. */
const LAST_SESSION_KEY = 'lmstudioCode.lastSessionID';
/**
 * Window-scoped claim so only the FIRST bridge to initialize (in practice the
 * sidebar view on launch) restores the persisted session — every panel shares
 * the one workspaceState slot, and siblings must not all open the same
 * conversation.
 */
let sessionRestoreClaimed = false;

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
  private agent: string;
  /** Last agent roster from GET /agent, for the picker and overhead math. */
  private lastAgents: OpencodeAgent[] = [];
  private eventAbort: AbortController | undefined;
  /** The client the live event stream is bound to, so a respawned server (new
   * port) can be detected and re-subscribed. */
  private streamingClient: OpencodeClient | undefined;
  private disposed = false;
  private connected = false;
  private connecting = false;
  private currentTitle = '';
  private agentsWarned = false;
  /** In-flight createSession promise, so concurrent first-sends share one. */
  private ensuringSession: Promise<void> | undefined;
  /** Whether this bridge already ran its one launch-time session restore. */
  private restoreAttempted = false;
  /**
   * The active goal loop, or null. `paused` keeps the goal pinned without
   * auto-continuing (user pressed Stop / pause, or a safety cap tripped).
   * Session-scoped: cleared on new chat / session switch.
   */
  private activeGoal: (Goal & { startedAt: number; paused: boolean }) | null = null;
  /** True while a judge check is in flight (prevents concurrent checks). */
  private goalChecking = false;
  /** True while a goal-revision check is in flight (prevents concurrent checks). */
  private revisionChecking = false;
  /** Last time the loop advanced — drives the health-tick watchdog. */
  private lastGoalActivity = 0;
  private activeFile: { abs: string; rel: string; chars: number } | null = null;
  /**
   * The current editor selection, tracked live like the active file. `text` is
   * the exact selected text (from getText, so multi-byte safe); start/end are
   * character offsets (from offsetAt) into the document; lines are 1-based for
   * display. Null whenever there's no non-empty file selection — which also
   * covers Markdown-preview panes (they aren't text editors, so no selection).
   */
  private activeSelection:
    | { abs: string; rel: string; text: string; start: number; end: number; startLine: number; endLine: number }
    | null = null;
  private editorSub: vscode.Disposable | undefined;
  private selectionSub: vscode.Disposable | undefined;
  private messageSub: vscode.Disposable | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  /** Next wall-clock time (ms) the upstream probe is due; 0 = due now. */
  private nextProbeDueAt = 0;
  /** Fast refresh loop while the webview's model picker is open. */
  private pickerTimer: ReturnType<typeof setInterval> | undefined;
  /** Whether this webview is currently visible (hidden panels stay alive). */
  private visible = true;
  /** JSON of the last 'models' payload posted — suppresses no-op refreshes. */
  private lastPostedModelsJson = '';
  private titleSink: ((t: string) => void) | undefined;
  private lastModels: UiModel[] = [];
  private serverExitSub: Disposable | undefined;
  /** Pure self-heal policy (reconnect timing, backoff, reload-after-reconnect). */
  private readonly healer: SelfHealer = new SelfHealer(
    {
      // Share one probe across all panels' ticks (they use this same client):
      // a result younger than ~80% of the cadence IN EFFECT is fresh enough to
      // reuse — while disconnected that cadence is the fast 5s one, so a
      // restarted LM Studio really is noticed within ~5s. While disconnected
      // the probe is also auth-aware (the greeting answers 200 even to a
      // rejected key, which would otherwise spin doInit in a reconnect loop).
      probeUpstream: () => {
        const cadence = this.connected ? this.healthIntervalMs() : OFFLINE_HEALTH_INTERVAL_MS;
        return this.deps.lmStudio.probeHealth(Math.floor(cadence * 0.8), !this.connected);
      },
      serverHealthy: () => this.deps.server.isRunning && !!this.client,
      isConnected: () => this.connected,
      goOffline: () => this.markOffline(),
      connect: () => this.init(),
      reloadModels: () => this.refreshModelsToWebview('periodic'),
    },
    {
      refreshEvery: REFRESH_EVERY_TICKS,
      offlineAfterTimeouts: OFFLINE_AFTER_TIMEOUTS,
      backoff: { base: 2000, max: 30000 },
    },
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
    this.editorSub = vscode.window.onDidChangeActiveTextEditor((e) => {
      this.updateActiveFile(e);
      this.updateSelection(e);
    });
    this.selectionSub = vscode.window.onDidChangeTextEditorSelection((e) =>
      this.updateSelection(e.textEditor),
    );
    // Self-heal when the shared OpenCode server dies unexpectedly.
    this.serverExitSub = this.deps.server.addExitListener(() => this.onServerExit());
  }

  dispose(): void {
    this.disposed = true;
    this.messageSub?.dispose();
    this.eventAbort?.abort();
    this.editorSub?.dispose();
    this.selectionSub?.dispose();
    this.serverExitSub?.dispose();
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.pickerTimer) {
      clearInterval(this.pickerTimer);
      this.pickerTimer = undefined;
    }
  }

  /** The connected-state poll cadence (ms), from user settings. */
  private healthIntervalMs(): number {
    return getConfig().healthCheckSeconds * 1000;
  }

  /**
   * Poll so the panel self-heals. The policy (when to reconnect, how to back
   * off, when to reload models) lives in the pure, unit-tested `SelfHealer`.
   *
   * The timer is a fixed 5s metronome that only PROBES when due: every tick
   * while disconnected, every healthCheckSeconds while connected. A fixed
   * interval (rather than a rescheduled timeout) survives a tick that throws,
   * and reacts within 5s when some out-of-tick path flips us offline —
   * postServers(false) resets the due time. Config changes take effect on the
   * next due probe.
   */
  private startHealthPoll(): void {
    if (this.healthTimer || this.disposed) {
      return;
    }
    this.healthTimer = setInterval(() => void this.runHealthTick(), OFFLINE_HEALTH_INTERVAL_MS);
  }

  /**
   * Visibility changed (sidebar collapsed, tab moved to background). Hidden
   * panels keep their slow self-heal poll but skip model refreshes; on
   * becoming visible again, catch up immediately.
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return;
    }
    this.visible = visible;
    if (visible && this.connected) {
      void this.refreshModelsToWebview('periodic');
    }
  }

  private async runHealthTick(): Promise<void> {
    if (this.disposed || this.connecting) {
      return;
    }
    if (Date.now() >= this.nextProbeDueAt) {
      const started = Date.now();
      try {
        await this.healer.tick();
      } finally {
        // While disconnected the next metronome tick (5s) probes again; while
        // connected wait out the configured cadence. Anchor to the tick START
        // (minus slack for timer drift) — anchoring to completion would push
        // the due time past the next tick whenever the cadence equals the
        // metronome period, silently halving the probe rate.
        this.nextProbeDueAt = this.connected ? started + this.healthIntervalMs() - 500 : 0;
      }
    }
    // Goal watchdog ("wake up on occasion"): if the loop lost its idle signal
    // (e.g. an error swallowed the event) re-check once things are quiet.
    if (
      this.activeGoal &&
      !this.activeGoal.paused &&
      !this.goalChecking &&
      Date.now() - this.lastGoalActivity > 120_000
    ) {
      this.lastGoalActivity = Date.now(); // back off between watchdog retries
      if (!(await this.isSessionBusy())) {
        void this.runGoalCheck();
      }
    }
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
    this.streamingClient = undefined;
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

  /**
   * Track the current editor selection so it can be auto-attached as context,
   * the way Claude Code shares the highlighted code. Cleared (and the pill
   * removed) whenever the selection is empty or the editor isn't a real file —
   * which is also why a Markdown *preview* never produces a selection (it's not
   * a TextEditor). Uses getText() for the exact text (multi-byte safe) and
   * offsetAt() for character offsets, so the range we hand OpenCode lines up
   * with the text even with emoji/accented characters in the document.
   */
  private updateSelection(editor: vscode.TextEditor | undefined): void {
    // Keep the last real selection when focus moves to the webview/panel (the
    // editor goes undefined) — same as updateActiveFile. Otherwise the user's
    // highlighted code would vanish the instant they click into the composer to
    // type, which is the primary "highlight → ask about it" flow.
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const sel = editor.selection;
    if (!sel || sel.isEmpty) {
      // A real file editor with no (longer a) selection — the user deselected.
      if (this.activeSelection) {
        this.activeSelection = null;
        this.post({ type: 'activeSelection', selection: null });
      }
      return;
    }
    const doc = editor.document;
    const abs = doc.uri.fsPath;
    const text = doc.getText(sel);
    this.activeSelection = {
      abs,
      rel: vscode.workspace.asRelativePath(abs),
      text,
      start: doc.offsetAt(sel.start),
      end: doc.offsetAt(sel.end),
      startLine: sel.start.line + 1, // 1-based for display (App.tsx#14-19)
      endLine: sel.end.line + 1,
    };
    this.post({
      type: 'activeSelection',
      selection: {
        path: this.activeSelection.rel,
        startLine: this.activeSelection.startLine,
        endLine: this.activeSelection.endLine,
        chars: text.length,
      },
    });
  }

  /** Start a fresh conversation (invoked by the New Chat command). */
  async requestNewChat(): Promise<void> {
    await this.newSession();
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
          // A fresh webview always starts with the picker closed — stop any
          // fast-poll loop a previous webview incarnation left running (iframe
          // reloads never send modelMenu open:false).
          this.setModelMenuOpen(false);
          await this.init();
          break;
        case 'send':
          // While a goal is set, quietly check (in the background — the send
          // must not wait on the local model) whether this message changes the
          // goal; if so the user gets a confirm card before it actually does.
          this.maybeOfferGoalRevision(msg.text);
          await this.handleSend(
            msg.text,
            msg.effort,
            msg.images ?? [],
            msg.includeActiveFile ?? false,
            msg.includeSelection ?? false,
          );
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
        case 'refreshModels':
          await this.refreshModelsToWebview();
          break;
        case 'modelMenu':
          this.setModelMenuOpen(msg.open);
          break;
        case 'listServers':
          this.postServers(this.connected);
          break;
        case 'addServer':
          await this.deps.servers.add(msg.name, msg.url, msg.apiKey);
          this.postServers(this.connected);
          break;
        case 'updateServer': {
          const before = this.deps.servers.list().find((s) => s.id === msg.id);
          await this.deps.servers.update(msg.id, msg.name, msg.url, msg.apiKey);
          const after = this.deps.servers.list().find((s) => s.id === msg.id);
          // A rename (or no-op Save) must not tear down a live session — only
          // reconnect when something the connection depends on changed.
          const connectionChanged =
            !!before && !!after && (before.url !== after.url || resolveApiKeyEdit(msg.apiKey).kind !== 'keep');
          if (this.deps.servers.active().id === msg.id && connectionChanged) {
            await this.switchServer(msg.id);
          } else {
            this.postServers(this.connected);
          }
          break;
        }
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
          // Stop means stop: pause the goal loop BEFORE aborting, so the abort's
          // session.idle event can't race in and immediately re-continue the
          // turn the user just killed (resume from the goal bar).
          if (this.activeGoal && !this.activeGoal.paused) {
            this.activeGoal.paused = true;
            this.postGoal();
            this.post({ type: 'status', text: 'Goal paused — resume from the goal bar.', kind: 'warn' });
          }
          if (this.currentSessionID) {
            await this.client?.abort(this.currentSessionID);
          }
          break;
        case 'permission':
          await this.client?.respondPermission(msg.sessionID, msg.permissionID, msg.response);
          break;
        case 'setPermissionMode':
          await this.setPermissionMode(msg.mode);
          break;
        case 'setMinContext':
          await this.setMinContext(msg.tokens);
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
        case 'openInTab':
          await vscode.commands.executeCommand('lmstudioCode.openInTab');
          break;
        case 'requestMcpStatus':
          await this.sendMcpStatus();
          break;
        case 'requestSkills':
          await this.sendSkills();
          break;
        case 'requestAgents':
          await this.sendAgents();
          break;
        case 'createAgent':
          await this.createAgent(msg.name);
          break;
        case 'runCommand':
          await this.handleRunCommand(msg.command, msg.arguments);
          break;
        case 'setGoal':
          await this.setGoal(msg.objective);
          break;
        case 'updateGoal': {
          // A confirmed revision: swap the objective in place. The revised goal
          // gets a fresh iteration budget, and old stall reasons no longer
          // apply; elapsed time and paused state carry over.
          const g = this.activeGoal;
          const obj = msg.objective.trim();
          if (g && obj) {
            g.objective = obj;
            g.iteration = 0;
            g.recentReasons = [];
            this.lastGoalActivity = Date.now();
            this.postGoal();
            this.post({ type: 'goalEvent', kind: 'updated', reason: obj });
          }
          break;
        }
        case 'pauseGoal':
          if (this.activeGoal) {
            this.activeGoal.paused = true;
            this.postGoal();
          }
          break;
        case 'resumeGoal':
          await this.resumeGoal();
          break;
        case 'clearGoal':
          this.activeGoal = null;
          this.postGoal();
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

  /**
   * Persist a new tool-approval posture. Writing the setting fires the
   * extension's onDidChangeConfiguration listener, which disposes the managed
   * server; the next request self-heals onto a fresh spawn with the new
   * ruleset baked in (the ruleset lives in OPENCODE_CONFIG_CONTENT, so a
   * respawn is the only way to change it for every session, subagents
   * included). Workspace-scoped when a folder is open so that trusting a
   * workspace with "bypass" doesn't silently carry into every other project.
   */
  private async setPermissionMode(mode: PermissionMode): Promise<void> {
    const value = normalizePermissionMode(mode);
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('lmstudioCode').update('permissionMode', value, target);
    log(`permission mode set to ${value} (server respawns on next request)`);
    this.post({ type: 'permissionMode', mode: value });
  }

  /**
   * "Context on load" from the model menu: persist the requested size, then
   * grow the current model to it right away if it's already loaded smaller —
   * otherwise the choice would silently wait for the next load. LM Studio has
   * the final say on the window it actually grants.
   */
  private async setMinContext(tokens: number): Promise<void> {
    const value = Math.max(1024, Math.floor(tokens));
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace
      .getConfiguration('lmstudioCode')
      .update('minContextLength', value, target);
    log(`context-on-load set to ${value}`);
    if (!this.currentModel) {
      return;
    }
    const result = await this.deps.lmStudio.ensureContext(
      this.currentModel,
      value,
      getConfig().gpuOffload,
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
    // Resolve the key BEFORE mutating the shared client: sibling panels' health
    // ticks use it concurrently, and url+key must change as one atomic pair so
    // a Bearer key can never be sent to a different server's host.
    const apiKey = await this.deps.servers.apiKeyFor(active.id);
    this.deps.lmStudio.setBaseUrl(active.url);
    this.deps.lmStudio.setApiKey(apiKey);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    this.post({ type: 'status', text: `Connecting to ${active.name}…` });
    const upstream = await this.deps.lmStudio.checkConnectionStatus();
    this.connected = upstream === 'ok';
    this.postServers(this.connected);

    // Offline or unauthorized: show the connection screen and wait for retry /
    // switch / key edit. The healer applies no backoff for this — the poll
    // recovers the moment LM Studio accepts a request again.
    if (!this.connected) {
      // 'timeout' lands here too: for a user-facing connect attempt a server
      // that won't answer is indistinguishable from one that's gone.
      const authRequired = upstream === 'auth-required';
      // The webview now shows models: [] — resync the periodic diff-guard so
      // the next healthy refresh always posts (a stale healthy snapshot here
      // would suppress it and freeze the picker on "No models found").
      this.lastPostedModelsJson = '';
      this.post({
        type: 'init',
        models: [],
        currentModel: null,
        agent: this.agent,
        cwd,
        serverReady: false,
        lmStudioConnected: false,
        lmStudioAuthRequired: authRequired,
        minContext: cfg.minContextLength,
        defaultEffort: cfg.defaultThinkingEffort,
        permissionMode: cfg.permissionMode,
        agents: [],
      });
      const text = authRequired
        ? active.hasApiKey
          ? `LM Studio at ${active.url} rejected the stored API key — update it under Servers`
          : `LM Studio at ${active.url} requires an API key — add one under Servers`
        : `Can't reach LM Studio at ${active.url}`;
      this.post({ type: 'status', text, kind: 'warn' });
      log(`doInit: upstream ${upstream} for ${active.url}`);
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
      this.lastPostedModelsJson = ''; // webview shows models: [] — resync diff-guard
      this.post({
        type: 'init',
        models: [],
        currentModel: null,
        agent: this.agent,
        cwd,
        serverReady: false,
        lmStudioConnected: true,
        minContext: cfg.minContextLength,
        defaultEffort: cfg.defaultThinkingEffort,
        permissionMode: cfg.permissionMode,
        agents: [],
      });
      return 'failed';
    }
    // A restart moves the server to a new random port. The old event stream is
    // still retrying the dead one, and startEventStream() would no-op because
    // eventAbort is still set — leaving the panel connected but eventless.
    if (this.streamingClient && this.streamingClient !== started.client) {
      this.eventAbort?.abort();
      this.eventAbort = undefined;
      this.streamingClient = undefined;
    }
    this.client = started.client;

    const models = await this.loadModels();
    const stored = this.deps.context.workspaceState.get<string>('lmstudioCode.model');
    // The live in-session selection wins over configuration: a self-heal
    // reconnect mid-conversation must never silently switch the user's model
    // back to defaultModel. defaultModel only decides on a fresh panel.
    this.currentModel =
      pickModel([this.currentModel ?? '', cfg.defaultModel, stored ?? ''], models) ?? null;

    this.startEventStream();

    // Agents come from the server (built-ins + anything the user defined on
    // disk). A stored selection that no longer exists falls back to build, so a
    // renamed or deleted agent can't leave the composer pointing at nothing.
    const agents = await this.loadAgents();
    this.agent = resolveAgent(this.agent, this.lastAgents as AgentInfo[]);

    this.lastPostedModelsJson = JSON.stringify({ models, currentModel: this.currentModel });
    this.post({
      type: 'init',
      models,
      currentModel: this.currentModel,
      agent: this.agent,
      cwd,
      serverReady: true,
      lmStudioConnected: true,
      minContext: cfg.minContextLength,
      defaultEffort: cfg.defaultThinkingEffort,
      permissionMode: cfg.permissionMode,
      agents,
    });

    await this.sendSessions();
    // Restore the last active conversation — idea contributed by
    // @AlessandroPerazzetta (PR #8), reworked to run only on a bridge's FIRST
    // init: doInit also runs on every self-heal reconnect, where re-posting
    // sessionLoaded would wipe and re-render a live transcript.
    await this.maybeRestoreLastSession();
    // No eager session: a fresh chat stays null until the first message creates
    // it lazily (handleSend), so an empty "New chat" never shows in history.
    if (!this.currentSessionID) {
      this.updateTitle('New chat');
      this.post({ type: 'cleared' });
    }
    // One-time migration: clean up empty sessions created before sessions went
    // lazy. Gated behind a PERSISTED flag (not a per-instance one) so it runs
    // once per install — every panel re-resolve / editor tab spins up a new
    // ChatBridge, and re-running this destructive scan each time is both wasteful
    // and widens the race window against sibling bridges' in-flight sessions.
    if (!this.deps.context.globalState.get(PRUNED_EMPTIES_KEY)) {
      void this.deps.context.globalState.update(PRUNED_EMPTIES_KEY, true);
      void this.pruneEmptySessions();
    }
    // Populate the slash menu with the server's commands + skills.
    void this.sendCommands();
    this.updateActiveFile(vscode.window.activeTextEditor);
    this.updateSelection(vscode.window.activeTextEditor);
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

  /**
   * Gather the skills OpenCode discovered (GET /skill) for the `/skills` panel,
   * classifying each by where it came from so the user can confirm their
   * project/global/Claude-Code skills are being found. Posts a `skills`
   * message; `skills: []` means none were discovered.
   */
  private async sendSkills(): Promise<void> {
    let skills: UiSkill[] = [];
    if (this.client) {
      try {
        const raw = await this.client.listSkills();
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        // Classification (project / global / built-in) is pure — see core/skills.
        skills = classifySkills(raw, root);
      } catch (err) {
        logError('GET /skill failed', err);
      }
    }
    this.post({ type: 'skills', skills });
  }

  /**
   * Both halves of the agent roster for the `/agents` panel: the ones the user
   * can select, and the ones only the model can reach by delegating through the
   * `task` tool. They are different sets — `mode: subagent` never appears in the
   * picker, `mode: primary` is never delegated to — and showing both is the
   * point, since a subagent is invisible in the composer yet still costs the
   * primary session context.
   */
  private async sendAgents(): Promise<void> {
    await this.loadAgents(); // refresh this.lastAgents
    const toUi = (a: AgentInfo): UiAgent => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
      native: a.native,
      modelID: a.model?.modelID ?? undefined,
    });
    const all = this.lastAgents as AgentInfo[];
    this.post({
      type: 'agents',
      agents: pickableAgents(all).map(toUi),
      delegatable: delegatableAgents(all).map(toUi),
    });
  }

  /**
   * Scaffold `.opencode/agent/<name>.md` and open it in the editor. OpenCode
   * discovers agents from disk only at startup — there is no runtime CRUD, and
   * a PATCH /config carrying an agent silently no-ops — so the server has to be
   * restarted before the new agent exists. We write the file and tell the user;
   * the restart happens on their next explicit restart or reload, which keeps a
   * half-written definition from tearing down a live session.
   */
  private async createAgent(rawName: string): Promise<void> {
    const name = rawName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) {
      this.post({ type: 'error', message: 'Agent name must contain a letter or number.' });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.post({ type: 'error', message: 'Open a folder before creating an agent.' });
      return;
    }
    const file = vscode.Uri.joinPath(root, '.opencode', 'agent', `${name}.md`);
    try {
      let exists = true;
      try {
        await vscode.workspace.fs.stat(file);
      } catch {
        exists = false;
      }
      if (!exists) {
        const template = [
          '---',
          `description: Describe when this agent should be used. The model reads this verbatim to decide whether to delegate here, so be specific.`,
          '# primary = you pick it in the composer; subagent = the model delegates to it; all = both',
          'mode: subagent',
          '# Optional: pin a model, restrict tools, set reasoning effort',
          '# model: lmstudio/qwen/qwen3.6-27b',
          '# variant: high',
          '# tools:',
          '#   bash: false',
          '---',
          '',
          `You are ${name}. Replace this body with the system prompt for this agent.`,
          '',
        ].join('\n');
        await vscode.workspace.fs.writeFile(file, Buffer.from(template, 'utf8'));
      }
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.post({
        type: 'status',
        text: exists
          ? `Opened existing agent "${name}".`
          : `Created .opencode/agent/${name}.md — restart the OpenCode server to load it.`,
        kind: 'info',
      });
    } catch (err) {
      logError('createAgent failed', err);
      this.post({ type: 'error', message: `Could not create agent: ${humanizeError(err)}` });
    }
  }

  /**
   * Send the server's slash commands (custom/built-in commands AND skills) to
   * the webview so they appear in the composer's slash menu. Skills carry
   * source:'skill' so the menu can badge them.
   */
  private async sendCommands(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      const raw = await this.client.listCommands();
      const commands: UiCommand[] = raw.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        source: c.source === 'skill' ? 'skill' : 'command',
        takesArgs: commandTakesArgs(c.hints),
      }));
      this.post({ type: 'commands', commands });
    } catch (err) {
      logError('GET /command failed', err);
    }
  }

  /**
   * Run a server command or skill (e.g. the user typed "/fibonacci-helper x").
   * Creates the session lazily if needed (a command is real activity, so it
   * earns a history entry), ensures the model context, then hands off to
   * OpenCode which expands the template and streams the result like a prompt.
   */
  private async handleRunCommand(command: string, args?: string): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    if (!this.currentModel) {
      throw new Error('No LM Studio model selected.');
    }
    await this.ensureSession();
    const cfg = getConfig();
    if (cfg.autoEnsureContext) {
      await this.deps.lmStudio
        .ensureContext(this.currentModel, cfg.minContextLength, cfg.gpuOffload, (m) =>
          this.post({ type: 'status', text: m }),
        )
        .catch((err) => logError('ensureContext for command', err));
      this.post({ type: 'status', text: '' });
    }
    this.post({ type: 'busy', busy: true });
    await this.client.runCommand(this.currentSessionID!, {
      command,
      ...(args ? { arguments: args } : {}),
      agent: this.agent,
      model: `lmstudio/${this.currentModel}`,
    });
    // A command counts as the first turn of a fresh chat — refresh history so it
    // shows up (and gets its session title from the run).
    await this.sendSessions();
  }

  // ---- Goal loop -----------------------------------------------------------
  // /goal <objective> sets an autonomous goal: after every turn goes idle, an
  // isolated LLM judge decides MET / NOT_MET; NOT_MET auto-continues the agent
  // with the judge's feedback until the goal is met or an unreasonable endpoint
  // is hit (iteration cap or no-progress stall — see core/goal). The judge runs
  // in a throwaway session that is deleted after each check so it never touches
  // the conversation or the history list.

  private postGoal(): void {
    const g = this.activeGoal;
    const goal: UiGoal | null = g
      ? {
          objective: g.objective,
          iteration: g.iteration,
          maxIterations: g.maxIterations,
          startedAt: g.startedAt,
          state: g.paused ? 'paused' : 'active',
        }
      : null;
    this.post({ type: 'goal', goal });
  }

  /** Set (or replace) the goal and kick off pursuit immediately. */
  private async setGoal(objective: string): Promise<void> {
    const obj = objective.trim();
    if (!obj) {
      return;
    }
    this.activeGoal = { ...newGoal(obj), startedAt: Date.now(), paused: false };
    this.lastGoalActivity = Date.now();
    this.postGoal();
    // Kick off right away (like Codex's "Pursuing goal…"): the first turn tells
    // the agent the goal; the idle→judge→continue loop sustains it from there.
    await this.handleSend(
      `Work toward this goal until it is fully met: ${obj}`,
      'auto', // leave depth to the model's own default, as this always has
      [],
      false,
      false,
    );
  }

  /** Un-pause the loop; if the session is already idle, get moving again now. */
  private async resumeGoal(): Promise<void> {
    if (!this.activeGoal) {
      return;
    }
    this.activeGoal.paused = false;
    this.lastGoalActivity = Date.now();
    this.postGoal();
    if (!(await this.isSessionBusy())) {
      void this.runGoalCheck();
    }
  }

  /** Whether the current session has a turn in flight (server-side truth). */
  private async isSessionBusy(): Promise<boolean> {
    try {
      const st = await this.client?.sessionStatus();
      return !!(st && this.currentSessionID && st[this.currentSessionID]);
    } catch {
      return false;
    }
  }

  /** The user-facing identity override (shared by sends + goal continues). */
  private identitySystem(): string {
    return 'You are "LM Studio Code", an agentic coding assistant running on the user\'s machine against their local LM Studio models. If asked your name or what you are, identify as "LM Studio Code". Never identify yourself as "opencode".';
  }

  /** The goal directive appended to the agent's system prompt while active. */
  private goalSystemSuffix(): string {
    const g = this.activeGoal;
    if (!g || g.paused) {
      return '';
    }
    return (
      `\n\nACTIVE GOAL: ${g.objective}\n` +
      'Keep working toward this goal across turns until it is fully met. ' +
      'Prefer taking the next concrete action over asking for confirmation.'
    );
  }

  /** session.idle hook — run one judge check (debounced by the checking flag). */
  private async onTurnIdle(): Promise<void> {
    if (!this.activeGoal || this.activeGoal.paused || this.goalChecking || this.disposed) {
      return;
    }
    await new Promise((r) => setTimeout(r, 600)); // let final parts persist
    void this.runGoalCheck();
  }

  /** One loop step: transcript → judge → met / continue / stop. */
  private async runGoalCheck(): Promise<void> {
    const goal = this.activeGoal;
    if (
      !goal ||
      goal.paused ||
      this.goalChecking ||
      !this.client ||
      !this.currentSessionID ||
      !this.currentModel
    ) {
      return;
    }
    this.goalChecking = true;
    this.post({ type: 'goalEvent', kind: 'checking' });
    try {
      const transcript = await this.transcriptTail(this.currentSessionID);
      const verdict = await this.judgeGoal(goal.objective, transcript);
      // The goal may have been cleared/edited/paused while the judge ran.
      if (this.activeGoal !== goal || goal.paused) {
        return;
      }
      const action = decideNext(goal, verdict);
      this.lastGoalActivity = Date.now();
      if (action.kind === 'met') {
        this.activeGoal = null;
        this.postGoal();
        this.post({ type: 'goalEvent', kind: 'met', reason: action.reason });
      } else if (action.kind === 'continue') {
        goal.iteration = action.iteration;
        goal.recentReasons = [...goal.recentReasons, action.reason].slice(-5);
        this.postGoal();
        this.post({
          type: 'goalEvent',
          kind: 'continued',
          reason: action.reason,
          iteration: action.iteration,
        });
        await this.continueGoal(goal.objective, action.reason);
      } else {
        // Unreasonable endpoint (cap or stall): pause, keep the goal pinned so
        // the user can see why and resume/raise the cap if they want.
        goal.paused = true;
        this.postGoal();
        this.post({ type: 'goalEvent', kind: 'stopped', why: action.why, reason: action.reason });
      }
    } catch (err) {
      logError('goal check failed', err);
    } finally {
      this.goalChecking = false;
    }
  }

  /** Judge in an isolated throwaway session; always delete it afterwards. */
  private async judgeGoal(
    objective: string,
    transcript: string,
  ): Promise<{ met: boolean; reason: string }> {
    const reply = await this.askThrowaway(
      'goal-judge',
      buildJudgePrompt(objective, transcript),
      'You are a strict goal-completion judge. Answer directly and concisely. ' +
        'Do not produce chain-of-thought.',
    );
    if (!reply.trim()) {
      return { met: false, reason: 'judge timed out' };
    }
    return parseJudgeVerdict(reply);
  }

  /**
   * Ask the current model one question in an isolated throwaway session and
   * return its raw reply text ('' on timeout or disposal). The session never
   * touches chat history — it is always deleted afterwards.
   */
  private async askThrowaway(title: string, prompt: string, system: string): Promise<string> {
    const client = this.client!;
    const session = await client.createSession(title);
    try {
      // Judge verdicts want speed, not deliberation: pin reasoning off via the
      // variant rather than the old qwen-only `/no_think` string, so it works
      // across families and leaves the prompt itself clean. Falls back to a
      // system nudge on models that declare no reasoning support.
      const reasoning = this.modelReasoning(this.currentModel);
      const level = resolveLevel('off', reasoning);
      const nudge = fallbackPromptText(level, reasoning);
      await client.promptAsync(session.id, {
        model: { providerID: 'lmstudio', modelID: this.currentModel! },
        system: nudge ? `${system}\n\n${nudge}` : system,
        ...(variantForLevel(level) ? { variant: variantForLevel(level) } : {}),
        parts: [{ type: 'text', text: prompt }],
      });
      // Poll for the completed assistant reply (local models can be slow).
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (this.disposed) {
          return '';
        }
        const msgs = await client.getMessages(session.id);
        const done = [...msgs]
          .reverse()
          .find((m) => m.info.role === 'assistant' && m.info.time?.completed);
        if (done) {
          return (done.parts ?? [])
            .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
            .map((p) => (p as { text?: string }).text ?? '')
            .join('\n');
        }
      }
      return '';
    } finally {
      void client.deleteSession(session.id).catch(() => undefined);
    }
  }

  /**
   * While a goal is set, ask the model whether a message the user just typed
   * changes the goal itself. If it does, offer the revised objective for
   * confirmation — the goal only changes when the user accepts (updateGoal).
   * Fire-and-forget: the message already went to the agent as a send/steer.
   */
  private maybeOfferGoalRevision(text: string): void {
    const goal = this.activeGoal;
    const trimmed = (text ?? '').trim();
    if (!goal || this.revisionChecking || !this.client || !this.currentModel) {
      return;
    }
    // Slash commands and trivial acks ("ok", "go") can't redefine a goal.
    if (!trimmed || trimmed.startsWith('/') || trimmed.length < 4) {
      return;
    }
    this.revisionChecking = true;
    void (async () => {
      try {
        const reply = await this.askThrowaway(
          'goal-revise',
          buildRevisionPrompt(goal.objective, trimmed),
          'You decide whether a user message changes an agent\'s goal. ' +
            'Answer directly and concisely. Do not produce chain-of-thought.',
        );
        const verdict = parseRevisionVerdict(reply, goal.objective);
        // The goal may have been cleared or replaced while the model thought.
        if (!verdict.revise || !verdict.objective || this.activeGoal !== goal) {
          return;
        }
        this.post({ type: 'goalRevision', proposed: verdict.objective });
      } catch (err) {
        logError('goal revision check failed', err);
      } finally {
        this.revisionChecking = false;
      }
    })();
  }

  /** The tail of the conversation, as plain text for the judge (~4k chars). */
  private async transcriptTail(sessionID: string): Promise<string> {
    const msgs = await this.client!.getMessages(sessionID);
    const lines: string[] = [];
    for (const m of msgs.slice(-8)) {
      const text = (m.parts ?? [])
        .map((p) => {
          if (p.type === 'text') {
            return (p as { text?: string }).text ?? '';
          }
          if (p.type === 'tool') {
            const t = p as { tool?: string; state?: { title?: string } };
            return `[tool: ${t.tool ?? '?'} ${t.state?.title ?? ''}]`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (text.trim()) {
        lines.push(`${m.info.role.toUpperCase()}:\n${text.trim()}`);
      }
    }
    const full = lines.join('\n\n');
    return full.length > 4000 ? full.slice(-4000) : full;
  }

  /** Auto-continue the working agent with the judge's feedback. */
  private async continueGoal(objective: string, reason: string): Promise<void> {
    this.post({ type: 'busy', busy: true });
    await this.sendPrompt({
      model: { providerID: 'lmstudio', modelID: this.currentModel! },
      agent: this.agent,
      system: this.identitySystem() + this.goalSystemSuffix(),
      parts: [{ type: 'text', text: buildContinuePrompt(objective, reason) }],
    });
  }

  private postServers(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      // Some flips to offline happen outside a health tick (a failed send's
      // reconnect, switching to a dead server) — make the next 5s metronome
      // tick probe immediately instead of waiting out the connected cadence.
      this.nextProbeDueAt = 0;
    }
    this.post({
      type: 'servers',
      servers: this.deps.servers.list().map((s) => ({ id: s.id, name: s.name, url: s.url, hasApiKey: !!s.hasApiKey })),
      activeId: this.deps.servers.active().id,
      connected,
    });
  }

  /** Switch the active LM Studio server: tear down OpenCode and re-initialize. */
  private async switchServer(id: string): Promise<void> {
    await this.deps.servers.setActive(id);
    this.currentSessionID = null;
    this.persistSession(null);
    this.healer.allowImmediate(); // a deliberate switch shouldn't wait on backoff
    this.teardownConnection(true);
    this.post({ type: 'cleared' });
    await this.init();
  }

  /**
   * Push a fresh model list to the webview.
   *
   * 'action' (user did something: load/eject/rescan/reconnect) always posts —
   * the webview uses the reply to clear load spinners and dismiss the menu.
   * 'periodic' (health cadence / picker loop / visibility catch-up) is
   * best-effort: skipped while hidden or disconnected, and suppressed when
   * nothing changed so the webview isn't re-rendered every cycle for no reason.
   */
  private async refreshModelsToWebview(reason: 'action' | 'periodic' = 'action'): Promise<void> {
    if (reason === 'periodic' && (!this.visible || !this.connected)) {
      return;
    }
    const models = await this.loadModels();
    if (reason === 'periodic' && models.length === 0) {
      // A transient listing failure surfaces as [] — never blank a populated
      // picker from a background refresh; an 'action' post stays authoritative.
      return;
    }
    const payload = { models, currentModel: this.currentModel };
    const json = JSON.stringify(payload);
    if (reason === 'periodic' && json === this.lastPostedModelsJson) {
      return;
    }
    this.lastPostedModelsJson = json;
    this.post({ type: 'models', ...payload, reason });
  }

  /** The webview's model picker opened/closed: run a fast refresh loop while open. */
  private setModelMenuOpen(open: boolean): void {
    if (open) {
      if (!this.pickerTimer && !this.disposed) {
        void this.refreshModelsToWebview('periodic');
        this.pickerTimer = setInterval(
          () => void this.refreshModelsToWebview('periodic'),
          PICKER_REFRESH_MS,
        );
      }
    } else if (this.pickerTimer) {
      clearInterval(this.pickerTimer);
      this.pickerTimer = undefined;
    }
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
      reasoning: m.reasoning,
    }));
    return this.lastModels;
  }

  /**
   * Agents the server knows, filtered to the ones a user can actually select.
   * User-defined agents come from .opencode/agent/*.md (and the global
   * ~/.config/opencode/agent/), discovered by OpenCode at startup — so a newly
   * added agent appears after the next server restart, not immediately.
   */
  private async loadAgents(): Promise<UiAgent[]> {
    if (!this.client) {
      return [];
    }
    try {
      this.lastAgents = await this.client.listAgents();
    } catch (err) {
      // Never fatal: an older server or a transient failure just means the
      // picker falls back to the built-in pair.
      logError('could not enumerate agents', err);
      this.lastAgents = [];
    }
    return pickableAgents(this.lastAgents as AgentInfo[]).map((a) => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
      native: a.native,
      modelID: a.model?.modelID ?? undefined,
    }));
  }

  /**
   * Declared reasoning capability for a model id, from the last enumeration.
   * `undefined` when we've never seen the model or the endpoint couldn't report
   * it — which the effort logic treats as "unknown", not "unsupported".
   */
  private modelReasoning(modelID: string | null): ReasoningCapability | null | undefined {
    if (!modelID) {
      return undefined;
    }
    return this.lastModels.find((m) => m.id === modelID)?.reasoning;
  }

  /**
   * Start a fresh chat WITHOUT creating a server session yet. The actual
   * OpenCode session is created lazily on the first send (see handleSend), so an
   * untouched "New chat" never lands in history — only conversations with real
   * back-and-forth do. Resets to a null session and clears the view.
   */
  private async newSession(announce = true): Promise<void> {
    this.currentSessionID = null;
    this.persistSession(null);
    // A goal is scoped to its conversation — leaving it ends the loop.
    this.activeGoal = null;
    this.postGoal();
    this.updateTitle('New chat');
    this.post({ type: 'cleared' });
    if (announce) {
      await this.sendSessions();
    }
  }

  /**
   * Ensure a server session exists for the current chat, creating one on demand.
   * Called right before the first prompt of a fresh chat — this is the moment a
   * "New chat" actually becomes a real session (and thus a history entry).
   */
  private async ensureSession(): Promise<void> {
    if (this.currentSessionID || !this.client) {
      return;
    }
    if (this.ensuringSession) {
      return this.ensuringSession;
    }
    const client = this.client;
    this.ensuringSession = (async () => {
      try {
        const session = await client.createSession('New chat');
        if (this.currentSessionID) {
          // A concurrent loadSession won the race — don't clobber it; discard
          // the session we just created so it doesn't linger as an empty entry.
          void client.deleteSession(session.id).catch(() => undefined);
          return;
        }
        this.currentSessionID = session.id;
        this.persistSession(session.id);
      } finally {
        this.ensuringSession = undefined;
      }
    })();
    return this.ensuringSession;
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

  /**
   * One-time cleanup of empty sessions left over from before sessions went lazy.
   * Going forward none are created, but a user upgrading has a pile of zero-
   * message "New chat" entries. A session that never had a message keeps
   * time.created === time.updated (verified: the first prompt bumps `updated`);
   * we confirm zero messages before deleting so a real session is never removed.
   * Best-effort and quiet — failures here must never block startup.
   */
  private async pruneEmptySessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    let removed = 0;
    try {
      const sessions = await this.client.listSessions();
      // Two guards keep this from deleting a session another open view is using:
      // an age floor (skip very recent sessions — likely a sibling's in-flight
      // new chat) and a workspace scope (only prune sessions in our directory,
      // since the OpenCode store is shared across projects). Leftover empties
      // from before lazy sessions are old + in-workspace, so still get cleaned.
      const candidates = emptySessionCandidates(sessions, {
        currentSessionID: this.currentSessionID,
        directory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        now: Date.now(),
      });
      for (const s of candidates) {
        try {
          const messages = await this.client.getMessages(s.id);
          if (Array.isArray(messages) && messages.length === 0) {
            await this.client.deleteSession(s.id);
            removed++;
          }
        } catch {
          // skip this one — never let cleanup throw
        }
      }
    } catch (err) {
      logError('pruneEmptySessions', err);
    }
    if (removed > 0) {
      log(`pruned ${removed} empty session(s)`);
      await this.sendSessions();
    }
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
    const sessionID = this.currentSessionID;
    // Marker count going in, so a failed request can tell "the server compacted
    // anyway" from "an older compaction is still sitting in this session".
    const markersBefore = (await this.compactionState(sessionID)).markers;
    let summary = '';
    try {
      await this.client.summarize(sessionID, 'lmstudio', this.currentModel);
      summary = (await this.compactionState(sessionID)).summary;
    } catch (err) {
      // The request is only the trigger. OpenCode runs the summarization to
      // completion even when our connection drops, so a thrown request does not
      // mean a failed compaction — only a missing marker does.
      summary = await this.awaitCompaction(sessionID, markersBefore);
      if (!summary) {
        throw err;
      }
      logError('summarize request failed, but the session compacted anyway', err);
    } finally {
      // Always release the input, even if summarize threw (onMessage's catch
      // surfaces the error). A stuck "compacting" lock would be worse.
      this.post({ type: 'compacting', active: false, summary });
      this.post({ type: 'status', text: '' });
    }
  }

  /**
   * Compaction state of a session: how many `compaction` markers it holds, and
   * the summary text of the most recent one — the assistant turn that
   * immediately follows the last marker. The summary is empty while that turn
   * is still streaming, so the count is what proves a compaction happened.
   */
  private async compactionState(
    sessionID: string,
  ): Promise<{ markers: number; summary: string }> {
    try {
      const messages = await this.client!.getMessages(sessionID);
      let pending = false;
      let markers = 0;
      let summary = '';
      for (const m of messages) {
        const isMarker = (m.parts ?? []).some((part) => part.type === 'compaction');
        if (isMarker) {
          markers++;
          pending = true;
          summary = '';
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
      return { markers, summary };
    } catch {
      return { markers: 0, summary: '' };
    }
  }

  /**
   * Wait for a compaction beyond `before` markers to land and its summary to
   * finish streaming. Used when the summarize request itself failed: the server
   * keeps compacting regardless, so this is how we tell a lost connection from
   * a lost compaction. Returns '' if nothing arrives, which means a real error.
   */
  private async awaitCompaction(sessionID: string, before: number): Promise<string> {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !this.disposed) {
      const { markers, summary } = await this.compactionState(sessionID);
      if (markers > before && summary) {
        return summary;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return '';
  }

  /** Remember (or forget) the active session so the next launch can restore it. */
  private persistSession(id: string | null): void {
    void this.deps.context.workspaceState.update(LAST_SESSION_KEY, id ?? undefined);
  }

  /**
   * On the first init of a fresh bridge, reopen the conversation that was
   * active when the window closed. Never on reconnects (restoreAttempted), and
   * only one panel per window may claim the restore (sessionRestoreClaimed).
   */
  private async maybeRestoreLastSession(): Promise<void> {
    if (this.restoreAttempted || this.currentSessionID || sessionRestoreClaimed || !this.client) {
      this.restoreAttempted = true;
      return;
    }
    this.restoreAttempted = true;
    const stored = this.deps.context.workspaceState.get<string>(LAST_SESSION_KEY);
    if (!stored) {
      return;
    }
    sessionRestoreClaimed = true;
    try {
      // Validate against the real session list — getMessages on a deleted id
      // can return an empty transcript rather than throwing.
      const sessions = await this.client.listSessions();
      const match = sessions.find((s) => s.id === stored);
      if (!match) {
        this.persistSession(null); // deleted elsewhere — forget the stale id
        return;
      }
      const messages = await this.client.getMessages(stored);
      this.currentSessionID = stored;
      const title = match.title || 'Chat';
      this.updateTitle(title);
      this.post({ type: 'sessionLoaded', sessionID: stored, title, messages });
    } catch (err) {
      // Restore is best-effort — fall back to the normal fresh-chat path.
      logError('restore last session', err);
      this.currentSessionID = null;
    }
  }

  private async loadSession(sessionID: string): Promise<void> {
    if (!this.client) {
      return;
    }
    // A goal is scoped to its conversation — switching sessions ends the loop.
    this.activeGoal = null;
    this.postGoal();
    this.currentSessionID = sessionID;
    this.persistSession(sessionID);
    const messages = await this.client.getMessages(sessionID);
    const sessions = await this.client.listSessions();
    const title = sessions.find((s) => s.id === sessionID)?.title ?? 'Chat';
    this.updateTitle(title);
    this.post({ type: 'sessionLoaded', sessionID, title, messages });
  }

  private async handleSend(
    text: string,
    effort: EffortLevel,
    images: UiImage[],
    includeActiveFile: boolean,
    includeSelection: boolean,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('OpenCode server is not running.');
    }
    if (!this.currentModel) {
      throw new Error('No LM Studio model selected.');
    }
    // Lazily create the server session on the first message of a fresh chat, so
    // an untouched "New chat" never exists server-side (and never shows in
    // history).
    await this.ensureSession();
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
        await this.refreshModelsToWebview('periodic');
      }
      this.post({ type: 'status', text: '' });
    }

    // Identity: OpenCode's base prompt makes the model call itself "opencode".
    // Our system text is appended, so this overrides the user-facing identity.
    let system = this.identitySystem() + this.goalSystemSuffix();

    // Reasoning effort. The real lever is the `variant` on the prompt body,
    // which OpenCode resolves to `reasoning_effort` on the LM Studio request —
    // engine-level, and it doesn't pollute the user's message the way the old
    // `/no_think` suffix did. Clamp to what this model actually declares, so a
    // level carried over from a different model can't be sent blindly.
    const reasoning = this.modelReasoning(this.currentModel);
    const level = resolveLevel(effort, reasoning);
    const variant = variantForLevel(level);
    // Only for models that declare no reasoning capability at all is there
    // nothing to send — there, a text nudge is the one remaining lever.
    const nudge = fallbackPromptText(level, reasoning);
    if (nudge) {
      system += `\n\n${nudge}`;
    }

    const parts: PromptBody['parts'] = [{ type: 'text', text }];
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

    // Attach the current editor selection as context (auto-included, excludable
    // from the UI). Shared as a file part scoped to the selection's range, so
    // the model sees exactly the highlighted code plus where it lives. The
    // filename carries the line range (e.g. app.js#14-19) so it's self-labeling.
    if (includeSelection && this.activeSelection) {
      const s = this.activeSelection;
      const label = selectionLabel(s.rel, s.startLine, s.endLine);
      parts.push({
        type: 'file',
        mime: 'text/plain',
        filename: label,
        url: `file://${s.abs}`,
        source: { type: 'file', path: s.abs, text: { value: s.text, start: s.start, end: s.end } },
      });
    }

    this.post({ type: 'busy', busy: true });
    await this.sendPrompt({
      model: { providerID: 'lmstudio', modelID: this.currentModel },
      agent: this.agent,
      ...(system ? { system } : {}),
      ...(variant ? { variant } : {}),
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
    this.streamingClient = this.client;
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
    // Goal loop: a finished turn on the active session triggers one judge check.
    if (event.type === 'session.idle' && sid && sid === this.currentSessionID) {
      void this.onTurnIdle();
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
