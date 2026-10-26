import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromEngineProviderID, toEngineProviderID } from '../src/core/providerIds';
import { EventTranslator } from '../src/opencode/translate';

test('ids OpenCode 2 reserves for its built-in local plugins are suffixed for the engine', () => {
  for (const id of ['lmstudio', 'ollama', 'vllm']) {
    assert.notEqual(toEngineProviderID(id), id);
    assert.equal(fromEngineProviderID(toEngineProviderID(id)), id, 'round-trips back to the panel id');
  }
});

test('every other id passes through unchanged', () => {
  for (const id of ['lm-studio', 'anthropic', 'opencode', 'ollama-local', 'e2e-fake', 'my-vllm']) {
    assert.equal(toEngineProviderID(id), id);
    assert.equal(fromEngineProviderID(id), id);
  }
});

test('a suffixed id that is not reserved is left alone', () => {
  assert.equal(fromEngineProviderID('acme-vscode-panel'), 'acme-vscode-panel');
});

test('events report the panel\'s provider id, not the engine\'s', () => {
  const t = new EventTranslator();
  const out = t.translate({
    type: 'session.step.started',
    data: { sessionID: 's', assistantMessageID: 'a1', model: { id: 'llama3', providerID: toEngineProviderID('ollama') } },
  });
  assert.equal((out[0].properties as any).info.providerID, 'ollama');
});
