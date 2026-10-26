// Keeping 1.x chat history visible after the move to the embedded OpenCode 2
// engine.
//
// OpenCode 2 reads sessions from its own tables (session_v2, session_message).
// 1.x servers up to 1.18 dual-wrote those tables, and a migrator copies the
// rest — but it runs once, records `migration.v1-v2 = completed`, and never
// looks again. 1.19 writes only the 1.x tables, so anything created or
// continued under 1.19 after that first migration is invisible to OpenCode 2.
//
// The fix: before the engine opens the database, re-arm the migrator's
// `sessions` phase whenever the 1.x tables hold writes newer than the last
// resync. That phase rebuilds each session from the 1.x tables (the copy 1.x
// kept current) and, unlike a migration from scratch, leaves the event log
// alone. The high-water mark stops it from re-running once 1.x is no longer
// writing.
//
// Known trade-off: a resync rebuilds sessions that exist in the 1.x tables, so
// messages added to such a session under OpenCode 2 are replaced by its 1.x
// copy. That only happens after a downgrade to a 1.x build that then writes
// again, and the alternative is losing everything written during it.

/** The subset of node:sqlite's DatabaseSync this module uses. */
export interface SqlDb {
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
}

/** The migrator's own progress key (OpenCode 2 core). */
export const MIGRATION_KEY = 'migration.v1-v2';
/** Our high-water mark: the newest 1.x session update already resynced. */
export const RESYNC_KEY = 'lmstudio-vscode-chat.legacy-resync';

export type ResyncDecision = 'no-legacy' | 'up-to-date' | 'rearmed';

/**
 * Re-arm OpenCode 2's 1.x migration if the 1.x tables changed since the last
 * resync. Returns what it did. Safe to call on every start: it is a no-op once
 * the 1.x tables stop changing.
 */
export function rearmLegacyMigration(db: SqlDb, now = Date.now()): ResyncDecision {
  const hasTable = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (!hasTable('session') || !hasTable('kv')) {
    // No 1.x data (a fresh install), or a database OpenCode 2 has not created
    // its tables in yet, in which case it migrates from scratch on its own.
    return 'no-legacy';
  }
  const newest = Number((db.prepare('SELECT MAX(time_updated) AS v FROM session').get() as { v?: number } | undefined)?.v ?? 0);
  if (!newest) {
    return 'no-legacy';
  }
  const mark = Number(readKv(db, RESYNC_KEY) ?? 0);
  const migration = readKv(db, MIGRATION_KEY) as { phase?: string } | undefined;
  // Never resynced and the migrator has not finished either: it will process
  // every session itself, so only record the mark.
  if (newest <= mark || (!mark && migration?.phase !== 'completed')) {
    if (!mark) {
      writeKv(db, RESYNC_KEY, newest, now);
    }
    return 'up-to-date';
  }
  writeKv(db, MIGRATION_KEY, { phase: 'sessions' }, now);
  writeKv(db, RESYNC_KEY, newest, now);
  return 'rearmed';
}

function readKv(db: SqlDb, key: string): unknown {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined;
  if (!row?.value) {
    return undefined;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

function writeKv(db: SqlDb, key: string, value: unknown, now: number): void {
  db.prepare(
    'INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, time_updated = excluded.time_updated',
  ).run(key, JSON.stringify(value), now, now);
}
