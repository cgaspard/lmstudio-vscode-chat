#!/usr/bin/env node
// Build the embedded OpenCode engine into ./opencode-sdk so the extension can
// run OpenCode in-process instead of spawning a server binary.
//
// Usage:
//   node scripts/build-opencode-sdk.js <vsce-target>
//   node scripts/build-opencode-sdk.js            (defaults to the host platform)
//
// Output:
//   opencode-sdk/sdk.mjs          @opencode/sdk and its JS dependency graph, one ESM file
//   opencode-sdk/node_modules/    the native modules it loads at runtime, for <target>
//   opencode-sdk/version          pinned SDK version + target, for provenance
//   opencode-sdk/LICENSE.opencode the MIT notice for the bundled OpenCode code
//
// Why one ESM file rather than folding it into dist/extension.js: the SDK is
// ESM-only and leans on import.meta (url, resolve) in ~30 places, which a
// CommonJS bundle cannot carry. The extension loads this file with a dynamic
// import(), which works from CommonJS in the extension host.
//
// The SDK version is pinned in package.json devDependencies (exact, no range):
// its API calls itself experimental and has broken contracts in a minor release.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'opencode-sdk');

// The symbol the extension sets before importing sdk.mjs. Must match
// SDK_ROOTS_KEY in src/opencode/embedded.ts.
const ROOTS_KEY = 'lmstudioCode.roots';

// Loaded by the SDK at runtime but not bundleable: native addons and wasm. They
// ship as real packages beside sdk.mjs, at the versions the SDK resolved.
// (2.2 dropped the tree-sitter shell parsers; the bundle no longer imports them.)
const NATIVE = ['@parcel/watcher', '@lydell/node-pty'];
// Platform-neutral packages that must also ship as real packages, because they
// find their own files at runtime and those files cannot be bundled.
// photon-node (image downscaling): @opencode/core resolves
// "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with createRequire(). 2.1.4
// did this lazily. 2.2.6 does it as soon as sdk.mjs loads, so without the
// package the engine never starts. Inside the package, photon_rs.js reads the
// wasm from its own __dirname, and an ESM bundle has no __dirname.
const RUNTIME = ['@silvia-odwyer/photon-node'];
// Optional accelerators the SDK falls back without (try/catch around the import).
const OPTIONAL = ['@ff-labs/fff-node', 'bufferutil', 'utf-8-validate', 'supports-color'];

// vsce target -> npm --os/--cpu(/--libc), so the native packages match the VSIX
// platform. Linux needs a libc: @parcel/watcher publishes glibc and musl builds
// separately and npm installs neither without one. VS Code's Linux builds are
// glibc.
const TARGETS = {
  'darwin-arm64': ['darwin', 'arm64'],
  'darwin-x64': ['darwin', 'x64'],
  'linux-x64': ['linux', 'x64', 'glibc'],
  'linux-arm64': ['linux', 'arm64', 'glibc'],
  'win32-x64': ['win32', 'x64'],
  'win32-arm64': ['win32', 'arm64'],
};

/**
 * Source patches, applied to the bundle only (node_modules is untouched).
 * Each throws if the code it targets has changed, so an SDK upgrade fails the
 * build loudly instead of shipping a silent regression.
 */
