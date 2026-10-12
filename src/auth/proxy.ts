import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import {
  hostOAuthCredentialLockScope,
  type OAuthCredentialEntry,
  type OAuthCredentialStoreIdentity,
  type OAuthCredentials,
  readHostOAuthCredentialEntry,
  readHostOAuthCredentials,
  writeHostOAuthCredentialEntry,
  writeHostOAuthCredentials,
} from './keychain.ts';
import { withOAuthRefreshLock } from './refresh-lock.ts';

// Claude Code's public OAuth client ID (from the CLI's source).
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_API_UPSTREAM = 'https://api.anthropic.com';

// Refresh the access token this long before it expires (1 hour margin).
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

// Timeouts for upstream requests.
const UPSTREAM_TIMEOUT_MS = 120_000; // 2 minutes for API requests
const REFRESH_TIMEOUT_MS = 15_000; // 15 seconds for OAuth refresh
const BODY_TIMEOUT_MS = 30_000; // 30 seconds to read request body
const MAX_BODY_BYTES = 100 * 1024 * 1024; // 100 MB max request body

const MAX_TIMER_MS = 2 ** 31 - 1;

// Retry delay after a failed proactive refresh.
const REFRESH_RETRY_MS = 60_000; // 1 minute
const MAX_REFRESH_RETRIES = 10; // stop retrying after this many consecutive failures
const PERSIST_RETRY_BASE_MS = 100;
const PERSIST_RETRY_MAX_MS = 30_000;
// Reconciliation is best effort and must terminate: a credential store that
// cannot be read or written may never hold the cross-process refresh lock (nor
// the caller's shutdown) indefinitely.
const PERSIST_DEADLINE_MS = 20_000;
// Bound how long stop() waits for an in-flight reconciliation.
const STOP_REFRESH_WAIT_MS = 10_000;

// Headers that must not be forwarded as-is (either stripped or replaced).
const STRIP_HEADERS = new Set([
  'x-api-key',
  'host',
  'transfer-encoding',
  'connection',
  'content-length',
]);

interface AuthProxyOptions {
  // Upstream API base URL and OAuth token endpoint. Default to Anthropic's;
  // overridable (http:// allowed) so tests can point at local servers.
  apiUpstream?: string;
  hostname?: string;
  // Private lock root; configurable for isolated tests, normally ~/.ccpod/oauth-locks.
  lockRoot?: string;
  // Store identity override for injected credential stores in tests.
  lockScope?: string;
  // Bound on read-back reconciliation after a credential write fails; the
  // default is generous, tests inject a small value.
  persistDeadlineMs?: number;
  port?: number;
  // Entry-aware adapters preserve the exact account/file selected by the reader.
  readCredentialEntry?: (
    identity?: OAuthCredentialStoreIdentity,
  ) => OAuthCredentialEntry | undefined;
  // Credential source; defaults to the host Keychain / ~/.claude file.
  readCredentials?: () => OAuthCredentials | undefined;
  // The sentinel API key that the proxy expects in x-api-key. If set,
  // requests without a matching x-api-key are rejected with 401.
  sentinelKey?: string;
  // Bound on how long stop() waits for an in-flight reconciliation.
  stopRefreshWaitMs?: number;
  tokenEndpoint?: string;
  writeCredentialEntry?: (
    creds: OAuthCredentials,
    identity: OAuthCredentialStoreIdentity,
  ) => void;
  // Persists refreshed credentials; defaults to the host Keychain / file.
  writeCredentials?: (creds: OAuthCredentials) => void;
}

interface TokenCache {
  creds: OAuthCredentials;
  identity?: OAuthCredentialStoreIdentity;
  refreshing: Promise<OAuthCredentials> | null;
}

/**
 * HTTP proxy that translates API-key auth into OAuth bearer auth.
 *
 * Containerized claude runs in API-key mode with a sentinel key. This proxy:
 * 1. Strips the sentinel `x-api-key` header
 * 2. Adds `Authorization: Bearer <real-oauth-access-token>`
 * 3. Forwards the request to api.anthropic.com
 * 4. Refreshes the access token proactively (single-flight) before expiry
 * 5. On 401 from upstream: refreshes on-demand and retries once
 *
 * Each invocation owns a proxy instance. A private SQLite transaction lock
 * coordinates refresh-token rotation across ccpod processes sharing the same
 * host credential store; native Claude is outside that lock.
 *
 * Limitation: native `claude` does not honor ccpod's SQLite lock. The proxy
 * reconciles ambiguous writes by rereading the store before each persistence
 * retry, but cannot make its write atomic with an external Keychain/file update;
 * an external rotation between that read and write can still race. Native
 * refresh may also invalidate the proxy's refresh token, causing a brief 401
 * window while the proxy rereads and recovers.
 */
