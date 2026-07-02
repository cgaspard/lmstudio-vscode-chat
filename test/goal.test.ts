import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_ITERATIONS,
  Goal,
  buildContinuePrompt,
  buildJudgePrompt,
  decideNext,
  isStalled,
  newGoal,
  parseJudgeVerdict,
} from '../src/core/goal';

// ---- parseJudgeVerdict ---------------------------------------------------

test('parseJudgeVerdict: MET with a reason', () => {
  const v = parseJudgeVerdict('MET - the toggle works and tests pass.');
  assert.equal(v.met, true);
  assert.match(v.reason, /toggle works/);
});

test('parseJudgeVerdict: NOT_MET (underscore) with a reason', () => {
  const v = parseJudgeVerdict('NOT_MET - the tests are still failing.');
  assert.equal(v.met, false);
  assert.match(v.reason, /tests are still failing/);
});

test('parseJudgeVerdict: "NOT MET" (space) and "not-met" (dash) both count as not met', () => {
  assert.equal(parseJudgeVerdict('NOT MET — needs docs').met, false);
  assert.equal(parseJudgeVerdict('verdict: not-met, missing error handling').met, false);
});

test('parseJudgeVerdict: prose-wrapped, prefers the LAST verdict token', () => {
  // an echoed instruction ("answer MET or NOT_MET") must not win over the real verdict
  const v = parseJudgeVerdict('You asked me to answer MET or NOT_MET.\nFinal: NOT_MET - still missing X');
  assert.equal(v.met, false);
  assert.match(v.reason, /missing X/);
});

test('parseJudgeVerdict: bare MET with no reason falls back to a default', () => {
  const v = parseJudgeVerdict('MET');
  assert.equal(v.met, true);
  assert.ok(v.reason.length > 0);
});

test('parseJudgeVerdict: NOT_MET must win even if the word "met" appears inside it', () => {
  // "NOT_MET" contains "met"; ensure we don't misread it as met
  assert.equal(parseJudgeVerdict('NOT_MET').met, false);
});

test('parseJudgeVerdict: unparseable / empty defaults to NOT met (safer)', () => {
  assert.equal(parseJudgeVerdict('').met, false);
  assert.equal(parseJudgeVerdict('hmm, hard to say').met, false);
});

test('parseJudgeVerdict: caps a runaway reason length', () => {
  const v = parseJudgeVerdict('NOT_MET - ' + 'x'.repeat(1000));
  assert.ok(v.reason.length <= 300);
});

// ---- isStalled -----------------------------------------------------------

test('isStalled: false below the threshold', () => {
  assert.equal(isStalled(['a', 'b']), false);
});

test('isStalled: true when the last N reasons are essentially identical', () => {
  assert.equal(isStalled(['missing tests', 'Missing tests.', 'missing   tests']), true);
});

test('isStalled: false when reasons differ', () => {
  assert.equal(isStalled(['missing tests', 'now missing docs', 'build broken']), false);
});

test('isStalled: only the trailing window matters', () => {
  // early identical reasons then progress → not stalled
  assert.equal(isStalled(['x', 'x', 'x', 'a', 'b', 'c']), false);
});

// ---- decideNext ----------------------------------------------------------

test('decideNext: met → stop and celebrate', () => {
  const g = newGoal('do the thing');
  const a = decideNext(g, { met: true, reason: 'done' });
  assert.equal(a.kind, 'met');
});

test('decideNext: not met within budget → continue with next iteration', () => {
  const g = newGoal('do the thing');
  const a = decideNext(g, { met: false, reason: 'missing X' });
  assert.equal(a.kind, 'continue');
  assert.equal((a as { iteration: number }).iteration, 1);
});

test('decideNext: not met at the iteration cap → stop (max-iterations)', () => {
  const g: Goal = { objective: 'x', iteration: DEFAULT_MAX_ITERATIONS, maxIterations: DEFAULT_MAX_ITERATIONS, recentReasons: [] };
  const a = decideNext(g, { met: false, reason: 'still going' });
  assert.equal(a.kind, 'stop');
  assert.equal((a as { why: string }).why, 'max-iterations');
});

test('decideNext: repeated identical reasons → stop (stalled) before the cap', () => {
  const g: Goal = { objective: 'x', iteration: 2, maxIterations: 25, recentReasons: ['stuck on Y', 'stuck on Y'] };
  const a = decideNext(g, { met: false, reason: 'stuck on Y' });
  assert.equal(a.kind, 'stop');
  assert.equal((a as { why: string }).why, 'stalled');
});

test('decideNext: a fresh reason resets progress even near identical history', () => {
  const g: Goal = { objective: 'x', iteration: 2, maxIterations: 25, recentReasons: ['stuck on Y', 'stuck on Y'] };
  const a = decideNext(g, { met: false, reason: 'now stuck on Z' });
  assert.equal(a.kind, 'continue');
});

// ---- prompt builders (smoke) ---------------------------------------------

test('buildJudgePrompt: includes objective + transcript and asks for MET/NOT_MET', () => {
  const p = buildJudgePrompt('add dark mode', 'edited theme.css');
  assert.match(p, /add dark mode/);
  assert.match(p, /edited theme.css/);
  assert.match(p, /MET or NOT_MET/);
});

test('buildContinuePrompt: includes the goal + the missing reason and says continue', () => {
  const p = buildContinuePrompt('add dark mode', 'toggle not wired');
  assert.match(p, /add dark mode/);
  assert.match(p, /toggle not wired/);
  assert.match(p, /[Cc]ontinue/);
});
