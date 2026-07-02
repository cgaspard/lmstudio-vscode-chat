import { log, logError } from '../logger';
import {
  CommandsResponse,
  McpStatusResponse,
  MessageWithParts,
  OpencodeEvent,
  PermissionResponse,
  PromptBody,
  ProvidersResponse,
  QuestionAnswer,
  Session,
  SkillsResponse,
} from './protocol';

/**
 * Thin HTTP client for a running OpenCode server. Uses the global `fetch`
 * (available in the VS Code extension host / Node 20+) plus manual SSE parsing
 * for the event stream — the same approach validated end to end against
 * LM Studio.
 */
export class OpencodeClient {
  constructor(private readonly baseUrl: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenCode ${method} ${path} -> ${res.status} ${res.statusText} ${text}`);
    }
    if (res.status === 204) {
      return undefined as unknown as T;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    return this.req('GET', '/global/health');
  }

  async listProviders(): Promise<ProvidersResponse> {
    return this.req('GET', '/config/providers');
  }

  /**
   * Live status of the configured MCP servers (`GET /mcp`): a map of server
   * name -> { status, error? }. Used by the `/mcp` panel so the user can see
   * which servers connected, which are disabled, and why a failed one failed.
   */
  async listMcp(): Promise<McpStatusResponse> {
    return this.req('GET', '/mcp');
  }

  /**
   * The skills OpenCode discovered (`GET /skill`): SKILL.md files from
   * <project>/.opencode/skill, <project>/.claude/skills, ~/.claude/skills, plus
   * built-ins. Used by the `/skills` panel so the user can confirm which skills
   * are available to the model.
   */
  async listSkills(): Promise<SkillsResponse> {
    return this.req('GET', '/skill');
  }

  /**
   * Commands OpenCode exposes (`GET /command`): user/built-in slash commands AND
   * skills, unified — each carries a `source` ("command" | "skill"). Used to
   * populate the slash menu with the real server command set.
   */
  async listCommands(): Promise<CommandsResponse> {
    return this.req('GET', '/command');
  }

  /**
   * Live per-session busy state (`GET /session/status`): a map of sessionID ->
   * { type: 'busy' | ... }. A session absent from the map is idle. Used by the
   * goal loop's watchdog to avoid judging while a turn is still running.
   */
  async sessionStatus(): Promise<Record<string, { type?: string }>> {
    return this.req('GET', '/session/status');
  }

  /**
   * Run a command or skill in a session (`POST /session/{id}/command`). The
   * server expands the command/skill template (with `arguments` substituted for
   * $ARGUMENTS) and runs it; output streams over the event channel like a normal
   * prompt. `agent`/`model` pin who runs it.
   */
  async runCommand(
    sessionID: string,
    body: { command: string; arguments?: string; agent?: string; model?: string },
  ): Promise<void> {
    await this.req('POST', `/session/${sessionID}/command`, body);
  }

  async createSession(title?: string): Promise<Session> {
    return this.req('POST', '/session', { title: title ?? 'New chat' });
  }

  async listSessions(): Promise<Session[]> {
    const all = await this.req<Session[]>('GET', '/session');
    // Top-level sessions only (skip subtask children), newest first.
    return all
      .filter((s) => !s.parentID)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  }

  async getMessages(sessionID: string): Promise<MessageWithParts[]> {
    return this.req('GET', `/session/${sessionID}/message`);
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.req('DELETE', `/session/${sessionID}`);
  }

  async updateSession(sessionID: string, body: { title?: string }): Promise<void> {
    await this.req('PATCH', `/session/${sessionID}`, body);
  }

  async abort(sessionID: string): Promise<void> {
    await this.req('POST', `/session/${sessionID}/abort`, {});
  }

  /**
   * Compact the conversation in place via AI summarization — the same operation
   * OpenCode's TUI runs for `/compact`. `providerID`/`modelID` are required by
   * the server (v1 `POST /session/{id}/summarize`). Progress surfaces over the
   * event stream as a `session.compacted` event, so this returns once accepted.
   */
  async summarize(sessionID: string, providerID: string, modelID: string): Promise<void> {
    await this.req('POST', `/session/${sessionID}/summarize`, { providerID, modelID });
  }

  /** Fire-and-forget prompt; the response streams over the event channel. */
  async promptAsync(sessionID: string, body: PromptBody): Promise<void> {
    await this.req('POST', `/session/${sessionID}/prompt_async`, body);
  }

  async respondPermission(
    sessionID: string,
    permissionID: string,
    response: PermissionResponse,
  ): Promise<void> {
    await this.req('POST', `/session/${sessionID}/permissions/${permissionID}`, { response });
  }

  /**
   * Answer a pending question from the built-in `question` tool. `answers` has
   * one entry per question (in order); each entry is the list of chosen option
   * labels (plus any typed custom answer).
   */
  async replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void> {
    await this.req('POST', `/question/${requestID}/reply`, { answers });
  }

  /** Dismiss a pending question without answering (the run continues). */
  async rejectQuestion(requestID: string): Promise<void> {
    await this.req('POST', `/question/${requestID}/reject`, {});
  }

  /**
   * Subscribe to the global SSE event stream. Calls `onEvent` for every event.
   * Automatically reconnects until `signal` aborts. Resolves only when aborted.
   */
  async subscribeEvents(
    onEvent: (event: OpencodeEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.baseUrl}/event`, { signal });
        if (!res.ok || !res.body) {
          throw new Error(`event stream HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) {
              continue;
            }
            const payload = dataLine.slice(5).trim();
            if (!payload) {
              continue;
            }
            try {
              const event = JSON.parse(payload) as OpencodeEvent;
              onEvent(event);
            } catch (err) {
              logError('failed to parse SSE event', err);
            }
          }
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        logError('event stream interrupted, reconnecting in 1s', err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
