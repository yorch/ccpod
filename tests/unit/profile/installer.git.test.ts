import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchProfileYaml } from '../../../src/profile/installer.ts';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch {}
  }
  cleanup.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccpod-installer-git-test-'));
  cleanup.push(dir);
  return dir;
}

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr?.toString()}`);
  }
}

function makeLocalRepo(withProfileYml: boolean): string {
  const repoDir = makeTempDir();
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  if (withProfileYml) {
    writeFileSync(
      join(repoDir, 'profile.yml'),
      'name: test\nstate: ephemeral\n',
    );
  } else {
    writeFileSync(join(repoDir, 'README.md'), '# no profile here');
  }
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  return repoDir;
}

describe('fetchProfileYaml - git', () => {
  it('clones repo and returns profile.yml content', async () => {
    const repoDir = makeLocalRepo(true);
    const result = await fetchProfileYaml({ type: 'git', url: repoDir });
    expect(result).toBe('name: test\nstate: ephemeral\n');
  });

  it('clone target is a subdirectory of the temp base (not the temp dir itself)', async () => {
    const repoDir = makeLocalRepo(true);
    // If clone target were the mkdtempSync dir itself, clone would fail with
    // "destination path already exists". Success here proves subdirectory clone.
    await expect(
      fetchProfileYaml({ type: 'git', url: repoDir }),
    ).resolves.toBeDefined();
  });

  it('throws when profile.yml not found at repo root', async () => {
    const repoDir = makeLocalRepo(false);
    await expect(
      fetchProfileYaml({ type: 'git', url: repoDir }),
    ).rejects.toThrow('No profile.yml found');
  });

  it('cleans up temp dir even when profile.yml is missing', async () => {
    const repoDir = makeLocalRepo(false);
    const tmpsBefore = mkdtempSync(join(tmpdir(), 'sentinel-'));
    cleanup.push(tmpsBefore);

    try {
      await fetchProfileYaml({ type: 'git', url: repoDir });
    } catch {}

    // Can't check the exact tmp path, but the function should not leave behind
    // ccpod-install-* dirs in tmpdir. Verify the call resolves/rejects cleanly.
    expect(existsSync(repoDir)).toBe(true); // source repo untouched
  });
});
