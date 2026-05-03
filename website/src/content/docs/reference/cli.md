---
title: ccpod CLI Reference
description: Complete reference for every ccpod command and flag — run, shell, init, update, profile, plugins, image, config, ps, and down.
---

`ccpod` is a single binary. All commands accept `--help`.

## `ccpod run`

Start an interactive Claude session in the current directory (mounted at `/workspace`).

```sh
ccpod run                              # interactive session, default profile
ccpod run "fix all lint errors"        # headless: inline prompt text
ccpod run --file prompt.txt            # headless: prompt from file
ccpod run --profile team               # use a specific profile
ccpod run --env KEY=VALUE              # set/override an env var (repeatable)
ccpod run --rebuild                    # force image rebuild or repull
ccpod run --no-state                   # force ephemeral state for this run
ccpod run -- --dangerously-skip-permissions   # pass flags directly to claude
```

`--file` and an inline prompt are mutually exclusive. `--file` paths are normalized; absolute paths and `..` traversals are rejected.

Everything after `--` is forwarded verbatim to the `claude` command inside the container and appended after any `claudeArgs` declared in the profile or project config.

## `ccpod shell`

Open an interactive shell in the container without starting Claude. Useful for debugging mounts, testing MCP servers, or inspecting the merged config.

```sh
ccpod shell                    # open /bin/bash in a new container
ccpod shell --profile team     # use a specific profile
ccpod shell --env KEY=VALUE    # set/override an env var
ccpod shell --no-state         # force ephemeral state
ccpod shell --rebuild          # force image rebuild or repull
```

If a container for this project/profile is already running (e.g. Claude is active), `ccpod shell` exec's into it with `docker exec -it` — giving you a second shell alongside the running session. Otherwise it starts a fresh container with `/bin/bash` as the entrypoint.

:::note
The target image must have `/bin/bash`. Alpine-based images typically only have `/bin/sh` and will fail. The official ccpod image always includes bash.
:::

## `ccpod init`

First-run setup wizard. Detects the container runtime, then offers two modes:

- **Quick** — asks for auth only; everything else (network, state, SSH, image) uses sensible defaults. Done in ~3 steps.
- **Full** — walks through all options: auth, config source, network policy, session state, SSH forwarding, and Docker image (official / custom registry / build your own).

```sh
ccpod init
ccpod init --profile team      # create a named profile
```

Re-run at any time to add another profile. The generated `profile.yml` is fully annotated — all fields can be edited by hand after setup.

## `ccpod update`

Update ccpod to the latest release.

```sh
ccpod update                   # download and replace current binary
```

Checks GitHub releases for the latest version. If permission denied, run with `sudo ccpod update`.

## Profile commands

```sh
ccpod profile create <name>         # interactive create
ccpod profile list                  # show all profiles
ccpod profile update <name>         # force-pull git config (resets sync lock)
ccpod profile delete <name>         # delete profile + its credential dir
```

## Plugin commands

```sh
ccpod plugins list [profile]        # list installed plugins in a profile's volume
ccpod plugins update [profile]      # flush + reinstall every declared plugin
```

`update` is destructive to the volume — use it when a plugin is broken or you want a clean slate.

## Image commands

```sh
ccpod image init [profile]          # download Dockerfile into profile dir for customization
ccpod image build [profile]         # build from profile's dockerfile
ccpod image pull [profile]          # pull (or update) the profile's image
```

### `ccpod image init`

Downloads the official ccpod Dockerfile to `~/.ccpod/profiles/<profile>/Dockerfile` and sets `image.dockerfile` in `profile.yml`.

**Flags:**
- `--from <url>` — download from a custom URL instead of the official Dockerfile
- `--force` — overwrite existing Dockerfile
- `--profile <name>` — target profile (defaults to current project's profile or `default`)

### `ccpod image build`

Build a local Docker image from the profile's Dockerfile.

**Flags:**
- `--apply` — update `profile.yml` `image.use` to the built tag after build
- `--dockerfile <path>` — Dockerfile path (overrides profile's `image.dockerfile`)
- `--tag <tag>` — custom image tag (overrides auto-generated `ccpod-local-<profile>-<hash>:latest`)
- `--profile <name>` — target profile (defaults to current project's profile or `default`)

After editing the Dockerfile, run `ccpod image build --apply` to build and activate it.

## Lifecycle commands

```sh
ccpod ps                            # list running ccpod containers (any profile/project)
ccpod ps --all                      # include stopped containers
ccpod down                          # stop Claude container + sidecars for $PWD
ccpod state clear [profile]         # delete persistent state directory (~/.ccpod/state/<profile>/)
```

`ccpod down` matches by `ccpod.project=sha256($PWD)` label. Run it from the project directory.

## Config commands

```sh
ccpod config show                   # print resolved merged ResolvedConfig
ccpod config validate               # validate .ccpod.yml + profile without running
ccpod config get <key>              # get a global config value
ccpod config set <key> <value>      # set a global config value
```

### `ccpod config get/set`

Reads and writes global ccpod configuration at `~/.ccpod/config.yml`.

**Known keys:**
- `autoCheckUpdates` — boolean (true/false) — whether to check for updates on startup

Example:
```sh
ccpod config get autoCheckUpdates
ccpod config set autoCheckUpdates false
```

## Global flags

| Flag | Effect |
|---|---|
| `--help` | Show help for the command. |
| `--version` | Print ccpod version. |

## Environment variables

| Var | Purpose |
|---|---|
| `DOCKER_SOCKET_PATH` | Override the auto-detected runtime socket. Useful for non-standard setups and tests. |
| `CCPOD_TEST_DIR` | Used by tests to redirect `~/.ccpod` to a temp dir. |
| Anything in your profile's `env:` list | Forwarded into the container. |
