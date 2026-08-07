import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampContext,
  computeWindow,
  decideContextLoad,
  formatTokens,
  opencodeContextLimit,
} from '../src/core/context';

test('clampContext never exceeds the model maximum', () => {
  assert.equal(clampContext(131072, 32768), 32768); // user asked for more than the model allows
  assert.equal(clampContext(8192, 32768), 8192); // under the max stays as-is
  assert.equal(clampContext(32768, 32768), 32768); // exactly the max
});

test('clampContext degrades gracefully when a value is missing/invalid', () => {
  assert.equal(clampContext(32768, undefined), 32768); // unknown max -> trust request
  assert.equal(clampContext(32768, 0), 32768); // zero max -> trust request
  assert.equal(clampContext(0, 32768), 32768); // no request -> use the cap
  assert.equal(clampContext(-5, 100), 100); // negative request -> use the cap
});

test('formatTokens uses 1024-base so 32768 reads as 32K (the old 33K bug)', () => {
  assert.equal(formatTokens(32768), '32K');
  assert.equal(formatTokens(65536), '64K');
  assert.equal(formatTokens(131072), '128K');
  assert.equal(formatTokens(262144), '256K');
  assert.equal(formatTokens(1048576), '1M');
  assert.equal(formatTokens(1572864), '1.5M');
  assert.equal(formatTokens(512), '512');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(-5), '0');
});

test('computeWindow shows the loaded window when a model is loaded', () => {
  assert.equal(computeWindow({ contextLength: 8192, maxContextLength: 32768 }, 131072), 8192);
});

test('computeWindow uses min(configured, model max) when not loaded', () => {
  assert.equal(computeWindow({ maxContextLength: 32768 }, 131072), 32768); // capped by model
  assert.equal(computeWindow({ maxContextLength: 131072 }, 32768), 32768); // capped by setting
});

test('computeWindow falls back to the configured window without model metadata', () => {
  assert.equal(computeWindow(undefined, 32768), 32768);
  assert.equal(computeWindow({}, 32768), 32768);
  assert.equal(computeWindow(undefined, 0), 0);
});

// The pre-prompt guarantee is a floor, deliberately: the loaded window is LM
// Studio's call, not ours (its load API ignores context_length on some builds),
// so chasing an exact number would eject the user's model before every send.
const at = (loadedContext: number, maxContext = 262144) => ({
  loaded: true,
  loadedContext,
  maxContext,
});

test('the floor grows a too-small window but never shrinks a big one', () => {
  assert.equal(decideContextLoad(at(8192), 65536).reason, 'below-floor');
  assert.equal(decideContextLoad(at(262144), 65536).action, 'none');
  assert.equal(decideContextLoad(at(65536), 65536).action, 'none');
});

test('the floor loads a model that is not loaded at all', () => {
  const d = decideContextLoad({ loaded: false, maxContext: 262144 }, 65536);
  assert.equal(d.action, 'load');
  assert.equal(d.reason, 'not-loaded');
});

test('decideContextLoad never asks for more than the model supports', () => {
  assert.equal(decideContextLoad(at(8192, 32768), 131072).target, 32768);
  assert.equal(decideContextLoad(at(32768, 32768), 131072).action, 'none');
});

test('decideContextLoad loads when the loaded window is unknown', () => {
  // LM Studio reported no context_length for the instance — cannot confirm it
  // is big enough, so apply rather than assume.
  assert.equal(decideContextLoad({ loaded: true, maxContext: 262144 }, 65536).action, 'load');
});

test('decideContextLoad does nothing when there is no usable target', () => {
  const d = decideContextLoad({ loaded: true, loadedContext: 4096 }, 0);
  assert.equal(d.action, 'none');
  assert.equal(d.reason, 'no-target');
});

test('opencodeContextLimit follows the window LM Studio actually loaded', () => {
  // The setting asked for 64K and LM Studio came up at 256K anyway — OpenCode
  // must compact against the real 256K, not the 64K nobody agreed to.
  assert.equal(
    opencodeContextLimit({ loadedContextLength: 262144, maxContextLength: 262144 }, 65536),
    262144,
  );
  // ...and equally when the real window is SMALLER than the setting.
  assert.equal(
    opencodeContextLimit({ loadedContextLength: 16384, maxContextLength: 262144 }, 131072),
    16384,
  );
});

test('opencodeContextLimit falls back to the clamped setting when not loaded', () => {
  assert.equal(opencodeContextLimit({ maxContextLength: 262144 }, 65536), 65536);
  assert.equal(opencodeContextLimit({ maxContextLength: 32768 }, 131072), 32768); // capped
  assert.equal(opencodeContextLimit({ loadedContextLength: 0, maxContextLength: 8192 }, 0), 8192);
});
