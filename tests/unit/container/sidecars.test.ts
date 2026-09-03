import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ServiceConfig } from '../../../src/types/index.ts';

// mock.module replaces the docker runtime so sidecars.ts calls our mock
// instead of shelling out to a real docker CLI. The mock records every call
// so tests can assert on argv structure and extraEnv handling.
type ExecResult = { exitCode: number; stdout: string; stderr: string };
type ExecCall = { args: string[]; extraEnv?: Record<string, string> };

let execCalls: ExecCall[] = [];
let execResults: ExecResult[] = [];

const dockerExecMock = mock(
  async (
    args: string[],
    extraEnv?: Record<string, string>,
  ): Promise<ExecResult> => {
    execCalls.push({ args, extraEnv });
    return execResults.shift() ?? { exitCode: 0, stderr: '', stdout: '' };
  },
);

const dockerSpawnMock = mock(async (_args: string[]): Promise<number> => 0);

mock.module('../../../src/runtime/docker.ts', () => ({
  dockerExec: dockerExecMock,
  dockerSpawn: dockerSpawnMock,
}));

// Import AFTER mock.module so the sidecars module picks up the mock.
const { startSidecars, sidecarNetworkName, removeSidecarNetwork } =
  await import('../../../src/container/sidecars.ts');

// Helper: a successful "network already exists" result for ensureNetwork.
const NET_EXISTS: ExecResult = { exitCode: 0, stderr: '', stdout: '' };

beforeEach(() => {
  execCalls = [];
  execResults = [];
  dockerExecMock.mockClear();
  dockerSpawnMock.mockClear();
});

afterEach(() => {
  execCalls = [];
  execResults = [];
});

// Find the first `docker run` call in the recorded exec calls.
function findRunCall(): ExecCall | undefined {
  return execCalls.find((c) => c.args[0] === 'run');
}

