---
title: Project Config (.ccpod.yml)
description: Overlay a profile per repository.
---

A profile is global to your machine. A **project config** lives in a repo and overlays the profile for that project. ccpod walks up from `$PWD` to find a `.ccpod.yml`, so any subdirectory of the repo works.

## Why use one

- Pin which profile this repo uses (`profile:`).
- Add domains to a restricted network policy.
- Expose extra ports.
- Forward extra env vars.
- Add sidecar services that only this project needs.
- Append to (or replace) `CLAUDE.md`.
- Pass extra flags to `claude` on every run (`claudeArgs`).

## Example

```yaml
# .ccpod.yml at the repo root
profile: personal              # which profile to base on
merge: deep                    # "deep" (default) | "override"

claudeArgs:
  - "--dangerously-skip-permissions"

config:
  claudeMd: append             # "append" (default) | "override"

network:
  policy: restricted
  allow:
    - api.github.com
    - registry.npmjs.org

ports:
  list:
    - "4000:4000"

env:
  - STRIPE_SECRET_KEY

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
| `network` | partial network block | Adds to (or replaces) the profile's network config. |
| `ports` | object | Extra port mappings (`list`, `autoDetectMcp`). |
| `services` | object | Extra sidecars; merged by key. |
| `env` | string[] | Extra env-var names to forward. |

> **Note:** If the profile has [`isolation: true`](../profiles/configuration/#isolation), this entire file is ignored — the profile config is used as-is regardless of what `.ccpod.yml` contains.

## Inspecting the result

```sh
ccpod config show              # print resolved merged config
ccpod config validate          # validate without running
```

`ccpod config show` is the source of truth — what you see is what `ccpod run` will use.
