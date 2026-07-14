# Project Guidelines

This file provides guidance to AI agents when working with code in this repository.

> `CLAUDE.md` is a symlink to `AGENTS.md` — any changes here should be reflected in `CLAUDE.md` and vice versa.

## Package manager

This project uses **bun** exclusively. Never use `npm`, `pnpm`, or `yarn`. Always run `bun install`, `bun run <script>`, `bun test`, etc. The website (`website/`) also uses bun — same rule applies there.

## Commands

```sh
bun run dev              # run CLI without building
bun run build            # compile to dist/ccpod binary
bun run typecheck        # tsc --noEmit
bun run check            # biome format + lint (writes fixes)
bun test                 # all tests
bun test tests/unit/config/merger.test.ts  # single test file
```

### Website commands

```sh
cd website
bun run dev              # start Astro dev server
bun run build            # build to website/dist/
bun run preview          # preview built site
```

## Architecture

`ccpod` is a CLI that runs Claude Code in Docker. Entry point: `src/cli/index.ts` (citty router).

### Config pipeline (the core flow)

`ccpod run` executes this pipeline in order:

1. **Load** — `src/config/loader.ts` reads `~/.ccpod/profiles/<name>/profile.yml` (profile) and walks up from `cwd` to find `.ccpod.yml` (project). Both validated via Zod schemas in `src/config/schema.ts`.
2. **Sync** — `src/profile/git-sync.ts` pulls the profile's config repo if `source: git`.
3. **Merge** — `src/config/merger.ts` combines profile + project using `merge: deep|override` strategy. CLAUDE.md files are merged separately via `mergeClaudes()` (append or override).
4. **Auth** — `src/auth/resolver.ts` resolves API key or OAuth credentials into env vars. Same module's `resolveEnvForwarding` collapses profile/project/CLI `env` lists, supporting bare `KEY` (forward host var), `KEY=value` (literal), and `KEY=${HOST_VAR}` / `KEY=${HOST_VAR:-default}` (interpolation, scoped to env values only).
5. **Config write** — `src/config/writer.ts` writes merged config to a temp dir mounted as `/ccpod/config` in the container.
6. **Container spec** — `src/container/builder.ts` builds the `ContainerSpec` (binds, env, ports, labels, tmpfs). Exports `computeProjectHash(dir)`.
7. **Sidecars** — `src/container/sidecars.ts` creates shared Docker network `ccpod-net-<hash>` and starts declared `services:` containers before the main container.
8. **Run** — `src/container/runner.ts` creates/reattaches/starts the container via `docker` CLI (`Bun.spawn`). TTY mode = interactive; headless mode (`--file`) streams logs.

### Key modules

| Path | Purpose |
|------|---------|
| `src/types/index.ts` | Shared types: `ProfileConfig`, `ProjectConfig`, `ResolvedConfig` (`ContainerSpec` lives in `src/container/builder.ts`) |
| `src/runtime/detector.ts` | Auto-detects OrbStack / Docker / Colima / Podman socket |
| `src/runtime/docker.ts` | `dockerExec` (capture stdout/stderr) and `dockerSpawn` (inherit stdio) |
| `src/profile/manager.ts` | `~/.ccpod/` directory layout, profile CRUD |
| `src/global/config.ts` | Read/write `~/.ccpod/config.yml` (global settings like `autoCheckUpdates`) |
| `src/mcp/parser.ts` | Reads `.mcp.json` to auto-expose MCP HTTP ports |
| `src/image/manager.ts` | Pull or `docker build` the container image |
| `src/container/sidecars.ts` | Shared network creation and sidecar container lifecycle |
| `src/update/checker.ts` | Checks GitHub releases for newer version |
| `src/update/updater.ts` | Downloads and replaces the ccpod binary in-place |
| `src/profile/installer.ts` | `detectSource` + `fetchProfileYaml` — source detection and YAML fetching for profile install |
| `src/profile/exporter.ts` | `exportProfile` — reads profile.yml and returns base64-encoded string for sharing |

### Storage layout

```
~/.ccpod/
  config.yml             # global ccpod settings (autoCheckUpdates, etc.)
  profiles/<name>/
    profile.yml          # profile config
    config/              # Claude config dir (if source: git, cloned here)
  credentials/<name>/    # auth tokens/keys
  state/<name>/          # persistent state (when state: persistent)
Docker volumes:
  ccpod-plugins-<profile>   # persistent plugin installs
```

### Container mounts

- `/workspace` — project dir (rw)
- `/ccpod/config` — merged Claude config dir (ro)
- `/ccpod/credentials` — auth credentials (rw)
- `/ccpod/plugins` — named volume for plugins
- `/ccpod/state` — host bind `~/.ccpod/state/<profile>/` (persistent) or tmpfs (ephemeral)

### Security invariants

