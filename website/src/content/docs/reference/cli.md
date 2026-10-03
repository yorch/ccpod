---
title: "CLI Reference: Every Command and Flag"
description: Complete reference for every ccpod command and flag — run, shell, exec, doctor, init, update, profile, plugins, image, config, ps, down, prune, and state.
---

`ccpod` is a single binary. All commands accept `--help`.

Profile selection is uniform: commands that act on a profile take `--profile <name>` (default: the project's `.ccpod.yml` `profile:`, else `default`), except the `ccpod profile …` management commands, which take the profile name as an argument. Passing a stray positional to a command that does not accept one is an error rather than being silently ignored. Confirmation prompts can be skipped with `--force` or `--yes` (`-y`) wherever they exist.

## `ccpod run`

Start an interactive Claude session in the current directory (mounted at `/workspace`), or run a single headless prompt.

```sh
ccpod run                              # interactive session, default profile
ccpod run "fix all lint errors"        # headless: inline prompt text
ccpod run --file prompt.txt            # headless: prompt read from a file
ccpod run --profile team               # use a specific profile
ccpod run --env KEY=VALUE              # set/override an env var (repeatable)
ccpod run --rebuild                    # force image rebuild or repull
ccpod run --no-state                   # force ephemeral state for this run
ccpod run --resume <session-id>        # resume a previous Claude session
ccpod run -- --dangerously-skip-permissions   # pass flags directly to claude
```

### Headless mode

An inline prompt or `--file` starts a non-interactive run: ccpod reads the prompt (for `--file`, from the host, relative to the project directory — absolute paths and `..` are rejected, max 100,000 bytes) and runs `claude -p "<prompt>"`, streaming Claude's output to stdout. Flags after `--` are forwarded too, so `ccpod run --file task.md -- --output-format json` works for CI. Headless runs need working auth up front (an API key, a saved OAuth login, or host OAuth credentials for `auth.type: proxy`) because there is no prompt to recover from a missing one. `--file` and an inline prompt are mutually exclusive.

Everything after `--` is forwarded verbatim to the `claude` command inside the container and appended after any `claudeArgs` declared in the profile or project config.

### Reattaching

Running `ccpod run` again for a project whose container is still running reattaches to it. With `auth.type: proxy` this is refused: the container's auth proxy belongs to the `ccpod run` process that started it, so run `ccpod down` first. Detaching (Ctrl-P Ctrl-Q) from a proxy-mode session leaves a container that can no longer reach the API; ccpod warns when that happens.

### Resuming sessions

When an interactive session ends, ccpod prints:

```
To resume a session: ccpod run --resume <session-id>
```

Copy the session ID from Claude's exit output and pass it to `--resume`. Session files are only preserved when the profile uses `state: persistent` — resuming after an ephemeral run will not find the prior session.

## `ccpod shell`

Open an interactive shell in the container without starting Claude. Useful for debugging mounts, testing MCP servers, or inspecting the merged config.

```sh
ccpod shell                    # open /bin/bash
ccpod shell --profile team     # use a specific profile
ccpod shell --env KEY=VALUE    # set/override an env var
ccpod shell --no-state         # force ephemeral state
ccpod shell --rebuild          # force image rebuild or repull
```

If a container for this project/profile is already running (e.g. Claude is active), `ccpod shell` exec's into it with `docker exec -it` — a second shell alongside the running session. Otherwise it starts a separate `ccpod-<profile>-<hash>-shell` container (so `ccpod run` never attaches to a bash session). The shell container does not publish the project's ports.

:::note
The target image must have `/bin/bash`. Alpine-based images typically only have `/bin/sh` and will fail. The official ccpod image always includes bash.
:::

## `ccpod exec`

Run a one-off command in the project container and exit with its status — the non-interactive sibling of `ccpod shell`.

```sh
ccpod exec -- ls -la /workspace
ccpod exec --profile team -- npm test
ccpod exec -- cat /workspace/package.json | jq .name   # stdout stays clean for piping
```

Everything after `--` is the command. It uses the same container selection as `ccpod shell` (exec into the running container, else a separate `-shell` container); flags are `--profile`, `--env`, `--rebuild`, and `--no-state`. Setup progress is printed to stderr so stdout contains only the command's output. The command runs as the `node` user. `--env`, `--no-state` and `--rebuild` only take effect when a new container is started; if ccpod attaches to one that is already running it warns that they were ignored.

## `ccpod doctor`

Check that everything `ccpod run` needs is in place: container runtime and daemon, project and profile config validity, auth, the image, and git config sync freshness. Exits non-zero if any check fails.

```sh
ccpod doctor
ccpod doctor --profile team
```

## `ccpod init`

First-run setup wizard. Detects the container runtime, then offers two modes:

- **Quick** — asks for auth only; everything else (network, state, SSH, image) uses sensible defaults. Done in ~3 steps.
- **Full** — walks through all options: auth, config source, network policy, session state, SSH forwarding, and Docker image (official / custom registry / build your own).

```sh
ccpod init
ccpod init --profile team      # create a named profile
```

Re-run at any time to add another profile. The generated `profile.yml` is fully annotated — all fields can be edited by hand after setup (or with `ccpod profile edit`).

## `ccpod update`

Update ccpod to the latest release.

```sh
ccpod update                   # download, verify (SHA-256) and replace the current binary
```

Checks GitHub releases for the latest version. If permission denied, run with `sudo ccpod update`.

## Profile commands

```sh
ccpod profile create <name>         # interactive create
ccpod profile list [--json]         # show all profiles
ccpod profile edit <name>           # edit profile.yml in $EDITOR, validated before saving
ccpod profile update <name>         # force-pull git config (resets sync lock)
ccpod profile delete <name>         # delete config, credentials, state and plugins volume
ccpod profile install <source>      # install a profile from git, URL, file, or base64
ccpod profile export <name>         # print base64-encoded profile for sharing
```

### `ccpod profile edit <name>`

Opens `profile.yml` in `$VISUAL` / `$EDITOR` (default `vi`) on a private copy. The real file is replaced only if the result parses, passes validation, and keeps the same `name`; otherwise you can re-edit or discard.

### `ccpod profile delete <name>`

Removes `~/.ccpod/profiles/<name>/`, `~/.ccpod/credentials/<name>/`, `~/.ccpod/state/<name>/` and the `ccpod-plugins-<name>` volume. Refuses while the profile has running containers (`ccpod down --profile <name>` first). Prompts for confirmation unless `--force` / `--yes` is given.

### `ccpod profile install <source>`

Installs a profile from any source — auto-detected:

| Input | Detected as |
|-------|-------------|
| `https://github.com/...`, `https://gitlab.com/...`, `https://bitbucket.org/...`, any `http(s)://...` ending in `*.git`, `git@...`, `git://...`, or `ssh://...` | Git repo (clones, reads `profile.yml` at root) |
| `https://...` (other) | Raw URL fetch |
| `/path/...`, `./path/...`, `~/...` | Local file |
| Anything else | Base64-encoded profile string |

Git and URL sources ask for confirmation before fetching. After parsing, ccpod lists anything notable the profile enables — init commands, sidecar images, a `~/.ssh` mount, unrestricted network, `allowProject*` trust flags — and asks you to confirm before writing it. `--yes` (`-y`) skips both prompts. If a profile with the same name already exists, you're prompted to overwrite, rename, or cancel.

### `ccpod profile export <name>`

Prints a base64-encoded string of the profile to stdout. Pipe it anywhere:

```bash
ccpod profile export myprofile | pbcopy   # copy to clipboard
ccpod profile export myprofile > shared.txt
```

To install from the string on another machine:
```bash
ccpod profile install <paste-string-here>
```

## Plugin commands

```sh
ccpod plugins list [--profile <name>] [--json]   # list plugins in a profile's volume
ccpod plugins update --reset [--profile <name>]  # remove the plugins volume (reinstalled on next run)
```

`plugins update` does nothing without `--reset`; with it, the volume is removed and every plugin listed under `plugins:` in the profile is reinstalled on the next `ccpod run`.

## Image commands

```sh
ccpod image init [--profile <name>]    # download Dockerfile into profile dir for customization
ccpod image build [--profile <name>]   # build from profile's dockerfile
ccpod image pull [--profile <name>]    # pull (or update) the profile's image
```

### `ccpod image init`

Downloads the official ccpod Dockerfile to `~/.ccpod/profiles/<profile>/Dockerfile` and sets `image.dockerfile` in `profile.yml`.

**Flags:**
- `--from <url>` — download from a custom URL instead of the official Dockerfile
- `--force` — overwrite existing Dockerfile
- `--profile <name>` — target profile (defaults to current project's profile or `default`)

### `ccpod image build`

Build a local Docker image from the profile's Dockerfile. A relative `image.dockerfile` is resolved against the profile directory (never the project); `--dockerfile` paths are relative to the current directory.

**Flags:**
- `--apply` — update `profile.yml` `image.use` to the built tag after build
- `--dockerfile <path>` — Dockerfile path (overrides profile's `image.dockerfile`)
- `--tag <tag>` — custom image tag (overrides auto-generated `ccpod-local-<profile>-<hash>:latest`)
- `--profile <name>` — target profile (defaults to current project's profile or `default`)

After editing the Dockerfile, run `ccpod image build --apply` to build and activate it.

### `ccpod image pull`

**Flags:**
- `--force` — re-pull even if the image already exists
- `--profile <name>` — target profile

## Lifecycle commands

```sh
ccpod ps [--all] [--profile <name>] [--json]   # list ccpod containers
ccpod down [--all] [--profile <name>]          # stop + remove containers (and sidecars)
ccpod prune [--dry-run] [--force] [--profile <name>]
ccpod state clear [--profile <name>] [--all] [--force]
```

### `ccpod ps`

Lists ccpod containers (running only by default). `--all` includes stopped ones, `--profile` filters, and `--json` prints a machine-readable array.

### `ccpod down`

Stops and removes the containers for the current project (matched by the `ccpod.project=sha256($PWD)` label; run it from the project directory). `--all` targets every project on this machine; `--profile <name>` narrows either form to one profile.

### `ccpod prune`

Garbage-collects ccpod leftovers:

- stopped ccpod containers;
- orphaned `ccpod-net-*` sidecar networks (skipped when `--profile` is given — networks are per project);
- unreferenced `ccpod-plugins-<profile>` volumes (profile gone from disk, or `--profile` given);
- per-project state directories whose project directory no longer exists. Each state dir records its project path in a `.ccpod-project` marker; dirs without one (from older versions) are kept.

**Flags:**
- `--dry-run` — show what would be removed
- `--force` / `--yes` — skip confirmation prompts for volumes and state dirs
- `--profile <name>` — restrict to one profile

### `ccpod state clear`

Deletes the persistent state directory: `~/.ccpod/state/<profile>/` (or only the current project's subdirectory when the profile uses `stateIsolation: per-project`; `--all` clears every project). Refuses while a container is running, and also when Docker cannot be reached (it will not delete state it cannot prove is idle).

**Flags:**
- `--profile <name>` — target profile
- `--all` — clear all projects' state for the profile
- `--force` / `--yes` — skip the confirmation prompt

## Config commands

```sh
ccpod config show [--json] [--profile <name>]   # print the effective merged config
ccpod config validate [--profile <name>]        # validate .ccpod.yml + profile without running
ccpod config get <key>                          # get a global config value
ccpod config set <key> <value>                  # set a global config value
```

### `ccpod config show`

Prints the merged result for the current directory: auth, image, network, ports, services, init, plugins, claudeArgs, isolation, permissions, the `allowProject*` flags, and env (keys only; project bare names the profile has not allowed are marked as ignored), followed by a CLAUDE.md preview. `--json` emits the same data as JSON.

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
| `DOCKER_HOST` | Honored when set (including remote `tcp://` / `ssh://` hosts and an existing `unix://` socket). Otherwise ccpod auto-detects OrbStack, Docker (including rootless), Colima, or Podman. |
| `DOCKER_SOCKET_PATH` | Override the default `/var/run/docker.sock` candidate during auto-detection. Useful for non-standard setups and tests. |
| `CCPOD_INSTALL_SKIP_VERIFY` | `install.sh` only: proceed even if the download's checksum cannot be verified. |
| `CCPOD_TEST_DIR` | Used by tests to redirect `~/.ccpod` to a temp dir. |
| Anything in your profile's `env:` list | Forwarded into the container. |
