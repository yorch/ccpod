# ccpod — Requirements Specification

CLI tool (TypeScript + Bun, single binary) that runs Claude Code inside Docker containers with portable, composable configuration via a profile system.

**Differentiator vs existing tools (claudebox, claude-code-container, etc.):** Profiles abstract the full `~/.claude` environment (settings, plugins, skills, CLAUDE.md, MCPs) and can be sourced from local dirs or git repos, enabling per-user, per-team, and per-project Claude environments.

**Target audiences:** individual developers (personal profile), engineering teams (shared git-based profile), open-source projects (published profile repo anyone can reference).

---

## Key Decisions

| Concern | Decision |
|---|---|
| Language | TypeScript + Bun (`bun build --compile` → single binary) |
| Lint/format | Biome |
| Tests | Bun test runner |
| Container runtimes | Docker, Podman, OrbStack, Colima (auto-detect socket) |
| Config format | YAML |
| Base image | `ghcr.io/yorch/ccpod` — auto-published tracking `@anthropic-ai/claude-code` npm releases |

---

## Functional Requirements

### Core Execution

| ID | Requirement |
|---|---|
| F-01 | Run `claude` CLI inside a Docker container |
| F-02 | Mount host project directory (default: `$PWD`) to `/workspace` inside container; working directory set to `/workspace` |
| F-03 | Support interactive mode (default) and headless mode (`ccpod run "prompt"` or `ccpod run --file prompt.txt`) |
| F-04 | Forward TTY and stdin for interactive sessions |
| F-05 | Stream stdout/stderr in headless mode; exit with container's exit code |
| F-06 | If no profile is specified (no `--profile` flag, no `.ccpod.yml` `profile:` key), use profile named `default`; if `default` does not exist, automatically trigger `ccpod init` |

### Profile System

A **profile** is the core abstraction — it defines the full Claude environment for a session.

| ID | Requirement |
|---|---|
| F-10 | Profiles stored at `~/.ccpod/profiles/<name>/profile.yml` on host |
| F-11 | Config source: **local directory** or **git repository** |
| F-12 | Git configs support sync strategies: `always` (every run), `daily` (once per calendar day, tracked via `.ccpod-sync-lock` timestamp file in the profile dir), `pin` (manual via `ccpod profile update` only) |
| F-13 | Three-layer hierarchy: global profile → project (`.ccpod.yml`) → CLI flags |
| F-14 | Each layer declares `merge: deep` (default) or `merge: override` |
| F-15 | `ccpod profile create <name>` — interactive profile creation |
| F-16 | `ccpod profile list` — list profiles with config source |
| F-17 | `ccpod profile update <name>` — force-pull git-based config |

### Config Merging

| Asset | Strategy |
|---|---|
| `settings.json` | Deep-merge; project wins on conflicts |
| `CLAUDE.md` | Configurable via `claudeMd: append` (default — profile content first, project appended below) or `claudeMd: override` (project content replaces profile entirely) |
| `skills/` | Union; symlinked skills skipped (not portable) |
| `plugins/enabledPlugins` | Union by default; project can enable additional plugins but cannot disable profile-declared ones unless `.ccpod.yml` sets `merge: override` (which replaces the entire plugin set) |
| `hooks/` | Merge arrays per event type |
| `extraKnownMarketplaces` | Union |

### Runtime State

The `~/.claude/` directory has three distinct categories requiring different persistence strategies:

| Category | Contents | Storage |
|---|---|---|
| **Config** (read-only) | `settings.json`, `CLAUDE.md`, `skills/`, `hooks/` | Temp dir seeded from profile config source; bind-mounted read-only |
| **Credentials** (read-write) | OAuth tokens, session auth, API key cache | `~/.ccpod/credentials/<profile>/` on host; bind-mounted read-write |
| **State** (configurable) | `history.jsonl`, `projects/`, `todos/`, `sessions/` | `~/.ccpod/state/<profile>/` bind mount (`persistent`) or tmpfs (`ephemeral`) |

| ID | Requirement |
|---|---|
| F-26 | State persistence configurable via profile: `state: ephemeral` (default) or `state: persistent` |
| F-27 | `persistent` mode: state stored in `~/.ccpod/state/<profile>/` on host, bind-mounted into container — survives container restarts |
| F-28 | `ephemeral` mode: state lives only for the container lifetime — fresh slate each run |
| F-29 | `ccpod state clear [profile]` — delete state directory (reset history/memory for a profile) |

### Authentication & Credentials

