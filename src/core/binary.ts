// Pure resolution of the opencode binary path, independent of vscode/fs so it
// can be unit-tested. serverManager wires the real `fs.existsSync`, PATH lookup,
// and candidate paths into this.

export interface BinaryResolverInputs {
  /** `lmstudioCode.opencodePath` setting, or '' if unset. */
  overridePath: string;
  /** Known user-install locations to probe, in order. */
  userCandidates: string[];
  /** Result of a PATH lookup (which/where opencode), or null. */
  onPath: string | null;
  /** The binary bundled in the VSIX, or null if missing. */
  bundled: string | null;
  /** Existence predicate (injected so tests stay filesystem-free). */
  exists: (p: string) => boolean;
}

/**
 * Resolve the opencode binary in precedence order:
 *   1. explicit override (`opencodePath`) if it exists
 *   2. a user's own install (known locations, then PATH)
 *   3. the bundled binary (guaranteed offline default)
 * Returns null only when every option fails.
 */
export function resolveBinaryPath(inp: BinaryResolverInputs): string | null {
  if (inp.overridePath && inp.exists(inp.overridePath)) {
    return inp.overridePath;
  }
  for (const c of inp.userCandidates) {
    if (inp.exists(c)) {
      return c;
    }
  }
  if (inp.onPath) {
    return inp.onPath;
  }
  return inp.bundled;
}
