---
title: Internals
description: Deep-dive reference — dependencies, type definitions, entrypoint assembly, startup sequence, config merging, runtime sockets, image tags, and testing.
---

Implementation details for contributors and advanced users.

## Dependencies

| Package | Purpose |
|---|---|
| `citty` | CLI framework (lightweight, Bun-native) |
| `zod` | Schema validation for config files |
| `yaml` | YAML parse/serialize |
| `deepmerge` | Deep-merge for `settings.json` |
| `@inquirer/prompts` | Interactive wizard prompts |
| `simple-git` | Git operations for profile sync |
| `chalk` | Terminal output colouring |

Docker operations use the `docker` CLI via `Bun.spawn` — no Docker SDK dependency.

## Core types

All shared types live in `src/types/index.ts`.

```typescript
export type SyncStrategy = 'always' | 'daily' | 'pin';
export type MergeStrategy = 'deep' | 'override';
export type StateMode = 'ephemeral' | 'persistent';
export type NetworkPolicy = 'full' | 'restricted';
export type AuthType = 'api-key' | 'oauth';
export type ClaudeMdMerge = 'append' | 'override';

export interface ProfileConfig {
  name: string;
  description?: string;
  claudeArgs: string[];
  config: {
    source: 'local' | 'git';
    path?: string;
    repo?: string;
    sync?: SyncStrategy;
    ref?: string;
  };
  image: {
    use: string;
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
    list: string[];
    autoDetectMcp: boolean;
  };
  services: Record<string, ServiceConfig>;
  env: string[];
}

export interface ProjectConfig {
  profile?: string;
  merge?: MergeStrategy;
  claudeArgs?: string[];
  config?: {
    claudeMd?: ClaudeMdMerge;
  };
  network?: Partial<ProfileConfig['network']>;
  ports?: Partial<PortsConfig>;
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
  env: Record<string, string>;
  mergedConfigDir: string;
  claudeArgs: string[];
}
```

## ~/.claude assembly

Four mount points feed `~/.claude/` inside the container. `docker/entrypoint.sh` assembles the final directory at startup:

```
Host mounts                     Inside container         ~/.claude/ result
─────────────────               ─────────────────        ─────────────────────
/tmp/ccpod-<hash>/   ──ro──►   /ccpod/config/      ──►  settings.json (copied)
  settings.json                                          CLAUDE.md     (copied)
  CLAUDE.md                                              skills/       (copied)
  hooks/                                                 hooks/        (copied)
  skills/

~/.ccpod/creds/<p>/  ──rw──►   /ccpod/credentials/ ──►  *.json auth files
                                                          (overlays config)

ccpod-plugins-<p>   (volume) ► /ccpod/plugins/     ──►  plugins/  ← symlink
~/.ccpod/state/<p>/ (bind rw)► /ccpod/state/       ──►  projects/ ← symlink
                                                          todos/    ← symlink
                                                          statsig/  ← symlink
$PWD                 ──rw──►   /workspace/
```

Full `entrypoint.sh`:

```sh
#!/bin/sh
set -e

CLAUDE_DIR="${HOME}/.claude"
mkdir -p "${CLAUDE_DIR}"

# 1. Seed config (CLAUDE.md, settings.json, skills, hooks) — ro source → rw dest
if [ -d /ccpod/config ]; then
  cp -r /ccpod/config/. "${CLAUDE_DIR}/"
fi

# 2. Restore persisted auth files
if [ -f /ccpod/credentials/.credentials.json ]; then
  cp -f /ccpod/credentials/.credentials.json "${CLAUDE_DIR}/.credentials.json"
fi
if [ -f /ccpod/credentials/.claude.json ]; then
  cp -f /ccpod/credentials/.claude.json "${HOME}/.claude.json"
fi

# 3. Plugins — symlink named volume so installs persist across runs
mkdir -p /ccpod/plugins
rm -rf "${CLAUDE_DIR}/plugins"
ln -sf /ccpod/plugins "${CLAUDE_DIR}/plugins"

# 4. State — symlink host bind mount or tmpfs
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

# 6. Network restriction — iptables OUTPUT rules when policy=restricted
#    (requires --cap-add NET_ADMIN; ccpod adds this automatically)
if [ "${CCPOD_NETWORK_POLICY}" = "restricted" ]; then
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  for host in $(printf '%s' "${CCPOD_ALLOWED_HOSTS:-}" | tr ',' '\n'); do ...done
  iptables -A OUTPUT -j DROP
fi

# Run claude as background job; signal-forward ensures docker stop works correctly.
# On exit, write credentials back so they survive container removal.
"$@" &
CHILD_PID=$!
trap "kill -TERM $CHILD_PID 2>/dev/null" TERM INT HUP
wait $CHILD_PID || STATUS=$?
STATUS=${STATUS:-0}
cp -f "${CLAUDE_DIR}/.credentials.json" /ccpod/credentials/.credentials.json 2>/dev/null || true
cp -f "${HOME}/.claude.json" /ccpod/credentials/.claude.json 2>/dev/null || true
exit $STATUS
```

**Credential persistence:** two auth files survive container removal via the bind-mounted credentials dir:

| File | Location inside container | Contains |
|---|---|---|
| `.credentials.json` | `$CLAUDE_CONFIG_DIR/.credentials.json` | OAuth access/refresh tokens |
| `.claude.json` | `$HOME/.claude.json` (ignores `CLAUDE_CONFIG_DIR`) | Account metadata, migration flags |

