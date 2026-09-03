import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import {
  type OAuthCredentials,
  readHostOAuthCredentials,
  writeHostOAuthCredentials,
} from './keychain.ts';

// Claude Code's public OAuth client ID (from the CLI's source).
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const API_UPSTREAM = 'https://api.anthropic.com';

// Refresh the access token this long before it expires (1 hour margin).
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

// Headers that must not be forwarded as-is (either stripped or replaced).
const STRIP_HEADERS = new Set([
  'x-api-key',
  'host',
  'transfer-encoding',
  'connection',
  'content-length',
]);

export interface AuthProxyOptions {
  hostname?: string;
  port?: number;
  // The sentinel API key that the proxy expects in x-api-key. If set,
  // requests without a matching x-api-key are rejected with 401.
  sentinelKey?: string;
}

interface TokenCache {
  creds: OAuthCredentials;
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
 * Multiple containers share one proxy instance, so all consumers share one
 * OAuth session with serialized refresh — eliminating the refresh-token
 * rotation race.
 */
export class AuthProxy {
  private server: Server | null = null;
  private cache: TokenCache | null = null;
  private readonly port: number;
  private readonly hostname: string;
  private readonly sentinelKey: string | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: AuthProxyOptions = {}) {
    this.port = opts.port ?? 0; // 0 = ephemeral port
    this.hostname = opts.hostname ?? '127.0.0.1';
    this.sentinelKey = opts.sentinelKey;
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
    // Load initial credentials from the host store
    const creds = readHostOAuthCredentials();
    if (!creds) {
      throw new Error(
        'No OAuth credentials found on host. Run "claude /login" first, then use proxy auth.',
      );
    }
    this.cache = { creds, refreshing: null };

    // If the access token is already expired or near expiry, refresh now
    if (this.needsRefresh(creds)) {
      await this.refreshToken();
    }

    this.scheduleProactiveRefresh();

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error(`[ccpod-auth-proxy] unhandled error: ${err}`);
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
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
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
    return Date.now() + REFRESH_MARGIN_MS >= creds.expiresAt;
  }

  private scheduleProactiveRefresh(): void {
    if (!this.cache) {
      return;
    }
    const { creds } = this.cache;
    const refreshAt = creds.expiresAt - REFRESH_MARGIN_MS;
    const delay = Math.max(refreshAt - Date.now(), 60_000); // at least 1 min

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshToken().catch((err) => {
        console.error(`[ccpod-auth-proxy] proactive refresh failed: ${err}`);
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

    const refreshPromise = this.doRefresh()
      .then((newCreds) => {
        this.cache = { creds: newCreds, refreshing: null };
        writeHostOAuthCredentials(newCreds);
        this.scheduleProactiveRefresh();
        return newCreds;
      })
      .catch((err) => {
        if (this.cache) {
          this.cache.refreshing = null;
        }
        throw err;
      });

    this.cache.refreshing = refreshPromise;
    return refreshPromise;
  }

  private async doRefresh(): Promise<OAuthCredentials> {
    if (!this.cache) {
      throw new Error('Proxy not initialized');
    }
    const { refreshToken, scopes, subscriptionType, rateLimitTier } =
      this.cache.creds;

    const body = JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    return new Promise<OAuthCredentials>((resolve, reject) => {
      const url = new URL(TOKEN_ENDPOINT);
      const opts: RequestOptions = {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'ccpod-auth-proxy/1.0',
        },
        hostname: url.hostname,
        method: 'POST',
        path: url.pathname,
      };

      const req = httpsRequest(opts, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (chunk: Buffer) => chunks.push(chunk));
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (resp.statusCode !== 200) {
            reject(
              new Error(
                `OAuth refresh failed: HTTP ${resp.statusCode} ${raw.slice(0, 200)}`,
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
          } catch (err) {
            reject(new Error(`Failed to parse refresh response: ${err}`));
          }
        });
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
      await this.refreshToken();
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
      if (incomingKey !== this.sentinelKey) {
        this.sendError(res, 401, 'invalid or missing sentinel key');
        return;
      }
    }

    // Read the request body
    const body = await this.readBody(req);

    // Get a valid access token (refresh if needed)
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch (err) {
      this.sendError(res, 401, `auth proxy: no valid token: ${err}`);
      return;
    }

    // Forward to upstream, stripping x-api-key and adding Authorization
    const upstreamUrl = new URL(req.url ?? '/', API_UPSTREAM);
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
    };

    return new Promise<void>((resolve) => {
      const upstreamReq = httpsRequest(opts, (upstreamResp) => {
        // Set a timeout so a hung upstream doesn't linger forever
        upstreamReq.setTimeout(120000, () => {
          upstreamReq.destroy(new Error('upstream timeout'));
        });
        // On 401, try refreshing the token and retry once
        if (upstreamResp.statusCode === 401 && retryCount === 0) {
          upstreamResp.resume(); // drain
          this.refreshToken()
            .then(() => {
              const cached = this.cache?.creds.accessToken;
              if (!cached) {
                this.sendError(res, 401, 'auth proxy: no token after refresh');
                return;
              }
              const newHeaders = {
                ...headers,
                Authorization: `Bearer ${cached}`,
              };
              return this.forwardRequest(url, method, newHeaders, body, res, 1);
            })
            .catch((err) => {
              this.sendError(
                res,
                401,
                `auth proxy: refresh on 401 failed: ${err}`,
              );
            })
            .finally(resolve);
          return;
        }

        // Stream the upstream response back to the client
        res.writeHead(upstreamResp.statusCode ?? 502, upstreamResp.headers);
        upstreamResp.pipe(res);
        upstreamResp.on('end', resolve);
      });

      upstreamReq.on('error', (err) => {
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
    // Replace the sentinel API key with the real OAuth bearer token
    headers.authorization = `Bearer ${accessToken}`;
    return headers;
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
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
