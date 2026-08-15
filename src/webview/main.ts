import { marked } from 'marked';
import {
  CompactionState,
  isCompactionPart,
  isSyntheticText,
  markCompaction,
  newCompactionState,
  shouldSuppressMessage,
} from '../core/compaction';
import { matchSlashPrefix, mergeSlashCommands, parseSlashInput } from '../core/commands';
import { computeWindow, formatTokens } from '../core/context';
import {
  type AgentInfo,
  agentLabel,
  agentOverheadTokens,
  agentTooltip,
  pickableAgents,
  resolveAgent,
} from '../core/agents';
import {
  formatRate,
  recordAgent,
  formatThinkingLabel,
  newTurnRate,
  recordDelta,
  recordTokens,
  summarize,
  type TurnRate,
} from '../core/genrate';
import {
  type EffortLevel,
  type ReasoningCapability,
  isBinary,
  levelLabel,
  levelsForModel,
  resolveLevel,
} from '../core/effort';
import { humanizeError } from '../core/errors';
import { type PermissionMode, permissionModeLabel } from '../core/permission';
import { modelDisambiguator, modelIdentity } from '../core/models';
import { isTodoCardCollapsed, summarizeTodos, Todo } from '../core/todos';
import { buildAnswers, isEmptyAnswer, parseQuestionBlob, QInfo } from '../core/question';
import type { MessageWithParts, OpencodeEvent, Part } from '../opencode/protocol';
import type { HostToWebview, UiAgent, UiCommand, UiGoal, UiImage, UiMcpServer, UiModel, UiServer, UiSession, UiSkill, WebviewToHost } from '../shared';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};
// Injected by esbuild `define`: true in test builds, false in production (where
// the test hook below is then dead-code-eliminated).
declare const __TEST__: boolean;

const vscode = acquireVsCodeApi();
function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface State {
  models: UiModel[];
  currentModel: string | null;
  agent: string;
  /** Selectable agents from the server (built-ins + user-defined). */
  agents: UiAgent[];
  sessions: UiSession[];
  currentSessionID: string | null;
  busy: boolean;
  serverReady: boolean;
  lmStudioConnected: boolean;
  lmStudioAuthRequired: boolean;
  /** Reasoning depth per model id. Effort is a per-model property, so it is
   *  remembered per model rather than globally. */
  effortByModel: Record<string, EffortLevel>;
  /** Configured fallback when a model has no stored choice. */
  defaultEffort: EffortLevel;
  /** Tool-approval posture (default / strict / bypass) — host-owned setting. */
  permissionMode: PermissionMode;
  /** Whether reasoning blocks are *displayed* — deliberately independent of how
   *  hard the model thinks. Conflating the two was the old `thinking` boolean. */
  showReasoning: boolean;
  pendingImages: UiImage[];
  minContext: number;
  realTokens: number;
  compacted: boolean;
  compacting: boolean; // a /compact run is in flight — input is blocked
  pendingCompaction: boolean; // compacted; true size is unknown until the next turn
  loadingModels: Set<string>;
  servers: UiServer[];
  activeServerId: string;
  activeFile: { path: string; chars: number } | null;
  includeActiveFile: boolean;
  activeSelection: { path: string; startLine: number; endLine: number; chars: number } | null;
  activeGoal: UiGoal | null;
}
const persisted =
  (vscode.getState() as {
    thinking?: boolean; // legacy (pre-effort) — migrated below
    showReasoning?: boolean;
    effortByModel?: Record<string, EffortLevel>;
    includeActiveFile?: boolean;
  }) ?? {};
const state: State = {
  models: [],
  currentModel: null,
  agent: 'build',
  agents: [],
  sessions: [],
  currentSessionID: null,
  busy: false,
  serverReady: false,
  lmStudioConnected: false,
  lmStudioAuthRequired: false,
  effortByModel: persisted.effortByModel ?? {},
  defaultEffort: 'auto',
  permissionMode: 'default',
  // Migrate the old single boolean: it drove display as well as generation, so
  // an existing "thinking off" user keeps reasoning hidden.
  showReasoning: persisted.showReasoning ?? persisted.thinking ?? true,
  pendingImages: [],
  minContext: 32768,
  realTokens: 0,
  compacted: false,
  compacting: false,
  pendingCompaction: false,
  loadingModels: new Set<string>(),
  servers: [],
  activeServerId: '',
  activeFile: null,
  includeActiveFile: persisted.includeActiveFile ?? true,
  activeSelection: null,
  activeGoal: null,
};

// Live rendering bookkeeping (keyed by ids so events and history both upsert).
const messageEls = new Map<string, { el: HTMLElement; partsEl: HTMLElement; role: string }>();
const partState = new Map<string, { el: HTMLElement; buffer: string; type: string }>();
const roleByMessage = new Map<string, string>();
const permissionEls = new Map<string, HTMLElement>();
const questionEls = new Map<string, HTMLElement>();
const toolCollapsed = new Map<string, boolean>(); // partID -> collapsed?
// The agent's todowrite tool is rendered as ONE live checklist per assistant
// message (it calls todowrite repeatedly, replacing the whole list). Keyed by
// messageID so repeated calls update one card in place instead of stacking.
const todoCards = new Map<string, HTMLElement>(); // messageID -> checklist card el
const todoCollapsed = new Map<string, boolean>(); // messageID -> user-forced collapse (unset = auto)
let lastErrorText = ''; // dedup repeated error bubbles within a turn
let turnTruncated = false; // the current turn hit its output-token budget (finish reason 'length')
let closeMenuOnLoad = false; // user hit Load from the menu — close it once the load returns
// Generation-speed tracking. Accounting lives in ../core/genrate (pure + tested):
// it counts only the time the model was actually streaming — tool calls and step
// boundaries are excluded — and prefers the exact token usage OpenCode reports on
// the assistant message over the chars/4 estimate used mid-stream.
let turnRate: TurnRate = newTurnRate();
// Compaction bookkeeping. OpenCode's summarize ("/compact") writes a user
// message with a `compaction` part, then streams the summarizer model's own
// reasoning + the summary template as an ordinary assistant turn. Neither is a
// real chat turn, so we collapse the marker to a chip and suppress that turn.
// Decision logic lives in ../core/compaction (pure + unit-tested).
const compaction: CompactionState = newCompactionState();
let lastCompactionChip: HTMLElement | null = null; // so the summary can be attached when it arrives

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const icon = {
  plus: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8.5 2.5v5h5v1h-5v5h-1v-5h-5v-1h5v-5z"/></svg>`,
  history: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5h-1A5.5 5.5 0 1 1 8 2.5V1.5zM7.5 4v4.2l3.1 1.8.5-.86L8.5 7.7V4z"/><path fill="currentColor" d="M8 1.5 5.4 3.2 8 4.9z"/></svg>`,
  window: `<svg viewBox="0 0 16 16" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M2.6 3.5h10.8a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path fill="currentColor" d="M1.6 5.4h12.8v1H1.6z"/></svg>`,
  target: `<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1" fill="currentColor"/></svg>`,
  dots: `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="13" cy="8" r="1.4" fill="currentColor"/></svg>`,
  pencil: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M11.5 1.6a1.4 1.4 0 0 1 2 0l.9.9a1.4 1.4 0 0 1 0 2l-8.2 8.2-3.5 1 1-3.5zM10.6 3.9l1.5 1.5 1.2-1.2-1.5-1.5z"/></svg>`,
  pause: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4.5 2.8h2.4v10.4H4.5zM9.1 2.8h2.4v10.4H9.1z"/></svg>`,
  play: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4.5 2.5 13 8l-8.5 5.5z"/></svg>`,
  send: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M1.7 14.3 15 8 1.7 1.7l-.2 4.8L10 8l-8.5 1.5z"/></svg>`,
  stop: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>`,
  trash: `<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M6 1.5h4l.5 1H14v1H2v-1h3.5zM3.5 4.5h9l-.7 9.2a1 1 0 0 1-1 .8H5.2a1 1 0 0 1-1-.8z"/></svg>`,
  close: `<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" fill-rule="evenodd" d="M2.84 2a1.273 1.273 0 100 2.547h14.107a1.273 1.273 0 100-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H22.04a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h14.106a1.274 1.274 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H15.38a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h14.106a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h9.698a1.273 1.273 0 100-2.547h-9.698z"/></svg>`,
  sparkLarge: `<svg viewBox="0 0 24 24" width="44" height="44"><path fill="currentColor" fill-rule="evenodd" d="M2.84 2a1.273 1.273 0 100 2.547h14.107a1.273 1.273 0 100-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H22.04a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h14.106a1.274 1.274 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H15.38a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h14.106a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h9.698a1.273 1.273 0 100-2.547h-9.698z"/></svg>`,
  file: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 4 14zM9 2v3h3z"/></svg>`,
  tool: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M11.5 1.5a3.5 3.5 0 0 0-3.4 4.4L1.7 12.3l1.9 1.9 6.4-6.4A3.5 3.5 0 1 0 11.5 1.5z"/></svg>`,
  brain: `<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M6 1.6a2.1 2.1 0 0 0-2 1.5 2 2 0 0 0-1.3 3.2A2.1 2.1 0 0 0 3.6 10c.1 1 1 1.9 2.1 1.9.3 0 .3.1.3.4v1.7h1V3.8c0-.5.1-.7.4-1a2.1 2.1 0 0 0-1.4-1.2zm4 0a2.1 2.1 0 0 1 2 1.5 2 2 0 0 1 1.3 3.2A2.1 2.1 0 0 1 12.4 10c-.1 1-1 1.9-2.1 1.9-.3 0-.3.1-.3.4v1.7H9V3.8c0-.5-.1-.7-.4-1A2.1 2.1 0 0 1 10 1.6z"/></svg>`,
  paperclip: `<svg viewBox="0 0 16 16" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M11.5 6.5 6.8 11.2a2 2 0 0 1-2.8-2.8l5-5a3 3 0 0 1 4.2 4.2l-5.1 5.1a4 4 0 0 1-5.6-5.6l4.8-4.8"/></svg>`,
  refresh: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M13.65 3.85A6 6 0 1 0 14 8h-1.5a4.5 4.5 0 1 1-1.2-3.35L9 6.5h5V1.5z"/></svg>`,
  caret: `<svg viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M4 6l4 4 4-4z"/></svg>`,
  shield: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M8 1.8l5 2.1v3.6c0 3.2-2.1 5.7-5 7.1-2.9-1.4-5-3.9-5-7.1V3.9z"/></svg>`,
  check: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M2.8 8.4l3.3 3.3 7-7"/></svg>`,
  zap: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M9.5 1 3 9h3.5L6 15l6.5-8H9z"/></svg>`,
  lock: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M5 7V4.8a3 3 0 0 1 6 0V7"/><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="currentColor"/></svg>`,
  unlock: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M11 7V4.8a3 3 0 0 0-5.9-.7"/><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="currentColor"/></svg>`,
  checklist: `<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M2 3h2v2H2zM6 3.5h8v1H6zM2 7h2v2H2zM6 7.5h8v1H6zM2 11h2v2H2zM6 11.5h8v1H6z"/></svg>`,
  // Flat monochrome capability glyphs for the model list (currentColor, no fill colors).
  eye: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>`,
  wrench: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M11.5 1.5a3.5 3.5 0 0 0-3.4 4.4L1.7 12.3l1.9 1.9 6.4-6.4A3.5 3.5 0 1 0 11.5 1.5z"/></svg>`,
  spinner: `<svg viewBox="0 0 16 16" width="13" height="13" class="spin" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M8 1.6a6.4 6.4 0 1 1-6.2 4.8" /></svg>`,
};

// ---------------------------------------------------------------------------
// DOM scaffolding
// ---------------------------------------------------------------------------
// Stick-to-bottom autoscroll. While `autoScrollEnabled` is true, streamed
// content keeps the view pinned to the bottom; once the user scrolls up past
// the threshold it turns off so they can read back mid-generation.
const STICK_TO_BOTTOM_THRESHOLD = 120; // px from the bottom that still counts as "at bottom"
let autoScrollEnabled = true;
let messagesEl!: HTMLElement;
let welcomeEl!: HTMLElement;
let inputEl!: HTMLTextAreaElement;
let slashMenuEl!: HTMLElement;
let sendBtn!: HTMLButtonElement;
let modelBtn!: HTMLButtonElement;
let modelMenu!: HTMLElement;
let modelMenuList!: HTMLElement;
let serverMenuList!: HTMLElement;
let connBanner!: HTMLElement;
let attachmentsEl!: HTMLElement;
let goalBarEl!: HTMLElement;
let goalTextEl!: HTMLElement;
let goalMetaEl!: HTMLElement;
let goalPauseBtn!: HTMLButtonElement;
let goalTicker: ReturnType<typeof setInterval> | undefined;
let behaviorBtn!: HTMLButtonElement;
let behaviorMenu!: HTMLElement;
let behaviorBtnLabel!: HTMLElement;
let behaviorBtnIco!: HTMLElement;
let agentChips!: HTMLElement;
let permMenuList!: HTMLElement;
let addBtn!: HTMLButtonElement;
let addMenu!: HTMLElement;
let historyOverlay!: HTMLElement;
let historyList!: HTMLElement;
let thumbsEl!: HTMLElement;
let fileInput!: HTMLInputElement;
let ctxMeterEl!: HTMLElement;
let ctxFillEl!: HTMLElement;
let ctxLabelEl!: HTMLElement;
// Merged activity strip (#activity): while a turn runs it carries the working
// label + elapsed/tok-s ticker; transient notices (steering ack, goal progress,
// connection warnings) take the same line over. One strip, never a stack.
let activityEl!: HTMLElement;
let activitySpinner!: HTMLElement;
let activityLabelEl!: HTMLElement;
let activityExtraEl!: HTMLElement;
let activityStatus = ''; // transient notice text ('' = none)
let activityKind: 'info' | 'warn' | 'error' | '' = '';
let workingActive = false;
let workingLabel = '';
let workingStart = 0;
let workingTimer: ReturnType<typeof setInterval> | undefined;

