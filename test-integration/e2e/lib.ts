// Shared steps for the e2e suite: connect the panel to a real model server,
// start fresh chats, type and send, and read what came back.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as h from '../suite/helpers';

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:1234/v1';
// One small model for everything: the LM Studio is shared, so keep loads down.
export const MODEL = process.env.E2E_MODEL ?? 'qwen/qwen3-vl-4b';
export const REASONING_MODEL = process.env.E2E_REASONING_MODEL ?? MODEL;
/** The model the LM Studio tests eject, load and resize: the same one. */
export const SMALL_MODEL = process.env.E2E_SMALL_MODEL ?? MODEL;
export const WORKSPACE = process.env.E2E_WORKSPACE ?? '';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const cfg = () => vscode.workspace.getConfiguration('lmstudioCode');
export const ws = (...p: string[]) => path.join(WORKSPACE, ...p);
export const read = (...p: string[]) => fs.readFileSync(ws(...p), 'utf8');

export async function until(pred: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

/** Point the extension at the model server and open a ready panel. Once per run. */
let connected = false;
export async function connect(): Promise<void> {
  if (connected) {
    return;
  }
  assert(WORKSPACE, 'E2E_WORKSPACE is not set — run via npm run test:e2e');
  // autoEnsureContext stays on (the default): the panel reloads a model that
  // is loaded with too small a window, which is part of what is under test.
  await cfg().update('defaultModel', MODEL, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('lmstudioCode._test.useServer', BASE_URL);
  await h.openPanel();
  await until(async () => /qwen|model/i.test(String(await h.text('#model-btn .model-btn-label'))), 120_000, 'the model chip');
  connected = true;
}

/** A clean conversation on `model` (default MODEL) with `agent` (default build). */
export async function freshChat(opts: { model?: string; agent?: string } = {}): Promise<void> {
  await connect();
  // The panel's own New chat button (the command targets the sidebar view,
  // not this editor-tab panel; /clear deletes every session).
  await until(async () => !(await busy()), 120_000, 'the previous turn to settle');
  await h.click('#ta-new');
  await until(async () => (await h.count('.msg')) === 0, 15_000, 'the conversation to clear');
  await selectModel(opts.model ?? MODEL);
  await h.postToHost({ type: 'selectAgent', agent: opts.agent ?? 'build' });
  await sleep(300);
}

/** LM Studio's chat models, in the order the panel's model menu lists them. */
export async function lmStudioModels(): Promise<Array<{ key: string; loaded: boolean; context: number; reasoning: boolean }>> {
  const root = BASE_URL.replace(/\/v\d+\/?$/, '');
  const res = await fetch(`${root}/api/v1/models`);
  const json = (await res.json()) as { models: any[] };
  return json.models
    .filter((m) => typeof m.key === 'string' && !/embed/i.test(m.type ?? '') && !/embed/i.test(m.key))
    .map((m) => ({
      key: m.key,
      loaded: (m.loaded_instances ?? []).length > 0,
      context: m.loaded_instances?.[0]?.config?.context_length ?? 0,
      reasoning: !!m.capabilities?.reasoning,
    }));
}

/** Open the model menu (the composer's model chip). */
export async function openModelMenu(): Promise<void> {
  if ((await h.count('#model-menu:not(.hidden)')) === 0) {
    await h.click('#model-btn');
  }
  await until(async () => (await h.count('#model-menu-list .model-row')) > 0, 30_000, 'the model menu');
}

export async function closeModelMenu(): Promise<void> {
  if ((await h.count('#model-menu:not(.hidden)')) > 0) {
    await h.click('#model-btn');
  }
}

/** The index of a model's row in the model menu. */
export async function modelRow(model: string): Promise<number> {
  const i = (await lmStudioModels()).findIndex((m) => m.key === model);
  assert(i >= 0, `LM Studio has no model ${model}`);
  return i;
}

/** Pick a model the way a user does: model chip, then its row. */
export async function selectModel(model: string): Promise<void> {
  const i = await modelRow(model);
  await openModelMenu();
  await until(async () => (await h.count('#model-menu-list .model-row')) > i, 30_000, `the ${model} row`);
  await h.click('#model-menu-list .model-row', i); // a row click selects it and closes the menu
  await until(async () => (await h.count('#model-menu:not(.hidden)')) === 0, 5_000, 'the menu to close');
}

export async function busy(): Promise<boolean> {
  return /\bbusy\b/.test(String(await h.attr('#send', 'class')));
}

/** Type `text` into the composer and press Enter (Alt+Enter with `queue`). */
export async function send(text: string, opts: { queue?: boolean } = {}): Promise<void> {
  await h.setInput(text);
  await h.keydown('Enter', { altKey: !!opts.queue });
}

/** Wait for the panel to start and then finish a turn. */
export async function turn(ms = 240_000): Promise<void> {
  await until(busy, 30_000, 'the turn to start').catch(() => undefined); // a fast turn may already be over
  await until(async () => !(await busy()), ms, 'the turn to end');
}

/** Send and wait for the reply. */
export async function ask(text: string, ms = 240_000): Promise<string> {
  const before = await assistantText();
  await send(text);
  await turn(ms);
  const reply = (await assistantText()).slice(before.length);
  if (!reply.trim()) {
    console.log(`      [diag] empty reply to: ${text.slice(0, 60)}\n${await panelState()}`);
  }
  return reply;
}

/** What the panel shows right now, for failure diagnostics. */
export async function panelState(): Promise<string> {
  const lines = [
    `activity: ${await h.text('#activity .activity-label')}`,
    `model chip: ${await h.text('#model-btn .model-btn-label')}`,
    `input: ${await h.attr('#input', 'value')} (disabled=${await h.attr('#input', 'disabled')})`,
    `messages: ${(await h.allText('.msg')).map((t) => t.slice(0, 120)).join(' || ')}`,
    `chips: ${(await h.allText('.sys-chip, .error-bubble')).join(' || ')}`,
    `banner: ${await h.text('#conn-banner')}`,
  ];
  return lines.map((l) => `        ${l}`).join('\n');
}

export async function assistantText(): Promise<string> {
  return (await h.allText('.msg.assistant .part-text')).join('\n');
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

export { h };
