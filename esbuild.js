const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Shared options */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
};

/** Extension host bundle (Node / CommonJS) */
const extensionConfig = {
  ...common,
  entryPoints: ['src/extension.ts'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
};

/** Webview bundle (browser / IIFE) */
const webviewConfig = {
  ...common,
  entryPoints: ['src/webview/main.ts'],
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'dist/webview/main.js',
};

async function main() {
  const ctxs = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);

  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[watch] watching for changes...');
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
