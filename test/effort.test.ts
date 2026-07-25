import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fallbackPromptText,
  isBinary,
  levelLabel,
  levelsForModel,
  resolveLevel,
  variantForLevel,
  variantsForModel,
  type ReasoningCapability,
} from '../src/core/effort';

const BINARY: ReasoningCapability = { allowedOptions: ['off', 'on'], default: 'on' };
const GRANULAR: ReasoningCapability = { allowedOptions: ['low', 'medium', 'high'], default: 'medium' };

test('variants use camelCase reasoningEffort — snake_case is silently dropped on the wire', () => {
  const v = variantsForModel();
  // This is the single most breakage-prone fact in the feature: the AI SDK
  // renames camelCase reasoningEffort -> wire reasoning_effort. Declaring
  // snake_case produces a request with no effort field and no error.
  assert.deepEqual(Object.keys(v).sort(), ['high', 'low', 'medium', 'off']);
  for (const key of Object.keys(v)) {
    assert.ok('reasoningEffort' in v[key], `${key} must use camelCase reasoningEffort`);
    assert.ok(!('reasoning_effort' in (v[key] as object)), `${key} must not use snake_case`);
  }
  assert.equal(v.off.reasoningEffort, 'none'); // 'off' is spelled 'none' to LM Studio
  assert.equal(v.high.reasoningEffort, 'high');
});

test('variantsForModel declares no auto entry — auto means omit the field', () => {
  assert.ok(!('auto' in variantsForModel()));
  assert.equal(variantForLevel('auto'), undefined);
  assert.equal(variantForLevel('off'), 'off');
  assert.equal(variantForLevel('high'), 'high');
});

test('binary models collapse to auto/off/on', () => {
  assert.deepEqual(levelsForModel(BINARY), ['auto', 'off', 'high']);
  assert.ok(isBinary(BINARY));
  // ...and the "on" level is labelled On, not High, so the UI does not imply a
  // depth the model cannot deliver.
  assert.equal(levelLabel('high', BINARY), 'On');
});

test('granular models expose their declared levels', () => {
  assert.deepEqual(levelsForModel(GRANULAR), ['auto', 'off', 'low', 'medium', 'high']);
  assert.ok(!isBinary(GRANULAR));
  assert.equal(levelLabel('high', GRANULAR), 'High');
});

test('unknown capability is treated as unknown, never as unsupported', () => {
  // undefined = we came via the /api/v0 fallback, which cannot report caps.
  // Sending an undeclared variant is a verified silent no-op, so offer everything.
  assert.deepEqual(levelsForModel(undefined), ['auto', 'off', 'low', 'medium', 'high']);
  assert.deepEqual(levelsForModel({ allowedOptions: [] }), ['auto', 'off', 'low', 'medium', 'high']);
});

test('explicitly non-reasoning models hide the control entirely', () => {
  assert.deepEqual(levelsForModel(null), []);
  assert.equal(resolveLevel('high', null), 'auto');
});

test('resolveLevel clamps a level carried over from another model', () => {
  // 'medium' is meaningless on a binary model — degrade downward, never upward.
  assert.equal(resolveLevel('medium', BINARY), 'off');
  assert.equal(resolveLevel('low', BINARY), 'off');
  assert.equal(resolveLevel('high', BINARY), 'high');
  assert.equal(resolveLevel('off', BINARY), 'off');
  assert.equal(resolveLevel('medium', GRANULAR), 'medium');
  assert.equal(resolveLevel(undefined, GRANULAR), 'auto');
});

test('fallbackPromptText only fires when the parameter path is unavailable', () => {
  // Capability present -> the variant does the work; no text nudge, so we never
  // double up and pollute the prompt.
  assert.equal(fallbackPromptText('off', BINARY), '');
  assert.equal(fallbackPromptText('high', GRANULAR), '');
  // No capability -> text is the only lever left.
  assert.match(fallbackPromptText('off', undefined), /concise|not produce/i);
  assert.match(fallbackPromptText('high', undefined), /step by step|thoroughly/i);
  assert.equal(fallbackPromptText('auto', undefined), '');
});
