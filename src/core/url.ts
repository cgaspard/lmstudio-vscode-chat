/**
 * LM Studio URL helpers. Pure so they can be shared (config, connection
 * registry) and unit-tested without vscode.
 */

/**
 * Normalize a user-entered LM Studio server URL to the OpenAI-compatible base
 * that ends in /vN (defaulting to /v1). Adds a scheme if missing and strips
 * trailing slashes. Empty input falls back to the local default.
 */
export function normalizeServerUrl(raw: string, fallback = 'http://127.0.0.1:1234/v1'): string {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (!u) {
    return fallback;
  }
  if (!/^https?:\/\//i.test(u)) {
    u = 'http://' + u;
  }
  if (!/\/v\d+$/.test(u)) {
    u = u + '/v1';
  }
  return u;
}

/** The OpenAI-compatible base URL without a trailing /vN (LM Studio REST root). */
export function lmStudioRestRoot(baseUrl: string): string {
  return (baseUrl || '').replace(/\/v\d+$/, '');
}
