// Runs inside the extension host for runE2E.ts: the *.e2e.js files, in order.
import * as path from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  // Real model turns: generous per-test timeout, and no retries — a flaky
  // feature should show up as a failure, not hide behind a second attempt.
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 300_000, ...(process.env.E2E_GREP ? { grep: process.env.E2E_GREP } : {}) });
  const files = (await glob('**/*.e2e.js', { cwd: __dirname })).sort();
  files.forEach((f) => mocha.addFile(path.resolve(__dirname, f)));
  // On any failure, print what the panel was showing: the assertion alone
  // rarely says whether the model, the engine or the UI went wrong.
  mocha.suite.afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      const { panelState } = await import('./lib');
      console.log(`      [panel at failure]\n${await panelState().catch((e) => `        (unavailable: ${e})`)}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
