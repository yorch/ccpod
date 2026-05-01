---
title: State Persistence
description: Choose between ephemeral and persistent Claude state.
---

Claude Code keeps history, projects, todos, and sessions in `~/.claude/`. ccpod treats that data as **state** and lets you choose how it lives across runs.

## Modes

| Mode | Storage | Survives container exit? | Survives host reboot? |
|---|---|---|---|
| `ephemeral` *(default)* | tmpfs inside the container | No | No |
| `persistent` | `~/.ccpod/state/<profile>/` on the host | Yes | Yes |

Configure in the profile:

```yaml
state: persistent
```

Override for a single run:

```sh
ccpod run --no-state           # force ephemeral, regardless of profile
```

## What's persisted

When `state: persistent`, the entrypoint symlinks these into the volume:

- `history.jsonl`
- `projects/`
- `todos/`
- `sessions/`

Settings, plugins, skills, `CLAUDE.md`, and credentials are *not* in this volume — they come from the merged config and credential mounts, so they regenerate cleanly on every run.

## Resetting

To wipe the state directory for a profile:

```sh
ccpod state clear              # current profile
ccpod state clear team         # specific profile
```

This deletes `~/.ccpod/state/<profile>/`. The next `ccpod run` recreates it empty.

## When to choose which

- **Ephemeral** is the right default. Sessions are reproducible from the merged config alone.
- **Persistent** when you want long-running memory: continued sessions across days, accumulated todos, or session resume across restarts.

For shared / open-source profiles, prefer ephemeral so contributors aren't surprised by stale state.
