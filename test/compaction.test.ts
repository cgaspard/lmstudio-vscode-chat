import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isCompactionPart,
  isSyntheticText,
  markCompaction,
  newCompactionState,
  shouldSuppressMessage,
} from '../src/core/compaction';

// Replays the message/part structure OpenCode 1.16.2 actually emits around a
// summarize ("/compact") call (captured from a live darwin-arm64 + LM Studio
// run): a real turn, a `compaction` marker on a user message, the summarizer's
// own assistant turn, then a fresh real turn. Only the marker + summarizer turn
// must be hidden.
const SESSION: { id: string; role: string; partTypes: string[] }[] = [
  { id: 'm1', role: 'user', partTypes: ['text'] },
  { id: 'm2', role: 'assistant', partTypes: ['step-start', 'reasoning', 'text', 'step-finish'] },
  { id: 'm3', role: 'user', partTypes: ['compaction'] },
  { id: 'm4', role: 'assistant', partTypes: ['step-start', 'reasoning', 'text', 'step-finish'] },
  { id: 'm5', role: 'user', partTypes: ['text'] },
];

// Mirror renderConversation's loop: returns which messages render as chat
// bubbles and how many compaction chips appear.
function replay(session: typeof SESSION): { rendered: string[]; chips: number } {
  const state = newCompactionState();
  const rendered: string[] = [];
  let chips = 0;
  for (const m of session) {
    if (m.partTypes.some((t) => isCompactionPart(t))) {
      markCompaction(state, m.id);
      chips++;
      continue;
    }
    if (shouldSuppressMessage(state, m.id, m.role)) {
      continue;
    }
    rendered.push(m.id);
  }
  return { rendered, chips };
}

test('isCompactionPart only matches the compaction marker type', () => {
  assert.equal(isCompactionPart('compaction'), true);
  assert.equal(isCompactionPart('text'), false);
  assert.equal(isCompactionPart('reasoning'), false);
  assert.equal(isCompactionPart('step-start'), false);
});

test('isSyntheticText hides only synthetic text parts (file content / tool framing)', () => {
  // OpenCode expands an attached file into synthetic text parts on the user
  // message — these must not render as chat (the file chip is the affordance).
  assert.equal(isSyntheticText({ type: 'text', synthetic: true }), true);
  // real user text still renders
  assert.equal(isSyntheticText({ type: 'text', synthetic: false }), false);
  assert.equal(isSyntheticText({ type: 'text' }), false);
  // synthetic flag only applies to text — never hide other part types on it
  assert.equal(isSyntheticText({ type: 'file', synthetic: true }), false);
  assert.equal(isSyntheticText({ type: 'reasoning', synthetic: true }), false);
});

test('compaction marker + summarizer turn are hidden; real turns render', () => {
  const { rendered, chips } = replay(SESSION);
  assert.deepEqual(rendered, ['m1', 'm2', 'm5']);
  assert.equal(chips, 1);
  // The summarizer turn (its reasoning + the leaked summary template) must not render.
  assert.equal(rendered.includes('m4'), false);
});

test('a normal "/"-prefixed text part is never mistaken for compaction', () => {
  const state = newCompactionState();
  // assistant turn with text that happens to start with "/" — still renders.
  assert.equal(shouldSuppressMessage(state, 'mA', 'assistant'), false);
});

test('only the FIRST assistant turn after a marker is suppressed', () => {
  const state = newCompactionState();
  markCompaction(state, 'marker');
  assert.equal(shouldSuppressMessage(state, 'summary', 'assistant'), true); // claimed
  assert.equal(shouldSuppressMessage(state, 'next', 'assistant'), false); // back to normal
});

test('a user message between marker and assistant does not consume suppression', () => {
  const state = newCompactionState();
  markCompaction(state, 'marker');
  // user messages never count as the summarizer turn
  assert.equal(shouldSuppressMessage(state, 'u', 'user'), false);
  assert.equal(state.pending, true);
  // the next assistant turn is still correctly suppressed
  assert.equal(shouldSuppressMessage(state, 'summary', 'assistant'), true);
});

test('back-to-back compactions each suppress their own summarizer turn', () => {
  const session = [
    { id: 'm1', role: 'user', partTypes: ['text'] },
    { id: 'c1', role: 'user', partTypes: ['compaction'] },
    { id: 's1', role: 'assistant', partTypes: ['reasoning', 'text'] },
    { id: 'c2', role: 'user', partTypes: ['compaction'] },
    { id: 's2', role: 'assistant', partTypes: ['reasoning', 'text'] },
    { id: 'm2', role: 'user', partTypes: ['text'] },
  ];
  const { rendered, chips } = replay(session);
  assert.deepEqual(rendered, ['m1', 'm2']);
  assert.equal(chips, 2);
});

test('repeated suppression checks for the same message are stable', () => {
  const state = newCompactionState();
  markCompaction(state, 'marker');
  assert.equal(shouldSuppressMessage(state, 'summary', 'assistant'), true);
  // idempotent: still suppressed when re-checked (parts stream in over many events)
  assert.equal(shouldSuppressMessage(state, 'summary', 'assistant'), true);
});
