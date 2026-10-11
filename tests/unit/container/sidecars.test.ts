import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { ServiceConfig } from '../../../src/types/index.ts';

type ExecResult = { exitCode: number; stdout: string; stderr: string };
type ExecCall = {
  args: string[];
  extraEnv?: Record<string, string>;
  options?: { timeoutMs?: number };
};
type SimContainer = {
  health?: string;
  healthcheck?: boolean;
  id: string;
  state: string;
};
let execCalls: ExecCall[] = [];
let containers: Map<string, SimContainer>;
let created = 0;
let inspectHook:
  | ((name: string, current: SimContainer) => ExecResult | undefined)
  | undefined;
let startFailure = '';
let startThrows = false;
let createThrows = false;
let healthSequence: string[] = [];
let replaceDuringReadiness = false;
const dockerExecMock = mock(
  async (
    args: string[],
    extraEnv?: Record<string, string>,
    options?: { timeoutMs?: number },
  ): Promise<ExecResult> => {
    execCalls.push({ args, extraEnv, options });
    if (args[0] === 'network') {
      return { exitCode: 0, stderr: '', stdout: '' };
    }
    if (args[0] === 'inspect') {
      const name = args.at(-1) ?? '';
      if (
        replaceDuringReadiness &&
        (name.startsWith('owned-') || name === 'existing-id')
      ) {
        replaceDuringReadiness = false;
        containers.delete(containerName('db'));
        containers.set(containerName('db'), {
          health: 'healthy',
          healthcheck: true,
          id: 'replacement-id',
          state: 'running',
        });
      }
      const current =
        containers.get(name) ??
        [...containers.values()].find((c) => c.id === name);
      if (!current) {
        return { exitCode: 1, stderr: 'No such container', stdout: '' };
      }
      const hooked = inspectHook?.(name, current);
      if (hooked) {
        return hooked;
      }
      if (healthSequence.length) {
        current.health = healthSequence.shift() ?? '';
      }
      return {
        exitCode: 0,
        stderr: '',
        stdout: `${current.id}|${current.state}|${current.health ?? ''}|${current.healthcheck ? 'yes' : ''}`,
      };
    }
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const id = `owned-${++created}`;
      if (createThrows) {
        const cidFile = args[args.indexOf('--cidfile') + 1];
        if (cidFile) {
          writeFileSync(cidFile, 'a'.repeat(64));
        }
        throw new Error('docker command timed out after 10ms');
      }
      containers.set(name, {
        health: 'starting',
        healthcheck: true,
        id,
        state: 'created',
      });
      return { exitCode: 0, stderr: '', stdout: id };
    }
    if (args[0] === 'start') {
      const id = args[1];
      if (startThrows) {
        throw new Error('start subprocess failed');
      }
      const current = [...containers.values()].find(
        (container) => container.id === id,
      );
      if (startFailure) {
        return { exitCode: 1, stderr: startFailure, stdout: '' };
      }
      if (current) {
        current.state = 'running';
      }
      return { exitCode: 0, stderr: '', stdout: id };
    }
    return { exitCode: 0, stderr: '', stdout: '' };
  },
);
mock.module('../../../src/runtime/docker.ts', () => ({
  dockerExec: dockerExecMock,
  dockerSpawn: mock(async () => 0),
}));
const { startSidecars, sidecarNetworkName, removeSidecarNetwork } =
  await import('../../../src/container/sidecars.ts');

beforeEach(() => {
  execCalls = [];
  containers = new Map();
  created = 0;
  inspectHook = undefined;
  startFailure = '';
  startThrows = false;
  createThrows = false;
  healthSequence = [];
  replaceDuringReadiness = false;
  dockerExecMock.mockClear();
});
afterEach(() => {
  execCalls = [];
});
const startedIds = () =>
  execCalls
    .filter(({ args }) => args[0] === 'start')
    .map(({ args }) => args[1]);
const removedIds = () =>
  execCalls
    .filter(({ args }) => args[0] === 'rm')
    .map(({ args }) => args.at(-1));
const containerName = (service: string) => `ccpod-svc-prof-abc123-${service}`;

