---
name: publish
description: Cut and ship a new versioned release of this VS Code extension — bump the version, write release notes, run a mandatory safety review of what actually gets packaged, then tag so the GitHub Action packages the VSIX and publishes to the Marketplace. Use when asked to publish, release, deploy, ship a new version, or cut a release of this extension.
---

# Publish a release

This extension releases are **tag-driven**: pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which typechecks, compiles, verifies the
version/notes, packages the `.vsix`, creates a GitHub Release, and publishes to
the VS Code Marketplace (needs the `VSCE_PAT` repo secret). There is no manual
`vsce publish` from a laptop — do **not** run it; let the Action do it so the
GitHub Release asset and the Marketplace build are byte-identical.

> Applies to both sibling extensions (`lmstudio-vscode-chat` and
> `ollama-vscode-chat`) — the flow is identical; only the package name and
> `lmstudioCode`/`ollamaCode` strings differ.

## Preconditions

- On `main`, working tree clean except the release changes, and `git pull` done.
- You know the extension id: `node -p "require('./package.json').publisher + '.' + require('./package.json').name"`.
- Decide the bump (semver): patch for fixes, minor for features, major for breaks
  (still `0.x` → minor for features is fine).

## Procedure

### 1. Bump the version
Edit `version` in `package.json`. It MUST equal the tag (without the `v`) — the
release workflow fails the build otherwise.

### 2. Write the release notes
Create `releasenotes/<version>.yaml` (see `releasenotes/README.md` for the
schema). Keep each list item on **one physical line** (the renderer uses a
minimal parser); use `[]` for empty sections. Then dry-run the exact render the
Action will use and read it:
```bash
node scripts/render-release-notes.js <version>
```

### 3. ⚠️ Safety review of the PACKAGED contents — MANDATORY, do not skip
The single most important step. The `.vscodeignore` decides what ships; a wrong
line can publish source, tests, internal docs, or secrets to the public
Marketplace. **Review the actual file list, not your assumptions.**

```bash
npx vsce ls          # the EXACT set of files that will be in the .vsix
```
Confirm the list contains ONLY:
- `package.json`, `README.md`, `LICENSE`
- `dist/extension.js`, `dist/webview/main.js` (the bundled output)
- curated `media/*` that the manifest references (icon, activity icon, styles, sample gif)

Then assert nothing inappropriate leaks (should print "clean"):
```bash
npx vsce ls | grep -iE '\.ts$|\.map$|/src/|/test/|tsconfig|esbuild|out-test|node_modules|\.vsix$|HANDOFF|secret|token|\.env' \
  && echo '!! REVIEW — unexpected file above' || echo 'clean'
```
Cross-check `.vscodeignore` still excludes: `src/**`, `test/**`, `**/*.ts`,
`**/*.map`, `out/**`, `out-test/**`, `esbuild*.js`, `tsconfig*.json`, `.github/**`,
`scripts/**`, `*.vsix`, `*HANDOFF.md`, internal/dev docs, `sample-workspace/**`,
and any dev-only/original media.

Scan source + bundle for leaked secrets (the `VSCE_PAT` lives ONLY as a GitHub
secret, referenced as `secrets.VSCE_PAT` in the workflow — never in code):
```bash
grep -rInE 'eyJ|-----BEGIN|AKIA[0-9A-Z]{16}|xox[baprs]-|ghp_[A-Za-z0-9]{20,}|VSCE_PAT *=' src dist 2>/dev/null \
  | grep -v 'secrets.VSCE_PAT' || echo 'no secrets in src/dist'
```
Also eyeball the diff for appropriateness: README claims true, no debug/PII
logging, no hardcoded hosts/paths, no profanity or placeholder text, and the
bundled `dist/*` is freshly built from the committed source.

### 4. Build + test
```bash
npm run check-types && npm run compile && npm test
```
(The release workflow runs check-types + compile; tests are local-only but run
them anyway — they cover the reliability logic.)

### 5. Commit
Stage everything (`.gitignore` already excludes `dist/`, `out-test/`, `*.vsix`)
and confirm no build artifacts are staged:
```bash
git add -A && git status --short
git commit -m "Release v<version> — <one-line summary>"
```

### 6. Tag and push
```bash
git push origin main
git tag -a v<version> -m "v<version>"
git push origin v<version>
```
Pushing the tag is what deploys. A pre-release tag (contains `-`, e.g.
`v0.3.0-rc.1`) creates a GitHub pre-release and **skips** the Marketplace publish.

### 7. Watch and verify
```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
gh release view v<version> --json tagName,isDraft,isPrerelease,assets
```
Confirm the run is green (incl. "Publish to VS Code Marketplace"), the GitHub
Release has both `<name>-<version>.vsix` and `<name>.vsix` assets, and — after a
few minutes' cache lag — `npx vsce show <publisher>.<name>` shows the new version.

## If something fails
- **Version/tag mismatch or missing notes file** → the workflow fails fast and
  nothing is published. Fix on `main`, delete the bad tag
  (`git push origin :v<version>` and `git tag -d v<version>`), re-tag, re-push.
- **Marketplace publish fails (VSCE_PAT)** → the GitHub Release still exists; add
  a valid `VSCE_PAT` (Marketplace → Manage → PAT with Marketplace scope) under
  repo Settings → Secrets → Actions, then re-run the failed job.
- You cannot "unpublish" a version cleanly — only publish a higher patch. So the
  safety review in step 3 is the real gate.
