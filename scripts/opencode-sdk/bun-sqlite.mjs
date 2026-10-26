// `bun:sqlite` for the embedded engine, over Node's built-in node:sqlite.
//
// Only OpenCode 2's 1.x session migrator imports bun:sqlite, and only to read
// an old `opencode-next.db` (a v2 pre-release database) if one exists. This
// covers exactly the surface it uses: open read-only, query(sql).get/all,
// run(sql), inTransaction, close. scripts/build-opencode-sdk.js maps the
// `bun:sqlite` import here.
import { DatabaseSync } from 'node:sqlite';

export class Database {
  constructor(path, options = {}) {
    this.db = new DatabaseSync(path, { readOnly: !!options.readonly });
  }

  query(sql) {
    const stmt = this.db.prepare(sql);
    return {
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
      run: (...params) => stmt.run(...params),
    };
  }

  run(sql, ...params) {
    return params.length ? this.db.prepare(sql).run(...params) : this.db.exec(sql);
  }

  get inTransaction() {
    return this.db.isTransaction;
  }

  close() {
    this.db.close();
  }
}

export default { Database };
