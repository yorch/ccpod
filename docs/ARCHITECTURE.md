# ccpod — Architecture & Technical Design

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Host Machine                                                        │
│                                                                      │
│  ccpod (single binary)                                              │
│  ┌─────────────────────────────────────────────────────────┐        │
│  │ CLI Layer        config  profile  plugins  container    │        │
│  │                  ──────  ───────  ───────  ─────────    │        │
│  │  commands ──────► merge  ► sync  ► diff  ► run         │        │
│  └────────────────────────────┬────────────────────────────┘        │
│                               │ ContainerConfig                      │
│  Sources:                     ▼                                      │
│  ~/.ccpod/profiles/<name>/  ┌──────────────────────────────────┐    │
│  .ccpod.yml (project root)  │  Container Runtime               │    │
│  ~/.ccpod/credentials/<n>/  │  (Docker / Podman / OrbStack /   │    │
│  ccpod-plugins-<name>       │   Colima — auto-detected)        │    │
│  ccpod-state-<name>         └──────────────┬───────────────────┘    │
│                                            │                         │
└────────────────────────────────────────────┼─────────────────────────┘
                                             │
                              ┌──────────────▼──────────────────┐
                              │  Docker Container               │
                              │                                 │
                              │  entrypoint.sh assembles        │
                              │  ~/.claude/ from 4 sources:     │
                              │                                 │
                              │  /ccpod/config   (ro bind)      │
                              │  /ccpod/creds    (rw bind)      │
                              │  /ccpod/plugins  (rw volume) ──►│─► ccpod-plugins-<name>
                              │  /ccpod/state    (rw volume) ──►│─► ccpod-state-<name>
                              │  /workspace      (rw bind)  ──►│─► $PWD on host
                              │                                 │
                              │  exec: claude [args]            │
                              └─────────────────────────────────┘
```

---

## 2. Module Structure

```
src/
├── cli/
│   ├── index.ts                 # Entry point; registers commands
│   └── commands/
│       ├── run.ts               # Default: ccpod [-- claude-args]
│       ├── init.ts              # ccpod init wizard
│       ├── profile/
│       │   ├── create.ts
│       │   ├── list.ts
│       │   ├── update.ts
│       │   └── delete.ts
│       ├── plugins/
│       │   ├── list.ts
│       │   └── update.ts
│       ├── image/
│       │   ├── build.ts
│       │   └── pull.ts
│       ├── state/
│       │   └── clear.ts
│       └── config/
│           ├── show.ts
│           └── validate.ts
│
├── config/
│   ├── loader.ts                # Load profile.yml + .ccpod.yml
│   ├── merger.ts                # Per-asset merge strategies
│   ├── writer.ts                # Write merged config to temp dir
│   └── schema.ts                # Zod schemas for both config files
│
├── profile/
│   ├── manager.ts               # CRUD for ~/.ccpod/profiles/
│   ├── git-sync.ts              # Clone/pull git-based config sources
│   ├── local-sync.ts            # Validate/copy local config sources
│   └── lock.ts                  # .ccpod-sync-lock timestamp management
│
├── runtime/
│   ├── detector.ts              # Socket auto-detection per runtime
│   ├── client.ts                # Thin wrapper over dockerode
│   └── types.ts                 # ContainerRuntime interface
│
├── container/
│   ├── builder.ts               # ResolvedConfig → ContainerSpec
│   ├── runner.ts                # Create / start / attach / stop
│   ├── mounts.ts                # Assemble bind mounts + volumes
│   └── sidecars.ts              # Start/stop sidecar services
│
├── plugins/
│   ├── volume.ts                # Ensure volume exists, list installed
│   └── installer.ts             # Delta-install: declared vs installed diff
│
├── mcp/
│   ├── parser.ts                # Parse .mcp.json at project root
│   └── ports.ts                 # Extract ports from HTTP/SSE MCP entries
│
├── network/
│   ├── policy.ts                # NetworkPolicy type + validation
│   └── rules.ts                 # iptables rule generation for restricted mode
│
├── image/
│   ├── manager.ts               # Pull / tag / exists check
│   └── builder.ts               # docker build wrapper
│
├── auth/
│   ├── resolver.ts              # Resolve API key (env var → secret file)
│   └── credentials.ts           # Ensure ~/.ccpod/credentials/<profile>/ exists
│
├── init/
│   └── wizard.ts                # Step-by-step first-run wizard
│
└── types/
    └── index.ts                 # All shared TypeScript interfaces
