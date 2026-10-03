import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  listVolumeEntries,
  removeVolume,
  volumeExists,
} from '../../../src/plugins/volume.ts';
import { dockerExec, dockerSpawn } from '../../../src/runtime/docker.ts';

const TEST_VOLUME = `ccpod-test-${Date.now()}`;

beforeAll(async () => {
  const { exitCode } = await dockerExec(['info']);
  if (exitCode !== 0) {
    throw new Error('Docker is not available — skipping integration tests');
  }
  // Pre-pull so the first test doesn't pay for the pull inside its own timeout
  const pull = await dockerExec(['pull', 'alpine']);
  if (pull.exitCode !== 0) {
    throw new Error(`Failed to pull alpine: ${pull.stderr}`);
  }
  // The first `docker run` on a fresh CI runner also pays one-time costs
  // (snapshot unpack, network setup) beyond the pull; do it here so the timed
  // tests below measure only their own run.
  const warm = await dockerExec(['run', '--rm', 'alpine', 'true']);
  if (warm.exitCode !== 0) {
    throw new Error(`Failed to start alpine: ${warm.stderr}`);
  }
}, 120_000);

// Container runs get a generous per-test timeout: they depend on the runner's
// Docker daemon, not on our code, and a 5s default flaked in CI.
const RUN_TIMEOUT_MS = 30_000;

afterAll(async () => {
  // Clean up test volume if left behind
  await dockerExec(['volume', 'rm', TEST_VOLUME]).catch(() => {});
});

describe('dockerExec', () => {
  it('returns version output', async () => {
    const { exitCode, stdout } = await dockerExec([
      'version',
      '--format',
      '{{.Client.Version}}',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('returns non-zero exit for bad command', async () => {
    const { exitCode } = await dockerExec([
      'inspect',
      'ccpod-nonexistent-container-xyz',
    ]);
    expect(exitCode).not.toBe(0);
  });
});

describe('dockerSpawn (container run)', () => {
  it(
    'runs alpine and exits with correct code',
    async () => {
      const exitCode = await dockerSpawn([
        'run',
        '--rm',
        'alpine',
        'sh',
        '-c',
        'exit 0',
      ]);
      expect(exitCode).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'propagates non-zero exit code',
    async () => {
      const exitCode = await dockerSpawn([
        'run',
        '--rm',
        'alpine',
        'sh',
        '-c',
        'exit 42',
      ]);
      expect(exitCode).toBe(42);
    },
    RUN_TIMEOUT_MS,
  );
});

describe('volume lifecycle', () => {
  it('volumeExists returns false for missing volume', async () => {
    expect(await volumeExists('ccpod-test-nonexistent-xyz')).toBe(false);
  });

  it('creates, lists entries, and removes a volume', async () => {
    // Create volume by running a container that writes to it
    const createExit = await dockerSpawn([
      'run',
      '--rm',
      '-v',
      `${TEST_VOLUME}:/data`,
      'alpine',
      'sh',
      '-c',
      'echo hello > /data/file.txt && mkdir /data/subdir',
    ]);
    expect(createExit).toBe(0);

    expect(await volumeExists(TEST_VOLUME)).toBe(true);

    const entries = await listVolumeEntries(TEST_VOLUME, '/data');
    expect(entries).toContain('file.txt');
    expect(entries).toContain('subdir');

    await removeVolume(TEST_VOLUME);
    expect(await volumeExists(TEST_VOLUME)).toBe(false);
  });
});
