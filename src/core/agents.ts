/**
 * Agent classification and context-overhead math. Pure so it is unit-testable
 * and browser-safe.
 *
 * OpenCode agents are not just specialized prompts: each carries its own model,
 * tool allow/deny map, permissions, temperature, step cap and reasoning variant.
 * A subagent additionally runs in its OWN child session with its own context
 * window, returning only its final text to the parent — which is why delegation
 * saves parent context rather than spending it.
 *
 * `mode` splits agents into two overlapping audiences, and the distinction is
 * the whole reason this module exists:
 *
 *   primary   → the user picks it in the composer. Never delegated to.
 *   subagent  → the model delegates to it via the `task` tool. Not user-pickable.
 *   all       → both.
 *
 * Verified against OpenCode 1.18.4: `describeTask` lists every agent whose mode
 * is not `primary`, and the CLI refuses a `subagent` as a primary selection
 * ("is a subagent, not a primary agent"). `hidden` only affects UI listings —
 * a hidden subagent is still delegated to.
 */

export interface AgentInfo {
  name: string;
  description?: string;
  /** 'primary' | 'subagent' | 'all'. Absent is treated as 'primary'. */
  mode?: string;
  /** True for OpenCode's built-ins (build/plan/general/explore/title/...). */
  native?: boolean;
  /** Internal agents (title/summary/compaction) that no UI should list. */
  hidden?: boolean;
  model?: { providerID?: string; modelID?: string } | null;
  /** Per-tool enable/disable map. */
  tools?: Record<string, boolean>;
  color?: string;
  variant?: string;
}

/** Agents the user can select as the driver of a turn. */
export function pickableAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents
    .filter((a) => !a.hidden && (a.mode ?? 'primary') !== 'subagent')
    .sort(byBuiltInsFirst);
}

/**
 * Agents the model can delegate to. Deliberately ignores `hidden` — verified
 * that a hidden subagent still appears in the `task` tool's description, so
 * counting it is what keeps the overhead estimate honest.
 */
export function delegatableAgents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => (a.mode ?? 'primary') !== 'primary').sort(byBuiltInsFirst);
}

/** build/plan first (the familiar pair), then custom agents alphabetically. */
function byBuiltInsFirst(a: AgentInfo, b: AgentInfo): number {
  const rank = (x: AgentInfo) => (x.name === 'build' ? 0 : x.name === 'plan' ? 1 : 2);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/** True when the user's stored agent no longer exists (deleted/renamed on disk). */
export function resolveAgent(stored: string | undefined, agents: AgentInfo[]): string {
  const pickable = pickableAgents(agents);
  if (stored && pickable.some((a) => a.name === stored)) {
    return stored;
  }
  // Fall back to build, then to whatever is first, so a stale selection can
  // never leave the composer pointing at an agent the server doesn't have.
  return pickable.find((a) => a.name === 'build')?.name ?? pickable[0]?.name ?? 'build';
}

// ---- Context overhead ------------------------------------------------------
// Every request carries a fixed preamble the conversation never sees: the
// agent's system prompt plus all tool schemas. Measured against OpenCode 1.18.4
// with the LM Studio provider: ~5.6k for the 12 tool schemas, and a system
// prompt that varies by agent (plan is much lighter than build, since it drops
// the edit tooling and its instructions).

/** Tool schemas sent on every request, independent of agent. */
export const TOOL_SCHEMA_TOKENS = 5600;

/** System-prompt size by agent, for the agents whose prompts we control. */
const PROMPT_TOKENS: Record<string, number> = {
  build: 5400,
  plan: 1600,
};

/** Fallback for a user-defined agent whose prompt length we don't know. */
const DEFAULT_PROMPT_TOKENS = 2000;

/**
 * Tokens each delegatable agent adds to the PRIMARY session, by appending its
 * name + description to the `task` tool description. Measured at ~32 tokens per
 * agent (~319 for ten).
 *
 * Note this is the only way another agent costs the current session anything:
 * a subagent's own prompt and tool traffic live in its own child session.
 */
export const TOKENS_PER_DELEGATABLE_AGENT = 32;

/**
 * Fixed per-request overhead for a session driven by `agentName`.
 *
 * The old model was a hardcoded `plan ? 6000 : 11000`, which breaks in two ways
 * once agents are user-definable: it can't account for a custom agent's prompt,
 * and it ignores that every delegatable agent grows the `task` tool description.
 */
export function agentOverheadTokens(
  agentName: string,
  agents: AgentInfo[],
  promptTokens: Record<string, number> = PROMPT_TOKENS,
): number {
  const prompt = promptTokens[agentName] ?? DEFAULT_PROMPT_TOKENS;
  const delegatable = delegatableAgents(agents).length;
  return prompt + TOOL_SCHEMA_TOKENS + delegatable * TOKENS_PER_DELEGATABLE_AGENT;
}

/** Human label for the picker: "reviewer (custom)" disambiguates from built-ins. */
export function agentLabel(a: AgentInfo): string {
  return a.native === false ? `${a.name} (custom)` : a.name;
}

/**
 * Tooltip for a picker entry — the description is what the model itself sees
 * when deciding whether to delegate, so showing it helps users write good ones.
 */
export function agentTooltip(a: AgentInfo): string {
  const bits: string[] = [];
  if (a.description) {
    bits.push(a.description);
  }
  if ((a.mode ?? 'primary') === 'all') {
    bits.push('Selectable here, and the model may also delegate to it.');
  }
  if (a.model?.modelID) {
    bits.push(`Always runs on ${a.model.modelID}.`);
  }
  return bits.join(' ');
}