- **Profile names** are validated by Zod regex `/^[a-zA-Z0-9_-]{1,64}$/` — enforced at parse time in `schema.ts`.
- **`--file` arg** in `run.ts` is normalized and rejected if it starts with `..` or is absolute.
- **Config temp dirs** live under a private per-uid parent `${tmpdir}/ccpod-u<uid>` (created `0o700`, verified owned by us and not a symlink), so another user on a shared host cannot pre-seed or race the deterministic per-content path. Dirs are `0o700`, files `0o600`, and the merged config is assembled in a `mkdtemp` dir then atomically `rename`d into place (a reader never sees a half-populated mount). On reuse, the writer `lstat`s `outDir` and refuses it if it is a symlink, not a directory, or owned by a different uid.
- **Resolved credential + forwarded env** are passed to the container as bare `-e KEY` flags with the values injected into the `docker` CLI's own environment (`ContainerSpec.secretEnv` → `dockerSpawn` `extraEnv`), never as `-e KEY=VALUE` argv — so secrets don't appear in `ps` / `/proc/<pid>/cmdline`. ccpod's own `CCPOD_*` control vars stay as plain flags.
- **Restricted network** (`docker/entrypoint.sh`) fails **closed**: if `iptables` is missing or any load-bearing rule (loopback, established, default-deny) cannot be installed, the container aborts rather than run with unrestricted egress. IPv6 is locked down via `ip6tables` (fail-closed when the kernel has IPv6 but `ip6tables` is absent), and DNS is scoped to `/etc/resolv.conf` nameservers instead of an open `:53`.
- **`SSH_AUTH_SOCK`** is rejected if it contains `:` (would corrupt Docker bind spec).
- **`DOCKER_SOCKET_PATH`** env var overrides the hardcoded `/var/run/docker.sock` path (useful in tests and non-standard Docker setups).
- **Profile `config.repo`** must use `https://`, `http://`, `ssh://`, `git://`, or scp-style (`user@host:path`). **`config.ref`** rejects values starting with `-`, containing `..`, or carrying shell metacharacters — closes git option-injection (`--upload-pack=...`) RCE.
- **`auth.keyFile`** must point inside `~/.ccpod/` (typically `~/.ccpod/credentials/<profile>/...`). At read time the resolver `realpathSync`-es the path and rejects it if the symlink target escapes `~/.ccpod/` — schema validation alone is a string-prefix check and would otherwise let a symlink under `~/.ccpod/` redirect to `/etc/shadow`. Use `keyEnv` to load keys stored elsewhere.
- **`profile install`** prompts for confirmation on `git` and `url` sources before fetching; pass `--yes` to bypass.
- **Shared OAuth credentials (host Keychain or another profile) are a one-time copy, not a live link.** `ccpod init` can seed a profile's `.credentials.json` from the macOS Keychain (`Claude Code-credentials`) or from an existing oauth profile (`src/init/wizard.ts` `writeKeychainCredentials`/`copyCredentials`). Anthropic's OAuth refresh tokens rotate on use — each refresh invalidates the previous refresh token server-side — so the copy and its source drift apart from that point on. If both are used concurrently (e.g. host `claude` and a ccpod container sharing the same original login), whichever side refreshes first silently logs the other out. The wizard warns and requires confirmation before creating such a copy (`confirmSharedOAuthRisk`); there is no automatic re-sync back to the Keychain or source profile. Prefer a fresh `OAuth (browser login)` per profile to avoid the collision entirely.
- **Updater (`ccpod update`)** verifies the downloaded binary's SHA-256 against `SHASUMS256.txt` from the release; releases without that asset are refused. The `install.sh` bootstrap performs the same verification (aborting on mismatch; warning and proceeding only when the release predates the checksum asset).
- **Project `.ccpod.yml` trust boundary** — a repo's project config is untrusted by default:
  - `services[].volumes`: host-path mounts rejected; only named volumes allowed unless the profile sets `allowProjectHostMounts: true`.
  - `services[].ports`: `0.0.0.0:` and non-localhost binds rejected; two-part `host:container` is auto-localized to `127.0.0.1:`. Bracketed IPv6 is recognised — `[::1]:host:container` loopback is accepted, every `::`-expanding wildcard (`[::]`, `[0::]`, `[::0:0]`, `[0:0:0:0:0:0:0:0]`, …) is rejected.
  - top-level `ports.list` (main container) and auto-detected `.mcp.json` ports from project are published on `127.0.0.1` only, not `0.0.0.0` — `parsePorts` tags project-sourced mappings with `hostIp: '127.0.0.1'` (profile-sourced ports keep Docker's default bind). Prevents a cloned repo from exposing the credential-mounted container to the LAN.
  - `env` entries from project may not use `${VAR}` interpolation (would exfiltrate host secrets), and may not set keys on `PROJECT_ENV_DENYLIST` (`src/auth/resolver.ts`) — the Anthropic credential/endpoint vars (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_*_BASE_URL`), proxy vars (`HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY`), `NODE_OPTIONS` (code injection), and TLS-trust vars (`NODE_EXTRA_CA_CERTS` / `NODE_TLS_REJECT_UNAUTHORIZED` / `SSL_CERT_FILE` / `SSL_CERT_DIR` / `CURL_CA_BUNDLE` / `REQUESTS_CA_BUNDLE`). These could redirect API traffic to exfiltrate the resolved credential, inject code into the credential-bearing process, or weaken TLS. Matched case-insensitively; ignored with a warning. Profile and `--env` entries are trusted and may set them.
  - `network:` (`policy` and `allow`) is profile-owned — project `network` keys are ignored with a warning regardless of `merge` strategy, so a repo cannot downgrade a `restricted` profile to `full` or widen the allow-list.
  - `init:` commands are ignored unless the profile sets `allowProjectInit: true`.
- **Project `.claude/settings.json`** deep-merges into profile settings (project wins on conflicts) — same trust level as `claudeArgs` passthrough. Only run ccpod against repos you control.

### Testing

Tests live in `tests/unit/` and `tests/integration/`. Fixtures in `tests/fixtures/`. Unit tests use `bun:test`; `mock.module()` is used for Docker subprocess isolation in container tests.

## Commit Checklist

Before every commit:

1. **Quality gates** — `bun run typecheck && bun test tests/unit/ && bun run check` must all pass
2. **Docs** — update `CLAUDE.md`, `website/src/content/docs/reference/internals.md`, or any affected docs to reflect the change
3. **Code review** — spawn a fresh subagent (the harness's built-in code reviewer, e.g. `code-reviewer` or `general-purpose`) to review the diff against the rest of the codebase; address any real bugs or meaningful risks before committing

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

<body>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`

Example: `feat(state): replace Docker volume with host bind mount`
