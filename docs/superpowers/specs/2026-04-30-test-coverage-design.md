# Test Coverage Expansion — Design

**Date:** 2026-04-30  
**Scope:** Unit tests only (no Docker required). 4 new test files covering uncovered non-Docker modules.

---

## Goal

Bring unit test coverage to all modules that can be tested without a live Docker daemon. Current state: 53 tests across 6 files covering auth, config, container builder, profile lock. Gap: mcp/parser, config/writer, runtime/detector, profile/manager.

## New Test Files

```
tests/unit/
  mcp/parser.test.ts
  config/writer.test.ts
  runtime/detector.test.ts
  profile/manager.test.ts
```

All use `bun:test` directly. No mock framework. Temp dirs via `mkdtempSync`, cleaned up in `afterEach`/`finally`.

---

## Source Refactors Required (minimal, no API breakage)

### `src/runtime/detector.ts`
- Move `const HOME = process.env.HOME ?? ""` and `const XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR ?? ""` from module scope into `detectRuntime()` body.
- **Why:** Module-level constants are computed at import time; tests can't override `HOME` after module loads.

### `src/profile/manager.ts`
- Change `CCPOD_DIR` from a module-level `const` to a function `getCcpodDir()` that reads `process.env.CCPOD_TEST_DIR ?? join(homedir(), ".ccpod")` at call time.
- All exported functions (`profileExists`, `listProfiles`, etc.) call `getCcpodDir()` internally.
- Tests set/restore `process.env.CCPOD_TEST_DIR` in `beforeEach`/`afterEach` — no module re-import needed.
- **Why:** Module-level constants are evaluated at import time; env vars set after import have no effect.

---

## Test Cases

### `mcp/parser.test.ts`

`parseMcpJson(projectDir)`:
- Returns `null` when `.mcp.json` absent
- Parses valid file with `mcpServers`
- Returns object with empty `mcpServers` when key missing

`extractHttpMcpPorts(config)`:
- Extracts port from `type: "http"` server
- Extracts port from `type: "sse"` server
- Skips `type: "stdio"` server (no url)
- Skips server with no `url`
- Deduplicates identical ports across multiple servers
- Ignores invalid URLs without throwing

### `config/writer.test.ts`

`writeMergedConfig(profileConfigDir, mergedClaudeMd, mergedSettings)`:
- Creates output dir containing `CLAUDE.md` with correct content
- Creates output dir containing `settings.json` with correct content
- Returns same path on second call with identical inputs (hash cache hit)
- Returns different path when content changes (different hash)
- Copies non-symlink regular files from profile config dir
- Skips symlinks in profile config dir
- Skips `CLAUDE.md` and `settings.json` from profile config dir (overwritten by generated versions)
- Works when `profileConfigDir` does not exist (no crash)

### `runtime/detector.test.ts`

`detectRuntime()`:
- Returns `{ name: "orbstack", socketPath }` when OrbStack socket present
- Returns `{ name: "docker", socketPath }` when only Docker socket present
- Prefers OrbStack over Docker (priority order) when both exist
- Throws with descriptive message when no socket exists
- Uses Podman socket when present and others absent
- All via: real temp dir as `HOME`, real empty files as sockets, save/restore `process.env.HOME`

### `profile/manager.test.ts`

All tests set `process.env.CCPOD_TEST_DIR` to a fresh `mkdtempSync` dir, cleaned up in `afterEach`.

`profileExists(name)`:
- Returns `false` when profile dir absent
- Returns `false` when dir exists but `profile.yml` missing
- Returns `true` when `profile.yml` present

`listProfiles()`:
- Returns `[]` when profiles dir absent
- Returns `[]` when profiles dir empty
- Filters out entries without `profile.yml`
- Returns names of valid profiles only

`deleteProfile(name)`:
- Throws `"Profile not found: <name>"` when profile absent
- Removes profile dir on success

`getCredentialsDir(profileName)`:
- Creates dir if absent and returns path
- Returns same path if already exists

`ensureCcpodDirs()`:
- Creates profiles and credentials dirs without error

---

## Out of Scope

- `container/runner.ts` — requires live Docker
- `image/manager.ts` — requires live Docker
- `plugins/volume.ts` (volume ops) — requires live Docker
- `profile/git-sync.ts` — thin wrapper over `simple-git`; unit value low relative to mocking cost
- CLI command handlers — integration level, no unit tests planned

---

## Success Criteria

- `bun test` passes with ~90+ tests (53 existing + ~40 new)
- No test touches `~/.ccpod` or real Docker socket
- Each test file runs independently and cleans up after itself
