/**
 * Error classification + humanization shared by the bridge, the OpenCode HTTP
 * client, and the webview. Pure (no vscode / node deps) so it is unit-testable
 * and safe to bundle into the browser webview.
 *
 * The goal is reliability: a dropped LM Studio / OpenCode connection surfaces in
 * many shapes ("fetch failed", ECONNREFUSED, undici "terminated", a TimeoutError
 * from AbortSignal.timeout, an SSE error event with { data: { message } }). We
 * classify all of them the same way so the self-healing layer can react, and we
 * humanize them so the user sees "reconnecting…" instead of "fetch failed".
 */

/** Extract a human-readable message from any thrown value / error-ish object. */
export function errorText(err: unknown): string {
  if (err == null) {
    return '';
  }
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error) {
    // Some runtimes attach the real syscall error on `cause`.
    const cause = (err as { cause?: unknown }).cause;
    if (!err.message && cause) {
      return errorText(cause);
    }
    return err.message;
  }
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    // OpenCode / SSE error shapes: { data: { message } } or { message }.
    const data = o.data as Record<string, unknown> | undefined;
    if (data && typeof data.message === 'string') {
      return data.message;
    }
    if (typeof o.message === 'string') {
      return o.message;
    }
    if (o.cause) {
      const c = errorText(o.cause);
      if (c) {
        return c;
      }
    }
  }
  try {
    return String(err);
  } catch {
    return '';
  }
}

const CONNECTION_PATTERNS: RegExp[] = [
  /fetch failed/i,
  /failed to fetch/i,
  /load failed/i, // Safari/webkit fetch failure wording
  /network ?error/i,
  /econnrefused/i,
  /econnreset/i,
  /econnaborted/i,
  /etimedout/i,
  /enotfound/i,
  /eai_again/i,
  /ehostunreach/i,
  /enetunreach/i,
  /epipe/i,
  /socket hang ?up/i,
  /other side closed/i,
  /\bterminated\b/i, // undici when a streaming body is cut
  /connection (refused|reset|closed|error|timed out|aborted)/i,
  /the operation timed out/i,
  /request timed out/i,
  /\btimeout\b/i,
];

/** True for an AbortController/AbortSignal-driven cancellation (not a failure). */
export function isAbortError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : (err as { name?: string } | null)?.name;
  return name === 'AbortError';
}

/**
 * True when the error looks like a transient connectivity / network failure
 * (as opposed to a real application error or a user-initiated abort). The
 * self-healing layer uses this to decide whether to reconnect + retry.
 */
export function isConnectionError(err: unknown): boolean {
  // A deliberate abort (e.g. the user pressed Stop) is not a connection fault.
  if (isAbortError(err)) {
    return false;
  }
  const name = err instanceof Error ? err.name : (err as { name?: string } | null)?.name;
  // AbortSignal.timeout() rejects with a TimeoutError — treat as connectivity.
  if (name === 'TimeoutError') {
    return true;
  }
  const text = errorText(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  const causeText = cause ? errorText(cause) : '';
  const haystack = `${name ?? ''} ${text} ${causeText}`.trim();
  if (!haystack) {
    return false;
  }
  return CONNECTION_PATTERNS.some((re) => re.test(haystack));
}

export interface HumanizeOptions {
  /** What we were talking to, e.g. "LM Studio". Defaults to "the server". */
  subject?: string;
  /**
   * Whether the caller will auto-reconnect. When true (the default) the message
   * reassures the user it is recovering; set false for a terminal message.
   */
  reconnecting?: boolean;
}

/**
 * Turn a raw error into a short, friendly, user-facing line. Connection-class
 * errors get a consistent "lost connection / reconnecting" message instead of
 * the cryptic "fetch failed"; everything else passes through its own message.
 */
export function humanizeError(err: unknown, opts: HumanizeOptions = {}): string {
  const subject = opts.subject ?? 'the server';
  if (isAbortError(err)) {
    return 'Stopped.';
  }
  if (isConnectionError(err)) {
    return opts.reconnecting === false
      ? `Lost connection to ${subject}.`
      : `Lost connection to ${subject} — reconnecting…`;
  }
  const text = errorText(err).trim();
  return text || 'Something went wrong.';
}
