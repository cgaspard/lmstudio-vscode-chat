// Bundle the unit tests (and the pure src/core modules they import) to
// out-test/ so they can run under Node's built-in test runner:
//   node esbuild.test.js && node --test out-test/
// The core modules have no vscode/node-only deps, so bundling is trivial.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const testDir = path.join(__dirname, 'test');
const entryPoints = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join('test', f));

if (!entryPoints.length) {
  console.error('no test files found in test/');
  process.exit(1);
}

esbuild
  .build({
    entryPoints,
    outdir: 'out-test',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: 'inline',
    logLevel: 'warning',
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
