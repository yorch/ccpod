import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncGitConfig } from '../../../src/profile/git-sync.ts';
import { writeSyncLock } from '../../../src/profile/lock.ts';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup) {
    rmSync(dir, { force: true, recursive: true });
  }
  cleanup.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccpod-git-test-'));
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

function makeLocalRepo(): { repoDir: string; ref: string } {
  const repoDir = makeTempDir();
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  git(['config', 'tag.gpgsign', 'false'], repoDir);
  writeFileSync(join(repoDir, 'config.txt'), 'initial content');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  return { ref: 'main', repoDir };
}

describe('syncGitConfig', () => {
  it('clones repo when configDir does not exist', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    const configDir = join(profileDir, 'config');
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, 'config.txt'))).toBe(true);
    expect(readFileSync(join(configDir, 'config.txt'), 'utf8')).toBe(
      'initial content',
    );
  });

  it('writes sync lock after cloning', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    expect(existsSync(join(profileDir, '.ccpod-sync-lock'))).toBe(true);
  });

  it('skips fetch when strategy=daily and synced today', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    const configDir = join(profileDir, 'config');

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    // Add a commit to the remote
    writeFileSync(join(repoDir, 'new-file.txt'), 'new content');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'update'], repoDir);

    // daily strategy with today's lock → should skip
    await syncGitConfig(profileDir, repoDir, ref, 'daily');

    expect(existsSync(join(configDir, 'new-file.txt'))).toBe(false);
  });

  it('fetches and resets when strategy=always', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    const configDir = join(profileDir, 'config');

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    // Add a commit to the remote
    writeFileSync(join(repoDir, 'update.txt'), 'updated content');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'update'], repoDir);

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    expect(existsSync(join(configDir, 'update.txt'))).toBe(true);
    expect(readFileSync(join(configDir, 'update.txt'), 'utf8')).toBe(
      'updated content',
    );
  });

  it('syncs a tag ref (reset uses FETCH_HEAD, not origin/<ref>)', async () => {
    const { repoDir } = makeLocalRepo();
    // Tag the initial commit and clone that tag.
    git(['tag', 'v1'], repoDir);
    const profileDir = makeTempDir();
    const configDir = join(profileDir, 'config');

    await syncGitConfig(profileDir, repoDir, 'v1', 'always');
    expect(existsSync(join(configDir, 'config.txt'))).toBe(true);

    // Move the tag forward on the remote to a new commit.
    writeFileSync(join(repoDir, 'tagged.txt'), 'tagged content');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'update'], repoDir);
    git(['tag', '-f', 'v1'], repoDir);

    // A shallow single-branch clone has no `origin/v1` ref, so the old
    // `reset --hard origin/v1` threw; FETCH_HEAD resolves the tag correctly.
    await syncGitConfig(profileDir, repoDir, 'v1', 'always');
    expect(existsSync(join(configDir, 'tagged.txt'))).toBe(true);
  });

  it('skips when strategy=pin regardless of lock state', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    const configDir = join(profileDir, 'config');

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    // Add a commit to the remote
    writeFileSync(join(repoDir, 'pinned.txt'), 'pinned');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'update'], repoDir);

    // pin strategy always skips — lock state irrelevant
    writeSyncLock(profileDir);
    await syncGitConfig(profileDir, repoDir, ref, 'pin');

    expect(existsSync(join(configDir, 'pinned.txt'))).toBe(false);
  });

  it('writes sync lock after a successful fetch', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    // Backdate lock to yesterday to force daily sync
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    writeFileSync(join(profileDir, '.ccpod-sync-lock'), String(yesterday));

    const beforeMs = Date.now();
    await syncGitConfig(profileDir, repoDir, ref, 'daily');

    const lockMs = Number(
      readFileSync(join(profileDir, '.ccpod-sync-lock'), 'utf8'),
    );
    expect(lockMs).toBeGreaterThanOrEqual(beforeMs);
  });

  it('keeps the cached config and does not throw when the remote is unreachable', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');

    rmSync(repoDir, { force: true, recursive: true });
    await syncGitConfig(profileDir, repoDir, ref, 'always');

    expect(readFileSync(join(profileDir, 'config', 'config.txt'), 'utf8')).toBe(
      'initial content',
    );
  });

  it('clones a commit SHA ref', async () => {
    const { repoDir } = makeLocalRepo();
    const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: repoDir,
    })
      .stdout.toString()
      .trim();
    writeFileSync(join(repoDir, 'later.txt'), 'later');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'later'], repoDir);

    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, `file://${repoDir}`, sha, 'always');

    const configDir = join(profileDir, 'config');
    expect(readFileSync(join(configDir, 'config.txt'), 'utf8')).toBe(
      'initial content',
    );
    expect(existsSync(join(configDir, 'later.txt'))).toBe(false);
  });

  it('refuses to replace a non-git local config directory', async () => {
    const profileDir = makeTempDir();
    const configDir = join(profileDir, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'user.txt'), 'local user data');

    await expect(
      syncGitConfig(profileDir, '/unused/remote', 'main', 'always'),
    ).rejects.toThrow('not a git checkout; no reset was performed');
    expect(readFileSync(join(configDir, 'user.txt'), 'utf8')).toBe(
      'local user data',
    );
  });

  it('refuses an origin mismatch without changing cached files', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    git(['remote', 'set-url', 'origin', '/different/repo'], configDir);

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'always'),
    ).rejects.toThrow(
      'origin does not match profile config.repo; no reset was performed',
    );
    expect(readFileSync(join(configDir, 'config.txt'), 'utf8')).toBe(
      'initial content',
    );
  });

  it('refuses to use a mismatched pin checkout before any cached fast return', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    git(['remote', 'set-url', 'origin', '/different/repo'], configDir);

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'pin'),
    ).rejects.toThrow(
      'origin does not match profile config.repo; no reset was performed',
    );
    expect(readFileSync(join(configDir, 'config.txt'), 'utf8')).toBe(
      'initial content',
    );
  });

  it('verifies cleanliness before daily fast return when the sync lock is current', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const file = join(profileDir, 'config', 'config.txt');
    writeFileSync(file, 'user edit');
    writeSyncLock(profileDir);

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'daily'),
    ).rejects.toThrow('local changes; no reset was performed');
    expect(readFileSync(file, 'utf8')).toBe('user edit');
  });

  it('rejects a config directory nested inside an enclosing git worktree', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = join(repoDir, 'nested-profile');
    const configDir = join(profileDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const beforeHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: repoDir,
    })
      .stdout.toString()
      .trim();

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'always'),
    ).rejects.toThrow(
      'worktree root does not match config directory; no reset was performed',
    );
    expect(
      Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoDir })
        .stdout.toString()
        .trim(),
    ).toBe(beforeHead);
    expect(existsSync(join(configDir, 'config.txt'))).toBe(false);
  });

  it('rejects symlink config destinations before returning or mutating their target', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    symlinkSync(repoDir, join(profileDir, 'config'));
    const beforeHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: repoDir,
    })
      .stdout.toString()
      .trim();

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'pin'),
    ).rejects.toThrow('config directory is a symlink; no reset was performed');
    expect(
      Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoDir })
        .stdout.toString()
        .trim(),
    ).toBe(beforeHead);
  });

  it('refuses to reset a dirty owned checkout and preserves local edits', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const file = join(profileDir, 'config', 'config.txt');
    writeFileSync(file, 'user edit');

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'always'),
    ).rejects.toThrow('local changes; no reset was performed');
    expect(readFileSync(file, 'utf8')).toBe('user edit');
  });

  it('ignores untracked files when verifying a reused checkout', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    // A leftover editor/Finder artifact must not block every start: reset
    // --hard never removes untracked files, so they are not a safety concern.
    writeFileSync(join(configDir, '.DS_Store'), 'junk');

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    expect(existsSync(join(configDir, '.DS_Store'))).toBe(true);
    expect(readFileSync(join(configDir, 'config.txt'), 'utf8')).toBe(
      'initial content',
    );
  });

  it('accepts an equivalent remote spelling for the same repository', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');

    // A trailing slash is spelling, not a different repository.
    git(['remote', 'set-url', 'origin', `${repoDir}/`], configDir);
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    expect(readFileSync(join(configDir, 'config.txt'), 'utf8')).toBe(
      'initial content',
    );
  });

  it('refuses a `.git`-suffixed origin that need not be the same repository', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    // On a plain server `repo` and `repo.git` can be distinct repositories, so
    // this fails closed with an actionable message instead of guessing.
    git(['remote', 'set-url', 'origin', `${repoDir}.git`], configDir);

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'always'),
    ).rejects.toThrow(/origin does not match profile config\.repo/);
  });

  it('does not equate scp-style and ssh-URL spellings of the same host', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    // `host:repo` is home-relative while `ssh://host/repo` is absolute, so the
    // two spellings can address different repositories and must not match.
    git(
      ['remote', 'set-url', 'origin', 'ssh://git@example.invalid/repo'],
      configDir,
    );

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'always'),
    ).rejects.toThrow('origin does not match profile config.repo');
  });

  it('refuses a reset that would overwrite an untracked local file', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    writeFileSync(join(repoDir, 'incoming.txt'), 'from upstream');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'add incoming'], repoDir);
    // The incoming revision tracks a path the checkout already has as untracked
    // local work; `reset --hard` would destroy it.
    writeFileSync(join(configDir, 'incoming.txt'), 'local untracked work');

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'always'),
    ).rejects.toThrow('would be overwritten');
    expect(readFileSync(join(configDir, 'incoming.txt'), 'utf8')).toBe(
      'local untracked work',
    );
  });

  it('refuses an incoming file that an untracked directory would replace', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    writeFileSync(join(repoDir, 'notes'), 'incoming file');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'add notes file'], repoDir);
    mkdirSync(join(configDir, 'notes'));
    writeFileSync(join(configDir, 'notes', 'draft.txt'), 'local work');

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'always'),
    ).rejects.toThrow('would be overwritten');
    expect(readFileSync(join(configDir, 'notes', 'draft.txt'), 'utf8')).toBe(
      'local work',
    );
  });

  it('refuses an untracked file that an incoming path nests under', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    mkdirSync(join(repoDir, 'notes'));
    writeFileSync(join(repoDir, 'notes', 'draft.txt'), 'incoming nested file');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'add nested file'], repoDir);
    writeFileSync(join(configDir, 'notes'), 'local untracked file');

    await expect(
      syncGitConfig(profileDir, repoDir, ref, 'always'),
    ).rejects.toThrow('would be overwritten');
    expect(readFileSync(join(configDir, 'notes'), 'utf8')).toBe(
      'local untracked file',
    );
  });

  it('still syncs when untracked files do not collide with the incoming revision', async () => {
    const { repoDir, ref } = makeLocalRepo();
    const profileDir = makeTempDir();
    await syncGitConfig(profileDir, repoDir, ref, 'always');
    const configDir = join(profileDir, 'config');
    writeFileSync(join(repoDir, 'incoming.txt'), 'from upstream');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'add incoming'], repoDir);
    writeFileSync(join(configDir, '.DS_Store'), 'junk');

    await syncGitConfig(profileDir, repoDir, ref, 'always');

    expect(readFileSync(join(configDir, 'incoming.txt'), 'utf8')).toBe(
      'from upstream',
    );
    expect(existsSync(join(configDir, '.DS_Store'))).toBe(true);
  });
});
