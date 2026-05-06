---
title: Profile Configuration
description: Every field in profile.yml, with defaults and examples.
---

A profile is a YAML file at `~/.ccpod/profiles/<name>/profile.yml`. ccpod validates it with [Zod](https://zod.dev) at load time — invalid files fail fast with a readable error.

## Full example

```yaml
name: personal
description: My personal Claude environment

config:
  source: local                 # "local" | "git"
  path: ~/.my-claude-config     # local path to config dir
  # source: git
  # repo: https://github.com/org/claude-config
  # sync: daily                 # "always" | "daily" | "pin"
  # ref: main

image:
  use: ghcr.io/yorch/ccpod:latest
  # use: build
  # dockerfile: "{{profile_dir}}/Dockerfile"

auth:
  type: api-key                 # "api-key" | "oauth"
  keyEnv: ANTHROPIC_API_KEY     # env var to read from
  # keyFile: /run/secrets/api-key

state: ephemeral                # "ephemeral" (default) | "persistent"

ssh:
  agentForward: true            # forward SSH_AUTH_SOCK
  mountSshDir: false            # mount ~/.ssh read-only

network:
  policy: full                  # "full" | "restricted"
  allow: []                     # domains/IPs allowed in restricted mode

ports:
  list:
    - "3000:3000"               # host:container
  autoDetectMcp: true           # expose HTTP/SSE MCP ports from .mcp.json

plugins:
  - mcp-server-brave-search     # delta-installed on first run

env:
  - DATABASE_URL                # host env vars to forward

services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: dev
    volumes:
      - ccpod-pg-data:/var/lib/postgresql/data
```

## Field reference

### `name` *(required)*

`/^[a-zA-Z0-9_-]{1,64}$/`. Used as a directory name and Docker label. Validated at parse time.

### `config` *(required)*

| Field | Type | Notes |
|---|---|---|
| `source` | `local` \| `git` | Where to read the Claude config tree. |
| `path` | string | Required when `source: local`. Tilde-expanded. |
| `repo` | string | Required when `source: git`. HTTPS or SSH URL. |
| `sync` | `always` \| `daily` \| `pin` | When to refresh the clone. `pin` never re-pulls. |
| `ref` | string | Branch, tag, or commit to check out. Defaults to remote HEAD. |

### `image` *(required)*

| Field | Type | Notes |
|---|---|---|
| `use` | string | Image reference (e.g. `ghcr.io/yorch/ccpod:latest`) or the literal `build`. |
| `dockerfile` | string | Required when `use: build`. Absolute path, path relative to `$PWD`, or `{{profile_dir}}/Dockerfile` to reference a Dockerfile inside the profile directory. |

When `use: build`, both `ccpod run` and `ccpod image build` use the same tag `ccpod-local-<profile>-<hash>:latest` (hash derived from Dockerfile contents). Running `ccpod image build` pre-builds the image so `ccpod run` reuses it without rebuilding. Override the tag with `--tag`. Force a rebuild with `ccpod run --rebuild`.

### `auth` *(required)*

| Field | Type | Notes |
|---|---|---|
| `type` | `api-key` \| `oauth` | |
| `keyEnv` | string | Env var name to read on the host (`api-key` only). |
| `keyFile` | string | File on the host to read (`api-key` only). |

For `oauth`, ccpod manages tokens in `~/.ccpod/credentials/<name>/`.

### `state`

`ephemeral` (default) wipes Claude history and session state when the container exits. `persistent` binds `~/.ccpod/state/<name>/` on the host into the container — history, projects, and todos survive across runs. Override per run with `--no-state`.

### `plugins`

A list of Claude Code plugin names to install on first run. ccpod passes them to the container entrypoint, which delta-installs only the ones not already present — subsequent runs are fast.

```yaml
plugins:
  - mcp-server-brave-search
  - mcp-server-filesystem
```

### `ssh`

| Field | Default | Notes |
|---|---|---|
| `agentForward` | `true` | Forwards `SSH_AUTH_SOCK` into the container. Rejected if the value contains `:`. Not supported with Podman (skipped with a warning). |
| `mountSshDir` | `false` | Mounts `~/.ssh` read-only. |

### `network`

| Field | Notes |
|---|---|
| `policy` | `full` (bridge with internet) or `restricted` (allow-list only). |
| `allow` | Hostnames/IPs to allow in restricted mode. Resolved at container start. |

See [Network Policy](../../features/network/).

### `ports`

| Field | Notes |
|---|---|
| `list` | Manual `host:container` mappings. |
| `autoDetectMcp` | Default `true`. If `.mcp.json` exists at `$PWD`, HTTP/SSE MCP ports are exposed automatically. |

### `env`

A list of env-var **names** on the host. ccpod forwards their values into the container. Names only — never values. To set a literal, use `ccpod run --env KEY=VALUE`.

### `claudeArgs`

A list of extra CLI flags passed verbatim to the `claude` command on every run. These are appended before any `claudeArgs` in the project config.

```yaml
claudeArgs:
  - "--dangerously-skip-permissions"
```

### `init`

A list of shell commands run inside the container as the `node` user in `/workspace` after config is seeded and before Claude starts. Commands execute with `set -e` (exit on error).

```yaml
init:
  - npm install
  - git config --global user.email "dev@example.com"
```

Merge behaviour: in `deep` mode (default) profile commands run first, project commands appended. In `override` mode, project commands replace profile commands entirely. When `isolation: true`, project `init` is ignored.

### `isolation`

Default `false`. When `true`, the profile ignores **all** project-level config for this run:

- `.ccpod.yml` settings (network, claudeArgs, services, env, ports, merge strategy)
- Project `CLAUDE.md`
- Project `.claude/settings.json` and other `.claude/` assets
- Project `.mcp.json` (MCP port auto-detection)

The profile config is used as-is. Useful for security-sensitive profiles where you want a guaranteed, unmodifiable environment regardless of the repo being run.

```yaml
isolation: true
```

> **Note:** `isolation` does not prevent profile selection — a project's `.ccpod.yml` can still specify `profile: my-isolated-profile` to opt into it. CLI flags (`--no-state`, `--env`, `--rebuild`) continue to work.

### `permissions`

Default: none (no preset injected). Sets a Claude Code `permissions.allow` preset as the lowest-priority layer — your profile and project `settings.json` always override it.

| Preset | Effect |
|--------|--------|
| `conservative` | Auto-allow `Edit` and `Write` — file edits skip prompts, `Bash` still prompts |
| `moderate` | Auto-allow `Bash`, `Edit`, `Write` — no prompts for typical dev work |
| `permissive` | Sets `defaultMode: bypassPermissions` — skips all prompts (Docker is the trust boundary) |

```yaml
permissions: moderate
```

`Read`, `Glob`, and `Grep` require no permission in Claude Code and are always free — no need to list them. `permissive` uses Claude Code's `bypassPermissions` mode rather than listing individual tools, so it covers all current and future tools automatically.

The preset is injected as the lowest-priority layer. If your profile or project `settings.json` already sets `permissions.allow`, those entries are unioned with the preset (deduplicated). Explicit entries always survive.

:::note
Without a preset, Claude Code uses its own defaults — which means permission prompts for most tool calls. Set `moderate` to eliminate prompt fatigue during typical development sessions inside a container.
:::

### `services`

Sidecar containers (Postgres, Redis, queues, anything with a Docker image). Reachable from the Claude container by service name on a shared network. See [Sidecar Services](../../features/sidecars/).

## Validate it

```sh
ccpod config validate
ccpod config show              # print resolved merged config
```
