// Pure translation between the embedded OpenCode 2 SDK and the 1.x-shaped
// events and messages the bridge and webview were built on. Keeping the webview
// on one event vocabulary means the engine swap does not ripple through 6k
// lines of UI; v2-only concepts (the steering inbox) get their own `inbox.*`
// events on top.
//
// No I/O here: everything is unit-tested against payloads captured from a live
// OpenCode 2.1.4 (test/translate.test.ts).
import { fromEngineProviderID } from '../core/providerIds';
import type { MessageWithParts, OpencodeEvent, Part, QuestionAnswer, QuestionInfo } from './protocol';

/** An event as the v2 SDK's `event.subscribe()` yields it. */
export interface V2Event {
  id?: string;
  type: string;
  data?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A pending steer/queue item, as the webview's inbox strip shows it. */
export interface InboxItem {
  inboxID: string;
  sessionID: string;
  text: string;
  delivery: 'steer' | 'queue';
  /** Count of attachments (images, files) riding along with the text. */
  files: number;
}

// ---- Tool names and inputs ---------------------------------------------------

/**
 * v2 renamed several built-in tools. The webview special-cases the 1.x names
 * (todos, subagent rows, edit/write diffs), so map back at the boundary.
 */
const TOOL_NAMES: Record<string, string> = {
  shell: 'bash',
  todo: 'todowrite',
  subagent: 'task',
};

export function v1ToolName(name: string): string {
  return TOOL_NAMES[name] ?? name;
}

/** Normalize a v2 tool input to the 1.x field names the webview reads. */
export function v1ToolInput(name: string, input: unknown): Record<string, unknown> {
  const inp = input && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {};
  if (typeof inp.path === 'string' && inp.filePath === undefined) {
    inp.filePath = inp.path;
  }
  if (name === 'subagent' && typeof inp.agent === 'string') {
    inp.subagent_type = inp.agent;
  }
  return inp;
}

/** Collapse a v2 tool result's content blocks to the plain output string 1.x had. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }
  return content
    .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * v2 attaches per-file patches as `metadata.files[].patch`; the webview's edit
 * renderer reads one unified diff from `metadata.diff`.
 */
function v1ToolMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const meta = { ...(metadata as Record<string, unknown>) };
  const files = Array.isArray(meta.files) ? (meta.files as Array<{ patch?: unknown }>) : [];
  const patches = files.map((f) => (typeof f?.patch === 'string' ? f.patch : '')).filter(Boolean);
  if (patches.length && meta.diff === undefined) {
    meta.diff = patches.join('\n');
  }
  return meta;
}

function errorMessage(error: unknown): string {
  if (!error) {
    return '';
  }
  if (typeof error === 'string') {
    return error;
  }
  const e = error as { message?: unknown; type?: unknown };
  return String(e.message ?? e.type ?? 'error');
}

/** A v2 `{type, message}` error in the 1.x `{name, data: {message}}` shape humanizeError reads. */
function v1Error(error: unknown): { name: string; data: { message: string } } {
  const e = (error ?? {}) as { type?: unknown };
  return { name: typeof e.type === 'string' ? e.type : 'UnknownError', data: { message: errorMessage(error) } };
}

const ABORTED = { name: 'MessageAbortedError', data: { message: 'Aborted' } };

// ---- Part ids ----------------------------------------------------------------
// v2 identifies streamed content by (assistantMessageID, ordinal) and tool calls
// by call id. 1.x had one id per part; derive stable ones so a live part and the
// same part reloaded from history land on the same webview element.

export const textPartId = (mid: string, ordinal: number) => `${mid}:text:${ordinal}`;
export const reasoningPartId = (mid: string, ordinal: number) => `${mid}:reasoning:${ordinal}`;
export const toolPartId = (mid: string, callID: string) => `${mid}:tool:${callID}`;
const stepStartId = (mid: string) => `${mid}:step-start`;
const stepFinishId = (mid: string) => `${mid}:step-finish`;
const userTextId = (mid: string) => `${mid}:text`;
const userFileId = (mid: string, i: number) => `${mid}:file:${i}`;

// ---- Prompt attachments -------------------------------------------------------

