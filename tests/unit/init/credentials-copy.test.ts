import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copyCredentials,
  writeKeychainCredentials,
} from '../../../src/init/wizard.ts';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccpod-wiz-cred-'));
  prev = process.env.CCPOD_TEST_DIR;
  process.env.CCPOD_TEST_DIR = join(dir, 'ccpod');
});

afterEach(() => {
  if (prev === undefined) {
    delete process.env.CCPOD_TEST_DIR;
  } else {
    process.env.CCPOD_TEST_DIR = prev;
  }
  rmSync(dir, { force: true, recursive: true });
});

function credDir(name: string): string {
  const d = join(dir, 'ccpod', 'credentials', name);
  mkdirSync(d, { mode: 0o700, recursive: true });
  return d;
}

describe('wizard credential copy', () => {
  it('copies a regular credentials file', () => {
    writeFileSync(join(credDir('a'), '.credentials.json'), '{"t":1}');
    copyCredentials('a', 'b');
    expect(readFileSync(join(credDir('b'), '.credentials.json'), 'utf8')).toBe(
      '{"t":1}',
    );
  });

  it('refuses a symlinked source planted by a container', () => {
    const secret = join(dir, 'secret');
    writeFileSync(secret, 'HOST-SECRET');
    symlinkSync(secret, join(credDir('a'), '.credentials.json'));
    copyCredentials('a', 'b');
    let exists = true;
    try {
      lstatSync(join(credDir('b'), '.credentials.json'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('replaces a symlinked destination instead of writing through it', () => {
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'ORIGINAL');
    symlinkSync(victim, join(credDir('b'), '.credentials.json'));
    writeKeychainCredentials('{"new":true}', 'b');
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL');
    const dest = join(credDir('b'), '.credentials.json');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('{"new":true}');
  });
});
