/**
 * Session-list logic shared by the bridge. Pure so it is unit-testable without
 * the OpenCode client.
 *
 * Empty-session detection: a session that has never had a message keeps
 * time.created === time.updated; the first prompt bumps `updated` (verified
 * against the live OpenCode server). This is used to find leftover empty "New
 * chat" sessions to prune — never the active one — without an N+1 message fetch.
 * The bridge still confirms zero messages before actually deleting, so this is a
 * cheap pre-filter, not the final authority.
 *
 * Two safety guards beyond "looks empty":
 *  - age floor (`minAgeMs`): a freshly-created session may be a SIBLING bridge's
 *    in-flight new chat that hasn't persisted its first message yet, so it would
 *    momentarily look empty across the shared OpenCode store. We only prune
 *    sessions older than the floor (default 5 minutes).
 *  - workspace scope (`directory`): the OpenCode store is shared across projects,
 *    so we only ever prune sessions that belong to OUR workspace directory.
 */

/** Default age floor: don't prune sessions created within the last 5 minutes. */
export const DEFAULT_PRUNE_MIN_AGE_MS = 5 * 60 * 1000;

export interface SessionTimes {
  id: string;
  /** The session's project/workspace directory, when the server reports it. */
  directory?: string;
  time?: { created?: number; updated?: number };
}

/** Context for deciding whether a session may be pruned. */
export interface PruneScope {
  /** The active session — never a candidate. */
  currentSessionID: string | null;
  /** Current wall-clock time (passed in so the module stays pure/testable). */
  now: number;
  /** Our workspace directory; only sessions here are candidates (empty = no filter). */
  directory?: string;
  /** Age floor in ms; defaults to DEFAULT_PRUNE_MIN_AGE_MS. */
  minAgeMs?: number;
}

/**
 * True when a session is a SAFE empty-prune candidate: it looks empty
 * (updated <= created), isn't the active session, is old enough not to be a
 * sibling's in-flight new chat, and belongs to our workspace.
 */
export function isEmptySessionCandidate(session: SessionTimes, scope: PruneScope): boolean {
  if (session.id === scope.currentSessionID) {
    return false;
  }
  const created = session.time?.created ?? 0;
  const updated = session.time?.updated ?? 0;
  if (updated > created) {
    return false; // had a message → not empty
  }
  // Age floor: skip sessions younger than the floor (likely a sibling's in-flight
  // new chat that hasn't persisted its first message yet).
  const minAgeMs = scope.minAgeMs ?? DEFAULT_PRUNE_MIN_AGE_MS;
  if (scope.now - created < minAgeMs) {
    return false;
  }
  // Workspace scope: when we know our own directory, only prune sessions in it.
  // A session with no directory is skipped (we can't prove it's ours). When our
  // own directory is unknown (empty) we fall back to no directory filter.
  if (scope.directory) {
    if (session.directory !== scope.directory) {
      return false;
    }
  }
  return true;
}

/** Select all safe empty prune candidates from a session list. */
export function emptySessionCandidates<T extends SessionTimes>(
  sessions: T[],
  scope: PruneScope,
): T[] {
  return sessions.filter((s) => isEmptySessionCandidate(s, scope));
}
