import { createHash } from 'node:crypto';
import {
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

// Sentinel file written last (just before the atomic rename) so concurrent
// readers can distinguish a fully-populated outDir from a half-written tree
// left behind by a crashed run.
const READY_SENTINEL = '.ccpod-ready';

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
  const outDir = join(tmpdir(), `ccpod-${hash}`);

  // On multi-user hosts another user must not be able to pre-seed the
  // deterministic path; require it to be a regular directory owned by us
  // AND fully populated (sentinel present).
  if (validateOwnedDir(outDir)) {
    return outDir;
  }

  // If outDir exists but lacks the sentinel, it's a half-written tree from a
  // crashed run. Removing it lets renameSync proceed; refuse if it isn't ours.
  clearBrokenOutDir(outDir);

  const tmpOut = mkdtempSync(join(tmpdir(), 'ccpod-tmp-'));
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

    // Sentinel last — its presence inside the renamed directory is what
    // signals "fully populated" to any concurrent reader.
    writeFileSync(join(tmpOut, READY_SENTINEL), '', {
      encoding: 'utf8',
      mode: 0o600,
    });

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

// Returns true if outDir is a regular directory owned by the current uid AND
// contains the ready-sentinel; false if it does not exist or is missing the
// sentinel (treat as "not yet present"); throws if the path exists but fails
// the structural / ownership checks.
function validateOwnedDir(outDir: string): boolean {
  if (!isOwnedDir(outDir)) {
    return false;
  }
  try {
    lstatSync(join(outDir, READY_SENTINEL));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

function isOwnedDir(outDir: string): boolean {
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

function clearBrokenOutDir(outDir: string): void {
  // isOwnedDir validates ownership and structure; only proceed if it's ours.
  // If it doesn't exist, nothing to clear. If it exists and is not ours,
  // isOwnedDir already threw.
  if (!isOwnedDir(outDir)) {
    return;
  }
  rmSync(outDir, { force: true, recursive: true });
}
