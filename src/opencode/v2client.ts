import { log, logError } from '../logger';
import type { SdkHost } from './embedded';
import type {
  AgentsResponse,
  CommandsResponse,
  McpStatusResponse,
  MessageWithParts,
  OpencodeEvent,
  PermissionResponse,
  PromptBody,
  ProviderInfo,
  ProvidersResponse,
  QuestionAnswer,
  Session,
  SkillsResponse,
} from './protocol';
import { fromEngineProviderID, toEngineProviderID } from '../core/providerIds';
import { EventTranslator, type InboxItem, v1History, v2FormAnswer } from './translate';

/** How a prompt reaches a session that is already working. */
export type Delivery = 'steer' | 'queue';

/** Instruction-entry key carrying the panel's per-prompt system text. */
const SYSTEM_ENTRY = 'lmstudio-vscode-chat.system'; // keys: ^[a-z0-9][a-z0-9._-]*$ (no slash)

/** Longest we wait for a compaction to finish before handing control back. */
const COMPACT_TIMEOUT_MS = 900000;

/** Ceiling for one SDK call, as the 1.x HTTP client had per request. */
const REQ_TIMEOUT_MS = 30000;

/** Longest we wait for a fresh engine to finish loading its agents, commands and skills. */
const CATALOG_READY_MS = 15000;

