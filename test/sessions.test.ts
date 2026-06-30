import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptySessionCandidates, isEmptySessionCandidate, PruneScope } from '../src/core/sessions';

// A fixed "now" well past the min-age floor so age never accidentally excludes.
const NOW = 10_000_000;
const OLD = NOW - 60 * 60 * 1000; // an hour ago — safely older than the 5-min floor

const scope = (over: Partial<PruneScope> = {}): PruneScope => ({
  currentSessionID: null,
  now: NOW,
  ...over,
});

const empty = (id: string, t: number, directory?: string) => ({
  id,
  directory,
  time: { created: t, updated: t },
});
const used = (id: string, c: number, u: number, directory?: string) => ({
  id,
  directory,
  time: { created: c, updated: u },
});

test('isEmptySessionCandidate: empty when updated <= created (and old enough)', () => {
  assert.equal(isEmptySessionCandidate(empty('a', OLD), scope()), true);
  assert.equal(isEmptySessionCandidate(used('a', OLD, OLD), scope()), true); // equal
});

test('isEmptySessionCandidate: not empty once updated is bumped past created', () => {
  assert.equal(isEmptySessionCandidate(used('a', OLD, OLD + 1), scope()), false);
});

test('isEmptySessionCandidate: never flags the active session', () => {
  assert.equal(
    isEmptySessionCandidate(empty('current', OLD), scope({ currentSessionID: 'current' })),
    false,
  );
});

test('isEmptySessionCandidate: tolerates missing time fields (treated as empty)', () => {
  assert.equal(isEmptySessionCandidate({ id: 'a' }, scope()), true);
  assert.equal(isEmptySessionCandidate({ id: 'a', time: {} }, scope()), true);
  assert.equal(isEmptySessionCandidate({ id: 'a', time: { created: 5 } }, scope()), true);
});

// ---- in-flight age floor -------------------------------------------------

test('isEmptySessionCandidate: a freshly-created session is NOT a candidate (in-flight guard)', () => {
  // created just now — a sibling bridge could be mid-send on it.
  assert.equal(isEmptySessionCandidate(empty('a', NOW), scope()), false);
  // created 1 minute ago, default floor is 5 minutes -> still protected.
  assert.equal(isEmptySessionCandidate(empty('a', NOW - 60_000), scope()), false);
  // older than the floor -> eligible.
  assert.equal(isEmptySessionCandidate(empty('a', NOW - 6 * 60_000), scope()), true);
});

test('isEmptySessionCandidate: minAgeMs is configurable', () => {
  const s = empty('a', NOW - 1000); // 1s old
  assert.equal(isEmptySessionCandidate(s, scope({ minAgeMs: 500 })), true); // floor below age
  assert.equal(isEmptySessionCandidate(s, scope({ minAgeMs: 5000 })), false); // floor above age
});

// ---- workspace/directory scoping -----------------------------------------

test('isEmptySessionCandidate: only sessions in the current workspace are candidates', () => {
  const here = scope({ directory: '/work/proj' });
  assert.equal(isEmptySessionCandidate(empty('a', OLD, '/work/proj'), here), true);
  // a different workspace -> never a candidate (shared global store).
  assert.equal(isEmptySessionCandidate(empty('b', OLD, '/work/other'), here), false);
});

test('isEmptySessionCandidate: a directory-less session is skipped when we know our own', () => {
  const here = scope({ directory: '/work/proj' });
  assert.equal(isEmptySessionCandidate(empty('a', OLD, undefined), here), false);
});

test('isEmptySessionCandidate: no directory filter when the workspace is unknown', () => {
  const nowhere = scope({ directory: '' });
  // with no workspace directory we fall back to the un-scoped behaviour.
  assert.equal(isEmptySessionCandidate(empty('a', OLD, '/work/anything'), nowhere), true);
  assert.equal(isEmptySessionCandidate(empty('b', OLD, undefined), nowhere), true);
});

// ---- emptySessionCandidates ----------------------------------------------

test('emptySessionCandidates: returns only safe empty candidates', () => {
  const sessions = [
    empty('e1', OLD, '/work/proj'),
    used('u1', OLD, OLD + 9, '/work/proj'),
    empty('current', OLD, '/work/proj'),
    empty('e2', OLD, '/work/proj'),
    empty('fresh', NOW, '/work/proj'), // too new -> excluded
    empty('other', OLD, '/work/other'), // wrong workspace -> excluded
  ];
  const out = emptySessionCandidates(
    sessions,
    scope({ currentSessionID: 'current', directory: '/work/proj' }),
  );
  assert.deepEqual(out.map((s) => s.id), ['e1', 'e2']);
});

test('emptySessionCandidates: empty list in, empty list out', () => {
  assert.deepEqual(emptySessionCandidates([], scope()), []);
});
