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
  await assertUntrackedResetSafe(configDir);
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
      let worktreeRoot: string | undefined;
      try {
        // Fails on a directory that is not a git checkout, so this replaces a
        // separate `git rev-parse --is-inside-work-tree` probe.
        worktreeRoot = realpathSync(
          (await git.revparse(['--show-toplevel'])).trim(),
        );
      } catch {
        reason = 'config directory is not a git checkout';
      }
      if (!reason && worktreeRoot !== canonicalDir) {
        reason = 'git worktree root does not match config directory';
      }
      if (!reason) {
        let origin: string | undefined;
        try {
          origin = (await git.raw(['remote', 'get-url', 'origin'])).trim();
        } catch {
          reason = 'could not verify checkout origin';
        }
        if (
          origin !== undefined &&
          !reason &&
          normalizeRepoUrl(origin) !== normalizeRepoUrl(repo)
        ) {
          reason = 'checkout origin does not match profile config.repo';
        }
        if (origin !== undefined && !reason) {
          // Untracked files are ignored on purpose: `reset --hard` never
          // removes them, and refusing to run because of a leftover editor
          // artifact (say, `.DS_Store`) would block every start. Tracked
          // modifications still fail closed.
          const dirty = (
            await git.raw(['status', '--porcelain', '--untracked-files=no'])
          ).trim();
          if (dirty.length > 0) {
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
      `Cannot safely sync profile config: ${reason}; no reset was performed. ` +
        `Remove ${configDir} to let ccpod re-clone it.`,
    );
  }
}

/**
 * Compare remote spellings that address the same repository: a trailing `/`,
 * scheme casing, and host casing. Things deliberately NOT folded together,
 * because they can name different repositories: a `.git` suffix, scp-style
 * `user@host:path` (home-relative) versus `ssh://user@host/path` (absolute),
 * and case-sensitive userinfo (SSH users, HTTP credentials). Repository paths
 * stay case-sensitive too.
 */
function normalizeRepoUrl(repo: string): string {
  // A trailing slash is spelling. A `.git` suffix is NOT folded away: on a
  // plain SSH server `repo` and `repo.git` can be different repositories, and
  // refusing a changed remote fails closed with an actionable message.
  const value = repo.trim().replace(/\/+$/, '');
  const scp = /^([^/@]+@)?([^/:]+):(?!\/)(.+)$/.exec(value);
  if (scp && !value.includes('://')) {
    return `scp:${scp[1] ?? ''}${(scp[2] ?? '').toLowerCase()}/${scp[3]}`;
  }
  const withScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(value);
  if (!withScheme) {
    return value;
  }
  const scheme = (withScheme[1] ?? '').toLowerCase();
  const rest = withScheme[2] ?? '';
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  const userinfo = at < 0 ? '' : authority.slice(0, at + 1);
  const hostport = (at < 0 ? authority : authority.slice(at + 1)).toLowerCase();
  return `${scheme}://${userinfo}${hostport}${path}`;
}

/**
 * Refuse a reset that would destroy untracked local work in the checkout.
 * Untracked files are otherwise ignored (they do not make a checkout unsafe to
 * reuse), but `git reset --hard` does overwrite an untracked file that collides
 * with an incoming tracked path, so the two sets are compared right before the
 * only destructive step.
 */
async function assertUntrackedResetSafe(configDir: string): Promise<void> {
  const git = simpleGit(realpathSync(configDir));
  let untracked: string[];
  let incomingFiles: Set<string>;
  try {
    const [untrackedRaw, incomingRaw] = await Promise.all([
      // Every untracked path, including ignored ones: `reset --hard` can still
      // remove an ignored file that collides with an incoming tracked path.
      // `-z` keeps git from quoting/escaping unusual names (the default output
      // wraps `notes/é.txt` in quotes and octal escapes), which would defeat
      // the prefix comparison below.
      git.raw(['ls-files', '--others', '-z']),
      git.raw(['ls-tree', '-r', '--name-only', '-z', 'FETCH_HEAD']),
    ]);
    untracked = splitPaths(untrackedRaw);
    incomingFiles = new Set(
      splitPaths(incomingRaw).map(canonicalPathForCompare),
    );
  } catch (error) {
    throw new Error(
      `Cannot safely sync profile config: could not list untracked files before the reset (${error instanceof Error ? error.message : String(error)}); no reset was performed. Remove ${configDir} to let ccpod re-clone it.`,
    );
  }
  if (untracked.length === 0) {
    return;
  }
  // An incoming path can also clobber a directory, and an incoming file can be
  // blocked by an untracked path nested under it, so compare whole chains.
  const incomingDirs = new Set<string>();
  for (const incoming of incomingFiles) {
    for (const ancestor of ancestorsOf(incoming)) {
      incomingDirs.add(ancestor);
    }
  }
  const collision = untracked.find((path) => {
    const canonical = canonicalPathForCompare(path);
    return (
      incomingFiles.has(canonical) ||
      incomingDirs.has(canonical) ||
      ancestorsOf(canonical).some((ancestor) => incomingFiles.has(ancestor))
    );
  });
  if (collision !== undefined) {
    throw new Error(
      `Cannot safely sync profile config: untracked path '${collision}' would be overwritten by the incoming revision; no reset was performed. Move or remove it, or remove ${configDir} to let ccpod re-clone it.`,
    );
  }
}

/**
 * Canonicalize a path for collision comparison. NFC plus lowercasing folds the
 * two ways a filesystem can treat distinct byte strings as one path: APFS/HFS+
 * ignore Unicode normalization (composed `é` vs decomposed `e` + U+0301), and
 * case-insensitive filesystems ignore case. This is deliberately conservative
 * on case- and normalization-sensitive filesystems.
 */
function canonicalPathForCompare(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'));
  }
  return ancestors;
}

/** Split `git ... -z` output: NUL-delimited, unquoted, unescaped names. */
function splitPaths(raw: string): string[] {
  return raw.split('\0').filter((entry) => entry !== '');
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
