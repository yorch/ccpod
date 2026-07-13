# Code Review Follow-ups

Open items from the project's code reviews, queued for follow-up PRs. Each item
lists `area`, `file:line` references, a short description, and a concrete
suggested fix, grouped by category.

Resolved items have been pruned from this doc — their record lives in git
history and, for the security trust boundary, in the "Security invariants"
section of `AGENTS.md`. Identifiers `R#` are from the 2026-07 multi-agent
review; `M#` / `Must-fix #` / `SHOULD-FIX` are from the earlier comprehensive
review. Numbering is left stable (with gaps) so cross-references stay valid.

## Next up

Highest-leverage open items, in suggested order:

1. **Security hardening** — M2 (dir perms `0700` for profile/state), M3
   (`.mcp.json` Zod validation + port bounds), R11 (CLI profile-name validation).
2. **Container/runtime correctness** — R12 (image tag case), R13 (port-binding
   collisions), R14 (`mountSshDir` path), R16 (image build-context), R17
   (`down --all --profile` filter).
3. **Config/CLI & auth correctness** — R5 (`run --` passthrough), R7 (updater
   `ETXTBSY`), R18 (config-show masking), R20, R21, R23, R24, R27.
4. **DRY / maintainability, performance, and test-coverage** backlogs (below).

> **Addressed:** the trust-boundary trio (**R1–R3**) and dead-`claudeArgs`
> (**R4**); the container-lifecycle cluster **Must-fix #3 / #7 / #8**, **R6**,
> **R15**, **R19**, **R28**, R22; and the security-hardening batch
> **Must-fix #9** (per-uid config dir), **R8** (secrets off the cmdline),
> **R9** (fail-closed restricted network), **R10** (`install.sh` checksum),
> **M5** (`removeSidecarNetwork` exit code). See the "Security invariants"
> section of `AGENTS.md` and git history.

---

## Security

Untrusted project `.ccpod.yml` (and `.mcp.json`) can escalate past the trust
boundary documented in `AGENTS.md`. The R1–R3 escapes were closed (network is
profile-owned, project `env` denylists redirect/TLS keys, main-container
project/`.mcp.json` ports pinned to loopback), and the hardening batch **R8**
(secrets off the `docker run` cmdline), **R9** (fail-closed restricted network),
and **R10** (`install.sh` checksum) landed. Remaining items:

- **R11. CLI profile names bypass `NAME_RE`; `profile delete` does recursive
  deletes on unvalidated joined paths.** `src/profile/manager.ts:42,72-83`
  (`getProfileDir`/`deleteProfile` raw-`join`), reached from `delete.ts`,
  `create.ts`, and `--profile` in `run`/`state clear`. Only YAML/export/install
  paths validate. `ccpod profile delete '../x'` `rmSync(recursive)`s a
  traversed path (gated only by a `profile.yml` existing there). Self-inflicted
  but contradicts the "enforced at parse time" invariant. Fix: apply `NAME_RE`
  in `getProfileDir`/`deleteProfile` or at each CLI entry.

- **M2 + R26. Directory permissions are inconsistent.**
  `credentialsBase()` uses `mode: 0o700` (`src/profile/manager.ts:34`), but
  `profilesDir()` (line 25) and `getStateDir()` (line 56) create with default
  (0755) modes, so profile config and Claude conversation state are readable by
  other local users. Fix: apply `0o700` to both.

- **M3. `.mcp.json` is parsed without validation or port bounds.**
  `src/mcp/parser.ts:14-24,33`. No Zod validation of structure and no port
  range/count cap; a malicious `.mcp.json` could conflict with privileged host
  ports. Fix: validate via Zod; cap servers and require port in 1024–65535.
  (Range-validation and the silent JSON-error swallow below are part of this.)

---

## Correctness

### Config / CLI wiring

