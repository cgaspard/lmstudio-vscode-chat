// A scripted OpenAI-compatible model server that "thinks": its chat stream
// carries reasoning_content deltas before the answer, the way LM Studio streams
// a reasoning model. Lets the e2e prove the thinking UI end to end (engine
// parses reasoning, events flow, the panel draws the block) without loading a
// large reasoning model into a shared LM Studio.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export const THINKER_MODEL = 'e2e/thinker';
export const THINKING = 'Let me think. 17 times 20 is 340, plus 17 times 3 is 51, so 391.';
export const ANSWER = 'The answer is 391.';

export class FakeThinker {
  private server: http.Server | undefined;
  port = 0;
  /** Every chat request body received, oldest first. */
  readonly requests: Array<Record<string, unknown>> = [];

  get url(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    switch (path) {
      // The extension's LM Studio probes: reachable, one model, already loaded
      // with a window big enough that the panel never asks to reload it.
      case '/lmstudio-greeting':
        return json({ lmstudio: true });
      case '/api/v1/models':
        return json({
          models: [
            {
              key: THINKER_MODEL,
              type: 'llm',
              max_context_length: 65536,
              capabilities: { trained_for_tool_use: true, reasoning: { allowed_options: ['off', 'on'] } },
              loaded_instances: [{ config: { context_length: 65536 } }],
            },
          ],
        });
      case '/api/v0/models':
        return json({ data: [{ id: THINKER_MODEL, state: 'loaded', loaded_context_length: 65536, max_context_length: 65536 }] });
      case '/v1/models':
        return json({ data: [{ id: THINKER_MODEL, object: 'model' }] });
      case '/v1/chat/completions':
        return this.chat(req, res);
      default:
        res.statusCode = 404;
        return void res.end('{}');
    }
  }

  private chat(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        this.requests.push(JSON.parse(body));
      } catch {
        // not JSON: nothing to record
      }
      const stream = (() => {
        try {
          return JSON.parse(body).stream !== false;
        } catch {
          return true;
        }
      })();
      const id = `chatcmpl-${Date.now()}`;
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: THINKER_MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      if (!stream) {
        return void res.end(
          JSON.stringify({ id, object: 'chat.completion', model: THINKER_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: ANSWER, reasoning_content: THINKING }, finish_reason: 'stop' }] }),
        );
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const pieces: string[] = [
        chunk({ role: 'assistant', content: '' }),
        ...THINKING.split(' ').map((w, i) => chunk({ reasoning_content: (i ? ' ' : '') + w })),
        ...ANSWER.split(' ').map((w, i) => chunk({ content: (i ? ' ' : '') + w })),
        chunk({}, 'stop', { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 18 } }),
        'data: [DONE]\n\n',
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= pieces.length || res.destroyed) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(pieces[i++]);
      }, 15);
    });
  }
}
