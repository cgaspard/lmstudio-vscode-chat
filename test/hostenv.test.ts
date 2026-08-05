import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  HOST_XDG_ENV,
  HOST_XDG_VARS,
  hostXdgForChildren,
  snapshotHostXdg,
  withHostXdg,
} from '../src/core/hostenv';

const join = (...parts: string[]) => parts.join('/');

test('captures every variable buildEnv overrides', () => {
  const got = snapshotHostXdg({});
  assert.deepEqual(Object.keys(got).sort(), [...HOST_XDG_VARS].sort());
});

test('unset host variables are recorded as null, not omitted', () => {
  const got = snapshotHostXdg({ XDG_CONFIG_HOME: '/home/u/.config' });
  assert.equal(got.XDG_CONFIG_HOME, '/home/u/.config');
  assert.equal(got.XDG_DATA_HOME, null);
  assert.equal(got.XDG_CACHE_HOME, null);
  assert.equal(got.XDG_STATE_HOME, null);
});

test('an explicitly empty host value is preserved as empty, not treated as unset', () => {
  // '' and unset are different to a tool that joins the value blindly, so the
  // snapshot must not collapse them.
  const got = snapshotHostXdg({ XDG_CONFIG_HOME: '' });
  assert.equal(got.XDG_CONFIG_HOME, '');
  assert.notEqual(got.XDG_CONFIG_HOME, null);
});

test('the snapshot survives a JSON round-trip (it is passed through the env)', () => {
  const snap = snapshotHostXdg({ XDG_DATA_HOME: '/d', XDG_STATE_HOME: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

// ---------------------------------------------------------------------------
// The bundled plugin is plain JS loaded by OpenCode's own runtime, so it cannot
// import the module above and hardcodes the env var name instead. These tests
// exercise the real shipped file so the duplication can't drift.
// ---------------------------------------------------------------------------

const PLUGIN = path.join(process.cwd(), 'opencode-plugin', 'xdg-passthrough.js');

/** Load the plugin with a given payload and run its `shell.env` hook. */
async function runHook(payload: string | undefined): Promise<Record<string, unknown>> {
  const previous = process.env[HOST_XDG_ENV];
  process.env[HOST_XDG_ENV] = payload;
  if (payload === undefined) {
    delete process.env[HOST_XDG_ENV];
  }
  try {
    // Cache-bust: the plugin reads process.env once at module scope.
    const url = `${pathToFileURL(PLUGIN).href}?t=${Math.random()}`;
    const mod = (await import(url)) as { default: () => Promise<Record<string, unknown>> };
    const hooks = await mod.default();
    const output: { env: Record<string, unknown> } = { env: {} };
    await (hooks['shell.env'] as (i: unknown, o: unknown) => Promise<void>)({}, output);
    return output.env;
  } finally {
    if (previous === undefined) {
      delete process.env[HOST_XDG_ENV];
    } else {
      process.env[HOST_XDG_ENV] = previous;
    }
  }
}

test('plugin restores host values and deletes the ones that were unset', async () => {
  const env = await runHook(
    JSON.stringify({ XDG_CONFIG_HOME: '/home/u/.config', XDG_DATA_HOME: null }),
  );
  assert.equal(env.XDG_CONFIG_HOME, '/home/u/.config');
  // `undefined` is what drops the key from the spawned command's environment.
  assert.ok('XDG_DATA_HOME' in env);
  assert.equal(env.XDG_DATA_HOME, undefined);
});

test('plugin strips its own payload variable from the agent environment', async () => {
  const env = await runHook(JSON.stringify({ XDG_CONFIG_HOME: '/c' }));
  assert.equal(env[HOST_XDG_ENV], undefined);
});

test('a malformed payload leaves the environment untouched rather than throwing', async () => {
  assert.deepEqual(await runHook('{not json'), { [HOST_XDG_ENV]: undefined });
});

test('a missing payload leaves the environment untouched rather than throwing', async () => {
  assert.deepEqual(await runHook(undefined), { [HOST_XDG_ENV]: undefined });
});

test('a non-object payload is ignored rather than spread into the environment', async () => {
  assert.deepEqual(await runHook('["XDG_CONFIG_HOME"]'), { [HOST_XDG_ENV]: undefined });
});

// ---------------------------------------------------------------------------
// stdio MCP servers: `environment` is a string map, so "unset" is expressed as
// the XDG spec's own default rather than an absent key.
// ---------------------------------------------------------------------------

test('unset host variables resolve to their XDG spec defaults', () => {
  const got = hostXdgForChildren({}, '/home/u', join);
  assert.deepEqual(got, {
    XDG_DATA_HOME: '/home/u/.local/share',
    XDG_CONFIG_HOME: '/home/u/.config',
    XDG_CACHE_HOME: '/home/u/.cache',
    XDG_STATE_HOME: '/home/u/.local/state',
  });
});

test('a set host variable is passed through verbatim', () => {
  const got = hostXdgForChildren({ XDG_CONFIG_HOME: '/custom/cfg' }, '/home/u', join);
  assert.equal(got.XDG_CONFIG_HOME, '/custom/cfg');
  assert.equal(got.XDG_CACHE_HOME, '/home/u/.cache');
});

test('an empty host variable falls back to the default, as the spec requires', () => {
  const got = hostXdgForChildren({ XDG_CONFIG_HOME: '' }, '/home/u', join);
  assert.equal(got.XDG_CONFIG_HOME, '/home/u/.config');
});

/** Mirrors the local half of the discovered map's element type. */
interface LocalServer {
  type: string;
  command: string[];
  environment?: Record<string, string>;
}

test('local MCP servers receive the XDG values', () => {
  const servers: Record<string, LocalServer> = { srv: { type: 'local', command: ['npx', 'thing'] } };
  const got = withHostXdg(servers, { XDG_CONFIG_HOME: '/home/u/.config' });
  assert.deepEqual(got.srv.environment, { XDG_CONFIG_HOME: '/home/u/.config' });
});

test("a server's own environment is preserved and wins over ours", () => {
  const servers: Record<string, LocalServer> = {
    srv: {
      type: 'local',
      command: ['x'],
      environment: { TOKEN: 'abc', XDG_CONFIG_HOME: '/deliberate' },
    },
  };
  const got = withHostXdg(servers, {
    XDG_CONFIG_HOME: '/home/u/.config',
    XDG_CACHE_HOME: '/home/u/.cache',
  });
  assert.equal(got.srv.environment?.TOKEN, 'abc');
  assert.equal(got.srv.environment?.XDG_CONFIG_HOME, '/deliberate');
  assert.equal(got.srv.environment?.XDG_CACHE_HOME, '/home/u/.cache');
});

test('remote MCP servers are left completely untouched', () => {
  const remote = { type: 'remote' as const, url: 'https://example.com' };
  const got = withHostXdg({ srv: remote }, { XDG_CONFIG_HOME: '/home/u/.config' });
  assert.deepEqual(got.srv, remote);
  assert.equal('environment' in got.srv, false);
});

test('an empty MCP map stays empty (no server is invented)', () => {
  assert.deepEqual(withHostXdg({}, { XDG_CONFIG_HOME: '/c' }), {});
});
