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

Most shared types live in `src/types/index.ts`. The `ContainerSpec` type is the exception — it is declared in `src/container/builder.ts` next to its builder.

```typescript
export type SyncStrategy = 'always' | 'daily' | 'pin';
export type PermissionsPreset = 'conservative' | 'moderate' | 'permissive';

type MergeStrategy = 'deep' | 'override';
type StateMode = 'ephemeral' | 'persistent';
type NetworkPolicy = 'full' | 'restricted';
type AuthType = 'api-key' | 'oauth';
type ClaudeMdMerge = 'append' | 'override';

interface PortsConfig {
  autoDetectMcp: boolean;
  list: string[];
}

interface PortMapping {
  host: number;
  container: number;
}

export interface ServiceConfig {
  image: string;
  env?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
}

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
  init: string[];
  auth: {
    type: AuthType;
    keyEnv?: string;
    keyFile?: string;
  };
  permissions?: PermissionsPreset;
  plugins: string[];
  state: StateMode;
  ssh: {
    agentForward: boolean;
    mountSshDir: boolean;
  };
  isolation: boolean;
  network: {
    policy: NetworkPolicy;
    allow: string[];
  };
  ports: PortsConfig;
  services: Record<string, ServiceConfig>;
  env: string[];
  allowProjectHostMounts: boolean;
  allowProjectInit: boolean;
}

export interface ProjectConfig {
  profile?: string;
  merge?: MergeStrategy;
  claudeArgs?: string[];
  init?: string[];
  config?: {
    claudeMd?: ClaudeMdMerge;
  };
  network?: Partial<ProfileConfig['network']>;
  ports?: Partial<PortsConfig>;
  services?: Record<string, ServiceConfig>;
  env?: string[];
}

// Fully resolved config after all layers merged
export interface ResolvedConfig {
  profileName: string;
  image: string;
  dockerfile?: string;
  auth: ProfileConfig['auth'];
  autoDetectMcp: boolean;
  state: StateMode;
  ssh: ProfileConfig['ssh'];
  network: ProfileConfig['network'];
  ports: PortMapping[];
  services: Record<string, ServiceConfig>;
  env: Record<string, string>;
  init: string[];
  plugins: string[];
  mergedConfigDir: string;
  claudeArgs: string[];
}
```

`ContainerSpec` is consumed by `src/container/runner.ts` and by `buildContainerSpec` callers in `src/cli/commands/`.

## ~/.claude assembly

Four mount points feed `~/.claude/` inside the container. `docker/entrypoint.sh` assembles the final directory at startup:

```
Host mounts                     Inside container         ~/.claude/ result
─────────────────               ─────────────────        ─────────────────────
/tmp/ccpod-<hash>/   ──ro──►   /ccpod/config/      ──►  settings.json (copied)
  settings.json                                          CLAUDE.md     (copied)
  CLAUDE.md                                              skills/       (copied)
  hooks/                                                 hooks/        (copied)
  skills/                                                extensions/   (copied)
  extensions/                                            …             (copied)

~/.ccpod/creds/<p>/  ──rw──►   /ccpod/credentials/ ──►  *.json auth files
                                                          (overlays config)

ccpod-plugins-<p>   (volume) ► /ccpod/plugins/     ──►  plugins/  ← symlink
~/.ccpod/state/<p>/ (bind rw)► /ccpod/state/       ──►  projects/ ← symlink
                                                          todos/    ← symlink
                                                          statsig/  ← symlink
$PWD                 ──rw──►   /workspace/
```