export class AuthProxy {
  private server: Server | null = null;
  private cache: TokenCache | null = null;
  private pendingPersistence: OAuthCredentials | null = null;
  // Generations this process consumed but could not verify in the store
  // (persistence gave up). The store is then known to lag this process, so
  // rediscovering any of them must never be treated as a newer external
  // rotation — doing so would resurrect a single-use refresh token. Every
  // unresolved generation is retained (one entry per failed rotation) until a
  // write is confirmed or another generation legitimately wins, because
  // replacing an earlier marker would let the store re-advertise it.
  private unverifiedRotationSources: OAuthCredentials[] = [];
  private readonly port: number;
  private readonly hostname: string;
  private readonly sentinelKey: string | undefined;
  private readonly readCredentialEntry: (
    identity?: OAuthCredentialStoreIdentity,
  ) => OAuthCredentialEntry | undefined;
  private readonly requireStoreIdentity: boolean;
  private readonly writeCredentialEntry: (
    creds: OAuthCredentials,
    identity?: OAuthCredentialStoreIdentity,
  ) => void;
  private readonly apiUpstream: string;
  private readonly tokenEndpoint: string;
  private readonly lockRoot: string | undefined;
  private readonly lockScope: string | undefined;
  private readonly persistDeadlineMs: number;
  private readonly stopRefreshWaitMs: number;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshRetryCount = 0;
  private stopped = false;

  constructor(opts: AuthProxyOptions = {}) {
    this.port = opts.port ?? 0; // 0 = ephemeral port
    // On macOS, Docker Desktop/OrbStack route host.docker.internal to the
    // host's 127.0.0.1, so binding loopback is sufficient. On native Linux
    // Docker Engine and Podman, host-gateway resolves to the bridge IP
    // (e.g. 172.17.0.1), not 127.0.0.1 — so callers should pass the bridge
    // gateway IP as `hostname` (see withAuthProxy); 0.0.0.0 is only the
    // fallback when it can't be determined. The sentinel key gates access.
    this.hostname =
      opts.hostname ??
      (process.platform === 'darwin' ? '127.0.0.1' : '0.0.0.0');
    this.sentinelKey = opts.sentinelKey;
    if (opts.readCredentialEntry || opts.writeCredentialEntry) {
      this.requireStoreIdentity = true;
      if (!opts.readCredentialEntry || !opts.writeCredentialEntry) {
        throw new Error(
          'Credential entry adapters must provide both read and write',
        );
      }
      this.readCredentialEntry = opts.readCredentialEntry;
      this.writeCredentialEntry = (credentials, identity) => {
        if (!identity) {
          throw new Error('OAuth credential store identity is unavailable');
        }
        opts.writeCredentialEntry?.(credentials, identity);
      };
    } else if (opts.readCredentials || opts.writeCredentials) {
      this.requireStoreIdentity = false;
      const read = opts.readCredentials ?? readHostOAuthCredentials;
      const write = opts.writeCredentials ?? writeHostOAuthCredentials;
      this.readCredentialEntry = () => {
        const credentials = read();
        return credentials ? { credentials, identity: undefined } : undefined;
      };
      this.writeCredentialEntry = (credentials) => write(credentials);
    } else {
      this.requireStoreIdentity = true;
      this.readCredentialEntry = readHostOAuthCredentialEntry;
      this.writeCredentialEntry = (credentials, identity) => {
        if (!identity) {
          throw new Error('OAuth credential store identity is unavailable');
        }
        writeHostOAuthCredentialEntry(credentials, identity);
      };
    }
    this.apiUpstream = opts.apiUpstream ?? DEFAULT_API_UPSTREAM;
    this.tokenEndpoint = opts.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.lockRoot = opts.lockRoot;
    this.lockScope = opts.lockScope;
    this.persistDeadlineMs = opts.persistDeadlineMs ?? PERSIST_DEADLINE_MS;
    this.stopRefreshWaitMs = opts.stopRefreshWaitMs ?? STOP_REFRESH_WAIT_MS;
  }

