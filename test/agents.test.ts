import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOKENS_PER_DELEGATABLE_AGENT,
  TOOL_SCHEMA_TOKENS,
  agentLabel,
  agentOverheadTokens,
  agentTooltip,
  delegatableAgents,
  pickableAgents,
  resolveAgent,
  type AgentInfo,
} from '../src/core/agents';

// Mirrors a real `GET /agent` response verified against OpenCode 1.18.4, with
// two user-defined agents loaded from .opencode/agent/*.md.
const AGENTS: AgentInfo[] = [
  { name: 'build', mode: 'primary', native: true, description: 'The default agent.' },
  { name: 'plan', mode: 'primary', native: true, description: 'Plan mode. Disallows all edit tools.' },
  { name: 'general', mode: 'subagent', native: true, description: 'General-purpose agent.' },
  { name: 'explore', mode: 'subagent', native: true, description: 'Fast codebase exploration.' },
  { name: 'dbexpert', mode: 'subagent', native: false, description: 'Postgres specialist.' },
  { name: 'reviewer', mode: 'all', native: false, description: 'Reviews a diff.' },
  { name: 'title', mode: 'primary', native: true, hidden: true },
  { name: 'summary', mode: 'primary', native: true, hidden: true },
  { name: 'compaction', mode: 'primary', native: true, hidden: true },
];

test('the picker excludes subagents and internal agents', () => {
  const names = pickableAgents(AGENTS).map((a) => a.name);
  // mode:'all' IS pickable; mode:'subagent' is not; hidden internals never show.
  assert.deepEqual(names, ['build', 'plan', 'reviewer']);
  assert.ok(!names.includes('general'), 'subagents are delegation-only');
  assert.ok(!names.includes('title'), 'internal agents must never be user-selectable');
});

test('delegation sees a different set than the picker', () => {
  const names = delegatableAgents(AGENTS).map((a) => a.name);
  assert.deepEqual(names, ['dbexpert', 'explore', 'general', 'reviewer']);
  // build/plan are primary-only — the model can never delegate to them.
  assert.ok(!names.includes('build'));
  // mode:'all' appears in BOTH sets; that overlap is the point of the mode.
  assert.ok(pickableAgents(AGENTS).some((a) => a.name === 'reviewer'));
});

test('delegatable counts hidden agents, because the model still sees them', () => {
  // Verified: `hidden` only filters UI listings — a hidden subagent is still
  // appended to the task tool description, so it still costs context.
  const withHidden = [...AGENTS, { name: 'sneaky', mode: 'subagent', hidden: true }];
  assert.equal(delegatableAgents(withHidden).length, 5);
  assert.ok(!pickableAgents(withHidden).some((a) => a.name === 'sneaky'));
});

test('built-ins sort first so the familiar pair stays put', () => {
  assert.deepEqual(pickableAgents(AGENTS).map((a) => a.name), ['build', 'plan', 'reviewer']);
});

test('a stale stored agent falls back instead of pointing at nothing', () => {
  assert.equal(resolveAgent('reviewer', AGENTS), 'reviewer');
  assert.equal(resolveAgent('deleted-agent', AGENTS), 'build'); // renamed/removed on disk
  assert.equal(resolveAgent(undefined, AGENTS), 'build');
  // A subagent must never end up selected as the primary driver.
  assert.equal(resolveAgent('general', AGENTS), 'build');
  // No build present -> first pickable, never a crash.
  assert.equal(resolveAgent('x', [{ name: 'custom', mode: 'primary' }]), 'custom');
  assert.equal(resolveAgent('x', []), 'build');
});

test('overhead is per-agent and grows with the delegatable roster', () => {
  // 4 delegatable agents in the fixture.
  const build = agentOverheadTokens('build', AGENTS);
  const plan = agentOverheadTokens('plan', AGENTS);
  assert.equal(build, 5400 + TOOL_SCHEMA_TOKENS + 4 * TOKENS_PER_DELEGATABLE_AGENT);
  assert.ok(plan < build, 'plan drops the edit tooling and its instructions');

  // A user-defined agent gets the default prompt estimate rather than build's.
  const custom = agentOverheadTokens('reviewer', AGENTS);
  assert.ok(custom < build && custom > plan);

  // Adding a subagent raises the PRIMARY session's overhead — this is the part
  // the old hardcoded `plan ? 6000 : 11000` could not express.
  const more = agentOverheadTokens('build', [...AGENTS, { name: 'extra', mode: 'subagent' }]);
  assert.equal(more - build, TOKENS_PER_DELEGATABLE_AGENT);
});

test('a subagent does not charge the parent for its own prompt', () => {
  // Only the ~32-token description line crosses into the parent session; the
  // subagent's prompt and tool schemas live in its own child session.
  const before = agentOverheadTokens('build', AGENTS);
  const after = agentOverheadTokens('build', [
    ...AGENTS,
    { name: 'heavy', mode: 'subagent', description: 'x'.repeat(4000) },
  ]);
  assert.equal(after - before, TOKENS_PER_DELEGATABLE_AGENT);
});

test('labels and tooltips distinguish custom agents and dual-mode ones', () => {
  assert.equal(agentLabel({ name: 'build', native: true }), 'build');
  assert.equal(agentLabel({ name: 'reviewer', native: false }), 'reviewer (custom)');
  const tip = agentTooltip(AGENTS.find((a) => a.name === 'reviewer')!);
  assert.match(tip, /Reviews a diff/);
  assert.match(tip, /may also delegate/i, 'mode:all should explain the dual role');
  assert.match(
    agentTooltip({ name: 'x', model: { modelID: 'qwen/qwen3.6-27b' } }),
    /qwen3\.6-27b/,
  );
});
