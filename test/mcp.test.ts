import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  augmentedPath,
  buildMcpConfig,
  countEnabled,
  expandVars,
  normalizeEntry,
  resolveMapVars,
  resolveServerVars,
} from '../src/core/mcp';

// ---- normalizeEntry: stdio / local ---------------------------------------

test('normalizeEntry: Claude Code / VS Code stdio (command string + args) -> local argv', () => {
  const out = normalizeEntry('playwright', {
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  });
  assert.deepEqual(out, { type: 'local', command: ['npx', '-y', '@playwright/mcp@latest'] });
});

test('normalizeEntry: OpenCode-native local (command already an array) is kept', () => {
  const out = normalizeEntry('db', { type: 'local', command: ['mcp-db', '--port', '5432'] });
  assert.deepEqual(out, { type: 'local', command: ['mcp-db', '--port', '5432'] });
});

test('normalizeEntry: command array + args concatenates', () => {
  const out = normalizeEntry('x', { command: ['node', 'server.js'], args: ['--flag'] });
  assert.deepEqual(out, { type: 'local', command: ['node', 'server.js', '--flag'] });
});

test('normalizeEntry: accepts both env (Claude/VS Code) and environment (OpenCode)', () => {
  assert.deepEqual(normalizeEntry('a', { command: 'x', env: { K: 'v' } }), {
    type: 'local',
    command: ['x'],
    environment: { K: 'v' },
  });
  assert.deepEqual(normalizeEntry('b', { command: 'x', environment: { K: 'v' } }), {
    type: 'local',
    command: ['x'],
    environment: { K: 'v' },
  });
});

test('normalizeEntry: explicit type "stdio" is treated as local', () => {
  const out = normalizeEntry('s', { type: 'stdio', command: 'mcp-x' });
  assert.deepEqual(out, { type: 'local', command: ['mcp-x'] });
});

test('normalizeEntry: local with no command is dropped (null)', () => {
  assert.equal(normalizeEntry('bad', { type: 'local' }), null);
  assert.equal(normalizeEntry('bad', { command: '' }), null);
  assert.equal(normalizeEntry('bad', { command: [] }), null);
});

test('normalizeEntry: cwd is preserved for local servers', () => {
  const out = normalizeEntry('c', { command: 'x', cwd: '/srv' });
  assert.deepEqual(out, { type: 'local', command: ['x'], cwd: '/srv' });
});

// ---- normalizeEntry: remote ----------------------------------------------

test('normalizeEntry: VS Code http -> remote', () => {
  const out = normalizeEntry('github', {
    type: 'http',
    url: 'https://api.githubcopilot.com/mcp',
    headers: { Authorization: 'Bearer abc' },
  });
  assert.deepEqual(out, {
    type: 'remote',
    url: 'https://api.githubcopilot.com/mcp',
    headers: { Authorization: 'Bearer abc' },
  });
});

test('normalizeEntry: sse type -> remote', () => {
  const out = normalizeEntry('s', { type: 'sse', url: 'https://x/sse' });
  assert.deepEqual(out, { type: 'remote', url: 'https://x/sse' });
});

test('normalizeEntry: a url with no command is inferred remote even without type', () => {
  const out = normalizeEntry('r', { url: 'https://x/mcp' });
  assert.deepEqual(out, { type: 'remote', url: 'https://x/mcp' });
});

test('normalizeEntry: remote with no url is dropped (null)', () => {
  assert.equal(normalizeEntry('bad', { type: 'remote' }), null);
  assert.equal(normalizeEntry('bad', { type: 'http', url: '   ' }), null);
});

// ---- enabled flag ---------------------------------------------------------

test('normalizeEntry: enabled:false is preserved; true/absent is omitted', () => {
  assert.equal((normalizeEntry('a', { command: 'x', enabled: false }) as any).enabled, false);
  assert.equal('enabled' in (normalizeEntry('b', { command: 'x', enabled: true }) as any), false);
  assert.equal('enabled' in (normalizeEntry('c', { command: 'x' }) as any), false);
});

// ---- buildMcpConfig: merge + precedence ----------------------------------