const patches = {
  name: 'opencode-embed-patches',
  setup(build) {
    // The Claude Agent SDK (since 2.2.3) is an optional peer of @opencode/core,
    // loaded through `import("#claude-agent-sdk")` only for the built-in Claude
    // Agent provider, which this extension never configures. It cannot simply
    // be external: that module is `export * from "@anthropic-ai/claude-agent-sdk"`,
    // and esbuild hoists an external re-export to a static top-level import, so
    // the whole engine would fail to load without the package. A stub that
    // throws on import keeps it lazy; upstream catches the failure and reports
    // "Claude Agent SDK isn't installed".
    build.onResolve({ filter: /^#claude-agent-sdk$/ }, () => ({ path: 'claude-agent-sdk', namespace: 'oc-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'oc-stub' }, () => ({
      contents: 'throw new Error("@anthropic-ai/claude-agent-sdk is not bundled with this extension");',
      loader: 'js',
    }));

    // global-roots.js reads XDG_* once at module load, and snapshots and shell
    // logs use those constants directly, ignoring the SDK's path options. In a
    // shared extension host we must not touch process.env, so the roots come
    // from a per-extension symbol instead (set by src/opencode/embedded.ts).
    build.onLoad({ filter: /@opencode[\\/]util[\\/]dist[\\/]global-roots\.js$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, 'utf8');
      const anchor = 'const home = os.homedir();';
      if (!src.includes(anchor) || !src.includes('process.env.XDG_DATA_HOME')) {
        throw new Error('@opencode/util global-roots.js changed upstream; update the roots patch');
      }
      const inject =
        `const __roots = globalThis[Symbol.for(${JSON.stringify(ROOTS_KEY)})] ?? {};\n` +
        'const __xdg = { XDG_DATA_HOME: __roots.data, XDG_CACHE_HOME: __roots.cache, XDG_CONFIG_HOME: __roots.config, XDG_STATE_HOME: __roots.state };\n';
      const out = src
        .replace(anchor, `${inject}${anchor}`)
        .replace(/process\.env\.(XDG_[A-Z_]+)/g, '(__xdg.$1 ?? process.env.$1)');
      return { contents: out, loader: 'js' };
    });

    // Chat history from 1.x: @opencode/core resolves `#v1-migration` to a no-op
    // on Node (the real migrator is published for Bun only) and the no-op
    // reports "completed". Sessions 1.x had not already mirrored into the v2
    // tables would silently vanish on upgrade. Use the real migrator; its only
    // Bun dependencies are bun:sqlite (mapped to a node:sqlite adapter) and one
    // hash call (below).
    build.onResolve({ filter: /^#v1-migration$/ }, () => ({
      path: path.join(ROOT, 'node_modules', '@opencode', 'core', 'dist', 'database', 'v1-migration.bun.js'),
    }));
    build.onResolve({ filter: /^bun:sqlite$/ }, () => ({
      path: path.join(ROOT, 'scripts', 'opencode-sdk', 'bun-sqlite.mjs'),
    }));
    build.onLoad({ filter: /@opencode[\\/]core[\\/]dist[\\/]database[\\/]v1-migration\.bun\.js$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, 'utf8');
      const bunHash = /new Bun\.CryptoHasher\("sha256"\)\.update\(/g;
      if ((src.match(bunHash) ?? []).length !== 1 || /\bBun\.(?!CryptoHasher)/.test(src)) {
        throw new Error('v1-migration.bun.js uses Bun APIs the patch does not cover; update the migration patch');
      }
      const out =
        'import { createHash as __ocCreateHash } from "node:crypto";\n' +
        src.replace(bunHash, '__ocCreateHash("sha256").update(');
      return { contents: out, loader: 'js' };
    });
  },
};

