import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ContainerSpec } from '../../../src/container/builder.ts';
import type { ResolvedConfig } from '../../../src/types/index.ts';

const state: {
  nextSignal: 'SIGINT' | 'SIGTERM' | null;
  target: string | null;
  signals: (AbortSignal | undefined)[];
  proxyCreateAllowed: boolean[];
} = {
  nextSignal: null,
  proxyCreateAllowed: [],
  signals: [],
  target: null,
};
const proxyOptions: boolean[] = [];

mock.module('../../../src/cli/commands/_setup.ts', () => ({
  setupContainer: async () => ({
    config: { auth: { type: 'proxy' } } as ResolvedConfig,
    networkName: 'test-network',
  }),
}));
mock.module('../../../src/container/builder.ts', () => ({
  buildContainerSpec: () =>
    ({ name: 'ccpod-session-test', proxyAuth: true }) as ContainerSpec,
}));
mock.module('../../../src/container/runner.ts', () => ({
  findRunningShellTarget: async () => state.target,
  shellContainer: async (
    _spec: ContainerSpec,
    _deps: unknown,
    signal?: AbortSignal,
    options?: { allowProxyCreate?: boolean },
  ) => {
    state.signals.push(signal);
    state.proxyCreateAllowed.push(options?.allowProxyCreate ?? false);
    if (state.nextSignal) {
      process.emit(state.nextSignal);
      state.nextSignal = null;
    }
    return signal?.aborted ? 130 : 0;
  },
}));
mock.module('../../../src/cli/auth-proxy.ts', () => ({
  withAuthProxy: async (
    _config: ResolvedConfig,
    needed: boolean,
    fn: (proxy: { baseUrl: string; sentinelKey: string } | null) => unknown,
  ) => {
    proxyOptions.push(needed);
    return fn(
      needed ? { baseUrl: 'http://proxy', sentinelKey: 'sentinel' } : null,
    );
  },
}));

const { runSession } = await import('../../../src/cli/session.ts');

beforeEach(() => {
  state.nextSignal = null;
  state.target = null;
  state.signals = [];
  state.proxyCreateAllowed = [];
  proxyOptions.length = 0;
});

afterEach(() => {
  state.nextSignal = null;
});

describe('runSession proxy cancellation wiring', () => {
  it('passes Ctrl+C cancellation to a fresh proxy shell container', async () => {
    state.nextSignal = 'SIGINT';
    const before = process.listenerCount('SIGINT');

    const code = await runSession({});

    expect(code).toBe(130);
    expect(state.signals).toHaveLength(1);
    expect(state.proxyCreateAllowed).toEqual([true]);
    expect(state.signals[0]?.aborted).toBe(true);
    expect(state.proxyCreateAllowed).toEqual([true]);
    expect(proxyOptions).toEqual([true]);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('passes SIGTERM cancellation to a fresh proxy exec container', async () => {
    state.nextSignal = 'SIGTERM';
    const before = process.listenerCount('SIGTERM');

    const code = await runSession({}, ['claude', '--version'], false);

    expect(code).toBe(130);
    expect(state.signals[0]?.aborted).toBe(true);
    expect(state.proxyCreateAllowed).toEqual([true]);
    expect(proxyOptions).toEqual([true]);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('does not install owned-container cancellation for a reused target', async () => {
    state.target = 'existing-container';
    const before = process.listenerCount('SIGTERM');

    const code = await runSession({});

    expect(code).toBe(0);
    expect(state.signals).toEqual([undefined]);
    expect(state.proxyCreateAllowed).toEqual([false]);
    expect(proxyOptions).toEqual([false]);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
