import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  downloadAndReplace,
  type LatestRelease,
  parseChecksums,
} from '../../../src/update/updater.ts';

describe('parseChecksums', () => {
  it('parses sha256sum-style lines', () => {
    const map = parseChecksums(
      `${'a'.repeat(64)}  ccpod-linux-x64\n${'b'.repeat(64)}  ccpod-darwin-arm64`,
    );
    expect(map.get('ccpod-linux-x64')).toBe('a'.repeat(64));
    expect(map.get('ccpod-darwin-arm64')).toBe('b'.repeat(64));
  });

  it('accepts binary-mode asterisk prefix, comments and uppercase digest', () => {
    const map = parseChecksums(
      `# sums\n\n${'F'.repeat(64)} *ccpod-linux-arm64`,
    );
    expect(map.get('ccpod-linux-arm64')).toBe('f'.repeat(64));
  });

  it('skips malformed lines', () => {
    const map = parseChecksums(
      `short  ccpod-linux-x64\n${'e'.repeat(64)}  good`,
    );
    expect(map.has('ccpod-linux-x64')).toBe(false);
    expect(map.get('good')).toBe('e'.repeat(64));
  });
});

describe('downloadAndReplace', () => {
  let workDir = '';
  afterEach(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { force: true, recursive: true });
    }
    workDir = '';
  });

  const release: LatestRelease = {
    assetName: 'ccpod-test',
    checksumsUrl: 'https://example.invalid/SHASUMS256.txt',
    url: 'https://example.invalid/asset',
    version: 'v1.0.0',
  };
  const payload = new TextEncoder().encode('verified-binary');
  const digest = createHash('sha256').update(payload).digest('hex');
  const response = (body: Uint8Array) => new Response(body);
  const fetchFor = (checksums: string, binary = payload): typeof fetch =>
    (async (input: string | URL | Request) =>
      input.toString().endsWith('SHASUMS256.txt')
        ? new Response(checksums)
        : response(binary)) as typeof fetch;
  const targetWithOriginal = () => {
    workDir = mkdtempSync(join(tmpdir(), 'ccpod-upd-'));
    const target = join(workDir, 'ccpod');
    writeFileSync(target, 'original-binary');
    return target;
  };
  const validSums = `${digest}  ccpod-test\n`;

  it('stages beside the destination and replaces only after checksum validation', async () => {
    const target = targetWithOriginal();
    const stageParents: string[] = [];
    await downloadAndReplace(release, target, {
      createStageDir(prefix) {
        stageParents.push(prefix);
        return mkdtempSync(prefix);
      },
      fetch: fetchFor(validSums),
    });
    expect(stageParents[0]).toBe(join(workDir, '.ccpod-update-'));
    expect(readFileSync(target, 'utf8')).toBe('verified-binary');
  });

  it('preserves the original on checksum mismatch', async () => {
    const target = targetWithOriginal();
    await expect(
      downloadAndReplace(release, target, {
        fetch: fetchFor(`${'0'.repeat(64)}  ccpod-test`),
      }),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(readFileSync(target, 'utf8')).toBe('original-binary');
  });

  it('preserves the original if checksums cannot be fetched', async () => {
    const target = targetWithOriginal();
    await expect(
      downloadAndReplace(release, target, {
        fetch: (async (input: string | URL | Request) =>
          input.toString().endsWith('SHASUMS256.txt')
            ? new Response('unavailable', { status: 503 })
            : response(payload)) as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(readFileSync(target, 'utf8')).toBe('original-binary');
  });

  it('preserves the original if the checksum entry is malformed or missing', async () => {
    for (const sums of [
      `broken  ccpod-test\n`,
      `${digest}  another-binary\n`,
    ]) {
      const target = targetWithOriginal();
      await expect(
        downloadAndReplace(release, target, { fetch: fetchFor(sums) }),
      ).rejects.toThrow(/does not contain an entry/);
      expect(readFileSync(target, 'utf8')).toBe('original-binary');
      rmSync(workDir, { force: true, recursive: true });
      workDir = '';
    }
  });

  it('preserves the original on staging, stream-copy, chmod, and final rename failures', async () => {
    const target = targetWithOriginal();
    await expect(
      downloadAndReplace(release, target, {
        createStageDir: () => {
          throw new Error('stage failed');
        },
        fetch: fetchFor(validSums),
      }),
    ).rejects.toThrow('stage failed');
    expect(readFileSync(target, 'utf8')).toBe('original-binary');

    const writeFailed = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('copy failed'));
      },
    });
    await expect(
      downloadAndReplace(release, target, {
        createWriteStream: (() => writeFailed) as never,
        fetch: fetchFor(validSums),
      }),
    ).rejects.toThrow('copy failed');
    expect(readFileSync(target, 'utf8')).toBe('original-binary');

    await expect(
      downloadAndReplace(release, target, {
        chmod: () => {
          throw new Error('chmod failed');
        },
        fetch: fetchFor(validSums),
      }),
    ).rejects.toThrow('chmod failed');
    expect(readFileSync(target, 'utf8')).toBe('original-binary');

    await expect(
      downloadAndReplace(release, target, {
        fetch: fetchFor(validSums),
        rename: () => {
          throw new Error('rename failed');
        },
      }),
    ).rejects.toThrow('rename failed');
    expect(readFileSync(target, 'utf8')).toBe('original-binary');
  });
});