function build(): void {
  const app = document.getElementById('app')!;
  // Injected into <body data-version> by the host, so it is available before
  // the first message arrives and needs no protocol field.
  const appVersion = document.body.dataset.version ?? '';
  app.innerHTML = `
    <div class="titlebar">
      <span class="ver-chip" title="LM Studio Code extension version">${appVersion ? `v${appVersion}` : ''}</span>
      <div id="titlebar-actions" class="titlebar-actions">
        <button id="ta-new" class="ta-btn" title="New chat">${icon.plus}</button>
        <button id="ta-history" class="ta-btn" title="Session history">${icon.history}</button>
        <button id="ta-tab" class="ta-btn" title="Open chat in editor tab">${icon.window}</button>
      </div>
    </div>
    <div id="conn-banner" class="conn-banner hidden"></div>
    <div id="messages" class="messages">
      <div id="welcome" class="welcome">
        <div class="welcome-logo">${icon.sparkLarge}</div>
        <div class="welcome-title">LM Studio Code${appVersion ? ` <span class="welcome-ver">v${appVersion}</span>` : ''}</div>
        <div class="welcome-sub">Local agentic coding, powered by OpenCode.</div>
        <div class="welcome-hint">Pick a model below and describe a task.</div>
      </div>
    </div>
    <div id="activity" class="activity">
      <span class="spinner hidden"></span>
      <span class="activity-label"></span>
      <span class="activity-extra"></span>
    </div>
    <div class="composer">
      <div id="goal-bar" class="goal-bar hidden">
        <span class="goal-ico">${icon.target}</span>
        <span class="goal-label">Pursuing goal</span>
        <span id="goal-text" class="goal-text"></span>
        <span id="goal-meta" class="goal-meta"></span>
        <span class="goal-actions">
          <button id="goal-edit" class="goal-btn" title="Edit goal">${icon.pencil}</button>
          <button id="goal-pause" class="goal-btn" title="Pause goal">${icon.pause}</button>
          <button id="goal-clear" class="goal-btn" title="Clear goal">${icon.trash}</button>
        </span>
      </div>
      <div class="composer-box">
        <div id="ctx-meter" class="ctx-edge" title="Context window usage"><div class="ctx-fill"></div></div>
        <span class="ctx-label" id="ctx-tip"></span>
        <div id="slash-menu" class="slash-menu hidden"></div>
        <div id="attachments" class="attachments hidden">
          <div id="thumbs" class="thumbs"></div>
        </div>
        <textarea id="input" rows="1" placeholder="Ask anything, paste an image, or describe a task…"></textarea>
        <div class="composer-row">
          <div class="composer-tools">
            <button id="btn-add" class="tool-pill icon-only" title="Add context — attach an image, include the open file">${icon.plus}</button>
          </div>
          <div class="composer-right">
            <button id="model-btn" class="model-btn" title="Model &amp; server — switch, load / eject">
              <span class="model-dot"></span>
              <span class="model-btn-label">Model</span>
              <span class="caret">${icon.caret}</span>
            </button>
            <button id="behavior-btn" class="model-btn behavior-btn" title="Permissions · agent · thinking">
              <span class="behavior-ico" id="behavior-btn-ico">${icon.zap}</span>
              <span class="model-btn-label" id="behavior-btn-label">Ask risky</span>
              <span class="caret">${icon.caret}</span>
            </button>
            <button id="send" class="send-btn" title="Send">${icon.send}</button>
          </div>
        </div>
      </div>
      <input id="file-input" type="file" accept="image/*" multiple hidden />
    </div>
    <div id="model-menu" class="model-menu hidden">
      <div class="model-menu-head"><span>Server</span></div>
      <div id="server-menu-list" class="model-menu-list server-section"></div>
      <button class="menu-row menu-add-row" id="server-add-toggle">${icon.plus}<span>Add server…</span></button>
      <div class="server-add hidden" id="server-add-form">
        <input id="server-add-name" class="server-input" placeholder="Name (e.g. Workstation)" />
        <input id="server-add-url" class="server-input" placeholder="http://192.168.1.50:1234" />
        <input id="server-add-key" class="server-input" type="password" autocomplete="off" placeholder="API key (optional, for auth proxies)" />
        <button id="server-add-btn" class="model-action load">Add server</button>
      </div>
      <div class="model-menu-head">
        <span id="models-head-label">Models</span>
        <button id="model-refresh" class="icon-btn" title="Rescan models">${icon.refresh}</button>
      </div>
      <div id="model-menu-list" class="model-menu-list"></div>
    </div>
    <div id="behavior-menu" class="model-menu hidden">
      <div class="menu-inline">
        <span class="menu-inline-label">Agent</span>
        <div id="agent-chips" class="ctx-presets"></div>
      </div>
      <div class="menu-sep"></div>
      <div id="perm-menu-list" class="model-menu-list"></div>
      <div class="menu-sep"></div>
      <div id="effort-foot">
        <div class="menu-inline">
          <span class="menu-inline-label" id="effort-label">Thinking</span>
          <div id="effort-presets" class="effort-dots"></div>
        </div>
        <span class="effort-note" id="effort-note"></span>
        <button class="menu-row" id="toggle-reasoning"><span>Show reasoning</span><span class="menu-check">${icon.check}</span></button>
        <div class="menu-sep"></div>
      </div>
      <button class="menu-row" id="menu-goal">${icon.target}<span>Pursue a goal…</span></button>
    </div>
    <div id="add-menu" class="model-menu hidden">
      <button class="menu-row" id="menu-attach">${icon.paperclip}<span>Attach image…</span></button>
      <button class="menu-row hidden" id="menu-ctxfile">${icon.file}<span class="menu-row-text"><span id="menu-ctxfile-name">Include open file</span><span class="menu-row-meta" id="menu-ctxfile-meta"></span></span><span class="menu-check">${icon.check}</span></button>
      <div class="menu-row info hidden" id="menu-ctxsel">${icon.file}<span class="menu-row-text"><span>Selection attached</span><span class="menu-row-meta" id="menu-ctxsel-meta"></span></span></div>
    </div>
    <div id="server-edit-overlay" class="overlay hidden">
      <div class="overlay-card">
        <div class="overlay-head">
          <span>Edit server</span>
          <div class="overlay-head-actions">
            <button id="server-edit-close" class="icon-btn">${icon.close}</button>
          </div>
        </div>
        <div class="server-edit-form">
          <label class="server-edit-label" for="server-edit-name">Name</label>
          <input id="server-edit-name" class="server-input" />
          <label class="server-edit-label" for="server-edit-url">URL</label>
          <input id="server-edit-url" class="server-input" />
          <label class="server-edit-label" for="server-edit-key">API key</label>
          <input id="server-edit-key" class="server-input" type="password" autocomplete="off" />
          <label id="server-edit-remove-row" class="server-edit-check hidden">
            <input id="server-edit-remove-key" type="checkbox" /> Remove the stored key
          </label>
          <div class="server-edit-actions">
            <button id="server-edit-save" class="model-action load">Save</button>
            <button id="server-edit-cancel" class="clear-all-btn">Cancel</button>
          </div>
        </div>
      </div>
    </div>
    <div id="history-overlay" class="overlay hidden">
      <div class="overlay-card">
        <div class="overlay-head">
          <span>Session history</span>
          <div class="overlay-head-actions">
            <button id="history-clear" class="clear-all-btn">Clear all</button>
            <button id="history-close" class="icon-btn">${icon.close}</button>
          </div>
        </div>
        <div id="history-list" class="history-list"></div>
      </div>
    </div>
  `;

  messagesEl = document.getElementById('messages')!;
  // Stick-to-bottom: stop forcing the view down once the user scrolls up to
  // read back, and re-engage when they return near the bottom. Without this,
  // every streamed token would yank the scroll position to the bottom.
  messagesEl.addEventListener('scroll', () => {
    const distanceFromBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    autoScrollEnabled = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD;
  });
  welcomeEl = document.getElementById('welcome')!;
  inputEl = document.getElementById('input') as HTMLTextAreaElement;
  slashMenuEl = document.getElementById('slash-menu')!;
  sendBtn = document.getElementById('send') as HTMLButtonElement;
  modelBtn = document.getElementById('model-btn') as HTMLButtonElement;
  modelMenu = document.getElementById('model-menu')!;
  modelMenuList = document.getElementById('model-menu-list')!;
  serverMenuList = document.getElementById('server-menu-list')!;
  connBanner = document.getElementById('conn-banner')!;
  attachmentsEl = document.getElementById('attachments')!;
  goalBarEl = document.getElementById('goal-bar')!;
  goalTextEl = document.getElementById('goal-text')!;
  goalMetaEl = document.getElementById('goal-meta')!;
  goalPauseBtn = document.getElementById('goal-pause') as HTMLButtonElement;

  // Goal bar controls + the behavior-menu Goal entry.
  document.getElementById('menu-goal')!.addEventListener('click', () => {
    closeBehaviorMenu();
    prefillGoalInput(state.activeGoal?.objective ?? '');
  });
  document.getElementById('goal-edit')!.addEventListener('click', () => {
    prefillGoalInput(state.activeGoal?.objective ?? '');
  });
  goalPauseBtn.addEventListener('click', () => {
    if (!state.activeGoal) {
      return;
    }
    post({ type: state.activeGoal.state === 'paused' ? 'resumeGoal' : 'pauseGoal' });
  });
  document.getElementById('goal-clear')!.addEventListener('click', () => post({ type: 'clearGoal' }));

  behaviorBtn = document.getElementById('behavior-btn') as HTMLButtonElement;
  behaviorMenu = document.getElementById('behavior-menu')!;
  behaviorBtnLabel = document.getElementById('behavior-btn-label')!;
  behaviorBtnIco = document.getElementById('behavior-btn-ico')!;
  agentChips = document.getElementById('agent-chips')!;
  permMenuList = document.getElementById('perm-menu-list')!;
  addBtn = document.getElementById('btn-add') as HTMLButtonElement;
  addMenu = document.getElementById('add-menu')!;
  historyOverlay = document.getElementById('history-overlay')!;
  historyList = document.getElementById('history-list')!;
  thumbsEl = document.getElementById('thumbs')!;
  fileInput = document.getElementById('file-input') as HTMLInputElement;
  ctxMeterEl = document.getElementById('ctx-meter')!;
  ctxFillEl = ctxMeterEl.querySelector('.ctx-fill') as HTMLElement;
  ctxLabelEl = document.getElementById('ctx-tip')!;
  activityEl = document.getElementById('activity')!;
  activitySpinner = activityEl.querySelector('.spinner') as HTMLElement;
  activityLabelEl = activityEl.querySelector('.activity-label') as HTMLElement;
  activityExtraEl = activityEl.querySelector('.activity-extra') as HTMLElement;

  // Floating top-right actions (mirror the old native title-bar buttons).
  document.getElementById('ta-new')!.addEventListener('click', () => post({ type: 'newChat' }));
  document.getElementById('ta-history')!.addEventListener('click', () => openHistory());
  document.getElementById('ta-tab')!.addEventListener('click', () => post({ type: 'openInTab' }));

  document.getElementById('history-close')!.addEventListener('click', closeHistory);
  const clearBtn = document.getElementById('history-clear') as HTMLButtonElement;
  let clearArmed = false;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  clearBtn.addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = 'Confirm clear all?';
      clearBtn.classList.add('armed');
      clearTimer = setTimeout(() => {
        clearArmed = false;
        clearBtn.textContent = 'Clear all';
        clearBtn.classList.remove('armed');
      }, 3000);
      return;
    }
    if (clearTimer) {
      clearTimeout(clearTimer);
    }
    clearArmed = false;
    clearBtn.textContent = 'Clear all';
    clearBtn.classList.remove('armed');
    post({ type: 'clearAllSessions' });
    closeHistory();
  });
  historyOverlay.addEventListener('click', (e) => {
    if (e.target === historyOverlay) {
      closeHistory();
    }
  });

  // The button is context-sensitive: while a turn runs it SHOWS a stop icon, so
  // clicking it always aborts — steering mid-turn is done with Enter instead.
  sendBtn.addEventListener('click', () => {
    if (state.busy) {
      post({ type: 'abort' });
      return;
    }
    onSend();
  });
  inputEl.addEventListener('keydown', (e) => {
    // While the slash-command menu is open it owns the arrow / tab / esc keys.
    if (slashMenuOpen()) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSlashSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSlashSelection(-1);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        acceptSlashCommand();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Runs while busy too: Enter with text STEERS the in-flight turn
      // (onSend handles it); Enter on an empty box does nothing.
      onSend();
    }
  });
  inputEl.addEventListener('input', () => {
    autoGrow();
    updateSlashMenu();
  });
  inputEl.addEventListener('blur', () => closeSlashMenu());

  // "Show reasoning" toggle — the old alt-click axis, now a visible menu row.
  document.getElementById('toggle-reasoning')!.addEventListener('click', (e) => {
    e.stopPropagation();
    state.showReasoning = !state.showReasoning;
    persist();
    applyEffort();
  });
  applyEffort();

  // Add-context menu: attach image + active-file toggle (+ selection info row).
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(addMenu, addBtn, 260);
  });
  document.getElementById('menu-attach')!.addEventListener('click', () => {
    addMenu.classList.add('hidden');
    fileInput.click();
  });
  document.getElementById('menu-ctxfile')!.addEventListener('click', (e) => {
    e.stopPropagation();
    state.includeActiveFile = !state.includeActiveFile;
    persist();
    renderActiveFile();
    renderMeter();
  });

  // Behavior menu (permissions · agent · thinking).
  behaviorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(behaviorMenu, behaviorBtn, 300);
  });

  // Image paste / drop
  fileInput.addEventListener('change', () => {
    if (fileInput.files) {
      for (const f of Array.from(fileInput.files)) {
        void addImage(f);
      }
    }
    fileInput.value = '';
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          void addImage(f);
        }
      }
    }
  });
  const composer = document.querySelector('.composer')!;
  composer.addEventListener('dragover', (e) => {
    e.preventDefault();
    composer.classList.add('dragover');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('dragover'));
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('dragover');
    const files = (e as DragEvent).dataTransfer?.files;
    if (files) {
      for (const f of Array.from(files)) {
        if (f.type.startsWith('image/')) {
          void addImage(f);
        }
      }
    }
  });

  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelMenu();
  });
  document.getElementById('model-refresh')!.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'refreshModels' });
  });
  // "Add server…" expands the inline form inside the combined menu.
  document.getElementById('server-add-toggle')!.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('server-add-form')!.classList.toggle('hidden');
  });
  document.getElementById('server-add-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const nameEl = document.getElementById('server-add-name') as HTMLInputElement;
    const urlEl = document.getElementById('server-add-url') as HTMLInputElement;
    const keyEl = document.getElementById('server-add-key') as HTMLInputElement;
    if (urlEl.value.trim()) {
      post({ type: 'addServer', name: nameEl.value, url: urlEl.value, apiKey: keyEl.value.trim() || undefined });
      nameEl.value = '';
      urlEl.value = '';
      keyEl.value = '';
    }
  });
  document.getElementById('server-edit-close')!.addEventListener('click', closeServerEdit);
  document.getElementById('server-edit-cancel')!.addEventListener('click', closeServerEdit);
  document.getElementById('server-edit-save')!.addEventListener('click', saveServerEdit);
  // "Remove key" wins over a typed replacement — make that visible by
  // disabling (and clearing) the key field while it's checked.
  document.getElementById('server-edit-remove-key')!.addEventListener('change', (e) => {
    const remove = (e.target as HTMLInputElement).checked;
    const keyEl = document.getElementById('server-edit-key') as HTMLInputElement;
    keyEl.disabled = remove;
    if (remove) {
      keyEl.value = '';
    }
  });
  document.getElementById('server-edit-overlay')!.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeServerEdit();
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (!modelMenu.classList.contains('hidden') && !modelMenu.contains(t) && !modelBtn.contains(t)) {
      closeModelMenu();
    }
    if (
      !behaviorMenu.classList.contains('hidden') &&
      !behaviorMenu.contains(t) &&
      !behaviorBtn.contains(t)
    ) {
      closeBehaviorMenu();
    }
    if (!addMenu.classList.contains('hidden') && !addMenu.contains(t) && !addBtn.contains(t)) {
      addMenu.classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('lightbox')) {
        closeLightbox();
        return;
      }
      closeModelMenu();
      closeBehaviorMenu();
      addMenu.classList.add('hidden');
    }
  });
  renderAgents();
  renderPermissionMode();
}

/**
 * Anchor a popup menu above its button, opening upward (shared by the add,
 * model and behavior menus). Toggles visibility.
 */
function toggleMenu(menu: HTMLElement, btn: HTMLElement, maxWidth: number): void {
  if (!menu.classList.contains('hidden')) {
    menu.classList.add('hidden');
    return;
  }
  menu.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const width = Math.min(maxWidth, window.innerWidth - 16);
  let left = r.left;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.width = width + 'px';
  menu.style.bottom = window.innerHeight - r.top + 6 + 'px';
}

function closeBehaviorMenu(): void {
  behaviorMenu.classList.add('hidden');
}

/** The three permission modes: menu rows (Claude-Code-style icon + name +
 * description) and the composer chip's identity. */
