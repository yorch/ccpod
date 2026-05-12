# Code Review Follow-ups

Items identified during the comprehensive code review on branch
`claude/comprehensive-code-review-uTT1C` but **not** addressed in that PR.
The branch in scope landed documentation refreshes and dead-code removal only;
the remainder is queued for follow-up PRs.

Format: each item has `area`, `file:line` references, a short description, and
a concrete suggested fix. Items are grouped by severity.

> ✅ All CRITICAL (C1–C3) and HIGH (H1, H3–H5) security items were addressed in
> the `claude/review-code-items-NoaPZ` branch. See the "Security invariants"
> section of `AGENTS.md` for the resulting trust boundary.

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

- **M1.** `writeMergedConfig` reuses deterministic `outDir` without checking
  ownership (`src/config/writer.ts:88-91, 119`). On multi-user machines another
  user could pre-create the dir. Fix: `lstat(outDir).uid === process.getuid()`
  check before reuse.
- **M2.** State and profiles directories created without `mode: 0o700`
  (`src/profile/manager.ts:54-58`, `manager.ts:31-34`). Credentials dir does
  use 0o700. Apply the same to `getStateDir` and `profilesDir`.
- **M3.** `.mcp.json` parser does not validate parsed structure with Zod and does
  not bound port range or count (`src/mcp/parser.ts:14-24,33`). A malicious
  `.mcp.json` could conflict with privileged host ports. Fix: validate via Zod;
  cap servers and require port in 1024-65535.
- **M5.** `removeSidecarNetwork` swallows exit codes (`src/container/sidecars.ts:47-49`)
  — silent failures.

---

## MUST-FIX — correctness

1. **`ccpod down` mismanages sidecar networks** (`src/cli/commands/down.ts:86-90`)
   - `--profile` removes the project's shared network even when sibling profiles
     are still using it; `--all` never removes networks at all. Fix: only remove
     the network when no main/sidecar containers reference it; iterate per
     project when `--all`.
2. **No SIGINT / SIGTERM handlers in headless run** (`src/cli/index.ts`,
   `src/container/runner.ts`). Ctrl+C orphans the container and skips
   sidecar/tmpdir cleanup. Fix: register handlers that propagate to the active
   docker child and tear down sidecars/temp dirs.
3. **Sidecar startup is not atomic** (`src/container/sidecars.ts:30-44`). Partial
   failure leaves containers running and the network in place. Also `ensureNetwork`
   has a TOCTOU race for concurrent `ccpod run` invocations. Fix: treat
   "already exists" as success; on per-service failure, tear down services started
   so far.
4. **`${VAR:-default}` does not fall back on empty string**
   (`src/auth/resolver.ts:40-47`). Contradicts CLAUDE.md's documented POSIX
   semantics. Fix: when syntax is `:-`, fall back on `undefined` OR empty.
5. **`isNewer` mishandles pre-releases and 2-component tags**
   (`src/update/checker.ts:44-55`). `v1.2.3-rc1` parses to `[1, 2, NaN]` →
   updates silently skipped. `v2.0` (2 parts) → treated as equal to anything.
   Fix: strip pre-release with `^v?(\d+)\.(\d+)\.(\d+)`, default missing parts to 0.
6. **`downloadAndReplace` leaks tmp file on EXDEV; no ETXTBSY handling**
   (`src/update/updater.ts:63-77`). Fix: try/finally on tmp cleanup; explicit
   ETXTBSY/EBUSY error message on macOS.
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
10. **`computeProjectHash` reinvented inline in down**
    (`src/cli/commands/down.ts:23-26`). Diverges silently if the algorithm
    changes. Fix: import `computeProjectHash` from `src/container/builder.ts`.

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
  `src/constants.ts`.
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

- **`src/update/updater.ts:60`** buffers the entire ~50-80 MB binary in memory.
  Stream `res.body` directly to `Bun.write`.
- **`src/image/downloader.ts:36-52`** fetches Dockerfile + entrypoint
  sequentially. `Promise.all` them.
- **`src/config/writer.ts:hashProfileDir` (~line 35)** walks the entire profile
  config dir including `mtimeMs` on every run. Caches break on `git checkout`.
  Re-think: either content-hash small files, or drop directory hashing.
- **`src/cli/commands/down.ts:50-83`** processes containers sequentially with
  two inspects each. Combine inspects (`{{.Name}}|{{.State.Status}}`) and
  `Promise.all` the loop.
- **`src/container/sidecars.ts:30-44`** starts sidecars sequentially. Parallelize.

---

## Test coverage gaps

- `src/container/sidecars.ts` — no tests for network race or partial-failure
  rollback.
- `src/update/updater.ts` — no tests for EXDEV / ETXTBSY paths.
- SIGINT handling in `runContainer` — no tests (because the handler doesn't
  exist yet — see Must-fix #2).
- `src/cli/commands/{down,ps}.ts`, `src/cli/commands/state/clear.ts`,
  `src/plugins/*` — no tests.
- `interpolateHostEnv` — missing coverage for empty-string + `:-` semantics
  (Must-fix #4).
- `isNewer` — missing pre-release and 2-component version tests
  (Must-fix #5).
- `detectSource` — missing `raw.githubusercontent.com` and
  `github.com/.../raw/...` cases.

---

## Documentation

These were noted but considered cosmetic enough to leave for a future pass:

- `ProfileConfig.description` is written by the wizard
  (`src/init/wizard.ts:578`) and documented in profile examples, but **never
  read** anywhere in `src/` or `tests/`. The annotation comment claims it is
  "shown in `ccpod profile list`" but `src/cli/commands/profile/list.ts` does
  not display it. Either wire it into `profile list` (preferred) or remove the
  field entirely from schema, types, and docs.
- `AGENTS.md` references a `feature-dev:code-reviewer` subagent in the commit
  checklist. Confirm it still exists in the harness; otherwise drop the
  instruction.
