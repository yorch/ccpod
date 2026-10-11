import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  request as rawHttpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  OAuthCredentialEntry,
  OAuthCredentialStoreIdentity,
  OAuthCredentials,
} from '../../../src/auth/keychain.ts';
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
let proxies: AuthProxy[] = [];
const lockDirs: string[] = [];

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
  proxies = [];
});

afterEach(async () => {
  await Promise.all(proxies.map((instance) => instance.stop()));
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const dir of lockDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
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
  lockRoot?: string;
  writeCredentials?: (creds: OAuthCredentials) => void;
  readCredentialEntry?: (
    identity?: OAuthCredentialStoreIdentity,
  ) => OAuthCredentialEntry | undefined;
  writeCredentialEntry?: (
    creds: OAuthCredentials,
    identity: OAuthCredentialStoreIdentity,
  ) => void;
  written?: OAuthCredentials[];
}): Promise<string> {
  const proxy = new AuthProxy({
    apiUpstream: opts.apiUpstream,
    hostname: '127.0.0.1',
    ...(opts.readCredentialEntry && opts.writeCredentialEntry
      ? {
          readCredentialEntry: opts.readCredentialEntry,
          writeCredentialEntry: opts.writeCredentialEntry,
        }
      : {
          readCredentials: opts.readCredentials ?? (() => creds()),
          writeCredentials:
            opts.writeCredentials ??
            ((c) => {
              opts.written?.push(c);
            }),
        }),
    lockRoot:
      opts.lockRoot ??
      (() => {
        const root = mkdtempSync(join(tmpdir(), 'ccpod-proxy-lock-'));
        lockDirs.push(root);
        return root;
      })(),
    sentinelKey: SENTINEL,
    tokenEndpoint: opts.tokenEndpoint ?? `${opts.apiUpstream}/token`,
  });
  proxies.push(proxy);
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
  it('rejects authority, absolute, and backslash targets before credential access', async () => {
    let apiCalls = 0;
    let credentialReads = 0;
    const api = await listen((req, res) => {
      apiCalls++;
      req.resume();
      res.writeHead(200).end('unexpected');
    });
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => {
        credentialReads++;
        return creds();
      },
    });
    const proxyPort = Number(new URL(base).port);
    for (const path of [
      '//attacker.invalid/steal',
      'http://attacker.invalid/steal',
      '/\\\\attacker.invalid/steal',
    ]) {
      const response = await new Promise<number>((resolve, reject) => {
        const req = rawHttpRequest(
          {
            headers: { 'content-length': '4', 'x-api-key': SENTINEL },
            hostname: '127.0.0.1',
            method: 'POST',
            path,
            port: proxyPort,
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end('body');
      });
      expect(response).toBe(400);
    }
    expect(credentialReads).toBe(1); // initial startup only
    expect(apiCalls).toBe(0);
  });
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

  it('persists rotation to the exact fallback Keychain account selected for reading', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    const accounts = new Map<string, OAuthCredentials>([
      ['A', creds({ expiresAt: 0 })],
    ]);
    const readCredentialEntry = (identity?: OAuthCredentialStoreIdentity) => {
      const selectedAccount =
        identity?.kind === 'keychain'
          ? identity.account
          : accounts.has('B')
            ? 'B'
            : accounts.has('A')
              ? 'A'
              : undefined;
      const credentials = selectedAccount
        ? accounts.get(selectedAccount)
        : undefined;
      return credentials && selectedAccount
        ? {
            credentials,
            identity: { account: selectedAccount, kind: 'keychain' as const },
          }
        : undefined;
    };
    await startProxy({
      apiUpstream: api,
      readCredentialEntry,
      writeCredentialEntry: (next, identity) => {
        expect(identity).toEqual({ account: 'A', kind: 'keychain' });
        accounts.set(identity.account, next);
      },
    });

    expect(state.tokenCalls).toEqual(['r1']);
    expect(accounts.has('B')).toBe(false);
    expect(accounts.get('A')?.refreshToken).toBe('r2');
    expect(readCredentialEntry()?.credentials.refreshToken).toBe('r2');
    expect(
      readCredentialEntry({ account: 'A', kind: 'keychain' })?.credentials
        .refreshToken,
    ).toBe('r2');
  });

  it('rejects unavailable or malformed store identity before consuming the refresh token', async () => {
    for (const identity of [undefined, { account: '', kind: 'keychain' }]) {
      const { handler, state } = fakeBackend();
      const api = await listen(handler);
      const lockRoot = mkdtempSync(join(tmpdir(), 'ccpod-invalid-store-id-'));
      lockDirs.push(lockRoot);
      const proxy = new AuthProxy({
        apiUpstream: api,
        hostname: '127.0.0.1',
        lockRoot,
        readCredentialEntry: () =>
          ({
            credentials: creds({ expiresAt: 0 }),
            identity,
          }) as OAuthCredentialEntry,
        sentinelKey: SENTINEL,
        writeCredentialEntry: () => {
          throw new Error('must not persist');
        },
      });
      proxies.push(proxy);
      await expect(proxy.start()).rejects.toThrow(
        'OAuth credential store read failed',
      );
      expect(state.tokenCalls).toEqual([]);
    }
  });

  it('persists R2 with newer metadata when readback still has consumed R1', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    const initial = creds({ expiresAt: 0, scopes: ['old-scope'] });
    let stored = initial;
    let reads = 0;
    const written: OAuthCredentials[] = [];
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => {
        reads++;
        if (reads === 3) {
          stored = creds({
            expiresAt: 0,
            rateLimitTier: 'new-tier',
            refreshTokenExpiresAt: Date.now() + 10_000,
            scopes: ['new-scope'],
            subscriptionType: 'new-subscription',
          });
        }
        return stored;
      },
      writeCredentials: (next) => {
        written.push(next);
        stored = next;
      },
    });

    const response = await call(base);
    expect(response.status).toBe(200);
    expect(state.tokenCalls).toEqual(['r1']);
    expect(written).toHaveLength(1);
    expect(stored.refreshToken).toBe('r2');
    expect(stored.accessToken).toBe('new-access');
    expect(stored.scopes).toEqual(['new-scope']);
    expect(stored.subscriptionType).toBe('new-subscription');
    expect(stored.rateLimitTier).toBe('new-tier');
    expect(stored.refreshTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it('keeps malformed token and scope readbacks pending under the refresh lock', async () => {
    for (const malformed of [
      { ...creds(), accessToken: 42 },
      { ...creds(), refreshToken: {} },
      { ...creds(), scopes: 'not-an-array' },
    ]) {
      const { handler, state } = fakeBackend();
      const api = await listen(handler);
      const lockRoot = mkdtempSync(join(tmpdir(), 'ccpod-malformed-readback-'));
      lockDirs.push(lockRoot);
      let stored: unknown = creds();
      let reads = 0;
      let signalMalformedRead: (() => void) | undefined;
      const malformedRead = new Promise<void>((resolve) => {
        signalMalformedRead = resolve;
      });
      const reader = () => {
        reads++;
        if (reads === 4) {
          stored = malformed;
          signalMalformedRead?.();
        }
        return stored as OAuthCredentials;
      };
      let writes = 0;
      const base = await startProxy({
        apiUpstream: api,
        lockRoot,
        readCredentials: reader,
        writeCredentials: (next) => {
          writes++;
          stored = next;
        },
      });
      const secondBase = await startProxy({
        apiUpstream: api,
        lockRoot,
        readCredentials: reader,
        writeCredentials: (next) => {
          writes++;
          stored = next;
        },
      });
      stored = creds({ expiresAt: 0 });

      const first = call(base);
      await malformedRead;
      expect(stored).toEqual(malformed);
      expect(writes).toBe(0);
      const second = call(secondBase);
      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondSettled).toBe(false);
      expect(state.tokenCalls).toEqual(['r1']);

      stored = creds({
        expiresAt: 0,
        scopes: ['updated-scope'],
        subscriptionType: 'updated-plan',
      });
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(state.tokenCalls).toEqual(['r1']);
      expect((stored as OAuthCredentials).refreshToken).toBe('r2');
    }
  });

  it('retries startup persistence without exiting or reusing the consumed token', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    let stored = creds({ expiresAt: 0 });
    let reads = 0;
    let writes = 0;
    const diagnostics: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      diagnostics.push(args.join(' '));
    };
    let base: string;
    try {
      base = await startProxy({
        apiUpstream: api,
        readCredentials: () => {
          reads++;
          if (reads === 3) {
            throw new Error('READ-ACCESS-MARKER READ-REFRESH-MARKER');
          }
          return stored;
        },
        writeCredentials: (next) => {
          writes++;
          if (writes <= 3) {
            throw new Error('ACCESS-MARKER REFRESH-MARKER');
          }
          stored = next;
        },
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(diagnostics.join('\n')).not.toContain('ACCESS-MARKER');
    expect(diagnostics.join('\n')).not.toContain('REFRESH-MARKER');
    expect(diagnostics.join('\n')).not.toContain('READ-ACCESS-MARKER');
    expect(diagnostics.join('\n')).not.toContain('READ-REFRESH-MARKER');
    expect(base).toContain('http://127.0.0.1:');
    expect(state.tokenCalls).toEqual(['r1']);
    expect(writes).toBe(4);
    expect(stored.refreshToken).toBe('r2');
    const response = await call(base);
    expect(response.status).toBe(200);
    expect(state.tokenCalls).toEqual(['r1']);
  });

  it('defers proxy stop until a pending credential rotation is reconciled', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    let stored = creds();
    let allowWrite = false;
    let signalFirstFailure: (() => void) | undefined;
    const firstFailure = new Promise<void>((resolve) => {
      signalFirstFailure = resolve;
    });
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => stored,
      writeCredentials: (next) => {
        if (!allowWrite) {
          signalFirstFailure?.();
          throw new Error('ACCESS-MARKER REFRESH-MARKER');
        }
        stored = next;
      },
    });

    const request = call(base).catch(() => undefined);
    await firstFailure;
    let stopped = false;
    const stopping = proxies
      .at(-1)
      ?.stop()
      .then(() => {
        stopped = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    expect(stored.refreshToken).toBe('r1');

    allowWrite = true;
    await stopping;
    await request;
    expect(stopped).toBe(true);
    expect(stored.refreshToken).toBe('r2');
    expect(state.tokenCalls).toEqual(['r1']);
  });

  it('rechecks after unreadable read-back and adopts a newer generation before retrying the write', async () => {
    const tokenCalls: string[] = [];
    const tokenEndpoint = await listen(async (req, res) => {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
      }
      const { refresh_token: refreshToken } = JSON.parse(raw) as {
        refresh_token: string;
      };
      tokenCalls.push(refreshToken);
      if (refreshToken !== 'r1') {
        res.writeHead(400).end('invalid_grant');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'access-r2',
          expires_in: 86_400,
          refresh_token: 'r2',
        }),
      );
    });
    const apiCalls: string[] = [];
    const api = await listen((req, res) => {
      apiCalls.push(String(req.headers.authorization));
      req.resume();
      res
        .writeHead(req.headers.authorization === 'Bearer access-r3' ? 200 : 401)
        .end('response');
    });
    let stored = creds();
    let reads = 0;
    let writes = 0;
    let markUnreadableReadback: (() => void) | undefined;
    const unreadableReadback = new Promise<void>((resolve) => {
      markUnreadableReadback = resolve;
    });
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => {
        reads++;
        if (reads === 4) {
          markUnreadableReadback?.();
          throw new Error('READ-ACCESS-MARKER READ-REFRESH-MARKER');
        }
        return stored;
      },
      tokenEndpoint,
      writeCredentials: (next) => {
        writes++;
        stored = next;
        throw new Error('ACCESS-MARKER REFRESH-MARKER');
      },
    });

    const request = call(base);
    await unreadableReadback;
    // Simulate native Claude advancing the effective store during backoff.
    stored = creds({ accessToken: 'access-r3', refreshToken: 'r3' });
    const response = await request;

    expect(response.status).toBe(200);
    expect(stored.refreshToken).toBe('r3');
    expect(writes).toBe(1);
    expect(tokenCalls).toEqual(['r1']);
    expect(apiCalls).toEqual(['Bearer old-access', 'Bearer access-r3']);
  });

  it('reconciles write-then-throw and never overwrites a newer shared-store generation', async () => {
    const tokenCalls: string[] = [];
    const tokenEndpoint = await listen(async (req, res) => {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
      }
      const { refresh_token: refreshToken } = JSON.parse(raw) as {
        refresh_token: string;
      };
      tokenCalls.push(refreshToken);
      const next =
        refreshToken === 'r1'
          ? { access_token: 'access-r2', refresh_token: 'r2' }
          : refreshToken === 'r2'
            ? { access_token: 'access-r3', refresh_token: 'r3' }
            : null;
      if (!next) {
        res.writeHead(400).end('invalid_grant');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...next, expires_in: 86_400 }));
    });
    const api = await listen((req, res) => {
      req.resume();
      res
        .writeHead(req.headers.authorization === 'Bearer access-r3' ? 200 : 401)
        .end('response');
    });
    const lockRoot = mkdtempSync(join(tmpdir(), 'ccpod-shared-proxy-lock-'));
    lockDirs.push(lockRoot);
    let stored = creds();
    let firstProxyWrites = 0;
    let markFirstWriteAttempt: (() => void) | undefined;
    const firstWriteAttempt = new Promise<void>((resolve) => {
      markFirstWriteAttempt = resolve;
    });
    const firstBase = await startProxy({
      apiUpstream: api,
      lockRoot,
      readCredentials: () => stored,
      tokenEndpoint,
      writeCredentials: (next) => {
        firstProxyWrites++;
        markFirstWriteAttempt?.();
        if (firstProxyWrites <= 3) {
          throw new Error('ACCESS-MARKER REFRESH-MARKER');
        }
        stored = next;
        throw new Error('ACCESS-MARKER REFRESH-MARKER');
      },
    });
    const secondBase = await startProxy({
      apiUpstream: api,
      lockRoot,
      readCredentials: () => stored,
      tokenEndpoint,
      writeCredentials: (next) => {
        stored = next;
      },
    });

    const diagnostics: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      diagnostics.push(args.join(' '));
    };
    const lifecycle = await (async () => {
      const firstOperation = call(firstBase);
      await firstWriteAttempt;
      const secondOperation = call(secondBase);
      try {
        const secondSettledWhileFirstOwnsLock = await Promise.race([
          secondOperation.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 20),
          ),
        ]);
        const firstResponse = await firstOperation;
        const secondResponse = await secondOperation;
        return {
          firstResponse,
          secondResponse,
          secondSettledWhileFirstOwnsLock,
        };
      } finally {
        console.warn = originalWarn;
      }
    })();
    expect(lifecycle.secondSettledWhileFirstOwnsLock).toBe(false);
    expect(lifecycle.firstResponse.status).toBe(401);
    expect(await lifecycle.firstResponse.text()).not.toContain('MARKER');
    expect(lifecycle.secondResponse.status).toBe(401);
    expect(diagnostics.join('\n')).not.toContain('ACCESS-MARKER');
    expect(diagnostics.join('\n')).not.toContain('REFRESH-MARKER');
    expect(stored.refreshToken).toBe('r2');
    expect(firstProxyWrites).toBe(4);

    // The second proxy adopts R2, then rotates it to R3. The first proxy's
    // reconciled R2 must not remain pending and overwrite that newer state.
    expect((await call(secondBase)).status).toBe(200);
    expect(stored.refreshToken).toBe('r3');
    expect((await call(firstBase)).status).toBe(200);
    expect(stored.refreshToken).toBe('r3');
    expect(tokenCalls).toEqual(['r1', 'r2']);
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

  it('keeps a staggered second 401 single-flight while the token endpoint is pending', async () => {
    const tokenCalls: string[] = [];
    let markTokenStarted: () => void = () => {};
    let releaseToken: () => void = () => {};
    const tokenStarted = new Promise<void>((resolve) => {
      markTokenStarted = resolve;
    });
    const tokenRelease = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    let oldApiCalls = 0;
    const backend = await listen(async (req, res) => {
      if (req.url === '/token') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }
        tokenCalls.push(
          (JSON.parse(body) as { refresh_token: string }).refresh_token,
        );
        markTokenStarted();
        await tokenRelease;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'fresh',
            expires_in: 86400,
            refresh_token: 'r2',
          }),
        );
        return;
      }
      req.resume();
      if (req.headers.authorization === 'Bearer fresh') {
        res.writeHead(200).end('ok');
      } else {
        oldApiCalls++;
        res.writeHead(401).end('expired');
      }
    });
    const base = await startProxy({ apiUpstream: backend });
    const first = call(base);
    await tokenStarted;
    const second = call(base);
    while (oldApiCalls < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    releaseToken();

    const results = await Promise.all([first, second]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    expect(tokenCalls).toEqual(['r1']);
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

  it('adopts the credentials reread under the refresh lock', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
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
    expect(state.tokenCalls).toEqual(['r1']);
    expect(reads).toBe(3);
  });

  it('recovers from invalid_grant by rereading credentials after the rejected refresh', async () => {
    const { handler, state } = fakeBackend();
    const api = await listen(handler);
    let reads = 0;
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => {
        reads++;
        // Startup and the under-lock reread both see the stale token. A native
        // Claude refresh then rotates the host store before invalid_grant retry.
        return reads <= 2
          ? creds({ refreshToken: 'stale' })
          : creds({ refreshToken: 'r1' });
      },
    });

    const res = await call(base);

    expect(res.status).toBe(200);
    expect(state.tokenCalls).toEqual(['stale', 'r1']);
    expect(state.apiCalls).toEqual(['Bearer old-access', 'Bearer new-access']);
    expect(reads).toBe(4);
  });

  it('keeps credential-store exception markers out of HTTP and diagnostics', async () => {
    const api = await listen((req, res) => {
      req.resume();
      res.writeHead(401).end('expired');
    });
    let reads = 0;
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => {
        reads++;
        if (reads === 1) {
          return creds();
        }
        throw new Error('ACCESS-MARKER REFRESH-MARKER');
      },
    });
    const diagnostics: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => diagnostics.push(args.join(' '));
    console.warn = (...args: unknown[]) => diagnostics.push(args.join(' '));
    let response: Response;
    try {
      response = await call(base);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).not.toContain('ACCESS-MARKER');
    expect(body).not.toContain('REFRESH-MARKER');
    expect(diagnostics.join('\n')).not.toContain('ACCESS-MARKER');
    expect(diagnostics.join('\n')).not.toContain('REFRESH-MARKER');
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
    const expired = creds({ expiresAt: Date.now() - 1000 });
    const base = await startProxy({
      apiUpstream: api,
      readCredentials: () => expired,
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

    await Promise.all(proxies.map((instance) => instance.stop()));
    proxies = [];

    await expect(call(base)).rejects.toThrow();
  });
});
