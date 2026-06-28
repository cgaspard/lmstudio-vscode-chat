// Entry point for the integration suite. Downloads (cached) a pinned VS Code,
// launches it headless with this extension loaded, and runs the mocha suite in
// the extension host. Invoked by `npm run test:integration`.
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // If this process was started with ELECTRON_RUN_AS_NODE (common in some
  // sandboxes/CI), the launched VS Code would run as plain Node and reject its
  // own GUI args ("bad option: --extensionTestsPath"). Clear it for the child.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // __dirname is out-integration/test-integration. The extension to load is the
  // repo root (real package.json + dist/); the compiled test suite is alongside.
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch {
    console.error('Integration tests failed.');
    process.exit(1);
  }
}

void main();
