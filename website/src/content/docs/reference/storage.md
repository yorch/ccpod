---
title: Storage Layout
description: Where ccpod keeps profiles, credentials, and Docker volumes.
---

ccpod stores everything under `~/.ccpod/` plus a small set of Docker named volumes. There is no global database, no daemon, no hidden state.

## Host filesystem

```
~/.ccpod/
├── profiles/
│   ├── default/
│   │   ├── profile.yml             # the profile definition
│   │   ├── .ccpod-sync-lock        # last git-sync timestamp (if source: git)
│   │   └── config/                 # cloned Claude config (only if source: git)
│   └── team/
│       └── profile.yml
└── credentials/
    ├── default/                    # auth tokens for "default" profile
    └── team/                       # auth tokens for "team" profile
```

In tests this can be redirected with `CCPOD_TEST_DIR`.

## Docker named volumes

| Name | Purpose | Lifetime |
|---|---|---|
| `ccpod-plugins-<profile>` | Installed Claude plugins | Persists across runs; recreated by `ccpod plugins update` |
| `ccpod-state-<profile>` | History, projects, todos, sessions | Persists across runs; only created when `state: persistent`; wiped by `ccpod state clear` |

Plus per-project networks for sidecars: `ccpod-net-<sha256($PWD)>`.

## Container mounts

Inside a Claude container:

| Mount | Source | Mode |
|---|---|---|
| `/workspace` | `$PWD` on host | rw bind |
| `/ccpod/config` | `/tmp/ccpod-<hash>/` (merged config) | ro bind |
| `/ccpod/credentials` | `~/.ccpod/credentials/<profile>/` | rw bind |
| `/ccpod/plugins` | `ccpod-plugins-<profile>` | volume |
| `/ccpod/state` | `ccpod-state-<profile>` *or* tmpfs | volume / tmpfs |

## Project files

Two files in your repo control behavior:

| File | Purpose |
|---|---|
| `.ccpod.yml` | Project config — overlays the profile. ccpod walks up from `$PWD` to find it. |
| `.mcp.json` | Standard Claude MCP config; ccpod auto-exposes HTTP/SSE ports if `ports.autoDetectMcp: true`. |

Both are optional.
