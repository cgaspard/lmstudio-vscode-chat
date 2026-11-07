/**
 * Diagnose a server URL whose scheme is wrong.
 *
 * Two mistakes look identical to the user — a generic "fetch failed" and a
 * banner saying the server "isn't responding" — while the server is actually
 * answering fine:
 *   - `https://` pointed at a plain-http server. LM Studio and Ollama serve no
 *     TLS, so the handshake dies on the server's plain-text reply.
 *   - `http://` pointed at a TLS-only endpoint (a reverse proxy in front of
 *     the server). The proxy drops the connection or answers 400.
 *
 * `diagnoseScheme` confirms the symptom, then probes the other scheme. It only
 * suggests a URL that really answered, so a server that is simply down never
 * gets a misleading "use http" offer.
 *
 * Pure apart from the injected fetch, so it is unit-tested against real local
 * http and https servers.
 */

/**
 * Error codes for "this https:// URL reached a server that doesn't speak TLS".
 * Node's OpenSSL reports PACKET_LENGTH_TOO_LONG (it reads "HTTP/1.1 400" as a
 * TLS record header); VS Code's Electron uses BoringSSL, which reports
 * WRONG_VERSION_NUMBER. Certificate errors (self-signed, expired, wrong host)
 * are deliberately absent: those servers do speak TLS.
 */
const TLS_MISMATCH_CODES = new Set([
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'ERR_SSL_HTTP_REQUEST',
  'EPROTO',
]);
const TLS_MISMATCH_MESSAGE = /wrong[ _]version[ _]number|packet[ _]length[ _]too[ _]long|ssl3_get_record/i;

/**
 * What an `http://` URL sees from a TLS-only endpoint: the server reads our
 * plain request as a broken handshake and closes the socket.
 */
const PLAIN_TO_TLS_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

/** Undici wraps the real error as the `cause` of "fetch failed"; walk the chain. */
function causes(err: unknown): Array<{ code?: string; message?: string }> {
  const out: Array<{ code?: string; message?: string }> = [];
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    out.push({
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
    });
    cur = e.cause;
  }
  return out;
}

/** An `https://` request failed because the server answered in plain text. */
export function isTlsMismatchError(err: unknown): boolean {
  return causes(err).some(
    (c) => (c.code !== undefined && TLS_MISMATCH_CODES.has(c.code)) || TLS_MISMATCH_MESSAGE.test(c.message ?? ''),
  );
}

/** An `http://` request failed the way a TLS-only endpoint makes it fail. */
export function isPlainToTlsError(err: unknown): boolean {
  return causes(err).some((c) => c.code !== undefined && PLAIN_TO_TLS_CODES.has(c.code));
}

/** The same URL with http and https swapped, or undefined for any other scheme. */
export function alternateSchemeUrl(url: string): string | undefined {
  const m = /^(https?):\/\//i.exec((url || '').trim());
  if (!m) {
    return undefined;
  }
  const other = m[1].toLowerCase() === 'https' ? 'http' : 'https';
  return other + url.trim().slice(m[1].length);
}

/** The scheme of a URL, lowercased ('http' | 'https'), or '' when it has none. */
export function schemeOf(url: string): string {
  const m = /^(https?):\/\//i.exec((url || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** The subset of `fetch` the diagnosis needs, injectable for tests. */
export type SchemeFetch = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

export interface DiagnoseOptions {
  /** Appended to both URLs, e.g. '/models'. */
  probePath: string;
  /** Headers for the probe of the CONFIGURED url (the user's chosen auth). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: SchemeFetch;
}

/**
 * When `baseUrl` fails only because its scheme is wrong, return the same URL
 * with the other scheme, confirmed to answer. Otherwise undefined.
 *
 * The probe of the alternate URL never carries `headers`: an API key the user
 * meant for https must not cross the network in plain text just because we are
 * checking. Any HTTP response counts as proof, a 401 included.
 */
export async function diagnoseScheme(baseUrl: string, opts: DiagnoseOptions): Promise<string | undefined> {
  const alt = alternateSchemeUrl(baseUrl);
  if (!alt) {
    return undefined;
  }
  const doFetch: SchemeFetch = opts.fetch ?? (fetch as unknown as SchemeFetch);
  const timeoutMs = opts.timeoutMs ?? 4000;
  const https = schemeOf(baseUrl) === 'https';

  let symptom = false;
  try {
    const res = await doFetch(`${baseUrl}${opts.probePath}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: opts.headers,
    });
    await res.body?.cancel().catch(() => undefined);
    // A TLS proxy that does answer plain http says 400 ("The plain HTTP request
    // was sent to HTTPS port"). An https URL that answers at all is fine.
    symptom = !https && res.status === 400;
  } catch (err) {
    symptom = https ? isTlsMismatchError(err) : isPlainToTlsError(err);
  }
  if (!symptom) {
    return undefined;
  }

  try {
    const res = await doFetch(`${alt}${opts.probePath}`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return alt;
  } catch {
    return undefined;
  }
}