  get address(): string {
    if (!this.server) {
      throw new Error('Proxy not started');
    }
    const addr = this.server.address();
    if (typeof addr === 'string' || addr === null) {
      throw new Error('Proxy listening on unexpected address type');
    }
    return `http://${this.hostname}:${addr.port}`;
  }

  get resolvedPort(): number {
    if (!this.server) {
      throw new Error('Proxy not started');
    }
    const addr = this.server.address();
    if (typeof addr === 'string' || addr === null) {
      throw new Error('Proxy listening on unexpected address type');
    }
    return addr.port;
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Load initial credentials from the host store
    const creds = this.readCredentialsSafely();
    if (!creds) {
      throw new Error(
        'No OAuth credentials found on host. Run "claude /login" first, then use proxy auth.',
      );
    }
    this.cache = {
      creds: creds.credentials,
      identity: creds.identity,
      refreshing: null,
    };

    // If the access token is already expired or near expiry, refresh now
    if (this.needsRefresh(creds.credentials)) {
      await this.refreshToken();
    }

    this.scheduleProactiveRefresh();

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch(() => {
        console.error('[ccpod-auth-proxy] unhandled proxy request error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: 'proxy error', type: 'proxy_error' },
            }),
          );
        }
      });
    });

    const server = this.server;
    if (!server) {
      throw new Error('Proxy server not created');
    }
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.hostname, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    // A credential write may have thrown after consuming a single-use token.
    // Keep this process alive and retain the SQLite lock until its read-back
    // reconciliation completes, even when the container lifecycle is ending.
    const refresh = this.cache?.refreshing;
    if (refresh) {
      // Bounded wait: an unreachable credential store must not keep the
      // process alive after the container lifecycle has ended.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        refresh.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.stopRefreshWaitMs);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
    }
    const server = this.server;
    if (server) {
      // Force-close lingering keep-alive connections so stop() doesn't hang
      server.closeAllConnections?.();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  private needsRefresh(creds: OAuthCredentials): boolean {
    if (!Number.isFinite(creds.expiresAt)) {
      return true; // missing/invalid expiry → force refresh
    }
    return Date.now() + REFRESH_MARGIN_MS >= creds.expiresAt;
  }

  private scheduleProactiveRefresh(): void {
    if (this.stopped || !this.cache) {
      return;
    }
    const { creds } = this.cache;
    const refreshAt = creds.expiresAt - REFRESH_MARGIN_MS;
    // At least 1 min (or 1 min if expiresAt is invalid), and capped at the
    // largest delay setTimeout supports — beyond 2^31-1 ms it fires at once.
    const delay = Number.isFinite(refreshAt)
      ? Math.min(Math.max(refreshAt - Date.now(), 60_000), MAX_TIMER_MS)
      : 60_000;

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshToken().catch(() => {
        console.error('[ccpod-auth-proxy] proactive refresh failed');
      });
    }, delay);
  }

  /**
   * Refresh the access token using the refresh token. Single-flight: if a
   * refresh is already in progress, concurrent callers await the same promise.
   */
  private refreshToken(): Promise<OAuthCredentials> {
    if (!this.cache) {
      return Promise.reject(new Error('Proxy not initialized'));
    }
    if (this.cache.refreshing) {
      return this.cache.refreshing;
    }

    const refreshPromise = withOAuthRefreshLock(
      this.lockScope ?? `${process.platform}:${hostOAuthCredentialLockScope()}`,
      async () => {
        if (this.pendingPersistence) {
          throw new Error('OAuth credential reconciliation is already active');
        }

        const latest = this.readCredentialsSafely();
        // Ignore a store generation this process already consumed and failed to
        // replace: it is older than what we hold in memory, not a competing
        // external rotation.
        const usable =
          latest && !this.isKnownConsumedGeneration(latest.credentials)
            ? latest
            : undefined;
        if (usable) {
          if (
            !this.needsRefresh(usable.credentials) &&
            usable.credentials.accessToken !== this.cache?.creds.accessToken
          ) {
            return usable;
          }
          // The store may contain a rotated refresh token with the same still-
          // rejected access token. Use that refresh token rather than adopting
          // an access token that already received a 401.
          this.cache = {
            creds: usable.credentials,
            identity: usable.identity,
            refreshing: this.cache?.refreshing ?? null,
          };
        }
        const { credentials: refreshed, source } = await this.doRefresh();
        // Retain the single-use token in memory and hold the SQLite transaction
        // until the write is confirmed, the exact source generation remains so
        // the same rotation can safely be retried, or another generation wins.
        this.pendingPersistence = refreshed;
        const reconciled = await this.persistRotation(source, refreshed);
        this.pendingPersistence = null;
        return reconciled;
      },
      this.lockRoot,
    )
      .then((entry) => {
        this.cache = {
          creds: entry.credentials,
          identity: entry.identity,
          refreshing: null,
        };
        this.refreshRetryCount = 0; // reset on success
        this.scheduleProactiveRefresh();
        return entry.credentials;
      })
      .catch((err) => {
        if (this.cache) {
          this.cache.refreshing = null;
        }
        // Schedule a retry with exponential backoff so a transient failure
        // doesn't leave us without a proactive refresh timer. Cap at
        // MAX_REFRESH_RETRIES to avoid an infinite loop when the refresh
        // token is permanently invalid; after that, rely solely on the
        // 401 on-demand path.
        if (!this.stopped && this.refreshRetryCount < MAX_REFRESH_RETRIES) {
          this.refreshRetryCount++;
          const delay = Math.min(
            REFRESH_RETRY_MS * 2 ** (this.refreshRetryCount - 1),
            3600_000, // cap at 1 hour
          );
          if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
          }
          this.refreshTimer = setTimeout(() => {
            this.refreshToken().catch(() =>
              console.error('[ccpod-auth-proxy] retry refresh failed'),
            );
          }, delay);
        } else if (this.refreshRetryCount >= MAX_REFRESH_RETRIES) {
          console.error(
            `[ccpod-auth-proxy] refresh retry limit reached (${MAX_REFRESH_RETRIES}); ` +
              'relying on 401 on-demand refresh',
          );
        }
        throw err;
      });

    this.cache.refreshing = refreshPromise;
    return refreshPromise;
  }

  private readCredentialsSafely(
    identity?: OAuthCredentialStoreIdentity,
  ): OAuthCredentialEntry | undefined {
    try {
      const entry: unknown = this.readCredentialEntry(identity);
      if (entry === undefined) {
        return undefined;
      }
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !isOAuthCredentials((entry as OAuthCredentialEntry).credentials) ||
        (this.requireStoreIdentity &&
          !isOAuthCredentialStoreIdentity(
            (entry as OAuthCredentialEntry).identity,
          )) ||
        ((entry as OAuthCredentialEntry).identity !== undefined &&
          !isOAuthCredentialStoreIdentity(
            (entry as OAuthCredentialEntry).identity,
          ))
      ) {
        throw new Error('invalid credentials');
      }
      return entry as OAuthCredentialEntry;
    } catch (error) {
      // Keep the message secret-free but retain a non-secret reason so callers
      // and diagnostics can tell a locked store from malformed credentials.
      const detail = credentialReadErrorDetail(error);
      throw new Error(
        detail === undefined
          ? 'OAuth credential store read failed'
          : `OAuth credential store read failed (${detail})`,
      );
    }
  }

  private isKnownConsumedGeneration(creds: OAuthCredentials): boolean {
    return this.unverifiedRotationSources.some((source) =>
      sameCredentialGeneration(creds, source),
    );
  }

  private rememberConsumedGeneration(creds: OAuthCredentials): void {
    if (!this.isKnownConsumedGeneration(creds)) {
      this.unverifiedRotationSources.push(creds);
    }
  }

  private clearConsumedGenerations(): void {
    this.unverifiedRotationSources = [];
  }

  private async persistRotation(
    source: OAuthCredentialEntry,
    pending: OAuthCredentials,
  ): Promise<OAuthCredentialEntry> {
    let attempt = 0;
    let warned = false;
    let expectedSource = source;
    let rotation = pending;
    const deadline = Date.now() + this.persistDeadlineMs;
    while (true) {
      let current: OAuthCredentialEntry | undefined;
      try {
        current = this.readCredentialsSafely(expectedSource.identity);
      } catch {
        // Missing, malformed, or unreadable state is indeterminate. Keep the
        // lock and pending rotation; never write after an unverified read.
      }

      if (current && sameCredentialGeneration(current.credentials, pending)) {
        this.clearConsumedGenerations();
        return current;
      }
      const matchesExpected =
        current !== undefined &&
        sameCredentialGeneration(
          current.credentials,
          expectedSource.credentials,
        );
      if (
        current &&
        !matchesExpected &&
        !this.isKnownConsumedGeneration(current.credentials)
      ) {
        // A different valid generation appeared (for example, an external
        // Claude refresh). Adopt it, never overwrite it with this rotation.
        // Consumed history is deliberately KEPT: adopting another generation
        // does not prove an older consumed one cannot reappear in the store.
        return current;
      }
      if (current) {
        if (
          matchesExpected &&
          !sameCredentialSnapshot(
            current.credentials,
            expectedSource.credentials,
          )
        ) {
          // Never restore the consumed source generation because metadata
          // changed. Preserve the latest metadata and make it the exact snapshot
          // that must be reread before retrying the pending rotation write.
          rotation = {
            ...rotation,
            rateLimitTier: current.credentials.rateLimitTier,
            refreshTokenExpiresAt: current.credentials.refreshTokenExpiresAt,
            scopes: current.credentials.scopes,
            subscriptionType: current.credentials.subscriptionType,
          };
          expectedSource = current;
        } else {
          // Safe to write: the store either still holds the exact source
          // snapshot, or holds a generation this process already consumed and
          // therefore must be older than the pending rotation.
          try {
            this.writeCredentialEntry(rotation, expectedSource.identity);
            // A confirmed write means the store now holds this rotation.
            this.clearConsumedGenerations();
            return { credentials: rotation, identity: expectedSource.identity };
          } catch {
            if (!warned) {
              console.warn(
                '[ccpod-auth-proxy] credential persistence failed; holding the refresh lock while reconciling the store',
              );
              warned = true;
            }
            // The next loop iteration rereads before any further write. In
            // particular, never write after a backoff without a fresh check.
          }
        }
      }

      const delay = Math.min(
        PERSIST_RETRY_BASE_MS * 2 ** Math.min(attempt, 16),
        PERSIST_RETRY_MAX_MS,
      );
      attempt++;
      if (Date.now() + delay >= deadline) {
        // Give up rather than hold the lock forever. The refreshed token stays
        // usable in memory because refresh() replaces the cached credentials;
        // the stored generation may still be the consumed one, so warn and let
        // the next process re-authenticate instead of hanging this one.
        console.warn(
          '[ccpod-auth-proxy] credential persistence unverified after ' +
            `${this.persistDeadlineMs}ms; continuing with the refreshed token in memory only ` +
            '(the stored credential may be stale — restart ccpod to re-authenticate)',
        );
        // Remember the generation we consumed so a later refresh never adopts
        // it back out of the lagging store.
        this.rememberConsumedGeneration(expectedSource.credentials);
        return { credentials: rotation, identity: expectedSource.identity };
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async doRefresh(): Promise<{
    credentials: OAuthCredentials;
    source: OAuthCredentialEntry;
  }> {
    if (!this.cache) {
      throw new Error('Proxy not initialized');
    }
    let source: OAuthCredentialEntry = {
      credentials: this.cache.creds,
      identity: this.cache.identity,
    };
    const { scopes, subscriptionType, rateLimitTier } = source.credentials;

    const body = JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: source.credentials.refreshToken,
    });

    try {
      return {
        credentials: await this.callTokenEndpoint(
          body,
          scopes,
          subscriptionType,
          rateLimitTier,
        ),
        source,
      };
    } catch (err) {
      // If the refresh failed with invalid_grant, the refresh token may have
      // been invalidated by native claude refreshing concurrently. Re-read
      // the host credential store and retry once with the fresh token.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid_grant')) {
        const freshEntry = this.readCredentialsSafely(source.identity);
        if (
          freshEntry &&
          freshEntry.credentials.refreshToken !==
            source.credentials.refreshToken &&
          !this.isKnownConsumedGeneration(freshEntry.credentials)
        ) {
          source = freshEntry;
          const retryBody = JSON.stringify({
            client_id: OAUTH_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: freshEntry.credentials.refreshToken,
          });
          return {
            credentials: await this.callTokenEndpoint(
              retryBody,
              scopes,
              subscriptionType,
              rateLimitTier,
            ),
            source,
          };
        }
      }
      throw err;
    }
  }

  private callTokenEndpoint(
    body: string,
    scopes: string[] | undefined,
    subscriptionType: string | undefined,
    rateLimitTier: string | undefined,
  ): Promise<OAuthCredentials> {
    return new Promise<OAuthCredentials>((resolve, reject) => {
      const url = new URL(this.tokenEndpoint);
      const opts: RequestOptions = {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'ccpod-auth-proxy/1.0',
        },
        hostname: url.hostname,
        method: 'POST',
        path: url.pathname,
        ...(url.port ? { port: Number(url.port) } : {}),
      };

      const req = requestFor(url)(opts, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (chunk: Buffer) => chunks.push(chunk));
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (resp.statusCode !== 200) {
            const invalidGrant = raw.includes('invalid_grant');
            reject(
              new Error(
                `OAuth refresh failed: HTTP ${resp.statusCode}${invalidGrant ? ' invalid_grant' : ''}`,
              ),
            );
            return;
          }
          try {
            const tr = JSON.parse(raw) as {
              access_token: string;
              refresh_token: string;
              expires_in: number;
            };
            if (!tr.access_token || !tr.refresh_token) {
              reject(new Error('OAuth refresh response missing tokens'));
              return;
            }
            const now = Date.now();
            resolve({
              accessToken: tr.access_token,
              expiresAt: now + tr.expires_in * 1000,
              refreshToken: tr.refresh_token,
              ...(scopes !== undefined ? { scopes } : {}),
              ...(subscriptionType !== undefined ? { subscriptionType } : {}),
              ...(rateLimitTier !== undefined ? { rateLimitTier } : {}),
            });
          } catch {
            reject(new Error('Failed to parse OAuth refresh response'));
          }
        });
      });

      // Attach timeout immediately so DNS/TLS/connect stalls are caught
      req.setTimeout(REFRESH_TIMEOUT_MS, () => {
        req.destroy(new Error('OAuth refresh timeout'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async getAccessToken(): Promise<string> {
    if (!this.cache) {
      throw new Error('Proxy not initialized');
    }
    if (this.needsRefresh(this.cache.creds)) {
      try {
        await this.refreshToken();
      } catch {
        // If proactive refresh failed, the old token may still be valid
        // (refresh starts 1 hour before expiry). Do not expose store errors.
        console.warn(
          '[ccpod-auth-proxy] proactive refresh failed; trying existing token',
        );
      }
    }
    return this.cache.creds.accessToken;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Health check
    if (req.method === 'GET' && req.url === '/__ccpod_health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Validate the sentinel API key if one is configured. This prevents
    // any local process that discovers the ephemeral port from using the
    // proxy as an open auth relay.
    if (this.sentinelKey) {
      const incomingKey = req.headers['x-api-key'];
      if (
        typeof incomingKey !== 'string' ||
        !constantTimeEqual(incomingKey, this.sentinelKey)
      ) {
        this.sendError(res, 401, 'invalid or missing sentinel key');
        return;
      }
    }

    const requestTarget = req.url ?? '/';
    if (!isOriginFormTarget(requestTarget)) {
      this.sendError(res, 400, 'invalid request target');
      return;
    }
    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL(requestTarget, this.apiUpstream);
      const configuredOrigin = new URL(this.apiUpstream).origin;
      if (upstreamUrl.origin !== configuredOrigin) {
        this.sendError(res, 400, 'invalid request target');
        return;
      }
    } catch {
      this.sendError(res, 400, 'invalid request target');
      return;
    }

    // Read the request body
    const body = await this.readBody(req);

    // Get a valid access token (refresh if needed)
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch {
      this.sendError(res, 401, 'auth proxy: unable to obtain a valid token');
      return;
    }

    // Forward to upstream, stripping x-api-key and adding Authorization
    const headers = this.buildUpstreamHeaders(req, accessToken);

    await this.forwardRequest(
      upstreamUrl,
      req.method ?? 'GET',
      headers,
      body,
      res,
      0,
    );
  }

  private async forwardRequest(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer,
    res: ServerResponse,
    retryCount: number,
  ): Promise<void> {
    const opts: RequestOptions = {
      headers,
      hostname: url.hostname,
      method,
      path: url.pathname + url.search,
      ...(url.port ? { port: Number(url.port) } : {}),
    };

    return new Promise<void>((resolve) => {
      // Abort the upstream request if the client disconnects while we're
      // waiting for the upstream response or during body streaming.
      let onClientClose: (() => void) | null = null;

      const upstreamReq = requestFor(url)(opts, (upstreamResp) => {
        // On 401, try refreshing the token and retry once
        if (upstreamResp.statusCode === 401 && retryCount === 0) {
          upstreamResp.resume(); // drain
          // Keep the close listener attached through the retry window
          // so a client disconnect during refresh is caught by the next
          // forwardRequest's upstreamReq.destroy().
          // If another request already rotated the token since this one was
          // sent, the 401 is just staleness: retry with the current token
          // instead of burning another refresh (and a refresh-token rotation).
          const sentToken = headers.authorization?.replace(/^Bearer /, '');
          const alreadyRotated =
            this.cache !== null && this.cache.creds.accessToken !== sentToken;
          (alreadyRotated ? Promise.resolve() : this.refreshToken())
            .then(() => {
              const cached = this.cache?.creds.accessToken;
              if (!cached) {
                this.sendError(res, 401, 'auth proxy: no token after refresh');
                return;
              }
              // Use lowercase 'authorization' to match buildUpstreamHeaders.
              // JS object keys are case-sensitive; mixing cases would send
              // two Authorization headers to the upstream.
              const newHeaders = {
                ...headers,
                authorization: `Bearer ${cached}`,
              };
              return this.forwardRequest(url, method, newHeaders, body, res, 1);
            })
            .catch(() => {
              this.sendError(res, 401, 'auth proxy: refresh on 401 failed');
            })
            .finally(() => {
              // The retry attached its own close listener; drop the first
              // request's so a long-lived response doesn't accumulate them.
              if (onClientClose) {
                res.off('close', onClientClose);
              }
              resolve();
            });
          return;
        }

        // Stream the upstream response back to the client
        res.writeHead(upstreamResp.statusCode ?? 502, upstreamResp.headers);
        upstreamResp.pipe(res);
        // Clean up the close listener only after the response body has
        // fully streamed (not when headers arrive — the client could still
        // disconnect during streaming). 'close' also fires when the client
        // disconnects mid-stream (we destroy upstreamReq) and 'error' covers
        // upstream resets — without these the promise never settled and an
        // unhandled 'error' would reach the global uncaughtException handler.
        const finish = () => {
          if (onClientClose) {
            res.off('close', onClientClose);
          }
          resolve();
        };
        upstreamResp.on('end', finish);
        upstreamResp.on('close', finish);
        upstreamResp.on('error', () => {
          res.destroy();
          finish();
        });
      });

      // Attach timeout immediately after request creation so DNS/TLS/connect
      // stalls are caught before any response headers arrive.
      upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        upstreamReq.destroy(new Error('upstream timeout'));
      });

      onClientClose = () => upstreamReq.destroy();
      res.on('close', onClientClose);

      upstreamReq.on('error', (err) => {
        if (onClientClose) {
          res.off('close', onClientClose);
        }
        if (!res.headersSent) {
          this.sendError(
            res,
            502,
            `auth proxy: upstream error: ${err.message}`,
          );
        }
        resolve();
      });

      if (body.length > 0) {
        upstreamReq.write(body);
      }
      upstreamReq.end();
    });
  }

  private buildUpstreamHeaders(
    req: IncomingMessage,
    accessToken: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (STRIP_HEADERS.has(key.toLowerCase())) {
        continue;
      }
      if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      } else if (value !== undefined) {
        headers[key] = value;
      }
    }
    // Replace the sentinel API key with the real OAuth bearer token.
    // Always use lowercase 'authorization' — Node.js lowercases outbound
    // header keys, and the 401-retry path must match this casing.
    headers.authorization = `Bearer ${accessToken}`;
    return headers;
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        reject(new Error('request body read timeout'));
        req.destroy();
      }, BODY_TIMEOUT_MS);
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          clearTimeout(timer);
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private sendError(
    res: ServerResponse,
    status: number,
    message: string,
  ): void {
    if (res.headersSent) {
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message, type: 'proxy_error' },
      }),
    );
  }
}

