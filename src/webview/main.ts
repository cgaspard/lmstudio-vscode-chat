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
import { computeWindow, contextPresets, formatTokens } from '../core/context';
import { humanizeError } from '../core/errors';
import { modelDisambiguator, modelIdentity } from '../core/models';
import { isTodoCardCollapsed, summarizeTodos, Todo } from '../core/todos';
import { buildAnswers, isEmptyAnswer, parseQuestionBlob, QInfo } from '../core/question';
import type { MessageWithParts, OpencodeEvent, Part } from '../opencode/protocol';
import type { HostToWebview, UiCommand, UiImage, UiMcpServer, UiModel, UiServer, UiSession, UiSkill, WebviewToHost } from '../shared';

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
  agent: 'build' | 'plan';
  sessions: UiSession[];
  currentSessionID: string | null;
  busy: boolean;
  serverReady: boolean;
  lmStudioConnected: boolean;
  thinking: boolean;
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
}
const persisted = (vscode.getState() as { thinking?: boolean; includeActiveFile?: boolean }) ?? {};
const state: State = {
  models: [],
  currentModel: null,
  agent: 'build',
  sessions: [],
  currentSessionID: null,
  busy: false,
  serverReady: false,
  lmStudioConnected: false,
  thinking: persisted.thinking ?? true,
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
// Generation-speed tracking. LM Studio reports no token usage to OpenCode, so we
// estimate from the streamed output ourselves: count characters (text+reasoning)
// and divide an estimated token count (chars/4) by our own elapsed time.
let turnOutputChars = 0; // streamed output chars this turn
let turnFirstTokenAt = 0; // when the first output token arrived (Date.now), for an accurate rate
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
let serverBtn!: HTMLButtonElement;
let serverMenu!: HTMLElement;
let serverMenuList!: HTMLElement;
let connBanner!: HTMLElement;
let ctxFileBtn!: HTMLButtonElement;
let ctxFileName!: HTMLElement;
let attachmentsEl!: HTMLElement;
let agentSelect!: HTMLSelectElement;
let statusEl!: HTMLElement;
let historyOverlay!: HTMLElement;
let historyList!: HTMLElement;
let thumbsEl!: HTMLElement;
let thinkBtn!: HTMLButtonElement;
let fileInput!: HTMLInputElement;
let ctxMeterEl!: HTMLElement;
let ctxFillEl!: HTMLElement;
let ctxLabelEl!: HTMLElement;
let workingEl!: HTMLElement;
let workingLabelEl!: HTMLElement;
let workingElapsedEl!: HTMLElement;
let workingStart = 0;
let workingTimer: ReturnType<typeof setInterval> | undefined;

function build(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div id="titlebar-actions" class="titlebar-actions">
      <button id="ta-new" class="ta-btn" title="New chat">${icon.plus}</button>
      <button id="ta-history" class="ta-btn" title="Session history">${icon.history}</button>
      <button id="ta-tab" class="ta-btn" title="Open chat in editor tab">${icon.window}</button>
    </div>
    <div id="conn-banner" class="conn-banner hidden"></div>
    <div id="messages" class="messages">
      <div id="welcome" class="welcome">
        <div class="welcome-logo">${icon.sparkLarge}</div>
        <div class="welcome-title">LM Studio Code</div>
        <div class="welcome-sub">Local agentic coding, powered by OpenCode.</div>
        <div class="welcome-hint">Pick a model below and describe a task.</div>
      </div>
    </div>
    <div id="status" class="status"></div>
    <div id="working" class="working hidden">
      <span class="spinner"></span>
      <span class="working-label">Working…</span>
      <span class="working-elapsed"></span>
    </div>
    <div id="ctx-meter" class="ctx-meter" title="Context window usage">
      <div class="ctx-bar"><div class="ctx-fill"></div></div>
      <span class="ctx-label"></span>
    </div>
    <div class="composer">
      <div class="composer-box">
        <div id="slash-menu" class="slash-menu hidden"></div>
        <div id="attachments" class="attachments hidden">
          <div id="thumbs" class="thumbs"></div>
        </div>
        <textarea id="input" rows="1" placeholder="Ask anything, paste an image, or describe a task…"></textarea>
        <div class="composer-row">
          <div class="composer-tools">
            <button id="server-btn" class="tool-pill" title="LM Studio server — switch / add">
              <span class="model-dot"></span><span id="server-name">Server</span>
            </button>
            <button id="btn-attach" class="tool-pill icon-only" title="Attach image">${icon.paperclip}</button>
            <button id="btn-think" class="tool-pill" title="Toggle thinking">${icon.brain}<span>Thinking</span></button>
            <span class="tool-sep"></span>
            <button id="ctxfile" class="ctxref hidden" title="Include the open file as context">${icon.file}<span id="ctxfile-name"></span></button>
          </div>
          <div class="composer-right">
            <button id="model-btn" class="model-btn" title="Model — load / eject">
              <span class="model-dot"></span>
              <span class="model-btn-label">Model</span>
              <span class="caret">${icon.caret}</span>
            </button>
            <select id="agent-select" class="picker agent" title="Agent">
              <option value="build">build</option>
              <option value="plan">plan</option>
            </select>
            <button id="send" class="send-btn" title="Send">${icon.send}</button>
          </div>
        </div>
      </div>
      <input id="file-input" type="file" accept="image/*" multiple hidden />
    </div>
    <div id="model-menu" class="model-menu hidden">
      <div class="model-menu-head">
        <span>LM Studio models</span>
        <button id="model-refresh" class="icon-btn" title="Rescan models">${icon.refresh}</button>
      </div>
      <div id="model-menu-list" class="model-menu-list"></div>
      <div class="model-menu-foot">
        <span class="ctx-foot-label">Context window</span>
        <div id="ctx-presets" class="ctx-presets"></div>
      </div>
    </div>
    <div id="server-menu" class="model-menu hidden">
      <div class="model-menu-head"><span>LM Studio servers</span></div>
      <div id="server-menu-list" class="model-menu-list"></div>
      <div class="server-add">
        <input id="server-add-name" class="server-input" placeholder="Name (e.g. Workstation)" />
        <input id="server-add-url" class="server-input" placeholder="http://192.168.1.50:1234" />
        <button id="server-add-btn" class="model-action load">Add server</button>
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
  serverBtn = document.getElementById('server-btn') as HTMLButtonElement;
  serverMenu = document.getElementById('server-menu')!;
  serverMenuList = document.getElementById('server-menu-list')!;
  connBanner = document.getElementById('conn-banner')!;
  ctxFileBtn = document.getElementById('ctxfile') as HTMLButtonElement;
  ctxFileName = document.getElementById('ctxfile-name')!;
  attachmentsEl = document.getElementById('attachments')!;
  agentSelect = document.getElementById('agent-select') as HTMLSelectElement;
  statusEl = document.getElementById('status')!;
  historyOverlay = document.getElementById('history-overlay')!;
  historyList = document.getElementById('history-list')!;
  thumbsEl = document.getElementById('thumbs')!;
  thinkBtn = document.getElementById('btn-think') as HTMLButtonElement;
  fileInput = document.getElementById('file-input') as HTMLInputElement;
  ctxMeterEl = document.getElementById('ctx-meter')!;
  ctxFillEl = ctxMeterEl.querySelector('.ctx-fill') as HTMLElement;
  ctxLabelEl = ctxMeterEl.querySelector('.ctx-label') as HTMLElement;
  workingEl = document.getElementById('working')!;
  workingLabelEl = workingEl.querySelector('.working-label') as HTMLElement;
  workingElapsedEl = workingEl.querySelector('.working-elapsed') as HTMLElement;

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

  sendBtn.addEventListener('click', onSend);
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
      if (!state.busy) {
        onSend();
      }
    }
  });
  inputEl.addEventListener('input', () => {
    autoGrow();
    updateSlashMenu();
  });
  inputEl.addEventListener('blur', () => closeSlashMenu());

  // Thinking toggle
  thinkBtn.addEventListener('click', () => {
    state.thinking = !state.thinking;
    persist();
    applyThinking();
  });
  applyThinking();

  // Active-file context toggle
  ctxFileBtn.addEventListener('click', () => {
    state.includeActiveFile = !state.includeActiveFile;
    persist();
    renderActiveFile();
    renderMeter();
  });

  // Image attach / paste / drop
  document.getElementById('btn-attach')!.addEventListener('click', () => fileInput.click());
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
  serverBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleServerMenu();
  });
  document.getElementById('server-add-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const nameEl = document.getElementById('server-add-name') as HTMLInputElement;
    const urlEl = document.getElementById('server-add-url') as HTMLInputElement;
    if (urlEl.value.trim()) {
      post({ type: 'addServer', name: nameEl.value, url: urlEl.value });
      nameEl.value = '';
      urlEl.value = '';
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (!modelMenu.classList.contains('hidden') && !modelMenu.contains(t) && !modelBtn.contains(t)) {
      closeModelMenu();
    }
    if (!serverMenu.classList.contains('hidden') && !serverMenu.contains(t) && !serverBtn.contains(t)) {
      closeServerMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('lightbox')) {
        closeLightbox();
        return;
      }
      closeModelMenu();
      closeServerMenu();
    }
  });
  agentSelect.addEventListener('change', () => {
    state.agent = agentSelect.value as 'build' | 'plan';
    post({ type: 'selectAgent', agent: state.agent });
    renderMeter();
  });
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
  /** Local UI commands run a callback; server commands carry their kind here. */
  run?: () => void;
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
function skillsCommand(): void {
  addSysChip('Checking skills…');
  post({ type: 'requestSkills' });
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
    cmd.run?.();
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
  if (state.busy) {
    post({ type: 'abort' });
    return;
  }
  const text = inputEl.value.trim();
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
    thinking: state.thinking,
    images,
    includeActiveFile: !!(state.activeFile && state.includeActiveFile),
    // The current selection is always attached silently when present.
    includeSelection: !!state.activeSelection,
  });
}