| ID | Requirement |
|---|---|
| F-20 | Profile config dir mounted **read-only** into container |
| F-21 | Credentials persisted to `~/.ccpod/credentials/<profile>/` on host — separate from the read-only config dir |
| F-22 | Credentials dir mounted **read-write** into container at the auth-relevant portion of `~/.claude/` (e.g. session tokens, OAuth state) — survives container restarts and re-creates |
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
| F-40 | Official base image: `ghcr.io/yorch/ccpod` with Claude Code pre-installed |
| F-41 | Override with `image: my-registry/my-image:tag` in profile |
| F-42 | `dockerfile:` path: if absolute, context dir = `dirname(dockerfile)`; if relative, context dir = `$PWD` |
| F-42a | When `dockerfile:` is set, ccpod auto-builds on first run using tag `ccpod-local-<profile>-<sha256-of-dockerfile-contents>` (falls back to path hash if file not found); subsequent runs reuse that tag unless `--rebuild` is passed |
| F-43 | `ccpod image build [profile]` — explicit local build |
| F-44 | `ccpod image pull [profile]` — pull latest base or declared image |
| F-45 | `ccpod image init [profile]` — download a Dockerfile into the profile directory for local customization; defaults to the official ccpod Dockerfile; `--from <url>` accepts any raw URL; updates `image.dockerfile` in profile.yml |

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
| F-70 | Declare port forwards in profile config under `ports.list:` |
| F-71 | Auto-detect HTTP/SSE MCPs from `.mcp.json` and expose their ports; controlled by `ports.autoDetectMcp: true` (default: `true`) |
| F-72 | Port format: `"host:container"` string or shorthand `"port"` (1:1 mapping) |

### Environment Variable Passthrough

| ID | Requirement |
|---|---|
| F-85 | `.ccpod.yml` `env:` list declares host env vars to forward into the container |
| F-86 | Vars in the list that are unset on the host are silently ignored (no error) |
| F-87 | Profile `profile.yml` can also declare `env:` entries as a base set |
| F-88 | CLI flag `--env KEY=VALUE` adds or overrides individual vars at runtime |

### Local stdio MCP Considerations

> **Known limitation:** stdio-based MCP servers (most common type) require their binaries to be present inside the container. `npx`-based MCPs work automatically since the base image includes Node.js. For other runtimes (Python, Go, custom binaries), the profile's `dockerfile:` must install them. Remote HTTP/SSE MCPs have no binary requirement.

### Multi-Container Sidecars

| ID | Requirement |
|---|---|
| F-80 | Profile supports `services:` section (Docker Compose-style sidecars) |
| F-81 | Sidecars started before Claude container; shared network |
| F-82 | `ccpod down` tears down Claude container + all sidecars; idempotent (silent if nothing running) |
| F-83 | `ccpod ps` lists all running ccpod-managed containers (main + sidecars) with profile name and project dir |
| F-84 | All ccpod-managed containers are labelled with `ccpod.profile`, `ccpod.project` (sha256 of `$PWD`), and `ccpod.type` (`main` or sidecar service name) |

### First-Run Experience

| ID | Requirement |
|---|---|
| F-90 | `ccpod init` — interactive wizard, triggered automatically on first run or explicitly |
| F-91 | Wizard step 1: detect installed container runtime (Docker / Podman / OrbStack / Colima) |
| F-92 | Wizard step 2: choose auth method (API key or OAuth login) and store credentials |
| F-93 | Wizard step 3: choose config source for default profile (local dir, git repo, or start empty) |
| F-94 | Wizard step 4: choose network policy default |
| F-95 | Wizard step 5: confirm and write `~/.ccpod/profiles/default/profile.yml` |

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
  use: ghcr.io/yorch/ccpod:latest    # or "build"
  # dockerfile: ./Dockerfile

auth:
  type: api-key                     # "api-key" | "oauth"
  # keyEnv: ANTHROPIC_API_KEY
  # keyFile: /run/secrets/api-key

claudeArgs: []                      # extra flags passed to claude on every run
# claudeArgs: ["--dangerously-skip-permissions", "--model", "claude-opus-4-5"]

state: ephemeral                    # "ephemeral" | "persistent"

ssh:
  agentForward: true
  mountSshDir: false

network:
  policy: full                      # "full" | "restricted"
  allow: []

ports:
  list:
    - "3000:3000"
  autoDetectMcp: true                 # default true; expose ports from .mcp.json HTTP/SSE entries

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

claudeArgs:                         # deep: appended after profile; override: replaces profile
  - "--dangerously-skip-permissions"

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
ccpod image init [profile]
ccpod image pull [profile]

ccpod down                          Stop container + sidecars
ccpod ps                            Show running ccpod containers

ccpod state clear [profile]         Delete state volume (reset history/memory)

ccpod config show                   Resolved merged config
ccpod config validate               Validate .ccpod.yml

Flags:
  --rebuild                         Force image rebuild (when dockerfile: is set)
  --env KEY=VALUE                   Pass/override env var for this run
  --profile <name>                  Use named profile (overrides .ccpod.yml)
  --no-state                        Force ephemeral state for this run
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
