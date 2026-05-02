---
title: Shared Team Profile
description: Sync a profile from a git repo so your whole team gets the same Claude environment.
---

The most common reason teams adopt ccpod is to align on a single Claude environment. The fix is a profile with `config.source: git`.

## 1. Put your Claude config in a repo

Create a repo with the contents of a Claude config dir at the root:

```
your-org/claude-config
├── settings.json
├── CLAUDE.md
├── skills/
│   └── ...
└── hooks/
    └── ...
```

Push it. Make sure teammates have read access.

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

- override per project via `.ccpod.yml` (deep-merge by default — see [Merge Strategies](/project-config/merge/))
- override per run via flags like `--env`, `--no-state`, `--rebuild`

Profiles stay clean; project- and run-level overrides do *not* mutate the profile file.
