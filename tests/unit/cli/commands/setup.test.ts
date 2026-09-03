import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';

// Mock docker runtime
const dockerExecMock = mock(
  async (
    _args: string[],
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> => ({ exitCode: 0, stderr: '', stdout: '' }),
);
const dockerSpawnMock = mock(async (_args: string[]): Promise<number> => 0);

mock.module('../../../../src/runtime/docker.ts', () => ({
  dockerExec: dockerExecMock,
  dockerSpawn: dockerSpawnMock,
}));

// Mock image manager to avoid real docker calls
mock.module('../../../../src/image/manager.ts', () => ({
  buildImage: mock(async () => {}),
  ensureImage: mock(async () => {}),
  ensureLocalImage: mock(async () => {}),
}));

// Mock writer to avoid filesystem writes
mock.module('../../../../src/config/writer.ts', () => ({
  writeMergedConfig: mock(() => '/tmp/fake-merged-config'),
}));

// Mock sidecars
mock.module('../../../../src/container/sidecars.ts', () => ({
  sidecarNetworkName: mock(() => 'ccpod-net-fake'),
  startSidecars: mock(async () => {}),
}));

// Mock git sync
mock.module('../../../../src/profile/git-sync.ts', () => ({
  syncGitConfig: mock(async () => {}),
}));

const { setupContainer } = await import(
  '../../../../src/cli/commands/_setup.ts'
);

let tmpDir: string;
let savedApiKey: string | undefined;
let savedAuthToken: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ccpod-setup-test-'));
  process.env.CCPOD_TEST_DIR = tmpDir;
  // Clear auth env vars so tests don't depend on the host environment
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  dockerExecMock.mockClear();
  dockerSpawnMock.mockClear();
});

afterEach(() => {
  rmSync(tmpDir, { force: true, recursive: true });
  delete process.env.CCPOD_TEST_DIR;
  if (savedApiKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = savedApiKey;
  }
  if (savedAuthToken !== undefined) {
    process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
  }
});

describe('setupContainer error handling (M7)', () => {
  it('throws (not process.exit) when explicit profile does not exist', async () => {
    await expect(
      setupContainer({ profile: 'nonexistent-profile' }, tmpDir),
    ).rejects.toThrow(/Profile 'nonexistent-profile' not found/);
  });

  it('throws when headless auth required but no API key set', async () => {
    // Create a profile with api-key auth but no key
    const profileDir = join(tmpDir, 'profiles', 'testprof');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'profile.yml'),
      yamlStringify({
        auth: { type: 'api-key' },
        config: { path: '/tmp', source: 'local' },
        name: 'testprof',
      }),
    );

    await expect(
      setupContainer({ profile: 'testprof', requireAuth: true }, tmpDir),
    ).rejects.toThrow(/Headless mode requires auth/);
  });

  it('throws when headless oauth but no prior login', async () => {
    const profileDir = join(tmpDir, 'profiles', 'oauthprof');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'profile.yml'),
      yamlStringify({
        auth: { type: 'oauth' },
        config: { path: '/tmp', source: 'local' },
        name: 'oauthprof',
      }),
    );

    await expect(
      setupContainer({ profile: 'oauthprof', requireAuth: true }, tmpDir),
    ).rejects.toThrow(/prior interactive login/);
  });

  it('rejects invalid profile name via validateProfileArg', async () => {
    // validateProfileArg calls process.exit(1) — spy on it to throw instead
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        setupContainer({ profile: '../etc' }, tmpDir),
      ).rejects.toThrow('process.exit');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