function applyThinking(): void {
  thinkBtn.classList.toggle('active', state.thinking);
  document.body.classList.toggle('hide-reasoning', !state.thinking);
  thinkBtn.title = state.thinking ? 'Thinking: on' : 'Thinking: off';
}

function persist(): void {
  vscode.setState({
    thinking: state.thinking,
    includeActiveFile: state.includeActiveFile,
  });
}

function renderActiveFile(): void {
  if (!state.activeFile) {
    ctxFileBtn.classList.add('hidden');
    return;
  }
  ctxFileBtn.classList.remove('hidden');
  ctxFileName.textContent = state.activeFile.path.split('/').pop() || state.activeFile.path;
  ctxFileBtn.classList.toggle('active', state.includeActiveFile);
  ctxFileBtn.title = state.includeActiveFile
    ? `Including ${state.activeFile.path} as context — click to exclude`
    : `${state.activeFile.path} excluded — click to include as context`;
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
function renderModels(): void {
  agentSelect.value = state.agent;
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
  renderCtxPresets();
}

function renderCtxPresets(): void {
  const el = document.getElementById('ctx-presets');
  if (!el) {
    return;
  }
  const m = state.models.find((x) => x.id === state.currentModel);
  // Presets are filtered to the selected model's real maximum (and always
  // include the exact max), so you can never pick more than the model supports.
  const presets = contextPresets(m?.maxContextLength);
  el.innerHTML = '';
  for (const v of presets) {
    const b = document.createElement('button');
    b.className = 'ctx-preset' + (v === state.minContext ? ' active' : '');
    b.textContent = formatTokens(v);
    b.title = v.toLocaleString() + ' tokens';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (v === state.minContext) {
        return;
      }
      state.minContext = v;
      renderCtxPresets();
      renderMeter();
      post({ type: 'setContextSize', tokens: v });
    });
    el.appendChild(b);
  }
}

