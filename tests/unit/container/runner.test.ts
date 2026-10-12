import { describe, expect, it, mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { ContainerSpec } from '../../../src/container/builder.ts';
import type { RunnerDeps } from '../../../src/container/runner.ts';
import {
  findRunningShellTarget,
  forceRemoveOwnedContainers,
  runContainer,
  shellContainer,
} from '../../../src/container/runner.ts';

type ExecResult = { exitCode: number; stdout: string; stderr: string };

function makeSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    binds: ['/proj:/workspace:rw'],
    env: ['ANTHROPIC_API_KEY=test'],
    image: 'test-image:latest',
    labels: { 'ccpod.profile': 'default' },
    name: 'ccpod-default-abc123',
    networkMode: 'bridge',
    openStdin: true,
    portBindings: {},
    secretEnv: {},
    tty: true,
    workingDir: '/workspace',
    ...overrides,
  };
}

function makeDeps(
  execResults: ExecResult[] = [],
  spawnResult = 0,
): {
  deps: RunnerDeps;
  execMock: ReturnType<typeof mock>;
  spawnMock: ReturnType<typeof mock>;
} {
  let execCallIndex = 0;
  const execMock = mock(async (_args: string[]): Promise<ExecResult> => {
    const result = execResults[execCallIndex] ?? {
      exitCode: 0,
      stderr: '',
      stdout: '',
    };
    execCallIndex++;
    return result;
  });
  const spawnMock = mock(
    async (_args: string[]): Promise<number> => spawnResult,
  );
  return {
    deps: {
      dockerExec: execMock as RunnerDeps['dockerExec'],
      dockerSpawn: spawnMock as RunnerDeps['dockerSpawn'],
    },
    execMock,
    spawnMock,
  };
}