const PERM_MODES: Array<{
  value: PermissionMode;
  label: string;
  chip: string;
  ico: 'zap' | 'lock' | 'unlock';
  meta: string;
}> = [
  { value: 'default', label: 'Ask: risky only', chip: 'Ask risky', ico: 'zap', meta: 'auto-approves safe actions, asks for risky ones' },
  { value: 'strict', label: 'Ask: always', chip: 'Ask always', ico: 'lock', meta: 'asks before every tool call' },
  { value: 'bypass', label: 'Bypass all', chip: 'Bypass', ico: 'unlock', meta: 'runs everything without asking' },
];

/**
 * Reflect the host-owned permission mode: check the matching row in the
 * behavior menu, and put the mode on the composer chip itself — the most
 * important state rides the chip, and bypass is never invisible.
 */
function renderPermissionMode(): void {
  state.permissionMode = state.permissionMode ?? 'default';
  const mode = state.permissionMode;
  permMenuList.innerHTML = '';
  for (const rowDef of PERM_MODES) {
    const row = document.createElement('div');
    row.className =
      'model-row menu-pick perm-row' +
      (rowDef.value === mode ? ' active' : '') +
      (rowDef.value === 'bypass' ? ' warnrow' : '');
    row.dataset.mode = rowDef.value;
    row.innerHTML = `
      <span class="perm-ico">${icon[rowDef.ico]}</span>
      <span class="model-info">
        <span class="model-name">${rowDef.label}</span>
        <span class="model-meta${rowDef.value === 'bypass' ? ' warntext' : ''}">${rowDef.meta}</span>
      </span>
      ${rowDef.value === mode ? `<span class="menu-check">${icon.check}</span>` : ''}`;
    row.addEventListener('click', () => {
      if (rowDef.value !== state.permissionMode) {
        state.permissionMode = rowDef.value;
        // The host persists the setting and acks with 'permissionMode' (the chip
        // renders on the ack, so settings.json edits get the same feedback).
        post({ type: 'setPermissionMode', mode: rowDef.value });
        renderPermissionMode();
      }
    });
    permMenuList.appendChild(row);
  }
  renderBehaviorLabel();
}

function permissionModeChip(mode: PermissionMode): string {
  const label = `Permissions: ${permissionModeLabel(mode)}`;
  if (mode === 'bypass') {
    return `🔓 ${label} — every tool call is auto-approved, including shell commands. Applies from the next message (the agent server restarts).`;
  }
  if (mode === 'strict') {
    return `🔒 ${label} — every tool call needs your approval. Applies from the next message (the agent server restarts).`;
  }
  return `${label} — only risky actions (outside the workspace, .env files) need approval. Applies from the next message (the agent server restarts).`;
}

function autoGrow(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
interface SlashCommand {
  name: string;
  hint: string;
  /** Local UI commands run a callback (given any trailing args the user typed);
   * server commands carry their kind in `server` instead. */
  run?: (args?: string) => void;
  /** Set for server-provided commands/skills (invoked via runCommand). */
  server?: { command: string; source: 'command' | 'skill'; takesArgs: boolean };
}

// Built-in UI commands (handled entirely in the webview/host, not the model).
const LOCAL_COMMANDS: SlashCommand[] = [
  { name: '/clear', hint: 'Clear the conversation and start fresh', run: clearChatCommand },
  { name: '/compact', hint: 'Summarize the conversation to free up context', run: compactCommand },
  { name: '/file', hint: 'Toggle including the open file as context', run: toggleFileCommand },
  { name: '/mcp', hint: 'Show connected MCP servers and their status', run: mcpCommand },
  { name: '/skills', hint: 'Show the skills available to the model', run: skillsCommand },
  { name: '/agents', hint: 'Show agents — yours to pick, and ones the model can delegate to; /agents new <name>', run: agentsCommand },
  { name: '/goal', hint: 'Pursue a goal until it is met — /goal <objective>, /goal clear', run: goalCommand },
  { name: '/effort', hint: 'Set reasoning effort for this model — /effort auto|off|low|med|high', run: effortCommand },
  { name: '/help', hint: 'List the available slash commands', run: helpCommand },
];

// Server-provided commands + skills (from GET /command), populated on connect.
let serverCommands: SlashCommand[] = [];

// The full slash list: local UI commands first, then server commands/skills,
// de-duplicated by name (a local command wins over a server one of the same
// name, e.g. our /compact).
function allCommands(): SlashCommand[] {
  // Merge + dedupe is pure — see core/commands. A local command of the same
  // name wins over a server one.
  return mergeSlashCommands(LOCAL_COMMANDS, serverCommands);
}

function setServerCommands(cmds: UiCommand[]): void {
  serverCommands = cmds.map((c) => ({
    name: '/' + c.name,
    hint: c.description || (c.source === 'skill' ? 'Skill' : 'Command'),
    server: { command: c.name, source: c.source, takesArgs: c.takesArgs },
  }));
}

function clearChatCommand(): void {
  post({ type: 'clearAllSessions' });
}

function compactCommand(): void {
  post({ type: 'compact' });
}

/**
 * `/effort <level>` — set reasoning depth for the current model. With no
 * argument it reports what's in effect and what this model actually supports,
 * which matters because most local models collapse every "on" level into one.
 */
function effortCommand(args?: string): void {
  const reasoning = currentReasoning();
  const levels = levelsForModel(reasoning);
  if (levels.length === 0) {
    addSysChip('This model reports no reasoning support, so effort has no effect.');
    return;
  }
  const arg = (args ?? '').trim().toLowerCase();
  if (!arg) {
    addSysChip(
      `Reasoning effort: ${levelLabel(currentEffort(), reasoning)}. ` +
        `Available for this model: ${levels.map((l) => levelLabel(l, reasoning)).join(', ')}.`,
    );
    return;
  }
  // Accept the shorthand the hint advertises, plus "on" for binary models.
  const alias: Record<string, EffortLevel> = { med: 'medium', on: 'high', none: 'off' };
  const wanted = (alias[arg] ?? arg) as EffortLevel;
  if (!levels.includes(wanted)) {
    addSysChip(
      `"${arg}" isn't available for this model. Try: ${levels
        .map((l) => levelLabel(l, reasoning))
        .join(', ')}.`,
    );
    return;
  }
  setEffort(wanted);
  addSysChip(`Reasoning effort set to ${levelLabel(wanted, reasoning)} for this model.`);
}

function toggleFileCommand(): void {
  if (!state.activeFile) {
    addSysChip('No open file to include as context.');
    return;
  }
  state.includeActiveFile = !state.includeActiveFile;
  persist();
  renderActiveFile();
  renderMeter();
  addSysChip(`Open file ${state.includeActiveFile ? 'included in' : 'excluded from'} context.`);
}

// Request the live MCP server status from the host. The result arrives as an
// `mcpStatus` message and is rendered by showMcpStatus() into a status chip.
function mcpCommand(): void {
  addSysChip('Checking MCP servers…');
  post({ type: 'requestMcpStatus' });
}

// Request the discovered skills from the host (GET /skill). Rendered by
// showSkills() so the user can confirm their project/global skills are found.
/**
 * `/agents` lists both halves of the roster; `/agents new <name>` scaffolds a
 * definition on disk and opens it.
 */
function agentsCommand(args?: string): void {
  const a = (args ?? '').trim();
  const m = /^(?:new|add|create)\s+(.+)$/i.exec(a);
  if (m) {
    post({ type: 'createAgent', name: m[1].trim() });
    return;
  }
  if (a) {
    addSysChip(`Unknown /agents argument "${a}". Use /agents or /agents new <name>.`);
    return;
  }
  addSysChip('Checking agents…');
  post({ type: 'requestAgents' });
}

function showAgents(pickable: UiAgent[], delegatable: UiAgent[]): void {
  const el = document.createElement('div');
  el.className = 'sys-chip mcp-panel';
  const row = (a: UiAgent, dot: string, badge: string) => {
    const desc = a.description ? `<div class="skill-desc">${escapeHtml(a.description)}</div>` : '';
    const model = a.modelID
      ? `<div class="skill-path">always runs on ${escapeHtml(a.modelID)}</div>`
      : '';
    const custom = a.native === false ? '<span class="mcp-transport">custom</span>' : '';
    return (
      `<div class="mcp-row"><span class="mcp-dot ${dot}"></span><div class="mcp-row-body">` +
      `<div class="mcp-row-top"><span class="mcp-name">${escapeHtml(a.name)}</span>${custom}` +
      `<span class="mcp-status-label ${dot}">${badge}</span></div>${desc}${model}` +
      `</div></div>`
    );
  };
  // Two sections because they are genuinely different audiences: you drive the
  // first, the model reaches the second on its own.
  const picked = pickable.map((a) => row(a, 'ok', 'you pick')).join('');
  const deleg = delegatable.map((a) => row(a, 'pending', 'model delegates')).join('');
  el.innerHTML =
    '<div class="mcp-head">Agents you can select</div>' +
    (picked || '<div class="mcp-empty">None.</div>') +
    '<div class="mcp-head">Agents the model can delegate to</div>' +
    (deleg ||
      '<div class="mcp-empty">None. These are reached through the built-in task tool, not the picker.</div>') +
    '<div class="mcp-empty">Define one as <code>.opencode/agent/&lt;name&gt;.md</code> with YAML frontmatter ' +
    '(<code>description</code>, <code>mode</code>, optional <code>model</code>/<code>tools</code>) and the body as its prompt — ' +
    'or run <code>/agents new &lt;name&gt;</code>. The <code>description</code> is what the model reads when deciding to delegate. ' +
    'New agents load when the OpenCode server restarts.</div>';
  messagesEl.appendChild(el);
  toggleWelcome();
  forceScrollToBottom();
}

function skillsCommand(): void {
  addSysChip('Checking skills…');
  post({ type: 'requestSkills' });
}

// /goal <objective> starts an autonomous goal loop; /goal clear ends it; bare
// /goal prefills the input so the user can type the objective.
function goalCommand(args?: string): void {
  const a = (args ?? '').trim();
  if (!a) {
    prefillGoalInput(state.activeGoal?.objective ?? '');
    return;
  }
  if (a.toLowerCase() === 'clear' || a.toLowerCase() === 'stop') {
    post({ type: 'clearGoal' });
    addSysChip('Goal cleared.');
    return;
  }
  post({ type: 'setGoal', objective: a });
}

// Put "/goal <current-or-empty>" in the composer so the user can type/edit the
// objective and press Enter — the same pattern as arg-taking server commands.
function prefillGoalInput(existing: string): void {
  inputEl.value = existing ? `/goal ${existing}` : '/goal ';
  inputEl.focus();
  autoGrow();
}

// Render the discovered skills as an inline panel — one row per skill with its
// name, a source tag (project / global / built-in), a 'slash' badge when it can
// be invoked as a command, and its description. Reuses the /mcp panel styling.
function showSkills(skills: UiSkill[]): void {
  const el = document.createElement('div');
  el.className = 'sys-chip mcp-panel';

  if (!skills.length) {
    el.innerHTML =
      '<div class="mcp-head">Skills</div>' +
      '<div class="mcp-empty">No skills found. Add one as <code>.opencode/skill/&lt;name&gt;/SKILL.md</code> ' +
      'or <code>.claude/skills/&lt;name&gt;/SKILL.md</code> in your workspace (or <code>~/.claude/skills/</code> globally). ' +
      'The model invokes a skill automatically when your request matches its description.</div>';
    messagesEl.appendChild(el);
    toggleWelcome();
    forceScrollToBottom();
    return;
  }

  const sourceClass = (src: string) => (src === 'project' ? 'ok' : src === 'global' ? 'pending' : 'off');
  const rows = skills
    .map((s) => {
      const dot = sourceClass(s.source);
      const slash = s.slash ? `<span class="mcp-transport">/${escapeHtml(s.name)}</span>` : '';
      const desc = s.description ? `<div class="skill-desc">${escapeHtml(s.description)}</div>` : '';
      const where = s.path ? `<div class="skill-path">${escapeHtml(s.path)}</div>` : '';
      return (
        `<div class="mcp-row">` +
        `<span class="mcp-dot ${dot}"></span>` +
        `<div class="mcp-row-body">` +
        `<div class="mcp-row-top"><span class="mcp-name">${escapeHtml(s.name)}</span>${slash}` +
        `<span class="mcp-status-label ${dot}">${escapeHtml(s.source)}</span></div>` +
        desc +
        where +
        `</div></div>`
      );
    })
    .join('');

  el.innerHTML =
    `<div class="mcp-head">Skills <span class="mcp-count">${skills.length} available</span></div>` +
    `<div class="mcp-list">${rows}</div>`;
  messagesEl.appendChild(el);
  toggleWelcome();
  forceScrollToBottom();
}

function helpCommand(): void {
  const lines = allCommands()
    .map((c) => `${c.name} — ${c.hint}${c.server?.source === 'skill' ? ' (skill)' : ''}`)
    .join('\n');
  addSysChip(`Slash commands:\n${lines}`);
}

// Render the MCP server status as an inline panel in the message stream — one
// row per server with a colored status dot, transport label, and (for failures)
// the error reason. Mirrors how Claude Code's /mcp prints into the conversation.
function showMcpStatus(servers: UiMcpServer[]): void {
  const el = document.createElement('div');
  el.className = 'sys-chip mcp-panel';

  if (!servers.length) {
    el.innerHTML =
      '<div class="mcp-head">MCP servers</div>' +
      '<div class="mcp-empty">No MCP servers configured. Add one in the <code>lmstudioCode.mcpServers</code> setting, ' +
      'or a <code>.mcp.json</code> / <code>.vscode/mcp.json</code> file in your workspace.</div>';
    messagesEl.appendChild(el);
    toggleWelcome();
    forceScrollToBottom();
    return;
  }

  const connected = servers.filter((s) => s.status === 'connected').length;
  const rows = servers
    .map((s) => {
      const dot = mcpStatusClass(s.status);
      const transport = s.transport
        ? `<span class="mcp-transport">${s.transport === 'remote' ? 'remote' : 'local'}</span>`
        : '';
      const detail = s.detail ? `<div class="mcp-detail">${escapeHtml(s.detail)}</div>` : '';
      const error =
        s.status === 'failed' && s.error
          ? `<div class="mcp-error">${escapeHtml(s.error)}</div>`
          : '';
      return (
        `<div class="mcp-row">` +
        `<span class="mcp-dot ${dot}"></span>` +
        `<div class="mcp-row-body">` +
        `<div class="mcp-row-top"><span class="mcp-name">${escapeHtml(s.name)}</span>${transport}` +
        `<span class="mcp-status-label ${dot}">${escapeHtml(s.status)}</span></div>` +
        detail +
        error +
        `</div></div>`
      );
    })
    .join('');

  el.innerHTML =
    `<div class="mcp-head">MCP servers <span class="mcp-count">${connected}/${servers.length} connected</span></div>` +
    `<div class="mcp-list">${rows}</div>`;
  messagesEl.appendChild(el);
  toggleWelcome();
  forceScrollToBottom();
}

// Map an MCP status string to the dot/label color class.
function mcpStatusClass(status: string): string {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'failed':
      return 'err';
    case 'disabled':
      return 'off';
    default:
      return 'pending';
  }
}

// Marks where the conversation was compacted. Rendered in place of the noisy
// summarizer turn; collapsed by default since the summary is internal context.
// The summary text arrives later (via the `compacting` done message) and gets
// attached, making the chip expandable.
function showCompactionChip(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sys-chip compaction-chip';
  const head = document.createElement('button');
  head.className = 'compaction-head';
  head.type = 'button';
  head.innerHTML =
    '<span class="compaction-chev"></span><span>⊘ Conversation compacted to free up context</span>';
  const body = document.createElement('div');
  body.className = 'compaction-body';
  el.appendChild(head);
  el.appendChild(body);
  // No summary yet → nothing to expand. attachCompactionSummary() flips this on.
  head.disabled = true;
  head.addEventListener('click', () => {
    if (head.disabled) {
      return;
    }
    el.classList.toggle('open');
  });
  messagesEl.appendChild(el);
  lastCompactionChip = el;
  toggleWelcome();
  scrollToBottom();
  return el;
}

