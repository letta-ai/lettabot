# Releasing

LettaBot uses GitHub Releases with automated release notes.

## How to Release

### 1. Tag the commit

```bash
git checkout main
git pull origin main
git tag v0.2.0
git push origin v0.2.0
```

### 2. What happens automatically

The [release workflow](../.github/workflows/release.yml) runs on every `v*` tag push:

1. **Build gate** - `npm ci && npm run build`
2. **Test gate** - `npm run test:run` (all unit tests must pass)
3. **Release notes** - Auto-generated from merged PRs since the last tag
4. **GitHub Release** - Created with the notes, linked to the tag

### 3. Pre-releases

Tags containing `alpha`, `beta`, or `rc` are automatically marked as pre-release:

```bash
git tag v0.2.0-alpha.1    # marked as pre-release
git tag v0.2.0-beta.2     # marked as pre-release
git tag v0.2.0-rc.1       # marked as pre-release
git tag v0.2.0            # marked as stable release
```

## Versioning

We follow [Semantic Versioning](https://semver.org/):

- **Major** (`v1.0.0`) - Breaking changes to config format, channel API, or CLI
- **Minor** (`v0.2.0`) - New features, new channels, new config options
- **Patch** (`v0.1.1`) - Bug fixes, dependency updates, docs

While in `0.x`, minor versions may include breaking changes.

## Release Checklist

Before tagging a release:

- [ ] All PRs for this release are merged to `main`
- [ ] `npm run build` passes locally
- [ ] `npm run test:run` passes locally
- [ ] README and docs are up to date
- [ ] No known critical bugs (check open issues)

## npm Publishing

Not yet available. Tracked in [#174](https://github.com/letta-ai/lettabot/issues/174).

Currently, users install from source:

```bash
git clone https://github.com/letta-ai/lettabot.git
cd lettabot
git checkout v0.2.0  # or latest tag
npm install && npm run build && npm link
```

## Viewing Releases

- [All releases](https://github.com/letta-ai/lettabot/releases)
- [Latest release](https://github.com/letta-ai/lettabot/releases/latest)
