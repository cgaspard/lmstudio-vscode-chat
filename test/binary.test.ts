import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveBinaryPath } from '../src/core/binary';

const base = {
  overridePath: '',
  userCandidates: ['/home/u/.opencode/bin/opencode', '/opt/homebrew/bin/opencode'],
  onPath: null as string | null,
  bundled: '/ext/bin/opencode',
  exists: () => false,
};

test('explicit override wins when it exists', () => {
  const got = resolveBinaryPath({
    ...base,
    overridePath: '/custom/opencode',
    onPath: '/usr/bin/opencode',
    exists: (p) => p === '/custom/opencode' || p === '/home/u/.opencode/bin/opencode',
  });
  assert.equal(got, '/custom/opencode');
});

test('a non-existent override is ignored and falls through', () => {
  const got = resolveBinaryPath({
    ...base,
    overridePath: '/missing/opencode',
    exists: (p) => p === '/opt/homebrew/bin/opencode',
  });
  assert.equal(got, '/opt/homebrew/bin/opencode');
});

test('a user install is preferred over the bundled binary', () => {
  const got = resolveBinaryPath({
    ...base,
    exists: (p) => p === '/home/u/.opencode/bin/opencode',
  });
  assert.equal(got, '/home/u/.opencode/bin/opencode');
});

test('PATH result is used when no known candidate exists', () => {
  const got = resolveBinaryPath({ ...base, onPath: '/usr/local/bin/opencode' });
  assert.equal(got, '/usr/local/bin/opencode');
});

test('PATH is preferred over the bundled binary', () => {
  const got = resolveBinaryPath({
    ...base,
    onPath: '/usr/local/bin/opencode',
    bundled: '/ext/bin/opencode',
  });
  assert.equal(got, '/usr/local/bin/opencode');
});

test('bundled binary is the fallback when nothing else is found', () => {
  const got = resolveBinaryPath({ ...base });
  assert.equal(got, '/ext/bin/opencode');
});

test('returns null when every option fails (corrupt install)', () => {
  const got = resolveBinaryPath({ ...base, bundled: null });
  assert.equal(got, null);
});
