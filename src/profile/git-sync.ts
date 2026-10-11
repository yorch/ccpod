import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
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

  if (!pathExists(configDir)) {
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
      try {
        await git.clone(repo, tmpDir, ['--depth', '1', '--branch', ref]);
      } catch (cloneErr) {
        // `--branch` only accepts branch and tag names. A commit SHA (which
        // `config.ref` allows) needs init + fetch-by-ref instead.
        rmTmp();
        try {
          await cloneAtRef(repo, tmpDir, ref);
        } catch {
          throw cloneErr;
        }
      }
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
      if (!pathExists(configDir)) {
        throw err;
      }
    }
    // The destination may have been populated by another process. Validate
    // both freshly cloned and race-lost destinations before recording/reusing.
    await verifyGitCheckout(configDir, repo);
    writeSyncLock(profileDir);
    return;
  }

  // Validate every reused checkout, even when pin/daily means no fetch. Those
  // strategies control freshness only; they are not an ownership boundary.
  await verifyGitCheckout(configDir, repo);
  if (!shouldSync(profileDir, strategy)) {
    return;
  }

  console.log(chalk.dim('Syncing profile config...'));
  const git = simpleGit(realpathSync(configDir));
  // Reset to FETCH_HEAD rather than `origin/<ref>`: a shallow single-branch
  // clone only tracks its clone branch, so a tag or a since-changed ref has no
  // `origin/<ref>` remote-tracking ref and `reset --hard origin/<ref>` fails
  // with "unknown revision". `fetch` always updates FETCH_HEAD to the fetched
  // ref, which works for branches, tags, and SHAs alike.
  try {
    await git.fetch('origin', ref, { '--depth': '1' });
  } catch (err) {
    // A failed fetch does not mutate the checkout, so a previously verified
    // cached config remains safe to use for this run.
    console.warn(
      chalk.yellow(
        `Warning: could not sync profile config (${err instanceof Error ? err.message : String(err)}); using the cached copy.`,
      ),
    );
    return;
  }
  // Recheck after fetch, immediately before the only destructive operation.
  await verifyGitCheckout(configDir, repo);
  await git.reset(['--hard', 'FETCH_HEAD']);
  writeSyncLock(profileDir);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function verifyGitCheckout(
  configDir: string,
  repo: string,
): Promise<void> {
  let reason: string | undefined;
  try {
    const stat = lstatSync(configDir);
    if (stat.isSymbolicLink()) {
      reason = 'config directory is a symlink';
    } else if (!stat.isDirectory()) {
      reason = 'config path is not a directory';
    }
    if (!reason) {
      const canonicalDir = realpathSync(configDir);
      const git = simpleGit(canonicalDir);
      if (!(await git.checkIsRepo())) {
        reason = 'config directory is not a git checkout';
      } else {
        const worktree = realpathSync(
          (await git.revparse(['--show-toplevel'])).trim(),
        );
        if (worktree !== canonicalDir) {
          reason = 'git worktree root does not match config directory';
        } else {
          let origin: string | undefined;
          try {
            origin = (await git.raw(['remote', 'get-url', 'origin'])).trim();
          } catch {
            reason = 'could not verify checkout origin';
          }
          if (origin !== undefined && origin !== repo) {
            reason = 'checkout origin does not match profile config.repo';
          }
          if (
            origin !== undefined &&
            !reason &&
            !(await git.status()).isClean()
          ) {
            reason = 'checkout has local changes';
          }
        }
      }
    }
  } catch {
    reason ??= 'could not verify git checkout ownership';
  }
  if (reason) {
    throw new Error(
      `Cannot safely sync profile config: ${reason}; no reset was performed.`,
    );
  }
}

async function cloneAtRef(
  repo: string,
  dir: string,
  ref: string,
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addRemote('origin', repo);
  await git.fetch('origin', ref, { '--depth': '1' });
  await git.checkout(['--detach', 'FETCH_HEAD']);
}
