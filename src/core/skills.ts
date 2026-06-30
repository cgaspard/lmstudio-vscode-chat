/**
 * Skill classification — pure logic shared by the bridge's `/skills` handler.
 * Decides where a discovered skill came from (project / global / built-in) from
 * its `location` path and the workspace root, and maps the raw `GET /skill`
 * shape into the UI shape. Kept vscode/fs-free so it is unit-testable.
 */

/** The subset of OpenCode's SkillV2Info we consume. */
export interface RawSkill {
  name: string;
  description?: string;
  location?: string;
  slash?: boolean;
}

export type SkillSource = 'project' | 'global' | 'built-in';

export interface ClassifiedSkill {
  name: string;
  description: string;
  source: SkillSource;
  /** Absolute SKILL.md path for disk skills; omitted for built-ins. */
  path?: string;
  slash: boolean;
}

/**
 * Classify a skill by its `location` relative to the workspace `root`:
 *   - built-in   → no location, "<built-in>", or a "/builtin/..." path
 *   - project    → on disk under the workspace root
 *   - global     → on disk elsewhere (e.g. ~/.claude/skills, ~/.config/opencode)
 */
export function classifySkillSource(location: string | undefined, root: string): SkillSource {
  const loc = typeof location === 'string' ? location : '';
  const builtIn = !loc || loc === '<built-in>' || loc.startsWith('/builtin/');
  if (builtIn) {
    return 'built-in';
  }
  return root && isUnderRoot(loc, root) ? 'project' : 'global';
}

/**
 * Whether `loc` is at or under `root`, enforcing a path-separator boundary so a
 * sibling directory that merely shares the root's name as a string prefix
 * (e.g. "/work-notes" under root "/work") is NOT counted as under root.
 * Tolerates a root with or without a trailing separator; handles "/" and "\".
 */
function isUnderRoot(loc: string, root: string): boolean {
  const base = root.replace(/[\\/]+$/, ''); // strip any trailing separator
  return loc === base || loc.startsWith(base + '/') || loc.startsWith(base + '\\');
}

/** Map one raw skill to the UI shape (path omitted for built-ins). */
export function toClassifiedSkill(skill: RawSkill, root: string): ClassifiedSkill {
  const source = classifySkillSource(skill.location, root);
  const loc = typeof skill.location === 'string' ? skill.location : '';
  return {
    name: skill.name,
    description: skill.description ?? '',
    source,
    path: source === 'built-in' ? undefined : loc,
    slash: !!skill.slash,
  };
}

/** Map + sort a raw skill list into UI skills (alphabetical by name). */
export function classifySkills(skills: RawSkill[], root: string): ClassifiedSkill[] {
  return skills.map((s) => toClassifiedSkill(s, root)).sort((a, b) => a.name.localeCompare(b.name));
}
