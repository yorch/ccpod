import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_FILE = '.ccpod-sync-lock';

export function getLastSync(profileDir: string): Date | null {
  const lockPath = join(profileDir, LOCK_FILE);
  if (!existsSync(lockPath)) return null;
  const ts = Number(readFileSync(lockPath, 'utf8').trim());
  return Number.isNaN(ts) ? null : new Date(ts);
}

export function writeSyncLock(profileDir: string): void {
  writeFileSync(join(profileDir, LOCK_FILE), String(Date.now()), 'utf8');
}

export function shouldSync(
  profileDir: string,
  strategy: 'always' | 'daily' | 'pin',
): boolean {
  if (strategy === 'always') return true;
  if (strategy === 'pin') return false;
  const last = getLastSync(profileDir);
  if (!last) return true;
  const today = new Date().toDateString();
  return last.toDateString() !== today;
}
