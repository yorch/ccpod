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

1. **Must-fix #3 / R28** — Sidecar startup atomicity, `ensureNetwork` TOCTOU,
   and the git-profile clone race.
2. **Must-fix #7 / R15 / R19** — `runContainer` container-state handling
   (no-such-container race, headless-attach, paused/restarting).
3. **Must-fix #8** — `computeProjectHash` platform stability (`realpathSync`,
   darwin case-folding).
4. **Must-fix #9** — `writeMergedConfig` rename race / sentinel marker.
5. **R8 / R9 / R10** — Remaining security hardening: API key in `docker run`
   cmdline, fail-open iptables, `install.sh` checksum verification.

> The 2026-07 trust-boundary trio (**R1–R3**) and the dead-`claudeArgs` fix
> (**R4**) were addressed — see the "Security invariants" section of `AGENTS.md`.

---

## Security

Untrusted project `.ccpod.yml` (and `.mcp.json`) can escalate past the trust
boundary documented in `AGENTS.md`. The R1–R3 escapes below were closed
(network is now profile-owned, project `env` denylists redirect/TLS keys, and
main-container project/`.mcp.json` ports are pinned to loopback); the remaining
items are open.

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
  verifies SHA-256 against `SHASUMS256.txt`, but the curl-pipe installer
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

- **Must-fix #3 + R28. Startup atomicity and clone races.**
  Sidecar startup is not atomic (`src/container/sidecars.ts:30-44`): partial
  failure leaves containers running and the network in place, and
  `ensureNetwork` has a TOCTOU race for concurrent `ccpod run`. Fix: treat
  "already exists" as success; on per-service failure, tear down services
  started so far. Separately, `profile/lock.ts` is a last-sync timestamp, not a
  mutex, so concurrent first-runs of the same git profile race on `git clone`
  into the same dir (loser dies "destination path already exists"); pair this
  with the corrupt-configDir cleanup in the git-sync group below.

- **Must-fix #7 + R15 + R19. `runContainer` container-state handling.**
  `src/container/runner.ts`. (a) `docker rm` "no such container" is fatal when
  a container is removed concurrently (`runner.ts:27-34`, same in
  `shellContainer`) — treat that stderr as success. (b) A headless
  `ccpod run --file …` against an already-running interactive container
  silently `docker attach`es (`runner.ts:22-24`), discarding the new
  spec/prompt, and its signal forwarding can then `docker stop` the user's live
  session — in headless mode, don't attach to a pre-existing interactive
  container. (c) `containerState` maps anything not `running` to `stopped`
  (`runner.ts:83`); paused/restarting containers then fail `docker rm` (no
  `-f`) and `run` throws a misleading error — handle paused/restarting as
  `down.ts` does.

- **Must-fix #8. `computeProjectHash` is not platform-stable.**
  `src/container/builder.ts:24-26`. Case-insensitive macOS HFS+, symlinks, and
  realpath variations produce different hashes for the same dir, yielding
  duplicate stopped containers. Fix: `realpathSync(projectDir)`; normalize case
  on darwin.

- **Must-fix #9. `writeMergedConfig` rename race.** `src/config/writer.ts:88-119`.
  Two concurrent runs can race on rename; a reader may see a half-populated
  mount. Also the cache short-circuit returns without verifying contents, so a
  same-uid attacker could pre-seed the deterministic path. Fix: write a
  sentinel marker file last and poll for it on rename failure, or use a per-pid
  temp dir.

- **M5 + R22. Sidecar exec results are ignored.**
  `removeSidecarNetwork` swallows exit codes (`src/container/sidecars.ts:47-49`),
  and the sidecar `rm` at `sidecars.ts:92` ignores its result — a
  paused/restarting sidecar fails `rm` silently and the next `run` fails with a
  name conflict. Fix: check exit codes and surface/handle failures.

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

- **R6. Profile git-sync breaks for tags or changed refs** (verified: exit 128,
  `unknown revision`). `src/profile/git-sync.ts:29-30`. After a shallow
  single-branch clone, a later `fetch origin <tag>` only updates `FETCH_HEAD`,
  so `git reset --hard origin/<tag>` (or a since-edited `ref`) fails and aborts
  `ccpod run` on every sync. Fix: `reset --hard FETCH_HEAD`.

- **Git ref as commit SHA fails** — `git clone --depth 1 --branch <sha>` is
  invalid (`src/profile/git-sync.ts:18`). Detect SHA-shaped refs and fall back
  to clone-then-checkout.

- **Partial clone leaves corrupt configDir** — next run sees `existsSync` and
  skips, then fetch fails. Fix: `rmSync(configDir, {recursive, force})` on clone
  failure.

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
- **`src/container/sidecars.ts:30-44`** starts sidecars sequentially. Parallelize
  (coordinate with the Must-fix #3 atomicity work).

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