// https for the real endpoints; http only ever appears via the test overrides.
function requestFor(url: URL): typeof httpsRequest {
  if (url.protocol === 'http:') {
    // SAFETY: Node's http and https request overloads have the same runtime
    // contract; this cast selects the corresponding local test transport.
    return httpRequest as unknown as typeof httpsRequest;
  }
  return httpsRequest;
}

/**
 * Accept only origin-form request targets. WHATWG URL resolution treats `//host`
 * and backslash forms as authorities, so reject them before any request body or
 * credential-store access occurs.
 *
 * This is defence in depth: an HTTP parser may already have collapsed such a
 * target into an ordinary path, and in that case the request is simply a
 * relative path on the configured upstream. The load-bearing guarantee is the
 * origin comparison in `handleRequest`, which refuses to forward whenever the
 * resolved URL is not the configured API origin.
 */
const BACKSLASH_RE = /\\/;

export function isOriginFormTarget(target: string): boolean {
  return (
    target.startsWith('/') &&
    !target.startsWith('//') &&
    !BACKSLASH_RE.test(target)
  );
}

function sameCredentialGeneration(
  left: OAuthCredentials,
  right: OAuthCredentials,
): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken
  );
}

function sameCredentialSnapshot(
  left: OAuthCredentials,
  right: OAuthCredentials,
): boolean {
  return (
    sameCredentialGeneration(left, right) &&
    left.expiresAt === right.expiresAt &&
    left.refreshTokenExpiresAt === right.refreshTokenExpiresAt &&
    left.subscriptionType === right.subscriptionType &&
    left.rateLimitTier === right.rateLimitTier &&
    ((left.scopes === undefined && right.scopes === undefined) ||
      (left.scopes !== undefined &&
        right.scopes !== undefined &&
        left.scopes.length === right.scopes.length &&
        left.scopes.every((scope, index) => scope === right.scopes?.[index])))
  );
}