describe('runContainer', () => {
  it('does not launch when cancellation arrives during inspect', async () => {
    const controller = new AbortController();
    const { deps, spawnMock } = makeDeps();
    const inspect = deps.dockerExec as unknown as (
      args: string[],
    ) => Promise<ExecResult>;
    const original = inspect;
    deps.dockerExec = (async (args: string[]) => {
      const result = await original(args);
      controller.abort();
      return result;
    }) as RunnerDeps['dockerExec'];

    await expect(
      runContainer(makeSpec({ proxyAuth: true }), deps, controller.signal),
    ).rejects.toThrow('Container startup cancelled');
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it('removes the owned container without starting after cancellation during create', async () => {
    const controller = new AbortController();
    const ownedId = 'd'.repeat(64);
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: '' },
    ]);
    let resolveCreate: () => void = () => {};
    let markCreateStarted: () => void = () => {};
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const original = deps.dockerExec;
    deps.dockerExec = (async (
      args: string[],
      extraEnv?: Record<string, string>,
    ) => {
      if (args[0] === 'create') {
        markCreateStarted();
        await new Promise<void>((resolve) => {
          resolveCreate = resolve;
        });
      }
      return original(args, extraEnv);
    }) as RunnerDeps['dockerExec'];

    const result = runContainer(
      makeSpec({ proxyAuth: true }),
      deps,
      controller.signal,
    );
    await createStarted;
    controller.abort();
    resolveCreate();
    await expect(result).rejects.toThrow('Container startup cancelled');

    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'rm' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
    expect(execMock.mock.calls.some(([args]) => args[0] === 'start')).toBe(
      false,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not start a non-proxy headless job when cancellation arrives during create', async () => {
    const controller = new AbortController();
    const ownedId = '1'.repeat(64);
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: '' },
    ]);
    let resolveCreate: () => void = () => {};
    let markCreateStarted: () => void = () => {};
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const original = deps.dockerExec;
    deps.dockerExec = (async (
      args: string[],
      extraEnv?: Record<string, string>,
    ) => {
      if (args[0] === 'create') {
        markCreateStarted();
        await new Promise<void>((resolve) => {
          resolveCreate = resolve;
        });
      }
      return original(args, extraEnv);
    }) as RunnerDeps['dockerExec'];

    const result = runContainer(
      makeSpec({ proxyAuth: false, tty: false }),
      deps,
      controller.signal,
    );
    await createStarted;
    controller.abort();
    resolveCreate();
    await expect(result).rejects.toThrow('Container startup cancelled');

    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'rm' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
    expect(execMock.mock.calls.some(([args]) => args[0] === 'start')).toBe(
      false,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stops the owned job when cancelled while attached', async () => {
    const controller = new AbortController();
    const ownedId = 'e'.repeat(64);
    const attachStartedCallbacks: Array<() => void> = [];
    let finishAttach: (code: number) => void = () => {};
    const spawnMock = mock(async (): Promise<number> => {
      const result = await new Promise<number>((resolve) => {
        finishAttach = resolve;
        for (const callback of attachStartedCallbacks.splice(0)) {
          callback();
        }
      });
      return result;
    });
    let inspectCount = 0;
    const execMock = mock(async (args: string[]) => {
      if (args[0] === 'inspect') {
        inspectCount++;
        return {
          exitCode: inspectCount === 1 ? 1 : 0,
          stderr: inspectCount === 1 ? 'No such container' : '',
          stdout:
            inspectCount === 1 ? '' : inspectCount === 2 ? 'running' : 'exited',
        };
      }
      if (args[0] === 'create') {
        return { exitCode: 0, stderr: '', stdout: ownedId };
      }
      if (args[0] === 'stop') {
        finishAttach(130);
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      return { exitCode: 1, stderr: 'unexpected command', stdout: '' };
    });
    const deps: RunnerDeps = {
      dockerExec: execMock as RunnerDeps['dockerExec'],
      dockerSpawn: spawnMock as RunnerDeps['dockerSpawn'],
    };
    const attachStarted = new Promise<void>((resolve) => {
      attachStartedCallbacks.push(resolve);
    });
    const run = runContainer(
      makeSpec({ proxyAuth: true }),
      deps,
      controller.signal,
    );
    await attachStarted;
    controller.abort();
    expect(await run).toBe(130);
    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'stop' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
    expect(inspectCount).toBeGreaterThanOrEqual(3);
  });

  it('stops the owned non-proxy headless job when cancelled while active', async () => {
    const controller = new AbortController();
    const ownedId = '2'.repeat(64);
    let finishStart: (code: number) => void = () => {};
    let markStartStarted: () => void = () => {};
    const startStarted = new Promise<void>((resolve) => {
      markStartStarted = resolve;
    });
    const spawnMock = mock(async (): Promise<number> => {
      markStartStarted();
      return await new Promise<number>((resolve) => {
        finishStart = resolve;
      });
    });
    let inspectCount = 0;
    const execMock = mock(async (args: string[]) => {
      if (args[0] === 'inspect') {
        inspectCount++;
        return {
          exitCode: inspectCount === 1 ? 1 : 0,
          stderr: inspectCount === 1 ? 'No such container' : '',
          stdout:
            inspectCount === 1 ? '' : inspectCount === 2 ? 'running' : 'exited',
        };
      }
      if (args[0] === 'create') {
        return { exitCode: 0, stderr: '', stdout: ownedId };
      }
      if (args[0] === 'stop') {
        finishStart(130);
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      return { exitCode: 1, stderr: 'unexpected command', stdout: '' };
    });
    const deps: RunnerDeps = {
      dockerExec: execMock as RunnerDeps['dockerExec'],
      dockerSpawn: spawnMock as RunnerDeps['dockerSpawn'],
    };

    const run = runContainer(
      makeSpec({ proxyAuth: false, tty: false }),
      deps,
      controller.signal,
    );
    await startStarted;
    controller.abort();
    expect(await run).toBe(130);
    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'stop' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
    expect(inspectCount).toBeGreaterThanOrEqual(3);
  });

  it('lets a normally completed non-proxy headless container exit without stopping it', async () => {
    const ownedId = '4'.repeat(64);
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: 'exited' },
    ]);
    const signal = new AbortController().signal;

    expect(
      await runContainer(
        makeSpec({ proxyAuth: false, tty: false }),
        deps,
        signal,
      ),
    ).toBe(0);
    expect(spawnMock.mock.calls[0]?.[0]).toEqual([
      'start',
      '--attach',
      ownedId,
    ]);
    expect(execMock.mock.calls.some(([args]) => args[0] === 'stop')).toBe(
      false,
    );
  });

  it('removes an owned headless container that remains created after start failure', async () => {
    const ownedId = '5'.repeat(64);
    const { deps, execMock } = makeDeps(
      [
        { exitCode: 1, stderr: 'No such container', stdout: '' },
        { exitCode: 0, stderr: '', stdout: ownedId },
        { exitCode: 0, stderr: '', stdout: 'created' },
        { exitCode: 0, stderr: '', stdout: '' },
      ],
      125,
    );

    expect(
      await runContainer(
        makeSpec({ proxyAuth: false, tty: false }),
        deps,
        new AbortController().signal,
      ),
    ).toBe(125);
    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'rm' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
  });

  it('handles cancellation stop failures while attach is still pending', async () => {
    const controller = new AbortController();
    const ownedId = '3'.repeat(64);
    let markStartStarted: () => void = () => {};
    const startStarted = new Promise<void>((resolve) => {
      markStartStarted = resolve;
    });
    const spawnMock = mock(async (): Promise<number> => {
      markStartStarted();
      return await new Promise<number>(() => {});
    });
    let inspectCount = 0;
    const execMock = mock(async (args: string[]) => {
      if (args[0] === 'inspect') {
        inspectCount++;
        return {
          exitCode: inspectCount === 1 ? 1 : 0,
          stderr: inspectCount === 1 ? 'No such container' : '',
          stdout: inspectCount === 1 ? '' : 'running',
        };
      }
      if (args[0] === 'create') {
        return { exitCode: 0, stderr: '', stdout: ownedId };
      }
      if (args[0] === 'stop') {
        return { exitCode: 1, stderr: 'stop denied', stdout: '' };
      }
      return { exitCode: 1, stderr: 'unexpected command', stdout: '' };
    });
    const deps: RunnerDeps = {
      dockerExec: execMock as RunnerDeps['dockerExec'],
      dockerSpawn: spawnMock as RunnerDeps['dockerSpawn'],
    };
    const run = runContainer(
      makeSpec({ proxyAuth: false, tty: false }),
      deps,
      controller.signal,
    );
    await startStarted;
    controller.abort();
    await expect(run).rejects.toThrow('Failed to stop owned container');
  });

  it('keeps ordinary non-proxy interactive detach on docker run without stopping it', async () => {
    const { deps, spawnMock, execMock } = makeDeps([
      { exitCode: 1, stderr: 'Error: No such container', stdout: '' },
    ]);

    const code = await runContainer(makeSpec(), deps);

    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
    expect(spawnArgs).toContain('test-image:latest');
    expect(execMock.mock.calls.some(([args]) => args[0] === 'stop')).toBe(
      false,
    );
  });

  it('reattaches when container is already running', async () => {
    const { deps, spawnMock, execMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'running' },
    ]);

    await runContainer(makeSpec(), deps);

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('attach');
    const execArgs = (execMock.mock.calls as [string[]][]).map((c) => c[0]);
    expect(execArgs.some((a) => a.includes('rm'))).toBe(false);
  });

  it('removes stopped container then starts fresh', async () => {
    const { deps, spawnMock, execMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'exited' },
      { exitCode: 0, stderr: '', stdout: '' },
    ]);

    await runContainer(makeSpec(), deps);

    const execArgs = (execMock.mock.calls as [string[]][]).map((c) => c[0]);
    expect(execArgs.some((a) => a.includes('rm'))).toBe(true);
    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
  });

  it('throws when docker rm fails on a stopped container', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'exited' },
      { exitCode: 1, stderr: 'permission denied', stdout: '' },
    ]);

    await expect(runContainer(makeSpec(), deps)).rejects.toThrow(
      'Failed to remove container',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('tolerates a container that vanished before rm (concurrent down)', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'exited' },
      { exitCode: 1, stderr: 'Error: No such container: x', stdout: '' },
    ]);

    await runContainer(makeSpec(), deps);

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
  });

  it('force-removes a paused container before starting fresh', async () => {
    const { deps, spawnMock, execMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'paused' },
      { exitCode: 0, stderr: '', stdout: '' }, // rm -f
    ]);

    await runContainer(makeSpec(), deps);

    const execArgs = (execMock.mock.calls as [string[]][]).map((c) => c[0]);
    expect(execArgs.some((a) => a[0] === 'rm' && a.includes('-f'))).toBe(true);
    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
  });

  it('tolerates a container whose removal is already in progress', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'removing' },
      {
        exitCode: 1,
        stderr: 'Error: removal of container x is already in progress',
        stdout: '',
      },
    ]);

    await runContainer(makeSpec(), deps);

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
  });

  it('creates, starts, attaches, and stops only the owned proxy container ID', async () => {
    const ownedId = 'a'.repeat(64);
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 0, stderr: '', stdout: '' }, // stop
      { exitCode: 0, stderr: '', stdout: 'exited' },
    ]);

    expect(await runContainer(makeSpec({ proxyAuth: true }), deps)).toBe(0);
    const execArgs = (execMock.mock.calls as [string[]][]).map(([a]) => a);
    expect(execArgs[1]?.[0]).toBe('create');
    expect(execArgs[2]?.[0]).toBe('inspect');
    expect(execArgs.some((a) => a[0] === 'stop' && a.at(-1) === ownedId)).toBe(
      true,
    );
    expect(
      execArgs.some(
        (a) => a[0] === 'stop' && a.at(-1) === 'ccpod-default-abc123',
      ),
    ).toBe(false);
    expect(spawnMock.mock.calls[0]?.[0]).toEqual([
      'start',
      '--attach',
      '--interactive',
      ownedId,
    ]);
  });

  it('says it stopped the container when the user detached a proxy run', async () => {
    const ownedId = 'b'.repeat(64);
    const { deps } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId }, // create
      { exitCode: 0, stderr: '', stdout: 'running' }, // pre-stop inspect
      { exitCode: 0, stderr: '', stdout: '' }, // stop
      { exitCode: 0, stderr: '', stdout: 'exited' }, // verify
    ]);
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      logged.push(values.join(' '));
    };
    try {
      // The spawned start/attach returns while the container is still running:
      // exactly what a Ctrl-P Ctrl-Q detach looks like.
      expect(await runContainer(makeSpec({ proxyAuth: true }), deps)).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(logged.join('\n')).toContain('Detached from ccpod-default-abc123');
  });

  it('treats a container already being removed as inactive when stopping', async () => {
    const ownedId = 'c'.repeat(64);
    const { deps, execMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId }, // create
      { exitCode: 0, stderr: '', stdout: 'removing' }, // pre-stop inspect
    ]);

    // `docker stop` on a container in `removing` fails; that must not become an
    // error or replace the container's real exit code.
    expect(await runContainer(makeSpec({ proxyAuth: true }), deps)).toBe(0);
    expect(
      (execMock.mock.calls as [string[]][]).some(([a]) => a[0] === 'stop'),
    ).toBe(false);
  });

  it('does not clean up a concurrent winner when create fails on name conflict', async () => {
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      {
        exitCode: 1,
        stderr: 'Conflict. The container name is already in use',
        stdout: '',
      },
    ]);

    await expect(
      runContainer(makeSpec({ proxyAuth: true }), deps),
    ).rejects.toThrow('Failed to create');
    expect(execMock.mock.calls.map(([args]) => args[0])).toEqual([
      'inspect',
      'create',
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stops its owned proxy container after start/attach throws', async () => {
    const ownedId = 'b'.repeat(64);
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 0, stderr: '', stdout: '' },
      { exitCode: 0, stderr: '', stdout: 'exited' },
    ]);
    spawnMock.mockImplementation(async () => {
      throw new Error('start attach failed');
    });
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      logged.push(values.join(' '));
    };
    try {
      await expect(
        runContainer(makeSpec({ proxyAuth: true }), deps),
      ).rejects.toThrow('start attach failed');
    } finally {
      console.log = originalLog;
    }
    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'stop' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
    // A failed start is not a detach: no misleading notice.
    expect(logged.join('\n')).not.toContain('Detached');
  });

  it('surfaces a failed stop for an owned proxy container', async () => {
    const ownedId = 'c'.repeat(64);
    const { deps } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 1, stderr: 'permission denied', stdout: '' },
    ]);

    await expect(
      runContainer(makeSpec({ proxyAuth: true }), deps),
    ).rejects.toThrow('Failed to stop owned container');
  });

  it('surfaces a final state verification failure after stop', async () => {
    const ownedId = '9'.repeat(64);
    const { deps } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 0, stderr: '', stdout: '' },
      { exitCode: 1, stderr: 'daemon unavailable', stdout: '' },
    ]);
    await expect(
      runContainer(makeSpec({ proxyAuth: true }), deps),
    ).rejects.toThrow('Failed to inspect owned container');
  });

  it('refuses to reattach in proxy auth mode', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'running' },
    ]);
    await expect(
      runContainer(makeSpec({ proxyAuth: true }), deps),
    ).rejects.toThrow(/ccpod down/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('headless run refuses to attach to a running container', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'running' },
    ]);

    await expect(runContainer(makeSpec({ tty: false }), deps)).rejects.toThrow(
      'already running',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('treats "no such container" rm error as concurrent removal', async () => {
    // Another `ccpod down` may have removed the container between our inspect
    // and rm. The rm error should not be fatal — proceed to start fresh.
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'exited' },
      {
        exitCode: 1,
        stderr: 'Error: No such container: ccpod-default-abc123',
        stdout: '',
      },
    ]);

    await runContainer(makeSpec(), deps);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
  });

  it('passes --name, -w, and image to docker run args', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: '', stdout: '' },
    ]);

    await runContainer(
      makeSpec({ image: 'my-img:v1', name: 'my-container' }),
      deps,
    );

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs).toContain('--name');
    expect(spawnArgs).toContain('my-container');
    expect(spawnArgs).toContain('-w');
    expect(spawnArgs).toContain('/workspace');
    expect(spawnArgs).toContain('my-img:v1');
  });

  it('appends /bin/bash cmd when spec.cmd overridden for shell', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: '', stdout: '' },
    ]);

    await runContainer(makeSpec({ cmd: ['/bin/bash'] }), deps);

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
    expect(spawnArgs[spawnArgs.length - 1]).toBe('/bin/bash');
  });

  it('passes secrets via bare -e flags and docker env, not the cmdline', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: '', stdout: '' },
    ]);

    await runContainer(
      makeSpec({ secretEnv: { ANTHROPIC_API_KEY: 'sk-secret' } }),
      deps,
    );

    const [spawnArgs, extraEnv] = spawnMock.mock.calls[0] as [
      string[],
      Record<string, string> | undefined,
    ];
    // The value must never appear in argv...
    expect(spawnArgs.join(' ')).not.toContain('sk-secret');
    // ...only the bare key, with the value injected into docker's env.
    const eIdx = spawnArgs.findIndex(
      (a, i) => a === '-e' && spawnArgs[i + 1] === 'ANTHROPIC_API_KEY',
    );
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(extraEnv?.ANTHROPIC_API_KEY).toBe('sk-secret');
  });
});

