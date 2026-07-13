import { existsSync, renameSync, rmSync } from 'node:fs';
import chalk from 'chalk';
import simpleGit from 'simple-git';
import type { SyncStrategy } from '../types/index.ts';
import { shouldSync, writeSyncLock } from './lock.ts';

export async function syncGitConfig(
  profileDir: string,
  repo: string,
  ref: string,
  strategy: SyncStrategy,
): Promise<void> {
  const configDir = `${profileDir}/config`;

  if (!existsSync(configDir)) {
    console.log(chalk.dim('Cloning profile config...'));
    // Clone into a per-process temp dir and rename into place atomically. This
    // (1) keeps a crashed/partial clone from leaving a corrupt `config/` that a
    // later run would `existsSync`-skip and then fail to fetch from, and
    // (2) resolves the race between concurrent first-runs of the same profile —
    // whoever renames first wins; the loser discards its clone and reuses it.
    const tmpDir = `${configDir}.tmp-${process.pid}`;
    const rmTmp = () => rmSync(tmpDir, { force: true, recursive: true });
    rmTmp();
    const git = simpleGit();
    try {
      await git.clone(repo, tmpDir, ['--depth', '1', '--branch', ref]);
    } catch (err) {
      rmTmp();
      throw err;
    }
    try {
      renameSync(tmpDir, configDir);
    } catch (err) {
      rmTmp();
      // Benign only if another process populated configDir first (lost race).
      // If configDir still isn't there, the rename failed for a real reason
      // (e.g. a permission error or a file squatting the path) — surface it
      // instead of writing a sync lock that claims success.
      if (!existsSync(configDir)) {
        throw err;
      }
    }
    writeSyncLock(profileDir);
    return;
  }

  if (!shouldSync(profileDir, strategy)) {
    return;
  }

  console.log(chalk.dim('Syncing profile config...'));
  const git = simpleGit(configDir);
  // Reset to FETCH_HEAD rather than `origin/<ref>`: a shallow single-branch
  // clone only tracks its clone branch, so a tag or a since-changed ref has no
  // `origin/<ref>` remote-tracking ref and `reset --hard origin/<ref>` fails
  // with "unknown revision". `fetch` always updates FETCH_HEAD to the fetched
  // ref, which works for branches, tags, and SHAs alike.
  await git.fetch('origin', ref, { '--depth': '1' });
  await git.reset(['--hard', 'FETCH_HEAD']);
  writeSyncLock(profileDir);
}
