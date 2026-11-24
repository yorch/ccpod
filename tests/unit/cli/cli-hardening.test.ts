import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPromptFile,
  resolvePromptFileArg,
} from '../../../src/cli/commands/run.ts';

describe('run --file resolution', () => {
  it('allows names that merely start with ..', () => {
    expect(resolvePromptFileArg('..notes.md')).toBe('..notes.md');
    expect(resolvePromptFileArg('sub/p.md')).toBe('sub/p.md');
  });
  it('rejects parent traversal and absolute paths', () => {
    expect(() => resolvePromptFileArg('../x.md')).toThrow('relative path');
    expect(() => resolvePromptFileArg('a/../../x.md')).toThrow('relative');
    expect(() => resolvePromptFileArg('/etc/passwd')).toThrow('relative');
  });

  describe('readPromptFile', () => {
    let base = '';
    afterEach(() => rmSync(base, { force: true, recursive: true }));
    it('reads inside, rejects symlink escapes and non-files', () => {
      base = mkdtempSync(join(tmpdir(), 'ccpod-runfile-'));
      const proj = join(base, 'proj');
      mkdirSync(join(proj, 'dir'), { recursive: true });
      writeFileSync(join(proj, 'p.md'), 'do it');
      writeFileSync(join(base, 'secret'), 'x');
      symlinkSync(join(base, 'secret'), join(proj, 'link.md'));
      expect(readPromptFile(proj, 'p.md', 'p.md')).toBe('do it');
      expect(() => readPromptFile(proj, 'link.md', 'link.md')).toThrow(
        'outside the project',
      );
      expect(() => readPromptFile(proj, 'dir', 'dir')).toThrow('not a regular');
    });
  });
});

describe('config get/set prototype keys', () => {
  for (const mod of ['get', 'set']) {
    it(`${mod} rejects toString as unknown key`, async () => {
      const cmd = (await import(`../../../src/cli/commands/config/${mod}.ts`))
        .default;
      const err = spyOn(console, 'error').mockImplementation(() => {});
      const exit = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as never);
      try {
        expect(() =>
          cmd.run({ args: { key: 'toString', value: 'x' } } as never),
        ).toThrow('exit');
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        err.mockRestore();
        exit.mockRestore();
      }
    });
  }
});
