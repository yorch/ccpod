import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ContainerSpec } from '../../../../src/container/builder.ts';
import type { ResolvedConfig } from '../../../../src/types/index.ts';

const state: {
  authType: 'proxy' | 'api-key';
  nextSignal: 'SIGINT' | 'SIGTERM' | null;
  signals: (AbortSignal | undefined)[];
  exits: number[];
} = { authType: 'proxy', exits: [], nextSignal: null, signals: [] };

mock.module('../../../../src/cli/commands/_setup.ts', () => ({
  setupContainer: async () => ({
    config: { auth: { type: state.authType } } as ResolvedConfig,
    networkName: 'test-network',
  }),
}));
mock.module('../../../../src/container/builder.ts', () => ({
  buildContainerSpec: () =>
    ({ name: 'ccpod-run-test', proxyAuth: true }) as ContainerSpec,
}));
mock.module('../../../../src/container/runner.ts', () => ({
  runContainer: async (
    _spec: ContainerSpec,
    _deps: unknown,
    signal?: AbortSignal,
  ) => {
    state.signals.push(signal);
    if (state.nextSignal) {
      process.emit(state.nextSignal);
      state.nextSignal = null;
    }
    return signal?.aborted ? 130 : 0;
  },
}));
mock.module('../../../../src/cli/auth-proxy.ts', () => ({
  withAuthProxy: async (
    _config: ResolvedConfig,
    _needed: boolean,
    fn: (proxy: { baseUrl: string; sentinelKey: string }) => unknown,
  ) =>
    fn(
      _config.auth.type === 'proxy'
        ? { baseUrl: 'http://proxy', sentinelKey: 'sentinel' }
        : null,
    ),
}));
mock.module('../../../../src/runtime/docker.ts', () => ({
  dockerExec: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
}));

const command = (await import('../../../../src/cli/commands/run.ts')).default;
const originalExit = process.exit;

beforeEach(() => {
  state.authType = 'proxy';
  state.nextSignal = null;
  state.signals = [];
  state.exits = [];
  process.exit = ((code?: number) => {
    state.exits.push(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
  state.nextSignal = null;
});

describe('run proxy cancellation wiring', () => {
  it('keeps ordinary non-proxy interactive runs on native terminal forwarding', async () => {
    state.authType = 'api-key';
    const before = process.listenerCount('SIGINT');
    await command.run({
      args: { rebuild: false, state: true },
      rawArgs: [],
    } as Parameters<typeof command.run>[0]);

    expect(state.signals).toEqual([undefined]);
    expect(state.exits).toEqual([0]);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  for (const signalName of ['SIGINT', 'SIGTERM'] as const) {
    it(`passes ${signalName} cancellation to an interactive proxy run`, async () => {
      state.nextSignal = signalName;
      const before = process.listenerCount(signalName);
      const context = {
        args: { rebuild: false, state: true },
        rawArgs: [],
      } as Parameters<typeof command.run>[0];

      await command.run(context);

      expect(state.signals).toHaveLength(1);
      expect(state.signals[0]?.aborted).toBe(true);
      expect(state.exits).toEqual([130]);
      expect(process.listenerCount(signalName)).toBe(before);
    });
  }
});
