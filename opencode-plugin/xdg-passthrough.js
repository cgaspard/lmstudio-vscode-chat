/**
 * OpenCode plugin: give commands the agent runs the host's real XDG_* values.
 *
 * The extension pins XDG_DATA/CONFIG/CACHE/STATE_HOME under its private data
 * dir so the managed OpenCode server can never share state with a user's own
 * install. OpenCode reads those once at startup — but they are also inherited
 * by every process the `bash` tool spawns, which breaks XDG-respecting CLIs
 * (`gh auth status` reports "not logged into any GitHub hosts"; `helm` loses
 * its repo config). Restoring them for children only fixes those tools and
 * leaves OpenCode's own isolation intact.
 *
 * OpenCode builds the shell environment as `{...process.env, ...pluginEnv}`
 * (ShellTool.shellEnv), so writing a key here overrides the pinned value, and
 * writing `undefined` removes it outright — verified against OpenCode 1.18.4
 * that a deleted key is not resurrected by the spawn's `extendEnv: true`.
 *
 * Plain JS with no imports: OpenCode loads this file directly, outside the
 * extension's esbuild pipeline. The env var name below must match
 * `HOST_XDG_ENV` in src/core/hostenv.ts.
 */

const PAYLOAD = process.env.LMSTUDIO_CODE_HOST_XDG;

/** `{ XDG_CONFIG_HOME: "/Users/x/.config", XDG_STATE_HOME: null, ... }` */
function parseSnapshot(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A malformed payload must not break the agent's shell — just leave the
    // pinned values in place, which is the pre-plugin behaviour.
    return {};
  }
}

const RESTORE = parseSnapshot(PAYLOAD);

export default async () => ({
  'shell.env': async (_input, output) => {
    for (const [name, value] of Object.entries(RESTORE)) {
      // null means "unset on the host": drop the key rather than setting it to
      // '', so tools that join the value blindly don't resolve to `/gh`.
      output.env[name] = value === null ? undefined : value;
    }
    // The payload itself is ours; the agent has no use for it and `env` is
    // something it genuinely runs and reads.
    output.env.LMSTUDIO_CODE_HOST_XDG = undefined;
  },
});