/**
 * A 1.x prompt file part → an OpenCode 2 prompt attachment (`{uri, name}`; the
 * engine resolves the uri). Everything goes as a data: URL so the model gets
 * exactly what the panel chose to send: the image as pasted, the open file
 * capped as the bridge capped it, a selection as just the selected text — not
 * whatever is on disk when the engine gets round to reading it.
 */
export function v2PromptFile(p: {
  mime: string;
  url: string;
  filename?: string;
  source?: { path: string; text: { value: string } };
}): { uri: string; name?: string; description?: string } {
  if (p.url.startsWith('data:')) {
    return { uri: p.url, ...(p.filename ? { name: p.filename } : {}) };
  }
  const text = p.source?.text?.value ?? '';
  const mime = p.mime || 'text/plain';
  return {
    uri: `data:${mime};base64,${Buffer.from(text, 'utf8').toString('base64')}`,
    ...(p.filename ? { name: p.filename } : {}),
    ...(p.source?.path ? { description: `From ${p.source.path}` } : {}),
  };
}

// ---- Permissions and questions ------------------------------------------------

/** v2 `permission.asked` data → the 1.x permission request the webview renders. */
export function v1Permission(d: any): Record<string, unknown> {
  const action = String(d?.action ?? '');
  const resources: string[] = Array.isArray(d?.resources) ? d.resources.map(String) : [];
  const meta = { ...(v1ToolMetadata(d?.metadata) ?? {}) };
  const firstFile = Array.isArray(d?.metadata?.files) ? d.metadata.files[0]?.file : undefined;
  if (meta.filePath === undefined && (firstFile || (action !== 'shell' && resources[0]))) {
    meta.filePath = firstFile ?? resources[0];
  }
  if (action === 'shell' && meta.command === undefined && resources[0]) {
    meta.command = resources[0];
  }
  return {
    id: d?.id,
    sessionID: d?.sessionID,
    permission: v1ToolName(action),
    patterns: resources,
    always: Array.isArray(d?.save) ? d.save : undefined,
    metadata: meta,
  };
}

interface FormField {
  key: string;
  title?: string;
  description?: string;
  type?: string;
  options?: Array<{ value?: unknown; label?: unknown; description?: unknown } | string>;
  custom?: boolean;
}

/** The form fields behind a v2 question, in order. */
export function formFields(form: any): FormField[] {
  return Array.isArray(form?.fields) ? (form.fields as FormField[]) : [];
}

/** Whether a v2 form is the `question` tool (as opposed to an MCP elicitation etc.). */
export function isQuestionForm(form: any): boolean {
  return form?.metadata?.kind === 'question';
}

/** v2 form fields → the 1.x QuestionInfo list the webview's picker renders. */
export function v1Questions(form: any): QuestionInfo[] {
  return formFields(form).map((f) => {
    const options = (f.options ?? []).map((o) =>
      typeof o === 'string'
        ? { label: o, description: '' }
        : { label: String(o.label ?? o.value ?? ''), description: String(o.description ?? '') },
    );
    return {
      question: String(f.description ?? f.title ?? ''),
      header: String(f.title ?? ''),
      options,
      multiple: f.type === 'multiselect',
      custom: f.custom !== false,
    };
  });
}

/**
 * The webview answers with one list of chosen labels per question (custom text
 * included as a label). v2 wants `{fieldKey: value}`: an option's `value` for a
 * picked label, the raw text for a custom answer, and an array for multiselect.
 */
export function v2FormAnswer(form: any, answers: QuestionAnswer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  formFields(form).forEach((f, i) => {
    const chosen = answers[i] ?? [];
    const values = chosen.map((label) => {
      const opt = (f.options ?? []).find((o) => (typeof o === 'string' ? o : String(o.label ?? o.value)) === label);
      if (opt === undefined) {
        return label;
      }
      return typeof opt === 'string' ? opt : (opt.value ?? opt.label);
    });
    out[f.key] = f.type === 'multiselect' ? values : (values[0] ?? '');
  });
  return out;
}

// ---- Live events --------------------------------------------------------------