describe('startSidecars', () => {
  it('no-ops when services is empty', async () => {
    await startSidecars({}, 'ccpod-net-abc', 'prof', 'abc123');
    expect(dockerExecMock).not.toHaveBeenCalled();
  });

  it('starts a new sidecar with correct args', async () => {
    const svc: ServiceConfig = {
      image: 'postgres:16',
      ports: ['5432:5432'],
      volumes: ['pgdata:/var/lib/postgresql/data'],
    };
    execResults = [
      NET_EXISTS, // network inspect
      { exitCode: 1, stderr: 'No such container', stdout: '' }, // container inspect
      { exitCode: 0, stderr: '', stdout: '' }, // run
    ];

    await startSidecars({ db: svc }, 'ccpod-net-abc', 'prof', 'abc123');

    const runCall = findRunCall();
    expect(runCall).toBeDefined();
    expect(runCall?.args[0]).toBe('run');
    expect(runCall?.args).toContain('--name');
    expect(runCall?.args).toContain('ccpod-svc-prof-abc123-db');
    expect(runCall?.args).toContain('--network');
    expect(runCall?.args).toContain('ccpod-net-abc');
    expect(runCall?.args).toContain('postgres:16');
    expect(runCall?.args).toContain('-v');
    expect(runCall?.args).toContain('pgdata:/var/lib/postgresql/data');
    expect(runCall?.args).toContain('-p');
    expect(runCall?.args).toContain('5432:5432');
  });

  it('passes sidecar env via bare -e flags + extraEnv, not in argv', async () => {
    const svc: ServiceConfig = {
      env: { DATABASE_PASSWORD: 'supersecret', POSTGRES_USER: 'admin' },
      image: 'postgres:16',
    };
    execResults = [
      NET_EXISTS, // network inspect
      { exitCode: 1, stderr: 'No such container', stdout: '' }, // container inspect
      { exitCode: 0, stderr: '', stdout: '' }, // run
    ];

    await startSidecars({ db: svc }, 'ccpod-net-abc', 'prof', 'abc123');

    const runCall = findRunCall();
    expect(runCall).toBeDefined();
    const argv = runCall?.args.join(' ');
    // Secret values must NOT appear in the command line.
    expect(argv).not.toContain('supersecret');
    expect(argv).not.toContain('admin');
    // Bare -e KEY flags should be present.
    const eFlags = runCall?.args.filter(
      (_v, i) => runCall?.args[i - 1] === '-e',
    );
    expect(eFlags).toContain('DATABASE_PASSWORD');
    expect(eFlags).toContain('POSTGRES_USER');
    // Values are injected via extraEnv instead.
    expect(runCall?.extraEnv?.DATABASE_PASSWORD).toBe('supersecret');
    expect(runCall?.extraEnv?.POSTGRES_USER).toBe('admin');
  });

  it('reuses an already-running sidecar without starting a new one', async () => {
    const svc: ServiceConfig = { image: 'postgres:16' };
    execResults = [
      NET_EXISTS, // network inspect
      { exitCode: 0, stderr: '', stdout: 'running' }, // container inspect
    ];

    await startSidecars({ db: svc }, 'ccpod-net-abc', 'prof', 'abc123');

    // No run call — only network inspect + container inspect.
    expect(findRunCall()).toBeUndefined();
    expect(execCalls).toHaveLength(2);
  });

  it('replaces a stale (exited) sidecar before starting fresh', async () => {
    const svc: ServiceConfig = { image: 'postgres:16' };
    execResults = [
      NET_EXISTS, // network inspect
      { exitCode: 0, stderr: '', stdout: 'exited' }, // container inspect
      { exitCode: 0, stderr: '', stdout: '' }, // rm -f
      { exitCode: 0, stderr: '', stdout: '' }, // run
    ];

    await startSidecars({ db: svc }, 'ccpod-net-abc', 'prof', 'abc123');

    const rmCall = execCalls.find(
      (c) => c.args[0] === 'rm' && c.args.includes('-f'),
    );
    expect(rmCall).toBeDefined();
    expect(rmCall?.args).toContain('ccpod-svc-prof-abc123-db');
    expect(findRunCall()).toBeDefined();
  });

  it('rolls back started sidecars when a later one fails', async () => {
    // Biome's useSortedKeys rule alphabetizes object literals, so we name the
    // services to ensure the successful one ("aaa") sorts before the failing
    // one ("zzz"). This guarantees Object.entries processes aaa first.
    const okSvc: ServiceConfig = { image: 'redis:7' };
    const failSvc: ServiceConfig = { image: 'broken:latest' };

    // Override the global mock for this test with a name-aware one.
    dockerExecMock.mockImplementation(
      async (args: string[], extraEnv?: Record<string, string>) => {
        execCalls.push({ args, extraEnv });
        const joined = args.join(' ');
        // Network operations always succeed.
        if (args[0] === 'network') {
          return { exitCode: 0, stderr: '', stdout: '' };
        }
        // Container inspect: always "not found" so we proceed to run.
        if (args[0] === 'inspect') {
          return { exitCode: 1, stderr: 'No such container', stdout: '' };
        }
        // Run: succeed for "aaa", fail for "zzz".
        if (args[0] === 'run') {
          if (joined.includes('ccpod-svc-prof-abc123-aaa')) {
            return { exitCode: 0, stderr: '', stdout: '' };
          }
          return { exitCode: 1, stderr: 'image pull failed', stdout: '' };
        }
        // rm -f (rollback): always succeed.
        return { exitCode: 0, stderr: '', stdout: '' };
      },
    );

    try {
      await expect(
        startSidecars(
          { aaa: okSvc, zzz: failSvc },
          'ccpod-net-abc',
          'prof',
          'abc123',
        ),
      ).rejects.toThrow(/Failed to start sidecar/);

      // The rollback should remove the sidecar that started successfully (aaa),
      // not the one that failed (zzz).
      const rmCall = execCalls.find(
        (c) => c.args[0] === 'rm' && c.args.includes('-f'),
      );
      expect(rmCall).toBeDefined();
      expect(rmCall?.args).toContain('ccpod-svc-prof-abc123-aaa');
    } finally {
      // Restore the default sequential mock.
      dockerExecMock.mockImplementation(
        async (args: string[], extraEnv?: Record<string, string>) => {
          execCalls.push({ args, extraEnv });
          return execResults.shift() ?? { exitCode: 0, stderr: '', stdout: '' };
        },
      );
    }
  });

  it('throws when docker run fails', async () => {
    const svc: ServiceConfig = { image: 'broken:latest' };
    execResults = [
      NET_EXISTS, // network inspect
      { exitCode: 1, stderr: 'No such container', stdout: '' }, // container inspect
      { exitCode: 1, stderr: 'docker: image not found', stdout: '' }, // run
    ];

    await expect(
      startSidecars({ db: svc }, 'ccpod-net-abc', 'prof', 'abc123'),
    ).rejects.toThrow(/image not found/);
  });

  it('filters CCPOD_* and DOCKER_* from sidecar env', async () => {
    const svc: ServiceConfig = {
      env: {
        CCPOD_NETWORK_POLICY: 'full',
        DATABASE_PASSWORD: 'secret',
        DOCKER_HOST: 'tcp://attacker:2375',
      },
      image: 'postgres:16',
    };
    execResults = [
      NET_EXISTS, // network inspect
      { exitCode: 1, stderr: 'No such container', stdout: '' }, // container inspect
      { exitCode: 0, stderr: '', stdout: '' }, // run
    ];

    await startSidecars({ db: svc }, 'ccpod-net-abc', 'prof', 'abc123');

    const runCall = findRunCall();
    expect(runCall).toBeDefined();
    // DOCKER_HOST and CCPOD_NETWORK_POLICY must not appear in argv or extraEnv.
    const argv = runCall?.args.join(' ');
    expect(argv).not.toContain('DOCKER_HOST');
    expect(argv).not.toContain('CCPOD_NETWORK_POLICY');
    expect(runCall?.extraEnv).not.toHaveProperty('DOCKER_HOST');
    expect(runCall?.extraEnv).not.toHaveProperty('CCPOD_NETWORK_POLICY');
    // Legitimate env still passes through.
    expect(runCall?.extraEnv?.DATABASE_PASSWORD).toBe('secret');
  });

  it('rejects sidecar env keys containing = (would leak value in argv)', async () => {
    const svc: ServiceConfig = {
      env: { 'ANTHROPIC_API_KEY=sk-evil': '' },
      image: 'postgres:16',
    };
    execResults = [
      NET_EXISTS, // network inspect
      { exitCode: 1, stderr: 'No such container', stdout: '' }, // container inspect
      { exitCode: 0, stderr: '', stdout: '' }, // run
    ];

    await startSidecars({ db: svc }, 'ccpod-net-abc', 'prof', 'abc123');

    const runCall = findRunCall();
    expect(runCall).toBeDefined();
    // The malicious key must not appear in argv or extraEnv.
    const argv = runCall?.args.join(' ');
    expect(argv).not.toContain('sk-evil');
    expect(argv).not.toContain('ANTHROPIC_API_KEY=sk-evil');
    expect(runCall?.extraEnv).not.toHaveProperty('ANTHROPIC_API_KEY=sk-evil');
  });
});

describe('sidecarNetworkName', () => {
  it('produces ccpod-net-<hash>', () => {
    expect(sidecarNetworkName('abc123')).toBe('ccpod-net-abc123');
  });
});

describe('removeSidecarNetwork', () => {
  it('removes the network successfully', async () => {
    execResults = [{ exitCode: 0, stderr: '', stdout: '' }];
    await removeSidecarNetwork('ccpod-net-abc');
    expect(execCalls[0].args).toEqual(['network', 'rm', 'ccpod-net-abc']);
  });

  it('tolerates already-removed network', async () => {
    execResults = [
      {
        exitCode: 1,
        stderr: 'Error: no such network: ccpod-net-abc',
        stdout: '',
      },
    ];
    // Should not throw — "no such network" is expected after ccpod down.
    await removeSidecarNetwork('ccpod-net-abc');
  });

  it('warns on unexpected network removal failure', async () => {
    execResults = [
      { exitCode: 1, stderr: 'network has active endpoints', stdout: '' },
    ];
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      await removeSidecarNetwork('ccpod-net-abc');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});
