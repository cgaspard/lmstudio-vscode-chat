import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLineRange, selectionLabel } from '../src/core/selection';

test('formatLineRange: single line shows just the number', () => {
  assert.equal(formatLineRange(14, 14), '14');
});

test('formatLineRange: a span shows start-end', () => {
  assert.equal(formatLineRange(14, 19), '14-19');
});

test('selectionLabel: relative path + range, for the attached file part', () => {
  assert.equal(selectionLabel('src/app.js', 14, 19), 'src/app.js#14-19');
  assert.equal(selectionLabel('src/app.js', 7, 7), 'src/app.js#7');
});
