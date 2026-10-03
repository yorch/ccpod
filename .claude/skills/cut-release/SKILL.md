---
name: cut-release
description: >
  Guide a ccpod release through Changesets: a normal PR carries the release
  metadata, GitHub creates a reviewed version PR, and merging that PR publishes
  the GitHub binary release and Docker image. Use when the user says "cut a
  release", "ship a release", or asks to release the latest changes.
---

# Cut a ccpod release

ccpod releases are **Changeset-driven and PR-gated**. Never bump `package.json`
manually and never create or push a `v*` tag: GitHub Actions owns both after the
version PR is approved.

## Lifecycle

```text
feature/fix PR + Changeset → CI → merge to main
  → Release workflow opens/updates "chore: version packages"
  → human reviews version + CHANGELOG → merge version PR
  → Release workflow re-verifies, builds, attests, tags, publishes the release,
    then calls docker.yml to push the versioned image
```

## 1. Prepare the normal PR

Work from a worktree based on current `origin/main`. Add a Changeset:

```bash
bun run changeset   # select ccpod, choose patch/minor/major, write user-facing notes
git add .changeset/*.md
```

CI checks `bun run changeset status --since=origin/main`. Use `--empty` only when
nothing user-visible changed.

## 2. Validate and merge the normal PR

```bash
bun run verify
```

Wait for CI. Pause for explicit user confirmation before merging.

## 3. Review the generated version PR

The Release workflow opens or updates `chore: version packages`. Check that the
semantic version, `CHANGELOG.md`, and `bun.lock` match the intended release. PRs
created with `GITHUB_TOKEN` may not trigger CI; that is expected because the
release workflow re-runs the quality gate before publishing.

Pause for explicit user confirmation before merging the version PR.

## 4. Watch the automated release

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status --interval 20
gh release view vX.Y.Z --json assets --jq '[.assets[].name]'
```

Expect four platform binaries plus `SHASUMS256.txt`, and a GHCR image tagged
`X.Y.Z`, `X.Y`, and `latest`. A rerun validates the existing release instead of
replacing public assets.

## Gotchas

- The workflow, not a local tag push, creates `vX.Y.Z` on the publishing commit.
- Tags created with `GITHUB_TOKEN` don't trigger other workflows, which is why
  `release.yml` calls `docker.yml` explicitly.
- `ccpod update` and `install.sh` require `SHASUMS256.txt` and the
  `ccpod-<os>-<arch>` asset names — don't rename them.
- ccpod never publishes to npm (`private: true`; `publish-script` is a no-op).
- PRs created with `GITHUB_TOKEN` (the version PR) don't trigger `pull_request`
  workflows. Don't make CI jobs required status checks for `changeset-release/*`
  PRs, or the PR will wait forever; the release workflow re-runs the full gate
  before publishing. (Alternatively give `changesets/action` a PAT/App token.)
- If the release was created but the image wasn't pushed, re-run the Docker
  workflow manually: `gh workflow run docker.yml -f version=X.Y.Z`. A release with
  missing/extra assets makes every rerun fail until it is deleted by hand.
- `ccpod` is `private: true`, so `.changeset/config.json` must keep
  `privatePackages: {version: true, tag: false}`; otherwise `changeset version`
  silently does nothing and the version PR comes out empty.
