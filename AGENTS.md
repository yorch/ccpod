# Project Guidelines

This file provides guidance to AI agents when working with code in this repository.

> `CLAUDE.md` is a symlink to `AGENTS.md` — any changes here should be reflected in `CLAUDE.md` and vice versa.

## Package manager

This project uses **bun** exclusively. Never use `npm`, `pnpm`, or `yarn`. Always run `bun install`, `bun run <script>`, `bun test`, etc. The website (`website/`) also uses bun — same rule applies there.

## Commands

```sh
bun run dev              # run CLI without building
bun run build            # compile to dist/ccpod binary
bun run typecheck        # tsc --noEmit
bun run check            # biome format + lint (writes fixes)
bun test                 # all tests
bun test tests/unit/config/merger.test.ts  # single test file
```

### Website commands

```sh
cd website
bun run dev              # start Astro dev server
bun run build            # build to website/dist/
bun run preview          # preview built site
```

## Architecture

`ccpod` is a CLI that runs Claude Code in Docker. Entry point: `src/cli/index.ts` (citty router).

### Config pipeline (the core flow)

`ccpod run` executes this pipeline in order:

1. **Load** — `src/config/loader.ts` reads `~/.ccpod/profiles/<name>/profile.yml` (profile) and walks up from `cwd` to find `.ccpod.yml` (project). Both validated via Zod schemas in `src/config/schema.ts`.
2. **Sync** — `src/profile/git-sync.ts` pulls the profile's config repo if `source: git`.
3. **Merge** — `src/config/merger.ts` combines profile + project using `merge: deep|override` strategy. CLAUDE.md files are merged separately via `mergeClaudes()` (append or override).
4. **Auth** — `src/auth/resolver.ts` resolves API key or OAuth credentials into env vars.
5. **Config write** — `src/config/writer.ts` writes merged config to a temp dir mounted as `/ccpod/config` in the container.
6. **Container spec** — `src/container/builder.ts` builds the `ContainerSpec` (binds, env, ports, labels, tmpfs). Exports `computeProjectHash(dir)`.
7. **Sidecars** — `src/container/sidecars.ts` creates shared Docker network `ccpod-net-<hash>` and starts declared `services:` containers before the main container.
8. **Run** — `src/container/runner.ts` creates/reattaches/starts the container via `docker` CLI (`Bun.spawn`). TTY mode = interactive; headless mode (`--file`) streams logs.

### Key modules

| Path | Purpose |
|------|---------|
| `src/types/index.ts` | Shared types: `ProfileConfig`, `ProjectConfig`, `ResolvedConfig`, `ContainerSpec` |
| `src/runtime/detector.ts` | Auto-detects OrbStack / Docker / Colima / Podman socket |
| `src/runtime/docker.ts` | `dockerExec` (capture stdout/stderr) and `dockerSpawn` (inherit stdio) |
| `src/profile/manager.ts` | `~/.ccpod/` directory layout, profile CRUD |
| `src/global/config.ts` | Read/write `~/.ccpod/config.yml` (global settings like `autoCheckUpdates`) |
| `src/mcp/parser.ts` | Reads `.mcp.json` to auto-expose MCP HTTP ports |
| `src/image/manager.ts` | Pull or `docker build` the container image |
| `src/container/sidecars.ts` | Shared network creation and sidecar container lifecycle |
| `src/update/checker.ts` | Checks GitHub releases for newer version |
| `src/update/updater.ts` | Downloads and replaces the ccpod binary in-place |

### Storage layout

```
~/.ccpod/
  config.yml             # global ccpod settings (autoCheckUpdates, etc.)
  profiles/<name>/
    profile.yml          # profile config
    config/              # Claude config dir (if source: git, cloned here)
  credentials/<name>/    # auth tokens/keys
  state/<name>/          # persistent state (when state: persistent)
Docker volumes:
  ccpod-plugins-<profile>   # persistent plugin installs
```

### Container mounts

- `/workspace` — project dir (rw)
- `/ccpod/config` — merged Claude config dir (ro)
- `/ccpod/credentials` — auth credentials (rw)
- `/ccpod/plugins` — named volume for plugins
- `/ccpod/state` — host bind `~/.ccpod/state/<profile>/` (persistent) or tmpfs (ephemeral)

### Security invariants

- **Profile names** are validated by Zod regex `/^[a-zA-Z0-9_-]{1,64}$/` — enforced at parse time in `schema.ts`.
- **`--file` arg** in `run.ts` is normalized and rejected if it starts with `..` or is absolute.
- **Config temp dirs** are written mode `0o700`, files mode `0o600`.
- **`SSH_AUTH_SOCK`** is rejected if it contains `:` (would corrupt Docker bind spec).
- **`DOCKER_SOCKET_PATH`** env var overrides the hardcoded `/var/run/docker.sock` path (useful in tests and non-standard Docker setups).
- **Project `.claude/settings.json`** deep-merges into profile settings (project wins on conflicts) — same trust level as `claudeArgs` passthrough. Only run ccpod against repos you control.

### Testing

Tests live in `tests/unit/` and `tests/integration/`. Fixtures in `tests/fixtures/`. Unit tests use `bun:test`; `mock.module()` is used for Docker subprocess isolation in container tests.

## Commit Checklist

Before every commit:

1. **Quality gates** — `bun run typecheck && bun test tests/unit/ && bun run check` must all pass
2. **Docs** — update `CLAUDE.md`, `website/src/content/docs/reference/internals.md`, or any affected docs to reflect the change
3. **Code review** — spawn a fresh subagent (`feature-dev:code-reviewer`) to review the diff; address any real bugs or meaningful risks before committing

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

<body>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`

Example: `feat(state): replace Docker volume with host bind mount`
