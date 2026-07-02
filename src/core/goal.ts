/**
 * Goal-loop control — the pure decision logic behind the `/goal` feature.
 *
 * A goal is a natural-language objective the agent works toward autonomously.
 * When the agent's turn goes idle, an LLM "judge" evaluates whether the goal is
 * met. If not, the loop auto-continues the agent with the judge's feedback, and
 * keeps iterating until the goal is met OR an "unreasonable endpoint" is hit —
 * a hard iteration cap or a no-progress stall — so it can never loop forever.
 *
 * This module is pure (no vscode / no client): it parses a judge's raw reply
 * into a verdict and decides what the loop should do next, so both are unit-
 * testable. The bridge owns the side effects (running the judge, re-prompting).
 */

/** How many times the loop may auto-continue before pausing, by default. */
export const DEFAULT_MAX_ITERATIONS = 25;
/** Consecutive near-identical "not met" reasons that count as a stall. */
export const DEFAULT_STALL_THRESHOLD = 3;

export interface Goal {
  /** The user's objective, verbatim from `/goal <objective>`. */
  objective: string;
  /** Auto-continue attempts so far (0 before the first check). */
  iteration: number;
  /** Max attempts before the loop pauses. */
  maxIterations: number;
  /** Recent judge "not met" reasons, newest last — for stall detection. */
  recentReasons: string[];
}

export interface JudgeVerdict {
  met: boolean;
  /** One-line reason (why not met, or a confirmation when met). */
  reason: string;
}

export function newGoal(objective: string, maxIterations = DEFAULT_MAX_ITERATIONS): Goal {
  return { objective: objective.trim(), iteration: 0, maxIterations, recentReasons: [] };
}

/**
 * Parse a judge's raw model reply into a verdict. The judge is asked to answer
 * with MET or NOT_MET followed by a one-line reason. We look for the verdict
 * token anywhere in the reply (models wrap it in prose), preferring the LAST
 * occurrence so a "answer MET or NOT_MET" instruction echoed early doesn't win.
 * Defaults to NOT met when the reply is unparseable — safer to keep working than
 * to declare a goal done on ambiguous output.
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const text = (raw ?? '').trim();
  if (!text) {
    return { met: false, reason: 'no judge response' };
  }
  // Find the last standalone MET / NOT_MET / NOT MET token.
  const re = /\b(NOT[_\s-]?MET|MET)\b/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    last = m;
  }
  const met = !!last && /^met$/i.test(last[1].replace(/[_\s-]/g, ''));
  // Reason: text after the verdict token, else the last non-empty line.
  let reason = '';
  if (last) {
    reason = text.slice(last.index + last[0].length).replace(/^[:\s.—-]+/, '').trim();
  }
  if (!reason) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    reason = lines[lines.length - 1] ?? '';
  }
  // Collapse whitespace and cap length so a runaway reply can't bloat the chip.
  reason = reason.replace(/\s+/g, ' ').slice(0, 300);
  return { met, reason: reason || (met ? 'goal met' : 'not met yet') };
}

/** Normalize a reason for stall comparison (lowercase, alphanumeric words). */
function normalizeReason(r: string): string {
  return r.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * True when the last `threshold` judge reasons are all essentially the same —
 * the agent is stuck making the same non-progress, so the loop should stop.
 */
export function isStalled(recentReasons: string[], threshold = DEFAULT_STALL_THRESHOLD): boolean {
  if (recentReasons.length < threshold) {
    return false;
  }
  const window = recentReasons.slice(-threshold).map(normalizeReason).filter(Boolean);
  if (window.length < threshold) {
    return false;
  }
  return window.every((r) => r === window[0]);
}

export type LoopAction =
  | { kind: 'met'; reason: string }
  | { kind: 'continue'; reason: string; iteration: number }
  | { kind: 'stop'; why: 'max-iterations' | 'stalled'; reason: string };

/**
 * Decide what the loop does after a judge verdict on an idle turn. Returns:
 *  - 'met'      → goal satisfied, stop and celebrate.
 *  - 'continue' → not met and within budget → auto-continue with the reason.
 *  - 'stop'     → an unreasonable endpoint (cap reached or stalled) → pause.
 * Pure: the caller mutates goal state from the returned action.
 */
export function decideNext(goal: Goal, verdict: JudgeVerdict): LoopAction {
  if (verdict.met) {
    return { kind: 'met', reason: verdict.reason };
  }
  const recentReasons = [...goal.recentReasons, verdict.reason];
  if (isStalled(recentReasons)) {
    return { kind: 'stop', why: 'stalled', reason: verdict.reason };
  }
  const nextIteration = goal.iteration + 1;
  if (nextIteration > goal.maxIterations) {
    return { kind: 'stop', why: 'max-iterations', reason: verdict.reason };
  }
  return { kind: 'continue', reason: verdict.reason, iteration: nextIteration };
}

/** The prompt for the isolated judge session. Kept here so it's testable. */
export function buildJudgePrompt(objective: string, transcript: string): string {
  return (
    `You are a strict goal-completion judge. Decide whether the objective below ` +
    `has been FULLY met based on the work transcript.\n\n` +
    `OBJECTIVE:\n${objective}\n\n` +
    `WORK TRANSCRIPT (most recent):\n${transcript}\n\n` +
    `Answer on the FIRST line with exactly one token: MET or NOT_MET. ` +
    `Then on the same line, after a dash, give a one-sentence reason. ` +
    `Be conservative: answer MET only if the objective is genuinely and ` +
    `completely satisfied; otherwise NOT_MET with the single most important ` +
    `thing still missing. Do not explain your role or restate the objective.`
  );
}

/** The continuation prompt fed back to the working agent when not met. */
export function buildContinuePrompt(objective: string, reason: string): string {
  return (
    `Your goal is not complete yet.\n\nGoal: ${objective}\n\n` +
    `What's still missing: ${reason}\n\n` +
    `Keep working toward the goal. Continue now — do not stop or ask for ` +
    `confirmation; take the next concrete step.`
  );
}
