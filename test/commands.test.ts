import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commandTakesArgs,
  matchSlashPrefix,
  mergeSlashCommands,
  parseSlashInput,
} from '../src/core/commands';

// ---- commandTakesArgs ----------------------------------------------------

test('commandTakesArgs: true when hints contain $ARGUMENTS or $N', () => {
  assert.equal(commandTakesArgs(['$ARGUMENTS']), true);
  assert.equal(commandTakesArgs(['$1']), true);
  assert.equal(commandTakesArgs(['prefix $2 suffix']), true);
});

test('commandTakesArgs: false for empty / missing / non-arg hints', () => {
  assert.equal(commandTakesArgs([]), false);
  assert.equal(commandTakesArgs(undefined), false);
  assert.equal(commandTakesArgs(null), false);
  assert.equal(commandTakesArgs('$ARGUMENTS' as unknown), false); // not an array
  assert.equal(commandTakesArgs(['no placeholders here']), false);
});

// ---- mergeSlashCommands --------------------------------------------------

test('mergeSlashCommands: local first, then server, deduped by name', () => {
  const local = [{ name: '/clear' }, { name: '/compact' }];
  const server = [{ name: '/review' }, { name: '/fib' }];
  const out = mergeSlashCommands(local, server);
  assert.deepEqual(out.map((c) => c.name), ['/clear', '/compact', '/review', '/fib']);
});

test('mergeSlashCommands: a local command wins over a same-named server command', () => {
  const local = [{ name: '/compact', kind: 'local' }];
  const server = [{ name: '/compact', kind: 'server' }, { name: '/review', kind: 'server' }];
  const out = mergeSlashCommands(local, server);
  // only the local /compact survives; /review is kept
  assert.deepEqual(out.map((c) => c.name), ['/compact', '/review']);
  assert.equal((out[0] as { kind: string }).kind, 'local');
});

test('mergeSlashCommands: handles empty sides', () => {
  assert.deepEqual(mergeSlashCommands([], [{ name: '/x' }]).map((c) => c.name), ['/x']);
  assert.deepEqual(mergeSlashCommands([{ name: '/x' }], []).map((c) => c.name), ['/x']);
  assert.deepEqual(mergeSlashCommands([], []), []);
});

// ---- matchSlashPrefix ----------------------------------------------------

const CMDS = [{ name: '/clear' }, { name: '/compact' }, { name: '/mcp' }, { name: '/skills' }];

test('matchSlashPrefix: filters by case-insensitive prefix', () => {
  assert.deepEqual(matchSlashPrefix('/c', CMDS).map((c) => c.name), ['/clear', '/compact']);
  assert.deepEqual(matchSlashPrefix('/CO', CMDS).map((c) => c.name), ['/compact']);
  assert.deepEqual(matchSlashPrefix('/s', CMDS).map((c) => c.name), ['/skills']);
});

test('matchSlashPrefix: bare "/" matches everything', () => {
  assert.equal(matchSlashPrefix('/', CMDS).length, CMDS.length);
});

test('matchSlashPrefix: nothing once whitespace appears (args / real prompt)', () => {
  assert.deepEqual(matchSlashPrefix('/mcp ', CMDS), []);
  assert.deepEqual(matchSlashPrefix('/skills do thing', CMDS), []);
});

test('matchSlashPrefix: empty for non-slash input', () => {
  assert.deepEqual(matchSlashPrefix('hello', CMDS), []);
  assert.deepEqual(matchSlashPrefix('', CMDS), []);
});

// ---- parseSlashInput -----------------------------------------------------

test('parseSlashInput: splits name (lowercased) from trailing args', () => {
  assert.deepEqual(parseSlashInput('/fib make it fast'), { name: '/fib', args: 'make it fast' });
  assert.deepEqual(parseSlashInput('/FIB  Extra   Spaces'), { name: '/fib', args: 'Extra   Spaces' });
});

test('parseSlashInput: bare command has empty args', () => {
  assert.deepEqual(parseSlashInput('/clear'), { name: '/clear', args: '' });
  assert.deepEqual(parseSlashInput('/clear   '), { name: '/clear', args: '' });
});

test('parseSlashInput: null for non-slash text', () => {
  assert.equal(parseSlashInput('just a prompt'), null);
  assert.equal(parseSlashInput(''), null);
});
