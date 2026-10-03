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

const { default: downCommand } = await import(
  '../../../../src/cli/commands/down.ts'
);

beforeEach(() => {
  execResults = [];
  dockerExecMock.mockClear();
  dockerSpawnMock.mockClear();
});

afterEach(() => {
  execResults = [];
});

describe('ccpod down --profile validation', () => {
  it('exits on invalid profile name with path separator', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        downCommand.run?.({
          args: { all: false, profile: '../etc' },
          rawArgs: [],
        } as never),
      ).rejects.toThrow('process.exit');
      expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
      const msg = errorSpy.mock.calls[0][0] as string;
      expect(msg).toMatch(/Invalid profile name/);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('exits on profile name with shell metacharacters', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        downCommand.run?.({
          args: { all: false, profile: 'foo;rm -rf' },
          rawArgs: [],
        } as never),
      ).rejects.toThrow('process.exit');
      expect(errorSpy.mock.calls[0][0] as string).toMatch(/Invalid profile/);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('accepts a valid profile name and proceeds to docker ps', async () => {
    // docker ps returns empty → "No ccpod containers found"
    execResults = [{ exitCode: 0, stderr: '', stdout: '' }];
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await downCommand.run?.({
        args: { all: false, profile: 'my-profile' },
        rawArgs: [],
      } as never);
      // First dockerExec call should be `ps -a --filter ...`
      expect(dockerExecMock.mock.calls[0][0][0]).toBe('ps');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('accepts no profile flag (default behavior)', async () => {
    execResults = [{ exitCode: 0, stderr: '', stdout: '' }];
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await downCommand.run?.({
        args: { all: false, profile: undefined },
        rawArgs: [],
      } as never);
      expect(dockerExecMock.mock.calls[0][0][0]).toBe('ps');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('ccpod down scoping and failure handling', () => {
  it('--all --profile X keeps the profile filter', async () => {
    execResults = [{ exitCode: 0, stderr: '', stdout: '' }];
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await downCommand.run?.({
        args: { all: true, profile: 'work' },
        rawArgs: [],
      } as never);
      const psArgs = dockerExecMock.mock.calls[0][0] as string[];
      expect(psArgs).toContain('label=ccpod.profile=work');
      // --all does not restrict to the current project
      expect(psArgs.some((a) => a.startsWith('label=ccpod.project='))).toBe(
        false,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('exits non-zero when docker ps fails instead of reporting nothing running', async () => {
    execResults = [
      {
        exitCode: 1,
        stderr: 'Cannot connect to the Docker daemon',
        stdout: '',
      },
    ];
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        downCommand.run?.({
          args: { all: false, profile: undefined },
          rawArgs: [],
        } as never),
      ).rejects.toThrow('process.exit');
      expect(errorSpy.mock.calls[0][0] as string).toMatch(/Cannot connect/);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('rejects an unexpected positional argument', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        downCommand.run?.({
          args: { _: ['work'], all: false, profile: undefined },
          rawArgs: [],
        } as never),
      ).rejects.toThrow('process.exit');
      expect(errorSpy.mock.calls[0][0] as string).toMatch(/--profile/);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
