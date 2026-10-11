import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredentialFileAtomically } from '../../../src/auth/keychain.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccpod-keychain-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('writeCredentialFileAtomically', () => {
  it('preserves the current token if a staged write fails partway through', () => {
    const dir = makeTempDir();
    const destination = join(dir, '.credentials.json');
    writeFileSync(destination, 'current-generation', { mode: 0o600 });

    expect(() =>
      writeCredentialFileAtomically(destination, 'next-generation', {
        rename: renameSync,
        write: (path, data, options) => {
          writeFileSync(path, data.slice(0, 4), options);
          throw new Error('simulated ENOSPC after partial write');
        },
      }),
    ).toThrow('simulated ENOSPC');

    expect(readFileSync(destination, 'utf8')).toBe('current-generation');
    expect(readdirSync(dir)).toEqual(['.credentials.json']);
  });

  it('atomically replaces the file with private permissions', () => {
    const dir = makeTempDir();
    const destination = join(dir, '.credentials.json');
    writeFileSync(destination, 'old-generation', { mode: 0o600 });

    writeCredentialFileAtomically(destination, 'new-generation');

    expect(readFileSync(destination, 'utf8')).toBe('new-generation');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['.credentials.json']);
  });
});
