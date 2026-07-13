import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Parent directory for all merged-config output. On a shared host /tmp is
// world-writable, so the deterministic `ccpod-<hash>` path could be pre-seeded
// or raced by another user. Nesting it under a private per-uid directory
// (0700, verified owned by us and not a symlink) means only our own uid can
// place anything there — no other user can plant a malicious settings.json at
// the path we're about to reuse.
function secureParentDir(): string {
  const base = tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) {
    // Non-POSIX (e.g. Windows) has no uid model; fall back to the temp root.
    return base;
  }
  const dir = join(base, `ccpod-u${uid}`);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Refusing to use ${dir}: not a regular directory.`);
  }
  if (st.uid !== uid) {
    throw new Error(
      `Refusing to use ${dir}: owned by uid ${st.uid}, not ${uid}.`,
    );
  }
  // Enforce 0700 even if the directory pre-existed with looser permissions.
  chmodSync(dir, 0o700);
  return dir;
}

function hashDir(dir: string, hash: ReturnType<typeof createHash>): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      hash.update(`${entry}/`);
      hashDir(p, hash);
    } else {
      hash.update(`${entry}:${stat.mtimeMs}:${stat.size}`);
    }
  }
}

function hashProfileDir(dir: string): string {
  const hash = createHash('sha256');
  hashDir(dir, hash);
  return hash.digest('hex').slice(0, 8);
}

function copyTreeSkipSymlinks(src: string, dest: string): void {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyTreeSkipSymlinks(join(src, entry), join(dest, entry));
    }
  } else {
    copyFileSync(src, dest);
  }
}

function copyAssets(srcDir: string, destDir: string): void {
  if (!existsSync(srcDir)) {
    return;
  }
  for (const entry of readdirSync(srcDir)) {
    if (entry === 'CLAUDE.md' || entry === 'settings.json') {
      continue;
    }
    const src = join(srcDir, entry);
    if (lstatSync(src).isSymbolicLink()) {
      continue;
    }
    copyTreeSkipSymlinks(src, join(destDir, entry));
  }
}

export function writeMergedConfig(
  profileConfigDir: string,
  mergedClaudeMd: string,
  mergedSettings: object,
  projectClaudeDir?: string,
  initCommands: string[] = [],
): string {
  const content = JSON.stringify({
    claudeMd: mergedClaudeMd,
    initCommands,
    profileDirHash: hashProfileDir(profileConfigDir),
    projectDirHash: projectClaudeDir ? hashProfileDir(projectClaudeDir) : '',
    settings: mergedSettings,
  });
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const parentDir = secureParentDir();
  const outDir = join(parentDir, `ccpod-${hash}`);

  // The private per-uid parent already blocks cross-user pre-seeding; still
  // require the deterministic path itself to be a regular directory owned by us.
  if (validateOwnedDir(outDir)) {
    return outDir;
  }

  const tmpOut = mkdtempSync(join(parentDir, 'tmp-'));
  try {
    // Profile assets first; project assets second so project wins on conflict
    copyAssets(profileConfigDir, tmpOut);
    if (projectClaudeDir) {
      copyAssets(projectClaudeDir, tmpOut);
    }

    writeFileSync(join(tmpOut, 'CLAUDE.md'), mergedClaudeMd, {
      encoding: 'utf8',
      mode: 0o600,
    });
    writeFileSync(
      join(tmpOut, 'settings.json'),
      JSON.stringify(mergedSettings, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );

    if (initCommands.length > 0) {
      const script = `#!/bin/sh\nset -e\n${initCommands.join('\n')}\n`;
      writeFileSync(join(tmpOut, 'post-init.sh'), script, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    renameSync(tmpOut, outDir);
  } catch (err) {
    rmSync(tmpOut, { force: true, recursive: true });
    // A concurrent run may have populated outDir between our lstat and the
    // rename; re-validate before reusing it.
    if (validateOwnedDir(outDir)) {
      return outDir;
    }
    throw err;
  }

  return outDir;
}

// Single-syscall existence + ownership check. Returns true if outDir is a
// regular directory owned by the current uid; false if it does not exist;
// throws if the path exists but fails the safety checks.
function validateOwnedDir(outDir: string): boolean {
  let existing: ReturnType<typeof lstatSync>;
  try {
    existing = lstatSync(outDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error(
      `Refusing to reuse merged-config path ${outDir}: not a regular directory.`,
    );
  }
  const ourUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (ourUid !== null && existing.uid !== ourUid) {
    throw new Error(
      `Refusing to reuse merged-config path ${outDir}: owned by uid ${existing.uid}, not ${ourUid}.`,
    );
  }
  return true;
}
