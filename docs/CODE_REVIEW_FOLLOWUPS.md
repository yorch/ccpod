# Code Review Follow-ups

Items identified during the comprehensive code review originally tracked on
branch `claude/comprehensive-code-review-uTT1C` (now deleted; the doc commit
introducing this file is the canonical record).

Format: each item has `area`, `file:line` references, a short description, and
a concrete suggested fix. Items are grouped by severity. Resolved items are
marked ✅ inline so future readers don't re-verify them.

> ✅ All CRITICAL (C1–C3), HIGH (H1, H3–H5), MUST-FIX correctness items, and
> the M2/M3/M5 medium-security items have landed. See the "Security
> invariants" section of `AGENTS.md` for the resulting trust boundary.

## Status

Every concrete bug-fix item from the original review (security, correctness,
should-fix, perf) is now closed. What remains is **architectural** work:
DRY/maintainability refactors, centralized logging/error handling, magic-string
extraction, and naming-consistency passes. Those are intentional design
choices — not bugs — and are not scheduled at the moment.

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

## MEDIUM — security (✅ addressed)

- ✅ **M1.** `writeMergedConfig` `lstat`s the deterministic `outDir`, refuses
  symlinks / non-dirs / foreign uids, and (with M9 below) requires a
  `.ccpod-ready` sentinel to consider the cache populated
  (`src/config/writer.ts`).
- ✅ **M2.** `profilesDir()`, `credentialsBase()`, and `getStateDir()` all
  `mkdir` with `mode: 0o700` (`src/profile/manager.ts`).
- ✅ **M3.** `.mcp.json` is parsed through a Zod schema that caps server
  entries at 64 and surfaces both JSON-parse and schema-validation failures
  via `console.warn` instead of silently swallowing them
  (`src/mcp/parser.ts`). `extractHttpMcpPorts` additionally rejects ports
  outside `1-65535` (Node's URL parser already rejects > 65535; this guards
  the lower bound).
- **M4.** *(intentionally skipped during the original review — kept for stable
  numbering.)*
- ✅ **M5.** `removeSidecarNetwork` returns `{ ok, stderr }` and `ccpod down`
  logs failures via `console.warn` (suppressing the benign
  "no such network" case) rather than swallowing the docker exit code
  (`src/container/sidecars.ts`, `src/cli/commands/down.ts`).

---

## MUST-FIX — correctness (✅ addressed)

1. ✅ **`ccpod down` mismanages sidecar networks** — `down.ts` collects every
   `ccpod.project` label touched by the run, then only removes each
   `ccpod-net-<hash>` once no containers reference that hash. `--all`
   cleans networks per project. The inspect-per-container loop is collapsed
   to a single `docker ps --format` round-trip.
2. ✅ **No SIGINT / SIGTERM handlers in headless run** —
   `src/cli/commands/run.ts:installSignalForwarding` registers SIGINT/SIGTERM
   handlers that issue `docker stop -t 5 <name>` for the active container
   in headless mode. TTY mode relies on docker's existing forwarding; a
   second Ctrl+C re-arms the default handler so it kills ccpod immediately.
3. ✅ **Sidecar startup atomicity / `ensureNetwork` TOCTOU** —
   `src/container/sidecars.ts:startSidecars` now starts sidecars via
   `Promise.all` and rolls back any containers it actually started this run
   if any service throws. `ensureNetwork` accepts `already exists` stderr
   from a racing concurrent `ccpod run` and falls back to re-inspecting the
   network so docker's wording variations don't surface as fatal errors.
4. ✅ **`${VAR:-default}` empty-string fallback** —
   `interpolateHostEnv` matches POSIX (`src/auth/resolver.ts`).
5. ✅ **`isNewer` pre-release / 2-component tags** —
   `src/update/checker.ts` parses with
   `/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/`, treats missing parts as 0, and
   silently ignores pre-release/build suffixes.
6. ✅ **`downloadAndReplace` tmp cleanup + EXDEV** —
   `src/update/updater.ts` wraps the rename in try/finally and falls back
   to copy+unlink on EXDEV.
7. ✅ **`runContainer` / `shellContainer` "no such container" race** —
   `docker rm` stderr matching `/no such container/i` is now treated as
   concurrent removal (`src/container/runner.ts`).
8. ✅ **`computeProjectHash` platform stability** — `realpathSync` is now
   applied to the project dir before hashing, so symlinked / case-folded
   paths collapse to one container name on APFS / macOS
   (`src/container/builder.ts`). Falls back to the raw string when the path
   does not yet exist.
