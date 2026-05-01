import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('ccpod config set', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(import.meta.dir, `__tmp_set_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.CCPOD_TEST_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    delete process.env.CCPOD_TEST_DIR;
  });

  describe('KNOWN_KEYS coercion', () => {
    it('coerces "true" to boolean true', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(KNOWN_KEYS.autoCheckUpdates('true')).toBe(true);
    });

    it('coerces "1" to boolean true', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(KNOWN_KEYS.autoCheckUpdates('1')).toBe(true);
    });

    it('coerces "false" to boolean false', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(KNOWN_KEYS.autoCheckUpdates('false')).toBe(false);
    });

    it('coerces "0" to boolean false', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(KNOWN_KEYS.autoCheckUpdates('0')).toBe(false);
    });

    it('throws on invalid boolean string', async () => {
      const { KNOWN_KEYS } = await import(
        '../../../../src/cli/commands/config/set.ts'
      );
      expect(() => KNOWN_KEYS.autoCheckUpdates('notabool')).toThrow(
        'expected boolean (true/false)',
      );
    });
  });

  describe('run()', () => {
    it('writes value and prints confirmation', async () => {
      const cmd = (await import('../../../../src/cli/commands/config/set.ts'))
        .default;
      const { loadGlobalConfig } = await import(
        '../../../../src/global/config.ts'
      );
      const logs: string[] = [];
      const logSpy = spyOn(console, 'log').mockImplementation((m) =>
        logs.push(m),
      );

      await cmd.run({
        args: { key: 'autoCheckUpdates', value: 'false' },
      } as never);

      logSpy.mockRestore();
      expect(logs).toContain('autoCheckUpdates = false');
      expect(loadGlobalConfig().autoCheckUpdates).toBe(false);
    });

    it('exits 1 on unknown key', async () => {
      const cmd = (await import('../../../../src/cli/commands/config/set.ts'))
        .default;
      const errors: string[] = [];
      const errSpy = spyOn(console, 'error').mockImplementation((m) =>
        errors.push(m),
      );
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

      try {
        expect(() =>
          cmd.run({ args: { key: 'nonexistent', value: 'x' } } as never),
        ).toThrow('process.exit');

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errors[0]).toContain("unknown config key 'nonexistent'");
        expect(errors[0]).toContain('autoCheckUpdates');
      } finally {
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it('exits 1 on invalid value', async () => {
      const cmd = (await import('../../../../src/cli/commands/config/set.ts'))
        .default;
      const errors: string[] = [];
      const errSpy = spyOn(console, 'error').mockImplementation((m) =>
        errors.push(m),
      );
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);

      try {
        expect(() =>
          cmd.run({
            args: { key: 'autoCheckUpdates', value: 'notabool' },
          } as never),
        ).toThrow('process.exit');

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errors[0]).toContain("invalid value for 'autoCheckUpdates'");
        expect(errors[0]).toContain('expected boolean (true/false)');
      } finally {
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  });
});
