import { describe, expect, it, mock } from 'bun:test';
import { listCcpodContainers } from '../../../src/container/list.ts';

type Exec = typeof import('../../../src/runtime/docker.ts').dockerExec;

function fakeExec(stdout: string, exitCode = 0, stderr = '') {
  return mock(async () => ({ exitCode, stderr, stdout })) as unknown as Exec &
    ReturnType<typeof mock>;
}

describe('listCcpodContainers', () => {
  it('parses tab-separated rows, including workdirs with commas and pipes', async () => {
    const exec = fakeExec(
      [
        'abc123',
        '/ccpod-work-1',
        'running',
        'img:1',
        'Up 2 minutes',
        'work',
        'deadbeefdeadbeef',
        '/home/me/a,b|c',
      ].join('\t'),
    );
    const rows = await listCcpodContainers({}, exec);
    expect(rows).toEqual([
      {
        id: 'abc123',
        image: 'img:1',
        name: 'ccpod-work-1',
        profile: 'work',
        project: 'deadbeefdeadbeef',
        running: true,
        state: 'running',
        status: 'Up 2 minutes',
        workdir: '/home/me/a,b|c',
      },
    ]);
  });

  it('builds filters from the options', async () => {
    const exec = fakeExec('');
    await listCcpodContainers(
      { all: true, profile: 'work', project: 'deadbeefdeadbeef' },
      exec,
    );
    const args = (exec as unknown as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as string[];
    expect(args[0]).toBe('ps');
    expect(args).toContain('-a');
    expect(args).toContain('label=ccpod.profile=work');
    expect(args).toContain('label=ccpod.project=deadbeefdeadbeef');
  });

  it('throws when docker fails instead of reporting an empty list', async () => {
    await expect(
      listCcpodContainers(
        {},
        fakeExec('', 1, 'Cannot connect to the Docker daemon'),
      ),
    ).rejects.toThrow(/Cannot connect/);
  });
});