9. ✅ **`writeMergedConfig` rename race** — the writer now writes a
   `.ccpod-ready` sentinel last, `validateOwnedDir` requires it on reuse,
   and `clearBrokenOutDir` removes any sentinel-less leftover tree owned by
   the current uid so an atomic rename can replace it
   (`src/config/writer.ts`). Concurrent readers no longer see a partially
   populated tree.
10. ✅ **`computeProjectHash` reinvented inline in down** —
    `src/cli/commands/down.ts` imports `computeProjectHash` from
    `src/container/builder.ts`.

---

## SHOULD-FIX — correctness (✅ addressed)

- ✅ **Git ref as commit SHA fails** — `syncGitConfig` now detects
  SHA-shaped refs and uses clone-then-`checkout` rather than the invalid
  `--branch <sha>` form (`src/profile/git-sync.ts`).
- ✅ **Partial clone leaves corrupt configDir** — the clone is wrapped in
  try/catch; on failure the half-populated `configDir` is removed so the
  next run re-clones rather than skipping ahead to a broken fetch
  (`src/profile/git-sync.ts`).
- ✅ **`mergeConfigs` array concat duplicates in `network.allow`** —
  deduped via `new Set(...)` (`src/config/merger.ts`).
- ✅ **`services` deep-merge replaces wholesale** — `mergeServices` now
  deep-merges per service so project additions to `env` don't replace the
  whole profile service block (`src/config/merger.ts`).
- ✅ **`parseMcpJson` silently swallows errors** — both JSON parse failures
  and schema validation failures emit a `console.warn` with the underlying
  reason (`src/mcp/parser.ts`).
- ✅ **MCP ports not range-validated** — see M3 above.
- ✅ **`detectSource` misclassifies `github.com/.../raw/...` URLs as git** —
  `isGitUrl` now rejects `raw.githubusercontent.com`,
  `gist.githubusercontent.com`, and any `github.com/<o>/<r>/{raw,blob}/...`
  path, falling through to `url` (`src/profile/installer.ts`).
- ✅ **Oauth credential presence not validated in headless mode** —
  `setupContainer` now refuses to start a headless oauth profile if
  `~/.ccpod/credentials/<profile>/.credentials.json` is missing, with a
  clear "run interactively first" message
  (`src/cli/commands/_setup.ts`).

---

## Performance (✅ addressed)

- ✅ **`src/update/updater.ts` streaming** — body is piped through
  `node:stream/promises::pipeline` while SHA-256 is computed incrementally.
- ✅ **`src/image/downloader.ts`** — Dockerfile + entrypoint downloads now
  run via `Promise.all`.
- ✅ **`src/cli/commands/down.ts`** — the two-inspect loop was collapsed to
  a single `docker ps --format` round-trip. Stop/rm calls are still
  sequential but that is rarely the bottleneck.
- ✅ **`src/container/sidecars.ts`** — sidecars now start in parallel via
  `Promise.all` (in the same change that landed rollback).
- **`src/config/writer.ts:hashProfileDir`** still walks the entire profile
  config dir including `mtimeMs` on every run. Caches break on
  `git checkout`. Re-think: either content-hash small files, or drop
  directory hashing. *(Open — design call rather than a bug.)*

---

## Test coverage (✅ addressed for landed fixes)

- ✅ `src/container/builder.ts:computeProjectHash` — symlink-collapse and
  missing-path fallback covered in `tests/unit/container/builder.test.ts`.
- ✅ `src/container/runner.ts` — "no such container" race covered in
  `tests/unit/container/runner.test.ts`.
- ✅ `src/config/writer.ts` — sentinel write + reuse covered in
  `tests/unit/config/writer.test.ts`.
- ✅ `src/mcp/parser.ts` — malformed JSON, schema invalidity, the 64-server
  cap, and port range covered in `tests/unit/mcp/parser.test.ts`.
- ✅ `src/profile/git-sync.ts` — SHA-shaped ref clone and partial-clone
  cleanup covered in `tests/unit/profile/git-sync.test.ts`.
- ✅ `src/profile/installer.ts` — raw.githubusercontent.com,
  github.com/raw/, and github.com/blob/ cases covered.
- ✅ `src/config/merger.ts` — `network.allow` dedupe and per-service deep
  merge covered.
