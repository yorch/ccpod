import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectFileIfExists } from '../../../src/config/project-files.ts';

describe('readProjectFileIfExists', () => {
  let root: string;
  let outside: string;
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'ccpod-pf-'));
    root = join(base, 'proj');
    outside = join(base, 'outside.txt');
    mkdirSync(root);
    writeFileSync(outside, 'secret');
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(join(root, '..'), { force: true, recursive: true });
  });

  it('reads a regular file and returns null when absent', () => {
    writeFileSync(join(root, 'CLAUDE.md'), 'hi');
    expect(readProjectFileIfExists(root, join(root, 'CLAUDE.md'))).toBe('hi');
    expect(readProjectFileIfExists(root, join(root, 'nope'))).toBeNull();
  });

  it('accepts a symlink to a regular file inside the project', () => {
    writeFileSync(join(root, 'docs.md'), 'shared');
    symlinkSync('docs.md', join(root, 'CLAUDE.md'));
    expect(readProjectFileIfExists(root, join(root, 'CLAUDE.md'))).toBe(
      'shared',
    );
  });

  it('rejects a symlink escaping the project', () => {
    symlinkSync(outside, join(root, 'CLAUDE.md'));
    expect(readProjectFileIfExists(root, join(root, 'CLAUDE.md'))).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('rejects a symlink to a directory and broken symlinks', () => {
    mkdirSync(join(root, 'd'));
    symlinkSync('d', join(root, 'a'));
    symlinkSync('missing', join(root, 'b'));
    expect(readProjectFileIfExists(root, join(root, 'a'))).toBeNull();
    expect(readProjectFileIfExists(root, join(root, 'b'))).toBeNull();
  });
});
