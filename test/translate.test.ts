import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  EventTranslator,
  textPartId,
  toolPartId,
  v1History,
  v1Permission,
  v1Questions,
  v1ToolInput,
  v1ToolName,
  v2FormAnswer,
  v2PromptFile,
  type V2Event,
} from '../src/opencode/translate';

// Payloads captured from a live OpenCode 2.1.4 (paths scrubbed).
const fx = JSON.parse(readFileSync('test/fixtures-v2.json', 'utf8')) as Record<string, V2Event[]> & { history: any[] };

function run(events: V2Event[]) {
  const t = new EventTranslator();
  return { t, out: events.flatMap((e) => t.translate(e)) };
}
const types = (out: Array<{ type: string }>) => out.map((e) => e.type);

test('a tool-using turn becomes assistant message, text, tool parts and idle', () => {
  const { out } = run(fx.toolWrite);
  const tys = types(out);
  assert.ok(tys.includes('message.updated'));
  assert.ok(tys.includes('message.part.delta'));
  assert.equal(tys.at(-1), 'session.idle');
  const tool = out
    .filter((e) => e.type === 'message.part.updated' && (e.properties as any).part.type === 'tool')
    .map((e) => (e.properties as any).part);
  assert.ok(tool.length >= 2, 'tool part updated as it progresses');
  const done = tool.at(-1);
  assert.equal(done.tool, 'write');
  assert.equal(done.state.status, 'completed');
  assert.equal(done.state.input.filePath, done.state.input.path, 'path mirrored to filePath for the webview');
  assert.match(done.state.output, /hello/i);
  // Every tool update for one call lands on the same webview element.
  assert.equal(new Set(tool.map((p) => p.id)).size, 1);
});

test('text deltas and the final part share one part id', () => {
  const { out } = run(fx.toolWrite);
  const delta = out.find((e) => e.type === 'message.part.delta')!.properties as any;
  const finals = out.filter((e) => e.type === 'message.part.updated' && (e.properties as any).part.id === delta.partID);
  assert.ok(finals.length >= 1);
  assert.equal(delta.field, 'text');
});

test('the user bubble appears when the prompt is delivered, not when it is queued', () => {
  const { out } = run(fx.toolWrite);
  const tys = types(out);
  const enq = tys.indexOf('inbox.enqueued');
  const del = tys.indexOf('inbox.delivered');
  assert.ok(enq >= 0 && del > enq);
  const userIdx = out.findIndex((e) => e.type === 'message.updated' && (e.properties as any).info.role === 'user');
  assert.ok(userIdx > del, 'user message follows delivery');
  const userText = out.find(
    (e) => e.type === 'message.part.updated' && (e.properties as any).part.messageID === (out[userIdx].properties as any).info.id,
  );
  assert.match((userText!.properties as any).part.text, /write tool/);
});

test('pending() tracks undelivered inbox items and clears them on delivery', () => {
  const t = new EventTranslator();
  const enq = fx.toolWrite.find((e) => e.type === 'session.inbox.enqueued')!;
  t.translate(enq);
  const sid = enq.data.sessionID;
  assert.equal(t.pending(sid).length, 1);
  assert.equal(t.pending(sid)[0].delivery, 'steer');
  t.translate({ type: 'session.inbox.delivery.changed', data: { sessionID: sid, inboxID: enq.data.inboxID, delivery: 'queue' } });
  assert.equal(t.pending(sid)[0].delivery, 'queue');
  t.translate(fx.toolWrite.find((e) => e.type === 'session.inbox.delivered')!);
  assert.equal(t.pending(sid).length, 0);
});

test('an interrupt reads as a stop (MessageAbortedError) followed by idle', () => {
  const { out } = run(fx.interrupt);
  const err = out.find((e) => e.type === 'session.error')!;
  assert.equal((err.properties as any).error.name, 'MessageAbortedError');
  assert.equal(types(out).at(-1), 'session.idle');
});

test('a failed run surfaces its message through session.error', () => {
  const { out } = run([
    { type: 'session.execution.failed', data: { sessionID: 's', error: { type: 'provider.no-route', message: 'Cannot initialize x' } } },
  ]);
  assert.deepEqual(types(out), ['session.error', 'session.idle']);
  assert.equal((out[0].properties as any).error.data.message, 'Cannot initialize x');
});

