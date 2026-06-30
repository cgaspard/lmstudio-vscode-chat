// Message protocol shared between the extension host and the webview.
import type { MessageWithParts, OpencodeEvent, PermissionResponse } from './opencode/protocol';

export interface UiModel {
  id: string;
  name: string;
  loaded: boolean;
  contextLength?: number;
  maxContextLength?: number;
  toolUse?: boolean;
  vision?: boolean;
  publisher?: string; // disambiguates same-named models (e.g. unsloth vs lmstudio-community)
  quantization?: string; // e.g. "8bit", "Q8_0"
  format?: string; // runtime format, e.g. "MLX" or "GGUF"
}

export interface UiSession {
  id: string;
  title: string;
  updated: number;
}

export interface UiServer {
  id: string;
  name: string;
  url: string;
}

/** A server-provided slash command (a user/built-in command, or a skill). */
export interface UiCommand {
  name: string;
  description: string;
  /** 'command' or 'skill' — lets the menu badge skills. */
  source: 'command' | 'skill';
  /** True if the command template takes arguments ($ARGUMENTS). */
  takesArgs: boolean;
}

/** One skill, as shown in the /skills panel. */
export interface UiSkill {
  name: string;
  description: string;
  /** 'project' (.opencode/skill or .claude/skills), 'global' (~/.claude), or 'built-in'. */
  source: 'project' | 'global' | 'built-in';
  /** Absolute SKILL.md path for disk skills (omitted for built-ins). */
  path?: string;
  /** Whether the skill is also invocable as a slash command. */
  slash?: boolean;
}

/** One MCP server's status, as shown in the /mcp panel. */
export interface UiMcpServer {
  name: string;
  /** 'connected' | 'disabled' | 'failed' | 'pending' (or any future status). */
  status: string;
  /** Failure reason, when status is 'failed'. */
  error?: string;
  /** 'local' (stdio) or 'remote' (http/sse), when known from the config. */
  transport?: 'local' | 'remote';
  /** The command (local) or url (remote) it was configured with, for display. */
  detail?: string;
}

// ---- Host -> Webview -----------------------------------------------------
export type HostToWebview =
  | {
      type: 'init';
      models: UiModel[];
      currentModel: string | null;
      agent: 'build' | 'plan';
      cwd: string;
      serverReady: boolean;
      lmStudioConnected: boolean;
      minContext: number;
    }
  | { type: 'models'; models: UiModel[]; currentModel: string | null }
  | { type: 'servers'; servers: UiServer[]; activeId: string; connected: boolean }
  | { type: 'sessions'; sessions: UiSession[]; currentSessionID: string | null }
  | { type: 'sessionLoaded'; sessionID: string; title: string; messages: MessageWithParts[] }
  | { type: 'cleared' }
  | { type: 'event'; event: OpencodeEvent }
  | { type: 'busy'; busy: boolean }
  // A /compact run is in flight (block input) or has finished (with the summary
  // text, if OpenCode produced one). `summary` is only set when done === true.
  | { type: 'compacting'; active: boolean; summary?: string }
  | { type: 'activeFile'; path: string | null; chars: number }
  // The current editor selection (or null when nothing is selected). Drives the
  // excludable "selection" pill in the composer; the raw text is attached as
  // context on send, not echoed here.
  | {
      type: 'activeSelection';
      selection: { path: string; startLine: number; endLine: number; chars: number } | null;
    }
  | { type: 'status'; text: string; kind?: 'info' | 'warn' | 'error' }
  | { type: 'command'; command: 'history' | 'newChat' | 'focusInput' }
  // Result of a /mcp request: the configured MCP servers and their live status.
  // `servers` is empty when none are configured.
  | { type: 'mcpStatus'; servers: UiMcpServer[] }
  // Result of a /skills request: the discovered skills (empty if none).
  | { type: 'skills'; skills: UiSkill[] }
  // Server-provided slash commands (skills + custom/built-in commands) to merge
  // into the composer's slash menu.
  | { type: 'commands'; commands: UiCommand[] }
  | { type: 'error'; message: string };

// ---- Webview -> Host -----------------------------------------------------
export interface UiImage {
  mime: string;
  dataUrl: string;
  name?: string;
}

export type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'send';
      text: string;
      thinking: boolean;
      images?: UiImage[];
      includeActiveFile?: boolean;
      includeSelection?: boolean;
    }
  | { type: 'selectModel'; modelID: string }
  | { type: 'loadModel'; modelID: string }
  | { type: 'unloadModel'; modelID: string }
  | { type: 'setContextSize'; tokens: number }
  | { type: 'refreshModels' }
  | { type: 'listServers' }
  | { type: 'addServer'; name: string; url: string }
  | { type: 'updateServer'; id: string; name: string; url: string }
  | { type: 'removeServer'; id: string }
  | { type: 'switchServer'; id: string }
  | { type: 'selectAgent'; agent: 'build' | 'plan' }
  | { type: 'newChat' }
  | { type: 'loadSessions' }
  | { type: 'loadSession'; sessionID: string }
  | { type: 'deleteSession'; sessionID: string }
  | { type: 'clearAllSessions' }
  | { type: 'compact' }
  | { type: 'abort' }
  | { type: 'permission'; sessionID: string; permissionID: string; response: PermissionResponse }
  | { type: 'questionReply'; requestID: string; answers: string[][] }
  | { type: 'questionReject'; requestID: string }
  | { type: 'openFile'; path: string }
  | { type: 'openInTab' }
  | { type: 'requestMcpStatus' }
  | { type: 'requestSkills' }
  // Run a server command/skill (e.g. typed "/fibonacci-helper some args").
  | { type: 'runCommand'; command: string; arguments?: string }
  | { type: 'retryConnect' };
