import { describe, expect, it } from 'bun:test';
import {
  dockerLogsArgs,
  logsFilter,
  streamContainerLogs,
} from '../../../src/cli/commands/logs.ts';
import { computeProjectHash } from '../../../src/container/builder.ts';
import type { CcpodContainer } from '../../../src/container/list.ts';

describe('logs selection and argv', () => {
  it('scopes to current project and selected profile/service by labels', () => {
    expect(logsFilter('work', '/tmp/project', false, 'redis')).toEqual({
      all: true,
      profile: 'work',
      project: computeProjectHash('/tmp/project'),
      service: 'redis',
    });
  });

  it('uses profile scope for --all without removing label scope', () => {
    expect(logsFilter('work', '/tmp/project', true)).toEqual({
      all: true,
      profile: 'work',
    });
  });

  it('follows every selected container without shell execution', async () => {
    const rows = ['a', 'b'].map(
      (id) =>
        ({
          id,
          image: 'img',
          name: id,
          profile: 'work',
          project: 'hash',
          running: true,
          state: 'running',
          status: 'Up',
          type: 'main',
          workdir: '/tmp',
        }) satisfies CcpodContainer,
    );
    const calls: string[][] = [];
    await streamContainerLogs(rows, '40', true, false, async (args) => {
      calls.push(args);
      return 0;
    });
    expect(calls).toEqual([
      ['logs', '--tail', '40', '--follow', 'a'],
      ['logs', '--tail', '40', '--follow', 'b'],
    ]);
  });

  it('keeps each header directly attached to the logs it labels', async () => {
    const rows = ['a', 'b'].map(
      (id) =>
        ({
          id,
          image: 'img',
          name: id,
          profile: 'work',
          project: 'hash',
          running: true,
          state: 'running',
          status: 'Up',
          type: 'main',
          workdir: '/tmp',
        }) satisfies CcpodContainer,
    );
    const events: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      events.push(`header:${values.join(' ')}`);
    };
    try {
      await streamContainerLogs(rows, '10', false, false, async (args) => {
        events.push(`logs:${args.at(-1)}`);
        return 0;
      });
    } finally {
      console.log = originalLog;
    }
    // Not every header first, then every log stream.
    expect(events).toEqual([
      'header:==> a (main) <==',
      'logs:a',
      'header:==> b (main) <==',
      'logs:b',
    ]);
  });

  it('builds Docker logs argv as separate arguments without shell evaluation', () => {
    expect(dockerLogsArgs('container;echo nope', '25', true)).toEqual([
      'logs',
      '--tail',
      '25',
      '--follow',
      'container;echo nope',
    ]);
  });
});
