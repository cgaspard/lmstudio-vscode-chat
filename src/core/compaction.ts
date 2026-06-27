// Pure logic for hiding OpenCode's compaction noise from the chat transcript.
//
// When the user runs `/compact` (or OpenCode auto-compacts on overflow), the
// server writes a `user` message whose single part is `type:"compaction"`, then
// streams the summarizer model's own reasoning + the summary template as an
// ordinary `assistant` turn. Neither is a real chat turn: the marker is an
// anchor and the summarizer turn is internal context generation. The UI should
// collapse the marker to a chip and suppress the summarizer turn entirely.
//
// This module is the decision logic only (no DOM), so it can be unit-tested and
// shared between the live event path and history replay in the webview.

/** Mutable state threaded through a message/part stream to track compaction. */
export interface CompactionState {
  /** messageIDs whose parts must never render (marker msg + summarizer turn). */
  suppressed: Set<string>;
  /** A compaction marker was seen; the next assistant message is the summary. */
  pending: boolean;
}

export function newCompactionState(): CompactionState {
  return { suppressed: new Set<string>(), pending: false };
}

/**
 * Classify a message's compaction part by type. Returns true when the part is
 * the compaction marker — the caller should show a "compacted" chip and skip
 * the marker's own message.
 */
export function isCompactionPart(partType: string): boolean {
  return partType === 'compaction';
}

/**
 * Whether a part is OpenCode-internal context injection that must NOT render as
 * a chat bubble: synthetic text (the attached file's contents, tool-call framing
 * like "Called the Read tool with…"). It's sent to the model but was never typed
 * by the user — the visible affordance for an attachment is its file chip.
 */
export function isSyntheticText(part: { type: string; synthetic?: boolean }): boolean {
  return part.type === 'text' && part.synthetic === true;
}

/**
 * Record that a compaction marker was seen on `messageID`. The marker's message
 * is suppressed and the next assistant turn is armed for suppression.
 */
export function markCompaction(state: CompactionState, messageID: string): void {
  state.suppressed.add(messageID);
  state.pending = true;
}

/**
 * Decide whether a message (identified by id + role) should be suppressed.
 * Mutates `state`: the first assistant turn after a marker is claimed as the
 * summarizer turn. Returns true when this message must not render as chat.
 */
export function shouldSuppressMessage(
  state: CompactionState,
  messageID: string,
  role: string,
): boolean {
  if (role !== 'user' && state.pending && !state.suppressed.has(messageID)) {
    state.suppressed.add(messageID);
    state.pending = false;
  }
  return state.suppressed.has(messageID);
}
