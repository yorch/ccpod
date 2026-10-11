import { describe, expect, it, mock } from 'bun:test';
import type { ContainerSpec } from '../../../src/container/builder.ts';
import type { RunnerDeps } from '../../../src/container/runner.ts';

const lifecycle: string[] = [];
let proxyStartGate: Promise<void> | null = null;
let onProxyStart: (() => void) | null = null;
const runtimeExec = mock(async (args: string[]) => {
  lifecycle.push(`docker:${args[0]}`);
  return { exitCode: 1, stderr: 'not found', stdout: '' };
});
mock.module('../../../src/runtime/docker.ts', () => ({
  dockerExec: runtimeExec,
  dockerSpawn: mock(async () => 0),
}));

const realAuthProxy = await import('../../../src/auth/proxy.ts');
mock.module('../../../src/auth/proxy.ts', () => ({
  ...realAuthProxy,
  AuthProxy: class {
    address = 'http://127.0.0.1:1234';
    resolvedPort = 1234;

    async start() {
      lifecycle.push('proxy:start');
      onProxyStart?.();
      await proxyStartGate;
    }

    async stop() {
      lifecycle.push('proxy:stop');
    }
  },
}));

const { withAuthProxy } = await import('../../../src/cli/auth-proxy.ts');
const { runContainer } = await import('../../../src/container/runner.ts');

function spec(): ContainerSpec {
  return {
    binds: [],
    env: [],
    image: 'synthetic-image',
    labels: {},
    name: 'ccpod-proxy-test',
    networkMode: 'bridge',
    openStdin: true,
    portBindings: {},
    proxyAuth: true,
    secretEnv: {},
    tty: true,
    workingDir: '/workspace',
  };
}

describe('withAuthProxy owned-container lifecycle', () => {
  it('keeps the caller pending until startup credential reconciliation completes', async () => {
    lifecycle.length = 0;
    let releaseStartup: (() => void) | undefined;
    let signalProxyStarted: (() => void) | undefined;
    const proxyStarted = new Promise<void>((resolve) => {
      signalProxyStarted = resolve;
    });
    onProxyStart = () => signalProxyStarted?.();
    proxyStartGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const config = { auth: { type: 'proxy' } } as Parameters<
      typeof withAuthProxy
    >[0];
    let callbackEntered = false;
    const operation = withAuthProxy(config, true, async () => {
      callbackEntered = true;
      lifecycle.push('callback:complete');
      return 0;
    });

    await proxyStarted;
    const callbackEnteredBeforeRelease = callbackEntered;
    releaseStartup?.();
    await operation;

    expect(callbackEnteredBeforeRelease).toBe(false);
    expect(callbackEntered).toBe(true);
    expect(lifecycle.indexOf('proxy:start')).toBeGreaterThan(-1);
    expect(lifecycle.indexOf('proxy:start')).toBeLessThan(
      lifecycle.indexOf('callback:complete'),
    );
    expect(lifecycle.at(-1)).toBe('proxy:stop');
    proxyStartGate = null;
    onProxyStart = null;
  });

  it('waits for owned container stop and verification before proxy teardown', async () => {
    lifecycle.length = 0;
    let inspectCount = 0;
    const dockerExec = mock(async (args: string[]) => {
      lifecycle.push(`docker:${args[0]}`);
      if (args[0] === 'create') {
        return { exitCode: 0, stderr: '', stdout: 'a'.repeat(64) };
      }
      if (args[0] === 'stop') {
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      if (args[0] === 'inspect') {
        inspectCount++;
        if (inspectCount === 1) {
          return { exitCode: 1, stderr: 'No such container', stdout: '' };
        }
        return {
          exitCode: 0,
          stderr: '',
          stdout: inspectCount === 2 ? 'running' : 'exited',
        };
      }
      return { exitCode: 1, stderr: 'unexpected command', stdout: '' };
    });
    const dockerSpawn = mock(async () => {
      lifecycle.push('docker:start');
      return 0;
    });
    const deps: RunnerDeps = {
      dockerExec: dockerExec as RunnerDeps['dockerExec'],
      dockerSpawn: dockerSpawn as RunnerDeps['dockerSpawn'],
    };
    const config = { auth: { type: 'proxy' } } as Parameters<
      typeof withAuthProxy
    >[0];

    await withAuthProxy(config, true, async () => {
      lifecycle.push('callback:start');
      await runContainer(spec(), deps);
      lifecycle.push('callback:complete');
      return 0;
    });

    expect(lifecycle.indexOf('docker:stop')).toBeGreaterThan(-1);
    expect(lifecycle.indexOf('docker:stop')).toBeLessThan(
      lifecycle.indexOf('proxy:stop'),
    );
    expect(lifecycle.indexOf('callback:complete')).toBeLessThan(
      lifecycle.indexOf('proxy:stop'),
    );
    expect(lifecycle.at(-1)).toBe('proxy:stop');
  });
});