Abridged `entrypoint.sh` (full source: [`docker/entrypoint.sh`](https://github.com/yorch/ccpod/blob/main/docker/entrypoint.sh)):

```sh
#!/bin/sh
set -e

# Entrypoint runs as root for setup (iptables, file seeding), then drops to
# the 'node' user (uid 1000) before exec'ing claude. This satisfies Claude
# Code's refusal to run --dangerously-skip-permissions as root.
NODE_HOME=/home/node
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${NODE_HOME}/.claude}"
mkdir -p "${CLAUDE_DIR}"

# 1. Seed config (CLAUDE.md, settings.json, skills/, hooks/, extensions/, …) — ro source → rw dest
if [ -d /ccpod/config ]; then
  cp -r /ccpod/config/. "${CLAUDE_DIR}/"
fi

# 2. Restore persisted auth files
if [ -f /ccpod/credentials/.credentials.json ]; then
  cp -f /ccpod/credentials/.credentials.json "${CLAUDE_DIR}/.credentials.json"
fi
if [ -f /ccpod/credentials/.claude.json ]; then
  cp -f /ccpod/credentials/.claude.json "${NODE_HOME}/.claude.json"
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

# Fix ownership so the node user can read/write everything
chown -R node:node "${CLAUDE_DIR}" "${NODE_HOME}" /ccpod/plugins /ccpod/state /ccpod/credentials 2>/dev/null || true

# 5. Run user-defined init commands (as node user, in /workspace)
if [ -f /ccpod/config/post-init.sh ]; then
  HOME="${NODE_HOME}" PATH="${PATH}" gosu node sh -c 'cd /workspace && sh /ccpod/config/post-init.sh'
fi

# 6. Delta-install missing plugins (comma-separated list from env)
if [ -n "${CCPOD_PLUGINS_TO_INSTALL}" ]; then
  for plugin in $(printf '%s' "${CCPOD_PLUGINS_TO_INSTALL}" | tr ',' '\n'); do
    if [ -n "${plugin}" ] && [ ! -d "${CLAUDE_DIR}/plugins/${plugin}" ]; then
      HOME="${NODE_HOME}" PATH="${PATH}" gosu node claude plugin install "${plugin}" 2>/dev/null || true
    fi
  done
fi

# 7. Network restriction — iptables OUTPUT rules when policy=restricted
#    (requires --cap-add NET_ADMIN; ccpod adds this automatically)
if [ "${CCPOD_NETWORK_POLICY}" = "restricted" ]; then
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  for host in $(printf '%s' "${CCPOD_ALLOWED_HOSTS:-}" | tr ',' '\n'); do ...done
  iptables -A OUTPUT -j DROP
fi

# Shell mode (ccpod shell): exec directly so bash gets TTY process group control.
if [ "${CCPOD_SHELL_MODE}" = "1" ]; then
  exec env HOME="${NODE_HOME}" PATH="${PATH}" gosu node "$@"
fi

# Normal mode: run as background job so signals forward cleanly.
# On exit, write credentials back so they survive container removal.
HOME="${NODE_HOME}" PATH="${PATH}" gosu node "$@" &
CHILD_PID=$!
trap "kill -TERM $CHILD_PID 2>/dev/null" TERM INT HUP
wait $CHILD_PID || STATUS=$?
STATUS=${STATUS:-0}
cp -f "${CLAUDE_DIR}/.credentials.json" /ccpod/credentials/.credentials.json 2>/dev/null || true
cp -f "${NODE_HOME}/.claude.json" /ccpod/credentials/.claude.json 2>/dev/null || true
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

### Env forwarding (`resolveEnvForwarding`)

`src/auth/resolver.ts:resolveEnvForwarding` collapses `profile.env`, `projectConfig.env`, and CLI `--env` overrides into a single `Record<string, string>`. Each entry has one of three forms:

- `KEY` — forward `process.env.KEY` (entry skipped if unset on host)
- `KEY=value` — literal value
- `KEY=...${VAR}...` / `KEY=...${VAR:-default}...` — interpolate host vars into the value

Interpolation is governed by `INTERPOLATION_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g`. Missing host vars without `:-default` resolve to empty string and warn once per unique name. Interpolation runs on `env` values only — other config string fields are taken verbatim by design (limits attack surface from project-controlled `.ccpod.yml`).

**Project entries cannot interpolate.** Because a repo's `.ccpod.yml` is untrusted input, `${VAR}` in a project-sourced entry throws an error rather than reading from `process.env`. Profile- and CLI-sourced entries retain full interpolation. Bare `KEY` forwarding and `KEY=literal` still work everywhere.

Source precedence: profile → project → CLI override (later wins).

### Project config trust boundary

A repo's `.ccpod.yml` ships with the codebase being run inside the sandbox, so it is treated as untrusted by default. `mergeConfigs` enforces:

- `services[].volumes` from project must be named volumes (`<name>:<path>[:opts]`). Host-path mounts (`/foo`, `./foo`, `~/foo`) are rejected.
- `services[].ports` from project may bind only to `127.0.0.1` / `localhost` / `::1`. Two-part `host:container` entries are auto-rewritten to `127.0.0.1:host:container`. Bracketed IPv6 is parsed explicitly so `[::1]:host:container` loopback is accepted and every `::`-expanding wildcard (`[::]`, `[0::]`, `[::0:0]`, `[0:0:0:0:0:0:0:0]`, …) is rejected with an "all IPv6 interfaces" error.
- `env` from project may not use `${VAR}` interpolation (see above).
- `init:` from project is dropped (with a one-line `console.warn`).

To opt out, the profile may set `allowProjectHostMounts: true` (for sidecar volumes/ports) or `allowProjectInit: true` (for init commands). Both default to `false`.

### Updater integrity

`ccpod update` requires each release to publish a `SHASUMS256.txt` asset alongside the binaries. The updater fetches `SHASUMS256.txt` and the platform asset in parallel, then streams the response body through `createHash('sha256')` into a write pipeline (`node:stream/promises#pipeline`). The hash is computed as bytes arrive, so the 50–80 MB binary is never buffered twice in memory; it is compared to the entry for the platform asset before the temp file is moved into place. A missing `SHASUMS256.txt`, a missing entry, or a mismatch all refuse the install with a clear error and leave nothing on disk.

## Startup sequence

```
ccpod run [-- claude-args]
│
├─ 1. Detect container runtime (first matching socket wins)
│     try: OrbStack (~/.orbstack/run/docker.sock)
│          Docker   ($DOCKER_SOCKET_PATH or /var/run/docker.sock, ~/.docker/run/docker.sock)
│          Colima   (~/.colima/default/docker.sock, ~/.colima/docker.sock)
│          Podman   ($XDG_RUNTIME_DIR/podman/podman.sock)
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
│     if dockerfile: {{profile_dir}} placeholder expanded to ~/.ccpod/profiles/<profile>/
│                   tag = ccpod-local-<profile>-<sha256(dockerfile)>
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
├── unit/                              # 23 unit-test files; run without Docker
│   ├── auth/resolver.test.ts
│   ├── cli/config/{get,set}.test.ts
│   ├── config/{loader,merger,permissions,schema,writer}.test.ts
│   ├── container/{builder,runner}.test.ts
│   ├── global/config.test.ts
│   ├── image/{hash,manager}.test.ts
│   ├── init/wizard.test.ts
│   ├── mcp/parser.test.ts
│   ├── profile/{exporter,git-sync,installer,installer.git,lock,manager}.test.ts
│   ├── runtime/detector.test.ts
│   └── update/checker.test.ts
├── integration/
│   └── container/docker.test.ts       # requires a real Docker socket
└── fixtures/                          # profile.yml / .ccpod.yml / .mcp.json
```

## Runtime socket paths

`src/runtime/detector.ts` tries these sockets in order until one is reachable. OrbStack is preferred over Docker because OrbStack also installs the standard `/var/run/docker.sock` symlink, so this order ensures the native OrbStack socket is chosen when both exist:

```typescript
const RUNTIME_CANDIDATES = [
  {
    name: 'orbstack',
    sockets: [
      `${HOME}/.orbstack/run/docker.sock`,
    ],
  },
  {
    name: 'docker',
    sockets: [
      // Honors $DOCKER_SOCKET_PATH first, falling back to the default path
      DOCKER_SOCKET_PATH ?? '/var/run/docker.sock',
      `${HOME}/.docker/run/docker.sock`,
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

Override the Docker socket path entirely by setting `DOCKER_SOCKET_PATH` in your environment (useful for non-standard Docker installs and tests).

Once a runtime is detected, `src/runtime/docker.ts` selects the CLI binary: `podman` when the runtime name is `podman`, `docker` for everything else. No `podman-docker` shim required.

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
