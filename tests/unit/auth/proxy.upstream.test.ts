import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthCredentials } from '../../../src/auth/keychain.ts';
import { AuthProxy } from '../../../src/auth/proxy.ts';

// End-to-end tests for AuthProxy against local fake "Anthropic API" and
// "OAuth token" servers: header rewriting, 401 retry, single-flight refresh,
// invalid_grant recovery, and write-back. Nothing touches the real network or
// the host Keychain (credentials are read/written through injected functions).

const SENTINEL = 'sk-ant-api03-ccpod-proxy-test';
const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000;

interface Seen {
  headers: IncomingMessage['headers'];
  method: string;
  url: string;
}

let servers: Server[] = [];
let proxy: AuthProxy | null = null;

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  servers = [];
  proxy = null;
});

afterEach(async () => {
  await proxy?.stop();
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const creds = (over: Partial<OAuthCredentials> = {}): OAuthCredentials => ({
  accessToken: 'old-access',
  expiresAt: FAR_FUTURE,
  refreshToken: 'r1',
  ...over,
});

async function startProxy(opts: {
  apiUpstream: string;
  readCredentials?: () => OAuthCredentials | undefined;
  tokenEndpoint?: string;
  written?: OAuthCredentials[];
}): Promise<string> {
  proxy = new AuthProxy({
    apiUpstream: opts.apiUpstream,
    hostname: '127.0.0.1',
    readCredentials: opts.readCredentials ?? (() => creds()),
    sentinelKey: SENTINEL,
    tokenEndpoint: opts.tokenEndpoint ?? `${opts.apiUpstream}/token`,
    writeCredentials: (c) => {
      opts.written?.push(c);
    },
  });
  await proxy.start();
  return `http://127.0.0.1:${proxy.resolvedPort}`;
}

const call = (base: string, init: RequestInit = {}) =>
  fetch(`${base}/v1/messages?x=1`, {
    body: '{"hello":"world"}',
    method: 'POST',
    ...init,
    headers: { 'x-api-key': SENTINEL, ...(init.headers ?? {}) },
  });

describe('AuthProxy → upstream request rewriting', () => {
  it('swaps the sentinel for a bearer token and forwards method, path, query and body', async () => {
    const seen: Seen[] = [];
    let body = '';
    const api = await listen((req, res) => {
      seen.push({
        headers: req.headers,
        method: req.method ?? '',
        url: req.url ?? '',
      });
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-up': 'yes',
        });
        res.end('{"ok":true}');
      });
    });
    const base = await startProxy({ apiUpstream: api });

    const res = await call(base, {
      headers: { 'anthropic-version': '2023-06-01' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-up')).toBe('yes');
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/v1/messages?x=1');
    expect(body).toBe('{"hello":"world"}');
    expect(seen[0]?.headers.authorization).toBe('Bearer old-access');
    expect(seen[0]?.headers['x-api-key']).toBeUndefined();
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('answers 502 when the upstream is unreachable', async () => {
    // A listening-then-closed port is refused.
    const dead = await listen(() => {});
    const server = servers.pop() as Server;
    await new Promise<void>((r) => server.close(() => r()));
    const base = await startProxy({ apiUpstream: dead });
    const res = await call(base);
    expect(res.status).toBe(502);
  });
});

describe('AuthProxy → 401 refresh and retry', () => {
  function fakeBackend() {
    const state = { apiCalls: [] as string[], tokenCalls: [] as string[] };
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/token') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const { refresh_token } = JSON.parse(raw) as {
            refresh_token: string;
          };
          state.tokenCalls.push(refresh_token);
          if (refresh_token === 'r1') {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                access_token: 'new-access',
                expires_in: 86_400,
                refresh_token: 'r2',
              }),
            );
          } else {
            res.writeHead(400);
            res.end('{"error":"invalid_grant"}');
          }
        });
        return;
      }
      state.apiCalls.push(String(req.headers.authorization));
      req.resume();
      if (req.headers.authorization === 'Bearer new-access') {
        res.writeHead(200);
        res.end('fine');
      } else {
        res.writeHead(401);
        res.end('expired');
      }
    };
    return { handler, state };
  }

  it('refreshes once on 401, retries with the new token, and writes it back', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    const written: OAuthCredentials[] = [];
    const base = await startProxy({ apiUpstream: api, written });

    const res = await call(base);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fine');
    expect(state.apiCalls).toEqual(['Bearer old-access', 'Bearer new-access']);
    expect(state.tokenCalls).toEqual(['r1']);
    expect(written).toHaveLength(1);
    expect(written[0]?.accessToken).toBe('new-access');
    expect(written[0]?.refreshToken).toBe('r2');
  });

  it('is single-flight: truly concurrent 401s share one refresh', async () => {
    const { handler, state } = fakeBackend();
    // Hold every old-token API request until all three have arrived, so the
    // three 401s are genuinely concurrent (not serialized by timing).
    let arrived = 0;
    let release: () => void = () => {};
    const allArrived = new Promise<void>((r) => {
      release = r;
    });
    const api = await listen((req, res) => {
      if (
        req.url !== '/token' &&
        req.headers.authorization === 'Bearer old-access'
      ) {
        arrived++;
        if (arrived === 3) {
          release();
        }
        void allArrived.then(() => handler(req, res));
        return;
      }
      handler(req, res);
    });
    const base = await startProxy({ apiUpstream: api });

    const results = await Promise.all([call(base), call(base), call(base)]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(state.tokenCalls).toEqual(['r1']);
  });

  it('does not refresh again for a 401 on a token that was already rotated', async () => {
    const { handler, state } = fakeBackend();
    // First request: its 401 is delayed until a second request has already
    // triggered (and finished) the refresh.
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let heldOne = false;
    const api = await listen((req, res) => {
      if (
        req.url !== '/token' &&
        req.headers.authorization === 'Bearer old-access' &&
        !heldOne
      ) {
        heldOne = true;
        void firstHeld.then(() => handler(req, res));
        return;
      }
      handler(req, res);
    });
    const base = await startProxy({ apiUpstream: api });

    const first = call(base);
    // Second request completes (old → 401 → refresh → new → 200) first.
    expect((await call(base)).status).toBe(200);
    releaseFirst();

    expect((await first).status).toBe(200);
    expect(state.tokenCalls).toEqual(['r1']); // no second refresh with r2
  });

  it('retries only once: a second 401 is passed through to the client', async () => {
    const calls: string[] = [];
    const api = await listen((req, res) => {
      if (req.url === '/token') {
        req.resume();
        res.writeHead(200);
        res.end(
          JSON.stringify({
            access_token: 'n',
            expires_in: 86_400,
            refresh_token: 'r2',
          }),
        );
        return;
      }
      calls.push(String(req.headers.authorization));
      req.resume();
      res.writeHead(401);
      res.end('still no');
    });
    const base = await startProxy({ apiUpstream: api });

    const res = await call(base);

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('still no');
    expect(calls).toEqual(['Bearer old-access', 'Bearer n']);
  });

  it('recovers from invalid_grant by re-reading the host credentials', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    // First read (start) gives a stale refresh token; the re-read after
    // invalid_grant gives the one native claude rotated to.
    let reads = 0;
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => {
        reads++;
        return reads === 1
          ? creds({ refreshToken: 'stale' })
          : creds({ refreshToken: 'r1' });
      },
    });

    const res = await call(base);

    expect(res.status).toBe(200);
    expect(state.tokenCalls).toEqual(['stale', 'r1']);
  });

  it('returns a 401 proxy error when the refresh itself fails', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    // Refresh token is permanently bad and the host store has nothing newer.
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => creds({ refreshToken: 'bad' }),
    });

    const res = await call(base);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('refresh on 401 failed');
    expect(state.tokenCalls).toEqual(['bad']);
  });

  it('refreshes before forwarding when the token is already expired', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => creds({ expiresAt: Date.now() - 1000 }),
    });

    const res = await call(base);

    expect(res.status).toBe(200);
    // start() refreshed proactively; the API only ever saw the new token.
    expect(state.apiCalls).toEqual(['Bearer new-access']);
    expect(state.tokenCalls).toEqual(['r1']);
  });
});

describe('AuthProxy lifecycle', () => {
  it('stops accepting connections after stop()', async () => {
    const api = await listen((req, res) => {
      req.resume();
      res.writeHead(200);
      res.end('ok');
    });
    const base = await startProxy({ apiUpstream: api });
    expect((await call(base)).status).toBe(200);

    await proxy?.stop();
    proxy = null;

    await expect(call(base)).rejects.toThrow();
  });
});
