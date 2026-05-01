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
│       ├── ps.ts                    # ccpod ps — list running ccpod containers
│       ├── down.ts                  # ccpod down — stop container + sidecars
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
│   ├── manager.ts               # CRUD for ~/.ccpod/profiles/; CCPOD_TEST_DIR override
│   ├── git-sync.ts              # Clone/pull git-based config sources
│   └── lock.ts                  # .ccpod-sync-lock timestamp management
│
├── runtime/
│   ├── detector.ts              # Socket auto-detection (OrbStack/Docker/Colima/Podman)
│   └── docker.ts                # dockerExec (capture stdout/stderr) / dockerSpawn (inherit stdio)
│
├── container/
│   ├── builder.ts               # ResolvedConfig → ContainerSpec; computeProjectHash()
│   ├── runner.ts                # Reattach-or-create-and-run via docker CLI
│   └── sidecars.ts              # Shared network + sidecar lifecycle
│
├── plugins/
│   └── volume.ts                # Volume exists check, list entries, remove
│
├── mcp/
│   └── parser.ts                # Parse .mcp.json; extract HTTP/SSE port list
│
├── image/
│   └── manager.ts               # ensureImage (pull if absent), buildImage
│
├── auth/
│   └── resolver.ts              # Resolve API key or OAuth creds → env vars
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
| `deepmerge` | Deep-merge for settings.json |
| `@inquirer/prompts` | Interactive wizard prompts |
| `simple-git` | Git operations for profile sync |
| `chalk` | Terminal output colouring |

Docker operations use the `docker` CLI via `Bun.spawn` — no Docker SDK dependency. Two helpers in `src/runtime/docker.ts`: `dockerExec` (captures stdout/stderr) and `dockerSpawn` (inherits stdio for TTY sessions).

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
  ports: {
    list: PortMapping[];
    autoDetectMcp: boolean;   // default true
  };
  mcp?: {
    autoDetectPorts: boolean;
  };
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

```sh
#!/bin/sh
set -e

CLAUDE_DIR="${HOME}/.claude"
mkdir -p "${CLAUDE_DIR}"

# 1. Seed config (CLAUDE.md, settings.json, skills, extensions) — ro source → rw dest
if [ -d /ccpod/config ]; then
  cp -r /ccpod/config/. "${CLAUDE_DIR}/"
fi

# 2. Overlay credentials (.credentials.json, OAuth tokens, etc.)
if [ -d /ccpod/credentials ] && [ "$(ls -A /ccpod/credentials 2>/dev/null)" ]; then
  cp -r /ccpod/credentials/. "${CLAUDE_DIR}/"
fi

# 3. Plugins — symlink named volume so installs persist across runs
mkdir -p /ccpod/plugins
rm -rf "${CLAUDE_DIR}/plugins"
ln -sf /ccpod/plugins "${CLAUDE_DIR}/plugins"

# 4. State — symlink named volume or tmpfs mount
mkdir -p /ccpod/state/projects /ccpod/state/todos /ccpod/state/statsig
for dir in projects todos statsig; do
  rm -rf "${CLAUDE_DIR}/${dir}"
  ln -sf "/ccpod/state/${dir}" "${CLAUDE_DIR}/${dir}"
done

# 5. Delta-install missing plugins (comma-separated list from env)
if [ -n "${CCPOD_PLUGINS_TO_INSTALL}" ]; then
  for plugin in $(printf '%s' "${CCPOD_PLUGINS_TO_INSTALL}" | tr ',' '\n'); do
    if [ -n "${plugin}" ] && [ ! -d "${CLAUDE_DIR}/plugins/${plugin}" ]; then
      claude plugin install "${plugin}" 2>/dev/null || true
    fi
  done
fi

# Run claude (or custom cmd) as a background job so the shell stays alive for cleanup.
# Signal forwarding ensures docker stop/-t works correctly.
# On exit, write credentials back to the host-mounted /ccpod/credentials so they
# survive container removal and are available on the next run.
"$@" &
CHILD_PID=$!
trap "kill -TERM $CHILD_PID 2>/dev/null" TERM INT HUP
wait $CHILD_PID || STATUS=$?
STATUS=${STATUS:-0}
cp -f "${CLAUDE_DIR}/.credentials.json" /ccpod/credentials/.credentials.json 2>/dev/null || true
cp -f "${HOME}/.claude.json" /ccpod/credentials/.claude.json 2>/dev/null || true
exit $STATUS
```

