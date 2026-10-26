// Does chat history from the 1.x server survive the switch to the embedded engine?
//
// Point MIGRATION_ROOT at a COPY of an extension data dir (the folder holding
// data/opencode/opencode.db). Never the live one: OpenCode migrates in place.
//   sqlite3 "file:<live>/data/opencode/opencode.db?mode=ro" ".backup '<copy>/data/opencode/opencode.db'"
//   MIGRATION_ROOT=<copy> npm run test:live migration
import * as path from 'node:path';
import { createHost } from '../src/opencode/embedded';
import { OpencodeV2Client } from '../src/opencode/v2client';

const ROOT = process.env.MIGRATION_ROOT;

(async () => {
  if (!ROOT) {
    console.log('SKIP  set MIGRATION_ROOT to a copy of an extension data dir');
    return;
  }
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'opencode', 'opencode.db'), { readOnly: true });
  const v1 = db.prepare('select directory, count(*) as n from session where parent_id is null group by directory').all() as Array<{ directory: string; n: number }>;
  db.close();

  const host = await createHost(path.resolve(__dirname, '..'), { root: ROOT }, JSON.stringify({}));
  let failed = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    failed += ok ? 0 : 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail.slice(0, 200)}` : ''}`);
  };
  try {
    const t0 = Date.now();
    let status: any;
    for (let i = 0; i < 600; i++) {
      status = await host.migration.v1.status({}).catch((e: unknown) => ({ status: `error: ${e}` }));
      const s = status?.data?.status ?? status?.status;
      if (s === 'completed' || /^error/.test(String(s))) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check('migration completes', (status?.data?.status ?? status?.status) === 'completed', `${JSON.stringify(status).slice(0, 160)} after ${Date.now() - t0}ms`);

    for (const { directory, n } of v1) {
      const client = new OpencodeV2Client(host, directory, 'migration');
      const sessions = await client.listSessions();
      check(`${path.basename(directory)}: exactly its ${n} 1.x session(s) listed`, sessions.length === n && sessions.every((x) => !x.directory || x.directory === directory), `${sessions.length} found`);
      const first = sessions[0];
      if (first) {
        const msgs = await client.getMessages(first.id);
        const users = msgs.filter((m) => m.info.role === 'user').length;
        const parts = msgs.reduce((k, m) => k + m.parts.length, 0);
        check(`${path.basename(directory)}: "${first.title.slice(0, 40)}" loads`, users > 0 && parts > users, `${msgs.length} messages, ${parts} parts`);
      }
      client.dispose();
    }
  } catch (err) {
    check('unexpected exception', false, String((err as Error)?.stack ?? err));
  } finally {
    await host.close();
  }
  process.exitCode = failed ? 1 : 0;
})();
