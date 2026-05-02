---
title: Profiles
description: A profile defines the complete Claude environment for a session.
---

A **profile** is the unit of portability in ccpod. It bundles everything that defines a Claude environment:

- the container image
- auth (API key or OAuth)
- Claude config (settings, plugins, skills, `CLAUDE.md`, hooks)
- network policy
- forwarded host env vars
- sidecar services
- state mode (ephemeral or persistent)

Profiles live at `~/.ccpod/profiles/<name>/profile.yml`.

## Where Claude config comes from

A profile points at a Claude config tree using `config.source`:

- **`local`** — a directory on disk (e.g. your existing `~/.claude` or a copy you maintain).
- **`git`** — a remote git repo. ccpod clones it into `~/.ccpod/profiles/<name>/config/` and pulls based on `sync` (`always`, `daily`, or `pin`).

The cloned/local tree is what gets mounted as `/ccpod/config` (read-only) inside the container. The container entrypoint copies it into `~/.claude/` at startup, then layers credentials on top.

## Multiple profiles

Create as many as you want — one for personal work, one for a client, one shared with your team. Switch per-run with `--profile <name>` or per-project with `.ccpod.yml`'s `profile:` field.

```sh
ccpod profile list
ccpod profile create work
ccpod profile update team        # force re-pull a git config
ccpod profile delete experiment
```

## Storage layout

```
~/.ccpod/
├── profiles/
│   └── <name>/
│       ├── profile.yml          # the config
│       ├── config/              # cloned git config (if source: git)
│       └── .ccpod-sync-lock     # last git-sync timestamp
└── credentials/
    └── <name>/                  # auth tokens for this profile
```

Plus per-profile storage managed automatically:

- `ccpod-plugins-<name>` Docker volume — installed Claude plugins
- `~/.ccpod/state/<name>/` host directory — history, projects, sessions (only when `state: persistent`)

## Next: [Configuration reference](../configuration/)