interface ToolState {
  mid: string;
  /** The turn-level message the card renders under. */
  tid: string;
  name: string;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Stateful v2 → 1.x event translator. One instance per event subscription: it
 * remembers what streamed so far (text so a part's final update carries all of
 * it, tool names and inputs across their separate events, queued prompts until
 * they are delivered).
 */
export class EventTranslator {
  /**
   * The 1.x message id a session's running turn renders under. 1.x had one
   * assistant message per turn, spanning every tool step; v2 has one per step.
   * The webview keys per-turn UI on the message (one bubble, one live todo
   * list, one timing stat), so a turn's steps share the id of its first step —
   * until the run ends, or a steered message is delivered mid-turn (the steps
   * after it then render below the user's message, in the order the model saw
   * them).
   */
  private readonly turns = new Map<string, string>();
  /** step message id -> its turn message id. */
  private readonly stepTurn = new Map<string, string>();
  private readonly text = new Map<string, string>();
  private readonly tools = new Map<string, ToolState>();
  private readonly inbox = new Map<string, InboxItem & { raw: any }>();
  private readonly forms = new Map<string, any>();

  /** The v2 form behind a question id (the reply needs its field keys). */
  formFor(id: string): any {
    return this.forms.get(id);
  }

  /** Queued/steering items not yet delivered, oldest first. */
  pending(sessionID: string): InboxItem[] {
    return [...this.inbox.values()]
      .filter((i) => i.sessionID === sessionID)
      .map(({ raw: _raw, ...item }) => item);
  }