- **R5. `ccpod run -- <flags>` passthrough is double-parsed** (verified: citty
  0.2.2 yields `{prompt:"--verbose"}` for `rawArgs:['--','--verbose']`).
  `src/cli/commands/run.ts:89-106`. citty parses post-`--` tokens as the
  `prompt` positional *and* run.ts re-extracts them from `process.argv`, so
  they double-apply: `run -- --verbose` silently goes headless (`tty=false`)
  and passes `--verbose` twice; `run -- --model opus` hard-errors on the bare
  `opus`. Fix: derive the prompt from pre-`--` argv only.

- **R17.** `ccpod down --all --profile X` silently ignores `--profile` and
  removes every ccpod container (`src/cli/commands/down.ts:33` — filter only
  added when `!args.all`). Warn or honor the filter.

- **R18.** `config show` masks only env keys containing "key"/"token"
  (`src/cli/commands/config/show.ts:49`); `PASSWORD`/`SECRET`/`CREDENTIALS`
  names print in cleartext, including `--json`. Broaden the mask list.

- **R21.** `loadGlobalConfig` swallows all YAML parse errors and reverts to
  defaults (`src/global/config.ts:24-28`), silently re-enabling
  `autoCheckUpdates` on a typo. Emit a stderr warning.

- **R23.** `DOCKER_SOCKET_PATH` override is silently outranked by an installed
  OrbStack (`src/runtime/detector.ts:9-16`) — it only substitutes into the
  lower-ranked `docker` candidate. An explicit env override should win.

- **R27.** Wizard emits unquoted YAML for values with a leading `"`/`'`, and
  `keyEnv` unquoted (`src/init/wizard.ts:559-598`) → unparseable `profile.yml`.
  Broaden `q()`'s quote-trigger class.

- **`services` deep-merge replaces wholesale** instead of merging per-service
  fields (`src/config/merger.ts:50-53`). Surprises users who only want to add
  one env var to a sidecar.

- **Oauth credential presence is not validated** in headless mode
  (`src/cli/commands/_setup.ts:88-97`). Container fails opaquely with no auth.

### Container / runtime state handling

The container-lifecycle cluster (**Must-fix #3 / #7 / #8**, **R15**, **R19**,
**R28**) was addressed: `runContainer`/`shellContainer` now `rm -f`
paused/restarting/dead containers, tolerate a concurrently-removed container,
and refuse to attach a headless run to a live interactive session; sidecar
startup rolls back on partial failure and `ensureNetwork` re-checks on a create
race; `computeProjectHash` normalizes via `realpathSync` + darwin case-folding;
and `syncGitConfig` clones through a temp dir + atomic rename. **Must-fix #9**
(config-writer) is also addressed — output lives under a private per-uid `0700`
parent and is atomically renamed into place — and **M5** (`removeSidecarNetwork`
now surfaces its exit code). Remaining open items:

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

- **R16. `image build` and `run` build the same tag from different contexts.**
  `src/cli/commands/image/build.ts:66-68` uses `cwd`; `_setup.ts:163-167` uses
  `dirname(dockerfileAbs)`. `computeLocalImageTag` hashes Dockerfile content
  only, so whichever builds first wins the tag and the other reuses a
  divergently-built image; editing `entrypoint.sh` also never triggers a
  rebuild on `run`. Fix: unify the context; include context-file digests in
  the tag.

- **R12. Uppercase profile name breaks image build.** `src/image/hash.ts:16` +
  `src/config/schema.ts` name regex allows `A-Z`, but `computeLocalImageTag`
  embeds the name verbatim in a Docker tag, which must be lowercase →
  `ccpod run`/`image build` fail with "repository name must be lowercase".
  Fix: `.toLowerCase()` in the tag (hash already disambiguates).

### Auth / update

- **R7. `ccpod update` copy-fallback fails on the running binary** (verified:
  `ETXTBSY`). `src/update/updater.ts:169`. The EXDEV fallback
  `copyFileSync(tmp, targetPath)` opens the live executable for write →
  `ETXTBSY` on Linux (tmpfs-`/tmp` hosts: Fedora/Arch), so the update can never
  complete and `update.ts` surfaces a raw stack. Fix: copy to
  `${targetPath}.new` in the target dir, then `renameSync` over it (atomic,
  same filesystem).