## Config merging pipeline

```
load_profile_config(name)
  → detect source (local | git)
  → git: sync_if_needed(strategy) → read files
  → local: read files directly
  → parse profile.yml (Zod validation)

load_project_config($PWD)
  → find .ccpod.yml walking up from $PWD
  → parse (Zod validation)
  → determine merge strategy (default: deep)

merge(profile_assets, project_overrides, strategy):
  settings.json  → deepmerge(profile, project)            // project wins on conflict
  CLAUDE.md      → claudeMdMerge(profile, project, mode)  // append or override
  skills/        → union(profile_skills, project_skills)  // skip symlinks
  enabledPlugins → union(...)  // or replace if strategy=override
  hooks/         → mergeArraysByEventType(profile, project)
  marketplaces   → { ...profile_markets, ...project_markets }

write_merged_config(result) → /tmp/ccpod-<sha256(content)>/
  // deterministic path: same content = same dir = skip re-write
```

## Startup sequence

```
ccpod run [-- claude-args]
│
├─ 1. Detect container runtime
│     try: OrbStack (~/.orbstack/run/docker.sock)
│          Docker (/var/run/docker.sock, ~/.docker/run/docker.sock)
│          Colima (~/.colima/default/docker.sock, ~/.colima/docker.sock)
│          Podman ($XDG_RUNTIME_DIR/podman/podman.sock)
│     error if none available
│
├─ 2. Resolve profile name
│     --profile flag > .ccpod.yml profile: field > "default"
│     if profile missing → trigger ccpod init, exit
│
├─ 3. Load + merge config
│     load profile → sync config source if needed
│     load .ccpod.yml (optional) → merge layers
│     apply --no-state (forces state: ephemeral for this run)
│     → ResolvedConfig
│
├─ 4. Ensure image
│     if dockerfile: tag = ccpod-local-<profile>-<sha256(dockerfile)>
│                   context = dirname(dockerfile) if absolute, else $PWD
│                   build if tag absent (or --rebuild)
│     else: check locally; pull if absent
│
├─ 5. Ensure volumes
│     credentials dir: mkdir -p ~/.ccpod/credentials/<profile>/
│     plugins volume:  docker volume create ccpod-plugins-<profile> (idempotent)
│     state dir:       mkdir -p ~/.ccpod/state/<profile>/    (if persistent)
│                      OR: --tmpfs /ccpod/state              (if ephemeral)
│
├─ 6. Plugin install prep
│     set CCPOD_PLUGINS_TO_INSTALL=<comma-list>
│     entrypoint does delta-install (skips dirs that already exist)
│
├─ 7. Parse .mcp.json (if present and ports.autoDetectMcp: true)
│     extract HTTP/SSE entries → additional port mappings
│
├─ 8. Start sidecars (if services: declared)
│     create network: ccpod-net-<sha256($PWD)>
│     docker run -d --network <network> per service
│     labels: ccpod.profile, ccpod.project, ccpod.type=<service-name>
│
├─ 9. Build ContainerSpec
│     image, workdir, env, mounts, network, ports, tty, labels
│
├─ 10. Start Claude container
│      entrypoint assembles ~/.claude/
│      plugin delta-install runs
│      exec claude [args]
│
└─ 11. Attach
        interactive → raw TTY stdin/stdout/stderr
        headless    → pipe stdout/stderr, capture exit code
```

## Testing

Config merging (`merger.ts`, `schema.ts`) are pure functions — fully unit-testable without Docker.

Container logic (`builder.ts`) is tested with a mock `docker` subprocess via `mock.module()`.

Integration tests require a real Docker socket and a minimal test image.

```
tests/
├── unit/
│   ├── config/merger.test.ts
│   ├── config/schema.test.ts
│   ├── mcp/ports.test.ts
│   └── profile/lock.test.ts
├── integration/
│   └── container/run.test.ts
└── fixtures/
    ├── profile.yml
    ├── .ccpod.yml
    └── .mcp.json
```

## Runtime socket paths

`src/runtime/detector.ts` tries these sockets in order until one is reachable:

```typescript
const RUNTIME_CANDIDATES = [
  {
    name: 'docker',
    sockets: [
      '/var/run/docker.sock',
      `${HOME}/.docker/run/docker.sock`,
    ],
  },
  {
    name: 'orbstack',
    sockets: [
      `${HOME}/.orbstack/run/docker.sock`,
    ],
  },
  {
    name: 'colima',
    sockets: [
      `${HOME}/.colima/default/docker.sock`,
      `${HOME}/.colima/docker.sock`,
    ],
  },
  {
    name: 'podman',
    sockets: [
      `${XDG_RUNTIME_DIR}/podman/podman.sock`,
      `${HOME}/.local/share/containers/podman/machine/podman.sock`,
    ],
  },
];
```

Override detection entirely by setting `DOCKER_SOCKET_PATH` in your environment.

## Base image tags

The `ghcr.io/yorch/ccpod` image is published by `.github/workflows/docker.yml`:

| Git event | Tags pushed |
|---|---|
| Push to `main` | `:main`, `:latest` |
| Push tag `v1.2.3` | `:1.2.3`, `:1.2` |

Pin to a specific release in your profile with `image.use: ghcr.io/yorch/ccpod:1.2.3`.

## See also

- [Architecture overview](../architecture/)
- [Storage Layout](../storage/)
