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
bun test tests/unit/ # unit tests
bun run check        # biome format + lint (writes fixes)
```

All three must pass. See `CLAUDE.md` for the full commit checklist.

## Cutting a release

1. **Bump the version** in `package.json` — this is the single source of truth; `src/version.ts` reads from it at build time.

   ```sh
   # Edit package.json: "version": "0.2.0"
   ```

2. **Commit the bump:**

   ```sh
   git add package.json
   git commit -m "chore: bump version to v0.2.0"
   ```

3. **Tag and push:**

   ```sh
   git tag v0.2.0
   git push origin main --tags
   ```

Pushing a `v*` tag triggers the [Release workflow](.github/workflows/release.yml), which:

- Runs `typecheck` and `bun test`
- Compiles four binaries: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`
- Creates a GitHub release with auto-generated notes and attaches the binaries

The install script at `https://ccpod.brnby.com/install.sh` automatically picks up the new release tag on next run.

## Website

The documentation site lives in `website/`. It is an [Astro Starlight](https://starlight.astro.build) site deployed to GitHub Pages on every push to `main`.

```sh
cd website
bun install
bun run dev      # http://localhost:4321
bun run build    # output to website/dist/
```
