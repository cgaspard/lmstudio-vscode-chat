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

/** Trimmed textContent of every match. */
export async function allText(selector: string): Promise<string[]> {
  return (await exec({ __test__: 'query', selector, prop: 'text' })).values;
}

/** Dispatch a real click on the first match (or the `index`-th). Returns false if nothing matched. */
export async function click(selector: string, index = 0): Promise<boolean> {
  return (await exec({ __test__: 'click', selector, index })).ok;
}

/** Messages the webview posted to the host, newest last (optionally of one type). */
export async function posted(type?: string): Promise<Array<Record<string, unknown>>> {
  return (await exec({ __test__: 'posted', ...(type ? { type } : {}) })).messages;
}

/** Attach an image the way a paste does (data: URL). Resolves once it is pending. */
export async function addImage(dataUrl: string, name = 'image.png'): Promise<number> {
  return (await exec({ __test__: 'addImage', dataUrl, name })).pending;
}

/** Send a webview→host message as one of the panel's own controls would. */
export async function postToHost(message: Record<string, unknown>): Promise<void> {
  await exec({ __test__: 'postToHost', message });
}

/** Press a key on the composer (or `selector`), e.g. Enter with altKey to queue. */
export async function keydown(key: string, mods: { altKey?: boolean; shiftKey?: boolean; selector?: string } = {}): Promise<boolean> {
  return (await exec({ __test__: 'keydown', key, ...mods })).ok;
}

/** Set the composer input value and fire its input event (drives autocomplete). */
export async function setInput(value: string): Promise<void> {
  await exec({ __test__: 'setInput', value });
}

/** Set a <select>'s value and fire change (drives picker controls). */
export async function setSelect(selector: string, value: string): Promise<boolean> {
  return (await exec({ __test__: 'setSelect', selector, value })).ok;
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
