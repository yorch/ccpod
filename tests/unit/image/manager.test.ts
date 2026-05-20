import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageDeps } from '../../../src/image/manager.ts';
import {
  buildImage,
  ensureImage,
  ensureLocalImage,
} from '../../../src/image/manager.ts';

type ExecResult = { exitCode: number; stdout: string; stderr: string };

function makeDeps(
  execResult: ExecResult = { exitCode: 0, stderr: '', stdout: '' },
  spawnResult = 0,
): {
  deps: ImageDeps;
  execMock: ReturnType<typeof mock>;
  spawnMock: ReturnType<typeof mock>;
} {
  const execMock = mock(
    async (_args: string[]): Promise<ExecResult> => execResult,
  );
  const spawnMock = mock(
    async (_args: string[]): Promise<number> => spawnResult,
  );
  return {
    deps: {
      dockerExec: execMock as ImageDeps['dockerExec'],
      dockerSpawn: spawnMock as ImageDeps['dockerSpawn'],
    },
    execMock,
    spawnMock,
  };
}

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ccpod-imgmgr-test-'));
});

function cleanup() {
  rmSync(testDir, { force: true, recursive: true });
}

describe('buildImage', () => {
  it('uses join(contextDir, dockerfile) when file exists there', async () => {
    writeFileSync(join(testDir, 'Dockerfile'), 'FROM scratch');
    const { deps, spawnMock } = makeDeps();

    await buildImage('Dockerfile', 'test:latest', testDir, deps);

    const args = (spawnMock.mock.calls[0] as [string[]])[0];
    const fIdx = args.indexOf('-f');
    expect(args[fIdx + 1]).toBe(join(testDir, 'Dockerfile'));
    cleanup();
  });

  it('uses dockerfile as-is when not found in contextDir', async () => {
    const absDockerfile = '/some/absolute/Dockerfile';
    const { deps, spawnMock } = makeDeps();

    await buildImage(absDockerfile, 'test:latest', testDir, deps);

    const args = (spawnMock.mock.calls[0] as [string[]])[0];
    const fIdx = args.indexOf('-f');
    expect(args[fIdx + 1]).toBe(absDockerfile);
    cleanup();
  });

  it('passes tag and contextDir correctly', async () => {
    writeFileSync(join(testDir, 'Dockerfile'), 'FROM scratch');
    const { deps, spawnMock } = makeDeps();

    await buildImage('Dockerfile', 'my-image:v1', testDir, deps);

    const args = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(args).toContain('my-image:v1');
    expect(args[args.length - 1]).toBe(testDir);
    cleanup();
  });

  it('throws on non-zero exit code', async () => {
    const { deps } = makeDeps(undefined, 2);
    await expect(
      buildImage('Dockerfile', 'test:latest', testDir, deps),
    ).rejects.toThrow('docker build failed (exit 2)');
    cleanup();
  });
});

describe('ensureLocalImage', () => {
  it('skips build when image exists and force=false', async () => {
    const { deps, spawnMock } = makeDeps({
      exitCode: 0,
      stderr: '',
      stdout: '',
    });

    await ensureLocalImage('my-tag:latest', 'Dockerfile', testDir, false, deps);

    expect(spawnMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('builds when image is not found locally', async () => {
    const { deps, spawnMock } = makeDeps({
      exitCode: 1,
      stderr: '',
      stdout: '',
    });

    await ensureLocalImage('my-tag:latest', 'Dockerfile', testDir, false, deps);

    expect(spawnMock).toHaveBeenCalled();
    cleanup();
  });

  it('builds when force=true even if image exists', async () => {
    const { deps, spawnMock } = makeDeps({
      exitCode: 0,
      stderr: '',
      stdout: '',
    });

    await ensureLocalImage('my-tag:latest', 'Dockerfile', testDir, true, deps);

    expect(spawnMock).toHaveBeenCalled();
    cleanup();
  });
});

describe('ensureImage', () => {
  it('skips pull when image exists and force=false', async () => {
    const { deps, spawnMock } = makeDeps({
      exitCode: 0,
      stderr: '',
      stdout: '',
    });

    await ensureImage('ghcr.io/test:latest', false, deps);

    expect(spawnMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('pulls when image is not found locally', async () => {
    const { deps, spawnMock } = makeDeps({
      exitCode: 1,
      stderr: '',
      stdout: '',
    });

    await ensureImage('ghcr.io/test:latest', false, deps);

    const args = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(args).toContain('pull');
    expect(args).toContain('ghcr.io/test:latest');
    cleanup();
  });

  it('pulls when force=true even if image exists', async () => {
    const { deps, spawnMock } = makeDeps({
      exitCode: 0,
      stderr: '',
      stdout: '',
    });

    await ensureImage('ghcr.io/test:latest', true, deps);

    expect(spawnMock).toHaveBeenCalled();
    cleanup();
  });

  it('throws when pull fails', async () => {
    const { deps } = makeDeps({ exitCode: 1, stderr: '', stdout: '' }, 1);

    await expect(
      ensureImage('ghcr.io/test:latest', false, deps),
    ).rejects.toThrow('docker pull failed');
    cleanup();
  });
});
