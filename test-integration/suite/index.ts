// Runs inside the extension host (launched by runTests.ts). Discovers and runs
// the *.itest.js files with mocha.
import * as path from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 });
  const testsRoot = __dirname;
  const files = await glob('**/*.itest.js', { cwd: testsRoot });
  files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