// Attach the summary markdown OpenCode produced to the most recent chip, making
// it expandable. Called when the bridge reports the compaction finished.
function attachCompactionSummary(summary: string): void {
  const chip = lastCompactionChip;
  if (!chip || !summary.trim()) {
    return;
  }
  const head = chip.querySelector('.compaction-head') as HTMLButtonElement | null;
  const body = chip.querySelector('.compaction-body') as HTMLElement | null;
  if (!head || !body) {
    return;
  }
  body.innerHTML = mdToHtml(summary);
  head.disabled = false;
}

// A small inline note from the extension UI itself (not the model).
function addSysChip(text: string): void {
  const el = document.createElement('div');
  el.className = 'sys-chip';
  el.textContent = text;
  messagesEl.appendChild(el);
  toggleWelcome();
  forceScrollToBottom();
}

// --- Autocomplete menu ---
// Index of the highlighted row while the menu is open, or -1 when closed.
let slashActiveIndex = -1;

function slashMenuOpen(): boolean {
  return !slashMenuEl.classList.contains('hidden');
}

// Commands matching the current input. Only offered while the line is a bare
// `/token` (no spaces yet) — once the user moves past the command name we stop
// suggesting so normal prompts starting with "/" aren't hijacked.
function matchingCommands(): SlashCommand[] {
  return matchSlashPrefix(inputEl.value, allCommands());
}

function updateSlashMenu(): void {
  const matches = matchingCommands();
  if (!matches.length) {
    closeSlashMenu();
    return;
  }
  if (slashActiveIndex < 0 || slashActiveIndex >= matches.length) {
    slashActiveIndex = 0;
  }
  slashMenuEl.innerHTML = '';
  matches.forEach((cmd, i) => {
    const row = document.createElement('div');
    row.className = `slash-item${i === slashActiveIndex ? ' active' : ''}`;
    const badge = cmd.server?.source === 'skill' ? '<span class="slash-badge">skill</span>' : '';
    row.innerHTML =
      `<span class="slash-left"><span class="slash-name">${escapeHtml(cmd.name)}</span>${badge}</span>` +
      `<span class="slash-hint">${escapeHtml(cmd.hint)}</span>`;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the textarea
      acceptSlashCommand(cmd);
    });
    slashMenuEl.appendChild(row);
  });
  slashMenuEl.classList.remove('hidden');
}

function closeSlashMenu(): void {
  slashMenuEl.classList.add('hidden');
  slashMenuEl.innerHTML = '';
  slashActiveIndex = -1;
}

function moveSlashSelection(delta: number): void {
  const matches = matchingCommands();
  if (!matches.length) {
    return;
  }
  slashActiveIndex = (slashActiveIndex + delta + matches.length) % matches.length;
  updateSlashMenu();
}

// Execute a chosen command. Local UI commands run their callback; server
// commands/skills are sent to the host to run via OpenCode (with any args).
function executeCommand(cmd: SlashCommand, args = ''): void {
  if (cmd.server) {
    post({ type: 'runCommand', command: cmd.server.command, ...(args.trim() ? { arguments: args.trim() } : {}) });
  } else {
    cmd.run?.(args);
  }
}

// Run the highlighted (or given) command straight from the menu.
function acceptSlashCommand(cmd?: SlashCommand): void {
  const matches = matchingCommands();
  const chosen = cmd ?? matches[slashActiveIndex];
  closeSlashMenu();
  if (!chosen) {
    return;
  }
  // A server command that takes arguments: don't fire yet — fill the input so
  // the user can type the arguments, then press Enter.
  if (chosen.server?.takesArgs) {
    inputEl.value = chosen.name + ' ';
    inputEl.focus();
    autoGrow();
    return;
  }
  inputEl.value = '';
  autoGrow();
  executeCommand(chosen);
}

// Run a slash command if the input is one. Returns true when handled (so the
// caller should NOT send it to the model). An unknown /command is reported and
// also swallowed, so a typo never gets sent to the model verbatim.
function runSlashCommand(text: string): boolean {
  const parsed = parseSlashInput(text);
  if (!parsed) {
    return false;
  }
  const { name, args } = parsed;
  const cmd = allCommands().find((c) => c.name.toLowerCase() === name);
  if (cmd) {
    inputEl.value = '';
    autoGrow();
    executeCommand(cmd, args);
    return true;
  }
  addSysChip(`Unknown command "${name}". Type /help to see what's available.`);
  inputEl.value = '';
  autoGrow();
  return true;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function onSend(): void {
  if (state.compacting) {
    return; // input is blocked while a /compact runs
  }
  const text = inputEl.value.trim();
  if (state.busy) {
    // Mid-generation: Enter with text STEERS — OpenCode injects the message at
    // the agent's next step boundary, so the model reads it and factors it into
    // the work already in flight (verified live: an instruction injected between
    // tool steps changed the ongoing task). Enter on an empty box is a no-op;
    // aborting belongs to the stop button. For a long single generation with no
    // tool steps the injection lands when that step finishes — same behavior as
    // Claude Code / Codex.
    if (!text && !state.pendingImages.length) {
      return;
    }
    if (!text.startsWith('/')) {
      // One-shot ack. It shares the activity strip with the working ticker
      // now, so clear it after a beat instead of squatting on the line.
      const notice = 'Steering — the agent will pick this up at its next step.';
      setStatus(notice);
      setTimeout(() => {
        if (activityStatus === notice) {
          setStatus('');
        }
      }, 5000);
    }
  }
  if (!text && !state.pendingImages.length) {
    return;
  }
  if (runSlashCommand(text)) {
    return;
  }
  if (!state.lmStudioConnected) {
    setStatus('Not connected to LM Studio — check the server banner above.', 'warn');
    return;
  }
  if (!state.serverReady) {
    setStatus('Server not ready yet…', 'warn');
    return;
  }
  const images = state.pendingImages.slice();
  inputEl.value = '';
  state.pendingImages = [];
  renderThumbs();
  autoGrow();
  autoScrollEnabled = true; // a new turn follows the response, even if scrolled up before
  post({
    type: 'send',
    text,
    effort: currentEffort(),
    images,
    includeActiveFile: !!(state.activeFile && state.includeActiveFile),
    // The current selection is always attached silently when present.
    includeSelection: !!state.activeSelection,
  });
}

/** Declared reasoning capability of the current model (undefined = unknown). */
function currentReasoning(): ReasoningCapability | null | undefined {
  return state.models.find((m) => m.id === state.currentModel)?.reasoning;
}

/** The effective level for the current model, clamped to what it supports. */
function currentEffort(): EffortLevel {
  const stored = state.currentModel ? state.effortByModel[state.currentModel] : undefined;
  return resolveLevel(stored ?? state.defaultEffort, currentReasoning());
}

function setEffort(level: EffortLevel): void {
  if (!state.currentModel) {
    return;
  }
  state.effortByModel[state.currentModel] = level;
  persist();
  applyEffort();
  renderEffortPresets();
}

/**
 * Reflect effort + reasoning-display state into the composer. The behavior
 * chip shows "agent · level"; the body class controls only whether existing
 * reasoning blocks are visible. The presets themselves live in the behavior
 * menu's Thinking section (renderEffortPresets).
 */
function applyEffort(): void {
  document.body.classList.toggle('hide-reasoning', !state.showReasoning);
  const check = document.querySelector('#toggle-reasoning .menu-check') as HTMLElement | null;
  if (check) {
    check.classList.toggle('off', !state.showReasoning);
  }
  renderBehaviorLabel();
  renderEffortPresets();
}

/**
 * The behavior chip is permission-forward (like Claude Code's mode chip):
 * mode icon + short mode label, warning-colored on bypass. Agent and thinking
 * live one click away in the menu; the tooltip carries the full picture.
 */
function renderBehaviorLabel(): void {
  if (!behaviorBtnLabel) {
    return;
  }
  const mode = state.permissionMode ?? 'default';
  const def = PERM_MODES.find((m) => m.value === mode) ?? PERM_MODES[0];
  behaviorBtnIco.innerHTML = icon[def.ico];
  behaviorBtnLabel.textContent = def.chip;
  behaviorBtn.classList.toggle('bypass', mode === 'bypass');
  const reasoning = currentReasoning();
  const levels = levelsForModel(reasoning);
  const level = currentEffort();
  behaviorBtn.title =
    `Permissions: ${def.label} — ${def.meta}. Agent: ${state.agent || 'build'}.` +
    (levels.length ? ` Thinking: ${levelLabel(level, reasoning)}.` : '');
}

/**
 * Thinking control in the behavior menu: one row — "Thinking (<level>)" label
 * + a discrete dot slider (Claude-Code-style). Each dot is a button for one of
 * the levels this model actually offers; the current dot is enlarged.
 */
function renderEffortPresets(): void {
  const el = document.getElementById('effort-presets');
  const foot = document.getElementById('effort-foot');
  const note = document.getElementById('effort-note');
  const label = document.getElementById('effort-label');
  if (!el || !foot) {
    return;
  }
  const reasoning = currentReasoning();
  const levels = levelsForModel(reasoning);
  // A model that reports no reasoning support gets no control at all, rather
  // than a dead one.
  foot.classList.toggle('hidden', levels.length === 0);
  if (note) {
    note.textContent =
      reasoning === undefined
        ? 'Effort support unknown for this model — it will be sent anyway (harmless if unsupported).'
        : isBinary(reasoning)
          ? 'This model reports on/off reasoning only.'
          : '';
  }
  const active = currentEffort();
  if (label) {
    label.textContent = `Thinking (${levelLabel(active, reasoning)})`;
  }
  el.innerHTML = '';
  for (const lvl of levels) {
    const b = document.createElement('button');
    b.className = 'effort-dot' + (lvl === active ? ' active' : '');
    b.dataset.level = lvl;
    const name = levelLabel(lvl, reasoning);
    b.setAttribute('aria-label', name);
    b.title =
      lvl === 'auto'
        ? "Auto — use the model's own default"
        : lvl === 'off'
          ? 'Off — suppress reasoning entirely'
          : name;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      setEffort(lvl);
    });
    el.appendChild(b);
  }
}

function persist(): void {
  vscode.setState({
    showReasoning: state.showReasoning,
    effortByModel: state.effortByModel,
    includeActiveFile: state.includeActiveFile,
  });
}

function renderActiveFile(): void {
  const row = document.getElementById('menu-ctxfile')!;
  const selRow = document.getElementById('menu-ctxsel')!;
  if (!state.activeFile) {
    row.classList.add('hidden');
  } else {
    const base = state.activeFile.path.split('/').pop() || state.activeFile.path;
    row.classList.remove('hidden');
    document.getElementById('menu-ctxfile-name')!.textContent = 'Include open file';
    document.getElementById('menu-ctxfile-meta')!.textContent = base;
    const check = row.querySelector('.menu-check') as HTMLElement;
    check.classList.toggle('off', !state.includeActiveFile);
    row.title = state.includeActiveFile
      ? `Including ${state.activeFile.path} as context — click to exclude`
      : `${state.activeFile.path} excluded — click to include as context`;
  }
  // The editor selection is attached automatically (host-side); surface that
  // here so everything being sent is visible in one place.
  if (state.activeSelection) {
    selRow.classList.remove('hidden');
    const sel = state.activeSelection as { path?: string; startLine?: number; endLine?: number };
    const base = sel.path ? sel.path.split('/').pop() : '';
    const lines =
      sel.startLine && sel.endLine ? ` · lines ${sel.startLine}–${sel.endLine}` : '';
    document.getElementById('menu-ctxsel-meta')!.textContent = `${base}${lines}`;
    selRow.title = 'The editor selection is attached to your next message automatically.';
  } else {
    selRow.classList.add('hidden');
  }
  // A subtle indicator on the + button when context beyond the message will be
  // sent (included file, selection, or pending images).
  const hasContext =
    !!(state.activeFile && state.includeActiveFile) ||
    !!state.activeSelection ||
    state.pendingImages.length > 0;
  addBtn.classList.toggle('active', hasContext);
}

// The pinned goal bar (Codex-style): "🎯 Pursuing goal <objective> • round n/N
// · elapsed" with edit / pause-resume / clear controls. Hidden when no goal.
function renderGoalBar(): void {
  const g = state.activeGoal;
  if (!g) {
    goalBarEl.classList.add('hidden');
    if (goalTicker) {
      clearInterval(goalTicker);
      goalTicker = undefined;
    }
    return;
  }
  goalBarEl.classList.remove('hidden');
  goalBarEl.classList.toggle('paused', g.state === 'paused');
  goalBarEl.querySelector('.goal-label')!.textContent =
    g.state === 'paused' ? 'Goal paused' : 'Pursuing goal';
  goalTextEl.textContent = g.objective;
  goalTextEl.title = g.objective;
  goalMetaEl.textContent =
    `• round ${g.iteration}/${g.maxIterations} · ${formatElapsed(Date.now() - g.startedAt)}`;
  goalPauseBtn.innerHTML = g.state === 'paused' ? icon.play : icon.pause;
  goalPauseBtn.title = g.state === 'paused' ? 'Resume goal' : 'Pause goal';
  // Tick the elapsed display once a second while a goal is pinned.
  if (!goalTicker) {
    goalTicker = setInterval(() => {
      const cur = state.activeGoal;
      if (cur) {
        goalMetaEl.textContent =
          `• round ${cur.iteration}/${cur.maxIterations} · ${formatElapsed(Date.now() - cur.startedAt)}`;
      }
    }, 1000);
  }
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The host noticed a message the user typed seems to change the active goal.
// Nothing changes unless the user confirms here — Update sends updateGoal back.
// At most one offer is open at a time; a newer one replaces the old.
let goalReviseCard: HTMLElement | null = null;

function renderGoalRevision(proposed: string): void {
  goalReviseCard?.remove();
  const card = document.createElement('div');
  card.className = 'perm-card goal-revise-card';
  card.innerHTML = `
    <div class="perm-head">🎯 Update the goal? Your last message looks like it changes it.</div>
    <pre class="perm-detail">${escapeHtml(proposed)}</pre>
    <div class="perm-actions">
      <button class="perm-btn allow-once update">Update goal</button>
      <button class="perm-btn reject keep">Keep current</button>
    </div>`;
  const resolve = (updated: boolean, note: string) => {
    if (updated) {
      post({ type: 'updateGoal', objective: proposed });
    }
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
    const el = document.createElement('div');
    el.className = 'perm-resolved';
    el.textContent = note;
    card.appendChild(el);
  };
  card.querySelector('.update')!.addEventListener('click', () => resolve(true, 'Goal updated'));
  card.querySelector('.keep')!.addEventListener('click', () => resolve(false, 'Kept the current goal'));
  messagesEl.appendChild(card);
  goalReviseCard = card;
  toggleWelcome();
  forceScrollToBottom(); // an offer must be visible to be actioned
}

/** Retire an unresolved revision offer (the goal it targeted is gone). */
function retireGoalRevision(): void {
  const card = goalReviseCard;
  if (card && !card.classList.contains('resolved')) {
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
    const el = document.createElement('div');
    el.className = 'perm-resolved';
    el.textContent = 'Goal ended';
    card.appendChild(el);
  }
}

function addImage(file: File): Promise<void> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      state.pendingImages.push({
        mime: file.type || 'image/png',
        dataUrl: String(reader.result),
        name: file.name || 'pasted-image',
      });
      renderThumbs();
      resolve();
    };
    reader.onerror = () => resolve();
    reader.readAsDataURL(file);
  });
}

