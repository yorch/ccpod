---
title: Project Config (.ccpod.yml)
description: Add a .ccpod.yml to a repo to choose a profile and add ports, env vars, and CLAUDE.md content for that project. Project config is untrusted by default.
---

A profile is global to your machine. A **project config** lives in a repo and overlays the profile for that project. ccpod walks up from `$PWD` to find a `.ccpod.yml`, so any subdirectory of the repo works.

## Why use one

- Pin which profile this repo uses (`profile:`) — you approve this once per project.
- Expose extra ports (published on `127.0.0.1` only).
- Set extra env vars.
- Add sidecar services that only this project needs (if the profile allows it).
- Append to (or replace) `CLAUDE.md`.
- Pass extra flags to `claude` on every run (`claudeArgs`).

## What a project can't do

A `.ccpod.yml` ships with the code you are about to run in a sandbox, so it is **untrusted**. The profile owner stays in control:

- **`network:`** is profile-owned. A project's `network:` block is ignored with a warning, so a repo cannot weaken a `restricted` profile.
- **`services:`** are ignored unless the profile sets `allowProjectServices: true`; even then volumes must be named volumes and ports are loopback-only unless `allowProjectHostMounts: true`.
- **`init:`** is ignored unless the profile sets `allowProjectInit: true`.
- **`env:`** may not use `${VAR}` interpolation, may not set sensitive keys (credentials/endpoints, proxies, TLS trust, `PATH`/`LD_*`-style hijack vars, `CCPOD_*`, `DOCKER_*`), and bare names that forward a host variable are ignored unless the profile lists them in `allowProjectEnvForward`.
- **`profile:`** needs your one-time approval the first time a project picks a profile (remembered in `~/.ccpod/trusted-projects.json`); `--profile` skips the prompt.
- Symlinked `.claude/`, `CLAUDE.md` and `.claude/settings.json` are ignored, and a project's `post-init.sh` is never copied.

## Example

```yaml
# .ccpod.yml at the repo root
profile: personal              # which profile to base on
merge: deep                    # "deep" (default) | "override"

claudeArgs:
  - "--dangerously-skip-permissions"

config:
  claudeMd: append             # "append" (default) | "override"

ports:
  list:
    - "4000:4000"

env:
  - LOG_LEVEL=debug

# Only honored if the profile sets allowProjectServices: true
services:
  redis:
    image: redis:7
    ports:
      - "6379:6379"
```

## Schema

| Field | Type | Notes |
|---|---|---|
| `profile` | string | Which profile to use. Falls back to `default`. |
| `merge` | `deep` \| `override` | How to combine ccpod settings with the profile. `deep` (default): project adds to/appends profile values. `override`: project sections fully replace the profile's (omitted fields revert to schema defaults). See [Merge Strategies](../merge/). |
| `claudeArgs` | string[] | Extra CLI flags passed to `claude`. Deep: appended after profile args. Override: replaces. |
| `init` | string[] | Shell commands run in `/workspace` as `node` before Claude starts. Deep: appended after profile commands. Override: replaces. Ignored when profile has `isolation: true`. |
| `config.claudeMd` | `append` \| `override` | How to combine `CLAUDE.md` files. |
| `network` | — | Not honored. Network policy is profile-owned; a project `network:` block is ignored with a warning. See [Network Policy](../../features/network/). |
| `ports` | object | Extra port mappings (`list`, `autoDetectMcp`). |
| `services` | object | Extra sidecars; merged by key. **Ignored unless the profile sets `allowProjectServices: true`.** |
| `env` | string[] | Extra env entries. Each is `KEY=value` (literal), or a bare `KEY` (forward host var — **ignored unless the profile lists `KEY` in `allowProjectEnvForward`**). Unlike profile and `--env`, project entries may **not** use `${VAR}` interpolation — a malicious project repo could otherwise exfiltrate host secrets. See [profile env reference](../../profiles/configuration/#env). |

> **Note:** If the profile has [`isolation: true`](../../profiles/configuration/#isolation), this entire file is ignored — the profile config is used as-is regardless of what `.ccpod.yml` contains.

## Inspecting the result

```sh
ccpod config show              # print resolved merged config
ccpod config validate          # validate without running
```

`ccpod config show` is the source of truth — what you see is what `ccpod run` will use, including which project entries were ignored.
