---
title: Quick Start
description: Set up ccpod and run your first Claude session in under five minutes.
---

This guide gets you from a fresh install to an interactive Claude session in your project.

## 1. Run the wizard

```sh
ccpod init
```

The wizard:

- Detects your container runtime (Docker / OrbStack / Colima / Podman)
- Asks for your auth method (API key or OAuth)
- Creates a `default` profile at `~/.ccpod/profiles/default/profile.yml`
- Pulls the base image `ghcr.io/yorch/ccpod:latest`

You can re-run `ccpod init` later to add another profile.

## 2. Start a session

```sh
cd path/to/your/project
ccpod run
```

The current directory is mounted at `/workspace` inside the container. Claude starts there. Exit the session and the container shuts down (state is wiped unless your profile sets `state: persistent`).

## 3. Pass arguments through to Claude

Anything after `--` is forwarded:

```sh
ccpod run -- --resume       # Resume the last Claude session
ccpod run -- "Refactor src/auth.ts"   # Headless: run a single prompt
```

## 4. Use a different profile

```sh
ccpod run --profile team
```

Or pin a profile to a project by adding `.ccpod.yml`:

```yaml
# .ccpod.yml
profile: team
```

ccpod walks up from `$PWD` to find this file, so any subdirectory of the repo works.

## 5. Headless mode

Pipe a prompt file and exit with the container's status code:

```sh
ccpod run --file prompt.txt
```

Useful in CI for "review this diff" or "summarize these docs" automations.

## What's next

- [Profiles](/ccpod/profiles/overview/) — the unit of portability.
- [Project config](/ccpod/project-config/overview/) — overlay a profile per repo.
- [State persistence](/ccpod/features/state/) — keep history between sessions.
- [CLI reference](/ccpod/reference/cli/) — every command and flag.
