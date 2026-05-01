# ccpod

Run Claude Code inside Docker containers with portable, composable configuration.

**Why:** Your Claude environment (settings, plugins, skills, CLAUDE.md, MCPs) is usually locked to one machine. ccpod wraps it in a **profile** — a versioned config that travels with you, your team, or your open-source project. Every `ccpod run` drops you into a clean, reproducible Claude session.

Works with Docker, Podman, OrbStack, and Colima — auto-detected.

📖 **Docs:** https://yorch.github.io/ccpod

---

## Install

```sh
# macOS / Linux — one-liner installer
curl -fsSL https://raw.githubusercontent.com/yorch/ccpod/main/install.sh | bash

# Or build from source (requires Bun)
bun run build   # outputs dist/ccpod
```

The installer places `ccpod` in `/usr/local/bin` by default. Override with `CCPOD_INSTALL_DIR=~/.local/bin` or pin a version with `CCPOD_VERSION=v0.2.0`.

---

## Quick start

```sh
ccpod init          # first-run wizard: detect runtime, set up auth, create default profile
ccpod run           # interactive Claude session in the current directory
```

The project directory is mounted at `/workspace` inside the container. Claude runs there.

---

## Profiles

A profile defines the complete Claude environment for a session: Docker image, auth, settings, plugins, CLAUDE.md, SSH config, network policy, and sidecar services.

Profiles live at `~/.ccpod/profiles/<name>/profile.yml`.

### Profile config (`~/.ccpod/profiles/<name>/profile.yml`)

```yaml
name: personal
description: My personal Claude environment

config:
  source: local               # "local" | "git"
  path: ~/.my-claude-config   # local path to your ~/.claude config dir
  # For git-based configs:
  # source: git
  # repo: https://github.com/org/claude-config
  # sync: daily               # "always" | "daily" | "pin"
  # ref: main

image:
  use: ghcr.io/yorch/ccpod:latest   # pre-built image with Claude Code
  # use: build                     # build locally using dockerfile:
  # dockerfile: ./Dockerfile

auth:
  type: api-key              # "api-key" | "oauth"
  keyEnv: ANTHROPIC_API_KEY  # env var to read key from
  # keyFile: /run/secrets/api-key

state: ephemeral             # "ephemeral" (default) | "persistent"

ssh:
  agentForward: true         # forward SSH_AUTH_SOCK
  mountSshDir: false         # mount ~/.ssh read-only

network:
  policy: full               # "full" (default) | "restricted"
  allow: []                  # domains/IPs to allow in restricted mode

ports:
  list:
    - "3000:3000"            # host:container
  autoDetectMcp: true        # expose HTTP/SSE MCP ports from .mcp.json

plugins:
  - mcp-server-brave-search  # delta-installed on first run; skipped if already present

env:
  - DATABASE_URL             # host env vars to forward into container

services:                    # optional sidecar containers
  postgres:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: dev
    volumes:
      - ccpod-pg-data:/var/lib/postgresql/data
```

### Project config (`.ccpod.yml` in project root)

Overrides the profile for a specific project. ccpod walks up from `$PWD` to find it.

```yaml
profile: personal            # which profile to use
merge: deep                  # "deep" (default) | "override"

config:
  claudeMd: append           # "append" (default) | "override"

network:
  policy: restricted
  allow:
    - api.github.com
    - registry.npmjs.org

ports:
  list:
    - "4000:4000"

env:
  - STRIPE_SECRET_KEY
```

**Merge strategies:**

| Asset | Default behavior |
|-------|-----------------|
| `settings.json` | Deep merge; project wins on conflicts |
| `CLAUDE.md` | Profile content first, project appended (or `override` to replace) |
| plugins | Union — project adds, cannot remove profile plugins (unless `merge: override`) |
| `services` | Merged by key; project adds sidecars |
| `env` | Union of both lists |

---

## CLI reference

```
ccpod run                        Interactive Claude session
ccpod run --file prompt.txt      Headless mode (pipe stdout/stderr, exit with container code)
ccpod run --profile <name>       Use a specific profile
ccpod run --env KEY=VALUE        Pass/override env var for this run
ccpod run --rebuild              Force image rebuild or repull
ccpod run --no-state             Force ephemeral state for this run

ccpod init                       First-run setup wizard

ccpod profile create <name>
ccpod profile list
ccpod profile update <name>      Force-pull git-based config
ccpod profile delete <name>

ccpod plugins list [profile]
ccpod plugins update [profile]   Flush and reinstall all plugins

ccpod image build [profile]      Build local Dockerfile image
ccpod image pull [profile]       Pull latest base or declared image

ccpod ps                         List running ccpod containers
ccpod down                       Stop Claude container + sidecars for $PWD

ccpod state clear [profile]      Delete state volume (resets history/memory)

ccpod config show                Print resolved merged config
ccpod config validate            Validate .ccpod.yml
```

---

## State persistence

| Mode | History & memory | Survives restart |
|------|-----------------|-----------------|
| `ephemeral` (default) | tmpfs — wiped on exit | No |
| `persistent` | `~/.ccpod/state/<profile>/` on host | Yes |

Switch for a single run: `ccpod run --no-state`

Reset: `ccpod state clear [profile]` — deletes `~/.ccpod/state/<profile>/`

---

## Storage layout

```
~/.ccpod/
  profiles/<name>/
    profile.yml
    .ccpod-sync-lock        # timestamp of last git sync
  credentials/<name>/       # auth tokens — persist across container restarts
  state/<name>/             # history, projects, todos (persistent mode only)

Docker named volumes (managed by ccpod):
  ccpod-plugins-<profile>   # installed Claude plugins
```

---

## MCP auto-detection

If `.mcp.json` exists at the project root and `ports.autoDetectMcp: true` (default), ccpod reads HTTP/SSE MCP entries and automatically exposes their ports. No manual port config needed for most MCP setups.

> **Note:** stdio-based MCP servers require their runtime binaries inside the container. `npx`-based MCPs work automatically since the base image includes Node.js. Other runtimes need a custom `dockerfile:`.

---

## Shared team profile

Point your team at a shared git repo:

```yaml
# ~/.ccpod/profiles/team/profile.yml
name: team
config:
  source: git
  repo: https://github.com/your-org/claude-config
  sync: daily
  ref: main
```

Everyone gets the same CLAUDE.md, settings, and plugins. Updates flow in daily (or on demand with `ccpod profile update team`).

---

## Base image

The official base image is `ghcr.io/yorch/ccpod` — built from `docker/Dockerfile` and published automatically on every push to `main` (`:main`, `:latest`) and on version tags (`:1.2.3`, `:1.2`).

To use a custom image, set `image.use` in your profile. To build locally from a Dockerfile, set `image.use: build` and `image.dockerfile: ./Dockerfile`.
