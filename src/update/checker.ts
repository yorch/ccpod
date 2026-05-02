import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GITHUB_REPO } from '../constants.ts';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  checkedAt: string;
  latestVersion: string;
}

export function cachePath(): string {
  return join(
    process.env.CCPOD_TEST_DIR ?? join(homedir(), '.ccpod'),
    'update-check.json',
  );
}

function readCache(): UpdateCache | null {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as UpdateCache;
  } catch {
    return null;
  }
}

export function writeCache(latestVersion: string): void {
  writeFileSync(
    cachePath(),
    JSON.stringify({ checkedAt: new Date().toISOString(), latestVersion }),
    'utf8',
  );
}

function isFresh(cache: UpdateCache): boolean {
  return Date.now() - new Date(cache.checkedAt).getTime() < CHECK_INTERVAL_MS;
}

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [lMaj, lMin, lPatch] = parse(latest);
  const [cMaj, cMin, cPatch] = parse(current);
  if (lMaj !== cMaj) return (lMaj ?? 0) > (cMaj ?? 0);
  if (lMin !== cMin) return (lMin ?? 0) > (cMin ?? 0);
  return (lPatch ?? 0) > (cPatch ?? 0);
}

export async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { 'User-Agent': 'ccpod-updater' }, signal: controller.signal },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Returns hint version if an update is available, null otherwise.
// Reads from cache instantly; triggers a background network refresh when stale.
export function checkForUpdate(currentVersion: string): string | null {
  const cache = readCache();

  if (!cache || !isFresh(cache)) {
    fetchLatestVersion()
      .then((v) => {
        if (v) writeCache(v);
      })
      .catch(() => {});
  }

  if (!cache) return null;
  return isNewer(cache.latestVersion, currentVersion)
    ? cache.latestVersion
    : null;
}
