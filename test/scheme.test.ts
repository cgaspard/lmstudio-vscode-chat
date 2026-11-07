import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { after, before, test } from 'node:test';
import {
  alternateSchemeUrl,
  diagnoseScheme,
  isPlainToTlsError,
  isTlsMismatchError,
  schemeOf,
  type SchemeFetch,
} from '../src/core/scheme';

// Error chains captured from a real `fetch('https://…')` against a plain-http
// server: "fetch failed" wrapping the TLS error.
const opensslMismatch = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('0A0000C6:SSL routines:tls_get_more_records:packet length too long'), {
    code: 'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  }),
});
// The same request from VS Code's extension host (Electron, BoringSSL).
const boringsslMismatch = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER'), {
    code: 'ERR_SSL_WRONG_VERSION_NUMBER',
  }),
});
const selfSigned = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
});
const refused = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' }),
});
const socketClosed = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
});

test('alternateSchemeUrl swaps http and https and keeps the rest', () => {
  assert.equal(alternateSchemeUrl('https://192.168.10.15:1234/v1'), 'http://192.168.10.15:1234/v1');
  assert.equal(alternateSchemeUrl('http://host:1234/v1'), 'https://host:1234/v1');
  assert.equal(alternateSchemeUrl('HTTPS://Host/v1'), 'http://Host/v1');
  assert.equal(alternateSchemeUrl('ftp://host'), undefined);
  assert.equal(alternateSchemeUrl(''), undefined);
});

test('schemeOf reads the scheme, lowercased', () => {
  assert.equal(schemeOf('HTTPS://x'), 'https');
  assert.equal(schemeOf('http://x'), 'http');
  assert.equal(schemeOf('x:1234'), '');
});

test('isTlsMismatchError recognizes both OpenSSL and BoringSSL shapes', () => {
  assert.equal(isTlsMismatchError(opensslMismatch), true);
  assert.equal(isTlsMismatchError(boringsslMismatch), true);
});

test('isTlsMismatchError ignores certificate and connection errors', () => {
  // A self-signed server DOES speak TLS — switching to http would not help.
  assert.equal(isTlsMismatchError(selfSigned), false);
  assert.equal(isTlsMismatchError(refused), false);
  assert.equal(isTlsMismatchError(socketClosed), false);
  assert.equal(isTlsMismatchError(undefined), false);
});

test('isPlainToTlsError recognizes a dropped socket but not a refused one', () => {
  assert.equal(isPlainToTlsError(socketClosed), true);
  assert.equal(isPlainToTlsError(refused), false);
  assert.equal(isPlainToTlsError(opensslMismatch), false);
});

// --- Against real local servers ---------------------------------------------

let plain: http.Server;
let plainPort = 0;
let seenAuth: Array<string | undefined> = [];
let dropper: net.Server;
let dropperPort = 0;
let closedPort = 0;

before(async () => {
  plain = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[]}');
  });
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
  plainPort = (plain.address() as net.AddressInfo).port;

  // Behaves like a TLS-only endpoint receiving plain http: reads the request,
  // then drops the connection without an HTTP reply.
  dropper = net.createServer((sock) => sock.once('data', () => sock.destroy()));
  await new Promise<void>((r) => dropper.listen(0, '127.0.0.1', r));
  dropperPort = (dropper.address() as net.AddressInfo).port;

  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  closedPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
});

after(async () => {
  plain.closeAllConnections();
  await new Promise<void>((r) => plain.close(() => r()));
  await new Promise<void>((r) => dropper.close(() => r()));
});

test('https:// against a real plain-http server suggests the http URL', async () => {
  const got = await diagnoseScheme(`https://127.0.0.1:${plainPort}/v1`, { probePath: '/models' });
  assert.equal(got, `http://127.0.0.1:${plainPort}/v1`);
});

test('the http probe never carries the API key meant for https', async () => {
  seenAuth = [];
  const got = await diagnoseScheme(`https://127.0.0.1:${plainPort}/v1`, {
    probePath: '/models',
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(got, `http://127.0.0.1:${plainPort}/v1`);
  assert.deepEqual(seenAuth, [undefined]);
});

test('a server that is simply down gets no suggestion', async () => {
  assert.equal(await diagnoseScheme(`https://127.0.0.1:${closedPort}/v1`, { probePath: '/models' }), undefined);
  assert.equal(await diagnoseScheme(`http://127.0.0.1:${closedPort}/v1`, { probePath: '/models' }), undefined);
});

test('a working http URL gets no suggestion', async () => {
  assert.equal(await diagnoseScheme(`http://127.0.0.1:${plainPort}/v1`, { probePath: '/models' }), undefined);
});

test('http:// dropped by a TLS-only endpoint, with no https answer, gets no suggestion', async () => {
  // Real dropped socket; the https retry fails too (the dropper speaks no TLS).
  assert.equal(await diagnoseScheme(`http://127.0.0.1:${dropperPort}/v1`, { probePath: '/models' }), undefined);
});

/** A fetch that answers per scheme: a status, or an error to throw. */
function fakeFetch(byScheme: Record<string, number | Error>, calls: string[] = []): SchemeFetch {
  return async (url) => {
    calls.push(url);
    const r = byScheme[schemeOf(url)];
    if (r instanceof Error) {
      throw r;
    }
    return { status: r, body: null };
  };
}

test('http:// dropped by a TLS proxy that answers https suggests the https URL', async () => {
  const calls: string[] = [];
  const got = await diagnoseScheme('http://proxy.lan:8443/v1', {
    probePath: '/models',
    fetch: fakeFetch({ http: socketClosed, https: 200 }, calls),
  });
  assert.equal(got, 'https://proxy.lan:8443/v1');
  assert.deepEqual(calls, ['http://proxy.lan:8443/v1/models', 'https://proxy.lan:8443/v1/models']);
});

test('http:// answered with 400 by a TLS proxy suggests the https URL', async () => {
  const got = await diagnoseScheme('http://proxy.lan/v1', {
    probePath: '/models',
    fetch: fakeFetch({ http: 400, https: 200 }),
  });
  assert.equal(got, 'https://proxy.lan/v1');
});

test('a 401 on the alternate scheme still proves it is the right one', async () => {
  const got = await diagnoseScheme('https://host:1234/v1', {
    probePath: '/models',
    fetch: fakeFetch({ https: boringsslMismatch, http: 401 }),
  });
  assert.equal(got, 'http://host:1234/v1');
});

test('a certificate error is not treated as a scheme problem', async () => {
  const calls: string[] = [];
  const got = await diagnoseScheme('https://host:1234/v1', {
    probePath: '/models',
    fetch: fakeFetch({ https: selfSigned, http: 200 }, calls),
  });
  assert.equal(got, undefined);
  assert.equal(calls.length, 1, 'must not probe http at all');
});

test('an https URL that answers with an error status is not a scheme problem', async () => {
  const got = await diagnoseScheme('https://host/v1', {
    probePath: '/models',
    fetch: fakeFetch({ https: 500, http: 200 }),
  });
  assert.equal(got, undefined);
});
