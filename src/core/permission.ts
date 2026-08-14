/**
 * Permission-mode handling: maps the user-facing mode to the `permission`
 * object injected into the OpenCode config. Pure (no vscode deps) so it is
 * unit-testable and safe to bundle into the webview.
 *
 * OpenCode flattens the `permission` object into an ordered rule list where
 * the LAST matching rule wins and key order is preserved (verified against the
 * bundled 1.18.17: `"permission": "allow"` normalizes to `{"*": "allow"}`),
 * so the wildcard must come first and per-tool overrides after it.
 */

export type PermissionMode = 'default' | 'strict' | 'bypass';

export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'strict', 'bypass'];

/** Settings.json is hand-editable, so an unknown mode must not reach the wire. */
export function normalizePermissionMode(value: unknown): PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : 'default';
}

/**
 * The `permission` block for the injected OpenCode config.
 *
 * - default: OpenCode's own posture — most tools run without asking; risky
 *   actions (paths outside the workspace, .env reads, doom loops) still prompt.
 *   `question` is allowed because the question picker IS the interaction; an
 *   approval gate before it would ask permission to ask.
 * - strict: every tool call prompts (except `question`, per the above).
 * - bypass: the wildcard allows everything — no approval prompts at all.
 *   `deny` is never emitted: a blanket deny would remove tools from the
 *   model's toolset entirely rather than gate them.
 */
export function opencodePermission(mode: PermissionMode): Record<string, 'allow' | 'ask'> {
  switch (mode) {
    case 'bypass':
      return { '*': 'allow' };
    case 'strict':
      return { '*': 'ask', question: 'allow' };
    default:
      return { question: 'allow' };
  }
}

/** Short human label for chips/pickers. */
export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'bypass':
      return 'Never ask (bypass)';
    case 'strict':
      return 'Ask for everything';
    default:
      return 'Ask for risky actions';
  }
}
