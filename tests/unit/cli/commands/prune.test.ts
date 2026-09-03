import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';

type ExecResult = { exitCode: number; stdout: string; stderr: string };

let execResults: ExecResult[] = [];

const dockerExecMock = mock(
  async (_args: string[]): Promise<ExecResult> =>
    execResults.shift() ?? { exitCode: 0, stderr: '', stdout: '' },
);

const dockerSpawnMock = mock(async (_args: string[]): Promise<number> => 0);

mock.module('../../../../src/runtime/docker.ts', () => ({
  dockerExec: dockerExecMock,
  dockerSpawn: dockerSpawnMock,
}));

const { default: pruneCommand } = await import(
  '../../../../src/cli/commands/prune.ts'
);

beforeEach(() => {
  execResults = [];
  dockerExecMock.mockClear();
  dockerSpawnMock.mockClear();
});

afterEach(() => {
  execResults = [];
});

// Helper: queue multiple exec results
function queueResults(...results: ExecResult[]): void {
  execResults = [...results];
}

describe('ccpod prune', () => {
  it('reports nothing to prune when all lists are empty', async () => {
    // ps returns empty, network ls returns empty, volume ls returns empty
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': false, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toMatch(/No stopped ccpod containers/);
      expect(output).toMatch(/No orphaned ccpod networks/);
      expect(output).toMatch(/No unreferenced plugin volumes/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('dry-run lists but does not remove stopped containers', async () => {
    queueResults(
      {
        exitCode: 0,
        stderr: '',
        stdout: 'abc123|ccpod-default-hash|exited|default\n',
      }, // ps -a
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': true, force: false, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toMatch(/1 stopped container/);
      expect(output).toMatch(/Would remove/);
      // No `docker rm` call should have been made
      const rmCalls = dockerExecMock.mock.calls.filter((c) => c[0][0] === 'rm');
      expect(rmCalls.length).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('removes stopped containers when not dry-run', async () => {
    queueResults(
      {
        exitCode: 0,
        stderr: '',
        stdout: 'abc123|ccpod-default-hash|exited|default\n',
      }, // ps -a
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
      { exitCode: 0, stderr: '', stdout: '' }, // docker rm
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(
      () => true,
    );
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': false, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const rmCalls = dockerExecMock.mock.calls.filter((c) => c[0][0] === 'rm');
      expect(rmCalls.length).toBe(1);
      expect(rmCalls[0][0]).toEqual(['rm', 'abc123']);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('removes orphaned networks with no attached containers', async () => {
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (no containers)
      {
        exitCode: 0,
        stderr: '',
        stdout: 'ccpod-net-abc123\nccpod-net-def456\n',
      }, // network ls
      { exitCode: 0, stderr: '', stdout: '{}' }, // inspect net 1 (empty → orphan)
      { exitCode: 0, stderr: '', stdout: '{"someid":{}}' }, // inspect net 2 (not orphan)
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
      { exitCode: 0, stderr: '', stdout: '' }, // network rm
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(
      () => true,
    );
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': false, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const netRmCalls = dockerExecMock.mock.calls.filter(
        (c) => c[0][0] === 'network' && c[0][1] === 'rm',
      );
      expect(netRmCalls.length).toBe(1);
      expect(netRmCalls[0][0]).toEqual(['network', 'rm', 'ccpod-net-abc123']);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it('rejects invalid profile name', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        pruneCommand.run?.({
          args: { 'dry-run': false, force: true, profile: '../etc' },
          rawArgs: [],
        } as never),
      ).rejects.toThrow('process.exit');
      expect(errorSpy.mock.calls[0][0] as string).toMatch(/Invalid profile/);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('dry-run lists unreferenced volumes without removing them', async () => {
    // ps returns empty, network ls returns empty, volume ls returns one volume,
    // ps volume check returns empty (no refs), profileExists returns false (orphaned)
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (no containers)
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: 'ccpod-plugins-oldprof\n' }, // volume ls
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a --filter volume (no refs)
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': true, force: false, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toMatch(/1 unreferenced plugin volume/);
      expect(output).toMatch(/Would remove/);
      expect(output).toMatch(/ccpod-plugins-oldprof/);
      // No volume rm call
      const volRmCalls = dockerExecMock.mock.calls.filter(
        (c) => c[0][0] === 'volume' && c[0][1] === 'rm',
      );
      expect(volRmCalls.length).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('skips volumes with invalid profile name in volume name', async () => {
    // Volume name with path traversal suffix should be skipped by VOLUME_NAME_RE
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      {
        exitCode: 0,
        stderr: '',
        stdout: 'ccpod-plugins-..\nccpod-plugins-valid\n',
      }, // volume ls
      { exitCode: 0, stderr: '', stdout: '' }, // ps volume check for valid
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': true, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      // Should only list the valid volume, not the traversal one
      expect(output).toMatch(/ccpod-plugins-valid/);
      expect(output).not.toMatch(/Would remove.*ccpod-plugins-\.\./);
    } finally {
      logSpy.mockRestore();
    }
  });
});
