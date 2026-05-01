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
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) continue;
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
  if (stat.isSymbolicLink()) return;
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
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir)) {
    if (entry === 'CLAUDE.md' || entry === 'settings.json') continue;
    const src = join(srcDir, entry);
    if (lstatSync(src).isSymbolicLink()) continue;
    copyTreeSkipSymlinks(src, join(destDir, entry));
  }
}

export function writeMergedConfig(
  profileConfigDir: string,
  mergedClaudeMd: string,
  mergedSettings: object,
  projectClaudeDir?: string,
): string {
  const content = JSON.stringify({
    claudeMd: mergedClaudeMd,
    profileDirHash: hashProfileDir(profileConfigDir),
    projectDirHash: projectClaudeDir ? hashProfileDir(projectClaudeDir) : '',
    settings: mergedSettings,
  });
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const outDir = join(tmpdir(), `ccpod-${hash}`);

  if (existsSync(outDir)) return outDir;

  const tmpOut = mkdtempSync(join(tmpdir(), 'ccpod-tmp-'));
  try {
    // Profile assets first; project assets second so project wins on conflict
    copyAssets(profileConfigDir, tmpOut);
    if (projectClaudeDir) copyAssets(projectClaudeDir, tmpOut);

    writeFileSync(join(tmpOut, 'CLAUDE.md'), mergedClaudeMd, {
      encoding: 'utf8',
      mode: 0o600,
    });
    writeFileSync(
      join(tmpOut, 'settings.json'),
      JSON.stringify(mergedSettings, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );

    renameSync(tmpOut, outDir);
  } catch (err) {
    rmSync(tmpOut, { force: true, recursive: true });
    if (existsSync(outDir)) return outDir;
    throw err;
  }

  return outDir;
}
