import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelDisambiguator, modelIdentity, pickModel } from '../src/core/models';

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

test('modelDisambiguator returns null when the name is unique', () => {
  const all = [
    { id: 'a', name: 'qwen-27b', publisher: 'unsloth' },
    { id: 'b', name: 'gemma-31b', publisher: 'google' },
  ];
  assert.equal(modelDisambiguator(all[0], all), null);
});

test('modelDisambiguator uses publisher when namesakes differ by publisher', () => {
  const all = [
    { id: 'lmstudio-community/qwen-27b', name: 'qwen-27b', publisher: 'lmstudio-community' },
    { id: 'unsloth/qwen-27b', name: 'qwen-27b', publisher: 'unsloth' },
  ];
  assert.equal(modelDisambiguator(all[0], all), 'lmstudio-community');
  assert.equal(modelDisambiguator(all[1], all), 'unsloth');
});

test('modelDisambiguator falls back to the id when name AND publisher collide', () => {
  // The real case: a bare id and a publisher-prefixed id, both from unsloth.
  const all = [
    { id: 'qwen3.6-27b-mlx', name: 'qwen3.6-27b-mlx', publisher: 'unsloth' },
    { id: 'unsloth/qwen3.6-27b-mlx', name: 'qwen3.6-27b-mlx', publisher: 'unsloth' },
  ];
  assert.equal(modelDisambiguator(all[0], all), 'qwen3.6-27b-mlx');
  assert.equal(modelDisambiguator(all[1], all), 'unsloth/qwen3.6-27b-mlx');
});

test('modelDisambiguator handles missing publisher (falls back to id on collision)', () => {
  const all = [
    { id: 'x/m', name: 'm' },
    { id: 'y/m', name: 'm' },
  ];
  // no publisher on either → same (empty) publisher → id distinguishes
  assert.equal(modelDisambiguator(all[0], all), 'x/m');
  assert.equal(modelDisambiguator(all[1], all), 'y/m');
});

test('modelIdentity joins present fields and skips blanks', () => {
  assert.equal(
    modelIdentity({ publisher: 'unsloth', format: 'MLX', quantization: '8bit' }),
    'unsloth · MLX · 8bit',
  );
  assert.equal(modelIdentity({ format: 'GGUF', quantization: 'Q8_0' }), 'GGUF · Q8_0');
  assert.equal(modelIdentity({ publisher: 'google' }), 'google');
  assert.equal(modelIdentity({}), '');
});
