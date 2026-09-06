import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IDLE_GAP_MS,
  addTurn,
  formatDuration,
  formatTotals,
  newSessionTotals,
  formatRate,
  formatThinkingLabel,
  newTurnRate,
  recordDelta,
  recordAgent,
  recordTokens,
  summarize,
} from '../src/core/genrate';

/** Stream `n` deltas of `chars` each, `stepMs` apart, starting at `t0`. */
function stream(
  rate: ReturnType<typeof newTurnRate>,
  kind: 'text' | 'reasoning',
  n: number,
  chars: number,
  stepMs: number,
  t0: number,
): number {
  let t = t0;
  for (let i = 0; i < n; i++) {
    recordDelta(rate, kind, chars, t);
    t += stepMs;
  }
  return t - stepMs;
}

test('tool-call gaps are excluded from generation time', () => {
  const r = newTurnRate();
  // 10 deltas at 100ms — 900ms of real generation...
  let t = stream(r, 'text', 10, 4, 100, 1000);
  // ...then a 30s tool call, then 10 more deltas.
  t += 30_000;
  stream(r, 'text', 10, 4, 100, t);
  // Active time counts only the two generation bursts (~1.8s), not the tool call.
  assert.ok(r.activeMs < 2000, `activeMs should exclude the tool gap, got ${r.activeMs}`);
  assert.ok(r.wallMs > 30_000, 'wall time still spans the whole turn');
  const s = summarize(r)!;
  // 20 deltas x 4 chars = 80 chars ≈ 20 tokens over ~1.8s ≈ 11 tok/s.
  // Naive wall-clock math would report ~0.6 tok/s — a 17x understatement.
  assert.ok(s.tps > 8, `rate should reflect generation, got ${s.tps}`);
});

test('a gap exactly at the threshold still counts, beyond it does not', () => {
  const at = newTurnRate();
  recordDelta(at, 'text', 4, 0);
  recordDelta(at, 'text', 4, IDLE_GAP_MS);
  assert.equal(at.activeMs, IDLE_GAP_MS);

  const over = newTurnRate();
  recordDelta(over, 'text', 4, 0);
  recordDelta(over, 'text', 4, IDLE_GAP_MS + 1);
  assert.equal(over.activeMs, 0, 'a gap past the threshold is dead air, not slow tokens');
});

test('reasoning and text chars are tracked separately', () => {
  const r = newTurnRate();
  stream(r, 'reasoning', 10, 40, 50, 0); // 400 reasoning chars
  stream(r, 'text', 5, 40, 50, 1000); // 200 text chars
  assert.equal(r.reasoningChars, 400);
  assert.equal(r.textChars, 200);
  const s = summarize(r)!;
  assert.equal(s.total, 150); // 600 chars / 4
  assert.equal(s.reasoning, 100); // 400 / 4
  assert.equal(s.exact, false);
});

test('exact usage supersedes the chars/4 estimate', () => {
  const r = newTurnRate();
  stream(r, 'reasoning', 10, 40, 50, 0);
  stream(r, 'text', 5, 40, 50, 1000);
  recordTokens(r, { output: 876, reasoning: 776 });
  const s = summarize(r)!;
  assert.equal(s.exact, true);
  assert.equal(s.total, 876);
  assert.equal(s.reasoning, 776);
  // `output` already includes reasoning — the reasoning count is a subset, so
  // the two must not be added together.
  assert.ok(s.reasoning < s.total);
});

test('a zeroed usage block never clobbers a usable estimate', () => {
  const r = newTurnRate();
  stream(r, 'text', 10, 40, 50, 0);
  recordTokens(r, { output: 0, reasoning: 0 });
  const s = summarize(r)!;
  assert.equal(s.exact, false, 'empty usage must not be treated as authoritative');
  assert.equal(s.total, 100);
  recordTokens(r, undefined);
  assert.equal(summarize(r)!.exact, false);
});

test('nothing measurable returns null rather than a bogus rate', () => {
  assert.equal(summarize(newTurnRate()), null); // tool-only turn, no stream
  const one = newTurnRate();
  recordDelta(one, 'text', 4, 5000);
  // A single delta has no gap to measure — no division by zero, just null.
  assert.equal(summarize(one), null);
});

test('formatRate trims the line to four fields; agent/total/thinking live in the tooltip', () => {
  assert.equal(
    formatRate({
      agent: 'build', total: 876, input: 7995, grandTotal: 8871,
      reasoning: 776, seconds: 21.06, tps: 41.6, exact: true,
    }),
    '7.8K in · 876 out · 21.1s · 42 tok/s',
  );
  // Mid-stream: no exact usage yet, so no input and everything is ~.
  assert.equal(
    formatRate({ total: 100, input: 0, grandTotal: 0, reasoning: 0, seconds: 2, tps: 50, exact: false }),
    '~100 out · 2.0s · ~50 tok/s',
  );
  // 1024-base like the context meter: 68_700 reads "67K" in both surfaces.
  assert.equal(
    formatRate({ total: 233, input: 68700, grandTotal: 68933, reasoning: 0, seconds: 80.9, tps: 2.88, exact: true }),
    '67K in · 233 out · 80.9s · 3 tok/s',
  );
});

