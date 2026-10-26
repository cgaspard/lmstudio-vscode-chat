// Build test-live/*.live.ts and run them under VS Code's own runtime (Electron's
// Node), which is where the embedded engine runs in production. Falls back to
// plain Node when the VS Code binary is not found (set VSCODE_BIN to override).
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out-live');

function vscodeBinary() {
  if (process.env.VSCODE_BIN) return process.env.VSCODE_BIN;
  const candidates = {
    darwin: ['/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders'],
    linux: ['/usr/share/code/code', '/usr/bin/code'],
    win32: [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')],
  }[process.platform] ?? [];
  return candidates.find((c) => fs.existsSync(c));
}

(async () => {
  const filter = process.argv[2];
  const entries = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.live.ts') && (!filter || f.includes(filter)))
    .map((f) => path.join(__dirname, f));
  await esbuild.build({
    entryPoints: entries,
    outdir: OUT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'warning',
    // The logger writes to a VS Code output channel; outside VS Code, log to stdout.
    alias: { vscode: path.join(__dirname, 'vscode-stub.js') },
  });
  const bin = vscodeBinary();
  let failed = 0;
  for (const entry of entries) {
    const js = path.join(OUT, path.basename(entry).replace(/\.ts$/, '.js'));
    console.log(`\n▶ ${path.basename(entry)} (${bin ? 'VS Code runtime' : 'node'})`);
    const res = cp.spawnSync(bin ?? process.execPath, [js], {
      stdio: 'inherit',
      env: { ...process.env, ...(bin ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    });
    failed += res.status === 0 ? 0 : 1;
  }
  process.exit(failed ? 1 : 0);
})();
