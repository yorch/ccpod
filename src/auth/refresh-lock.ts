import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOCK_WAIT_MS = 30_000;
const RETRY_MS = 50;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBusy(error: unknown): boolean {
  return errorCode(error) === 'SQLITE_BUSY';
}

async function checkPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error('OAuth refresh lock directory is not private and owned');
  }
}

async function ensureLockDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw error;
    }
  }

  // O_EXCL publishes the empty regular file atomically with private mode. A
  // process killed before SQLite opens it leaves a valid zero-byte database
  // candidate that the next process can safely adopt; never replace or unlink
  // this shared pathname.
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (info.mode & 0o777) !== 0o600
  ) {
    throw new Error('OAuth refresh lock database is not a private owned file');
  }
}

async function openLockDatabase(path: string): Promise<Database> {
  await ensureLockDatabaseFile(path);
  const before = await lstat(path);
  const database = new Database(path, { create: false, readwrite: true });
  try {
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      (typeof process.getuid === 'function' &&
        after.uid !== process.getuid()) ||
      (after.mode & 0o777) !== 0o600 ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error('OAuth refresh lock database changed or is not private');
    }
    // Do not block the JavaScript event loop while another proxy owns the
    // transaction; contenders retry asynchronously until the bounded deadline.
    database.exec('PRAGMA busy_timeout = 0');
    const integrity = database.query('PRAGMA quick_check').get() as {
      quick_check?: unknown;
    } | null;
    if (integrity?.quick_check !== 'ok') {
      throw new Error('OAuth refresh lock database is corrupt');
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Serialize refresh-token rotation across ccpod processes sharing one host
 * credential store. SQLite's BEGIN IMMEDIATE lock is released by the OS when
 * a process exits, so no pathname-based stale-owner reclamation is needed.
 */
export async function withOAuthRefreshLock<T>(
  scope: string,
  fn: () => Promise<T>,
  root = join(homedir(), '.ccpod', 'oauth-locks'),
  lockWaitMs = LOCK_WAIT_MS,
): Promise<T> {
  await mkdir(root, { mode: 0o700, recursive: true });
  await checkPrivateDirectory(root);

  const name = createHash('sha256').update(scope).digest('hex');
  const database = await openLockDatabase(join(root, `${name}.sqlite`));
  const deadline = Date.now() + lockWaitMs;
  let acquired = false;
  try {
    while (!acquired) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for OAuth refresh lock');
      }
      try {
        database.exec('BEGIN IMMEDIATE');
        acquired = true;
      } catch (error) {
        if (!isBusy(error)) {
          throw new Error(
            `Cannot acquire OAuth refresh lock: ${errorMessage(error)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }

    try {
      const result = await fn();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}
