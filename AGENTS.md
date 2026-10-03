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
bun test --isolate       # all tests (same as `bun run test`)
bun test tests/unit/config/merger.test.ts --isolate  # single test file
```

### Website commands

```sh
cd website
bun run dev              # start Astro dev server
bun run build            # build to website/dist/
bun run preview          # preview built site
bun scripts/build-og.mjs # re-render public/og.png (social card) from scripts/og.svg
```

SEO notes: the homepage overrides `<title>` via frontmatter `head` (Starlight would otherwise emit `ccpod | ccpod`); site-wide `og:type`, `og:image`, `twitter:image` and the `SoftwareApplication` JSON-LD live in `website/astro.config.mjs`. "Last updated" dates come from git history (`lastUpdated: true`), so the deploy workflow checks out with `fetch-depth: 0`, and `Footer.astro` must keep rendering Starlight's default footer (it carries the date, edit link, and prev/next). Task-oriented guides live in `website/src/content/docs/guides/`.

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
| `src/cli/validate.ts` | `validateProfileArg` — shared `--profile` name validation for all CLI commands |
| `src/cli/profile-arg.ts` | `resolveProfileName` — `--profile` → project `.ccpod.yml` → `default`, validated and existence-checked (use this in new profile-scoped commands) |
| `src/cli/errors.ts` / `src/cli/args.ts` | `exitWithError` / `formatCliError` (uniform `error:` output, Zod issues listed) and `toArray` / `rejectExtraPositionals` (citty silently drops undeclared positionals) |
| `src/cli/auth-proxy.ts` | `withAuthProxy` — starts/stops the auth proxy around a callback and hands back the base URL + sentinel key for `buildContainerSpec` |
| `src/cli/session.ts` | `runSession` — shared by `ccpod shell` and `ccpod exec` (exec into the running container, else a separate `-shell` container) |
| `src/cli/project-trust.ts` | One-time, remembered approval of a project-selected profile (`~/.ccpod/trusted-projects.json`) |
| `src/container/list.ts` | `listCcpodContainers` — the single typed `docker ps` query for ccpod containers; throws when docker fails (callers delete things based on it) |
| `src/cli/commands/prune.ts` | `ccpod prune` — remove stopped containers, orphaned networks, unreferenced plugin volumes, orphaned per-project state dirs (project path recorded in a `.ccpod-project` marker no longer exists) |
| `src/cli/commands/doctor.ts` | `ccpod doctor` — `collectChecks` (runtime, config, auth, image, sync freshness) |
| `src/auth/proxy.ts` | `AuthProxy` — HTTP proxy that translates sentinel API key into OAuth bearer token (proxy auth mode) |
| `src/auth/keychain.ts` | `readHostOAuthCredentials` / `writeHostOAuthCredentials` — read/write host OAuth credentials (macOS Keychain or `~/.claude/.credentials.json`) |

### Storage layout

```
~/.ccpod/
  config.yml             # global ccpod settings (autoCheckUpdates, etc.)
  profiles/<name>/
    profile.yml          # profile config
    config/              # Claude config dir (if source: git, cloned here)
  credentials/<name>/    # auth tokens/keys
  state/<name>/          # persistent state (when state: persistent, stateIsolation: per-profile)
  state/<name>/<hash>/   # per-project state (when state: persistent, stateIsolation: per-project)
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

