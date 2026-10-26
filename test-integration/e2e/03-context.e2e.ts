// Context: highlighted code rides along, /file attaches the open file, pasted
// images reach a vision model, /compact summarizes.
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ask, freshChat, h, until, ws } from './lib';

/** Open a file beside the panel (as a user would) and select one line. */
async function openAndSelect(rel: string, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ws(rel)));
  const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.Beside });
  if (line < 0) {
    editor.selection = new vscode.Selection(0, 0, 0, 0);
  } else {
    const l = doc.lineAt(line);
    editor.selection = new vscode.Selection(l.range.start, l.range.end);
  }
  await new Promise((r) => setTimeout(r, 800)); // the bridge debounces editor context
}

describe('e2e · context', function () {
  afterEach(async () => {
    // Close the text editors this suite opened — never the panel's tab.
    const textTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText);
    await vscode.window.tabGroups.close(textTabs);
  });

  it('highlighted code is attached to the next message', async () => {
    await freshChat();
    await openAndSelect('src/app.txt', 2); // codeword = BANANA-17
    const reply = await ask('What does my selected text say? Quote it exactly. Do not use any tools.');
    assert.match(reply, /BANANA-17/);
    // The selection rides along as its own attachment, labelled with its lines.
    assert.match((await h.allText('.msg.user')).join(' '), /app\.txt#3/, 'the user message carries the selection');
  });

  it('/file toggles the open file as context, and an included file rides along', async () => {
    await freshChat();
    await openAndSelect('src/app.txt', -1); // open, nothing selected
    // The open file is included by default; /file flips it. Toggle until it
    // reads "included", which proves both directions work.
    const toggle = async (): Promise<string> => {
      const before = (await h.allText('.sys-chip')).length;
      await h.setInput('/file');
      await h.keydown('Enter');
      await until(async () => (await h.allText('.sys-chip')).length > before, 10_000, 'the /file chip');
      return (await h.allText('.sys-chip')).at(-1) ?? '';
    };
    const first = await toggle();
    const second = await toggle();
    assert.deepStrictEqual(
      [first, second].map((t) => (/included in/.test(t) ? 'in' : /excluded from/.test(t) ? 'out' : t)).sort(),
      ['in', 'out'],
      `/file toggles (${first} / ${second})`,
    );
    if (/excluded from/.test(second)) {
      await toggle();
    }
    const reply = await ask('According to the attached file, what is the codeword? Do not use any tools.');
    assert.match(reply, /BANANA-17/);
  });

  it('a pasted image reaches a vision model', async () => {
    await freshChat();
    const png = fs.readFileSync(ws('red.png')).toString('base64');
    const pending = await h.addImage(`data:image/png;base64,${png}`, 'red.png');
    assert.strictEqual(pending, 1, 'the image is pending as a chip');
    const reply = await ask('What single color fills this image? Answer with one word.');
    assert.match(reply, /red/i);
  });

  it('/compact summarizes the conversation and shows the summary', async function () {
    this.timeout(900_000);
    await freshChat();
    await ask('Remember this: the launch code is ZEBRA-9. Reply OK.', 600_000);
    await h.setInput('/compact');
    await h.keydown('Enter');
    await until(async () => (await h.count('.compaction-chip')) > 0, 300_000, 'the compaction chip');
    // The summary lands in the chip once compaction ends, which makes it expandable.
    await until(async () => (await h.attr('.compaction-chip .compaction-head', 'disabled')) === null, 300_000, 'the summary in the chip');
    assert.ok((await h.count('.compaction-chip .compaction-body *')) > 0, 'the chip carries the summary');
    const reply = await ask('What was the launch code? Answer with just the code.', 600_000);
    assert.match(reply, /ZEBRA-9/, 'context survived compaction');
  });
});
