import { afterEach, describe, expect, it } from 'bun:test';
import { AuthProxy, generateSentinelApiKey } from '../../../src/auth/proxy.ts';

describe('generateSentinelApiKey', () => {
  it('produces a format-valid sentinel that looks like an API key', () => {
    const key = generateSentinelApiKey();
    expect(key).toMatch(/^sk-ant-api03-ccpod-proxy-/);
  });

  it('produces unique values on each call', () => {
    const a = generateSentinelApiKey();
    const b = generateSentinelApiKey();
    expect(a).not.toBe(b);
  });
});

describe('AuthProxy', () => {
  let proxy: AuthProxy | null = null;

  afterEach(async () => {
    await proxy?.stop();
    proxy = null;
  });

  async function startProxy(sentinelKey: string): Promise<string> {
    proxy = new AuthProxy({
      hostname: '127.0.0.1',
      readCredentials: () => ({
        accessToken: 'access',
        // Far enough out that start() does not attempt a network refresh.
        expiresAt: Date.now() + 24 * 60 * 60 * 1000 * 365,
        refreshToken: 'refresh',
      }),
      sentinelKey,
    });
    await proxy.start();
    return `http://127.0.0.1:${proxy.resolvedPort}`;
  }

  it('answers the health check without a sentinel key', async () => {
    const base = await startProxy('sentinel-key-123');
    const res = await fetch(`${base}/__ccpod_health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects requests with a missing sentinel key', async () => {
    const base = await startProxy('sentinel-key-123');
    const res = await fetch(`${base}/v1/messages`, {
      body: '{}',
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('rejects wrong sentinel keys, including different lengths', async () => {
    const base = await startProxy('sentinel-key-123');
    for (const key of [
      'sentinel-key-124',
      'short',
      'sentinel-key-123-and-more',
    ]) {
      const res = await fetch(`${base}/v1/messages`, {
        body: '{}',
        headers: { 'x-api-key': key },
        method: 'POST',
      });
      expect(res.status).toBe(401);
    }
  });

  it('fails to start when no host credentials exist', async () => {
    proxy = new AuthProxy({
      hostname: '127.0.0.1',
      readCredentials: () => undefined,
    });
    await expect(proxy.start()).rejects.toThrow(/No OAuth credentials/);
    proxy = null;
  });
});