describe('startSidecars', () => {
  it('no-ops for empty service lists', async () => {
    await startSidecars({}, 'ccpod-net-abc', 'prof', 'abc123');
    expect(execCalls).toEqual([]);
  });

  it('rejects missing dependencies and cycles before any Docker side effects', async () => {
    await expect(
      startSidecars(
        { app: { dependsOn: ['db'], image: 'app' } },
        'n',
        'p',
        'h',
      ),
    ).rejects.toThrow(/missing service/);
    expect(execCalls).toHaveLength(0);
    await expect(
      startSidecars(
        {
          a: { dependsOn: ['b'], image: 'a' },
          b: { dependsOn: ['a'], image: 'b' },
        },
        'n',
        'p',
        'h',
      ),
    ).rejects.toThrow(/cycle/);
    expect(execCalls).toHaveLength(0);
  });

  it('starts sequentially in deterministic topological order', async () => {
    const services: Record<string, ServiceConfig> = {
      app: { dependsOn: ['db', 'cache'], image: 'app' },
      cache: { image: 'cache' },
      db: { image: 'db' },
      zeta: { image: 'z' },
    };
    await startSidecars(services, 'ccpod-net-abc', 'prof', 'abc123');
    expect(startedIds()).toEqual(['owned-1', 'owned-2', 'owned-3', 'owned-4']);
    const createdImageOrder = execCalls
      .filter(({ args }) => args[0] === 'create')
      .map(({ args }) => args.at(-1));
    expect(createdImageOrder).toEqual(['cache', 'db', 'app', 'z']);
  });

  it('passes sidecar env via bare -e flags and starts by captured id', async () => {
    await startSidecars(
      { db: { env: { PASSWORD: 'secret' }, image: 'postgres:16' } },
      'n',
      'prof',
      'abc123',
    );
    const create = execCalls.find(({ args }) => args[0] === 'create');
    expect(create).toBeDefined();
    if (!create) {
      return;
    }
    expect(create.args).toContain('PASSWORD');
    expect(create.args.join(' ')).not.toContain('secret');
    expect(create.extraEnv?.PASSWORD).toBe('secret');
    expect(startedIds()).toEqual(['owned-1']);
  });

  it('waits for an image healthcheck to become healthy', async () => {
    healthSequence = ['starting', 'healthy'];
    await startSidecars(
      { db: { image: 'db', ready: { timeoutSeconds: 1 } } },
      'n',
      'prof',
      'abc123',
    );
    const inspections = execCalls.filter(({ args }) => args[0] === 'inspect');
    expect(inspections).toHaveLength(3);
    expect(
      inspections.slice(1).every(({ args }) => args.at(-1) === 'owned-1'),
    ).toBe(true);
    expect(inspections[1]?.options?.timeoutMs).toBeGreaterThan(0);
    expect(
      execCalls.find(({ args }) => args[0] === 'create')?.options?.timeoutMs,
    ).toBeGreaterThan(0);
    expect(
      execCalls.find(({ args }) => args[0] === 'start')?.options?.timeoutMs,
    ).toBeGreaterThan(0);
  });

  it('fails readiness for absent healthcheck, unhealthy, exited, and timeout', async () => {
    const cases: Array<[string, (current: SimContainer) => void, string]> = [
      [
        'no healthcheck',
        (c) => {
          c.healthcheck = false;
        },
        /no configured image healthcheck/,
      ],
      [
        'unhealthy',
        (c) => {
          c.health = 'unhealthy';
        },
        /became unhealthy/,
      ],
      [
        'exited',
        (c) => {
          c.state = 'exited';
        },
        /exited while waiting/,
      ],
      [
        'timeout',
        (c) => {
          c.health = 'starting';
        },
        /Timed out/,
      ],
    ];
    for (const [label, configure, error] of cases) {
      execCalls = [];
      containers = new Map();
      created = 0;
      inspectHook = (_name, current) => {
        if (current.state === 'running') {
          configure(current);
        }
        return undefined;
      };
      const timeoutSeconds = label === 'timeout' ? 1 : 2;
      await expect(
        startSidecars(
          { db: { image: 'db', ready: { timeoutSeconds } } },
          'n',
          'prof',
          'abc123',
        ),
      ).rejects.toThrow(error);
      expect(removedIds()).toContain('owned-1');
    }
  });

  it('fails if the captured container disappears and its name is replaced during readiness', async () => {
    replaceDuringReadiness = true;
    await expect(
      startSidecars(
        { db: { image: 'db', ready: { timeoutSeconds: 1 } } },
        'n',
        'prof',
        'abc123',
      ),
    ).rejects.toThrow(/disappeared while waiting/);
    const inspections = execCalls.filter(({ args }) => args[0] === 'inspect');
    expect(inspections.map(({ args }) => args.at(-1))).toEqual([
      containerName('db'),
      'owned-1',
    ]);
    expect(removedIds()).toEqual(['owned-1']);
  });

  it('fails if a reused container disappears and its name is replaced during readiness', async () => {
    containers.set(containerName('db'), {
      health: 'starting',
      healthcheck: true,
      id: 'existing-id',
      state: 'running',
    });
    replaceDuringReadiness = true;
    await expect(
      startSidecars(
        { db: { image: 'db', ready: { timeoutSeconds: 1 } } },
        'n',
        'prof',
        'abc123',
      ),
    ).rejects.toThrow(/disappeared while waiting/);
    expect(removedIds()).toEqual([]);
    expect(
      execCalls
        .filter(({ args }) => args[0] === 'inspect')
        .map(({ args }) => args.at(-1)),
    ).toEqual([containerName('db'), 'existing-id']);
  });

  it('does not wait for health when ready is omitted', async () => {
    await startSidecars({ db: { image: 'db' } }, 'n', 'prof', 'abc123');
    expect(execCalls.filter(({ args }) => args[0] === 'inspect')).toHaveLength(
      1,
    );
  });

  it('checks readiness of reused services but never owns or removes them', async () => {
    containers.set(containerName('db'), {
      health: 'healthy',
      healthcheck: true,
      id: 'existing-id',
      state: 'running',
    });
    await startSidecars(
      { db: { image: 'db', ready: {} } },
      'n',
      'prof',
      'abc123',
    );
    expect(startedIds()).toEqual([]);
    expect(removedIds()).toEqual([]);
  });

  it('rolls back only captured IDs, including create-success/start-failure', async () => {
    startFailure = 'start rejected';
    await expect(
      startSidecars({ db: { image: 'db' } }, 'n', 'prof', 'abc123'),
    ).rejects.toThrow(/start rejected/);
    expect(removedIds()).toEqual(['owned-1']);
    expect(removedIds()).not.toContain(containerName('db'));
  });

  it('rolls back a created ID if the Docker start invocation throws', async () => {
    startThrows = true;
    await expect(
      startSidecars({ db: { image: 'db' } }, 'n', 'prof', 'abc123'),
    ).rejects.toThrow(/start subprocess failed/);
    expect(removedIds()).toEqual(['owned-1']);
  });

  it('bounds create and recovers an ambiguous created ID from the cidfile', async () => {
    createThrows = true;
    const id = 'a'.repeat(64);

    await expect(
      startSidecars(
        { db: { image: 'db', ready: { timeoutSeconds: 1 } } },
        'n',
        'prof',
        'abc123',
      ),
    ).rejects.toThrow(/timed out/);

    const create = execCalls.find(({ args }) => args[0] === 'create');
    expect(create?.options?.timeoutMs).toBeGreaterThan(0);
    expect(create?.args).toContain('--cidfile');
    expect(removedIds()).toEqual([id]);
  });

  it('bounds start and rolls back its captured ID when start times out', async () => {
    startThrows = true;
    await expect(
      startSidecars(
        { db: { image: 'db', ready: { timeoutSeconds: 1 } } },
        'n',
        'prof',
        'abc123',
      ),
    ).rejects.toThrow(/start subprocess failed/);

    const start = execCalls.find(({ args }) => args[0] === 'start');
    expect(start?.options?.timeoutMs).toBeGreaterThan(0);
    expect(removedIds()).toEqual(['owned-1']);
  });

  it('rolls back previously started services by ID when a later service fails', async () => {
    const original = dockerExecMock.getMockImplementation();
    expect(original).toBeDefined();
    if (!original) {
      return;
    }
    dockerExecMock.mockImplementation(async (args, env, options) => {
      if (args[0] === 'create' && args.at(-1) === 'broken') {
        return { exitCode: 1, stderr: 'image missing', stdout: '' };
      }
      if (args[0] === 'rm' && args.at(-1) === 'owned-2') {
        await original(args, env, options);
        throw new Error('simulated cleanup timeout');
      }
      return original(args, env, options);
    });
    try {
      await expect(
        startSidecars(
          {
            a: { image: 'ok' },
            b: { image: 'ok-again' },
            c: { image: 'broken' },
          },
          'n',
          'prof',
          'abc123',
        ),
      ).rejects.toThrow(/image missing/);
      expect(removedIds()).toEqual(['owned-2', 'owned-1']);
      expect(
        execCalls
          .filter(({ args }) => args[0] === 'rm')
          .every(({ options }) => options?.timeoutMs === 5000),
      ).toBe(true);
    } finally {
      dockerExecMock.mockImplementation(original);
    }
  });
});

describe('sidecarNetworkName', () => {
  it('produces ccpod-net-<hash>', () =>
    expect(sidecarNetworkName('abc123')).toBe('ccpod-net-abc123'));
});

describe('removeSidecarNetwork', () => {
  it('removes the network and tolerates missing networks', async () => {
    await removeSidecarNetwork('ccpod-net-abc');
    expect(execCalls[0].args).toEqual(['network', 'rm', 'ccpod-net-abc']);
  });
});
