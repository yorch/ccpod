---
title: Auth Proxy Design
description: Design rationale for proxy auth mode — why copying OAuth credentials into containers causes refresh-token races, the architectures considered, and why API-key translation was selected.
---

## The problem: OAuth refresh-token rotation

ccpod copies OAuth credentials (`.credentials.json`) from the host macOS Keychain or another ccpod profile into each profile's credentials directory. Anthropic's OAuth refresh tokens **rotate on use** — each refresh invalidates the previous refresh token server-side. When two independent credential stores hold the same original refresh token, whichever side refreshes first silently logs the other out.

The access token expires every **~8 hours**, so this collision happens within a single workday when host `claude` and a ccpod container run concurrently. The refresh token lasts ~14 days, so the problem can also surface across sessions.

### How native Claude avoids it

Multiple `claude` processes on the same host share a single credential store (macOS Keychain or `~/.claude/.credentials.json`). When one refreshes, it writes the new token back to the shared store. Other processes read the updated token on their next refresh attempt. There's a narrow race window, but it's **recoverable** because both sides read/write the same store.

ccpod's problem is that it **forks** the credential store — each profile has its own copy that never converges with the source. The entrypoint copies credentials in at start and writes them back at exit, creating a fork for the entire run duration. With multiple concurrent containers, the last one to exit overwrites newer rotated credentials.

### How Docker Sandbox (`sbx`) solves it

Docker Sandboxes uses a **host-side HTTP proxy** that intercepts all container egress. The key mechanisms:

1. **Token never enters the sandbox** — the container sees only a sentinel value. The proxy replaces it with the real token before forwarding.
2. **Proxy owns the refresh** — the daemon holds the real refresh token, refreshes the access token when it expires, and caches the result.
3. **Single-flight refresh** — concurrent requests trigger at most one refresh, eliminating the race.
4. **OAuth interception** — the proxy intercepts the OAuth token response during `/login`, replaces real tokens with sentinels in the credential file, and keeps real tokens host-side.

## Architectures considered

### Architecture A: Token broker

A host daemon holds the OAuth session. Containers ask the daemon for access tokens via Unix socket.

**Rejected because:** claude inside the container does its own refresh using the refresh token in `.credentials.json`. To prevent that, you'd need to give claude only an access token (no refresh token) — which claude does not support as a standalone mode.

### Architecture B: Full MITM proxy (sbx model)

A host-side proxy intercepts all HTTPS traffic via iptables redirect + TLS MITM. Handles both API calls and OAuth refresh.

**Rejected because:** requires per-install CA cert, TLS interception, and ~1100-1500 lines of code. The complexity is not justified when a simpler approach exists.

### Architecture C: Auth-only redirect proxy

Redirect only API calls via `ANTHROPIC_BASE_URL`. The proxy would still need to intercept `platform.claude.com` for OAuth refresh, which requires TLS MITM.

**Rejected because:** same TLS MITM complexity as Architecture B, just for a different endpoint.

### Architecture C-revised: API-key translation (selected)

Trick containerized claude into API-key mode while the proxy does the OAuth dance. See below.

## Selected approach: API-key translation

### Core insight

Claude Code in API-key mode:
- Uses a static `ANTHROPIC_API_KEY` env var, sent as `x-api-key` header
- Has **no refresh token, no expiry, no `.credentials.json`**
- Never calls the OAuth token endpoint

The Anthropic API accepts **either** `x-api-key` **or** `Authorization: Bearer` — they're interchangeable at the API level. The server doesn't care which auth mode the client "thinks" it's in; it just validates the credential.

### Architecture

```
Container (claude thinks it's in API-key mode):
  ANTHROPIC_BASE_URL=http://host.docker.internal:<ephemeral-port>
  ANTHROPIC_API_KEY=sk-ant-api03-ccpod-proxy-<random>  (format-valid sentinel)
  No .credentials.json, no credential mount

  claude → sends x-api-key: sk-ant-api03-ccpod-proxy-<random> to the proxy

Proxy (~300 lines, src/auth/proxy.ts):
  1. Validates sentinel x-api-key (rejects unmatched with 401)
  2. Strips x-api-key header
  3. Adds Authorization: Bearer <real-oauth-access-token>
  4. Forwards as HTTPS to api.anthropic.com
  5. Holds real refresh token in Keychain, refreshes AT before expiry (single-flight)
  6. On 401 from upstream: refreshes on-demand, retries once

Host:
  - OAuth login done via host `claude /login` (browser flow, stores RT in Keychain)
  - Proxy started before container, stopped after
```