test('buildMcpConfig: gathers servers from all four sources', () => {
  const map = buildMcpConfig({
    claudeProject: { mcpServers: { a: { command: 'a-cmd' } } },
    vscodeWorkspace: { servers: { b: { command: 'b-cmd' } } },
    vscodeUser: { servers: { c: { type: 'http', url: 'https://c/mcp' } } },
    explicit: { d: { command: 'd-cmd' } },
  });
  assert.deepEqual(Object.keys(map).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(map.a, { type: 'local', command: ['a-cmd'] });
  assert.deepEqual(map.c, { type: 'remote', url: 'https://c/mcp' });
});

test('buildMcpConfig: later sources override earlier ones on name collision (explicit wins)', () => {
  const map = buildMcpConfig({
    claudeProject: { mcpServers: { shared: { command: 'from-claude' } } },
    explicit: { shared: { command: 'from-explicit' } },
  });
  assert.deepEqual(map.shared, { type: 'local', command: ['from-explicit'] });
});

test('buildMcpConfig: VS Code workspace overrides Claude project; user overrides workspace', () => {
  const map = buildMcpConfig({
    claudeProject: { mcpServers: { s: { command: 'claude' } } },
    vscodeWorkspace: { servers: { s: { command: 'ws' } } },
    vscodeUser: { servers: { s: { command: 'user' } } },
  });
  assert.deepEqual(map.s, { type: 'local', command: ['user'] });
});

test('buildMcpConfig: explicit setting accepts a bare map or a wrapped {servers}/{mcpServers}', () => {
  assert.ok(buildMcpConfig({ explicit: { a: { command: 'x' } } }).a);
  assert.ok(buildMcpConfig({ explicit: { servers: { a: { command: 'x' } } } }).a);
  assert.ok(buildMcpConfig({ explicit: { mcpServers: { a: { command: 'x' } } } }).a);
});

test('buildMcpConfig: empty / missing / malformed sources yield an empty map', () => {
  assert.deepEqual(buildMcpConfig({}), {});
  assert.deepEqual(buildMcpConfig({ claudeProject: undefined, explicit: null }), {});
  assert.deepEqual(buildMcpConfig({ claudeProject: 'not an object' as any }), {});
  assert.deepEqual(buildMcpConfig({ claudeProject: { mcpServers: 'nope' } as any }), {});
});

test('buildMcpConfig: malformed individual entries are dropped, valid ones kept', () => {
  const map = buildMcpConfig({
    explicit: {
      good: { command: 'x' },
      noCommand: { type: 'local' },
      noUrl: { type: 'remote' },
    },
  });
  assert.deepEqual(Object.keys(map), ['good']);
});

// ---- countEnabled ---------------------------------------------------------

test('countEnabled: counts servers not explicitly disabled', () => {
  const map = buildMcpConfig({
    explicit: {
      on: { command: 'x' },
      off: { command: 'y', enabled: false },
      on2: { type: 'http', url: 'https://z/mcp' },
    },
  });
  assert.equal(countEnabled(map), 2);
});

// ---- expandVars -----------------------------------------------------------

test('expandVars: ${VAR} and $VAR are expanded from the env', () => {
  const env = { TOKEN: 'secret123', NAME: 'corey' };
  assert.equal(expandVars('Bearer ${TOKEN}', env), 'Bearer secret123');
  assert.equal(expandVars('$NAME-suffix', env), 'corey-suffix');
  assert.equal(expandVars('${NAME}/${TOKEN}', env), 'corey/secret123');
});

test('expandVars: unknown variables expand to empty string (no literal token leak)', () => {
  assert.equal(expandVars('Bearer ${MISSING}', {}), 'Bearer ');
  assert.equal(expandVars('plain text', {}), 'plain text');
});

// ---- resolveServerVars / resolveMapVars ----------------------------------

test('resolveServerVars: expands remote url + headers', () => {
  const out = resolveServerVars(
    { type: 'remote', url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
    { HOST: 'api.example.com', TOKEN: 'xyz' },
  );
  assert.deepEqual(out, {
    type: 'remote',
    url: 'https://api.example.com/mcp',
    headers: { Authorization: 'Bearer xyz' },
  });
});

test('resolveServerVars: expands local command + environment + cwd', () => {
  const out = resolveServerVars(
    { type: 'local', command: ['mcp', '--key', '${KEY}'], environment: { TOKEN: '${TOKEN}' }, cwd: '${HOME}/srv' },
    { KEY: 'k1', TOKEN: 't1', HOME: '/Users/me' },
  );
  assert.deepEqual(out, {
    type: 'local',
    command: ['mcp', '--key', 'k1'],
    environment: { TOKEN: 't1' },
    cwd: '/Users/me/srv',
  });
});

test('resolveServerVars: does not mutate the input', () => {
  const input = { type: 'remote' as const, url: 'https://${HOST}/x' };
  resolveServerVars(input, { HOST: 'h' });
  assert.equal(input.url, 'https://${HOST}/x');
});

test('resolveMapVars: resolves every server in the map', () => {
  const out = resolveMapVars(
    {
      a: { type: 'local', command: ['x', '${A}'] },
      b: { type: 'remote', url: 'https://${B}/mcp' },
    },
    { A: 'aa', B: 'bb' },
  );
  assert.deepEqual((out.a as any).command, ['x', 'aa']);
  assert.equal((out.b as any).url, 'https://bb/mcp');
});

// ---- augmentedPath --------------------------------------------------------

test('augmentedPath: appends common bin dirs, keeping existing entries first', () => {
  const out = augmentedPath('/usr/bin', '/home/me', ':');
  const parts = out.split(':');
  assert.equal(parts[0], '/usr/bin'); // user toolchain still wins (searched first)
  assert.ok(parts.includes('/opt/homebrew/bin'));
  assert.ok(parts.includes('/home/me/.local/bin'));
});

test('augmentedPath: de-duplicates dirs already on PATH', () => {
  const out = augmentedPath('/opt/homebrew/bin:/usr/bin', '/home/me', ':');
  const count = out.split(':').filter((p) => p === '/opt/homebrew/bin').length;
  assert.equal(count, 1);
});

test('augmentedPath: extra dirs are prepended to the added set', () => {
  const out = augmentedPath('/usr/bin', '/home/me', ':', ['/custom/bin']);
  const parts = out.split(':');
  // existing first, then extra, then common
  assert.equal(parts[0], '/usr/bin');
  assert.equal(parts[1], '/custom/bin');
});

test('augmentedPath: Windows separator uses Windows-style dirs', () => {
  const out = augmentedPath('C:\\Windows', 'C:\\Users\\me', ';');
  assert.ok(out.includes('C:\\Users\\me\\AppData\\Roaming\\npm'));
  assert.ok(out.startsWith('C:\\Windows'));
});

test('augmentedPath: handles an empty/undefined current PATH', () => {
  const out = augmentedPath(undefined, '/home/me', ':');
  assert.ok(out.includes('/opt/homebrew/bin'));
  assert.equal(out.startsWith(':'), false); // no leading empty segment
});
