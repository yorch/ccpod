import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GITHUB_REPO } from '../constants.ts';
import { getCcpodHome } from '../profile/manager.ts';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  checkedAt: string;
  latestVersion: string;
}

function cachePath(): string {
  return join(getCcpodHome(), 'update-check.json');
}

function readCache(): UpdateCache | null {
  const path = cachePath();
  if (!existsSync(path)) {
    return null;
  }
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
  // Strip a leading "v" and any pre-release / build suffix (e.g. "-rc1",
  // "+meta") to compare on the numeric triple. Missing minor/patch
  // components default to 0 so "v2.0" is treated as "2.0.0". A version
  // without a pre-release is considered newer than one with the same
  // triple plus pre-release (so users on `1.2.3-rc1` are prompted to
  // upgrade to `1.2.3` GA).
  const parse = (v: string): [number, number, number, boolean] => {
    const match = v.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[\w.+-]+)?/);
    if (!match) {
      return [0, 0, 0, false];
    }
    return [
      Number(match[1]),
      Number(match[2] ?? 0),
      Number(match[3] ?? 0),
      Boolean(match[4]),
    ];
  };
  const [lMaj, lMin, lPatch, lPre] = parse(latest);
  const [cMaj, cMin, cPatch, cPre] = parse(current);
  if (lMaj !== cMaj) {
    return lMaj > cMaj;
  }
  if (lMin !== cMin) {
    return lMin > cMin;
  }
  if (lPatch !== cPatch) {
    return lPatch > cPatch;
  }
  // Same numeric triple — GA is newer than pre-release, but we don't
  // attempt to order between two pre-releases (rc1 vs rc2).
  return !lPre && cPre;
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { 'User-Agent': 'ccpod-updater' }, signal: controller.signal },
    );
    if (!res.ok) {
      return null;
    }
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
        if (v) {
          writeCache(v);
        }
      })
      .catch(() => {});
  }

  if (!cache) {
    return null;
  }
  return isNewer(cache.latestVersion, currentVersion)
    ? cache.latestVersion
    : null;
}
