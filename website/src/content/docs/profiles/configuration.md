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
  # dockerfile: ./Dockerfile

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
| `dockerfile` | string | Required when `use: build`. Path relative to `$PWD`. |

When `use: build`, ccpod tags the local build as `ccpod-local-<profile>-<sha256(dockerfile-path)>`. Bump it with `ccpod run --rebuild`.

### `auth` *(required)*

| Field | Type | Notes |
|---|---|---|
| `type` | `api-key` \| `oauth` | |
| `keyEnv` | string | Env var name to read on the host (`api-key` only). |
| `keyFile` | string | File on the host to read (`api-key` only). |

For `oauth`, ccpod manages tokens in `~/.ccpod/credentials/<name>/`.

### `state`

`ephemeral` (default) wipes Claude history and session state when the container exits. `persistent` mounts a Docker volume `ccpod-state-<name>` that survives across runs. Override per run with `--no-state`.

### `ssh`

| Field | Default | Notes |
|---|---|---|
| `agentForward` | `false` | Forwards `SSH_AUTH_SOCK` into the container. Rejected if the value contains `:`. |
| `mountSshDir` | `false` | Mounts `~/.ssh` read-only. |

### `network`

| Field | Notes |
|---|---|
| `policy` | `full` (bridge with internet) or `restricted` (allow-list only). |
| `allow` | Hostnames/IPs to allow in restricted mode. Resolved at container start. |

See [Network Policy](/ccpod/features/network/).

### `ports`

| Field | Notes |
|---|---|
| `list` | Manual `host:container` mappings. |
| `autoDetectMcp` | Default `true`. If `.mcp.json` exists at `$PWD`, HTTP/SSE MCP ports are exposed automatically. |

### `env`

A list of env-var **names** on the host. ccpod forwards their values into the container. Names only — never values. To set a literal, use `ccpod run --env KEY=VALUE`.

### `services`

Sidecar containers (Postgres, Redis, queues, anything with a Docker image). Reachable from the Claude container by service name on a shared network. See [Sidecar Services](/ccpod/features/sidecars/).

## Validate it

```sh
ccpod config validate
ccpod config show              # print resolved merged config
```
