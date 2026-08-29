// Integration tests for editor context tracking — the "Include open file" row
// and the auto-attached selection in the add-context menu.
//
// Unlike the injection-driven suites, this one drives the HOST: it opens and
// closes a real editor and asserts the webview follows. The bug it protects
// against: the bridge deliberately keeps the last file/selection when the
// active editor goes undefined (so clicking into the composer doesn't wipe your
// context), and closing a tab fires neither an active-editor nor a selection
// change for that document — so a closed file used to stay pinned forever,
// showing a phantom "Include open file" row and silently attaching its stale
// selection to every later message.
//
// Named zz-* so it runs after the injection-driven suites: it replaces the
// activeFile state v080 injects.
//
// NOTE: the harness's chat panel is itself an editor tab, so this suite closes
// only its own file's tab — never closeAllEditors, which would take the webview
// (and the test hook) down with it.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as helpers from './helpers';

const { openPanel, count, text } = helpers;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until a selector's text satisfies the predicate. Tolerates a failed
 * exec (the webview can be mid-render while the editor takes focus).
 */
async function waitForText(
  selector: string,
  pred: (s: string | null) => boolean,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  let last: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await text(selector);
      if (pred(last)) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(150);
  }
  throw new Error(`waitForText(${selector}) timed out — last was ${JSON.stringify(last)}`);
}

/** Poll until a selector's match count satisfies the predicate. */
async function waitForCount(
  selector: string,
  pred: (n: number) => boolean,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await count(selector);
      if (pred(last)) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(150);
  }
  throw new Error(`waitForCount(${selector}) timed out — last was ${last}`);
}

/** Close every tab showing `file`, leaving the chat panel's tab alone. */
async function closeTabsFor(file: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.fsPath === file);
  if (tabs.length) {
    await vscode.window.tabGroups.close(tabs, false);
  }
}

describe('editor context', function () {
  this.timeout(60000);

  // A real on-disk file, so the bridge sees a `file:` scheme document. Written
  // to the temp dir because the harness launches VS Code with no workspace.
  const file = path.join(os.tmpdir(), `lmcode-ctx-${process.pid}.js`);
  const base = path.basename(file);

  before(async () => {
    fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    await openPanel();
  });

  after(async () => {
    await closeTabsFor(file);
    fs.rmSync(file, { force: true });
  });

  it('tracks the open file and its selection', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
    editor.selection = new vscode.Selection(0, 0, 1, 5);

    // Wait on our own file specifically — an earlier suite injects a fake
    // activeFile, so a merely-visible row proves nothing.
    await waitForText('#menu-ctxfile-meta', (s) => s === base);
    await waitForText('#menu-ctxsel-meta', (s) => !!s && s.startsWith(base) && s.includes('1'));
    assert.strictEqual(await count('#menu-ctxfile:not(.hidden)'), 1, 'open-file row visible');
    assert.strictEqual(await count('#menu-ctxsel:not(.hidden)'), 1, 'selection row visible');
  });

  it('drops the file and the selection once the editor is closed', async () => {
    await closeTabsFor(file);
    await waitForCount('#menu-ctxfile:not(.hidden)', (n) => n === 0);
    assert.strictEqual(
      await count('#menu-ctxsel:not(.hidden)'),
      0,
      'a closed file leaves no selection attached',
    );
  });
});
