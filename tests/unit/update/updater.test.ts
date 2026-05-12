import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadAndReplace,
  type LatestRelease,
  parseChecksums,
} from '../../../src/update/updater.ts';

describe('parseChecksums', () => {
  it('parses sha256sum-style lines', () => {
    const txt = [
      `${'a'.repeat(64)}  ccpod-linux-x64`,
      `${'b'.repeat(64)}  ccpod-darwin-arm64`,
    ].join('\n');
    const map = parseChecksums(txt);
    expect(map.get('ccpod-linux-x64')).toBe('a'.repeat(64));
    expect(map.get('ccpod-darwin-arm64')).toBe('b'.repeat(64));
  });

  it('accepts binary-mode asterisk prefix', () => {
    const txt = `${'c'.repeat(64)} *ccpod-linux-arm64`;
    expect(parseChecksums(txt).get('ccpod-linux-arm64')).toBe('c'.repeat(64));
  });

  it('ignores blank lines and comments', () => {
    const txt = ['# header', '', `${'d'.repeat(64)}  ccpod-linux-x64`].join(
      '\n',
    );
    expect(parseChecksums(txt).size).toBe(1);
  });

  it('skips malformed lines', () => {
    const txt = ['short  ccpod-linux-x64', `${'e'.repeat(64)}  good`].join(
      '\n',
    );
    const map = parseChecksums(txt);
    expect(map.has('ccpod-linux-x64')).toBe(false);
    expect(map.get('good')).toBe('e'.repeat(64));
  });

  it('lowercases hex digests', () => {
    const txt = `${'F'.repeat(64)}  ccpod-linux-x64`;
    expect(parseChecksums(txt).get('ccpod-linux-x64')).toBe('f'.repeat(64));
  });
});

describe('downloadAndReplace — streaming + integrity verification', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { force: true, recursive: true });
    }
  });

  function streamBody(payload: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
  }

  function mockFetch(checksums: string, payload: Uint8Array): typeof fetch {
    return mock(async (url: string | URL | Request) => {
      const s = url.toString();
      if (s.endsWith('SHASUMS256.txt')) {
        return { ok: true, text: async () => checksums };
      }
      return { body: streamBody(payload), ok: true };
    }) as typeof fetch;
  }

  const release = (overrides: Partial<LatestRelease> = {}): LatestRelease => ({
    assetName: 'ccpod-test',
    checksumsUrl: 'https://x/SHASUMS256.txt',
    url: 'https://x/asset',
    version: 'v1.0.0',
    ...overrides,
  });

  it('writes the binary when SHA-256 matches', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ccpod-upd-'));
    const target = join(workDir, 'ccpod-test');
    const payload = new TextEncoder().encode('binary-bytes-v1');
    const sha = createHash('sha256').update(payload).digest('hex');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(`${sha}  ccpod-test\n`, payload);
    try {
      await downloadAndReplace(release(), target);
      expect(readFileSync(target).toString()).toBe('binary-bytes-v1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to install on SHA-256 mismatch', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ccpod-upd-'));
    const target = join(workDir, 'ccpod-test');
    const payload = new TextEncoder().encode('tampered');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(`${'0'.repeat(64)}  ccpod-test\n`, payload);
    try {
      await expect(downloadAndReplace(release(), target)).rejects.toThrow(
        /[Cc]hecksum mismatch/,
      );
      expect(existsSync(target)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
