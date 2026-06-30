import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySkillSource, classifySkills, toClassifiedSkill } from '../src/core/skills';

const ROOT = '/Users/me/project';

test('classifySkillSource: built-in for empty / <built-in> / /builtin paths', () => {
  assert.equal(classifySkillSource(undefined, ROOT), 'built-in');
  assert.equal(classifySkillSource('', ROOT), 'built-in');
  assert.equal(classifySkillSource('<built-in>', ROOT), 'built-in');
  assert.equal(classifySkillSource('/builtin/customize-opencode.md', ROOT), 'built-in');
});

test('classifySkillSource: project when under the workspace root', () => {
  assert.equal(
    classifySkillSource(`${ROOT}/.opencode/skill/x/SKILL.md`, ROOT),
    'project',
  );
  assert.equal(classifySkillSource(`${ROOT}/.claude/skills/y/SKILL.md`, ROOT), 'project');
});

test('classifySkillSource: global when on disk outside the root', () => {
  assert.equal(
    classifySkillSource('/Users/me/.claude/skills/z/SKILL.md', ROOT),
    'global',
  );
  assert.equal(
    classifySkillSource('/Users/me/.config/opencode/skill/q/SKILL.md', ROOT),
    'global',
  );
});

test('classifySkillSource: a disk skill is global when there is no workspace root', () => {
  assert.equal(classifySkillSource('/somewhere/.claude/skills/a/SKILL.md', ''), 'global');
});

test('classifySkillSource: a sibling dir sharing the root prefix is NOT project (boundary)', () => {
  // root "/Users/me/proj"; "/Users/me/proj-notes/..." merely shares the prefix.
  assert.equal(
    classifySkillSource('/Users/me/proj-notes/.opencode/skill/x/SKILL.md', '/Users/me/proj'),
    'global',
  );
  // the real project dir still classifies as project
  assert.equal(
    classifySkillSource('/Users/me/proj/.opencode/skill/x/SKILL.md', '/Users/me/proj'),
    'project',
  );
});

test('classifySkillSource: tolerates a root with a trailing separator', () => {
  assert.equal(
    classifySkillSource('/Users/me/proj/.opencode/skill/x/SKILL.md', '/Users/me/proj/'),
    'project',
  );
});

test('toClassifiedSkill: maps fields and omits path for built-ins', () => {
  const builtIn = toClassifiedSkill(
    { name: 'customize-opencode', description: 'd', location: '<built-in>', slash: true },
    ROOT,
  );
  assert.deepEqual(builtIn, {
    name: 'customize-opencode',
    description: 'd',
    source: 'built-in',
    path: undefined,
    slash: true,
  });

  const project = toClassifiedSkill(
    { name: 'fib', description: 'helps with fib', location: `${ROOT}/.opencode/skill/fib/SKILL.md` },
    ROOT,
  );
  assert.deepEqual(project, {
    name: 'fib',
    description: 'helps with fib',
    source: 'project',
    path: `${ROOT}/.opencode/skill/fib/SKILL.md`,
    slash: false,
  });
});

test('toClassifiedSkill: missing description becomes empty string; slash defaults false', () => {
  const s = toClassifiedSkill({ name: 'x', location: `${ROOT}/.opencode/skill/x/SKILL.md` }, ROOT);
  assert.equal(s.description, '');
  assert.equal(s.slash, false);
});

test('classifySkills: sorts alphabetically by name', () => {
  const out = classifySkills(
    [
      { name: 'zebra', location: `${ROOT}/.opencode/skill/zebra/SKILL.md` },
      { name: 'apple', location: '<built-in>' },
      { name: 'mango', location: '/Users/me/.claude/skills/mango/SKILL.md' },
    ],
    ROOT,
  );
  assert.deepEqual(
    out.map((s) => s.name),
    ['apple', 'mango', 'zebra'],
  );
  assert.deepEqual(
    out.map((s) => s.source),
    ['built-in', 'global', 'project'],
  );
});

test('classifySkills: empty input yields empty list', () => {
  assert.deepEqual(classifySkills([], ROOT), []);
});