// Render pasted/attached images as compact chips (thumbnail + name + dimensions)
// in the attachments row above the input, matching Claude's composer. Clicking
// a chip opens the image in a lightbox over the chat. The whole attachments row
// is hidden when there's nothing to show, so it costs no vertical space.
function renderThumbs(): void {
  thumbsEl.innerHTML = '';
  state.pendingImages.forEach((img, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.title = 'Click to preview';

    const im = document.createElement('img');
    im.className = 'attach-thumb';
    im.src = img.dataUrl;

    const meta = document.createElement('span');
    meta.className = 'attach-meta';
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = img.name || 'image.png';
    const dims = document.createElement('span');
    dims.className = 'attach-dims';
    // Fill in real pixel dimensions once the image decodes.
    im.addEventListener('load', () => {
      dims.textContent = im.naturalWidth && im.naturalHeight ? `${im.naturalWidth}×${im.naturalHeight}` : '';
    });
    meta.appendChild(name);
    meta.appendChild(dims);

    const rm = document.createElement('button');
    rm.className = 'attach-rm';
    rm.innerHTML = icon.close;
    rm.title = 'Remove';
    rm.addEventListener('click', (e) => {
      e.stopPropagation(); // don't open the lightbox when removing
      state.pendingImages.splice(i, 1);
      renderThumbs();
    });

    chip.addEventListener('click', () => openLightbox(img.dataUrl, img.name || 'image.png'));

    chip.appendChild(im);
    chip.appendChild(meta);
    chip.appendChild(rm);
    thumbsEl.appendChild(chip);
  });
  // The attachments row holds image chips today; show it only when non-empty.
  attachmentsEl.classList.toggle('hidden', state.pendingImages.length === 0);
  renderActiveFile(); // the + button's context dot tracks pending images too
}

// A full-bleed image preview over the chat output area (like Claude's). Click
// the backdrop, press Escape, or hit the close button to dismiss.
function openLightbox(src: string, alt: string): void {
  closeLightbox();
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.id = 'lightbox';
  const img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = src;
  img.alt = alt;
  const close = document.createElement('button');
  close.className = 'lightbox-close';
  close.innerHTML = icon.close;
  close.title = 'Close (Esc)';
  overlay.appendChild(img);
  overlay.appendChild(close);
  overlay.addEventListener('click', (e) => {
    // Close on a backdrop click, or anywhere inside the close button — including
    // its inner <svg>/<path>, which is the actual e.target when the visible X
    // glyph is clicked (an identity check against the button would miss it).
    const t = e.target as Node;
    if (t === overlay || close.contains(t)) {
      closeLightbox();
    }
  });
  document.body.appendChild(overlay);
}

function closeLightbox(): void {
  document.getElementById('lightbox')?.remove();
}

// ---------------------------------------------------------------------------
// Model / agent pickers
// ---------------------------------------------------------------------------
/**
 * Populate the Agent chips row of the behavior menu from the server roster.
 * Only pickable agents appear (mode primary/all); subagents are
 * delegation-only and would do nothing here.
 */
function renderAgents(): void {
  const agents = state.agents.length
    ? state.agents
    : // Pre-connect fallback so the control is never empty.
      [{ name: 'build', native: true }, { name: 'plan', native: true }];
  const wanted = resolveAgent(state.agent, agents as AgentInfo[]);
  if (state.agent !== wanted) {
    state.agent = wanted;
    post({ type: 'selectAgent', agent: wanted });
  }
  agentChips.innerHTML = '';
  for (const a of agents) {
    const chip = document.createElement('button');
    chip.className = 'ctx-preset' + (a.name === wanted ? ' active' : '');
    chip.dataset.agent = a.name;
    chip.textContent = agentLabel(a as AgentInfo);
    const tip = agentTooltip(a as AgentInfo);
    if (tip) {
      chip.title = tip;
    }
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.agent !== a.name) {
        state.agent = a.name;
        post({ type: 'selectAgent', agent: a.name });
        renderAgents();
        renderMeter(); // agent overhead feeds the token estimate
      }
    });
    agentChips.appendChild(chip);
  }
  renderBehaviorLabel();
}

function renderModels(): void {
  renderAgents();
  const cur = state.models.find((m) => m.id === state.currentModel);
  const dot = modelBtn.querySelector('.model-dot') as HTMLElement;
  const label = modelBtn.querySelector('.model-btn-label') as HTMLElement;
  dot.classList.toggle('loaded', !!cur?.loaded);
  if (cur) {
    const ctx = cur.contextLength ? ` · ${formatTokens(cur.contextLength)}` : '';
    label.textContent = cur.name + ctx;
  } else {
    label.textContent = state.models.length ? 'Select model' : 'No models';
  }
  if (!modelMenu.classList.contains('hidden')) {
    renderModelMenu();
  }
}

function renderModelMenu(): void {
  // A background refresh can rebuild the list while the user is scrolled into
  // it — preserve the scroll position across the innerHTML rebuild.
  const scrollTop = modelMenuList.scrollTop;
  modelMenuList.innerHTML = '';
  if (!state.models.length) {
    modelMenuList.innerHTML = `<div class="model-empty">No models found. Start LM Studio's server and download a model.</div>`;
    return;
  }
  for (const m of state.models) {
    const row = document.createElement('div');
    row.className = 'model-row' + (m.id === state.currentModel ? ' active' : '');
    const loading = state.loadingModels.has(m.id);
    const caps = [
      m.vision ? `<span class="model-cap" title="Vision">${icon.eye}</span>` : '',
      m.toolUse ? `<span class="model-cap" title="Tool use">${icon.wrench}</span>` : '',
    ].join('');
    const ctx = m.loaded
      ? `${formatTokens(m.contextLength || 0)} / ${formatTokens(m.maxContextLength || 0)}`
      : `max ${formatTokens(m.maxContextLength || 0)}`;
    // Identity line: publisher / format / quant — the fields that tell apart
    // same-named models. Only shown when present.
    const ident = modelIdentity(m);
    // Disambiguate the name itself when it isn't unique in the list.
    const tag = modelDisambiguator(m, state.models);
    // An id tag is long and case-sensitive; a publisher tag is a short label.
    const tagIsId = tag === m.id;
    const nameTag = tag
      ? `<span class="model-name">${escapeHtml(m.name)}</span><span class="model-pub-tag${tagIsId ? ' id' : ''}">${escapeHtml(tag)}</span>`
      : `<span class="model-name">${escapeHtml(m.name)}</span>`;
    row.innerHTML = `
      <span class="model-dot${m.loaded ? ' loaded' : ''}"></span>
      <span class="model-info">
        <span class="model-name-row">${nameTag}</span>
        ${ident ? `<span class="model-ident">${escapeHtml(ident)}</span>` : ''}
        <span class="model-meta">${m.loaded ? 'loaded · ' : ''}${ctx}${caps ? ' · <span class="model-caps">' + caps + '</span>' : ''}</span>
      </span>
      <button class="model-action ${loading ? 'busy' : m.loaded ? 'eject' : 'load'}" aria-busy="${loading}">
        ${loading ? `${icon.spinner}<span>${m.loaded ? 'Ejecting…' : 'Loading…'}</span>` : m.loaded ? 'Eject' : 'Load'}
      </button>`;
    // Row click selects the model as active.
    row.addEventListener('click', () => {
      state.currentModel = m.id;
      post({ type: 'selectModel', modelID: m.id });
      renderModels();
      renderMeter();
      closeModelMenu();
    });
    // Action button loads / ejects. Loading also makes the model active (you
    // loaded it to use it); ejecting leaves the current selection alone.
    const action = row.querySelector('.model-action') as HTMLButtonElement;
    action.addEventListener('click', (e) => {
      e.stopPropagation();
      if (loading) {
        return;
      }
      if (!m.loaded) {
        state.currentModel = m.id;
        post({ type: 'selectModel', modelID: m.id });
        renderMeter();
        closeMenuOnLoad = true; // dismiss the menu once this load completes
      }
      state.loadingModels.add(m.id);
      post({ type: m.loaded ? 'unloadModel' : 'loadModel', modelID: m.id });
      renderModelMenu();
    });
    modelMenuList.appendChild(row);
  }
  modelMenuList.scrollTop = scrollTop;
  renderEffortPresets();
}

function toggleModelMenu(): void {
  if (modelMenu.classList.contains('hidden')) {
    openModelMenu();
  } else {
    closeModelMenu();
  }
}

function openModelMenu(): void {
  if (modelMenu.classList.contains('hidden')) {
    // Tell the host to fast-refresh the list while the picker is open, and
    // pull a fresh server roster for the Server section.
    post({ type: 'modelMenu', open: true });
    post({ type: 'listServers' });
  }
  renderServerMenu();
  renderModelMenu();
  modelMenu.classList.remove('hidden');
  // Anchor above the model button, opening upward.
  const r = modelBtn.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 16);
  let left = r.left;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }
  modelMenu.style.left = Math.max(8, left) + 'px';
  modelMenu.style.width = width + 'px';
  modelMenu.style.bottom = window.innerHeight - r.top + 6 + 'px';
}

function closeModelMenu(): void {
  if (!modelMenu.classList.contains('hidden')) {
    post({ type: 'modelMenu', open: false });
  }
  modelMenu.classList.add('hidden');
  // Fold the add-server form (and any typed key) away with the menu.
  const addForm = document.getElementById('server-add-form');
  if (addForm && !addForm.classList.contains('hidden')) {
    addForm.classList.add('hidden');
    (document.getElementById('server-add-key') as HTMLInputElement).value = '';
  }
}

// ---------------------------------------------------------------------------
// Servers (multi-server + offline handling)
// ---------------------------------------------------------------------------
function renderServers(): void {
  // The server's connection state lives on the model chip's dot now: red when
  // the active server is unreachable, regardless of model-loaded state.
  const dot = modelBtn.querySelector('.model-dot') as HTMLElement;
  const active = state.servers.find((s) => s.id === state.activeServerId);
  dot.classList.toggle('err', !state.lmStudioConnected);
  modelBtn.title = active
    ? `Model & server — ${active.name} (${active.url})`
    : 'Model & server — switch, load / eject';
  const headLabel = document.getElementById('models-head-label');
  if (headLabel) {
    headLabel.textContent = active ? `Models on ${active.name}` : 'Models';
  }
  if (!modelMenu.classList.contains('hidden')) {
    renderServerMenu();
  }
  renderConnection();
}

function renderServerMenu(): void {
  serverMenuList.innerHTML = '';
  for (const s of state.servers) {
    const isActive = s.id === state.activeServerId;
    const row = document.createElement('div');
    row.className = 'model-row' + (isActive ? ' active' : '');
    row.innerHTML = `
      <span class="model-dot${isActive && state.lmStudioConnected ? ' loaded' : ''}"></span>
      <span class="model-info">
        <span class="model-name">${escapeHtml(s.name)}${isActive ? ' ·  active' : ''}</span>
        <span class="model-meta">${escapeHtml(s.url)}${s.hasApiKey ? '<span class="server-key-badge" title="API key configured">key</span>' : ''}</span>
      </span>
      <button class="model-action server-edit" title="Edit server">${icon.pencil}</button>
      <button class="model-action eject" title="Remove server">✕</button>`;
    row.addEventListener('click', () => {
      // Keep the menu open on switch: the model list below refreshes in place,
      // which is the whole point of the combined menu.
      if (!isActive) {
        post({ type: 'switchServer', id: s.id });
      }
    });
    (row.querySelector('.server-edit') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation();
      closeModelMenu();
      openServerEdit(s);
    });
    (row.querySelector('.eject') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'removeServer', id: s.id });
    });
    serverMenuList.appendChild(row);
  }
}

// ---- Server edit overlay ----------------------------------------------------

/** The server currently open in the edit overlay (null when closed). */
let editingServer: UiServer | null = null;

function openServerEdit(s: UiServer): void {
  editingServer = s;
  (document.getElementById('server-edit-name') as HTMLInputElement).value = s.name;
  (document.getElementById('server-edit-url') as HTMLInputElement).value = s.url;
  const keyEl = document.getElementById('server-edit-key') as HTMLInputElement;
  keyEl.value = '';
  keyEl.disabled = false;
  // The stored key is never sent to the webview, so the field can't be
  // prefilled — an empty field means "keep the current key".
  keyEl.placeholder = s.hasApiKey ? 'Unchanged — type to replace' : 'API key (optional, for auth proxies)';
  const removeRow = document.getElementById('server-edit-remove-row')!;
  removeRow.classList.toggle('hidden', !s.hasApiKey);
  (document.getElementById('server-edit-remove-key') as HTMLInputElement).checked = false;
  document.getElementById('server-edit-overlay')!.classList.remove('hidden');
}

function closeServerEdit(): void {
  editingServer = null;
  // Don't leave a typed key sitting in the (hidden) DOM.
  (document.getElementById('server-edit-key') as HTMLInputElement).value = '';
  document.getElementById('server-edit-overlay')!.classList.add('hidden');
}

function saveServerEdit(): void {
  if (!editingServer) {
    return;
  }
  const name = (document.getElementById('server-edit-name') as HTMLInputElement).value;
  const url = (document.getElementById('server-edit-url') as HTMLInputElement).value;
  const key = (document.getElementById('server-edit-key') as HTMLInputElement).value.trim();
  const removeKey = (document.getElementById('server-edit-remove-key') as HTMLInputElement).checked;
  if (!url.trim()) {
    return;
  }
  // Tri-state key edit: remove beats replace; an untouched field keeps the key.
  const apiKey = removeKey ? null : key || undefined;
  post({ type: 'updateServer', id: editingServer.id, name, url, apiKey });
  closeServerEdit();
}


function renderConnection(): void {
  if (state.lmStudioConnected) {
    connBanner.classList.add('hidden');
    connBanner.innerHTML = '';
    return;
  }
  const active = state.servers.find((s) => s.id === state.activeServerId);
  connBanner.classList.remove('hidden');
  const auth = state.lmStudioAuthRequired;
  const title = auth ? 'LM Studio requires an API key' : "Can't reach LM Studio";
  const sub = auth
    ? `<code>${escapeHtml(active?.url ?? '')}</code> rejected the request (401) — ${active?.hasApiKey ? 'the stored key was refused; update it' : 'add a key'} under <b>Servers</b>.`
    : `<code>${escapeHtml(active?.url ?? '')}</code> isn't responding — start the server or switch.`;
  connBanner.innerHTML = `
    <span class="conn-ico"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1 5h2v7h-2V7zm0 9h2v2h-2v-2z"/></svg></span>
    <span class="conn-text">
      <span class="conn-title">${title}</span>
      <span class="conn-sub">${sub}</span>
    </span>
    <span class="conn-actions">
      <button class="conn-btn" id="conn-retry">Retry</button>
      <button class="conn-btn primary" id="conn-servers">Servers</button>
    </span>`;
  connBanner.querySelector('#conn-retry')!.addEventListener('click', () => post({ type: 'retryConnect' }));
  connBanner.querySelector('#conn-servers')!.addEventListener('click', (e) => {
    e.stopPropagation();
    // Servers live in the combined model menu now.
    openModelMenu();
  });
}

// ---------------------------------------------------------------------------
// Context usage meter
// ---------------------------------------------------------------------------
function currentWindow(): number {
  // The loaded window if loaded, else min(configured, model max) — see core.
  return computeWindow(
    state.models.find((x) => x.id === state.currentModel),
    state.minContext,
  );
}

function tokensUsed(t: any): number {
  if (!t) {
    return 0;
  }
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0);
}