test('the rate stays output-per-second — prompt tokens are prefill, not generation', () => {
  const r = newTurnRate();
  stream(r, 'text', 10, 4, 100, 1000);
  recordTokens(r, { input: 100000, output: 100, reasoning: 0, total: 100100 });
  const s = summarize(r)!;
  // A huge prompt must not inflate tok/s — only `output` drives the rate.
  assert.equal(s.total, 100);
  assert.equal(s.input, 100000);
  assert.equal(s.grandTotal, 100100);
  assert.ok(Math.abs(s.tps - 100 / s.seconds) < 0.001);
});

test('grandTotal falls back to input+output when the provider omits a total', () => {
  const r = newTurnRate();
  stream(r, 'text', 5, 8, 50, 0);
  recordTokens(r, { input: 500, output: 250, reasoning: 40 });
  const s = summarize(r)!;
  assert.equal(s.grandTotal, 750);
});

test('the agent that ran the turn is carried through to the stat line', () => {
  const r = newTurnRate();
  stream(r, 'text', 5, 8, 50, 0);
  recordAgent(r, 'reviewer');
  recordTokens(r, { input: 10, output: 20 });
  assert.equal(summarize(r)!.agent, 'reviewer');
  // An absent agent must not blank a previously recorded one.
  recordAgent(r, undefined);
  assert.equal(summarize(r)!.agent, 'reviewer');
});

test('formatThinkingLabel reads as a duration, and handles minutes', () => {
  assert.equal(formatThinkingLabel(21_060, 776, true), 'Thought for 21.1s · 776 tokens');
  assert.equal(formatThinkingLabel(63_000, 0, true), 'Thought for 1m 03s');
  assert.equal(formatThinkingLabel(5000, 120, false), 'Thought for 5.0s · ~120 tokens');
});


// A turn that streamed 400 chars of thinking and 200 of answer, so the observed
// split is unambiguous: ~100 reasoning tokens, ~50 answer tokens.
function thoughtfulTurn() {
  const r = newTurnRate();
  recordDelta(r, 'reasoning', 400, 1000);
  recordDelta(r, 'text', 200, 2000);
  return r;
}

// The bug: `output` was taken as the whole story. On a provider that reports
// thinking SEPARATELY from output, every thinking token vanished from the total
// and from tok/s — the number even dropped the moment exact usage arrived,
// because the mid-stream estimate had counted them.
test('summarize adds reasoning when the provider reports it outside output', () => {
  const r = thoughtfulTurn();
  // output ~= the answer alone (50), reasoning reported beside it.
  recordTokens(r, { input: 900, output: 50, reasoning: 100 });
  const s = summarize(r)!;
  assert.equal(s.total, 150, 'thinking is part of what the model generated');
  assert.equal(s.reasoning, 100);
});

// The other convention (OpenAI-style): completion_tokens already contains the
// reasoning tokens, which are restated as a subset. Adding them here would
// count the thinking twice and overstate tok/s.
test('summarize does not double count reasoning already inside output', () => {
  const r = thoughtfulTurn();
  // output ~= answer + thinking (150), with reasoning restated as a subset.
  recordTokens(r, { input: 900, output: 150, reasoning: 100 });
  const s = summarize(r)!;
  assert.equal(s.total, 150);
  assert.equal(s.reasoning, 100);
});

test('summarize leaves output alone when no reasoning is reported', () => {
  const r = thoughtfulTurn();
  recordTokens(r, { input: 900, output: 150 });
  assert.equal(summarize(r)!.total, 150);
});

// Replayed history streamed nothing past us, so there is no evidence to weigh.
// Prefer the common convention over inflating the count.
test('summarize falls back to output when nothing streamed', () => {
  const r = newTurnRate();
  recordDelta(r, 'text', 0, 1000); // no-op: keeps chars at zero
  r.started = true;
  r.firstDeltaAt = 1000;
  r.lastDeltaAt = 2000;
  r.activeMs = 1000;
  recordTokens(r, { input: 10, output: 150, reasoning: 100 });
  assert.equal(summarize(r)!.total, 150);
});

test('session totals accumulate across turns and survive compaction', () => {
  const t = newSessionTotals();
  assert.equal(formatTotals(t), null, 'nothing measured yet');
  const r1 = thoughtfulTurn();
  recordTokens(r1, { input: 1000, output: 50, reasoning: 100 });
  addTurn(t, summarize(r1)!);
  const r2 = thoughtfulTurn();
  recordTokens(r2, { input: 2000, output: 50, reasoning: 100 });
  addTurn(t, summarize(r2)!);
  assert.equal(t.turns, 2);
  assert.equal(t.input, 3000);
  assert.equal(t.output, 300, 'both turns counted thinking');
  assert.equal(t.reasoning, 200);
  assert.equal(t.exact, true);
});

test('session totals go approximate once any turn was estimated', () => {
  const t = newSessionTotals();
  addTurn(t, summarize(thoughtfulTurn())!); // no exact usage attached
  assert.equal(t.exact, false);
  assert.match(formatTotals(t)!, /^~/);
});

test('formatDuration reads coarsely at every scale', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(1_100_000), '18m 20s');
  assert.equal(formatDuration(3_840_000), '1h 04m');
});
