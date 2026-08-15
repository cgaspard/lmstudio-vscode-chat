import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizePermissionMode,
  opencodePermission,
  permissionModeLabel,
} from '../src/core/permission';

test('normalizePermissionMode accepts the known modes and falls back on garbage', () => {
  assert.equal(normalizePermissionMode('default'), 'default');
  assert.equal(normalizePermissionMode('strict'), 'strict');
  assert.equal(normalizePermissionMode('bypass'), 'bypass');
  // settings.json is hand-editable
  assert.equal(normalizePermissionMode('yolo'), 'default');
  assert.equal(normalizePermissionMode(''), 'default');
  assert.equal(normalizePermissionMode(undefined), 'default');
  assert.equal(normalizePermissionMode(42), 'default');
});

test('default mode only pre-allows the question tool', () => {
  assert.deepEqual(opencodePermission('default'), { question: 'allow' });
});

test('bypass mode is a single wildcard allow (what a bare "allow" normalizes to)', () => {
  assert.deepEqual(opencodePermission('bypass'), { '*': 'allow' });
});

test('strict mode asks for everything but keeps question interactive', () => {
  const p = opencodePermission('strict');
  assert.deepEqual(p, { '*': 'ask', question: 'allow' });
  // OpenCode flattens with last-match-wins and preserves key order, so the
  // wildcard must be declared BEFORE the question override.
  assert.deepEqual(Object.keys(p), ['*', 'question']);
});

test('no mode ever emits deny (a blanket deny would strip tools from the model)', () => {
  for (const mode of ['default', 'strict', 'bypass'] as const) {
    const values: string[] = Object.values(opencodePermission(mode));
    assert.ok(values.every((v) => v !== 'deny'));
  }
});

test('permissionModeLabel names every mode', () => {
  assert.equal(permissionModeLabel('bypass'), 'Bypass');
  assert.equal(permissionModeLabel('strict'), 'Manual');
  assert.equal(permissionModeLabel('default'), 'Auto');
});
