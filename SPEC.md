# ccpod — Requirements Specification

CLI tool (TypeScript + Bun, single binary) that runs Claude Code inside Docker containers with portable, composable configuration via a profile system.

**Differentiator vs existing tools (claudebox, claude-code-container, etc.):** Profiles abstract the full `~/.claude` environment (settings, plugins, skills, CLAUDE.md, MCPs) and can be sourced from local dirs or git repos, enabling per-user, per-team, and per-project Claude environments.

---

## Key Decisions

| Concern | Decision |
|---|---|
| Language | TypeScript + Bun (`bun build --compile` → single binary) |
| Lint/format | Biome |
| Tests | Bun test runner |
| Container runtimes | Docker, Podman, OrbStack, Colima (auto-detect socket) |
| Config format | YAML |
| Base image | `ghcr.io/ccpod/base` — auto-published tracking `@anthropic-ai/claude-code` npm releases |

---

## Functional Requirements

### Core Execution

| ID | Requirement |
|---|---|
| F-01 | Run `claude` CLI inside a Docker container |
| F-02 | Mount host project directory (default: `$PWD`) to `/workspace` inside container |
| F-03 | Support interactive mode (default) and headless mode (`ccpod run "prompt"`) |
| F-04 | Forward TTY and stdin for interactive sessions |
| F-05 | Stream stdout/stderr in headless mode; exit with container's exit code |

### Profile System

A **profile** is the core abstraction — it defines the full Claude environment for a session.

| ID | Requirement |
|---|---|
| F-10 | Profiles stored at `~/.ccpod/profiles/<name>/profile.yml` on host |
| F-11 | Config source: **local directory** or **git repository** |
| F-12 | Git configs support sync strategies: `always`, `daily`, `pin` (manual) |
| F-13 | Three-layer hierarchy: global profile → project (`.ccpod.yml`) → CLI flags |
| F-14 | Each layer declares `merge: deep` (default) or `merge: override` |
| F-15 | `ccpod profile create <name>` — interactive profile creation |
| F-16 | `ccpod profile list` — list profiles with config source |
| F-17 | `ccpod profile update <name>` — force-pull git-based config |

### Config Merging

| Asset | Strategy |
|---|---|
| `settings.json` | Deep-merge; project wins on conflicts |
| `CLAUDE.md` | Append: profile content first, project content below |
| `skills/` | Union; symlinked skills skipped (not portable) |
| `plugins/enabledPlugins` | Union; project can enable additional plugins |
| `hooks/` | Merge arrays per event type |
| `extraKnownMarketplaces` | Union |

### Authentication & Credentials

| ID | Requirement |
|---|---|
| F-20 | Profile config dir mounted **read-only** into container |
| F-21 | Credentials persisted to `~/.ccpod/credentials/<profile>/` on host |
| F-22 | Credentials dir mounted **read-write** as separate Docker volume — survives restarts |
| F-23 | API key via env var (`ANTHROPIC_API_KEY`) or Docker secret file |
| F-24 | OAuth/subscription login flow supported inside running container |
| F-25 | Credentials persist across runs — no re-login unless session expires |

### Plugin Management

| ID | Requirement |
|---|---|
| F-30 | Plugin state in named Docker volume: `ccpod-plugins-<profile>` |
| F-31 | On container start: diff declared plugins vs installed → delta-install only |
| F-32 | Fast on subsequent runs (no reinstall if nothing changed) |
| F-33 | `ccpod plugins update [profile]` — flush volume and reinstall all |

### Container Image

| ID | Requirement |
|---|---|
| F-40 | Official base image: `ghcr.io/ccpod/base` with Claude Code pre-installed |
| F-41 | Override with `image: my-registry/my-image:tag` in profile |
| F-42 | `dockerfile: ./Dockerfile` — ccpod builds it before running |
| F-43 | `ccpod image build [profile]` — explicit local build |
| F-44 | `ccpod image pull [profile]` — pull latest base or declared image |

### Network Policy

