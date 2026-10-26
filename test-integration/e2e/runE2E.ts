// End-to-end suite: the real panel, the embedded OpenCode 2 engine, a real
// local model, and a workspace with files, agents, commands, skills and an MCP
// server. Every README feature gets exercised through the actual UI.
//
//   npm run test:e2e
//
// Needs LM Studio (default http://127.0.0.1:1234/v1) with one small tool-capable
// vision model (default qwen/qwen3-vl-4b), which the LM Studio tests also
// eject, load and resize through the panel; override with E2E_BASE_URL /
// E2E_MODEL / E2E_SMALL_MODEL. Reasoning is proven against a scripted
// server (fakeThinker.ts), so no reasoning model is ever loaded. Each run gets a fresh copy of
// test-integration/e2e/workspace, so edits the agent makes never touch the repo.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const repo = path.resolve(__dirname, '..', '..', '..');
  const fixture = path.join(repo, 'test-integration', 'e2e', 'workspace');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-e2e-ws-'));
  fs.cpSync(fixture, workspace, { recursive: true });
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION ?? '1.130.0',
      extensionDevelopmentPath: repo,
      extensionTestsPath: path.resolve(__dirname, 'index.js'),
      // A fresh profile per run, so a previous run's sessions and settings
      // cannot make a test pass.
      launchArgs: [
        workspace,
        '--disable-extensions',
        `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'lms-e2e-profile-'))}`,
        // A run takes half an hour; another window on top must not throttle
        // this one's renderer (and with it the webview the suite drives).
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ],
      extensionTestsEnv: {
        E2E_WORKSPACE: workspace,
        LMSTUDIO_CODE_LOG_STDOUT: '1',
        OPENCODE_CHAT_LOG_STDOUT: '1',
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('E2E_')) as Array<[string, string]>),
      },
    });
  } catch {
    console.error('E2E tests failed.');
    process.exitCode = 1;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

void main();
