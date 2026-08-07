// Runs inside the extension host (launched by runTests.ts). Discovers and runs
// the *.itest.js files with mocha.
import * as path from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  // ITEST_GREP runs a single suite — the live LM Studio one reloads real models
  // and is far too slow to sit through when you only want the rest.
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 30000,
    ...(process.env.ITEST_GREP ? { grep: process.env.ITEST_GREP } : {}),
  });
  const testsRoot = __dirname;
  // Sorted, because the suite order is load-bearing: the zz-*/zzz-* prefixes
  // are how state-disturbing suites (a real connection, an open model picker)
  // are kept behind the injection-driven ones on the shared webview. glob does
  // not promise an order of its own.
  const files = (await glob('**/*.itest.js', { cwd: testsRoot })).sort();
  files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