test('permission asks map to the 1.x request and replies resolve it by id', () => {
  const { out } = run(fx.permission);
  const asked = out.find((e) => e.type === 'permission.asked')!.properties as any;
  assert.equal(asked.permission, 'edit');
  assert.ok(asked.metadata.filePath, 'file path surfaced for the card');
  assert.match(String(asked.metadata.diff), /\+/, 'patch surfaced as a diff');
  const replied = out.find((e) => e.type === 'permission.replied')!.properties as any;
  assert.equal(replied.id, asked.id);
});

test('shell permissions show the command', () => {
  const p = v1Permission({ id: 'p', sessionID: 's', action: 'shell', resources: ['rm -rf build'] });
  assert.equal(p.permission, 'bash');
  assert.equal((p.metadata as any).command, 'rm -rf build');
});

test('question forms map to the picker and answers back to field values', () => {
  const { t, out } = run(fx.question);
  const asked = out.find((e) => e.type === 'question.asked')!.properties as any;
  assert.equal(asked.questions.length, 1);
  assert.equal(asked.questions[0].options[1].label, 'Blue');
  assert.ok(types(out).includes('question.replied'));
  const form = fx.question.find((e) => e.type === 'form.created')!.data.form;
  assert.deepEqual(v2FormAnswer(form, [['Blue']]), { q0: 'Blue' });
  assert.deepEqual(v2FormAnswer(form, [['something else']]), { q0: 'something else' }, 'custom text passes through');
  // A replied form is forgotten.
  assert.equal(t.formFor(asked.id), undefined);
});