- **Profile names** are validated by Zod regex `/^[a-zA-Z0-9_-]{1,64}$/` — enforced at parse time in `schema.ts` and at the CLI entry point via `validateProfileArg()` (`src/cli/validate.ts`). Every command that accepts `--profile` calls `validateProfileArg` before passing the name to `profileExists`, `getProfileDir`, `getStateDir`, etc., preventing path traversal (`../etc`) and shell metacharacter injection through the profile name. The shared setup helper `setupContainer` also validates, covering `run` and `shell`.
- **`--file` arg** in `run.ts` is normalized and rejected if it starts with `..` or is absolute.
- **Config temp dirs** live under a private per-uid parent `${tmpdir}/ccpod-u<uid>` (created `0o700`, verified owned by us and not a symlink; content-addressed dirs unused for 14 days are swept), so another user on a shared host cannot pre-seed or race the deterministic per-content path. Dirs are `0o700`, files `0o600`, and the merged config is assembled in a `mkdtemp` dir then atomically `rename`d into place (a reader never sees a half-populated mount). On reuse, the writer `lstat`s `outDir` and refuses it if it is a symlink, not a directory, or owned by a different uid.
- **Per-profile directories** — `profilesDir()`, `credentialsBase()`, and `getStateDir()` all `mkdir` with `mode: 0o700`, so another local user cannot read a profile's config, credentials, or Claude conversation state. The `~/.ccpod` base dir itself is also created `0o700` by `ensureCcpodDirs()` and `saveGlobalConfig()`, with `chmodSync` to tighten pre-existing dirs that may have been created with looser perms by prior versions.
- **`.mcp.json`** is parsed through a Zod schema (`src/mcp/parser.ts`): the server map is capped at 64 entries, auto-exposed HTTP/SSE ports must be in `1–65535`, and both JSON-parse and schema-validation failures are surfaced via `console.warn` rather than silently swallowed. Symlinked `.mcp.json` files are rejected via `lstatSync` — an untrusted project could otherwise point `.mcp.json` at an arbitrary host file (e.g. `/etc/shadow`) to probe readability. The same symlink rejection applies to `.ccpod.yml` in `findProjectConfig` (protecting all callers, including `config validate`).
- **Resolved credential + forwarded env** are passed to the container as bare `-e KEY` flags with the values injected into the `docker` CLI's own environment (`ContainerSpec.secretEnv` → `dockerSpawn` `extraEnv`), never as `-e KEY=VALUE` argv — so secrets don't appear in `ps` / `/proc/<pid>/cmdline`. ccpod's own `CCPOD_*` control vars stay as plain flags.
- **Restricted network** (`docker/entrypoint.sh`) fails **closed**: if `iptables` is missing or any load-bearing rule (loopback, established, default-deny) cannot be installed, the container aborts rather than run with unrestricted egress. IPv6 is locked down via `ip6tables` (fail-closed when the kernel has IPv6 but `ip6tables` is absent), and DNS is scoped to `/etc/resolv.conf` nameservers instead of an open `:53`.
- **`image.dockerfile`** relative paths resolve against the profile directory (`resolveProfileDockerfile` in `src/profile/manager.ts`), never the project checkout — otherwise a cloned repo's Dockerfile would be built and run with the profile's credentials. `{{profile_dir}}` and absolute paths still work; `ccpod image build --dockerfile` stays relative to cwd (user-typed).
- **docker binary resolution** — `runtime/docker.ts` resolves `docker`/`podman` to an absolute path from ccpod's own `PATH` before merging `extraEnv` into the child environment, so a `PATH` in forwarded env cannot redirect which binary is executed.
- **Entrypoint root PATH** — `docker/entrypoint.sh` runs root-side commands (`cp`, `chown`, `iptables`, `gosu`) with a fixed root-owned `PATH`; only the `node` user gets the image/profile `PATH` (`USER_PATH`). `/ccpod/credentials` is not `chown`ed (only root touches it), so the host's 0700 credentials dir never changes owner on Linux.
- **`SSH_AUTH_SOCK`** is rejected if it contains `:` (would corrupt Docker bind spec).
- **Runtime detection** (`runtime/detector.ts`) honors a set `DOCKER_HOST` (remote `tcp://`/`ssh://`, or an existing `unix://` socket) before auto-detecting OrbStack / Docker (incl. rootless `$XDG_RUNTIME_DIR/docker.sock`) / Colima / Podman.
- **Host uid on Linux** — the builder passes `CCPOD_HOST_UID/GID` and the entrypoint remaps `node` to them, so bind mounts (project, `~/.ccpod/state`) stay owned by the host user.
- **Profile identity** — the profile *directory name* is authoritative; `loadProfileConfig` overrides a differing `name:` (with a warning) so a copied profile can't share another's credentials, state or container.
- **`DOCKER_SOCKET_PATH`** env var overrides the hardcoded `/var/run/docker.sock` path (useful in tests and non-standard Docker setups).
- **Profile `config.repo`** must use `https://`, `http://`, `ssh://`, `git://`, or scp-style (`user@host:path`). **`config.ref`** rejects values starting with `-`, containing `..`, or carrying shell metacharacters — closes git option-injection (`--upload-pack=...`) RCE.
- **`auth.keyFile`** must point inside `~/.ccpod/` (typically `~/.ccpod/credentials/<profile>/...`). At read time the resolver `realpathSync`-es the path and rejects it if the symlink target escapes `~/.ccpod/` — schema validation alone is a string-prefix check and would otherwise let a symlink under `~/.ccpod/` redirect to `/etc/shadow`. Use `keyEnv` to load keys stored elsewhere.
- **Proxy auth mode** (`auth.type: proxy`) eliminates the OAuth refresh-token rotation race between concurrent ccpod containers. Instead of copying `.credentials.json` into each container (which creates independent stores of the same rotating refresh token), ccpod starts a local HTTP proxy (`src/auth/proxy.ts`) before the container. The container runs claude in API-key mode with a format-valid sentinel key (`sk-ant-api03-ccpod-proxy-...`) and `ANTHROPIC_BASE_URL` pointing at the proxy. The proxy validates the sentinel, strips the `x-api-key` header, adds `Authorization: Bearer <real-oauth-access-token>`, and forwards to `api.anthropic.com`. The proxy holds the only OAuth session, refreshes the access token with a single-flight lock (proactively before expiry and on-demand on 401), and writes refreshed tokens back to the host Keychain. No `.credentials.json` enters the container, no credential mount is created, and the entrypoint skips credential copy-in/copy-out. Multiple containers share one proxy, which serializes refreshes and serves all consumers from one cache. **Limitation:** if native `claude` runs concurrently on the host and refreshes the same OAuth session independently, it can invalidate the proxy's refresh token. The proxy re-reads the host credential store on `invalid_grant` to recover, but a brief window of 401s is possible. On macOS the proxy binds to `127.0.0.1` (Docker Desktop routes `host.docker.internal` to host loopback); on Linux it binds to the default bridge gateway IP (`docker network inspect bridge`, because `host-gateway` resolves there, not to loopback), falling back to `0.0.0.0` only if that cannot be determined. The sentinel key is checked in constant time. Under `network: restricted`, the entrypoint allows only the proxy's single port on the host gateway (derived from `ANTHROPIC_BASE_URL`), not the whole host. **Lifecycle:** the proxy lives exactly as long as the `ccpod run` / `ccpod shell` process that started it, and each container's `ANTHROPIC_BASE_URL`/key are fixed at creation — so `ccpod run` refuses to reattach to a running proxy-mode container (run `ccpod down` first), and detaching leaves a container that can no longer reach the API (ccpod warns). `ccpod shell` into an already-running container needs no proxy.
- **`profile install`** prompts for confirmation on `git` and `url` sources before fetching; pass `--yes` to bypass. `detectSource` (`src/profile/installer.ts`) classifies scp-style `user@host:path` URLs as `git` (matching `gitRepoSchema` in `schema.ts`), so they are not misinterpreted as base64 data.
- **Project config walk** (`findProjectConfig` in `src/config/loader.ts`) stops at the user's home directory — a `.ccpod.yml` found above `$HOME` (e.g. at `/` on macOS) is not loaded, preventing a stray parent config from overriding profile settings for every child project.
- **Updater (`ccpod update`)** verifies the downloaded binary's SHA-256 against `SHASUMS256.txt` from the release; releases without that asset are refused. The `install.sh` bootstrap performs the same verification (aborting on mismatch; warning and proceeding only when the release predates the checksum asset).
- **Project `.ccpod.yml` trust boundary** — a repo's project config is untrusted by default:
  - `services`: project-declared sidecar services are ignored unless the profile sets `allowProjectServices: true`. A cloned repo could otherwise start arbitrary container images on the same bridge network as the credential-bearing main container. When opted in, `services[].volumes` and `services[].ports` are still sanitized (see below) unless `allowProjectHostMounts` is also set.
  - `services[].volumes`: host-path mounts rejected; only named volumes allowed unless the profile sets `allowProjectHostMounts: true`.
  - `services[].ports`: `0.0.0.0:` and non-localhost binds rejected; two-part `host:container` is auto-localized to `127.0.0.1:`. Bracketed IPv6 is recognised — `[::1]:host:container` loopback is accepted, every `::`-expanding wildcard (`[::]`, `[0::]`, `[::0:0]`, `[0:0:0:0:0:0:0:0]`, …) is rejected.
  - top-level `ports.list` (main container) and auto-detected `.mcp.json` ports from project are published on `127.0.0.1` only, not `0.0.0.0` — `parsePorts` tags project-sourced mappings with `hostIp: '127.0.0.1'` (profile-sourced ports keep Docker's default bind). Prevents a cloned repo from exposing the credential-mounted container to the LAN.
  - `env` entries from project may not use `${VAR}` interpolation (would exfiltrate host secrets), and may not set keys on `PROJECT_ENV_DENYLIST` (`src/auth/resolver.ts`) — the Anthropic credential/endpoint vars (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_*_BASE_URL`), proxy vars (`HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY`), `NODE_OPTIONS` / `BUN_OPTIONS` (code injection), binary/library hijack vars (`PATH`, `HOME`, `SHELL`, `BASH_ENV`, `ENV`, `IFS`, `CLAUDE_CONFIG_DIR`, plus every `LD_*` / `DYLD_*`), and TLS-trust vars (`NODE_EXTRA_CA_CERTS` / `NODE_TLS_REJECT_UNAUTHORIZED` / `SSL_CERT_FILE` / `SSL_CERT_DIR` / `CURL_CA_BUNDLE` / `REQUESTS_CA_BUNDLE`). These could redirect API traffic to exfiltrate the resolved credential, inject code into the credential-bearing process, or weaken TLS. Matched case-insensitively; ignored with a warning. Profile and `--env` entries are trusted and may set them. Bare-name entries (`GITHUB_TOKEN`, forwarding the host value) from project are ignored with a warning unless the profile lists the name in `allowProjectEnvForward` — otherwise it is the same exfiltration path as `${VAR}`. Project env entries with `CCPOD_*` or `DOCKER_*` prefixes are also blocked — `CCPOD_*` could override ccpod's own control vars (e.g. `CCPOD_NETWORK_POLICY`), and `DOCKER_*` (e.g. `DOCKER_HOST`) could redirect the docker CLI itself to an attacker-controlled daemon. `builder.ts` additionally strips `CCPOD_*` and `DOCKER_*` from `secretEnv` as defense-in-depth.
  - `network:` (`policy` and `allow`) is profile-owned — project `network` keys are ignored with a warning regardless of `merge` strategy, so a repo cannot downgrade a `restricted` profile to `full` or widen the allow-list.
  - `init:` commands are ignored unless the profile sets `allowProjectInit: true`.
  - **Project assets** (`.claude/`, `CLAUDE.md`, `.claude/settings.json`) are rejected if they are symlinks (a repo could otherwise point them at `~/.ssh` or `~/.aws/credentials` and have the target copied into `/ccpod/config`). `post-init.sh` is a reserved name that is never copied from profile or project config dirs — it is only generated from trust-gated `init` commands, so a project cannot bypass `allowProjectInit` by shipping its own.
  - **Project-selected profile** — `.ccpod.yml` `profile:` lets a repo choose among your local profiles, so the first time a project selects a given (non-`default`) profile ccpod asks for confirmation and remembers the approval in `~/.ccpod/trusted-projects.json` (0600, keyed by project realpath). Non-interactive runs fail unless already approved. An explicit `--profile` never prompts. Implemented in `src/cli/project-trust.ts`.
- **Project `.claude/settings.json`** deep-merges into profile settings (project wins on conflicts) — same trust level as `claudeArgs` passthrough. Only run ccpod against repos you control.
- **`setupContainer`** (`src/cli/commands/_setup.ts`) throws on error instead of calling `process.exit` — the calling commands (`run`, `shell`) catch and exit. This makes the setup pipeline testable with `await expect(...).rejects.toThrow(...)`. The global `unhandledRejection`/`uncaughtException` handler in `cli/index.ts` remains as a last-resort backstop.
- **`ccpod prune`** removes stopped ccpod containers, orphaned `ccpod-net-*` networks (no attached endpoints; skipped under `--profile`), unreferenced `ccpod-plugins-<profile>` volumes (no container references and profile no longer exists on disk), and orphaned per-project state dirs. A state dir is orphaned only when its `.ccpod-project` marker names a project path that no longer exists — container existence is not evidence (containers are not `--rm` and get removed by `down`/prune), and dirs without a marker are never auto-deleted. Supports `--dry-run`, `--profile`, and `--force`/`--yes`. Volume and state dir removal prompts for confirmation unless `--force` is given.
- **`stateIsolation`** (profile config, default `per-profile`) controls whether persistent state is shared across projects using the same profile (`per-profile`: `~/.ccpod/state/<profile>/`) or isolated per project (`per-project`: `~/.ccpod/state/<profile>/<projectHash>/`). When `per-project`, each project gets its own conversation history, todos, and statsig state — preventing cross-project state leakage when using the same profile for trusted and untrusted repos. `ccpod state clear` clears the current project's state by default; `--all` clears all state for the profile. `ccpod prune` cleans orphaned per-project state dirs.

### Testing

Always run tests with `--isolate` (each test file gets a fresh global/module registry; needs a recent Bun, 1.4+). Several files use `mock.module()` for Docker/filesystem isolation, and without isolation those mocks leak into other files, so results depend on file order — `bun test tests/unit --isolate --randomize` (or without `--isolate` to see what would leak) is a good check that a new test doesn't rely on leftovers. When mocking a module, spread its real exports (`...(await import(path))`) and override only what you need, so other importers keep working.

`AuthProxy` is tested end to end against local fake API/OAuth servers (`tests/unit/auth/proxy.upstream.test.ts`) via its `apiUpstream` / `tokenEndpoint` / `readCredentials` / `writeCredentials` options — never against the real network or the host Keychain.

The Docker image is only published from `main`, so PRs that touch `docker/` run `.github/workflows/docker-check.yml` (build for amd64, no push, then smoke-test `claude`/`bun`/`uv`). `uv` (the `FROM` tag) and `bun` (`ARG BUN_VERSION`) are pinned in `docker/Dockerfile`; `claude` is deliberately unpinned because it auto-updates.

Tests live in `tests/unit/` and `tests/integration/`. Unit tests use `bun:test`; `mock.module()` is used for Docker subprocess isolation in container tests.

## Workflow

- **Always work in a dedicated worktree** (e.g. `git worktree add -b <branch> /path/to/ccpod-<branch> origin/main`) unless the user explicitly says otherwise. Never commit directly to `main`.
- **Open a PR for every change** — no matter how small. Push the branch and use `gh pr create` with a clear title and description. Do not push directly to `main`.
- Clean up worktrees and local branches after the PR is merged.
- **Every PR that changes the `ccpod` package needs a Changeset** (`bun run changeset`, pick `ccpod`, choose patch/minor/major, write user-facing notes). CI rejects PRs without one (except the generated `changeset-release/*` version PR). Docs/website/CI-only PRs generally need a patch Changeset too, or `bun run changeset --empty` if nothing user-visible changed.

## Release

Releases are **Changeset-driven and PR-gated**. Never bump `package.json` by hand and never push a `v*` tag — GitHub Actions owns both.

1. Merging a PR with Changesets to `main` triggers `.github/workflows/release.yml`, which opens or updates the `chore: version packages` PR (bumps `package.json`, updates `CHANGELOG.md`, refreshes `bun.lock`, deletes the consumed Changesets).
2. Merging that version PR is the human approval of the version. The same workflow then re-runs `bun run verify`, cross-compiles the four binaries (`ccpod-{linux,darwin}-{x64,arm64}`), generates and validates `SHASUMS256.txt`, signs a build-provenance attestation per binary, and creates the `vX.Y.Z` release (tag created on the exact commit) with auto-generated notes.
3. After publishing, `release.yml` calls `docker.yml` (`workflow_call`) to push `ghcr.io/yorch/ccpod` tagged `X.Y.Z`, `X.Y`, and `latest`. This is explicit because tags created with `GITHUB_TOKEN` do not trigger `on: push: tags` workflows. `docker.yml` also still runs on every push to `main` (`latest`/`main` tags).

The workflow is idempotent: if the current version's release was tagged on an earlier commit it is a no-op (ordinary merge), unless the commit is a merged version PR, which fails (the version was already released elsewhere); if the tag is on the publishing commit, the release must contain exactly the four binaries plus `SHASUMS256.txt`, or it fails without replacing public assets. It only publishes commits associated with a merged `changeset-release/*` PR. The `cut-release` skill (`.claude/skills/cut-release/`) walks through the procedure. Repo settings required: `main` protected (PRs required) and Actions allowed to create pull requests. The version PR is created with `GITHUB_TOKEN`, so it does not trigger CI — do not make CI jobs required checks for it. If the image push is missed, run `gh workflow run docker.yml -f version=X.Y.Z`.

## Commit Checklist

Before every commit:

1. **Quality gates** — `bun run typecheck && bun test tests/unit/ --isolate && bun run check` must all pass
2. **Docs** — update `CLAUDE.md`, `website/src/content/docs/reference/internals.md`, or any affected docs to reflect the change
3. **Code review** — spawn a fresh subagent (the harness's built-in code reviewer, e.g. `code-reviewer` or `general-purpose`) to review the diff against the rest of the codebase; address any real bugs or meaningful risks before committing

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

<body>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`

Example: `feat(state): replace Docker volume with host bind mount`
