---
title: ccpod Architecture
description: How the ccpod pipeline loads, merges, and runs a Claude Code container — from profile config to live Docker session. Covers the 8-step execution pipeline.
---

ccpod is a CLI built with [citty](https://github.com/unjs/citty) that orchestrates the official Claude Code binary inside a container. This page walks the data flow end to end.

## High-level

```
┌──────────────── Host ────────────────┐
│                                       │
│  ccpod (single binary)                │
│  ┌─────────────────────────────────┐  │
│  │ load → sync → merge → resolve   │  │
│  │      → write → spec → run       │  │
│  └────────────────┬────────────────┘  │
│                   │ ContainerSpec     │
│                   ▼                   │
│       Docker / OrbStack / Colima /    │
│       Podman (auto-detected socket)   │
│                                       │
└────────────────┬──────────────────────┘
                 │
        ┌────────▼─────────┐
        │ Claude container │  /workspace ◄── $PWD
        │                  │  /ccpod/config (ro) ◄── merged config dir
        │ exec claude      │  /ccpod/credentials (rw) ◄── auth tokens
        │                  │  /ccpod/plugins (volume)
        │                  │  /ccpod/state (host bind or tmpfs)
        └──────────────────┘
```

## The pipeline

`ccpod run` executes these steps in order:

### 1. Load

`src/config/loader.ts` reads:

- the profile at `~/.ccpod/profiles/<name>/profile.yml`
- a `.ccpod.yml` found by walking up from `$PWD`

Both pass through Zod schemas in `src/config/schema.ts`. Invalid configs fail fast.

If no profile is specified and the `default` profile doesn't exist, `ccpod run` automatically launches the setup wizard (`ccpod init`) before continuing.

### 2. Sync

`src/profile/git-sync.ts` checks the profile's `config.source`. If `git`, it pulls based on `sync` (`always`, `daily`, or `pin`) and writes a timestamp to `.ccpod-sync-lock`.

### 3. Merge

`src/config/merger.ts` combines profile + project per the documented [merge strategies](../../project-config/merge/). `CLAUDE.md` files are handled separately by `mergeClaudes()` (append vs. override).

### 4. Auth

`src/auth/resolver.ts` resolves the auth block to env vars or credential files in `~/.ccpod/credentials/<profile>/`.

### 5. Write merged config

`src/config/writer.ts` writes the merged Claude config tree to a deterministic temp dir: `/tmp/ccpod-<sha256(content)>/`. Same content → same path → skip rewrite. Mode `0o700` for dirs, `0o600` for files.

### 6. Build container spec

`src/container/builder.ts` turns the `ResolvedConfig` into a `ContainerSpec`: image, env, mounts, network, ports, tmpfs, labels. Exports `computeProjectHash($PWD)` for labels.

### 7. Sidecars

`src/container/sidecars.ts` ensures the shared network exists (`ccpod-net-<projectHash>`) and starts every declared service. All sidecars get `ccpod.project` and `ccpod.profile` labels for discovery.

### 8. Run

`src/container/runner.ts` creates / reattaches / starts the container via the `docker` CLI (`Bun.spawn`).

- TTY mode → interactive, attach raw stdin/stdout/stderr.
- Headless mode (`--file`) → pipe stdout/stderr, exit with container's status.

## Inside the container

The base image (`ghcr.io/yorch/ccpod`) ships an entrypoint that assembles `~/.claude/` at startup from four mount points:

```
/ccpod/config       → copied into ~/.claude (settings, CLAUDE.md, skills, hooks)
/ccpod/credentials  → copied (overlays config defaults if same filename)
/ccpod/plugins      → symlinked as ~/.claude/plugins
/ccpod/state        → symlinked items (history.jsonl, projects/, todos/, sessions/)
                      only when state: persistent
```

Then it delta-installs any plugins listed in `CCPOD_PLUGINS_TO_INSTALL` (the full declared `plugins:` list from the profile — entrypoint skips dirs that already exist) and `exec`s the Claude binary.

If `CCPOD_NETWORK_POLICY=restricted`, the entrypoint applies iptables OUTPUT rules (ACCEPT loopback/established/DNS + resolved allowed hosts, DROP all else) before launching Claude. The container must have `--cap-add NET_ADMIN` for this — ccpod adds it automatically when `network.policy: restricted`.

## Module map

| Path | Purpose |
|---|---|
| `src/cli/index.ts` | Citty router. |
| `src/cli/commands/*` | One file per command (`run`, `init`, `profile/*`, etc.). |
| `src/config/loader.ts` | Read profile + project config. |
| `src/config/merger.ts` | Per-asset merge strategies. |
| `src/config/writer.ts` | Write merged config to temp dir. |
| `src/config/schema.ts` | Zod schemas. |
| `src/profile/manager.ts` | CRUD for `~/.ccpod/profiles/`. |
| `src/profile/git-sync.ts` | Clone/pull git config sources. |
| `src/runtime/detector.ts` | Auto-detect runtime socket. |
| `src/runtime/docker.ts` | `dockerExec` and `dockerSpawn`. |
| `src/container/builder.ts` | Build `ContainerSpec`. |
| `src/container/runner.ts` | Create/reattach/start container. |
| `src/container/sidecars.ts` | Shared network + sidecar lifecycle. |
| `src/mcp/parser.ts` | Parse `.mcp.json`, extract HTTP/SSE ports. |
| `src/image/manager.ts` | Pull or `docker build` the image. |
| `src/auth/resolver.ts` | Resolve auth block to env/creds. |

## Container labels

All ccpod-managed containers get these labels for discovery (used by `ccpod ps` and `ccpod down`):

| Label | Value |
|---|---|
| `ccpod.profile` | profile name |
| `ccpod.project` | `sha256($PWD)`, first 16 hex chars |
| `ccpod.type` | `main` or sidecar service name |
| `ccpod.version` | ccpod binary version |

## Security invariants

- Profile names are validated by `/^[a-zA-Z0-9_-]{1,64}$/` at parse time.
- `--file` paths are rejected if absolute or starting with `..`.
- Merged config dirs are written mode `0o700`, files `0o600`.
- `SSH_AUTH_SOCK` is rejected if it contains `:`.
- `DOCKER_SOCKET_PATH` env var lets ops override the hardcoded socket path for non-standard setups.

## See also

- [Internals](../internals/) — type definitions, entrypoint assembly, full startup sequence
- [Storage Layout](../storage/)
- [CLI Reference](../cli/)