test('multiselect questions answer with an array of option values', () => {
  const form = {
    fields: [{ key: 'q0', title: 'Pick', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
  };
  assert.equal(v1Questions(form)[0].multiple, true);
  assert.deepEqual(v2FormAnswer(form, [['A', 'B']]), { q0: ['a', 'b'] });
});

test('a cancelled question is reported as rejected', () => {
  const { out } = run(fx.questionCancel);
  assert.ok(types(out).includes('question.rejected'));
});

test('non-question forms are not shown as questions', () => {
  const { out } = run([{ type: 'form.created', data: { form: { id: 'f', sessionID: 's', metadata: { kind: 'mcp' }, fields: [] } } }]);
  assert.equal(out.length, 0);
});

test('a live compaction renders as the marker + summary pair, then session.compacted', () => {
  const t = new EventTranslator();
  t.translate({ type: 'session.compaction.started', data: { sessionID: 'ses_c', inputID: 'msg_c1', reason: 'manual' } });
  const out = fx.compaction.flatMap((e) => t.translate({ ...e, data: { ...e.data, sessionID: 'ses_c' } }));
  const parts = out.filter((e) => e.type === 'message.part.updated').map((e) => (e.properties as any).part);
  assert.equal(parts[0].type, 'compaction', 'the marker comes first');
  assert.equal(parts[1].messageID, 'msg_c1', 'the summary turn takes the compaction id, as history does');
  assert.match(String(parts[1].text), /Objective/);
  assert.equal(out.at(-1)!.type, 'session.compacted');
  const hist = v1History('ses_c', [{ id: 'msg_c1', type: 'compaction', text: 'x', time: { created: 1 } }]);
  assert.deepEqual(hist.map((m) => m.info.id), [parts[0].messageID, 'msg_c1'], 'live and reloaded compactions share ids');
});

test('history comes back oldest first, a turn\'s steps folded into one message', () => {
  const sid = 'ses_x';
  const h = v1History(sid, fx.history);
  assert.deepEqual(
    h.map((m) => m.info.role),
    ['user', 'assistant'],
    'two steps (tool call, then answer) are one turn; idle markers are not chat',
  );
  assert.match((h[0].parts[0] as any).text, /write tool/);
  const turn = h[1];
  const tool = turn.parts.find((p) => p.type === 'tool') as any;
  assert.equal(tool.state.status, 'completed');
  const steps = fx.history.filter((m: any) => m.type === 'assistant').sort((a: any, b: any) => a.time.created - b.time.created);
  assert.equal(turn.info.id, steps[0].id, 'the turn takes its first step\'s id');
  assert.equal(tool.id, toolPartId(steps[0].id, tool.callID), 'part ids keep their own step, as live parts do');
  assert.ok(turn.parts.every((p) => p.messageID === turn.info.id), 'every part renders under the turn');
  assert.equal(turn.parts.filter((p) => p.type === 'step-finish').length, 2, 'one step-finish per step');
  assert.ok(turn.info.tokens, 'tokens kept for the context meter');
});

test('live: a turn\'s steps share one message id, matching history', () => {
  const { out } = run(fx.toolWrite);
  const info = out.filter((e) => e.type === 'message.updated').map((e) => (e.properties as any).info);
  const assistantIds = new Set(info.filter((i) => i.role === 'assistant').map((i) => i.id));
  const userIds = new Set(info.filter((i) => i.role === 'user').map((i) => i.id));
  assert.equal(assistantIds.size, 1, 'one assistant message for the whole turn');
  const partMsgs = new Set(
    out
      .filter((e) => e.type === 'message.part.updated')
      .map((e) => (e.properties as any).part.messageID)
      .filter((id) => !userIds.has(id)),
  );
  assert.deepEqual([...partMsgs], [...assistantIds], 'every assistant part renders under the turn');
});

test('live: a new run starts a new turn, and so does a message delivered mid-turn', () => {
  const t = new EventTranslator();
  const step = (mid: string) => t.translate({ type: 'session.step.started', data: { sessionID: 's', assistantMessageID: mid } });
  const idOf = (evs: Array<{ type: string; properties: any }>) => evs.find((e) => e.type === 'message.updated')!.properties.info.id;
  assert.equal(idOf(step('a1')), 'a1');
  assert.equal(idOf(step('a2')), 'a1', 'second step of the same run joins the turn');
  t.translate({ type: 'session.inbox.enqueued', data: { sessionID: 's', inboxID: 'u2', item: { type: 'user', payload: { text: 'steer' }, delivery: 'steer' } } });
  t.translate({ type: 'session.inbox.delivered', data: { sessionID: 's', inboxID: 'u2' } });
  assert.equal(idOf(step('a3')), 'a3', 'steps after a steered message render below it');
  t.translate({ type: 'session.execution.succeeded', data: { sessionID: 's' } });
  assert.equal(idOf(step('b1')), 'b1', 'a new run is a new turn');
});

test('a compaction in history becomes a marker plus the summary turn the webview folds', () => {
  const h = v1History('s', [
    { id: 'm1', type: 'user', text: 'hi', time: { created: 1 } },
    { id: 'c1', type: 'compaction', text: '## Objective\n- x', time: { created: 2 } },
    { id: 'm2', type: 'user', text: 'next', time: { created: 3 } },
  ]);
  assert.deepEqual(
    h.map((m) => [m.info.role, m.parts[0]?.type]),
    [
      ['user', 'text'],
      ['user', 'compaction'],
      ['assistant', 'text'],
      ['user', 'text'],
    ],
  );
});

test('renamed tools map back to the names the webview special-cases', () => {
  assert.equal(v1ToolName('shell'), 'bash');
  assert.equal(v1ToolName('todo'), 'todowrite');
  assert.equal(v1ToolName('subagent'), 'task');
  assert.equal(v1ToolName('read'), 'read');
  assert.equal(v1ToolInput('subagent', { agent: 'reviewer', prompt: 'x' }).subagent_type, 'reviewer');
});

test('prompt attachments are data: URLs carrying exactly what the panel chose', () => {
  const img = v2PromptFile({ mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'shot.png' });
  assert.deepEqual(img, { uri: 'data:image/png;base64,AAAA', name: 'shot.png' });
  const sel = v2PromptFile({
    mime: 'text/plain',
    url: 'file:///w/src/app.txt',
    filename: 'src/app.txt:3',
    source: { path: '/w/src/app.txt', text: { value: 'codeword = BANANA-17' } },
  });
  assert.equal(sel.name, 'src/app.txt:3');
  assert.match(sel.uri, /^data:text\/plain;base64,/);
  assert.equal(Buffer.from(sel.uri.split(',')[1], 'base64').toString('utf8'), 'codeword = BANANA-17', 'only the selection, not the file');
  assert.match(String(sel.description), /app\.txt/);
});
