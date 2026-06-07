import * as vscode from 'vscode';
import { normalizeServerUrl } from './core/url';

// Re-exported so existing importers keep the same entry point; the
// implementation lives in the pure core module for unit testing.
export { normalizeServerUrl };

export interface LmServer {
  id: string;
  name: string;
  url: string; // normalized, ends in /vN
}

let counter = 0;
function genId(): string {
  return 'srv_' + Date.now().toString(36) + (counter++).toString(36);
}

const SERVERS_KEY = 'lmstudioCode.servers';
const ACTIVE_KEY = 'lmstudioCode.activeServer';

/** Persisted registry of LM Studio servers the user can switch between. */
export class ServerRegistry {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly defaultUrl: string,
  ) {}

  list(): LmServer[] {
    let servers = this.context.globalState.get<LmServer[]>(SERVERS_KEY);
    if (!servers || !servers.length) {
      servers = [{ id: genId(), name: 'Local', url: normalizeServerUrl(this.defaultUrl) }];
      void this.context.globalState.update(SERVERS_KEY, servers);
    }
    return servers;
  }

  active(): LmServer {
    const servers = this.list();
    const id = this.context.globalState.get<string>(ACTIVE_KEY);
    return servers.find((s) => s.id === id) ?? servers[0];
  }

  async setActive(id: string): Promise<void> {
    await this.context.globalState.update(ACTIVE_KEY, id);
  }

  async add(name: string, url: string): Promise<LmServer> {
    const servers = this.list();
    const server: LmServer = { id: genId(), name: (name || '').trim() || 'Server', url: normalizeServerUrl(url) };
    servers.push(server);
    await this.context.globalState.update(SERVERS_KEY, servers);
    return server;
  }

  async update(id: string, name: string, url: string): Promise<void> {
    const servers = this.list().map((s) =>
      s.id === id ? { ...s, name: (name || '').trim() || s.name, url: normalizeServerUrl(url) } : s,
    );
    await this.context.globalState.update(SERVERS_KEY, servers);
  }

  async remove(id: string): Promise<void> {
    let servers = this.list().filter((s) => s.id !== id);
    if (!servers.length) {
      servers = [{ id: genId(), name: 'Local', url: normalizeServerUrl(this.defaultUrl) }];
    }
    await this.context.globalState.update(SERVERS_KEY, servers);
    if (this.active().id === id) {
      await this.setActive(servers[0].id);
    }
  }
}
