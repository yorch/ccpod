import { existsSync, rmSync } from 'node:fs';
import chalk from 'chalk';
import simpleGit from 'simple-git';
import type { SyncStrategy } from '../types/index.ts';
import { shouldSync, writeSyncLock } from './lock.ts';

// Heuristic for "this ref looks like a commit SHA, not a branch/tag".
// `git clone --depth 1 --branch <sha>` is invalid; we have to clone-then-checkout.
function looksLikeSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

export async function syncGitConfig(
  profileDir: string,
  repo: string,
  ref: string,
  strategy: SyncStrategy,
): Promise<void> {
  const configDir = `${profileDir}/config`;

  if (!existsSync(configDir)) {
    console.log(chalk.dim('Cloning profile config...'));
    const git = simpleGit();
    try {
      if (looksLikeSha(ref)) {
        // Full clone, then check out the requested SHA. `--branch <sha>` is a
        // git error; `--depth 1` won't reach the commit unless the server
        // advertises it.
        await git.clone(repo, configDir);
        await simpleGit(configDir).checkout(ref);
      } else {
        await git.clone(repo, configDir, ['--depth', '1', '--branch', ref]);
      }
    } catch (err) {
      // A failed clone can leave a half-populated configDir behind. The next
      // run would then see existsSync(configDir) and skip the clone, leading
      // to opaque fetch failures. Wipe it so a retry is clean.
      rmSync(configDir, { force: true, recursive: true });
      throw err;
    }
    writeSyncLock(profileDir);
    return;
  }

  if (!shouldSync(profileDir, strategy)) {
    return;
  }

  console.log(chalk.dim('Syncing profile config...'));
  const git = simpleGit(configDir);
  if (looksLikeSha(ref)) {
    await git.fetch('origin', ref);
    await git.checkout(ref);
  } else {
    await git.fetch('origin', ref, { '--depth': '1' });
    await git.reset(['--hard', `origin/${ref}`]);
  }
  writeSyncLock(profileDir);
}