// OpenCode's openai-compatible provider doesn't report token usage for LM
// Studio, so estimate locally. The fixed preamble (agent prompt + tool schemas
// + the delegatable-agent list) comes from ../core/agents; on top of that,
// ~1 token / 4 chars of visible conversation, plus images.
function estimateUsed(): number {
  let chars = 0;
  for (const ps of partState.values()) {
    chars += ps.buffer.length;
  }
  // Per-agent, and grows with the delegatable roster: every subagent's
  // description is appended to the `task` tool the primary agent sees. A
  // subagent's own prompt does NOT count here — it runs in its own session.
  const overhead = agentOverheadTokens(state.agent, state.agents as AgentInfo[]);
  const images = document.querySelectorAll('.msg-img').length + state.pendingImages.length;
  const fileTokens =
    state.activeFile && state.includeActiveFile ? Math.ceil(state.activeFile.chars / 4) : 0;
  const selTokens = state.activeSelection ? Math.ceil(state.activeSelection.chars / 4) : 0;
  return overhead + Math.ceil(chars / 4) + images * 700 + fileTokens + selTokens;
}

function renderMeter(): void {
  if (!ctxMeterEl) {
    return;
  }
  // Ambient 2px edge on the composer box: quiet below 70%, labeled + warning
  // colored above. The full detail lives in the tooltip and the hover label.
  ctxMeterEl.style.display = state.serverReady ? 'block' : 'none';
  const box = document.querySelector('.composer-box');
  const win = currentWindow();
  const estimated = state.realTokens <= 0;
  const used = estimated ? estimateUsed() : state.realTokens;
  const pct = win > 0 ? Math.min(100, (used / win) * 100) : 0;
  ctxFillEl.style.width = pct.toFixed(1) + '%';
  const warn = pct >= 70 && pct < 90;
  const crit = pct >= 90;
  ctxMeterEl.classList.toggle('warn', warn);
  ctxMeterEl.classList.toggle('crit', crit);
  if (box) {
    box.classList.toggle('ctx-announce', warn || crit);
    (box as HTMLElement).classList.toggle('ctx-warn', warn);
    (box as HTMLElement).classList.toggle('ctx-crit', crit);
  }
  const winLabel = win ? formatTokens(win) : '—';
  let label: string;
  if (state.pendingCompaction) {
    // The reduced size only becomes known on the next real turn (the summarizer
    // turn reports no usable usage), so don't show a number we can't measure.
    label = `compacted · updates on next message / ${winLabel}`;
  } else {
    label = `${estimated ? '~' : ''}${formatTokens(used)} / ${winLabel} · ${Math.round(pct)}%`;
    if (state.compacted) {
      label += ' · compacted';
    }
  }
  ctxLabelEl.textContent = label;
  const tip = state.pendingCompaction
    ? 'Conversation was compacted. The exact reduced size shows after your next message.'
    : estimated
      ? 'Estimated context usage (includes the agent system prompt + tools). LM Studio does not report exact token usage to OpenCode.'
      : 'Context window usage';
  ctxMeterEl.title = tip;
  ctxLabelEl.title = tip;
}

// ---------------------------------------------------------------------------
// Message + part rendering
// ---------------------------------------------------------------------------
function clearConversation(): void {
  messageEls.clear();
  partState.clear();
  roleByMessage.clear();
  permissionEls.clear();
  questionEls.clear();
  toolCollapsed.clear();
  compaction.suppressed.clear();
  compaction.pending = false;
  lastCompactionChip = null;
  state.pendingCompaction = false;
  todoCards.clear();
  todoCollapsed.clear();
  hideWorking();
  messagesEl
    .querySelectorAll('.msg, .perm-card, .question-card, .sys-chip, .error-bubble')
    .forEach((n) => n.remove());
  state.realTokens = 0;
  state.compacted = false;
  lastErrorText = '';
  autoScrollEnabled = true; // fresh conversation starts pinned to the bottom
  toggleWelcome();
}

function toggleWelcome(): void {
  const hasContent = messagesEl.querySelector('.msg, .perm-card, .question-card, .error-bubble');
  welcomeEl.style.display = hasContent ? 'none' : 'flex';
}

function ensureMessageEl(messageID: string, role: string): { partsEl: HTMLElement } {
  let entry = messageEls.get(messageID);
  if (!entry) {
    const el = document.createElement('div');
    el.className = `msg ${role === 'user' ? 'user' : 'assistant'}`;
    const partsEl = document.createElement('div');
    partsEl.className = 'parts';
    el.appendChild(partsEl);
    messagesEl.appendChild(el);
    entry = { el, partsEl, role };
    messageEls.set(messageID, entry);
    toggleWelcome();
  } else if (role && entry.role !== role) {
    entry.role = role;
    entry.el.className = `msg ${role === 'user' ? 'user' : 'assistant'}`;
  }
  return entry;
}

function mdToHtml(src: string): string {
  const raw = marked.parse(src ?? '', { async: false, gfm: true, breaks: true }) as string;
  const tpl = document.createElement('template');
  tpl.innerHTML = raw;
  tpl.content.querySelectorAll('script,iframe,object,embed,link,meta,style').forEach((n) => n.remove());
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) {
        el.removeAttribute(attr.name);
      }
      if ((attr.name === 'href' || attr.name === 'src') && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}

// Render a text or reasoning part from its buffer. Empty parts are hidden so
// they don't leave a stray timeline dot.
function renderTextLike(ps: { el: HTMLElement; buffer: string; type: string }): void {
  const has = ps.buffer.trim().length > 0;
  ps.el.style.display = has ? '' : 'none';
  if (!has) {
    ps.el.innerHTML = '';
    return;
  }
  if (ps.type === 'reasoning') {
    if (!ps.el.querySelector('.reasoning-body')) {
      // Streams open so you can watch it think, then collapses at turn end
      // (see collapseReasoning) — on a reasoning-heavy turn the thinking can be
      // ~90% of the output and would otherwise bury the actual answer.
      ps.el.innerHTML =
        '<details class="reasoning" open><summary><span class="chev"></span><span class="reasoning-label">Thinking…</span></summary><div class="reasoning-body"></div></details>';
      ps.el.dataset.startedAt = String(Date.now());
      // A block the user opened or closed by hand is theirs — auto-collapse must
      // not override it. Listen for the click rather than `toggle`: `toggle`
      // also fires when the element is inserted already-open, which would mark
      // every block as user-touched and defeat the collapse entirely.
      const sum = ps.el.querySelector('details.reasoning > summary') as HTMLElement;
      sum.addEventListener('click', () => {
        ps.el.dataset.userToggled = '1';
      });
    }
    ps.el.dataset.endedAt = String(Date.now());
    ps.el.dataset.chars = String(ps.buffer.length);
    (ps.el.querySelector('.reasoning-body') as HTMLElement).innerHTML = mdToHtml(ps.buffer);
  } else {
    // Fallback: a model that printed the AskUserQuestion JSON as text instead
    // of calling the `question` tool. Once the blob parses, render the picker
    // in place of the raw JSON (requestID null → answers go back as a message).
    const qs = parseQuestionBlob(ps.buffer);
    if (qs && !ps.el.dataset.questionRendered) {
      ps.el.dataset.questionRendered = '1';
      ps.el.style.display = 'none';
      ps.el.innerHTML = '';
      renderQuestion(null, qs);
      return;
    }
    if (ps.el.dataset.questionRendered) {
      return; // already swapped for a picker — ignore further deltas
    }
    ps.el.innerHTML = mdToHtml(ps.buffer);
    enhanceCode(ps.el);
  }
}

function enhanceCode(container: HTMLElement): void {
  container.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      try {
        void navigator.clipboard?.writeText(code);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      } catch {
        /* ignore */
      }
    });
    pre.appendChild(btn);
  });
}

function upsertPart(part: Part): void {
  // A compaction marker: collapse it to a chip and mark the summarizer turn
  // that follows for suppression. Handle before ensureMessageEl so the marker's
  // own (user) message never produces an empty bubble.
  if (isCompactionPart(part.type)) {
    markCompaction(compaction, part.messageID);
    showCompactionChip();
    return;
  }
  // Synthetic text is OpenCode's own context injection — the attached file's
  // contents, tool-call framing ("Called the Read tool with…"), etc. It is sent
  // to the model but was never typed by the user, so it must not render as a
  // chat bubble. The visible affordance for an attachment is its file chip.
  if (isSyntheticText(part)) {
    return;
  }
  const role = roleByMessage.get(part.messageID) ?? 'assistant';
  // The first assistant turn after a compaction marker is the summarizer
  // generating the summary — suppress it (its reasoning + template aren't chat).
  if (shouldSuppressMessage(compaction, part.messageID, role)) {
    return; // summarizer-internal output; never render as a chat turn
  }
  const { partsEl } = ensureMessageEl(part.messageID, role);
  // The agent's todo list (todowrite) renders as one live checklist per turn,
  // not a generic JSON tool card. Route it here and return BEFORE partState so
  // it never enters partState (no meter inflation) and never duplicates.
  if (part.type === 'tool' && (part as { tool?: string }).tool === 'todowrite') {
    if (role !== 'user' && state.busy) {
      setWorkingLabel('Updating plan…');
    }
    renderTodos(part as Part & { messageID: string; state?: any }, partsEl);
    renderMeter();
    scrollToBottom();
    return;
  }
  if (role !== 'user' && state.busy) {
    if (part.type === 'reasoning') {
      setWorkingLabel('Thinking…');
    } else if (part.type === 'tool') {
      const st = (part as any).state;
      const status = st?.status;
      setWorkingLabel(
        status === 'running' || status === 'pending'
          ? `Running ${(part as any).tool}…`
          : 'Working…',
      );
    } else if (part.type === 'text') {
      setWorkingLabel('Responding…');
    }
  }

  let ps = partState.get(part.id);
  if (!ps) {
    const el = document.createElement('div');
    el.className = `part part-${part.type}`;
    partsEl.appendChild(el);
    ps = { el, buffer: '', type: part.type };
    partState.set(part.id, ps);
  }

  switch (part.type) {
    case 'text':
    case 'reasoning': {
      ps.buffer = (part as any).text ?? ps.buffer;
      renderTextLike(ps);
      break;
    }
    case 'tool': {
      renderTool(ps.el, part as any, part.id);
      break;
    }
    case 'file': {
      const f = part as any;
      const mime: string = f.mime ?? '';
      const url: string = f.url ?? '';
      if (mime.startsWith('image/') || /^data:image\//.test(url)) {
        ps.el.innerHTML = `<img class="msg-img" alt="${escapeHtml(f.filename ?? 'image')}" />`;
        (ps.el.querySelector('img.msg-img') as HTMLImageElement).src = url;
      } else {
        ps.el.innerHTML = `<div class="file-chip">${icon.file}<span>${escapeHtml(f.filename ?? url ?? 'file')}</span></div>`;
      }
      break;
    }
    case 'step-finish':
      // `reason: 'length'` means the model hit its output-token budget mid-turn
      // (common with reasoning models that think at length). Remember it so the
      // turn-end handler can tell the user it was truncated rather than just
      // stopping silently — which reads like a freeze/crash.
      if ((part as { reason?: string }).reason === 'length') {
        turnTruncated = true;
      }
      ps.el.remove();
      partState.delete(part.id);
      break;
    case 'step-start':
    case 'snapshot':
    case 'patch':
      ps.el.remove();
      partState.delete(part.id);
      break;
    default:
      ps.el.remove();
      partState.delete(part.id);
  }
  renderMeter();
  scrollToBottom();
}

function appendDelta(partID: string, field: string, delta: string): void {
  if (field !== 'text') {
    return;
  }
  const ps = partState.get(partID);
  if (!ps) {
    return;
  }
  // Feed the generation-rate accounting. Gaps longer than the idle threshold
  // (tool calls, step boundaries) are dropped there rather than counted as slow
  // tokens, which is what made the old wall-clock rate read far too low.
  if (delta && (ps.type === 'text' || ps.type === 'reasoning')) {
    recordDelta(turnRate, ps.type === 'reasoning' ? 'reasoning' : 'text', delta.length, Date.now());
  }
  ps.buffer += delta;
  renderTextLike(ps);
  scrollToBottom();
}

// Generation rate for the current turn, or null if not measurable yet.
function currentGenRate() {
  return summarize(turnRate);
}

function renderTool(el: HTMLElement, part: { tool: string; state: any }, partId: string): void {
  const st = part.state ?? {};
  const status = st.status ?? 'pending';
  const input = st.input ?? {};
  const filePath = input.filePath || input.path || input.file;
  // A `task` call is a delegation to a subagent. Surface WHICH one — otherwise
  // every delegation looks identical and you can't tell that your custom agent
  // was actually picked up.
  const subagent = part.tool === 'task' ? String(input.subagent_type ?? '') : '';
  const title = subagent
    ? `→ ${subagent}${st.title && st.title !== part.tool ? ` · ${st.title}` : ''}`
    : st.title && st.title !== part.tool
      ? st.title
      : filePath
        ? String(filePath)
        : '';
  const statusIcon =
    status === 'completed' ? '✓' : status === 'error' ? '✕' : status === 'running' ? '●' : '·';
  const collapsed = toolCollapsed.get(partId) ?? true;
  el.dataset.status = status;

  el.innerHTML = `
    <div class="tool-card status-${status}${collapsed ? ' collapsed' : ''}">
      <button class="tool-head" type="button">
        <span class="tool-chev"></span>
        <span class="tool-ico">${icon.tool}</span>
        <span class="tool-name">${escapeHtml(part.tool)}</span>
        <span class="tool-title">${escapeHtml(title)}</span>
        <span class="tool-status">${statusIcon}</span>
      </button>
      <div class="tool-body"></div>
    </div>`;
  const card = el.querySelector('.tool-card') as HTMLElement;
  const body = el.querySelector('.tool-body') as HTMLElement;
  (el.querySelector('.tool-head') as HTMLElement).addEventListener('click', () => {
    const next = !card.classList.contains('collapsed');
    card.classList.toggle('collapsed', next);
    toolCollapsed.set(partId, next);
  });

  if (filePath) {
    const fileRow = document.createElement('button');
    fileRow.className = 'tool-file';
    fileRow.innerHTML = `${icon.file}<span>${escapeHtml(String(filePath))}</span>`;
    fileRow.addEventListener('click', () => post({ type: 'openFile', path: String(filePath) }));
    body.appendChild(fileRow);
  }
  const output = status === 'error' ? st.error : st.output;
  if (output) {
    const pre = document.createElement('pre');
    pre.className = 'tool-output';
    pre.textContent = String(output).slice(0, 8000);
    body.appendChild(pre);
  } else if (!filePath && Object.keys(input).length) {
    const pre = document.createElement('pre');
    pre.className = 'tool-output dim';
    pre.textContent = JSON.stringify(input, null, 2).slice(0, 1500);
    body.appendChild(pre);
  }
}

// ---------------------------------------------------------------------------
// Todo checklist (the agent's todowrite tool)
// ---------------------------------------------------------------------------
// Render/replace the single live checklist for this assistant message. Each
// todowrite call carries the full list (replace semantics), so we just rewrite
// one card's contents in place.
function renderTodos(part: { messageID: string; state?: any }, partsEl: HTMLElement): void {
  const mid = part.messageID;
  const todos: Todo[] = Array.isArray(part.state?.input?.todos) ? part.state.input.todos : [];
  let card = todoCards.get(mid);
  if (!todos.length) {
    // Empty / pre-input call: don't leave an empty card flashing.
    card?.remove();
    todoCards.delete(mid);
    return;
  }
  if (!card) {
    card = document.createElement('div');
    card.className = 'part part-todo';
    partsEl.appendChild(card); // append only on first create → updates mutate in place
    todoCards.set(mid, card);
  }
  card.innerHTML = buildTodoHtml(todos, mid);
  const head = card.querySelector('.tool-head') as HTMLElement | null;
  const inner = card.querySelector('.todo-card') as HTMLElement | null;
  head?.addEventListener('click', () => {
    const nowCollapsed = !inner?.classList.contains('collapsed');
    inner?.classList.toggle('collapsed', nowCollapsed);
    todoCollapsed.set(mid, nowCollapsed); // user choice overrides the auto rule
  });
}