  translate(e: V2Event): OpencodeEvent[] {
    const d = e.data ?? {};
    const sid: string | undefined = d.sessionID;
    const mid: string | undefined = d.assistantMessageID;
    // The turn-level message every part of this step renders under.
    const tid = mid ? this.turnOf(sid, mid) : undefined;
    const ev = (type: string, properties: Record<string, unknown>): OpencodeEvent => ({ type, properties });
    const part = (p: Record<string, unknown>) => ev('message.part.updated', { part: { sessionID: sid, messageID: tid, ...p } });

    switch (e.type) {
      // -- assistant turn structure -------------------------------------------
      case 'session.step.started':
        return [
          ev('message.updated', {
            info: {
              id: tid,
              sessionID: sid,
              role: 'assistant',
              time: { created: d.started ?? Date.now() },
              agent: d.agent,
              modelID: d.model?.id,
              providerID: d.model?.providerID ? fromEngineProviderID(d.model.providerID) : undefined,
            },
          }),
          part({ id: stepStartId(mid!), type: 'step-start' }),
        ];
      case 'session.step.ended':
        return [
          part({ id: stepFinishId(mid!), type: 'step-finish', reason: d.finish, cost: d.cost, tokens: d.tokens }),
          ev('message.updated', {
            info: { id: tid, sessionID: sid, role: 'assistant', time: { created: 0, completed: Date.now() }, tokens: d.tokens, cost: d.cost },
          }),
        ];

      // -- streamed text and reasoning -----------------------------------------
      case 'session.text.started':
      case 'session.reasoning.started': {
        const type = e.type === 'session.text.started' ? 'text' : 'reasoning';
        const id = type === 'text' ? textPartId(mid!, d.ordinal ?? 0) : reasoningPartId(mid!, d.ordinal ?? 0);
        this.text.set(id, '');
        return [part({ id, type, text: '', time: { start: Date.now() } })];
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const id = e.type === 'session.text.delta' ? textPartId(mid!, d.ordinal ?? 0) : reasoningPartId(mid!, d.ordinal ?? 0);
        this.text.set(id, (this.text.get(id) ?? '') + String(d.delta ?? ''));
        return [ev('message.part.delta', { sessionID: sid, messageID: tid, partID: id, field: 'text', delta: d.delta ?? '' })];
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const type = e.type === 'session.text.ended' ? 'text' : 'reasoning';
        const id = type === 'text' ? textPartId(mid!, d.ordinal ?? 0) : reasoningPartId(mid!, d.ordinal ?? 0);
        const text = typeof d.text === 'string' ? d.text : (this.text.get(id) ?? '');
        this.text.delete(id);
        return [part({ id, type, text, time: { start: 0, end: Date.now() } })];
      }

      // -- tool calls ----------------------------------------------------------
      case 'session.tool.input.started': {
        const t: ToolState = { mid: mid!, tid: tid!, name: String(d.name ?? 'tool'), input: {} };
        this.tools.set(d.id, t);
        return [this.toolPart(sid, d.id, t, { status: 'pending' })];
      }
      case 'session.tool.input.ended':
      case 'session.tool.called': {
        const t = this.tool(d.id, mid);
        if (e.type === 'session.tool.called') {
          t.input = v1ToolInput(t.name, d.input);
        } else if (typeof d.text === 'string') {
          try {
            t.input = v1ToolInput(t.name, JSON.parse(d.text));
          } catch {
            // partial/invalid JSON: the `called` event carries the parsed input
          }
        }
        return [this.toolPart(sid, d.id, t, { status: e.type === 'session.tool.called' ? 'running' : 'pending' })];
      }
      case 'session.tool.progress': {
        const t = this.tool(d.id, mid);
        t.metadata = { ...(t.metadata ?? {}), ...(v1ToolMetadata(d.metadata) ?? {}) };
        return [this.toolPart(sid, d.id, t, { status: 'running' })];
      }
      case 'session.tool.success': {
        const t = this.tool(d.id, mid);
        t.metadata = { ...(t.metadata ?? {}), ...(v1ToolMetadata(d.metadata) ?? {}) };
        this.tools.delete(d.id);
        return [this.toolPart(sid, d.id, t, { status: 'completed', output: contentText(d.content), time: { start: 0, end: Date.now() } })];
      }
      case 'session.tool.failed': {
        const t = this.tool(d.id, mid);
        this.tools.delete(d.id);
        return [this.toolPart(sid, d.id, t, { status: 'error', error: errorMessage(d.error), time: { start: 0, end: Date.now() } })];
      }

      // -- end of a run --------------------------------------------------------
      case 'session.execution.succeeded':
        this.endTurn(sid);
        return [ev('session.idle', { sessionID: sid })];
      case 'session.execution.interrupted':
        this.endTurn(sid);
        // 1.x reported a stop as MessageAbortedError, which the webview renders
        // as one muted "Stopped" chip rather than an error bubble.
        return [ev('session.error', { sessionID: sid, error: ABORTED }), ev('session.idle', { sessionID: sid })];
      case 'session.execution.failed':
        this.endTurn(sid);
        return [ev('session.error', { sessionID: sid, error: v1Error(d.error) }), ev('session.idle', { sessionID: sid })];
      case 'session.retry.scheduled':
        return [ev('session.retry', { sessionID: sid, attempt: d.attempt, at: d.at, message: errorMessage(d.error) })];

      // -- compaction ----------------------------------------------------------
      case 'session.compaction.ended':
        return [ev('session.compacted', { sessionID: sid, summary: d.text ?? '' })];
      case 'session.compaction.failed':
        return [ev('session.error', { sessionID: sid, error: v1Error(d.error) })];

      // -- permissions ---------------------------------------------------------
      case 'permission.asked':
        return [ev('permission.asked', v1Permission(d))];
      case 'permission.replied':
        return [ev('permission.replied', { id: d.requestID, sessionID: sid, reply: d.reply })];

      // -- questions (v2 forms) ------------------------------------------------
      case 'form.created': {
        const form = d.form;
        if (!isQuestionForm(form)) {
          return [];
        }
        this.forms.set(form.id, form);
        return [ev('question.asked', { id: form.id, sessionID: form.sessionID, questions: v1Questions(form) })];
      }
      case 'form.replied':
        this.forms.delete(d.id);
        return [ev('question.replied', { requestID: d.id, sessionID: sid })];
      case 'form.cancelled':
        this.forms.delete(d.id);
        return [ev('question.rejected', { requestID: d.id, sessionID: sid })];

      // -- steering inbox ------------------------------------------------------
      case 'session.inbox.enqueued': {
        const item = d.item ?? {};
        if (item.type !== 'user') {
          return []; // compaction/synthetic/move items have their own surfaces
        }
        const entry = {
          inboxID: d.inboxID,
          sessionID: sid!,
          text: String(item.payload?.text ?? ''),
          delivery: item.delivery === 'queue' ? ('queue' as const) : ('steer' as const),
          files: Array.isArray(item.payload?.files) ? item.payload.files.length : 0,
          raw: item.payload,
        };
        this.inbox.set(d.inboxID, entry);
        const { raw: _raw, ...pub } = entry;
        return [ev('inbox.enqueued', { ...pub })];
      }
      case 'session.inbox.delivery.changed': {
        const entry = this.inbox.get(d.inboxID);
        if (entry) {
          entry.delivery = d.delivery === 'queue' ? 'queue' : 'steer';
        }
        return [ev('inbox.changed', { sessionID: sid, inboxID: d.inboxID, delivery: d.delivery })];
      }
      case 'session.inbox.cancelled':
        this.inbox.delete(d.inboxID);
        return [ev('inbox.cancelled', { sessionID: sid, inboxID: d.inboxID })];
      case 'session.inbox.delivered': {
        const entry = this.inbox.get(d.inboxID);
        this.inbox.delete(d.inboxID);
        this.endTurn(sid); // steps after a steered message render below it
        // The user's bubble enters the transcript when the model actually sees
        // it, so the conversation reads in the order the model received it.
        const out: OpencodeEvent[] = [ev('inbox.delivered', { sessionID: sid, inboxID: d.inboxID })];
        if (entry) {
          out.push(...userMessageEvents(sid!, d.inboxID, entry.raw, Date.now()));
        }
        return out;
      }

      default:
        return [];
    }
  }