**Credential persistence:** two auth files are persisted in `~/.ccpod/credentials/<profile>/` (bind-mounted as `/ccpod/credentials`):

| File | Location inside container | Contains |
|---|---|---|
| `.credentials.json` | `$CLAUDE_CONFIG_DIR/.credentials.json` | OAuth access/refresh tokens |
| `.claude.json` | `$HOME/.claude.json` (fixed — ignores `CLAUDE_CONFIG_DIR`) | Account metadata, migration flags |

On startup both are copied in; on exit both are written back. The signal-forwarding wrapper (`"$@" &` + `trap`) ensures write-back runs even when `docker stop` sends `SIGTERM`.

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
├─ 2. Resolve profile name
│     --profile flag > .ccpod.yml profile: field > "default"
│     if resolved profile does not exist → trigger ccpod init, exit
│
├─ 3. Load + merge config
│     load profile → sync config source if needed
│     load .ccpod.yml (optional) → merge layers
│     apply --no-state flag (forces state: ephemeral for this run)
│     → ResolvedConfig
│
├─ 4. Ensure image
│     if dockerfile: set tag = ccpod-local-<profile>-<sha256(dockerfile-path)>
│                   dockerfile path resolved relative to $PWD
│                   build if tag not found locally (or --rebuild)
│     else: check if image exists locally; pull if not
│
├─ 5. Ensure volumes
│     credentials dir: mkdir -p ~/.ccpod/credentials/<profile>/
│     plugins volume:  docker volume create ccpod-plugins-<profile> (idempotent)
│     state volume:    docker volume create ccpod-state-<profile>   (if persistent)
│                      OR: use --tmpfs /ccpod/state (if ephemeral)
│
├─ 6. Plugin delta-install prep
│     list installed plugins from plugin volume
│     diff against declared plugins in resolved config
│     pass delta as CCPOD_PLUGINS_TO_INSTALL env var to container
│
├─ 7. Parse .mcp.json (if exists at $PWD, and ports.autoDetectMcp: true)
│     extract HTTP/SSE MCP entries → additional port mappings
│
├─ 8. Start sidecars (if services: declared)
│     create shared network: ccpod-net-<projectHash>
│     start each sidecar with docker run -d --network <network>
│     label each: ccpod.profile=<name>, ccpod.project=<projectHash>, ccpod.type=<service-name>
│     sidecars reachable inside network by service name as hostname
│
├─ 9. Build ContainerSpec
│     image, workdir, env, mounts, network, ports, tty
│     labels: ccpod.profile=<name>, ccpod.project=<sha256(PWD)>, ccpod.type=main
│
├─ 10. Start Claude container
│     entrypoint assembles ~/.claude/
│     plugin delta-install runs
│     exec claude [args]
│
└─ 11. Attach
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

export function detectRuntime(): DetectedRuntime { ... }
```

Dockerode accepts a custom socket path, so after detection the rest of the code uses the same API regardless of runtime.

---

## 8. Container Labeling & Discovery

All ccpod-managed containers (main + sidecars) receive Docker labels so `ccpod ps` and `ccpod down` can find them without tracking state on disk.

| Label | Value | Purpose |
|---|---|---|
| `ccpod.profile` | profile name | Which profile spawned this container |
| `ccpod.project` | `sha256($PWD)` | Which project directory (scopes ps/down per project) |
| `ccpod.type` | `main` or sidecar service name | Distinguish Claude container from sidecars |
| `ccpod.version` | ccpod binary version | Debugging / compatibility |

**`ccpod ps`:** `docker ps --filter label=ccpod.profile` (or all ccpod containers if run from any dir)

**`ccpod down`:** `docker ps --filter label=ccpod.project=<sha256(PWD)>` → stop + remove all matches; idempotent if empty.

---

## 9. Network Policy Implementation

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

## 10. Base Image Strategy

**Image:** `ghcr.io/yorch/ccpod`

**Publish triggers (`.github/workflows/docker.yml`):**

| Event | Tags pushed |
|---|---|
| Push to `main` | `:main`, `:latest` |
| Push `v1.2.3` tag | `:1.2.3`, `:1.2` |

```dockerfile
# docker/Dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude"]
```

---

## 11. Directory Layout on Host

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

## 12. Testing Strategy

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

## 13. v1 Build Order

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
