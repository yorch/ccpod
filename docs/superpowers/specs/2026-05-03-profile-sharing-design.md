# Profile Sharing Design

**Date:** 2026-05-03  
**Status:** Approved

## Overview

Add `ccpod profile install <source>` and `ccpod profile export <name>` commands so users can share profile configs via git repos, raw URLs, local files, or self-contained base64 strings — no registry or hosting required.

## Commands

```
ccpod profile install <source>   # install a profile from any source
ccpod profile export <name>      # print shareable base64 string to stdout
```

## Source Detection (install)

Detection runs in order; first match wins:

| Pattern | Type | Action |
|---------|------|--------|
| `https?://.*\.git` or known git host (github.com, gitlab.com, bitbucket.org) | git | Shallow-clone to temp dir, read `profile.yml` at repo root, delete temp dir |
| `https?://` | url | HTTP fetch, expect YAML text response |
| Starts with `/`, `./`, or `~` | file | `readFileSync`, expand `~` to homedir |
| Anything else | base64 | `Buffer.from(input, 'base64').toString('utf8')` |

## Install Flow

1. Fetch/decode `profile.yml` from source
2. Validate against `profileConfigSchema` (Zod) — hard fail on invalid YAML or schema violation
3. If profile name conflicts → interactive prompt:
   ```
   Profile "python-dev" already exists. What would you like to do?
   ❯ Overwrite existing profile
     Install with a different name
     Cancel
   ```
   - Rename loops until name is valid (regex `/^[a-zA-Z0-9_-]{1,64}$/`) and unique
4. Write to `~/.ccpod/profiles/<name>/profile.yml`
5. Print success + next steps

## Export Flow

1. Read raw `~/.ccpod/profiles/<name>/profile.yml` bytes
2. Base64-encode (no compression — profiles are small)
3. Print to stdout (pipeable: `ccpod profile export myprofile | pbcopy`)

Auth config is included as-is. Credentials live separately in `~/.ccpod/credentials/` and are never exported.

## New Files

| File | Purpose |
|------|---------|
| `src/profile/installer.ts` | Source detection (`detectSource`) + fetching (`fetchProfileYaml`) |
| `src/profile/exporter.ts` | `exportProfile(name): string` — reads + base64-encodes |
| `src/cli/commands/profile/install.ts` | Thin command — conflict prompt + writes profile |
| `src/cli/commands/profile/export.ts` | Thin command — calls exporter, prints to stdout |

## CLI Wiring

Add `install` and `export` to `src/cli/commands/profile/index.ts` subCommands map.

## Key Types

```ts
// src/profile/installer.ts
type InstallSource =
  | { type: 'git'; url: string }
  | { type: 'url'; url: string }
  | { type: 'file'; path: string }
  | { type: 'base64'; data: string };

function detectSource(input: string): InstallSource
async function fetchProfileYaml(source: InstallSource): Promise<string>
```

## Testing

- Unit tests for `detectSource()` — each source type and edge cases
- Unit tests for `exportProfile()` + round-trip: export → base64 install → identical YAML
- Unit test for conflict rename loop (mock `profileExists`)
- No integration tests for network/git sources (mock those)

## Out of Scope

- Profile registry / short codes
- Compression of base64 output
- Exporting credentials
- `--force` flag (interactive prompt handles conflicts)