```

**Third-party dependencies:**

| Package | Purpose |
|---|---|
| `citty` | CLI framework (lightweight, Bun-native) |
| `zod` | Schema validation for config files |
| `yaml` | YAML parse/serialize |
| `dockerode` | Docker SDK (works with any compatible socket) |
| `deepmerge` | Deep-merge for settings.json |
| `@inquirer/prompts` | Interactive wizard prompts |
| `simple-git` | Git operations for profile sync |
| `chalk` | Terminal output colouring |

---

## 3. Core Type Definitions

```typescript
// types/index.ts

export type SyncStrategy = 'always' | 'daily' | 'pin';
export type MergeStrategy = 'deep' | 'override';
export type StateMode = 'ephemeral' | 'persistent';
export type NetworkPolicy = 'full' | 'restricted';
export type AuthType = 'api-key' | 'oauth';
export type ClaudeMdMerge = 'append' | 'override';

export interface ProfileConfig {
  name: string;
  description?: string;
  config: {
    source: 'local' | 'git';
    path?: string;      // local
    repo?: string;      // git
    sync?: SyncStrategy;
    ref?: string;       // git branch/tag/commit
  };
  image: {
    use: string;        // image ref or "build"
    dockerfile?: string;
  };
  auth: {
    type: AuthType;
    keyEnv?: string;
    keyFile?: string;
  };
  state: StateMode;
  ssh: {
    agentForward: boolean;
    mountSshDir: boolean;
  };
  network: {
    policy: NetworkPolicy;
    allow: string[];
  };
  ports: PortMapping[];
  services: Record<string, ServiceConfig>;
  env: string[];        // var names to forward from host
}

export interface ProjectConfig {
  profile?: string;
  merge?: MergeStrategy;
  config?: {
    claudeMd?: ClaudeMdMerge;
  };
  network?: Partial<ProfileConfig['network']>;
  ports?: PortMapping[];
  services?: Record<string, ServiceConfig>;
  env?: string[];
}

export interface PortMapping {
  host: number;
  container: number;
}

export interface ServiceConfig {
  image: string;
  env?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
}

// Fully resolved config after all layers merged
export interface ResolvedConfig {
  profileName: string;
  image: string;
  dockerfile?: string;
  auth: ProfileConfig['auth'];
  state: StateMode;
  ssh: ProfileConfig['ssh'];
  network: ProfileConfig['network'];
  ports: PortMapping[];
  services: Record<string, ServiceConfig>;
  env: Record<string, string>;       // resolved key→value
  mergedConfigDir: string;           // /tmp/ccpod-<hash>/
  claudeArgs: string[];
}

export interface ContainerRuntime {
  name: string;
  socketPath: string;
  isAvailable(): Promise<boolean>;
}

export interface PluginDiff {
  toInstall: string[];
  alreadyInstalled: string[];
  toRemove: string[];              // only relevant after plugins update
}
```

---

## 4. ~/.claude Assembly Model

The four sources that compose `~/.claude/` inside the container are mounted to `/ccpod/` paths. The entrypoint script assembles the final directory at startup.

```
Host mounts                     Inside container         ~/.claude/ result
─────────────────               ─────────────────        ─────────────────────
/tmp/ccpod-<hash>/   ──ro──►   /ccpod/config/      ──►  settings.json (copied)
  settings.json                                          CLAUDE.md     (copied)
  CLAUDE.md                                             skills/       (copied)
  hooks/                                                hooks/        (copied)
  skills/

~/.ccpod/creds/<p>/  ──rw──►   /ccpod/credentials/ ──►  *.json auth files (copied,
  *.credentials.json                                      overlays config)

ccpod-plugins-<p>   (volume)►  /ccpod/plugins/     ──►  plugins/  ← symlink
ccpod-state-<p>     (volume)►  /ccpod/state/       ──►  history.jsonl ← symlink
                                                         projects/     ← symlink
                                                         todos/        ← symlink
                                                         sessions/     ← symlink
$PWD                 ──rw──►   /workspace/
```

**Entrypoint (`docker/entrypoint.sh`):**

```bash
#!/usr/bin/env bash
set -euo pipefail

CLAUDE_HOME="${HOME}/.claude"
mkdir -p "$CLAUDE_HOME"

# 1. Seed from profile config (base layer, -n = no-overwrite)
cp -rn /ccpod/config/. "$CLAUDE_HOME/"

# 2. Overlay credentials (auth tokens overwrite config defaults if same filename)
if [[ -d /ccpod/credentials && -n "$(ls -A /ccpod/credentials 2>/dev/null)" ]]; then
  cp -r /ccpod/credentials/. "$CLAUDE_HOME/"
fi

# 3. Symlink plugin volume (avoids copying large plugin data)
rm -rf "$CLAUDE_HOME/plugins"
mkdir -p /ccpod/plugins
ln -sf /ccpod/plugins "$CLAUDE_HOME/plugins"

