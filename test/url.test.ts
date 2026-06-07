import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lmStudioRestRoot, normalizeServerUrl } from '../src/core/url';

test('normalizeServerUrl falls back to the local default on empty input', () => {
  assert.equal(normalizeServerUrl(''), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeServerUrl('   '), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeServerUrl('', 'http://custom/v1'), 'http://custom/v1');
});

test('normalizeServerUrl adds a scheme and the /v1 suffix', () => {
  assert.equal(normalizeServerUrl('192.168.1.50:1234'), 'http://192.168.1.50:1234/v1');
  assert.equal(normalizeServerUrl('http://host:1234'), 'http://host:1234/v1');
});

test('normalizeServerUrl strips trailing slashes and respects existing /vN', () => {
  assert.equal(normalizeServerUrl('http://host:1234/'), 'http://host:1234/v1');
  assert.equal(normalizeServerUrl('http://host:1234/v1'), 'http://host:1234/v1');
  assert.equal(normalizeServerUrl('http://host:1234/v1/'), 'http://host:1234/v1');
  assert.equal(normalizeServerUrl('https://host/v2'), 'https://host/v2');
});

test('lmStudioRestRoot strips the /vN suffix to get the REST root', () => {
  assert.equal(lmStudioRestRoot('http://host:1234/v1'), 'http://host:1234');
  assert.equal(lmStudioRestRoot('http://host:1234/v0'), 'http://host:1234');
  assert.equal(lmStudioRestRoot('http://host:1234'), 'http://host:1234');
  assert.equal(lmStudioRestRoot(''), '');
});
