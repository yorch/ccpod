import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let destination = '';
const fakeGit = {
  checkIsRepo: async () => false,
  clone: async (_repo: string, target: string) => {
    mkdirSync(target, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'user-config.txt'), 'preserve');
  },
};

mock.module('simple-git', () => ({ default: () => fakeGit }));
const { syncGitConfig } = await import('../../../src/profile/git-sync.ts');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  destination = '';
});

describe('syncGitConfig clone race reconciliation', () => {
  it('verifies a destination that appears during clone before trusting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccpod-git-race-'));
    roots.push(root);
    const profileDir = join(root, 'profile');
    mkdirSync(profileDir);
    destination = join(profileDir, 'config');

    await expect(
      syncGitConfig(
        profileDir,
        'https://example.invalid/config',
        'main',
        'pin',
      ),
    ).rejects.toThrow('not a git checkout; no reset was performed');
    expect(readFileSync(join(destination, 'user-config.txt'), 'utf8')).toBe(
      'preserve',
    );
  });
});