### Why this eliminates the race

- The container **never has a refresh token** — it's in API-key mode, which has no refresh flow.
- The proxy owns the **only** OAuth session and refreshes with a single-flight lock.
- Multiple containers share the same proxy, which serializes refreshes and serves all consumers from one cache.

### Concurrency model

```
3 containers sharing one proxy:

T=8h  AT expires
      ├─ container A sends request → proxy checks cache: expired
      │   → acquires single-flight lock → refreshes with real RT
      │   → stores new AT in cache → releases lock
      │   → injects real AT → forwards request
      │
      ├─ container B sends request → cache is now fresh (A refreshed it)
      │   → injects cached AT → forwards
      │
      └─ container C sends request → same as B, cached AT

No race. One refresh, one store, all consumers served from cache.
```

### Known limitation: concurrent native claude

If native `claude` runs concurrently on the host and refreshes the same OAuth session independently, it can invalidate the proxy's refresh token (and vice versa). The proxy re-reads the host credential store on `invalid_grant` to recover, but a brief window of 401s is possible. This is a fundamental limitation of two independent consumers sharing a rotating token without a shared refresh coordinator. For fully race-free operation, use proxy mode for all consumers or use independent OAuth logins per consumer.

## Empirical verification

The following was verified by hand against `api.anthropic.com` during development:

| Test | Setup | Result |
|------|-------|--------|
| OAuth Bearer + `anthropic-beta: oauth` header | `Authorization: Bearer <AT>` | **200** |
| OAuth Bearer, no beta header | `Authorization: Bearer <AT>` | **200** (beta not required) |
| OAuth token in `x-api-key` header | `x-api-key: <AT>` | **401** ("API key is invalid") |
| Both `x-api-key` (fake) + Bearer (real) | Both headers present | **401** (server checks `x-api-key` first) |
| Usage endpoint with Bearer | `/api/oauth/usage` | **200** (subscription billing confirmed) |
| Full proxy flow: sentinel → strip → add Bearer → forward | End-to-end | **200** |

**Key findings:**

1. The proxy **must strip `x-api-key`** — if present alongside `Authorization`, the server rejects the request (test 4). This is why the proxy strips rather than merely adds the bearer header.
2. The `anthropic-beta: oauth-2025-04-20` header is **not required** for the Messages API (test 2).
3. Billing goes against the **subscription**, not API pay-as-you-go (test 5).
4. The sentinel `ANTHROPIC_API_KEY` must pass claude's **local format check** (v2.1.76+). A format-valid sentinel like `sk-ant-api03-ccpod-proxy-<random>` works. Claude exits with "Not logged in" without making any HTTP request if the format check fails.

## Token lifetimes

| Token | Lifetime |
|-------|----------|
| Access token | ~8 hours (`expiresAt: T + 8h`) |
| Refresh token | ~14 days (`refreshTokenExpiresAt: T + 14d`) |

The proxy proactively refreshes the access token 1 hour before expiry and on-demand when the upstream returns 401. Refreshed tokens are written back to the host Keychain (or `~/.claude/.credentials.json` on non-macOS).

## OAuth endpoints

- Token endpoint: `https://platform.claude.com/v1/oauth/token`
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's public OAuth client ID)
- Grant type: `refresh_token`
- API endpoint: `https://api.anthropic.com`

## Why not simpler approaches

- **Symlink credentials dir**: doesn't solve Keychain access; the container entrypoint copies credentials at start and writes back at exit, creating a fork for the entire run duration.
- **Per-run sync**: narrows divergence to one run but doesn't handle concurrent runs.
- **Independent logins per profile**: correct but inconvenient — requires a browser login per profile, and users want their subscription shared.
- **Warn-and-opt-in**: good stopgap, correctly surfaces the risk, but doesn't fix the structural problem.