- `src/container/sidecars.ts` — network-race acceptance and partial-failure
  rollback are still not under unit test; both paths require mocking
  `dockerExec` extensively. *(Open — sidecars integration test is the
  better venue.)*
- `src/update/updater.ts` — EXDEV / ETXTBSY paths still untested.
- SIGINT in headless `ccpod run` — handler is fire-and-forget; a child-process
  integration test is the right shape.
- `src/cli/commands/{down,ps}.ts`, `src/cli/commands/state/clear.ts`,
  `src/plugins/*` — still no tests.

---

## Documentation

- ✅ **`ProfileConfig.description` was unused** — `profile list` now renders
  a `DESCRIPTION` column when any profile has one set.
- ✅ **Broken contributor instruction** — the commit checklist in
  `AGENTS.md` references the harness's built-in code reviewer.

---

## DRY / Maintainability (open by design)

The original review surfaced a number of refactor opportunities. None of
these are bugs; they are intentional design decisions about how much to
abstract. Kept here so they can be revisited in future passes if needed.

- **Three near-identical docker-arg builders** in `container/runner.ts`,
  `container/sidecars.ts`, and `cli/commands/down.ts`. Extract
  `flagPairs(flag, kv)` and `flagList(flag, values)` helpers in a new
  `src/container/dockerArgs.ts`.
- **Three duplicate `docker inspect --format ...` call sites** in `runner.ts`,
  `sidecars.ts`, and `down.ts`. Canonical implementation: `containerState`.
  Reuse it everywhere; expose a `containerInfo()` helper that returns
  name+status in a single inspect call.
- **Two identical `arrayMerge` closures** in `src/cli/commands/_setup.ts`.
  Hoist to a module-level constant.
- **Identical ZodError formatting** in `src/cli/commands/run.ts` and
  `src/cli/commands/shell.ts`. Extract `handleCliError(err)`.
- **`readIfExists` / `readJsonIfExists` duplicated** across
  `src/cli/commands/_setup.ts` and `src/cli/commands/config/show.ts`.
  Move to `src/util/fs.ts`.
- **Hand-written `ProfileConfig` / `ProjectConfig` interfaces in
  `src/types/index.ts`** parallel Zod schemas in `src/config/schema.ts` and
  will drift. Replace with `z.infer<typeof profileConfigSchema>`.
- **Unchecked `JSON.parse … as` sites:** `src/cli/commands/ps.ts`,
  `src/cli/commands/_setup.ts`, `src/update/checker.ts`,
  `src/update/updater.ts`. Define Zod schemas for each. (`.mcp.json` is
  already done.)
- **`init/wizard.ts` is 751 lines.** Split into `src/init/steps/auth.ts`,
  `src/init/steps/image.ts`, etc. The auth detection logic belongs in
  `src/auth/detector.ts`, not init.
- **`_setup.ts:setupContainer` is a 213-line 9-stage pipeline.** Split each
  stage into a named function.
- **Library code does `console.warn`** in `src/auth/resolver.ts` and
  `src/mcp/parser.ts`. Return warnings to the caller; let the CLI layer
  render them.
- **Magic strings duplicated everywhere:** `/workspace`, `/ccpod/config`,
  `/ccpod/credentials`, `/ccpod/plugins`, `/ccpod/state`, hash truncation
  length `16`, container/network/volume prefixes (`ccpod-net-`, `ccpod-svc-`,
  `ccpod-plugins-`, `ccpod-tmp-`), default git ref `'main'`. Move to
  `src/constants.ts`. (Partial: `src/constants.ts` exists but only holds
  GitHub URL constants.)
- **Naming inconsistencies:** `profileName` vs `name` vs `profile`; `cwd` vs
  `projectDir` vs `workdir`; `mergedConfigDir` vs `outDir`.
- **`mergeConfigs` has two structurally identical return branches.** Compute
  variant parts up-front then return one object.
- **`container/builder.ts` couples downward** to `profile/manager` and
  `runtime/detector`. Pass resolved paths/runtime as inputs instead.
- **No centralized logger.** Mix of `console.log` / `chalk.dim` /
  `process.stdout.write` across all command modules. Add `src/util/logger.ts`
  with `info/warn/error/dim/success` and a `--quiet` / `--json` mode.
- **No centralized error handling.** Many ad-hoc `process.exit(1)` sites;
  only two commands render Zod errors nicely. Define
  `class CcpodError extends Error` and route all CLI errors through a single
  top-level handler.
