import { describe, expect, it, mock } from 'bun:test';
import { clearStateSafely } from '../../../src/cli/commands/state/clear.ts';
import type { CcpodContainer } from '../../../src/container/list.ts';

const container = (state: string) =>
  ({
    id: 'x',
    image: 'img',
    name: 'x',
    profile: 'p',
    project: 'hash',
    running: state === 'running',
    state,
    status: state,
    type: 'main',
    workdir: '/tmp',
  }) satisfies CcpodContainer;
const filter = { all: true, profile: 'p' };

describe('state clear safety recheck', () => {
  it('rechecks after confirmation before removing', async () => {
    const list = mock(async () => [container('exited')]);
    const remove = mock(() => {});
    const confirmRemoval = mock(async () => true);
    await clearStateSafely('p', 'this profile', filter, false, {
      confirmRemoval,
      list,
      remove,
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('rechecks even with force and preserves state if a container became active', async () => {
    let calls = 0;
    const list = mock(async () =>
      ++calls === 1 ? [container('exited')] : [container('restarting')],
    );
    const remove = mock(() => {});
    await expect(
      clearStateSafely('p', 'this profile', filter, true, {
        confirmRemoval: async () => false,
        list,
        remove,
      }),
    ).rejects.toThrow(/restarting/);
    expect(list).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    'paused',
    'restarting',
    'created',
    'running',
  ])('refuses a pre-existing %s container', async (state) => {
    const remove = mock(() => {});
    await expect(
      clearStateSafely('p', 'this profile', filter, true, {
        confirmRemoval: async () => true,
        list: async () => [container(state)],
        remove,
      }),
    ).rejects.toThrow(new RegExp(state));
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not delete if Docker listing fails, including on force', async () => {
    const remove = mock(() => {});
    await expect(
      clearStateSafely('p', 'this profile', filter, true, {
        confirmRemoval: async () => true,
        list: async () => {
          throw new Error('docker ps failed');
        },
        remove,
      }),
    ).rejects.toThrow(/docker ps failed/);
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not query again or delete when confirmation is declined', async () => {
    const list = mock(async () => [container('exited')]);
    const remove = mock(() => {});
    const result = await clearStateSafely('p', 'this profile', filter, false, {
      confirmRemoval: async () => false,
      list,
      remove,
    });
    expect(result).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