function toggleModelMenu(): void {
  if (modelMenu.classList.contains('hidden')) {
    openModelMenu();
  } else {
    closeModelMenu();
  }
}

function openModelMenu(): void {
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
  modelMenu.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Servers (multi-server + offline handling)
// ---------------------------------------------------------------------------
function renderServers(): void {
  const dot = serverBtn.querySelector('.model-dot') as HTMLElement;
  const name = document.getElementById('server-name')!;
  const active = state.servers.find((s) => s.id === state.activeServerId);
  dot.classList.toggle('loaded', state.lmStudioConnected);
  dot.classList.toggle('err', !state.lmStudioConnected);
  name.textContent = active ? active.name : 'Server';
  serverBtn.title = active ? `LM Studio: ${active.url}` : 'LM Studio server';
  if (!serverMenu.classList.contains('hidden')) {
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
        <span class="model-meta">${escapeHtml(s.url)}</span>
      </span>
      <button class="model-action eject" title="Remove server">✕</button>`;
    row.addEventListener('click', () => {
      if (!isActive) {
        post({ type: 'switchServer', id: s.id });
      }
      closeServerMenu();
    });
    (row.querySelector('.model-action') as HTMLButtonElement).addEventListener('click', (e) => {
      e.stopPropagation();
      post({ type: 'removeServer', id: s.id });
    });
    serverMenuList.appendChild(row);
  }
}

function toggleServerMenu(): void {
  if (serverMenu.classList.contains('hidden')) {
    openServerMenu();
  } else {
    closeServerMenu();
  }
}

function openServerMenu(): void {
  post({ type: 'listServers' });
  renderServerMenu();
  serverMenu.classList.remove('hidden');
  const r = serverBtn.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 16);
  let left = r.left;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }
  serverMenu.style.left = Math.max(8, left) + 'px';
  serverMenu.style.width = width + 'px';
  serverMenu.style.bottom = window.innerHeight - r.top + 6 + 'px';
}

function closeServerMenu(): void {
  serverMenu.classList.add('hidden');
}

function renderConnection(): void {
  if (state.lmStudioConnected) {
    connBanner.classList.add('hidden');
    connBanner.innerHTML = '';
    return;
  }
  const active = state.servers.find((s) => s.id === state.activeServerId);
  connBanner.classList.remove('hidden');
  connBanner.innerHTML = `
    <span class="conn-ico"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1 5h2v7h-2V7zm0 9h2v2h-2v-2z"/></svg></span>
    <span class="conn-text">
      <span class="conn-title">Can't reach LM Studio</span>
      <span class="conn-sub"><code>${escapeHtml(active?.url ?? '')}</code> isn't responding — start the server or switch.</span>
    </span>
    <span class="conn-actions">
      <button class="conn-btn" id="conn-retry">Retry</button>
      <button class="conn-btn primary" id="conn-servers">Servers</button>
    </span>`;
  connBanner.querySelector('#conn-retry')!.addEventListener('click', () => post({ type: 'retryConnect' }));
  connBanner.querySelector('#conn-servers')!.addEventListener('click', (e) => {
    e.stopPropagation();
    openServerMenu();
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
// Studio, so estimate locally. Calibrated against a proxy measurement: the
// build agent's system prompt + tool definitions are ~11k tokens; plan is
// lighter. Plus ~1 token / 4 chars of visible conversation, plus images.
function estimateUsed(): number {
  let chars = 0;
  for (const ps of partState.values()) {
    chars += ps.buffer.length;
  }
  const overhead = state.agent === 'plan' ? 6000 : 11000;
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
  ctxMeterEl.style.display = state.serverReady ? 'flex' : 'none';
  const win = currentWindow();
  const estimated = state.realTokens <= 0;
  const used = estimated ? estimateUsed() : state.realTokens;
  const pct = win > 0 ? Math.min(100, (used / win) * 100) : 0;
  ctxFillEl.style.width = pct.toFixed(1) + '%';
  ctxMeterEl.classList.toggle('warn', pct >= 70 && pct < 90);
  ctxMeterEl.classList.toggle('crit', pct >= 90);
  const winLabel = win ? formatTokens(win) : '—';
  let label: string;
  if (state.pendingCompaction) {
    // The reduced size only becomes known on the next real turn (the summarizer
    // turn reports no usable usage), so don't show a number we can't measure.
    label = `compacted · updates on next message / ${winLabel} context`;
  } else {
    label = `${estimated ? '~' : ''}${formatTokens(used)} / ${winLabel} context · ${Math.round(pct)}%`;
    if (state.compacted) {
      label += ' · compacted';
    }
  }
  ctxLabelEl.textContent = label;
  ctxMeterEl.title = state.pendingCompaction
    ? 'Conversation was compacted. The exact reduced size shows after your next message.'
    : estimated
      ? 'Estimated context usage (includes the agent system prompt + tools). LM Studio does not report exact token usage to OpenCode.'
      : 'Context window usage';
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
      ps.el.innerHTML =
        '<details class="reasoning" open><summary><span class="chev"></span>Thinking</summary><div class="reasoning-body"></div></details>';
    }
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
  // Count streamed output for the generation-speed estimate. Stamp the first
  // token so the rate measures generation, not the prompt-processing wait.
  if (delta && (ps.type === 'text' || ps.type === 'reasoning')) {
    if (!turnFirstTokenAt) {
      turnFirstTokenAt = Date.now();
    }
    turnOutputChars += delta.length;
  }
  ps.buffer += delta;
  renderTextLike(ps);
  scrollToBottom();
}

// Estimated generation rate for the current turn, or null if not measurable yet.
// Tokens are estimated as chars/4 (LM Studio reports no exact usage); the rate is
// over the time since the first token (excludes prompt-processing latency).
function currentGenRate(): { tokens: number; seconds: number; tps: number } | null {
  if (!turnFirstTokenAt || turnOutputChars <= 0) {
    return null;
  }
  const seconds = (Date.now() - turnFirstTokenAt) / 1000;
  const tokens = Math.round(turnOutputChars / 4);
  if (seconds <= 0) {
    return null;
  }
  return { tokens, seconds, tps: tokens / seconds };
}

function renderTool(el: HTMLElement, part: { tool: string; state: any }, partId: string): void {
  const st = part.state ?? {};
  const status = st.status ?? 'pending';
  const input = st.input ?? {};
  const filePath = input.filePath || input.path || input.file;
  const title = st.title && st.title !== part.tool ? st.title : filePath ? String(filePath) : '';
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
      post({ type: 'send', text, thinking: false });
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
function showWorking(label = 'Working…'): void {
  workingLabelEl.textContent = label;
  workingEl.classList.remove('hidden');
  workingStart = Date.now();
  workingElapsedEl.textContent = '';
  if (workingTimer) {
    clearInterval(workingTimer);
  }
  workingTimer = setInterval(() => {
    const s = Math.floor((Date.now() - workingStart) / 1000);
    const rate = currentGenRate();
    const parts = [];
    if (s > 0) {
      parts.push(`${s}s`);
    }
    if (rate && rate.tps >= 0.5) {
      parts.push(`~${Math.round(rate.tps)} tok/s`);
    }
    workingElapsedEl.textContent = parts.join(' · ');
  }, 1000);
}
function setWorkingLabel(label: string): void {
  if (!workingEl.classList.contains('hidden')) {
    workingLabelEl.textContent = label;
  }
}
function hideWorking(): void {
  workingEl.classList.add('hidden');
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = undefined;
  }
}

// Append a small estimated generation-speed stat under the just-finished
// assistant turn (e.g. "~340 tokens · 7.5s · ~45 tok/s"). No-op when there's
// nothing measurable (e.g. a tool-only turn with no streamed text).
function appendGenStat(): void {
  const rate = currentGenRate();
  if (!rate || rate.tokens < 1) {
    return;
  }
  const msgs = messagesEl.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1] as HTMLElement | undefined;
  if (!last || last.querySelector('.gen-stat')) {
    return;
  }
  const el = document.createElement('div');
  el.className = 'gen-stat';
  el.textContent = `~${rate.tokens} tokens · ${rate.seconds.toFixed(1)}s · ~${Math.round(rate.tps)} tok/s`;
  el.title =
    'Estimated from the response length — LM Studio does not report exact token usage to OpenCode.';
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
  const el = document.createElement('div');
  el.className = 'error-bubble';
  el.textContent = text;
  messagesEl.appendChild(el);
  toggleWelcome();
  scrollToBottom();
}

function setStatus(text: string, kind?: 'info' | 'warn' | 'error'): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind ?? ''} ${text ? 'show' : ''}`;
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  sendBtn.innerHTML = busy ? icon.stop : icon.send;
  sendBtn.classList.toggle('busy', busy);
  if (busy) {
    lastErrorText = ''; // new turn — allow a fresh error to surface
    turnTruncated = false; // fresh turn — clear any prior truncation flag
    turnOutputChars = 0; // reset generation-speed tracking for the new turn
    turnFirstTokenAt = 0;
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
      state.minContext = msg.minContext;
      renderModels();
      renderMeter();
      renderServers();
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
      state.loadingModels.clear();
      renderModels();
      renderMeter();
      if (closeMenuOnLoad) {
        // A load the user kicked off from the menu has returned — dismiss it.
        closeMenuOnLoad = false;
        closeModelMenu();
      }
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
      // The selection is auto-attached silently (no pill); just track it so the
      // context meter reflects the extra tokens.
      state.activeSelection = msg.selection;
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
    case 'commands':
      setServerCommands(msg.commands);
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
