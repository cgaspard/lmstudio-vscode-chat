import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLineRange, isContextLive, selectionLabel } from '../src/core/selection';

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

test('isContextLive: kept while the file is still open', () => {
  const open = new Set(['/w/src/app.js', '/w/README.md']);
  assert.equal(isContextLive('/w/src/app.js', open), true);
});

test('isContextLive: dropped once the file is closed', () => {
  const open = new Set(['/w/README.md']);
  assert.equal(isContextLive('/w/src/app.js', open), false);
  assert.equal(isContextLive('/w/src/app.js', new Set()), false);
});

test('isContextLive: nothing remembered is never live', () => {
  assert.equal(isContextLive(null, new Set(['/w/src/app.js'])), false);
  assert.equal(isContextLive(undefined, new Set(['/w/src/app.js'])), false);
});
