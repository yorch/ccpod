import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mock.module('../../../src/runtime/detector.ts', () => ({
  detectRuntime: () => ({
    dockerHost: 'unix:///tmp/fake-docker.sock',
    name: 'docker',
    socketPath: '/tmp/fake-docker.sock',
  }),
}));
const { dockerExec } = await import('../../../src/runtime/docker.ts');

let tempDir = '';
let previousPath: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { force: true, recursive: true });
    tempDir = '';
  }
  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
  previousPath = undefined;
});

async function useSleepAsDocker(): Promise<void> {
  tempDir = mkdtempSync(join(tmpdir(), 'ccpod-fake-docker-'));
  previousPath = process.env.PATH;
  const fakeDocker = join(tempDir, 'docker');
  writeFileSync(fakeDocker, '#!/bin/sh\nexec /bin/sleep "$@"\n');
  chmodSync(fakeDocker, 0o700);
  process.env.PATH = tempDir;
}

async function useForkingAsDocker(): Promise<string> {
  tempDir = mkdtempSync(join(tmpdir(), 'ccpod-fake-docker-'));
  previousPath = process.env.PATH;
  const fakeDocker = join(tempDir, 'docker');
  const childMarker = join(tempDir, 'child-finished');
  writeFileSync(
    fakeDocker,
    `#!/bin/sh\n/bin/sh -c '/bin/sleep 0.3; echo finished > "${childMarker}"' &\nwait\n`,
  );
  chmodSync(fakeDocker, 0o700);
  process.env.PATH = tempDir;
  return childMarker;
}

describe('dockerExec timeout', () => {
  it('preserves the existing unbounded-call behavior when no timeout is supplied', async () => {
    await useSleepAsDocker();
    await expect(dockerExec(['0'])).resolves.toMatchObject({ exitCode: 0 });
  });

  it('kills and reaps an overdue docker child before rejecting', async () => {
    await useSleepAsDocker();
    const startedAt = Date.now();
    await expect(
      dockerExec(['30'], undefined, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out after 50ms/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('kills wrapper descendants that inherit the captured output pipes', async () => {
    const childMarker = await useForkingAsDocker();
    const startedAt = Date.now();

    await expect(dockerExec([], undefined, { timeoutMs: 50 })).rejects.toThrow(
      /timed out after 50ms/,
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(existsSync(childMarker)).toBe(false);
  });
});
