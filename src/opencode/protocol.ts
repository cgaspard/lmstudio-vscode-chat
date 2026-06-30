// Types mirroring the subset of the OpenCode HTTP API (v1.2.x) that this
// extension uses. Derived from the server's OpenAPI 3.1 spec (`GET /doc`).

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface Session {
  id: string;
  slug?: string;
  projectID?: string;
  directory?: string;
  parentID?: string;
  title: string;
  version?: string;
  time: { created: number; updated: number };
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: Record<string, { name?: string }>;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  default: Record<string, string>;
}

// ---- MCP status ----------------------------------------------------------
// `GET /mcp` returns a map of server name -> live connection state. Observed
// shapes from OpenCode 1.16.x: { status: 'connected' | 'disabled' | 'failed',
// error?: string }. We keep it loose so an added field never breaks parsing.

export type McpServerStatus = 'connected' | 'disabled' | 'failed' | 'pending' | string;

export interface McpServerState {
  status: McpServerStatus;
  error?: string;
  [k: string]: unknown;
}

/** Map of MCP server name -> its current connection state. */
export type McpStatusResponse = Record<string, McpServerState>;

// ---- Message parts -------------------------------------------------------

export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
  time?: { start: number; end?: number };
}

export interface ReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
  time?: { start: number; end?: number };
}

export type ToolStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ToolState {
  status: ToolStatus;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number; end?: number };
}

export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
}

export interface FilePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}

export interface StepStartPart {
  id: string;
  type: 'step-start';
  sessionID: string;
  messageID: string;
}

export interface StepFinishPart {
  id: string;
  type: 'step-finish';
  sessionID: string;
  messageID: string;
  reason?: string;
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number };
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | StepStartPart
  | StepFinishPart
  | { id: string; type: string; sessionID: string; messageID: string; [k: string]: unknown };

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: { created: number; completed?: number };
  modelID?: string;
  providerID?: string;
  error?: unknown;
  tokens?: { input: number; output: number; reasoning: number; total?: number };
  cost?: number;
}

export interface MessageWithParts {
  info: MessageInfo;
  parts: Part[];
}

// ---- Permissions ---------------------------------------------------------

export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
}

export type PermissionResponse = 'once' | 'always' | 'reject';

// ---- Questions (the built-in `question`/ask tool) ------------------------
// Mirrors the server's v2 question API: the model calls the `question` tool,
// the server emits `question.asked` with this shape, and the client replies
// via POST /question/{id}/reply with one answer array per question (each entry
// is the list of chosen option labels), or rejects via /question/{id}/reject.

export interface QuestionOption {
  /** Display text (1-5 words). */
  label: string;
  /** Explanation of the choice. */
  description: string;
}

export interface QuestionInfo {
  /** The complete question text. */
  question: string;
  /** Very short label / chip (max ~30 chars). */
  header: string;
  options: QuestionOption[];
  /** Allow selecting multiple options. */
  multiple?: boolean;
  /** Allow a typed custom answer (default true). */
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
}

/** One answer per question, in order; each is the list of selected labels. */
export type QuestionAnswer = string[];

// ---- Events --------------------------------------------------------------

export interface OpencodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

// Prompt body for POST /session/{id}/prompt_async
export interface FilePartInputSource {
  type: 'file';
  path: string;
  text: { value: string; start: number; end: number };
}

export interface PromptBody {
  model: ModelRef;
  agent?: string;
  system?: string;
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; mime: string; url: string; filename?: string; source?: FilePartInputSource }
  >;
}
