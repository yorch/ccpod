---
title: Shared Team Profile
description: Sync a profile from a git repo so your whole team gets the same Claude environment.
---

The most common reason teams adopt ccpod is to align on a single Claude environment. The fix is a profile with `config.source: git` plus an optional `ccpod-overlay.yml` in the synced repo.

## What syncs from a git config repo

A `config.source: git` repo always provides the **Claude config tree** — `settings.json`, `CLAUDE.md`, `skills/`, `hooks/`, `agents/`. That's the part stored in `~/.claude/` on a normal install.

The repo can also include a top-level **`ccpod-overlay.yml`** that contributes operational fields back into the local profile: `image`, `plugins`, `services`, `network`, `permissions`, `env`, `claudeArgs`, `init`, `ports`, `ssh`. This closes the gap that used to exist where every teammate had to maintain their own copy of `plugins:`, `services:`, etc.

What stays local on each machine: `auth` (per-user keys), `name`, `state`, and the `config:` block itself.

## 1. Put your Claude config in a repo

Create a repo with the contents of a Claude config dir at the root, plus an optional `ccpod-overlay.yml` for shared operational fields:

```
your-org/claude-config
├── settings.json
├── CLAUDE.md
├── ccpod-overlay.yml      # optional: plugins, image, services, network, etc.
├── skills/
│   └── ...
└── hooks/
    └── ...
```

Push it. Make sure teammates have read access.

A typical `ccpod-overlay.yml`:

```yaml
image:
  use: ghcr.io/your-org/claude-base:1.4.0   # team-wide pinned image

plugins:
  - mcp-server-filesystem
  - your-org/team-mcp

permissions: moderate

network:
  policy: restricted
  allow:
    - api.github.com
    - registry.npmjs.org

services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: dev
```

The overlay applies on every `ccpod run` after the config repo syncs, so updates to plugins or the pinned image flow to the team without anyone editing their local `profile.yml`.

## 2. Define the profile

Each teammate runs:

```sh
ccpod profile create team
```

…and edits `~/.ccpod/profiles/team/profile.yml`:

```yaml
name: team
description: Shared team Claude environment

config:
  source: git
  repo: https://github.com/your-org/claude-config
  sync: daily         # "always" | "daily" | "pin"
  ref: main

image:
  use: ghcr.io/yorch/ccpod:latest

auth:
  type: api-key
  keyEnv: ANTHROPIC_API_KEY
```

## 3. Use it

```sh
ccpod run --profile team
```

…or pin it per project with `.ccpod.yml`:

```yaml
profile: team
```

## How sync works

| `sync` | Behavior |
|---|---|
| `always` | Pull on every `ccpod run`. |
| `daily` *(default)* | Pull at most once per 24h. Tracked in `~/.ccpod/profiles/team/.ccpod-sync-lock`. |
| `pin` | Never auto-pull. Use `ccpod profile update team` to force. |

To force an update at any time:

```sh
ccpod profile update team
```

## Layered overrides

A team profile is a baseline. Individuals can:

- override per project via `.ccpod.yml` (deep-merge by default — see [Merge Strategies](../../project-config/merge/))
- override per run via flags like `--env`, `--no-state`, `--rebuild`
- opt out of the overlay entirely by setting `config.overlay: false` in their local `profile.yml`

Profiles stay clean; project- and run-level overrides do *not* mutate the profile file.

## Overlay merge rules

When a `ccpod-overlay.yml` is present and `config.overlay` is on (default), it merges into the local profile with these rules:

| Field | Behaviour |
|---|---|
| `plugins` | Union with local list, deduped |
| `services` | Merged by key, overlay wins on conflict |
| `network` | `policy` overrides local; `allow` lists union+dedupe |
| `image` | Overlay fields override local (per-key) |
| `permissions` | Overlay overrides if set |
| `ssh`, `ports.autoDetectMcp` | Overlay overrides per-key if set |
| `claudeArgs`, `init`, `env`, `ports.list` | Concatenated; overlay appended |

Fields that **never** sync from the overlay: `auth`, `name`, `state`, `config`, `isolation`, `description`. These stay strictly local.

## Trust model

An overlay can change `image`, `network.policy`, `init` (host-shell commands run inside the container), `services` (sidecar containers), and `permissions`. That is strictly more power than `settings.json` or `CLAUDE.md` alone — those couldn't pin a different base image, open the network, or run init commands.

In practical terms: **only enable `config.overlay` on repos you fully trust.** A malicious overlay could swap your base image, disable the restricted-network allow-list, or run arbitrary shell during `init`. This is the same trust level as installing a profile from someone else, just continuously refreshed. Set `config.overlay: false` in your local `profile.yml` to opt out while still syncing the Claude config tree.
