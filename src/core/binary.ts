// Pure resolution of the opencode binary path, independent of vscode/fs so it
// can be unit-tested. serverManager wires the real `fs.existsSync` and the
// bundled path into this.

/**
 * Whether `opencode --version` output names a release this extension can drive.
 * OpenCode 2 replaced the v1 HTTP API we speak (`/global/health`, `/session`,
 * `/config/providers`, …) with a password-gated `/api/*` surface: its server
 * starts and listens, then answers every v1 route with the web UI's index.html.
 * Unreadable output gets the benefit of the doubt and counts as supported.
 */
export function isSupportedOpencodeVersion(versionOutput: string): boolean {
  const m = versionOutput.match(/(\d+)\.\d+\.\d+/);
  return !m || Number(m[1]) < 2;
}

export interface BinaryResolverInputs {
  /** `lmstudioCode.opencodePath` setting, or '' if unset. */
  overridePath: string;
  /** The binary bundled in the VSIX, or null if missing. */
  bundled: string | null;
  /** Existence predicate (injected so tests stay filesystem-free). */
  exists: (p: string) => boolean;
}

/**
 * Resolve the opencode binary:
 *   1. explicit override (`opencodePath`) if it exists
 *   2. the bundled binary — the version this extension is built and tested
 *      against
 * A user's own install (PATH, Homebrew, ~/.opencode) is deliberately never
 * picked up on its own: the client is tied to one server API, so upgrading
 * OpenCode elsewhere (e.g. Homebrew moving to OpenCode 2) must not change
 * what the panel runs. Returns null only when both fail.
 */
export function resolveBinaryPath(inp: BinaryResolverInputs): string | null {
  if (inp.overridePath && inp.exists(inp.overridePath)) {
    return inp.overridePath;
  }
  return inp.bundled;
}
