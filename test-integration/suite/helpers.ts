// Friendly wrappers around the extension's test commands, for driving and
// inspecting the live webview from inside the extension host.
import * as vscode from 'vscode';
import type { HostToWebview } from '../../src/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open the chat panel and wait for the webview to boot + register itself. */
export async function openPanel(): Promise<void> {
  await vscode.commands.executeCommand('lmstudioCode._test.openPanel');
  await sleep(800); // let the webview script load and install its test hook
}

/** Inject a host->webview message (drives the fake event stream). */
export async function post(msg: HostToWebview | Record<string, unknown>): Promise<void> {
  await vscode.commands.executeCommand('lmstudioCode._test.post', msg);
}

async function exec(op: Record<string, unknown>): Promise<any> {
  return vscode.commands.executeCommand('lmstudioCode._test.exec', op);
}

/** Number of elements matching a selector. */
export async function count(selector: string): Promise<number> {
  return (await exec({ __test__: 'query', selector, prop: 'text' })).count;
}

/** Trimmed textContent of the first match (null if none). */
export async function text(selector: string): Promise<string | null> {
  return (await exec({ __test__: 'query', selector, prop: 'text' })).value;
}

/** An attribute (or 'class') of the first match. */
export async function attr(selector: string, prop: string): Promise<string | null> {
  return (await exec({ __test__: 'query', selector, prop })).value;
}

/** className list of every match. */
export async function classes(selector: string): Promise<string[]> {
  return (await exec({ __test__: 'query', selector, prop: 'class' })).values;
}

/** Dispatch a real click on the first match. Returns false if nothing matched. */
export async function click(selector: string): Promise<boolean> {
  return (await exec({ __test__: 'click', selector })).ok;
}

/** Set the composer input value and fire its input event (drives autocomplete). */
export async function setInput(value: string): Promise<void> {
  await exec({ __test__: 'setInput', value });
}

/** Poll until the predicate over a selector's count holds (or time out). */
export async function waitFor(
  selector: string,
  pred: (n: number) => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred(await count(selector))) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`waitFor(${selector}) timed out`);
}