# 4. Symlink state items (persistent mode only)
if [[ "${CCPOD_STATE:-ephemeral}" == "persistent" ]]; then
  for item in history.jsonl projects todos sessions; do
    rm -rf "$CLAUDE_HOME/$item"
    # Create placeholder so symlink target exists even on first run
    if [[ "$item" == "history.jsonl" ]]; then
      touch "/ccpod/state/$item"
    else
      mkdir -p "/ccpod/state/$item"
    fi
    ln -sf "/ccpod/state/$item" "$CLAUDE_HOME/$item"
  done
fi

# 5. Delta-install missing plugins (populated by ccpod before exec)
if [[ -n "${CCPOD_PLUGINS_TO_INSTALL:-}" ]]; then
  IFS=',' read -ra PLUGINS <<< "$CCPOD_PLUGINS_TO_INSTALL"
  for plugin in "${PLUGINS[@]}"; do
    claude plugin install "$plugin" --yes 2>/dev/null || true
  done
fi

exec "$@"
```

---

## 5. Config Merging Pipeline

```
load_profile_config(name)
  → detect source (local | git)
  → git: sync_if_needed(strategy) → read files
  → local: read files directly
  → parse profile.yml (Zod validation)
  → read ~/.claude assets from config.path or cloned repo

load_project_config($PWD)
  → find .ccpod.yml walking up from $PWD
  → parse (Zod validation)
  → determine merge strategy (default: deep)

merge(profile_claude_assets, project_overrides, strategy):
  settings.json  → deepmerge(profile, project)          // project wins on conflict
  CLAUDE.md      → claudeMdMerge(profile, project, mode) // append or override
  skills/        → union(profile_skills, project_skills) // skip symlinks
  enabledPlugins → union(profile_plugins, project_plugins) // or replace if override
  hooks/         → mergeArraysByEventType(profile, project)
  marketplaces   → { ...profile_markets, ...project_markets }

write_merged_config(result) → /tmp/ccpod-<sha256(content)>/
  // deterministic path: same config content = same dir = skip re-write
