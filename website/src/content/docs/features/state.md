---
title: State Persistence
description: Choose between ephemeral and persistent Claude state.
---

Claude Code keeps projects, todos, and feature-flag state under `~/.claude/`. ccpod treats that data as **state** and lets you choose how it lives across runs.

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

- `projects/`
- `todos/`
- `statsig/`

Settings, plugins, skills, `CLAUDE.md`, and credentials are *not* in this volume — they come from the merged config and credential mounts, so they regenerate cleanly on every run.

## Resetting

To wipe the state directory for a profile:

```sh
ccpod state clear              # current profile (current project only if per-project isolation)
ccpod state clear team         # specific profile
ccpod state clear --all        # all projects for the profile (per-project isolation)
```

This deletes the relevant state directory. The next `ccpod run` recreates it empty.

## Per-project isolation

By default, all projects using the same profile share a single state directory (`~/.ccpod/state/<profile>/`). This means conversation history, todos, and project metadata are visible across projects.

When this is undesirable — for example, using the same profile for both trusted and untrusted repos — enable per-project isolation:

```yaml
state: persistent
stateIsolation: per-project
```

Each project gets its own state directory at `~/.ccpod/state/<profile>/<projectHash>/`, where `<projectHash>` is derived from the project path. State from one project is not visible to another.

Orphaned per-project state dirs (projects with no remaining containers) can be cleaned with `ccpod prune`.

## When to choose which

- **Ephemeral** is the right default. Sessions are reproducible from the merged config alone.
- **Persistent** when you want long-running memory: continued sessions across days, accumulated todos, or session resume across restarts.
- **Per-project isolation** when using the same profile across projects with different trust levels, to prevent cross-project state leakage.

For shared / open-source profiles, prefer ephemeral so contributors aren't surprised by stale state.
