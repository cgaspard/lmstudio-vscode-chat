// The running extension version has to be readable at a glance — from the empty
// state and from the composer, which is on screen for the whole session. The
// host injects it into <body data-version> at html-build time, so a stale or
// missing wire-up shows up as an empty chip rather than a wrong number.
//
// Injection-driven: no LM Studio, no OpenCode.
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import * as helpers from './helpers';

const { openPanel, post, count, text } = helpers;

function installedVersion(): string {
  const ext =
    vscode.extensions.getExtension('cgaspard.lmstudio-code') ??
    vscode.extensions.all.find((e) => e.id.toLowerCase().endsWith('.lmstudio-code'));
  assert.ok(ext, 'the extension under test should be resolvable');
  return String(ext!.packageJSON.version);
}

describe('extension version', function () {
  this.timeout(30000);

  before(async () => {
    await openPanel();
    await post({
      type: 'init',
      models: [],
      currentModel: null,
      agent: 'build',
      cwd: '/tmp',
      serverReady: true,
      lmStudioConnected: true,
      minContext: 32768,
    });
  });

  it('shows the real installed version, not a hardcoded string', async () => {
    const version = installedVersion();
    assert.match(version, /^\d+\.\d+\.\d+/, 'package.json version should be semver');
    assert.strictEqual(await text('.ver-chip'), `v${version}`);
  });

  it('sits left of the title-bar actions, outside the cluster that fades out', async () => {
    // .titlebar-actions is opacity:0 until hover/focus. The version must not
    // inherit that — it is meant to be readable at all times — so it lives in
    // the wrapper beside the cluster, not inside it.
    assert.strictEqual(await count('.titlebar > .ver-chip'), 1);
    assert.strictEqual(await count('.titlebar-actions .ver-chip'), 0);
    // First child of the wrapper = to the LEFT of the buttons.
    assert.strictEqual(await count('.titlebar > .ver-chip:first-child'), 1);
  });

  it('tags the empty-state title with it too', async () => {
    assert.strictEqual(await text('.welcome-ver'), `v${installedVersion()}`);
    assert.strictEqual(await text('.welcome-title'), `LM Studio Code v${installedVersion()}`);
  });
});