```

---

## 6. Startup Sequence

```
ccpod run [-- claude-args]
│
├─ 1. Detect container runtime
│     try: Docker (unix:///var/run/docker.sock)
│          Podman (~/.local/share/containers/podman/machine/...)
│          OrbStack (unix:///var/run/docker.sock, different context)
│          Colima (~/.colima/default/docker.sock)
│     error if none available
│
├─ 2. Load + merge config
│     load profile → sync config source if needed
│     load .ccpod.yml (optional) → merge layers
│     → ResolvedConfig
│
├─ 3. Ensure image
│     if dockerfile: check if image tag exists; build if not (or --rebuild)
│     else: check if image exists locally; pull if not
│
├─ 4. Ensure volumes
│     credentials dir: mkdir -p ~/.ccpod/credentials/<profile>/
│     plugins volume:  docker volume create ccpod-plugins-<profile> (idempotent)
│     state volume:    docker volume create ccpod-state-<profile>   (if persistent)
│                      OR: use --tmpfs /ccpod/state (if ephemeral)
│
├─ 5. Plugin delta-install prep
│     list installed plugins from plugin volume
│     diff against declared plugins in resolved config
│     pass delta as CCPOD_PLUGINS_TO_INSTALL env var to container
│
├─ 6. Parse .mcp.json (if exists at $PWD)
│     extract HTTP/SSE MCPs → additional port mappings
│
├─ 7. Start sidecars (if services: declared)
│     create shared network: ccpod-<session>-net
│     start each sidecar container on that network
│
├─ 8. Build ContainerSpec
│     image, workdir, env, mounts, network, ports, tty
│
├─ 9. Start Claude container
│     entrypoint assembles ~/.claude/
│     plugin delta-install runs
│     exec claude [args]
│
└─ 10. Attach
      interactive: attach stdin/stdout/stderr with raw TTY
      headless:    pipe stdout/stderr, capture exit code
```

---

## 7. Container Runtime Abstraction

All runtime-specific logic is behind a single interface. This makes Podman, OrbStack, and Colima support transparent — they all expose a Docker-compatible socket.

```typescript
// runtime/detector.ts

const RUNTIME_CANDIDATES = [
  {
    name: 'docker',
    sockets: [
      '/var/run/docker.sock',
      `${process.env.HOME}/.docker/run/docker.sock`,
    ],
  },
  {
    name: 'orbstack',
    sockets: [
      `${process.env.HOME}/.orbstack/run/docker.sock`,
    ],
  },
  {
    name: 'colima',
    sockets: [
      `${process.env.HOME}/.colima/default/docker.sock`,
      `${process.env.HOME}/.colima/docker.sock`,
    ],
  },
  {
    name: 'podman',
    sockets: [
      `${process.env.XDG_RUNTIME_DIR}/podman/podman.sock`,
      `${process.env.HOME}/.local/share/containers/podman/machine/podman.sock`,
    ],
  },
] as const;

export async function detectRuntime(): Promise<ContainerRuntime> { ... }
```

Dockerode accepts a custom socket path, so after detection the rest of the code uses the same API regardless of runtime.

---

## 8. Network Policy Implementation

**Full mode:** container attached to standard bridge network with full outbound.

**Restricted mode:**
1. Create an isolated Docker network (`--internal` flag blocks default internet)
2. The entrypoint runs an iptables setup script that:
   - Adds rules to ACCEPT traffic to declared allowed domains (resolved at startup)
   - Drops everything else
3. DNS still works via the bridge gateway

```typescript
// network/rules.ts
export function generateIptablesRules(allowList: string[]): string[] {
  // resolves each domain → IPs at container start time
  // generates ACCEPT rules for each IP
  // final rule: DROP all other outbound
}
```

---

## 9. Base Image Strategy

**Tagging convention:** `ghcr.io/ccpod/base:<claude-code-version>`
e.g. `ghcr.io/ccpod/base:2.1.120`, `ghcr.io/ccpod/base:latest`

**Release automation (GitHub Actions):**
- Watch `@anthropic-ai/claude-code` on npm registry (poll or webhook)
- On new version: build + push new image tag
- Update `latest` tag

```dockerfile
# docker/Dockerfile
FROM node:24-slim

ARG CLAUDE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl openssh-client python3 python3-pip \
    iptables \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /ccpod/entrypoint.sh
RUN chmod +x /ccpod/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/ccpod/entrypoint.sh"]
CMD ["claude"]
```

---

## 10. Directory Layout on Host

```
~/.ccpod/
├── profiles/
│   ├── default/
│   │   ├── profile.yml
│   │   └── .ccpod-sync-lock        # timestamp of last git sync
│   └── team-frontend/
│       └── profile.yml
└── credentials/
    ├── default/                    # auth files for "default" profile
    └── team-frontend/

Docker named volumes (managed by ccpod):
  ccpod-plugins-default
  ccpod-plugins-team-frontend
  ccpod-state-default              # only if state: persistent
  ccpod-state-team-frontend

Project (in git repo):
  .ccpod.yml                       # project-level config overrides
  .mcp.json                        # Claude Code MCP server config (auto-detected)
```

---

## 11. Testing Strategy

Config merging logic (merger.ts, schema.ts) is pure functions — fully unit-testable without Docker.

Container logic (builder.ts, mounts.ts) should be tested with a mock runtime implementing `ContainerRuntime`.

Integration tests use a real Docker socket and a minimal test image.

```
tests/
├── unit/
│   ├── config/merger.test.ts       # All merge strategy variants
│   ├── config/schema.test.ts       # Zod validation edge cases
│   ├── mcp/ports.test.ts           # .mcp.json port extraction
│   ├── network/rules.test.ts       # iptables rule generation
│   └── profile/lock.test.ts        # Sync lock timestamp logic
├── integration/
│   ├── container/run.test.ts       # Requires Docker socket
│   └── plugins/install.test.ts     # Requires Docker socket
└── fixtures/
    ├── profile.yml
    ├── .ccpod.yml
    └── .mcp.json
```

---

## 12. v1 Build Order

Recommended implementation sequence (each step independently testable):

1. **Types + schema** — `types/index.ts`, `config/schema.ts` (Zod)
2. **Config loader + merger** — pure functions, fully unit-testable
3. **Profile manager** — CRUD for `~/.ccpod/profiles/`
4. **Runtime detector** — socket detection, dockerode init
5. **Image manager** — pull/build/exists
6. **Mount builder** — assemble ContainerSpec mounts from ResolvedConfig
7. **Container runner** — create/start/attach/stop
8. **Entrypoint + base image** — Dockerfile + entrypoint.sh
9. **Plugin delta-installer** — volume + diff + CCPOD_PLUGINS_TO_INSTALL
10. **Network policy** — iptables rules for restricted mode
11. **Sidecar manager** — start/stop services
12. **CLI commands** — wire all above into `citty` commands
13. **Init wizard** — `@inquirer/prompts` step-by-step
14. **MCP port auto-detection** — parse .mcp.json
15. **Git sync + lock** — simple-git, .ccpod-sync-lock
16. **GitHub Actions** — base image CI, binary release CI