| ID | Requirement |
|---|---|
| F-50 | Default policy: `full` (unrestricted outbound) |
| F-51 | `restricted`: blocks all outbound except declared `allow` list (domains/IPs) |
| F-52 | Policy configurable at profile level, overridable at project level |
| F-53 | Restricted mode via `iptables` rules applied at container start |

### SSH & Git Credentials

| ID | Requirement |
|---|---|
| F-60 | Configurable: forward SSH agent socket (`SSH_AUTH_SOCK`) |
| F-61 | Configurable: mount `~/.ssh` read-only into container |
| F-62 | Both can be enabled simultaneously |
| F-63 | Default: SSH agent forwarding on, `~/.ssh` mount off |

### Port Forwarding

| ID | Requirement |
|---|---|
| F-70 | Declare port forwards in profile config under `ports:` |
| F-71 | Auto-detect HTTP/SSE MCPs from `.mcp.json` and expose their ports |
| F-72 | Port format: `host:container` or shorthand `port` (1:1 mapping) |

### Multi-Container Sidecars

| ID | Requirement |
|---|---|
| F-80 | Profile supports `services:` section (Docker Compose-style sidecars) |
| F-81 | Sidecars started before Claude container; shared network |
| F-82 | `ccpod down` tears down Claude container + all sidecars |

### First-Run Experience

| ID | Requirement |
|---|---|
| F-90 | `ccpod init` — interactive wizard on first run |
| F-91 | Wizard creates default profile, detects container runtime, handles auth setup |

---

## Configuration Schema

### `~/.ccpod/profiles/<name>/profile.yml`

```yaml
name: personal
description: My personal Claude environment

config:
  source: local                     # "local" | "git"
  path: ~/.my-claude-config         # for local
  # repo: https://github.com/org/claude-config
  # sync: daily                     # "always" | "daily" | "pin"
  # ref: main

image:
  use: ghcr.io/ccpod/base:latest    # or "build"
  # dockerfile: ./Dockerfile

auth:
  type: api-key                     # "api-key" | "oauth"
  # keyEnv: ANTHROPIC_API_KEY
  # keyFile: /run/secrets/api-key

ssh:
  agentForward: true
  mountSshDir: false

network:
  policy: full                      # "full" | "restricted"
  allow: []

ports:
  - "3000:3000"
  autoDetectMcp: true

services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: dev
    volumes:
      - ccpod-pg-data:/var/lib/postgresql/data
```

### `.ccpod.yml` (project root)

```yaml
profile: personal
merge: deep                         # "deep" | "override"

config:
  claudeMd: append                  # "append" | "override"

network:
  policy: restricted
  allow:
    - api.github.com
    - registry.npmjs.org

ports:
  - "4000:4000"

env:
  - DATABASE_URL
  - STRIPE_SECRET_KEY
```

---

## CLI Interface

```
ccpod [-- claude-args]              Interactive session
ccpod run "prompt text"             Headless mode
ccpod run --file prompt.txt         Headless from file
ccpod init                          First-run setup wizard

ccpod profile create <name>
ccpod profile list
ccpod profile update <name>
ccpod profile delete <name>

ccpod plugins list [profile]
ccpod plugins update [profile]

ccpod image build [profile]
ccpod image pull [profile]

ccpod down                          Stop container + sidecars
ccpod ps                            Show running ccpod containers

ccpod config show                   Resolved merged config
ccpod config validate               Validate .ccpod.yml
```

---

## Non-Functional Requirements

| ID | Requirement |
|---|---|
| NF-01 | Single binary via `bun build --compile`; no runtime deps |
| NF-02 | macOS and Linux; Windows via WSL2 |
| NF-03 | Container start-to-prompt under 5s when plugins already installed |
| NF-04 | Config merging logic fully unit-testable without Docker |
| NF-05 | Biome for lint/format; Bun test runner |
| NF-06 | Docker (or compatible runtime) is the only dependency |

---

## v1 / v2 Boundary

**v1:** Everything above.

**v2 (deferred):**
- TUI dashboard (live logs, container status, resource usage)
- Plugin marketplace browser
- Centralized team profile server (HTTP endpoint as config source)
- Windows native (non-WSL2)
