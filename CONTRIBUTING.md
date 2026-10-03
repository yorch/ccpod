# Contributing to ccpod

## Development setup

Requires [Bun](https://bun.sh) 1.x and a container runtime (Docker, OrbStack, Colima, or Podman).

```sh
git clone https://github.com/yorch/ccpod.git
cd ccpod
bun install
bun run dev -- --version   # run without building
```

**Package manager:** bun only. Never use `npm`, `pnpm`, or `yarn`.

## Quality gates

Run before every commit:

```sh
bun run typecheck    # tsc --noEmit
bun test tests/unit/ --isolate # unit tests (--isolate keeps mock.module() from leaking between files)
bun run check        # biome format + lint (writes fixes)
```

All three must pass. See `CLAUDE.md` for the full commit checklist.

## Changesets

Every PR that changes the `ccpod` package includes a [Changeset](https://github.com/changesets/changesets):

```sh
bun run changeset   # select ccpod, choose patch/minor/major, describe the change
git add .changeset/*.md
```

CI fails PRs without one. Use `bun run changeset --empty` for changes that are not user-visible.

## Cutting a release

Releases are Changeset-driven and PR-gated — do not edit the version in `package.json` or push tags manually.

1. Merge PRs carrying Changesets into `main`.
2. The [Release workflow](.github/workflows/release.yml) opens or updates a `chore: version packages` PR with the bumped version and `CHANGELOG.md`.
3. Review and merge that PR. This is the approval step.
4. The workflow then re-runs the full quality gate, compiles four binaries (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`), generates `SHASUMS256.txt`, attests build provenance, creates the `vX.Y.Z` tag and GitHub release with auto-generated notes, and publishes the Docker image to GHCR.

Verify a binary with `gh attestation verify <binary> --repo yorch/ccpod`. The install script at `https://ccpod.brnby.com/install.sh` picks up the new release on its next run.

## Website

The documentation site lives in `website/`. It is an [Astro Starlight](https://starlight.astro.build) site deployed to GitHub Pages on every push to `main`.

```sh
cd website
bun install
bun run dev      # http://localhost:4321
bun run build    # output to website/dist/
```
