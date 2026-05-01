---
title: CLI Reference
description: Every ccpod command and flag.
---

`ccpod` is a single binary. All commands accept `--help`.

## `ccpod run`

Start an interactive Claude session in the current directory (mounted at `/workspace`).

```sh
ccpod run                              # interactive session, default profile
ccpod run --profile team               # use a specific profile
ccpod run --env KEY=VALUE              # set/override an env var (repeatable)
ccpod run --rebuild                    # force image rebuild or repull
ccpod run --no-state                   # force ephemeral state for this run
ccpod run --file prompt.txt            # headless: pipe stdout/stderr, exit with container code
```

`--file` paths are normalized; absolute paths and `..` traversals are rejected.

## `ccpod init`

First-run wizard. Detects the container runtime, asks for auth method, creates the `default` profile, and pulls the base image.

```sh
ccpod init
```

Re-run later to add another profile via the wizard.

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
ccpod image build [profile]         # build from profile's dockerfile
ccpod image pull [profile]          # pull (or update) the profile's image
```

## Lifecycle commands

```sh
ccpod ps                            # list running ccpod containers (any profile/project)
ccpod down                          # stop Claude container + sidecars for $PWD
ccpod state clear [profile]         # delete persistent state volume
```

`ccpod down` matches by `ccpod.project=sha256($PWD)` label. Run it from the project directory.

## Config commands

```sh
ccpod config show                   # print resolved merged ResolvedConfig
ccpod config validate               # validate .ccpod.yml + profile without running
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
