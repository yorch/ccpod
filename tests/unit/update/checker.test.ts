import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer } from '../../../src/update/checker.ts';

// isNewer is pure — no I/O needed
describe('isNewer()', () => {
  it('returns false when versions are equal', () => {
    expect(isNewer('v0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
  });

  it('detects patch bump', () => {
    expect(isNewer('v0.1.1', '0.1.0')).toBe(true);
    expect(isNewer('v0.1.0', '0.1.1')).toBe(false);
  });

  it('detects minor bump', () => {
    expect(isNewer('v0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('v0.1.9', '0.2.0')).toBe(false);
  });

  it('detects major bump', () => {
    expect(isNewer('v1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('v0.9.9', '1.0.0')).toBe(false);
  });

  it('handles missing v prefix on either side', () => {
    expect(isNewer('1.0.0', 'v0.9.9')).toBe(true);
    expect(isNewer('v1.0.0', '0.9.9')).toBe(true);
  });

  it('ignores pre-release suffixes when comparing different triples', () => {
    expect(isNewer('v1.2.3-rc1', '1.2.2')).toBe(true);
    expect(isNewer('v1.2.2', '1.2.3-rc1')).toBe(false);
  });

  it('treats GA as newer than the same triple with a pre-release', () => {
    expect(isNewer('v1.2.3', '1.2.3-rc1')).toBe(true);
    expect(isNewer('v1.2.3-rc1', '1.2.3')).toBe(false);
    // Two pre-releases on the same triple are not ordered against each other.
    expect(isNewer('v1.2.3-rc2', '1.2.3-rc1')).toBe(false);
  });

  it('treats missing minor/patch as zero', () => {
    expect(isNewer('v2.0', '1.9.9')).toBe(true);
    expect(isNewer('v2', '1.9.9')).toBe(true);
    expect(isNewer('v2.0', '2.0.0')).toBe(false);
    expect(isNewer('v2.0.0', '2.0')).toBe(false);
  });

  it('treats unparseable latest as 0.0.0 (no update offered)', () => {
    expect(isNewer('not-a-version', '1.0.0')).toBe(false);
  });

  it('treats unparseable current as 0.0.0 (update offered)', () => {
    expect(isNewer('1.0.0', 'not-a-version')).toBe(true);
  });
});

// checkForUpdate I/O uses an injected temporary cache and fake fetch only.
describe('checkForUpdate() — cache behaviour', () => {
  it('uses cached versions and waits for the injected background refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccpod-checker-'));
    const path = join(dir, 'cache.json');
    const pending: Promise<void>[] = [];
    try {
      const { checkForUpdate } = await import('../../../src/update/checker.ts');
      const dependencies = {
        cachePath: path,
        fetch: (async () =>
          new Response(JSON.stringify({ tag_name: 'v0.3.0' }))) as typeof fetch,
        scheduleBackground(task: Promise<void>) {
          pending.push(task);
        },
      };
      expect(checkForUpdate('0.1.0', dependencies)).toBeNull();
      await Promise.all(pending);
      expect(JSON.parse(readFileSync(path, 'utf8')).latestVersion).toBe(
        'v0.3.0',
      );
      expect(checkForUpdate('0.1.0', dependencies)).toBe('v0.3.0');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('does not let fake fetch or a deferred cache write escape the test', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccpod-checker-'));
    const path = join(dir, 'cache.json');
    const pending: Promise<void>[] = [];
    writeFileSync(
      path,
      JSON.stringify({ checkedAt: 'invalid', latestVersion: 'v0.2.0' }),
    );
    try {
      const { checkForUpdate } = await import('../../../src/update/checker.ts');
      const result = checkForUpdate('0.1.0', {
        cachePath: path,
        fetch: (async () =>
          new Response('offline', { status: 503 })) as typeof fetch,
        scheduleBackground(task) {
          pending.push(task);
        },
      });
      expect(result).toBe('v0.2.0');
      await Promise.all(pending);
      expect(JSON.parse(readFileSync(path, 'utf8')).latestVersion).toBe(
        'v0.2.0',
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
