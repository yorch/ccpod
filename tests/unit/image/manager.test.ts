import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dockerExecMock = mock(
  async (
    _args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({
    exitCode: 0,
    stderr: '',
    stdout: '',
  }),
);
const dockerSpawnMock = mock(async (_args: string[]): Promise<number> => 0);

mock.module('../../../src/runtime/docker.ts', () => ({
  dockerExec: dockerExecMock,
  dockerSpawn: dockerSpawnMock,
}));

const { buildImage, ensureImage, ensureLocalImage } = await import(
  '../../../src/image/manager.ts'
);

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ccpod-imgmgr-test-'));
  dockerExecMock.mockReset();
  dockerSpawnMock.mockReset();
});

afterEach(() => {
  rmSync(testDir, { force: true, recursive: true });
});

describe('buildImage', () => {
  it('uses join(contextDir, dockerfile) when file exists there', async () => {
    writeFileSync(join(testDir, 'Dockerfile'), 'FROM scratch');
    dockerSpawnMock.mockResolvedValue(0);

    await buildImage('Dockerfile', 'test:latest', testDir);

    const args = dockerSpawnMock.mock.calls[0][0] as string[];
    const fIdx = args.indexOf('-f');
    expect(args[fIdx + 1]).toBe(join(testDir, 'Dockerfile'));
  });

  it('uses dockerfile as-is when not found in contextDir', async () => {
    const absDockerfile = '/some/absolute/Dockerfile';
    dockerSpawnMock.mockResolvedValue(0);

    await buildImage(absDockerfile, 'test:latest', testDir);

    const args = dockerSpawnMock.mock.calls[0][0] as string[];
    const fIdx = args.indexOf('-f');
    expect(args[fIdx + 1]).toBe(absDockerfile);
  });

  it('passes tag and contextDir correctly', async () => {
    writeFileSync(join(testDir, 'Dockerfile'), 'FROM scratch');
    dockerSpawnMock.mockResolvedValue(0);

    await buildImage('Dockerfile', 'my-image:v1', testDir);

    const args = dockerSpawnMock.mock.calls[0][0] as string[];
    expect(args).toContain('my-image:v1');
    expect(args[args.length - 1]).toBe(testDir);
  });

  it('throws on non-zero exit code', async () => {
    dockerSpawnMock.mockResolvedValue(2);
    await expect(
      buildImage('Dockerfile', 'test:latest', testDir),
    ).rejects.toThrow('docker build failed (exit 2)');
  });
});

describe('ensureLocalImage', () => {
  it('skips build when image exists and force=false', async () => {
    dockerExecMock.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });

    await ensureLocalImage('my-tag:latest', 'Dockerfile', testDir, false);

    expect(dockerSpawnMock).not.toHaveBeenCalled();
  });

  it('builds when image is not found locally', async () => {
    dockerExecMock.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });
    dockerSpawnMock.mockResolvedValue(0);

    await ensureLocalImage('my-tag:latest', 'Dockerfile', testDir, false);

    expect(dockerSpawnMock).toHaveBeenCalled();
  });

  it('builds when force=true even if image exists', async () => {
    dockerExecMock.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
    dockerSpawnMock.mockResolvedValue(0);

    await ensureLocalImage('my-tag:latest', 'Dockerfile', testDir, true);

    expect(dockerSpawnMock).toHaveBeenCalled();
  });
});

describe('ensureImage', () => {
  it('skips pull when image exists and force=false', async () => {
    dockerExecMock.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });

    await ensureImage('ghcr.io/test:latest', false);

    expect(dockerSpawnMock).not.toHaveBeenCalled();
  });

  it('pulls when image is not found locally', async () => {
    dockerExecMock.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });
    dockerSpawnMock.mockResolvedValue(0);

    await ensureImage('ghcr.io/test:latest', false);

    const args = dockerSpawnMock.mock.calls[0][0] as string[];
    expect(args).toContain('pull');
    expect(args).toContain('ghcr.io/test:latest');
  });

  it('pulls when force=true even if image exists', async () => {
    dockerExecMock.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '' });
    dockerSpawnMock.mockResolvedValue(0);

    await ensureImage('ghcr.io/test:latest', true);

    expect(dockerSpawnMock).toHaveBeenCalled();
  });

  it('throws when pull fails', async () => {
    dockerExecMock.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });
    dockerSpawnMock.mockResolvedValue(1);

    await expect(ensureImage('ghcr.io/test:latest', false)).rejects.toThrow(
      'docker pull failed',
    );
  });
});
