/**
 * Generation-rate accounting for a turn. Pure so it is unit-testable and
 * browser-safe.
 *
 * Why this is not just (tokens / wall-clock):
 *
 * An agentic turn is not one continuous stream. It is bursts of generation
 * separated by tool execution (file reads, shell commands) and per-step prompt
 * reprocessing, during which the model emits nothing. Dividing tokens by total
 * wall-clock counts all that dead air as generation time, so a turn with a few
 * tool calls reports a rate far below what the model actually sustains.
 *
 * Instead we accumulate only the gaps BETWEEN consecutive deltas, discarding any
 * gap longer than IDLE_GAP_MS — those are tool calls or step boundaries, not
 * slow tokens. What's left is time the model was demonstrably producing output.
 *
 * Token counts: LM Studio does report real usage now (it did not when the
 * original estimate was written), and OpenCode surfaces it on the assistant
 * message as { input, output, reasoning, cache }. We prefer those exact numbers
 * and fall back to a chars/4 estimate mid-stream, before the totals land.
 */

/**
 * Longest gap between two deltas still counted as generation time. Local models
 * typically emit every 10–100ms; anything beyond a second is a tool call or a
 * step boundary, not a slow token. Deliberately generous so a genuinely slow
 * model on loaded hardware isn't penalized.
 */
export const IDLE_GAP_MS = 2000;

/** Rough chars-per-token for the pre-usage estimate. */
const CHARS_PER_TOKEN = 4;

export interface TurnRate {
  /** Accumulated active generation time, ms (excludes tool/step gaps). */
  activeMs: number;
  /** Wall-clock from first to last delta, ms (includes the gaps). */
  wallMs: number;
  /** Streamed chars, split by kind. */
  textChars: number;
  reasoningChars: number;
  /** Exact counts from the assistant message, when they've arrived. */
  tokens?: { input?: number; output?: number; reasoning?: number; total?: number };
  /** Which agent ran the turn, from AssistantMessage.agent. */
  agent?: string;
  /** Timestamp of the previous delta, for gap math. */
  lastDeltaAt: number;
  firstDeltaAt: number;
  /** Explicit, because a timestamp of 0 is falsy and would restart the turn. */
  started: boolean;
}

export function newTurnRate(): TurnRate {
  return {
    activeMs: 0,
    wallMs: 0,
    textChars: 0,
    reasoningChars: 0,
    lastDeltaAt: 0,
    firstDeltaAt: 0,
    started: false,
  };
}

/**
 * Record a streamed delta. `now` is injected so this stays pure and testable.
 * Gaps longer than IDLE_GAP_MS are treated as dead air and excluded from
 * `activeMs`, which is what makes the resulting rate reflect generation rather
 * than the turn's total duration.
 */
export function recordDelta(
  rate: TurnRate,
  kind: 'text' | 'reasoning',
  chars: number,
  now: number,
): TurnRate {
  if (chars <= 0) {
    return rate;
  }
  if (kind === 'reasoning') {
    rate.reasoningChars += chars;
  } else {
    rate.textChars += chars;
  }
  if (!rate.started) {
    rate.started = true;
    rate.firstDeltaAt = now;
  } else {
    const gap = now - rate.lastDeltaAt;
    // A gap at or under the threshold is time the model spent producing this
    // delta. A longer one is a tool call / step boundary — drop it entirely
    // rather than attributing it to generation.
    if (gap > 0 && gap <= IDLE_GAP_MS) {
      rate.activeMs += gap;
    }
    rate.wallMs = now - rate.firstDeltaAt;
  }
  rate.lastDeltaAt = now;
  return rate;
}

/** Attach exact usage from the assistant message once it arrives. */
export function recordTokens(
  rate: TurnRate,
  tokens: { input?: number; output?: number; reasoning?: number; total?: number } | undefined,
): TurnRate {
  // Guard against a zeroed/absent usage block overwriting a good estimate.
  if (tokens && ((tokens.output ?? 0) > 0 || (tokens.reasoning ?? 0) > 0)) {
    rate.tokens = {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      total: tokens.total,
    };
  }
  return rate;
}