describe('shellContainer', () => {
  it('removes the owned proxy shell ID when cancelled during create', async () => {
    const controller = new AbortController();
    const ownedId = '9'.repeat(64);
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: '' },
    ]);
    let releaseCreate: (() => void) | undefined;
    let markCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const original = deps.dockerExec;
    deps.dockerExec = (async (args: string[], env?: Record<string, string>) => {
      if (args[0] === 'create') {
        markCreateStarted?.();
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
      }
      return original(args, env);
    }) as RunnerDeps['dockerExec'];

    const result = shellContainer(
      makeSpec({ name: 'shell', proxyAuth: true }),
      deps,
      controller.signal,
    );
    await createStarted;
    controller.abort();
    releaseCreate?.();
    await expect(result).rejects.toThrow('Container startup cancelled');

    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'rm' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('stops the owned proxy shell ID when cancelled during start', async () => {
    const controller = new AbortController();
    const ownedId = '8'.repeat(64);
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 0, stderr: '', stdout: '' },
      { exitCode: 0, stderr: '', stdout: 'exited' },
    ]);
    let releaseStart: (() => void) | undefined;
    let markStart: (() => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      markStart = resolve;
    });
    deps.dockerSpawn = (async () => {
      markStart?.();
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      return 0;
    }) as RunnerDeps['dockerSpawn'];

    const result = shellContainer(
      makeSpec({ name: 'shell', proxyAuth: true }),
      deps,
      controller.signal,
    );
    await startStarted;
    controller.abort();
    expect(await result).toBe(130);
    releaseStart?.();

    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'stop' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('cleans up a newly created proxy shell container', async () => {
    const ownedId = 'f'.repeat(64);
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' }, // exec target
      { exitCode: 1, stderr: 'No such container', stdout: '' }, // shell target
      { exitCode: 0, stderr: '', stdout: ownedId },
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 0, stderr: '', stdout: '' }, // stop
      { exitCode: 0, stderr: '', stdout: 'exited' },
    ]);

    expect(
      await shellContainer(
        makeSpec({ execTarget: 'main', name: 'shell', proxyAuth: true }),
        deps,
      ),
    ).toBe(0);
    expect(spawnMock.mock.calls[0]?.[0]).toEqual([
      'start',
      '--attach',
      '--interactive',
      ownedId,
    ]);
    expect(
      execMock.mock.calls.some(
        ([args]) => args[0] === 'stop' && args.at(-1) === ownedId,
      ),
    ).toBe(true);
  });

  it('does not stop a reused proxy-backed main shell target', async () => {
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'running' }, // execTarget is running
    ]);
    await shellContainer(
      makeSpec({ execTarget: 'main', name: 'shell', proxyAuth: true }),
      deps,
    );
    expect(spawnMock.mock.calls[0]?.[0]).toContain('main');
    expect(execMock.mock.calls.some(([args]) => args[0] === 'stop')).toBe(
      false,
    );
    expect(execMock.mock.calls.some(([args]) => args[0] === 'create')).toBe(
      false,
    );
  });
  it('execs into the running main container (execTarget) before starting its own', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'running' },
    ]);
    await shellContainer(
      makeSpec({
        cmd: ['/bin/bash'],
        execTarget: 'ccpod-default-abc123',
        name: 'ccpod-default-abc123-shell',
      }),
      deps,
    );
    expect(spawnMock.mock.calls[0]?.[0]).toEqual([
      'exec',
      '-it',
      '-u',
      'node',
      '-e',
      'HOME=/home/node',
      'ccpod-default-abc123',
      '/bin/bash',
    ]);
  });

  it('execs into running container with spec.cmd', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'running' },
    ]);

    await shellContainer(makeSpec({ cmd: ['/bin/bash'] }), deps);

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('exec');
    expect(spawnArgs).toContain('-it');
    expect(spawnArgs).toContain('/bin/bash');
  });

  it('removes stopped container and starts fresh with spec.cmd', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'exited' },
      { exitCode: 0, stderr: '', stdout: '' },
    ]);

    await shellContainer(makeSpec({ cmd: ['/bin/bash'] }), deps);

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
    expect(spawnArgs[spawnArgs.length - 1]).toBe('/bin/bash');
  });

  it('starts new container when not found', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
    ]);

    await shellContainer(makeSpec({ cmd: ['/bin/bash'] }), deps);

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs[0]).toBe('run');
    expect(spawnArgs[spawnArgs.length - 1]).toBe('/bin/bash');
  });

  it('does not create a proxy-backed shell if a selected reuse target disappeared', async () => {
    const { deps, execMock, spawnMock } = makeDeps([
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 1, stderr: 'No such container', stdout: '' },
    ]);
    const spec = makeSpec({ name: 'shell', proxyAuth: true });

    expect(await findRunningShellTarget(spec, deps)).toBe('shell');
    await expect(
      shellContainer(spec, deps, undefined, { allowProxyCreate: false }),
    ).rejects.toThrow(/retry the command/);

    expect(execMock.mock.calls.some(([args]) => args[0] === 'create')).toBe(
      false,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('forceRemoveOwnedContainers', () => {
  it('removes the owned ID during a forced exit and deregisters it afterwards', async () => {
    const ownedId = 'd'.repeat(64);
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId }, // create
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 0, stderr: '', stdout: '' }, // stop
      { exitCode: 0, stderr: '', stdout: 'exited' },
    ]);
    const removed: string[] = [];
    spawnMock.mockImplementation(async () => {
      // Simulate a forced exit (second Ctrl+C) while the run is in flight.
      forceRemoveOwnedContainers((id) => removed.push(id));
      return 0;
    });

    await runContainer(makeSpec({ proxyAuth: true }), deps);
    expect(removed).toEqual([ownedId]);

    // The normal path deregisters the ID, so a later forced exit is a no-op.
    removed.length = 0;
    forceRemoveOwnedContainers((id) => removed.push(id));
    expect(removed).toEqual([]);
  });

  it('recovers an ID from the cidfile when a create is still in flight', async () => {
    const ownedId = 'e'.repeat(64);
    const { deps, execMock } = makeDeps([
      { exitCode: 1, stderr: 'No such container', stdout: '' },
      { exitCode: 0, stderr: '', stdout: ownedId }, // create
      { exitCode: 0, stderr: '', stdout: 'running' },
      { exitCode: 0, stderr: '', stdout: '' }, // stop
      { exitCode: 0, stderr: '', stdout: 'exited' },
    ]);
    const removed: string[] = [];
    const originalExec = deps.dockerExec as unknown as (
      args: string[],
    ) => Promise<{ exitCode: number; stderr: string; stdout: string }>;
    deps.dockerExec = (async (args: string[]) => {
      if (args[0] === 'create') {
        // Docker has written the cidfile, but the CLI has not returned yet:
        // this is the window where only the cidfile knows the container ID.
        const cidfile = args[args.indexOf('--cidfile') + 1] ?? '';
        writeFileSync(cidfile, `${ownedId}\n`);
        forceRemoveOwnedContainers((id) => removed.push(id));
      }
      return originalExec(args);
    }) as RunnerDeps['dockerExec'];

    await runContainer(makeSpec({ proxyAuth: true }), deps);
    expect(removed).toEqual([ownedId]);
    expect(
      (execMock.mock.calls as [string[]][]).some(([args]) =>
        args.includes('--cidfile'),
      ),
    ).toBe(true);
  });
});

describe('runContainer (continued)', () => {
  it('appends cmd to run args when spec.cmd is set', async () => {
    const { deps, spawnMock } = makeDeps([
      { exitCode: 1, stderr: '', stdout: '' },
    ]);

    await runContainer(
      makeSpec({ cmd: ['--file', '/workspace/prompt.md'] }),
      deps,
    );

    const spawnArgs = (spawnMock.mock.calls[0] as [string[]])[0];
    expect(spawnArgs).toContain('--file');
    expect(spawnArgs).toContain('/workspace/prompt.md');
  });
});
