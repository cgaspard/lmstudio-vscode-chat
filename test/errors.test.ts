import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText, humanizeError, isAbortError, isConnectionError } from '../src/core/errors';

// Helpers to fake the error shapes we actually see from fetch / undici / SSE.
const named = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name });
const withCause = (message: string, cause: unknown): Error =>
  Object.assign(new TypeError(message), { cause });

test('errorText extracts a message from every shape we encounter', () => {
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText('plain string'), 'plain string');
  assert.equal(errorText({ message: 'obj message' }), 'obj message');
  assert.equal(errorText({ data: { message: 'sse message' } }), 'sse message'); // OpenCode SSE
  assert.equal(errorText(withCause('', new Error('the real cause'))), 'the real cause');
  assert.equal(errorText(null), '');
  assert.equal(errorText(undefined), '');
});

test('isConnectionError catches the many faces of a dropped connection', () => {
  assert.equal(isConnectionError(new TypeError('fetch failed')), true);
  assert.equal(isConnectionError('Failed to fetch'), true); // browser fetch
  assert.equal(isConnectionError(withCause('fetch failed', new Error('connect ECONNREFUSED 127.0.0.1:1234'))), true);
  assert.equal(isConnectionError(named('TimeoutError', 'The operation timed out')), true);
  assert.equal(isConnectionError(new Error('socket hang up')), true);
  assert.equal(isConnectionError(new Error('read ECONNRESET')), true);
  assert.equal(isConnectionError(new Error('getaddrinfo ENOTFOUND host')), true);
  assert.equal(isConnectionError(new TypeError('terminated')), true); // undici cut stream
  assert.equal(isConnectionError({ data: { message: 'fetch failed' } }), true); // SSE error event
});

test('isConnectionError ignores real application errors and user aborts', () => {
  assert.equal(isConnectionError(new Error("model 'qwen' not found")), false);
  assert.equal(isConnectionError(new Error('Bad Request')), false);
  assert.equal(isConnectionError(named('AbortError', 'The operation was aborted')), false);
  assert.equal(isConnectionError(null), false);
  assert.equal(isConnectionError(''), false);
});

test('isAbortError only matches genuine aborts', () => {
  assert.equal(isAbortError(named('AbortError', 'aborted')), true);
  assert.equal(isAbortError(named('TimeoutError', 'timed out')), false);
  assert.equal(isAbortError(new Error('fetch failed')), false);
});

test('humanizeError turns connection faults into a friendly, reassuring line', () => {
  assert.equal(
    humanizeError(new TypeError('fetch failed'), { subject: 'LM Studio' }),
    'Lost connection to LM Studio — reconnecting…',
  );
  assert.equal(
    humanizeError(new TypeError('fetch failed'), { subject: 'LM Studio', reconnecting: false }),
    'Lost connection to LM Studio.',
  );
  // The exact ugly string from the screenshot must never reach the user verbatim.
  assert.notEqual(humanizeError('fetch failed', { subject: 'LM Studio' }), 'fetch failed');
});

test('humanizeError passes real errors through and handles aborts/empties', () => {
  assert.equal(humanizeError(new Error("model 'x' not found")), "model 'x' not found");
  assert.equal(humanizeError(named('AbortError', 'aborted')), 'Stopped.');
  assert.equal(humanizeError(null), 'Something went wrong.');
  assert.equal(humanizeError('   '), 'Something went wrong.');
});

test('humanizeError is idempotent on its own output', () => {
  const once = humanizeError(new TypeError('fetch failed'), { subject: 'LM Studio' });
  assert.equal(humanizeError(once, { subject: 'LM Studio' }), once);
});
