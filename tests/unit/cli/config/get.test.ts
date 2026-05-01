import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('ccpod config get', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dir, `__tmp_get_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.CCPOD_TEST_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    delete process.env.CCPOD_TEST_DIR;
  });

  it('prints current value when config file exists', async () => {
    const { saveGlobalConfig } = await import(
      '../../../../src/global/config.ts'
    );
    saveGlobalConfig({ autoCheckUpdates: false });

    const cmd = (await import('../../../../src/cli/commands/config/get.ts'))
      .default;
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((m) =>
      logs.push(m),
    );

    try {
      await cmd.run({ args: { key: 'autoCheckUpdates' } } as never);
      expect(logs).toContain('false');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints default value when no config file exists', async () => {
    const cmd = (await import('../../../../src/cli/commands/config/get.ts'))
      .default;
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((m) =>
      logs.push(m),
    );

    try {
      await cmd.run({ args: { key: 'autoCheckUpdates' } } as never);
      expect(logs).toContain('true');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('exits 1 on unknown key', async () => {
    const cmd = (await import('../../../../src/cli/commands/config/get.ts'))
      .default;
    const errors: string[] = [];
    const errSpy = spyOn(console, 'error').mockImplementation((m) =>
      errors.push(m),
    );
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    try {
      expect(() => cmd.run({ args: { key: 'nonexistent' } } as never)).toThrow(
        'process.exit',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errors[0]).toContain("unknown config key 'nonexistent'");
      expect(errors[0]).toContain('autoCheckUpdates');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