- **R20.** `auth.keyFile` is always rejected when `~/.ccpod` is itself a
  symlink (`src/auth/resolver.ts:37-43` compares `realpathSync(keyPath)`
  against a non-realpath'd home). Fails closed. Fix: `realpathSync` the home
  dir before comparing.

- **R24.** `ccpod update` run via `bun run dev` replaces the user's `bun`
  binary (`src/cli/commands/update.ts:45` uses `process.execPath`). Guard:
  refuse when not a compiled `ccpod` build.

### Git-sync / installer

> **R6** (tag/changed-ref sync) and the partial-corrupt-configDir case were
> addressed: `syncGitConfig` resets to `FETCH_HEAD` and clones via a temp dir +
> atomic rename. The SHA-ref clone below is still open.

- **Git ref as commit SHA fails** — `git clone --depth 1 --branch <sha>` is
  invalid (`src/profile/git-sync.ts`). Detect SHA-shaped refs and fall back
  to clone-then-checkout.

- **R25 + `detectSource` URL misclassification.** `src/profile/installer.ts:35`
  classifies `github.com/.../blob/...` and `github.com/.../raw/...` file URLs
  as git clones. Fix: prefer `.git` suffix; `raw.githubusercontent.com` and
  `blob`/`raw` paths should be `url`.

- **`parseMcpJson` silently swallows JSON errors** (`src/mcp/parser.ts:19-23`).
  Log a warning. (Part of the M3 hardening.)

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
- **Array-valued config fields can accumulate duplicates** where profile and
  project lists concatenate (e.g. `claudeArgs`, `init`, `ports.list`). Dedupe
  where a duplicate is meaningless. (`network.allow` no longer takes project
  input after R1, so it is no longer a concern here.)
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

- **`src/image/downloader.ts:36-52`** fetches Dockerfile + entrypoint
  sequentially. `Promise.all` them.
- **`src/config/writer.ts:hashProfileDir` (~line 35)** walks the entire profile
  config dir including `mtimeMs` on every run. Caches break on `git checkout`.
  Re-think: either content-hash small files, or drop directory hashing.
- **`src/container/sidecars.ts`** starts sidecars sequentially. Parallelize —
  the rollback path added for Must-fix #3 must still clean up all started
  containers if any concurrent start fails.

---

## Test coverage gaps

- `src/container/sidecars.ts` — no tests for network race or partial-failure
  rollback.
- `src/update/updater.ts` — no tests for EXDEV / ETXTBSY paths (R7).
- SIGINT handling in headless `ccpod run` — no tests for
  `installSignalForwarding` in `src/cli/commands/run.ts`. The handler is
  fire-and-forget and hard to assert on without spawning a real subprocess;
  consider a child-process integration test.
- `src/cli/commands/{down,ps}.ts`, `src/cli/commands/state/clear.ts`,
  `src/plugins/*` — no tests.
- `detectSource` — missing `raw.githubusercontent.com` and
  `github.com/.../{raw,blob}/...` cases (R25).

---

## Documentation

- `ProfileConfig.description` is written by the wizard
  (`src/init/wizard.ts:578`) and documented in profile examples, but **never
  read** anywhere in `src/` or `tests/`. The annotation comment claims it is
  "shown in `ccpod profile list`" but `src/cli/commands/profile/list.ts` does
  not display it. Either wire it into `profile list` (preferred) or remove the
  field entirely from schema, types, and docs.

---

## Verified clean (probed, not skipped)

IPv6 port classifier (`::`, `[::]`, IPv4-mapped, zero-group and zone-ID forms
all rejected), named-volume regex, git repo/ref option-injection guards, the
`--file` traversal check, the updater's SHA-256 verify wiring (mismatch
provably never touches the target), `writeMergedConfig` symlink/uid
revalidation, and the array-based (shell-free) docker/git argv construction all
held up under focused probing.
