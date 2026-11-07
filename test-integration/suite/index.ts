// Runs inside the extension host (launched by runTests.ts). Discovers and runs
// the *.itest.js files with mocha.
import * as path from 'node:path';
import { glob } from 'glob';
import Mocha from 'mocha';
import * as vscode from 'vscode';

/**
 * Every suite runs against a server that is not there unless it opts into one
 * with `_test.useServer`. Injection-driven suites click Load and Send on
 * fixture models, and those clicks reach the real host. Pointed at this
 * machine's LM Studio, the host would answer with the real model list and then
 * load whatever model sat first in it, or run a real prompt. Only the live
 * suites connect to a real server, deliberately, after checking what is loaded.
 */
const DEAD_SERVER = 'http://127.0.0.1:9/v1';

/** The test commands register on activation, which can trail the runner's start. */
async function waitForTestCommands(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await vscode.commands.getCommands(true)).includes('lmstudioCode._test.useServer')) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('lmstudioCode test commands never registered (is the extension built with __TEST__?)');
}

export async function run(): Promise<void> {
  // ITEST_GREP runs a single suite — the live LM Studio one reloads real models
  // and is far too slow to sit through when you only want the rest.
  let restore: unknown;
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 30000,
    rootHooks: {
      async beforeAll() {
        await waitForTestCommands();
        restore = await vscode.commands.executeCommand('lmstudioCode._test.useServer', DEAD_SERVER);
      },
      async afterAll() {
        if (restore) {
          await vscode.commands.executeCommand('lmstudioCode._test.restoreServer', restore);
        }
      },
    },
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