function run(cmd, args, opts = {}) {
  const res = cp.spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  if (res.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed (status ${res.status})\n${res.stdout ?? ''}${res.stderr ?? ''}`.trim());
  }
  return res.stdout;
}

function installedVersion(pkg) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version;
}

async function main() {
  const target = process.argv[2] || `${process.platform}-${process.arch}`;
  const platform = TARGETS[target];
  if (!platform) {
    throw new Error(`Unknown target "${target}". Known: ${Object.keys(TARGETS).join(', ')}`);
  }
  const sdkVersion = installedVersion('@opencode/sdk');
  console.log(`[build-opencode-sdk] @opencode/sdk ${sdkVersion} for ${target}`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const entry = path.join(OUT, 'entry.mjs');
  fs.writeFileSync(entry, "export { OpenCode } from '@opencode/sdk';\n");
  try {
    await esbuild.build({
      entryPoints: [entry],
      absWorkingDir: ROOT,
      nodePaths: [path.join(ROOT, 'node_modules')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: path.join(OUT, 'sdk.mjs'),
      minify: true,
      legalComments: 'eof',
      logLevel: 'warning',
      // jsonc-parser's UMD entry uses relative requires esbuild cannot follow.
      mainFields: ['module', 'main'],
      // CommonJS deps inside the ESM bundle still call require().
      banner: { js: "import { createRequire as __ocCreateRequire } from 'node:module'; const require = __ocCreateRequire(import.meta.url);" },
      plugins: [patches],
      external: [...NATIVE.flatMap((p) => [p, `${p}/*`, `${p}-*`]), ...RUNTIME.flatMap((p) => [p, `${p}/*`]), ...OPTIONAL, '*.node'],
    });
  } finally {
    fs.rmSync(entry, { force: true });
  }

  // Native and runtime packages: install the exact versions the SDK resolved,
  // for the target platform, into opencode-sdk/node_modules (resolved relative
  // to sdk.mjs).
  const specs = [...NATIVE, ...RUNTIME].map((p) => `${p}@${installedVersion(p)}`);
  fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ name: 'opencode-sdk-runtime', private: true }, null, 2));
  run(
    'npm',
    [
      'install',
      ...specs,
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      `--os=${platform[0]}`,
      `--cpu=${platform[1]}`,
      ...(platform[2] ? [`--libc=${platform[2]}`] : []),
    ],
    { cwd: OUT },
  );
  // Fail the build rather than ship a VSIX whose engine cannot start on <target>.
  for (const [pkg, dir] of [
    ['@parcel/watcher', `@parcel/watcher-${platform[0]}-${platform[1]}${platform[2] ? `-${platform[2]}` : ''}`],
    ['@lydell/node-pty', `@lydell/node-pty-${platform[0]}-${platform[1]}`],
  ]) {
    if (!fs.existsSync(path.join(OUT, 'node_modules', dir))) {
      throw new Error(`${pkg}: no native package for ${target} (expected node_modules/${dir})`);
    }
  }
  for (const pkg of RUNTIME) {
    if (!fs.existsSync(path.join(OUT, 'node_modules', pkg, 'package.json'))) {
      throw new Error(`${pkg}: not installed beside sdk.mjs`);
    }
  }
  fs.rmSync(path.join(OUT, 'package.json'), { force: true });

  fs.writeFileSync(path.join(OUT, 'version'), `${sdkVersion}\n${target}\n`);
  // MIT requires the notice to travel with the OpenCode code bundled into
  // sdk.mjs. Keep scripts/LICENSE.opencode in step if upstream changes terms.
  fs.copyFileSync(path.join(ROOT, 'scripts', 'LICENSE.opencode'), path.join(OUT, 'LICENSE.opencode'));
  // npm bookkeeping the runtime never reads.
  fs.rmSync(path.join(OUT, 'node_modules', '.bin'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'node_modules', '.package-lock.json'), { force: true });
  smokeLoad(target);
  const mb = (p) => (fs.statSync(p).size / 1e6).toFixed(1);
  console.log(
    `[build-opencode-sdk] wrote opencode-sdk/sdk.mjs (${mb(path.join(OUT, 'sdk.mjs'))} MB) + ${NATIVE.length} native and ${RUNTIME.length} runtime packages`,
  );
}

/**
 * Import the built engine from a copy outside the repo, as the installed
 * extension will. Run in place, a package missing from opencode-sdk/node_modules
 * still resolves from the repo's own node_modules, so the check passes while
 * the shipped VSIX fails on load. That is how 0.35.0 shipped without
 * photon-node. Runs only when <target> is the host, because a foreign target's
 * natives cannot load here (CI's linux-x64 legs cover it).
 */
function smokeLoad(target) {
  if (target !== `${process.platform}-${process.arch}`) {
    console.log(`[build-opencode-sdk] skipped the load check: ${target} is not this host`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sdk-smoke-'));
  try {
    const copy = path.join(dir, 'opencode-sdk');
    fs.cpSync(OUT, copy, { recursive: true });
    const url = pathToFileURL(path.join(copy, 'sdk.mjs')).href;
    const script =
      `import(${JSON.stringify(url)}).then((m) => {` +
      " if (typeof m.OpenCode?.create !== 'function') throw new Error('sdk.mjs does not export OpenCode.create');" +
      '});';
    const res = cp.spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`the built engine does not load outside the repo:\n${(res.stderr || res.stdout || '').trim()}`);
    }
    console.log('[build-opencode-sdk] load check passed (imported from a copy outside the repo)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[build-opencode-sdk] ${err.message}`);
  process.exit(1);
});
