#!/usr/bin/env node
// Fetch the pinned OpenCode binary for a given VS Code platform target and stage
// it into ./bin so `vsce package --target <target>` bundles it. Pure Node + npm,
// no global install: we `npm pack` the exact platform package and untar it.
//
// Usage:
//   node scripts/fetch-opencode.js <vsce-target>
//   node scripts/fetch-opencode.js            (defaults to the host platform)
//
// The pinned version is read from package.json -> "opencodeVersion" so the
// bundled binary can never drift from what we declare. Bump that field to
// upgrade OpenCode; the release workflow fetches per target from it.
//
// We deliberately do NOT execute the binary here — fetching is just download +
// untar, so every target can be staged on a single (e.g. Linux) CI runner.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');

// vsce target -> { pkg: npm platform package, exe: binary name inside bin/ }.
// npm uses "windows" in the package name; vsce/VS Code uses "win32".
const TARGETS = {
  'darwin-arm64': { pkg: 'opencode-darwin-arm64', exe: 'opencode' },
  'darwin-x64': { pkg: 'opencode-darwin-x64', exe: 'opencode' },
  'linux-x64': { pkg: 'opencode-linux-x64', exe: 'opencode' },
  'linux-arm64': { pkg: 'opencode-linux-arm64', exe: 'opencode' },
  'win32-x64': { pkg: 'opencode-windows-x64', exe: 'opencode.exe' },
  'win32-arm64': { pkg: 'opencode-windows-arm64', exe: 'opencode.exe' },
};

function hostTarget() {
  const plat = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch; // 'arm64' | 'x64'
  return `${plat}-${arch}`;
}

function pinnedVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const v = pkg.opencodeVersion;
  if (!v || typeof v !== 'string') {
    throw new Error('package.json is missing a string "opencodeVersion" field');
  }
  return v;
}

function run(cmd, args, opts = {}) {
  const res = cp.spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed (status ${res.status})\n${out}`);
  }
  return res.stdout;
}

function main() {
  const target = process.argv[2] || hostTarget();
  const spec = TARGETS[target];
  if (!spec) {
    throw new Error(
      `Unknown target "${target}". Known: ${Object.keys(TARGETS).join(', ')}`,
    );
  }
  const version = pinnedVersion();
  const pkgRef = `${spec.pkg}@${version}`;

  // Stage into a temp dir, then atomically place the single binary into bin/.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-opencode-'));
  try {
    console.log(`[fetch-opencode] target=${target} pkg=${pkgRef}`);
    // npm pack writes <name>-<version>.tgz into cwd and prints the filename.
    const packed = run('npm', ['pack', pkgRef, '--silent'], { cwd: work })
      .trim()
      .split('\n')
      .pop()
      .trim();
    const tgz = path.join(work, packed);

    // Untar: platform packages contain `package/bin/opencode[.exe]`.
    run('tar', ['-xzf', tgz, '-C', work]);
    const srcBin = path.join(work, 'package', 'bin', spec.exe);
    if (!fs.existsSync(srcBin)) {
      throw new Error(`binary not found in package at ${srcBin}`);
    }

    fs.rmSync(BIN_DIR, { recursive: true, force: true });
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const destBin = path.join(BIN_DIR, spec.exe);
    fs.copyFileSync(srcBin, destBin);
    // Preserve the executable bit (matters for darwin/linux; harmless on win).
    fs.chmodSync(destBin, 0o755);

    // Stamp what we placed so the runtime / debugging can confirm provenance.
    fs.writeFileSync(
      path.join(BIN_DIR, 'opencode.version'),
      `${version}\n${target}\n${spec.exe}\n`,
    );

    const bytes = fs.statSync(destBin).size;
    console.log(
      `[fetch-opencode] wrote ${destBin} (${(bytes / 1e6).toFixed(1)} MB), v${version}`,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`[fetch-opencode] ${err.message}`);
  process.exit(1);
}
