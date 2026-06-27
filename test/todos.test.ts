import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTodoCardCollapsed, summarizeTodos, Todo } from '../src/core/todos';

const T = (status: Todo['status'], content: string = status): Todo => ({ content, status });

test('summarizeTodos counts done/total and excludes cancelled from both', () => {
  const s = summarizeTodos([T('completed'), T('in_progress'), T('pending'), T('cancelled')]);
  assert.equal(s.done, 1);
  assert.equal(s.total, 3); // cancelled excluded
  assert.equal(s.anyInProgress, true);
  assert.equal(s.allDone, false);
  assert.equal(s.cardStatus, 'running');
});

test('summarizeTodos marks allDone only when every non-cancelled item is completed', () => {
  const s = summarizeTodos([T('completed'), T('completed'), T('cancelled')]);
  assert.equal(s.done, 2);
  assert.equal(s.total, 2);
  assert.equal(s.allDone, true);
  assert.equal(s.cardStatus, 'completed');
  assert.equal(s.currentLabel, '✓ Done');
});

test('summarizeTodos currentLabel prefers the in-progress item', () => {
  const s = summarizeTodos([T('completed'), T('in_progress', 'Wire the bridge'), T('pending')]);
  assert.equal(s.currentLabel, '● Wire the bridge');
});

test('summarizeTodos currentLabel falls back to the next pending when nothing is running', () => {
  const s = summarizeTodos([T('completed'), T('pending', 'Add the CSS'), T('pending', 'Verify')]);
  assert.equal(s.anyInProgress, false);
  assert.equal(s.currentLabel, 'Next: Add the CSS');
  assert.equal(s.cardStatus, 'pending');
});

test('summarizeTodos handles an all-cancelled list without false allDone', () => {
  const s = summarizeTodos([T('cancelled'), T('cancelled')]);
  assert.equal(s.total, 0);
  assert.equal(s.allDone, false); // total===0 must not read as "done"
  assert.equal(s.cardStatus, 'pending');
});

test('isTodoCardCollapsed is expanded by default regardless of progress', () => {
  assert.equal(isTodoCardCollapsed(true, undefined), false); // running → expanded
  assert.equal(isTodoCardCollapsed(false, undefined), false); // idle/done → still expanded
});

test('isTodoCardCollapsed honors a manual user toggle over the default', () => {
  assert.equal(isTodoCardCollapsed(true, true), true); // user collapsed an active plan
  assert.equal(isTodoCardCollapsed(false, false), false); // user kept a done plan open
});