/** Reject with a TimeoutError (which the bridge treats as a lost connection) after `ms`. */
function withTimeout<T>(p: Promise<T> | T, ms: number, what: string): Promise<T> {
  if (!(p instanceof Promise)) {
    return Promise.resolve(p);
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`OpenCode ${what} did not answer within ${ms / 1000}s`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type Listener = (event: OpencodeEvent) => void;

/**
 * The bridge's view of OpenCode, backed by the embedded v2 SDK.
 *
 * Keeps the method surface the bridge was written against (it used to be an
 * HTTP client for a spawned 1.x server) so the engine swap stays contained,
 * and adds the v2-only operations the panel now exposes: steering delivery and
 * the pending inbox.
 *
 * One upstream event subscription serves every panel; translation state is
 * shared so a question reply or inbox action can find what its event carried.
 */
export class OpencodeV2Client {
  private readonly translator = new EventTranslator();
  private readonly listeners = new Set<Listener>();
  private upstream: AbortController | undefined;
  /** Last model/agent/system pushed to each session, to skip redundant switches. */
  private readonly sessionState = new Map<string, { model?: string; agent?: string; system?: string }>();

  /** The SDK host behind a guard: see `guard`. */
  private readonly host: SdkHost;
  private closed = false;
  /** Resolves once the workspace's agents, commands and skills are loaded: see `catalogReady`. */
  private catalog: Promise<void> | undefined;

  constructor(
    host: SdkHost,
    /** The workspace folder every request is located in. */
    private readonly directory: string,
    readonly version: string,
  ) {
    this.host = this.guard(host, []);
  }

  /**
   * Every SDK call goes through here. A 1.x server that went away failed fast
   * ("connection refused") and the bridge reconnected; an embedded host that
   * was closed (a settings change, a restart) would instead leave calls
   * pending forever. So once disposed, calls reject at once with an error the
   * bridge treats as a lost connection, and every call gets the same ceiling
   * the 1.x client had. The event stream is exempt: it is meant to stay open.
   */
  private guard(target: any, path: string[]): any {
    return new Proxy(target, {
      get: (obj, prop) => {
        const value = obj[prop];
        if (typeof prop !== 'string') {
          return value;
        }
        if (typeof value === 'function') {
          const name = [...path, prop].join('.');
          return (...args: unknown[]) => {
            if (this.closed) {
              return Promise.reject(new Error('OpenCode engine stopped'));
            }
            const result = value.apply(obj, args);
            return name === 'event.subscribe' ? result : withTimeout(result, REQ_TIMEOUT_MS, name);
          };
        }
        return value && typeof value === 'object' ? this.guard(value, [...path, prop]) : value;
      },
    });
  }

  private get location() {
    return { location: { directory: this.directory } };
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    return { healthy: true, version: this.version };
  }

  // ---- Catalog ---------------------------------------------------------------

  /**
   * A freshly created engine answers catalog calls before it has read the
   * workspace: for a few hundred milliseconds agent, command and skill lists
   * come back empty (not even the built-in `build` agent). The panel asks for
   * them right after start, so it would show a picker without the user's
   * agents and a slash menu without their commands. Wait until the built-in
   * agents appear — every list is loaded together — or give up after a while
   * and let the caller see whatever the engine has.
   */
  private catalogReady(): Promise<void> {
    if (!this.catalog) {
      this.catalog = (async () => {
        const end = Date.now() + CATALOG_READY_MS;
        while (Date.now() < end) {
          const res = await this.host.agent.list(this.location);
          if (((res?.data ?? res ?? []) as unknown[]).length) {
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        log('embedded opencode: agents still empty after waiting; continuing');
      })().catch((err) => {
        this.catalog = undefined; // a failed probe must not wedge later calls
        throw err;
      });
    }
    return this.catalog;
  }

  async listProviders(): Promise<ProvidersResponse> {
    await this.catalogReady();
    const [models, providers] = await Promise.all([this.host.model.list(this.location), this.host.provider.list(this.location)]);
    const names = new Map<string, string>(((providers?.data ?? []) as any[]).map((p) => [String(p.id), String(p.name ?? p.id)]));
    const byProvider = new Map<string, ProviderInfo>();
    for (const m of (models?.data ?? []) as any[]) {
      const enginePid = String(m.providerID);
      const pid = fromEngineProviderID(enginePid);
      let p = byProvider.get(pid);
      if (!p) {
        p = { id: pid, name: names.get(enginePid) ?? pid, models: {} };
        byProvider.set(pid, p);
      }
      const input: string[] = Array.isArray(m.capabilities?.input) ? m.capabilities.input : ['text'];
      const variants: Record<string, unknown> = Object.fromEntries(
        (Array.isArray(m.variants) ? m.variants : []).map((v: any) => [String(v.id), v.settings ?? {}]),
      );
      const cost = Array.isArray(m.cost) ? m.cost[0] : m.cost;
      p.models[String(m.id)] = {
        id: String(m.id),
        name: m.name,
        family: m.family,
        capabilities: {
          // v2 dropped the boolean; a model with effort variants reasons.
          reasoning: m.capabilities?.reasoning ?? Object.keys(variants).length > 0,
          toolcall: m.capabilities?.tools !== false,
          attachment: input.includes('image') || input.includes('pdf'),
          input: { text: input.includes('text'), image: input.includes('image'), pdf: input.includes('pdf') },
        },
        ...(cost && (cost.input !== undefined || cost.output !== undefined) ? { cost: { input: cost.input, output: cost.output } } : {}),
        limit: m.limit,
        variants,
        status: m.status,
      };
    }
    return { providers: [...byProvider.values()], default: {} };
  }

  async listAgents(): Promise<AgentsResponse> {
    await this.catalogReady();
    const res = await this.host.agent.list(this.location);
    // v2's `name` is a display label ("Build"); the id is what switchAgent and
    // the 1.x code (and the user's settings) call it.
    return ((res?.data ?? res ?? []) as any[]).map((a) => ({
      ...a,
      name: String(a.id ?? a.name),
      displayName: a.name,
      description: a.description,
      mode: a.mode,
      native: a.native ?? a.builtin,
      hidden: a.hidden,
    }));
  }

  async listCommands(): Promise<CommandsResponse> {
    await this.catalogReady();
    const res = await this.host.command.list(this.location);
    return ((res?.data ?? res ?? []) as any[]).map((c) => ({ ...c, name: String(c.name ?? c.id), description: c.description }));
  }

  async listSkills(): Promise<SkillsResponse> {
    await this.catalogReady();
    const res = await this.host.skill.list(this.location);
    return ((res?.data ?? res ?? []) as any[]).map((s) => ({
      ...s,
      name: String(s.name ?? s.id),
      description: String(s.description ?? ''),
      location: String(s.location ?? s.path ?? ''),
      content: String(s.content ?? s.text ?? ''),
    }));
  }

  async listMcp(): Promise<McpStatusResponse> {
    await this.catalogReady();
    const res = await this.host.mcp.list(this.location);
    const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    const out: McpStatusResponse = {};
    for (const s of rows) {
      out[String(s.name ?? s.id)] = { ...s, status: String(s.status?.type ?? s.status ?? 'pending'), error: s.status?.error ?? s.error };
    }
    return out;
  }

  // ---- Sessions ----------------------------------------------------------------

  async createSession(title?: string): Promise<Session> {
    const s = await this.host.session.create({ ...(title ? { title } : {}), ...this.location });
    return v1Session(s);
  }

  /** This workspace's top-level sessions, newest first. */
  async listSessions(): Promise<Session[]> {
    // Sessions filter on `directory`; a request location does not scope them.
    const rows: any[] = [];
    let res = await this.host.session.list({ directory: this.directory, limit: 200 });
    for (let page = 0; page < 50; page++) {
      rows.push(...((res?.data ?? []) as any[]));
      const next: string | undefined = res?.cursor?.next;
      if (!next || !(res?.data ?? []).length) {
        break;
      }
      res = await this.host.session.list({ cursor: next, limit: 200 });
    }
    return rows.filter((s) => !s.parentID).map(v1Session);
  }

  async getMessages(sessionID: string): Promise<MessageWithParts[]> {
    const rows: unknown[] = [];
    // Oldest first, following cursor.next (an order may not be combined with a cursor).
    let res = await this.host.message.list({ sessionID, order: 'asc', limit: 200 });
    for (let page = 0; page < 500; page++) {
      rows.push(...((res?.data ?? []) as unknown[]));
      const next: string | undefined = res?.cursor?.next;
      if (!next || !(res?.data ?? []).length) {
        break;
      }
      res = await this.host.message.list({ sessionID, cursor: next, limit: 200 });
    }
    return v1History(sessionID, rows as any[]);
  }

  async deleteSession(sessionID: string): Promise<void> {
    this.sessionState.delete(sessionID);
    await this.host.session.remove({ sessionID });
  }

  async updateSession(sessionID: string, body: { title?: string }): Promise<void> {
    await this.host.session.update({ sessionID, ...body });
  }

  /** Session ids currently executing, in the 1.x `{id: {type}}` shape. */
  async sessionStatus(): Promise<Record<string, { type?: string }>> {
    const res = await this.host.session.active(this.location);
    const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    return Object.fromEntries(rows.map((r) => [String(r.id ?? r.sessionID ?? r), { type: 'busy' }]));
  }

  // ---- Prompting ---------------------------------------------------------------

  /**
   * Send a prompt. In v2 the model, reasoning variant and agent are session
   * state rather than per-prompt fields, and there is no per-prompt system
   * text, so each is pushed to the session first — only when it changed.
   *
   * `delivery` matters only while the session is already working: `steer`
   * injects at the agent's next step, `queue` waits for the current run to end.
   */
  async promptAsync(sessionID: string, body: PromptBody & { delivery?: Delivery }): Promise<void> {
    await this.applySessionState(sessionID, body);
    const text = body.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    const files = body.parts.filter((p) => p.type === 'file').map(v2File);
    await this.host.session.prompt({
      sessionID,
      text,
      ...(files.length ? { files } : {}),
      delivery: body.delivery ?? 'steer',
    });
  }

  async runCommand(
    sessionID: string,
    body: { command: string; arguments?: string; agent?: string; model?: string; variant?: string },
  ): Promise<void> {
    if (body.model) {
      const slash = body.model.indexOf('/');
      await this.applySessionState(sessionID, {
        model: { providerID: body.model.slice(0, slash), modelID: body.model.slice(slash + 1) },
        agent: body.agent,
        variant: body.variant,
      });
    }
    await this.host.session.command({ sessionID, name: body.command, text: body.arguments ?? '' });
  }

  private async applySessionState(
    sessionID: string,
    body: { model?: { providerID: string; modelID: string }; agent?: string; variant?: string; system?: string },
  ): Promise<void> {
    const st = this.sessionState.get(sessionID) ?? {};
    if (body.model) {
      const key = `${body.model.providerID}/${body.model.modelID}#${body.variant ?? ''}`;
      if (st.model !== key) {
        await this.host.session.switchModel({
          sessionID,
          model: { providerID: toEngineProviderID(body.model.providerID), id: body.model.modelID, ...(body.variant ? { variant: body.variant } : {}) },
        });
        st.model = key;
      }
    }
    if (body.agent && st.agent !== body.agent) {
      await this.host.session.switchAgent({ sessionID, agent: body.agent });
      st.agent = body.agent;
    }
    if (body.system !== undefined && st.system !== body.system) {
      try {
        if (body.system) {
          await this.host.session.instructions.entry.put({ sessionID, key: SYSTEM_ENTRY, value: body.system });
        } else {
          await this.host.session.instructions.entry.remove({ sessionID, key: SYSTEM_ENTRY });
        }
        st.system = body.system;
      } catch (err) {
        // Experimental surface: losing the panel's extra instructions degrades
        // the prompt, it must not block it.
        logError('could not set session instructions', err);
      }
    }
    this.sessionState.set(sessionID, st);
  }

  /** Stop the running turn. */
  async abort(sessionID: string): Promise<void> {
    await this.host.session.interrupt({ sessionID });
  }

  /**
   * Compact the conversation. v2 returns as soon as compaction is scheduled; the
   * bridge was built for 1.x, which held the call open until the summary
   * existed, so wait for the outcome here.
   */
  async summarize(sessionID: string, _providerID: string, _modelID: string): Promise<void> {
    const done = this.waitFor(
      (e) => (e.type === 'session.compacted' || e.type === 'session.error') && (e.properties as any).sessionID === sessionID,
      COMPACT_TIMEOUT_MS,
    );
    await this.host.session.compact({ sessionID });
    const outcome = await done;
    if (outcome?.type === 'session.error') {
      throw new Error(String((outcome.properties as any).error?.data?.message ?? 'Compaction failed'));
    }
  }

  // ---- Steering inbox ------------------------------------------------------------

  /** Prompts sent while the session was busy that the agent has not picked up yet. */
  pendingInbox(sessionID: string): InboxItem[] {
    return this.translator.pending(sessionID);
  }

  /** Switch a pending prompt between steering (next step) and queueing (after the run). */
  async setDelivery(sessionID: string, inboxID: string, delivery: Delivery): Promise<void> {
    await this.host.session.inbox.update({ sessionID, inboxID, delivery });
  }

  /** Withdraw a pending prompt before the agent sees it. */
  async cancelPending(sessionID: string, inboxID: string): Promise<void> {
    await this.host.session.inbox.cancel({ sessionID, inboxID });
  }

  // ---- Approvals and questions -----------------------------------------------------

  async respondPermission(sessionID: string, permissionID: string, response: PermissionResponse): Promise<void> {
    await this.host.permission.reply({ sessionID, requestID: permissionID, decision: response });
  }

  async replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void> {
    const form = this.translator.formFor(requestID);
    if (!form) {
      throw new Error('That question is no longer open.');
    }
    await this.host.session.form.reply({ sessionID: form.sessionID, formID: requestID, answer: v2FormAnswer(form, answers) });
  }

  async rejectQuestion(requestID: string): Promise<void> {
    const form = this.translator.formFor(requestID);
    if (!form) {
      return;
    }
    await this.host.session.form.cancel({ sessionID: form.sessionID, formID: requestID });
  }

  // ---- Events -----------------------------------------------------------------------

  /**
   * Deliver translated events until `signal` aborts. Panels share one upstream
   * subscription; the first subscriber starts it.
   */
  async subscribeEvents(onEvent: Listener, signal: AbortSignal): Promise<void> {
    this.listeners.add(onEvent);
    this.ensureUpstream();
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    this.listeners.delete(onEvent);
  }

  private ensureUpstream(): void {
    if (this.upstream) {
      return;
    }
    const ac = new AbortController();
    this.upstream = ac;
    void (async () => {
      try {
        for await (const e of this.host.event.subscribe(undefined, { signal: ac.signal })) {
          for (const out of this.translator.translate(e)) {
            this.emit(out);
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          logError('embedded event stream ended', err);
        }
      } finally {
        if (this.upstream === ac) {
          this.upstream = undefined;
          // The SDK does not replay or reconnect. Resubscribe while anyone listens.
          if (!ac.signal.aborted && this.listeners.size) {
            log('resubscribing to the embedded event stream');
            setTimeout(() => this.ensureUpstream(), 250);
          }
        }
      }
    })();
  }

  private emit(event: OpencodeEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        logError('event listener threw', err);
      }
    }
  }

  /** Resolve with the first event matching `pred`, or undefined after `ms`. */
  private waitFor(pred: (e: OpencodeEvent) => boolean, ms: number): Promise<OpencodeEvent | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        resolve(undefined);
      }, ms);
      const l: Listener = (e) => {
        if (pred(e)) {
          clearTimeout(timer);
          this.listeners.delete(l);
          resolve(e);
        }
      };
      this.listeners.add(l);
      this.ensureUpstream();
    });
  }

  /** Stop the upstream subscription (the host itself is closed by its owner). */
  dispose(): void {
    this.closed = true;
    this.upstream?.abort();
    this.upstream = undefined;
    this.listeners.clear();
  }
}

function v1Session(s: any): Session {
  const created = Number(s?.time?.created ?? 0);
  return {
    id: String(s.id),
    title: String(s.title ?? ''),
    projectID: s.projectID,
    directory: s.location?.directory,
    parentID: s.parentID,
    time: { created, updated: Number(s?.time?.updated ?? created) },
  };
}

/** A 1.x file part (data: URL image, or a workspace file with its text) → a v2 attachment. */
function v2File(p: PromptBody['parts'][number]): Record<string, unknown> {
  const f = p as { mime: string; url: string; filename?: string; source?: { path: string; text: { value: string } } };
  if (f.url.startsWith('data:')) {
    const comma = f.url.indexOf(',');
    return { data: f.url.slice(comma + 1), mime: f.mime, source: { type: 'inline' }, ...(f.filename ? { name: f.filename } : {}) };
  }
  // A workspace file or selection: inline its text, keep where it came from.
  const text = f.source?.text?.value ?? '';
  return {
    data: Buffer.from(text, 'utf8').toString('base64'),
    mime: f.mime || 'text/plain',
    source: { type: 'uri', uri: f.url },
    ...(f.filename ? { name: f.filename } : {}),
  };
}
