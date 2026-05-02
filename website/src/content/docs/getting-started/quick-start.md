---
title: Quick Start — Run Claude Code in Docker
description: Set up ccpod and run your first Claude Code session in a Docker container in under five minutes. Init wizard, profile creation, and headless mode.
---

This guide gets you from a fresh install to an interactive Claude session in your project.

## 1. Run the wizard

```sh
ccpod init
```

The wizard first asks which mode you want:

- **Quick** — auth only, sensible defaults for everything else. Done in ~3 steps.
- **Full** — also configures network policy, session state, SSH, and Docker image.

Both modes:
- Detect your container runtime (Docker / OrbStack / Colima / Podman)
- Ask for your auth method — if `ANTHROPIC_API_KEY` is already set in your environment, or you have an existing profile, those are offered as first choices so you don't have to retype anything
- Create a `default` profile at `~/.ccpod/profiles/default/profile.yml`

The base image is pulled automatically on first `ccpod run`.

You can re-run `ccpod init` later to add another profile.

## 2. Start a session

```sh
cd path/to/your/project
ccpod run
```

The current directory is mounted at `/workspace` inside the container. Claude starts there. Exit the session and the container shuts down (state is wiped unless your profile sets `state: persistent`).

> **Tip:** If you skip `ccpod init`, running `ccpod run` from any directory automatically launches the wizard when no `default` profile exists.

## 3. Use a different profile

```sh
ccpod run --profile team
```

Or pin a profile to a project by adding `.ccpod.yml`:

```yaml
# .ccpod.yml
profile: team
```

ccpod walks up from `$PWD` to find this file, so any subdirectory of the repo works.

## 4. Headless mode

Pipe a prompt file and exit with the container's status code:

```sh
ccpod run --file prompt.txt
```

Useful in CI for "review this diff" or "summarize these docs" automations.

## What's next

- [Profiles](../../profiles/overview/) — the unit of portability.
- [Project config](../../project-config/overview/) — overlay a profile per repo.
- [State persistence](../../features/state/) — keep history between sessions.
- [CLI reference](../../reference/cli/) — every command and flag.
