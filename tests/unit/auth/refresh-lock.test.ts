import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withOAuthRefreshLock } from '../../../src/auth/refresh-lock.ts';

const tempDirs: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(path)) {
    throw new Error(`Timed out waiting for ${path}`);
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('withOAuthRefreshLock', () => {
  it('serializes concurrent waiters without overlapping refresh callbacks', async () => {
    const root = tempDir('ccpod-lock-contention-');
    const scope = 'synthetic-shared-store';
    let releaseFirst: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered: () => void = () => {};
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let entered = 0;
    let active = 0;
    let maxActive = 0;
    const callback = async (first: boolean) => {
      entered++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (first) {
        markFirstEntered();
        await held;
      }
      active--;
    };

    const first = withOAuthRefreshLock(scope, () => callback(true), root);
    await firstEntered;
    const second = withOAuthRefreshLock(scope, () => callback(false), root);
    const third = withOAuthRefreshLock(scope, () => callback(false), root);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(entered).toBe(1);

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(entered).toBe(3);
    expect(maxActive).toBe(1);
  });

  it('does not evict a live transaction and enforces the acquisition deadline', async () => {
    const root = tempDir('ccpod-lock-live-');
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const first = withOAuthRefreshLock(
      'live-store',
      async () => {
        markEntered();
        await held;
      },
      root,
    );
    await entered;

    await expect(
      withOAuthRefreshLock('live-store', async () => {}, root, 100),
    ).rejects.toThrow('Timed out waiting for OAuth refresh lock');
    release();
    await first;
  });

  it('releases the cross-process lock after its owner is killed', async () => {
    const root = tempDir('ccpod-lock-kill-');
    const marker = join(root, 'entered');
    const moduleUrl = new URL(
      '../../../src/auth/refresh-lock.ts',
      import.meta.url,
    ).href;
    const script = `
      import { writeFileSync } from 'node:fs';
      const { withOAuthRefreshLock } = await import(${JSON.stringify(moduleUrl)});
      await withOAuthRefreshLock('synthetic-killed-owner', async () => {
        writeFileSync(${JSON.stringify(marker)}, 'entered');
        await new Promise(() => {});
      }, ${JSON.stringify(root)});
    `;
    const child = Bun.spawn(['bun', '-e', script], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    children.push(child);
    await waitForFile(marker);
    child.kill('SIGKILL');
    await child.exited;

    const waiters = ['one', 'two'].map((label) => {
      const waiterScript = `
        import { existsSync, rmSync, writeFileSync } from 'node:fs';
        const { withOAuthRefreshLock } = await import(${JSON.stringify(moduleUrl)});
        const root = ${JSON.stringify(root)};
        const label = ${JSON.stringify(label)};
        writeFileSync(root+'/'+label+'.started', 'started');
        await withOAuthRefreshLock('synthetic-killed-owner', async () => {
          if (existsSync(root+'/active')) writeFileSync(root+'/overlap', 'yes');
          writeFileSync(root+'/active', label);
          writeFileSync(root+'/'+label+'.entered', 'entered');
          const deadline = Date.now()+5000;
          while (!existsSync(root+'/'+label+'.release') && Date.now()<deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          if (!existsSync(root+'/'+label+'.release')) throw new Error('release timeout');
          rmSync(root+'/active', { force:true });
        }, root);
      `;
      const waiter = Bun.spawn(['bun', '-e', waiterScript], {
        stderr: 'pipe',
        stdout: 'pipe',
      });
      children.push(waiter);
      return { label, process: waiter };
    });
    await Promise.all(
      waiters.map(({ label }) => waitForFile(join(root, `${label}.started`))),
    );

    const entryDeadline = Date.now() + 5_000;
    while (
      !existsSync(join(root, 'one.entered')) &&
      !existsSync(join(root, 'two.entered')) &&
      Date.now() < entryDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const firstEntered = existsSync(join(root, 'one.entered')) ? 'one' : 'two';
    const secondEntered = firstEntered === 'one' ? 'two' : 'one';
    expect(existsSync(join(root, `${firstEntered}.entered`))).toBe(true);
    expect(existsSync(join(root, `${secondEntered}.entered`))).toBe(false);
    expect(existsSync(join(root, 'overlap'))).toBe(false);

    writeFileSync(join(root, `${firstEntered}.release`), 'release');
    await waitForFile(join(root, `${secondEntered}.entered`));
    expect(existsSync(join(root, 'overlap'))).toBe(false);
    writeFileSync(join(root, `${secondEntered}.release`), 'release');
    await Promise.all(waiters.map(({ process: waiter }) => waiter.exited));
    const failures = await Promise.all(
      waiters.map(async ({ label, process: waiter }) => ({
        exitCode: waiter.exitCode,
        label,
        stderr: await new Response(waiter.stderr).text(),
      })),
    );
    expect(
      failures.filter(({ exitCode, stderr }) => exitCode !== 0 || stderr),
    ).toEqual([]);
  });

  it('adopts a private database after its exclusive creator dies before SQLite opens it', async () => {
    const root = tempDir('ccpod-lock-bootstrap-crash-');
    const scope = 'creator-crash-before-open';
    const name = createHash('sha256').update(scope).digest('hex');
    const databasePath = join(root, `${name}.sqlite`);
    const marker = join(root, 'created');
    const script = `
      import { open } from 'node:fs/promises';
      import { writeFileSync } from 'node:fs';
      process.umask(0o022);
      await open(${JSON.stringify(databasePath)}, 'wx', 0o600);
      writeFileSync(${JSON.stringify(marker)}, String((await import('node:fs')).statSync(${JSON.stringify(databasePath)}).mode & 0o777));
      await new Promise(() => {});
    `;
    const creator = Bun.spawn(['bun', '-e', script], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    children.push(creator);
    await waitForFile(marker);
    expect(Number(readFileSync(marker, 'utf8'))).toBe(0o600);
    creator.kill('SIGKILL');
    await creator.exited;

    let entered = false;
    await withOAuthRefreshLock(
      scope,
      async () => {
        entered = true;
      },
      root,
    );
    expect(entered).toBe(true);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it('uses independent lock databases for different scopes', async () => {
    const root = tempDir('ccpod-lock-scopes-');
    await withOAuthRefreshLock('store-one', async () => {}, root);
    await withOAuthRefreshLock('store-two', async () => {}, root);
    const one = join(
      root,
      `${createHash('sha256').update('store-one').digest('hex')}.sqlite`,
    );
    const two = join(
      root,
      `${createHash('sha256').update('store-two').digest('hex')}.sqlite`,
    );
    expect(existsSync(one)).toBe(true);
    expect(existsSync(two)).toBe(true);
    expect(one).not.toBe(two);
  });

  it('rejects a lock directory with unsafe permissions', async () => {
    const root = tempDir('ccpod-lock-mode-');
    chmodSync(root, 0o755);
    await expect(
      withOAuthRefreshLock('unsafe-root', async () => {}, root),
    ).rejects.toThrow('not private and owned');
  });

  it('rejects a symlinked lock directory', async () => {
    const root = tempDir('ccpod-lock-root-link-');
    const target = tempDir('ccpod-lock-root-target-');
    const linkedRoot = join(root, 'linked-locks');
    symlinkSync(target, linkedRoot);

    await expect(
      withOAuthRefreshLock('symlinked-root', async () => {}, linkedRoot),
    ).rejects.toThrow('not private and owned');
  });

  it('rejects a symlinked lock database without modifying its target', async () => {
    const root = tempDir('ccpod-lock-symlink-');
    const scope = 'symlinked-database';
    const name = createHash('sha256').update(scope).digest('hex');
    const target = join(root, 'target.sqlite');
    const lockPath = join(root, `${name}.sqlite`);
    writeFileSync(target, 'untouched');
    symlinkSync(target, lockPath);

    await expect(
      withOAuthRefreshLock(scope, async () => {}, root),
    ).rejects.toThrow('not a private owned file');
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('fails closed on a corrupt lock database', async () => {
    const root = tempDir('ccpod-lock-corrupt-');
    const scope = 'corrupt-database';
    const name = createHash('sha256').update(scope).digest('hex');
    const databasePath = join(root, `${name}.sqlite`);
    writeFileSync(databasePath, 'not a sqlite database');
    chmodSync(databasePath, 0o600);

    await expect(
      withOAuthRefreshLock(scope, async () => {}, root),
    ).rejects.toThrow();
  });

  it('rejects an existing lock database with unsafe permissions', async () => {
    const root = tempDir('ccpod-lock-db-mode-');
    const scope = 'unsafe-database';
    const name = createHash('sha256').update(scope).digest('hex');
    const databasePath = join(root, `${name}.sqlite`);
    writeFileSync(databasePath, 'not opened');
    chmodSync(databasePath, 0o644);

    await expect(
      withOAuthRefreshLock(scope, async () => {}, root),
    ).rejects.toThrow('not a private owned file');
    expect(readFileSync(databasePath, 'utf8')).toBe('not opened');
  });
});
