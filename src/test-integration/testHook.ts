// Host-side half of the webview test hook. Imported by the extension ONLY when
// __TEST__ is set (esbuild drops it from production). It registers commands the
// integration tests call to drive + inspect the live webview:
//   lmstudioCode._test.attach  — register the active webview (called by the provider)
//   lmstudioCode._test.exec    — relay a {__test__} op to the webview, await its result
//   lmstudioCode._test.post    — inject a raw HostToWebview message (the fake event stream)
//
// The webview half (installTestHook in webview/main.ts) answers `query`/`click`
// over postMessage and replies with { __test__: 'result', id, ... }.
import * as vscode from 'vscode';

let activeWebview: vscode.Webview | undefined;
let resultSub: vscode.Disposable | undefined;
const pending = new Map<number, (payload: any) => void>();
let nextId = 1;

/** Called by the webview provider (under __TEST__) so tests can reach the live view. */
export function attachTestWebview(webview: vscode.Webview): void {
  activeWebview = webview;
  resultSub?.dispose();
  resultSub = webview.onDidReceiveMessage((m: any) => {
    if (m && m.__test__ === 'result' && typeof m.id === 'number') {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
}

function exec(op: Record<string, unknown>): Promise<any> {
  if (!activeWebview) {
    return Promise.reject(new Error('no webview attached for tests'));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`__test__ op timed out: ${JSON.stringify(op)}`));
    }, 5000);
    pending.set(id, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    void activeWebview!.postMessage({ __test__: op.__test__, id, ...op });
  });
}

/** Register the test commands. Returns a disposable to tear them down. */
export function registerTestCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('lmstudioCode._test.exec', (op: Record<string, unknown>) =>
      exec(op),
    ),
    // Inject a raw host->webview message — used to feed the fake event stream.
    vscode.commands.registerCommand('lmstudioCode._test.post', (msg: unknown) => {
      if (!activeWebview) {
        throw new Error('no webview attached for tests');
      }
      return activeWebview.postMessage(msg as never);
    }),
  );
}