function isOAuthCredentialStoreIdentity(
  value: unknown,
): value is OAuthCredentialStoreIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const identity = value as Record<string, unknown>;
  return (
    identity.kind === 'file' ||
    (identity.kind === 'keychain' &&
      typeof identity.account === 'string' &&
      identity.account.length > 0)
  );
}

function isOAuthCredentials(value: unknown): value is OAuthCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const credentials = value as Record<string, unknown>;
  return (
    typeof credentials.accessToken === 'string' &&
    credentials.accessToken.length > 0 &&
    typeof credentials.refreshToken === 'string' &&
    credentials.refreshToken.length > 0 &&
    typeof credentials.expiresAt === 'number' &&
    Number.isFinite(credentials.expiresAt) &&
    (credentials.refreshTokenExpiresAt === undefined ||
      (typeof credentials.refreshTokenExpiresAt === 'number' &&
        Number.isFinite(credentials.refreshTokenExpiresAt))) &&
    (credentials.scopes === undefined ||
      (Array.isArray(credentials.scopes) &&
        credentials.scopes.every((scope) => typeof scope === 'string'))) &&
    (credentials.subscriptionType === undefined ||
      typeof credentials.subscriptionType === 'string') &&
    (credentials.rateLimitTier === undefined ||
      typeof credentials.rateLimitTier === 'string')
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Reduce a credential-store read failure to a non-secret reason. Node fs/OS
 * errors carry a short symbol code (EACCES, ENOENT); the only other expected
 * failure is our own validation marker. Anything else stays unspecified.
 */
function credentialReadErrorDetail(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) {
      return code;
    }
  }
  if (error instanceof Error && error.message === 'invalid credentials') {
    return 'invalid credentials';
  }
  return undefined;
}

/**
 * Generate a format-valid sentinel API key that passes Claude Code's local
 * credential format check (v2.1.76+) but is never sent to Anthropic.
 *
 * The format mimics `sk-ant-api03-...` so claude's regex accepts it.
 */
export function generateSentinelApiKey(): string {
  const random = randomBytes(16).toString('hex');
  return `sk-ant-api03-ccpod-proxy-${random}`;
}
