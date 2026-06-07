import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickModel } from '../src/core/models';

const M = (id: string, loaded = false) => ({ id, loaded });

test('pickModel honors preference order, skipping ones that no longer exist', () => {
  assert.equal(pickModel(['a', 'b'], [M('b'), M('c')]), 'b'); // a is gone, b wins
  assert.equal(pickModel(['c', 'b'], [M('b'), M('c')]), 'c'); // first match wins
});

test('pickModel falls back to a loaded model, then the first available', () => {
  assert.equal(pickModel(['gone'], [M('a'), M('b', true)]), 'b'); // prefer the loaded one
  assert.equal(pickModel(['gone'], [M('a'), M('b')]), 'a'); // else first
});

test('pickModel skips empty / null / undefined preferences', () => {
  assert.equal(pickModel([null, undefined, '', 'a'], [M('a')]), 'a');
  assert.equal(pickModel(['', '  '], [M('x')]), 'x'); // whitespace-only isn't a real id match
});

test('pickModel returns undefined when there are no models', () => {
  assert.equal(pickModel(['a'], []), undefined);
  assert.equal(pickModel([], []), undefined);
});