/** Remember which agent produced the turn, so the stat line can name it. */
export function recordAgent(rate: TurnRate, agent: string | undefined): TurnRate {
  if (agent) {
    rate.agent = agent;
  }
  return rate;
}

export interface RateSummary {
  /** Output tokens (answer + reasoning). */
  total: number;
  /** Prompt tokens sent for this turn — 0 when not reported. */
  input: number;
  /** input + output: everything the turn cost. 0 when input is unknown. */
  grandTotal: number;
  /** Agent that ran the turn, when known. */
  agent?: string;
  /** Reasoning tokens, when known separately. */
  reasoning: number;
  /** Seconds of active generation. */
  seconds: number;
  /** Tokens per second over active generation time. */
  tps: number;
  /** True when `total`/`reasoning` are exact rather than chars/4 estimates. */
  exact: boolean;
}

/**
 * Collapse a turn's accounting into a displayable summary, or null when there
 * is nothing measurable (e.g. a tool-only turn that streamed no text).
 *
 * `output` from the provider already includes reasoning tokens, so the total is
 * `output` and the reasoning portion is a subset — not a second addend.
 */
export function summarize(rate: TurnRate): RateSummary | null {
  const exact = !!rate.tokens && (rate.tokens.output ?? 0) > 0;
  const reasoning = exact
    ? (rate.tokens!.reasoning ?? 0)
    : Math.round(rate.reasoningChars / CHARS_PER_TOKEN);
  const total = exact
    ? rate.tokens!.output!
    : Math.round((rate.textChars + rate.reasoningChars) / CHARS_PER_TOKEN);
  if (total < 1) {
    return null;
  }
  // Single-delta turns have no measurable gap; fall back to wall time so a
  // short reply still reports something rather than dividing by zero.
  const ms = rate.activeMs > 0 ? rate.activeMs : rate.wallMs;
  if (ms <= 0) {
    return null;
  }
  const seconds = ms / 1000;
  const input = exact ? (rate.tokens!.input ?? 0) : 0;
  // Prefer the provider's own total when present; otherwise add the parts we
  // have. Rate stays output-per-second — prompt tokens are prefill, not
  // generation, and folding them in would inflate the number.
  const grandTotal = input > 0 ? (rate.tokens!.total ?? input + total) : 0;
  return { total, input, grandTotal, agent: rate.agent, reasoning, seconds, tps: total / seconds, exact };
}

/**
 * The one-line stat shown under a finished turn. Surfacing the reasoning share
 * matters: a turn can be ~90% thinking, and a single blended token count hides
 * that completely.
 */
export function formatRate(s: RateSummary): string {
  const approx = s.exact ? '' : '~';
  const bits: string[] = [];
  if (s.agent) {
    bits.push(s.agent);
  }
  // Prompt size first — on a 32k local model it's usually the dominant cost and
  // the thing that decides when you have to compact.
  if (s.input > 0) {
    bits.push(`${compact(s.input)} in`);
  }
  const out =
    s.reasoning > 0
      ? `${approx}${compact(s.total)} out (${compact(s.reasoning)} thinking)`
      : `${approx}${compact(s.total)} out`;
  bits.push(out);
  if (s.grandTotal > 0) {
    bits.push(`${compact(s.grandTotal)} total`);
  }
  bits.push(`${s.seconds.toFixed(1)}s`);
  bits.push(`${approx}${Math.round(s.tps)} tok/s`);
  return bits.join(' · ');
}

/** 8192 -> "8.2k". Keeps the stat line readable when prompts run large. */
function compact(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "Thought for 12.4s" / "Thought for 1m 03s" — the collapsed reasoning summary. */
export function formatThinkingLabel(ms: number, tokens: number, exact: boolean): string {
  const secs = ms / 1000;
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(Math.round(secs % 60)).padStart(2, '0')}s` : `${secs.toFixed(1)}s`;
  if (tokens > 0) {
    return `Thought for ${time} · ${exact ? '' : '~'}${tokens} tokens`;
  }
  return `Thought for ${time}`;
}
