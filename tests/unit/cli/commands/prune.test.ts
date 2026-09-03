import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ExecResult = { exitCode: number; stdout: string; stderr: string };

let execResults: ExecResult[] = [];
let testDir: string;

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
  testDir = mkdtempSync(join(tmpdir(), 'ccpod-prune-test-'));
  process.env.CCPOD_TEST_DIR = testDir;
  dockerExecMock.mockClear();
  dockerSpawnMock.mockClear();
});

afterEach(() => {
  execResults = [];
  delete process.env.CCPOD_TEST_DIR;
  rmSync(testDir, { force: true, recursive: true });
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

  it('skips volumes when docker ps reference check fails', async () => {
    // ps -a ok (no containers), network ls ok (empty), volume ls ok (one vol),
    // ps volume check FAILS → volume should be skipped, not removed.
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (no containers)
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: 'ccpod-plugins-oldprof\n' }, // volume ls
      { exitCode: 1, stderr: 'docker daemon error', stdout: '' }, // ps volume check FAILS
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': false, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      // Volume should NOT be listed as orphaned
      expect(output).toMatch(/No unreferenced plugin volumes/);
      // Warning should be emitted
      const warnOutput = warnSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      expect(warnOutput).toMatch(/could not check volume references/);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('skips networks when docker network inspect fails', async () => {
    // ps -a ok (no containers), network ls ok (one net), inspect FAILS
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a
      { exitCode: 0, stderr: '', stdout: 'ccpod-net-abc123\n' }, // network ls
      { exitCode: 1, stderr: 'permission denied', stdout: '' }, // inspect FAILS
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': false, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toMatch(/No orphaned ccpod networks/);
      const warnOutput = warnSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      expect(warnOutput).toMatch(/could not inspect network/);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('dry-run lists orphaned per-project state dirs', async () => {
    // Create a per-project state dir on disk
    const stateDir = join(testDir, 'state', 'myprof', 'abcdef0123456789');
    mkdirSync(stateDir, { recursive: true });
    // ps -a returns no containers (no active project hashes)
    // volume ls returns empty
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (containers, no active hashes)
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (state dir active hash check)
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': true, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toMatch(/1 orphaned state dir/);
      expect(output).toMatch(/myprof\/abcdef0123456789/);
      // Dir should still exist (dry-run)
      expect(readdirSync(stateDir)).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('removes orphaned per-project state dirs with --force', async () => {
    const stateDir = join(testDir, 'state', 'myprof', 'abcdef0123456789');
    mkdirSync(stateDir, { recursive: true });
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (containers for stale check)
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (state dir active hash check)
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (re-check before rm)
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': false, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toMatch(/done/);
      // Dir should be gone
      expect(() => readdirSync(stateDir)).toThrow();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not remove state dirs for projects with active containers', async () => {
    const stateDir = join(testDir, 'state', 'myprof', 'abcdef0123456789');
    mkdirSync(stateDir, { recursive: true });
    // ps -a returns a container with profile|hash matching the state dir
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (containers for stale check)
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
      {
        exitCode: 0,
        stderr: '',
        stdout: 'myprof|abcdef0123456789\n', // ps -a (state dir check: profile|hash IS active)
      },
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': false, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toMatch(/No orphaned state dirs/);
      // Dir should still exist
      expect(readdirSync(stateDir)).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('skips state dir removal if container starts between scan and rm', async () => {
    const stateDir = join(testDir, 'state', 'myprof', 'abcdef0123456789');
    mkdirSync(stateDir, { recursive: true });
    // Initial scan: no active containers. Re-check: container now exists.
    queueResults(
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (containers for stale check)
      { exitCode: 0, stderr: '', stdout: '' }, // network ls
      { exitCode: 0, stderr: '', stdout: '' }, // volume ls
      { exitCode: 0, stderr: '', stdout: '' }, // ps -a (state dir active hash check: empty)
      {
        exitCode: 0,
        stderr: '',
        stdout: 'container123\n', // ps -a (re-check before rm: container now exists!)
      },
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await pruneCommand.run?.({
        args: { 'dry-run': false, force: true, profile: undefined },
        rawArgs: [],
      } as never);
      const output = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
      expect(output).toMatch(/skipped/);
      // Dir should still exist
      expect(readdirSync(stateDir)).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});
