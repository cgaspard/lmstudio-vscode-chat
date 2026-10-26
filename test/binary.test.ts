import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSupportedOpencodeVersion, resolveBinaryPath } from '../src/core/binary';

const base = {
  overridePath: '',
  bundled: '/ext/bin/opencode',
  exists: () => false,
};

test('explicit override wins when it exists', () => {
  const got = resolveBinaryPath({
    ...base,
    overridePath: '/custom/opencode',
    exists: (p) => p === '/custom/opencode',
  });
  assert.equal(got, '/custom/opencode');
});

test('a non-existent override is ignored and falls back to the bundled binary', () => {
  const got = resolveBinaryPath({ ...base, overridePath: '/missing/opencode' });
  assert.equal(got, '/ext/bin/opencode');
});

test('the bundled binary is used when no override is set, whatever else is installed', () => {
  // A Homebrew / PATH install is never consulted: it may be OpenCode 2.
  const got = resolveBinaryPath({ ...base, exists: () => true });
  assert.equal(got, '/ext/bin/opencode');
});

test('returns null when every option fails (corrupt install)', () => {
  const got = resolveBinaryPath({ ...base, bundled: null });
  assert.equal(got, null);
});

test('only OpenCode 1.x version output counts as supported', () => {
  assert.equal(isSupportedOpencodeVersion('1.19.4'), true);
  assert.equal(isSupportedOpencodeVersion('1.18.26'), true);
  assert.equal(isSupportedOpencodeVersion('opencode v2.1.4'), false);
  assert.equal(isSupportedOpencodeVersion('3.0.0'), false);
  // Unreadable output gets the benefit of the doubt.
  assert.equal(isSupportedOpencodeVersion(''), true);
});