  /** The turn message for a step: the first step of the session's current turn. */
  private turnOf(sid: string | undefined, mid: string): string {
    // Steps are keyed by message id too, so a late event for a step finds its
    // turn even without a session id.
    const known = this.stepTurn.get(mid);
    if (known) {
      return known;
    }
    const key = sid ?? '';
    let turn = this.turns.get(key);
    if (!turn) {
      turn = mid;
      this.turns.set(key, turn);
    }
    this.stepTurn.set(mid, turn);
    return turn;
  }

  private endTurn(sid: string | undefined): void {
    this.turns.delete(sid ?? '');
  }

  private tool(callID: string, mid: string | undefined): ToolState {
    let t = this.tools.get(callID);
    if (!t) {
      t = { mid: mid ?? '', tid: mid ? this.turnOf(undefined, mid) : '', name: 'tool', input: {} };
      this.tools.set(callID, t);
    }
    return t;
  }

  private toolPart(sid: string | undefined, callID: string, t: ToolState, state: Record<string, unknown>): OpencodeEvent {
    return {
      type: 'message.part.updated',
      properties: {
        part: {
          id: toolPartId(t.mid, callID),
          sessionID: sid,
          messageID: t.tid,
          type: 'tool',
          callID,
          tool: v1ToolName(t.name),
          state: { input: t.input, ...(t.metadata ? { metadata: t.metadata } : {}), ...state },
        },
      },
    };
  }
}

/** The 1.x events for one user message (bubble + its text and attachments). */
function userMessageEvents(sid: string, mid: string, payload: any, created: number): OpencodeEvent[] {
  const msg = userMessage(sid, mid, payload, created);
  return [
    { type: 'message.updated', properties: { info: msg.info } },
    ...msg.parts.map((p) => ({ type: 'message.part.updated', properties: { part: p } })),
  ];
}

function userMessage(sid: string, mid: string, payload: any, created: number): MessageWithParts {
  const parts: Part[] = [{ id: userTextId(mid), sessionID: sid, messageID: mid, type: 'text', text: String(payload?.text ?? '') }];
  const files: any[] = Array.isArray(payload?.files) ? payload.files : [];
  files.forEach((f, i) => {
    const mime = String(f?.mime ?? 'application/octet-stream');
    const url = f?.source?.type === 'uri' && f.source.uri ? String(f.source.uri) : `data:${mime};base64,${String(f?.data ?? '')}`;
    parts.push({ id: userFileId(mid, i), sessionID: sid, messageID: mid, type: 'file', mime, url, filename: f?.name });
  });
  return { info: { id: mid, sessionID: sid, role: 'user', time: { created } }, parts };
}

// ---- History ------------------------------------------------------------------

/**
 * A v2 message list → 1.x MessageWithParts, oldest first.
 *
 * v2 lists newest first and keeps a compaction as its own entry carrying the
 * summary. The webview's 1.x history logic expects a compaction *marker*
 * message followed by the summarizer's assistant turn (which it folds into an
 * expandable chip), so a compaction becomes exactly that pair.
 */
export function v1History(sessionID: string, rows: any[]): MessageWithParts[] {
  const out: MessageWithParts[] = [];
  const sorted = [...rows].sort((a, b) => Number(a?.time?.created ?? 0) - Number(b?.time?.created ?? 0));
  // A turn's steps (one v2 assistant message each) fold into one 1.x message,
  // matching the live grouping in EventTranslator; anything else ends the turn.
  let turn: MessageWithParts | undefined;
  for (const m of sorted) {
    const created = Number(m?.time?.created ?? 0);
    if (m?.type === 'assistant') {
      const step = assistantMessage(sessionID, m);
      if (!turn) {
        turn = step;
        out.push(turn);
      } else {
        turn.parts.push(...step.parts.map((p) => ({ ...p, messageID: turn!.info.id })));
        turn.info = {
          ...turn.info,
          time: { created: turn.info.time.created, completed: step.info.time.completed ?? turn.info.time.completed },
          tokens: step.info.tokens ?? turn.info.tokens,
          cost: (turn.info.cost ?? 0) + (step.info.cost ?? 0),
          ...(step.info.error ? { error: step.info.error } : {}),
        };
      }
      continue;
    }
    turn = undefined;
    switch (m?.type) {
      case 'user':
        out.push(userMessage(sessionID, m.id, { text: m.text, files: m.files }, created));
        break;
      case 'compaction': {
        const marker = `${m.id}:marker`;
        out.push({
          info: { id: marker, sessionID, role: 'user', time: { created } },
          parts: [{ id: `${marker}:part`, sessionID, messageID: marker, type: 'compaction' }],
        });
        const summary = String(m.text ?? m.summary ?? m.payload?.text ?? '');
        out.push({
          info: { id: m.id, sessionID, role: 'assistant', time: { created } },
          parts: summary ? [{ id: textPartId(m.id, 0), sessionID, messageID: m.id, type: 'text', text: summary }] : [],
        });
        break;
      }
      default:
        break; // idle markers, synthetic notes: not chat (but they do end a turn)
    }
  }
  return out;
}

function assistantMessage(sessionID: string, m: any): MessageWithParts {
  const mid = String(m.id);
  const parts: Part[] = [{ id: stepStartId(mid), sessionID, messageID: mid, type: 'step-start' }];
  let text = 0;
  let reasoning = 0;
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c?.type === 'text') {
      parts.push({ id: textPartId(mid, text++), sessionID, messageID: mid, type: 'text', text: String(c.text ?? '') });
    } else if (c?.type === 'reasoning') {
      parts.push({ id: reasoningPartId(mid, reasoning++), sessionID, messageID: mid, type: 'reasoning', text: String(c.text ?? '') });
    } else if (c?.type === 'tool') {
      const st = c.state ?? {};
      const status = st.status === 'completed' ? 'completed' : st.status === 'error' || st.status === 'failed' ? 'error' : 'running';
      parts.push({
        id: toolPartId(mid, String(c.id)),
        sessionID,
        messageID: mid,
        type: 'tool',
        callID: String(c.id),
        tool: v1ToolName(String(c.name ?? 'tool')),
        state: {
          status,
          input: v1ToolInput(String(c.name ?? ''), st.input),
          output: contentText(st.content),
          error: status === 'error' ? errorMessage(st.error) : undefined,
          metadata: v1ToolMetadata(st.metadata),
          time: { start: Number(c.time?.created ?? 0), end: Number(c.time?.completed ?? 0) || undefined },
        },
      });
    }
  }
  parts.push({ id: stepFinishId(mid), sessionID, messageID: mid, type: 'step-finish', reason: m.finish, cost: m.cost, tokens: m.tokens });
  return {
    info: {
      id: mid,
      sessionID,
      role: 'assistant',
      time: { created: Number(m.time?.created ?? 0), completed: Number(m.time?.completed ?? 0) || undefined },
      modelID: m.model?.id,
      providerID: m.model?.providerID ? fromEngineProviderID(m.model.providerID) : undefined,
      tokens: m.tokens,
      cost: m.cost,
      ...(m.error ? { error: v1Error(m.error) } : {}),
    },
    parts,
  };
}
