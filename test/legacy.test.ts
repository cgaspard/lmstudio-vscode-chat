import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATION_KEY, RESYNC_KEY, rearmLegacyMigration } from '../src/core/legacy';

function db(opts: { legacy?: number[]; kv?: boolean; migration?: string } = {}) {
  const d = new DatabaseSync(':memory:');
  if (opts.legacy) {
    d.exec('CREATE TABLE session (id text primary key, time_updated integer)');
    opts.legacy.forEach((t, i) => d.prepare('INSERT INTO session VALUES (?, ?)').run(`s${i}`, t));
  }
  if (opts.kv !== false) {
    d.exec('CREATE TABLE kv (key text primary key, value text not null, time_created integer not null, time_updated integer not null)');
  }
  if (opts.migration) {
    d.prepare('INSERT INTO kv VALUES (?, ?, 0, 0)').run(MIGRATION_KEY, JSON.stringify({ phase: opts.migration }));
  }
  return d;
}
const kv = (d: DatabaseSync, key: string) => {
  const row = d.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
};

test('a fresh install has nothing to resync', () => {
  assert.equal(rearmLegacyMigration(db()), 'no-legacy');
});

test('a database OpenCode 2 has not touched yet is left to the migrator', () => {
  assert.equal(rearmLegacyMigration(db({ legacy: [10], kv: false })), 'no-legacy');
});

test('1.x writes after a completed migration re-arm the sessions phase', () => {
  const d = db({ legacy: [10, 50], migration: 'completed' });
  assert.equal(rearmLegacyMigration(d), 'rearmed');
  assert.deepEqual(kv(d, MIGRATION_KEY), { phase: 'sessions' }, 'sessions phase: the event log is not cleared');
  assert.equal(kv(d, RESYNC_KEY), 50);
});

test('once resynced, it does not run again until 1.x writes something newer', () => {
  const d = db({ legacy: [10, 50], migration: 'completed' });
  rearmLegacyMigration(d);
  d.prepare('INSERT INTO kv VALUES (?, ?, 0, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MIGRATION_KEY, JSON.stringify({ phase: 'completed' }));
  assert.equal(rearmLegacyMigration(d), 'up-to-date');
  assert.deepEqual(kv(d, MIGRATION_KEY), { phase: 'completed' });
  // A downgrade that writes 1.x again triggers one more resync.
  d.prepare('INSERT INTO session VALUES (?, ?)').run('s9', 99);
  assert.equal(rearmLegacyMigration(d), 'rearmed');
  assert.equal(kv(d, RESYNC_KEY), 99);
});

test('a migration still in progress is left alone; only the mark is recorded', () => {
  const d = db({ legacy: [10], migration: 'sessions' });
  assert.equal(rearmLegacyMigration(d), 'up-to-date');
  assert.deepEqual(kv(d, MIGRATION_KEY), { phase: 'sessions' });
  assert.equal(kv(d, RESYNC_KEY), 10);
});
