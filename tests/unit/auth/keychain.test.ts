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
import {
  parseKeychainAccountOutput,
  writeCredentialFileAtomically,
} from '../../../src/auth/keychain.ts';

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

describe('parseKeychainAccountOutput', () => {
  it('reads a printable account from security metadata', () => {
    const attributes = [
      'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="1234567890"',
      '    "svce"<blob>="Claude Code-credentials"',
    ].join('\n');
    expect(parseKeychainAccountOutput(attributes)).toBe('1234567890');
  });

  it('decodes a hex-encoded account that security cannot print', () => {
    // "bob\u0000x" — the blob form security uses for non-printable bytes.
    const hex = Buffer.from('bob\u0000x', 'utf8').toString('hex');
    const attributes = `    "acct"<blob>=0x${hex}\n    "svce"<blob>="Claude Code-credentials"`;
    expect(parseKeychainAccountOutput(attributes)).toBe('bob\u0000x');
  });

  it('keeps an account that contains escaped quotes', () => {
    const attributes = '    "acct"<blob>="weird\\"name"';
    expect(parseKeychainAccountOutput(attributes)).toBe('weird"name');
  });

  it('refuses ambiguous or absent accounts instead of guessing', () => {
    expect(parseKeychainAccountOutput('class: "genp"')).toBeUndefined();
    expect(
      parseKeychainAccountOutput(
        '    "acct"<blob>="first"\n    "acct"<blob>="second"',
      ),
    ).toBeUndefined();
    expect(parseKeychainAccountOutput('    "acct"<blob>=""')).toBeUndefined();
  });
});
