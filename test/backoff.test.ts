import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextDelay } from '../src/core/backoff';

test('nextDelay grows exponentially from the base', () => {
  assert.equal(nextDelay(1), 1000);
  assert.equal(nextDelay(2), 2000);
  assert.equal(nextDelay(3), 4000);
  assert.equal(nextDelay(4), 8000);
});

test('nextDelay is capped at max so we never wait absurdly long', () => {
  assert.equal(nextDelay(100), 30000);
  assert.equal(nextDelay(6, { base: 2000, max: 30000 }), 30000); // 2000*2^5 = 64000 -> 30000
});

test('nextDelay treats attempt <= 1 (and junk) as the first attempt', () => {
  assert.equal(nextDelay(1), 1000);
  assert.equal(nextDelay(0), 1000);
  assert.equal(nextDelay(-5), 1000);
  assert.equal(nextDelay(NaN), 1000);
});

test('nextDelay honors custom base / factor', () => {
  assert.equal(nextDelay(1, { base: 2000 }), 2000);
  assert.equal(nextDelay(2, { base: 2000 }), 4000);
  assert.equal(nextDelay(2, { base: 500, factor: 3 }), 1500);
  assert.equal(nextDelay(3, { base: 1000, factor: 1 }), 1000); // factor 1 stays flat
});