function buildTodoHtml(todos: Todo[], mid: string): string {
  const { done, total, anyInProgress, allDone, cardStatus, currentLabel } = summarizeTodos(todos);
  const collapsed = isTodoCardCollapsed(anyInProgress, todoCollapsed.get(mid));
  const mark = (s: Todo['status']): string =>
    s === 'in_progress'
      ? icon.spinner
      : s === 'completed'
        ? '✓'
        : s === 'cancelled'
          ? '⊘'
          : '▢';
  const rows = todos
    .map(
      (t) =>
        `<div class="todo-item is-${t.status}"><span class="todo-mark">${mark(t.status)}</span><span class="todo-text">${escapeHtml(t.content)}</span></div>`,
    )
    .join('');
  return `
    <div class="tool-card todo-card status-${cardStatus}${collapsed ? ' collapsed' : ''}">
      <button class="tool-head" type="button">
        <span class="tool-chev"></span>
        <span class="tool-ico">${icon.checklist}</span>
        <span class="tool-name">Plan</span>
        <span class="todo-current">${escapeHtml(currentLabel)}</span>
        <span class="todo-count">${done}/${total}${allDone ? ' ✓' : ''}</span>
      </button>
      <div class="tool-body todo-list">${rows}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------
function renderPermission(req: any): void {
  if (permissionEls.has(req.id)) {
    return;
  }
  const card = document.createElement('div');
  card.className = 'perm-card';
  const meta = req.metadata ?? {};
  const detail = meta.command || meta.filePath || (req.patterns || []).join(', ') || '';
  card.innerHTML = `
    <div class="perm-head">Permission required: <b>${escapeHtml(req.permission ?? 'action')}</b></div>
    ${detail ? `<pre class="perm-detail">${escapeHtml(String(detail))}</pre>` : ''}
    <div class="perm-actions">
      <button class="perm-btn allow-once">Allow once</button>
      <button class="perm-btn allow-always">Allow always</button>
      <button class="perm-btn reject">Deny</button>
    </div>`;
  const respond = (response: 'once' | 'always' | 'reject') => {
    post({ type: 'permission', sessionID: req.sessionID, permissionID: req.id, response });
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
    const note = document.createElement('div');
    note.className = 'perm-resolved';
    note.textContent = response === 'reject' ? 'Denied' : `Allowed (${response})`;
    card.appendChild(note);
  };
  card.querySelector('.allow-once')!.addEventListener('click', () => respond('once'));
  card.querySelector('.allow-always')!.addEventListener('click', () => respond('always'));
  card.querySelector('.reject')!.addEventListener('click', () => respond('reject'));
  messagesEl.appendChild(card);
  permissionEls.set(req.id, card);
  toggleWelcome();
  forceScrollToBottom(); // a permission prompt must be visible to be actioned
}

function resolvePermission(id: string): void {
  const card = permissionEls.get(id);
  if (card && !card.classList.contains('resolved')) {
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
  }
}

// ---------------------------------------------------------------------------
// Questions (the built-in `question`/ask tool — and a text fallback)
// ---------------------------------------------------------------------------
/**
 * Render an interactive picker for a question request and reply over the
 * /question API. `requestID` null means this came from the text fallback
 * (a model that printed the JSON instead of calling the tool) — in that case
 * we send the chosen labels back as a normal follow-up message instead.
 */
function renderQuestion(requestID: string | null, questions: QInfo[]): void {
  const key = requestID ?? `local-${questions.map((q) => q.question).join('|')}`;
  if (questionEls.has(key)) {
    return;
  }
  const card = document.createElement('div');
  card.className = 'question-card';

  // Per-question selection state: a Set of chosen labels + the custom text.
  const picks = questions.map(() => ({ chosen: new Set<string>(), custom: '' }));
  const tabbed = questions.length > 1;
  let active = 0;

  // A single question auto-advances on a single-select pick only when there's
  // no free-text input to fill in. Multi-select or "type your own" needs Next.
  const autoAdvances = (qi: number): boolean => {
    const q = questions[qi];
    const allowCustom = q.custom !== false || (q.options ?? []).length === 0;
    return !q.multiple && !allowCustom;
  };
  const isAnswered = (qi: number): boolean =>
    picks[qi].chosen.size > 0 || picks[qi].custom.trim().length > 0;

  // --- Tab strip (only when there's more than one question) ------------------
  let tabsEl: HTMLElement | undefined;
  if (tabbed) {
    tabsEl = document.createElement('div');
    tabsEl.className = 'question-tabs';
    questions.forEach((q, qi) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'question-tab';
      tab.dataset.qi = String(qi);
      tab.innerHTML = `<span class="question-tab-num">${qi + 1}</span><span class="question-tab-label">${escapeHtml(
        q.header || `Q${qi + 1}`,
      )}</span><span class="question-tab-check">✓</span>`;
      tab.addEventListener('click', () => show(qi));
      tabsEl!.appendChild(tab);
    });
    card.appendChild(tabsEl);
  }

  // --- Question panels (one shown at a time) ---------------------------------
  const panels: HTMLElement[] = questions.map((q, qi) => {
    const block = document.createElement('div');
    block.className = 'question-block';
    const hasOptions = (q.options ?? []).length > 0;
    // Force the free-text input on when there are no options, so the picker is
    // never a dead end (only "Skip") regardless of what the model sends.
    const allowCustom = q.custom !== false || !hasOptions;
    const multiple = !!q.multiple;
    block.innerHTML = `
      ${q.header ? `<div class="question-chip">${escapeHtml(q.header)}</div>` : ''}
      <div class="question-text">${escapeHtml(q.question)}</div>
      <div class="question-options"></div>
      ${allowCustom ? `<input class="question-custom" type="text" placeholder="Type a custom answer…" />` : ''}`;
    const optsEl = block.querySelector('.question-options') as HTMLElement;
    (q.options ?? []).forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'question-opt';
      btn.innerHTML = `<span class="question-opt-label">${escapeHtml(opt.label)}</span>${
        opt.description ? `<span class="question-opt-desc">${escapeHtml(opt.description)}</span>` : ''
      }`;
      btn.addEventListener('click', () => {
        if (card.classList.contains('resolved')) {
          return;
        }
        const sel = picks[qi].chosen;
        if (multiple) {
          if (sel.has(opt.label)) {
            sel.delete(opt.label);
            btn.classList.remove('selected');
          } else {
            sel.add(opt.label);
            btn.classList.add('selected');
          }
        } else {
          sel.clear();
          optsEl.querySelectorAll('.question-opt').forEach((b) => b.classList.remove('selected'));
          sel.add(opt.label);
          btn.classList.add('selected');
        }
        syncChrome();
        // Single-select with no custom field → jump straight to the next tab.
        if (autoAdvances(qi) && qi < questions.length - 1) {
          show(qi + 1);
        }
      });
      optsEl.appendChild(btn);
    });
    if (allowCustom) {
      const input = block.querySelector('.question-custom') as HTMLInputElement;
      input.addEventListener('input', () => {
        picks[qi].custom = input.value;
        syncChrome();
      });
    }
    card.appendChild(block);
    return block;
  });

  // --- Footer: Back / Next / Submit / Skip -----------------------------------
  const actions = document.createElement('div');
  actions.className = 'question-actions';
  actions.innerHTML = `
    ${tabbed ? '<button class="question-back" type="button">Back</button>' : ''}
    ${tabbed ? '<button class="question-next" type="button">Next</button>' : ''}
    <button class="question-submit" type="button">Send answer</button>
    <button class="question-skip" type="button">Skip</button>`;
  card.appendChild(actions);
  const backBtn = actions.querySelector('.question-back') as HTMLButtonElement | null;
  const nextBtn = actions.querySelector('.question-next') as HTMLButtonElement | null;
  const submitBtn = actions.querySelector('.question-submit') as HTMLButtonElement;

  // Reflect current tab + answered-state across the strip and footer buttons.
  function syncChrome(): void {
    panels.forEach((p, qi) => (p.style.display = qi === active ? '' : 'none'));
    if (tabsEl) {
      tabsEl.querySelectorAll('.question-tab').forEach((t) => {
        const qi = Number((t as HTMLElement).dataset.qi);
        t.classList.toggle('active', qi === active);
        t.classList.toggle('answered', isAnswered(qi));
      });
    }
    if (backBtn) {
      backBtn.style.display = active > 0 ? '' : 'none';
    }
    const onLast = active === questions.length - 1;
    if (nextBtn) {
      nextBtn.style.display = onLast ? 'none' : '';
    }
    // Submit only on the last tab (or always when not tabbed), enabled once
    // every question has an answer.
    submitBtn.style.display = tabbed && !onLast ? 'none' : '';
    submitBtn.disabled = questions.some((_, qi) => !isAnswered(qi));
  }

  function show(qi: number): void {
    if (card.classList.contains('resolved')) {
      return;
    }
    active = Math.max(0, Math.min(questions.length - 1, qi));
    syncChrome();
    const input = panels[active].querySelector('.question-custom') as HTMLInputElement | null;
    input?.focus();
    forceScrollToBottom(); // user navigated between question pages — keep it in view
  }

  backBtn?.addEventListener('click', () => show(active - 1));
  nextBtn?.addEventListener('click', () => show(active + 1));

  const lock = (note: string) => {
    card.querySelectorAll('button, input').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
    const n = document.createElement('div');
    n.className = 'question-resolved';
    n.textContent = note;
    card.appendChild(n);
  };

  const submit = () => {
    if (card.classList.contains('resolved')) {
      return;
    }
    // One answer array per question: chosen labels + any custom text.
    const answers = buildAnswers(picks);
    if (isEmptyAnswer(answers)) {
      return; // nothing chosen — keep the card open
    }
    if (requestID) {
      post({ type: 'questionReply', requestID, answers });
    } else {
      // Fallback path: no real request to reply to — echo the picks as a message.
      const text = questions
        .map((q, i) => `${q.header || q.question}: ${answers[i].join(', ')}`)
        .join('\n');
      post({ type: 'send', text, effort: 'off' });
    }
    lock(`Answered: ${answers.map((a) => a.join(', ')).filter(Boolean).join(' · ')}`);
  };

  submitBtn.addEventListener('click', submit);
  actions.querySelector('.question-skip')!.addEventListener('click', () => {
    if (card.classList.contains('resolved')) {
      return;
    }
    if (requestID) {
      post({ type: 'questionReject', requestID });
    }
    lock('Skipped');
  });

  messagesEl.appendChild(card);
  questionEls.set(key, card);
  syncChrome();
  toggleWelcome();
  forceScrollToBottom(); // a question prompt must be visible to be answered
}

function resolveQuestion(id: string): void {
  const card = questionEls.get(id);
  if (card && !card.classList.contains('resolved')) {
    card.querySelectorAll('button, input').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    card.classList.add('resolved');
  }
}

// ---------------------------------------------------------------------------
// Typing indicator / errors / status
// ---------------------------------------------------------------------------
/**
 * One activity strip instead of a #status + #working stack. While a turn runs
 * it shows the working label + elapsed/tok-s ticker; a transient notice
 * (steering ack, goal progress, connection warning) takes the line over until
 * cleared, then the working content returns. Empty and idle → collapsed.
 */
function renderActivity(): void {
  const hasStatus = !!activityStatus;
  const showing = hasStatus || workingActive;
  activityEl.classList.toggle('show', showing);
  activityEl.classList.toggle('warn', hasStatus && activityKind === 'warn');
  activityEl.classList.toggle('error', hasStatus && activityKind === 'error');
  activitySpinner.classList.toggle('hidden', !workingActive || hasStatus);
  activityLabelEl.textContent = hasStatus ? activityStatus : workingActive ? workingLabel : '';
  if (hasStatus || !workingActive) {
    activityExtraEl.textContent = '';
  }
}

function showWorking(label = 'Working…'): void {
  workingActive = true;
  workingLabel = label;
  workingStart = Date.now();
  if (workingTimer) {
    clearInterval(workingTimer);
  }
  workingTimer = setInterval(() => {
    if (activityStatus) {
      return; // a notice owns the line right now
    }
    const s = Math.floor((Date.now() - workingStart) / 1000);
    const rate = currentGenRate();
    const parts = [];
    if (s > 0) {
      parts.push(`${s}s`);
    }
    if (rate && rate.tps >= 0.5) {
      parts.push(`${rate.exact ? '' : '~'}${Math.round(rate.tps)} tok/s`);
    }
    activityExtraEl.textContent = parts.join(' · ');
  }, 1000);
  renderActivity();
}
function setWorkingLabel(label: string): void {
  if (workingActive) {
    workingLabel = label;
    renderActivity();
  }
}
function hideWorking(): void {
  workingActive = false;
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = undefined;
  }
  renderActivity();
}

// Append a small estimated generation-speed stat under the just-finished
// assistant turn (e.g. "~340 tokens · 7.5s · ~45 tok/s"). No-op when there's
// nothing measurable (e.g. a tool-only turn with no streamed text).
/**
 * Collapse every still-open reasoning block in the finished turn, relabelling it
 * with how long the model thought and roughly how much it produced. Exact
 * reasoning tokens are used when the turn had a single reasoning block (so the
 * message total unambiguously belongs to it); otherwise each block reports its
 * own chars/4 estimate.
 */
function collapseReasoning(): void {
  const msgs = messagesEl.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1] as HTMLElement | undefined;
  if (!last) {
    return;
  }
  const blocks = Array.from(last.querySelectorAll('.part-reasoning')) as HTMLElement[];
  const exactReasoning = turnRate.tokens?.reasoning ?? 0;
  const useExact = blocks.length === 1 && exactReasoning > 0;
  for (const wrap of blocks) {
    const details = wrap.querySelector('details.reasoning') as HTMLDetailsElement | null;
    const label = wrap.querySelector('.reasoning-label') as HTMLElement | null;
    if (!details) {
      continue;
    }
    const started = Number(wrap.dataset.startedAt ?? 0);
    const ended = Number(wrap.dataset.endedAt ?? 0);
    const chars = Number(wrap.dataset.chars ?? 0);
    const tokens = useExact ? exactReasoning : Math.round(chars / 4);
    if (label && started && ended >= started) {
      label.textContent = formatThinkingLabel(ended - started, tokens, useExact);
    } else if (label) {
      label.textContent = 'Thinking';
    }
    // Only auto-collapse blocks the user hasn't already interacted with, so a
    // deliberately-opened block doesn't slam shut when the turn ends.
    if (details.open && !wrap.dataset.userToggled) {
      details.open = false;
    }
  }
}

function appendGenStat(): void {
  const rate = currentGenRate();
  if (!rate || rate.total < 1) {
    return;
  }
  const msgs = messagesEl.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1] as HTMLElement | undefined;
  if (!last || last.querySelector('.gen-stat')) {
    return;
  }
  const el = document.createElement('div');
  el.className = 'gen-stat';
  el.textContent = formatRate(rate);
  // The trimmed line keeps four fields; agent, grand total and the thinking
  // share move here so the detail is one hover away rather than always-on.
  el.title =
    (rate.agent ? `Run by the "${rate.agent}" agent. ` : '') +
    (rate.grandTotal > 0 ? `Total (prompt + output): ${formatTokens(rate.grandTotal)} tokens. ` : '') +
    (rate.reasoning > 0 ? `Thinking: ${formatTokens(rate.reasoning)} of the output tokens. ` : '') +
    (rate.exact
      ? 'Exact token usage reported by LM Studio. '
      : 'Token count estimated from the response length (exact usage had not arrived yet). ') +
    'tok/s counts output tokens over the time the model was generating — prompt processing, tool calls and step boundaries are excluded.';
  last.appendChild(el);
}

function showError(message: string): void {
  hideWorking();
  const text = (message || '').trim() || 'Something went wrong.';
  // Don't stack duplicate bubbles — a dropped connection often arrives as both
  // a session.error and a message error in the same turn.
  if (text === lastErrorText) {
    return;
  }
  lastErrorText = text;
  // A user-initiated stop is not a failure. It also arrives through several
  // paths at once (the message's error, session.error, the prompt call's
  // rejection) — humanizeError collapses them all to this exact text, so the
  // dedup above guarantees a single quiet chip instead of stacked red alerts.
  if (text === 'Stopped.') {
    addSysChip('⏹ Stopped.');
    return;
  }
  const el = document.createElement('div');
  el.className = 'error-bubble';
  el.textContent = text;
  messagesEl.appendChild(el);
  toggleWelcome();
  scrollToBottom();
}

function setStatus(text: string, kind?: 'info' | 'warn' | 'error'): void {
  activityStatus = text;
  activityKind = kind ?? '';
  renderActivity();
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  sendBtn.innerHTML = busy ? icon.stop : icon.send;
  sendBtn.classList.toggle('busy', busy);
  if (busy) {
    lastErrorText = ''; // new turn — allow a fresh error to surface
    turnTruncated = false; // fresh turn — clear any prior truncation flag
    turnRate = newTurnRate(); // reset generation-speed tracking for the new turn
    showWorking('Working…');
  } else {
    hideWorking();
  }
}

// Block the composer while a /compact runs. Unlike a normal turn (where the send
// button becomes an abort), compaction can't be interrupted, so we disable the
// input + send entirely and show a distinct indicator. Model/server pickers stay
// usable. On completion the meter enters "pending" mode (true size unknown until
// the next turn) — see renderMeter().
function setCompacting(active: boolean): void {
  state.compacting = active;
  inputEl.disabled = active;
  sendBtn.disabled = active;
  document.body.classList.toggle('compacting', active);
  if (active) {
    lastErrorText = '';
    showWorking('Compacting conversation…');
  } else {
    hideWorking();
    state.pendingCompaction = true; // size now stale until the next real turn lands
    state.compacted = true;
    renderMeter();
  }
}

// Pin to the bottom only if the user hasn't scrolled up. Used for streamed
// tokens and incremental part updates so reading back mid-generation works.
function scrollToBottom(): void {
  if (!autoScrollEnabled) {
    return;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Force the view to the bottom and re-engage autoscroll. Used when the user
// just did something that should bring them back (sent a message, new session)
// or when a card needs to be visible to be actionable (permission, question).
function forceScrollToBottom(): void {
  autoScrollEnabled = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

// ---------------------------------------------------------------------------
// History overlay
// ---------------------------------------------------------------------------
function openHistory(): void {
  post({ type: 'loadSessions' });
  renderHistory();
  historyOverlay.classList.remove('hidden');
}
function closeHistory(): void {
  historyOverlay.classList.add('hidden');
}
function renderHistory(): void {
  historyList.innerHTML = '';
  if (!state.sessions.length) {
    historyList.innerHTML = `<div class="history-empty">No conversations yet.</div>`;
    return;
  }
  for (const s of state.sessions) {
    const row = document.createElement('div');
    row.className = 'history-row' + (s.id === state.currentSessionID ? ' active' : '');
    row.innerHTML = `
      <button class="history-open">
        <span class="history-title">${escapeHtml(s.title)}</span>
        <span class="history-time">${relativeTime(s.updated)}</span>
      </button>
      <button class="history-del" title="Delete">${icon.trash}</button>`;
    row.querySelector('.history-open')!.addEventListener('click', () => {
      post({ type: 'loadSession', sessionID: s.id });
      closeHistory();
    });
    row.querySelector('.history-del')!.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'deleteSession', sessionID: s.id });
    });
    historyList.appendChild(row);
  }
}
function relativeTime(ms: number): string {
  if (!ms) {
    return '';
  }
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) {
    return 'just now';
  }
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// History (full conversation) rendering
// ---------------------------------------------------------------------------
function renderConversation(messages: MessageWithParts[]): void {
  clearConversation();
  let lastUsed = 0;
  for (const m of messages) {
    roleByMessage.set(m.info.id, m.info.role);
    // Mirror the live path: a message carrying a compaction marker collapses to
    // a chip, and the summarizer turn that follows it is suppressed.
    if (m.parts.some((part) => isCompactionPart(part.type))) {
      markCompaction(compaction, m.info.id);
      showCompactionChip();
      continue;
    }
    if (shouldSuppressMessage(compaction, m.info.id, m.info.role)) {
      // Recover the summary text from the suppressed summarizer turn so the
      // chip stays expandable after a reload (the live path gets it from the
      // bridge instead).
      const summary = m.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text?: string }).text ?? '')
        .join('')
        .trim();
      if (summary) {
        attachCompactionSummary(summary);
      }
      continue; // summarizer-internal turn — not chat
    }
    ensureMessageEl(m.info.id, m.info.role);
    for (const part of m.parts) {
      upsertPart(part);
    }
    if (m.info.role === 'assistant' && (m.info as any).tokens) {
      const u = tokensUsed((m.info as any).tokens);
      if (u > 0) {
        lastUsed = u;
      }
    }
    if (m.info.error) {
      showError(humanizeError(m.info.error, { subject: 'LM Studio' }));
    }
  }
  state.realTokens = lastUsed;
  renderMeter();
  toggleWelcome();
  forceScrollToBottom(); // full (re)render of a session lands the user at the bottom
}

// ---------------------------------------------------------------------------
// OpenCode event handling
// ---------------------------------------------------------------------------
function handleEvent(event: OpencodeEvent): void {
  const p = event.properties as any;
  switch (event.type) {
    case 'message.updated': {
      const info = p.info;
      if (info?.id) {
        roleByMessage.set(info.id, info.role);
        // The summarizer turn that follows a compaction marker isn't a chat
        // turn — don't materialize a bubble or count its tokens.
        if (shouldSuppressMessage(compaction, info.id, info.role)) {
          break;
        }
        ensureMessageEl(info.id, info.role);
        if (info.role === 'assistant') {
          // A real assistant turn after compaction has begun (the summarizer
          // turn was suppressed above), so the post-compaction state is now
          // current. Clear the "pending" flag even when LM Studio reports no
          // token usage — otherwise the meter sticks on "compacted" forever.
          state.pendingCompaction = false;
          // Exact usage for the generation stat — LM Studio does report it now,
          // with reasoning broken out, so we prefer it over the chars/4 estimate.
          recordTokens(turnRate, info.tokens);
          // Which agent actually ran the turn — confirms the picker selection
          // took effect, and names the agent when a command/goal pinned another.
          recordAgent(turnRate, (info as { agent?: string }).agent);
          if (info.tokens) {
            const used = tokensUsed(info.tokens);
            if (used > 0) {
              state.realTokens = used;
              state.compacted = false;
            }
          }
          renderMeter();
        }
        if (info.error) {
          showError(humanizeError(info.error, { subject: 'LM Studio' }));
        }
      }
      break;
    }
    case 'session.compacted':
      state.compacted = true;
      renderMeter();
      break;
    case 'message.part.updated':
      if (p.part) {
        upsertPart(p.part as Part);
      }
      break;
    case 'message.part.delta':
      appendDelta(p.partID, p.field, p.delta);
      break;
    case 'message.part.removed': {
      const ps = partState.get(p.partID);
      ps?.el.remove();
      partState.delete(p.partID);
      toolCollapsed.delete(p.partID);
      break;
    }
    case 'permission.asked':
      renderPermission(p);
      break;
    case 'permission.replied':
      resolvePermission(p.id ?? p.permissionID);
      break;
    case 'question.asked':
      renderQuestion(p.id, p.questions ?? []);
      break;
    case 'question.replied':
    case 'question.rejected':
      resolveQuestion(p.requestID ?? p.id);
      break;
    case 'session.idle':
      // Capture the generation rate before setBusy(false) clears the counters.
      collapseReasoning();
      appendGenStat();
      setBusy(false);
      renderMeter();
      if (turnTruncated) {
        // The turn ended because it ran out of output budget, not because the
        // model was done. Say so — otherwise a cut-off reply looks like a freeze.
        addSysChip(
          '⚠ Response was cut off — it reached the output token limit. Raise the context window (it scales the output budget) or ask the model to be more concise.',
        );
        turnTruncated = false;
      }
      break;
    case 'session.error': {
      showError(humanizeError(p.error, { subject: 'LM Studio' }));
      setBusy(false);
      break;
    }
    case 'file.edited':
      // Subtle chip noting an edited file (deduped per render is not critical).
      break;
  }
}

// ---------------------------------------------------------------------------
// Host messages
// ---------------------------------------------------------------------------
window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      state.models = msg.models;
      state.currentModel = msg.currentModel;
      state.agent = msg.agent;
      state.serverReady = msg.serverReady;
      state.lmStudioConnected = msg.lmStudioConnected;
      state.lmStudioAuthRequired = !!msg.lmStudioAuthRequired;
      state.minContext = msg.minContext;
      state.defaultEffort = msg.defaultEffort ?? 'auto';
      state.permissionMode = msg.permissionMode ?? 'default';
      state.agents = msg.agents ?? [];
      renderPermissionMode();
      renderModels();
      renderMeter();
      renderServers();
      applyEffort(); // levels depend on the selected model's declared capability
      if (!msg.serverReady && msg.lmStudioConnected) {
        setStatus('OpenCode server failed to start. See logs.', 'error');
      }
      break;
    case 'servers':
      state.servers = msg.servers;
      state.activeServerId = msg.activeId;
      state.lmStudioConnected = msg.connected;
      renderServers();
      break;
    case 'models':
      state.models = msg.models;
      state.currentModel = msg.currentModel;
      // Only a reply to a user action may clear in-flight load spinners or
      // dismiss the menu — a background refresh landing mid-load must not.
      if (msg.reason !== 'periodic') {
        state.loadingModels.clear();
        if (closeMenuOnLoad) {
          // A load the user kicked off from the menu has returned — dismiss it.
          closeMenuOnLoad = false;
          closeModelMenu();
        }
      }
      renderModels();
      renderMeter();
      applyEffort(); // a model switch can change which levels exist
      break;
    case 'sessions':
      state.sessions = msg.sessions;
      state.currentSessionID = msg.currentSessionID;
      renderHistory();
      break;
    case 'sessionLoaded':
      state.currentSessionID = msg.sessionID;
      renderConversation(msg.messages);
      break;
    case 'cleared':
      clearConversation();
      renderMeter();
      break;
    case 'event':
      handleEvent(msg.event);
      break;
    case 'busy':
      setBusy(msg.busy);
      break;
    case 'compacting':
      setCompacting(msg.active);
      if (!msg.active && msg.summary) {
        attachCompactionSummary(msg.summary);
      }
      break;
    case 'activeFile':
      state.activeFile = msg.path ? { path: msg.path, chars: msg.chars } : null;
      renderActiveFile();
      renderMeter();
      break;
    case 'activeSelection':
      // The selection is auto-attached (host-side); the add-context menu shows
      // an info row for it and the context meter reflects the extra tokens.
      state.activeSelection = msg.selection;
      renderActiveFile();
      renderMeter();
      break;
    case 'status':
      setStatus(msg.text, msg.kind);
      break;
    case 'command':
      if (msg.command === 'history') {
        openHistory();
      } else if (msg.command === 'newChat') {
        post({ type: 'newChat' });
      } else if (msg.command === 'focusInput') {
        inputEl.focus();
      }
      break;
    case 'mcpStatus':
      showMcpStatus(msg.servers);
      break;
    case 'skills':
      showSkills(msg.skills);
      break;
    case 'agents':
      // Keep the picker in sync with what the panel just showed.
      state.agents = msg.agents;
      renderAgents();
      renderMeter(); // the delegatable count feeds the overhead estimate
      showAgents(msg.agents, msg.delegatable);
      break;
    case 'commands':
      setServerCommands(msg.commands);
      break;
    case 'goal':
      state.activeGoal = msg.goal;
      if (!msg.goal) {
        retireGoalRevision(); // an open offer can't apply to a cleared goal
      }
      renderGoalBar();
      break;
    case 'goalRevision':
      renderGoalRevision(msg.proposed);
      break;
    case 'goalEvent':
      if (msg.kind === 'checking') {
        setStatus('Checking goal…');
      } else if (msg.kind === 'continued') {
        setStatus(`Goal round ${msg.iteration ?? '?'}: ${msg.reason ?? 'continuing…'}`);
      } else if (msg.kind === 'met') {
        setStatus('');
        addSysChip(`🎯 Goal met — ${msg.reason ?? 'done'}`);
      } else if (msg.kind === 'updated') {
        addSysChip(`🎯 Goal updated — ${msg.reason ?? ''}`);
      } else if (msg.kind === 'stopped') {
        setStatus('');
        const why = msg.why === 'stalled' ? 'no progress across several rounds' : 'iteration cap reached';
        addSysChip(`Goal paused (${why}) — ${msg.reason ?? ''}\nResume from the goal bar, or /goal clear to end it.`);
      }
      break;
    case 'permissionMode':
      state.permissionMode = msg.mode;
      renderPermissionMode();
      addSysChip(permissionModeChip(msg.mode));
      break;
    case 'error':
      showError(msg.message);
      setBusy(false);
      break;
  }
});

// ---------------------------------------------------------------------------
// Test hook (stripped from production by esbuild — see __TEST__ define)
// ---------------------------------------------------------------------------
// Lets integration tests drive + inspect the webview over the postMessage
// channel: { __test__: 'query', id, selector, prop } reads an element's text or
// attribute; { __test__: 'click', id, selector } dispatches a real click. The
// result is posted back as { __test__: 'result', id, ... }. No eval is exposed.
function installTestHook(): void {
  window.addEventListener('message', (e: MessageEvent<any>) => {
    const m = e.data;
    if (!m || m.__test__ === undefined || m.__test__ === 'result') {
      return;
    }
    const reply = (payload: Record<string, unknown>) =>
      vscode.postMessage({ __test__: 'result', id: m.id, ...payload } as never);
    try {
      if (m.__test__ === 'query') {
        const els = Array.from(document.querySelectorAll(m.selector as string));
        const read = (el: Element) =>
          m.prop === 'text'
            ? (el.textContent ?? '').trim()
            : m.prop === 'class'
              ? el.className
              : m.prop === 'value'
                ? ((el as HTMLInputElement).value ?? null)
                : el.getAttribute(m.prop as string);
        reply({ count: els.length, value: els[0] ? read(els[0]) : null, values: els.map(read) });
      } else if (m.__test__ === 'click') {
        const el = document.querySelector(m.selector as string) as HTMLElement | null;
        if (el) {
          el.click();
        }
        reply({ ok: !!el });
      } else if (m.__test__ === 'setInput') {
        // Set the composer textarea value and fire the input event, so tests can
        // drive the slash-command autocomplete the way a user typing would.
        inputEl.value = String(m.value ?? '');
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        reply({ ok: true });
      } else if (m.__test__ === 'setSelect') {
        // Set a <select>'s value and fire change, the way a user picking an
        // option would (click() can't open a native dropdown in tests).
        const el = document.querySelector(m.selector as string) as HTMLSelectElement | null;
        if (el) {
          el.value = String(m.value ?? '');
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        reply({ ok: !!el });
      } else {
        reply({ error: `unknown __test__ op: ${m.__test__}` });
      }
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
build();
if (__TEST__) {
  installTestHook();
}
post({ type: 'ready' });
