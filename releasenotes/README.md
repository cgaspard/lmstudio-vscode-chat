# Release notes

One YAML file per published version: `releasenotes/<version>.yaml`. The
`Release` GitHub Action requires the file to exist and matches it to the git
tag and `package.json` version, then renders it into the GitHub Release body
with `scripts/render-release-notes.js`.

## Schema

```yaml
version: 0.1.0          # must equal package.json version and the tag (v0.1.0)
date: 2026-06-07
highlights:             # optional, shown first
  - Short, user-facing summary line.
added:                  # optional
  - New capability.
changed:                # optional
  - Behavior change.
fixed:                  # optional
  - Bug fix.
removed:                # optional, use `[]` when empty
  - Dropped feature.
```

Keep lines plain (no nested YAML) — the renderer uses a minimal parser that
supports `key: value`, list-of-strings blocks, and `key: []`.

## Cutting a release

1. Bump `version` in `package.json`.
2. Add `releasenotes/<version>.yaml`.
3. Commit, then tag: `git tag v<version> && git push origin v<version>`.
4. The Release workflow packages the `.vsix`, creates the GitHub Release, and
   publishes to the VS Code Marketplace (needs the `VSCE_PAT` repo secret).
