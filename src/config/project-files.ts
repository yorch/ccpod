import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';

/**
 * True when `child` is `root` or lives beneath it (both already realpath'd).
 */
export function isInsideDir(root: string, child: string): boolean {
  if (child === root) {
    return true;
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(prefix);
}

/**
 * Read a file that comes from an untrusted project checkout. Regular files are
 * read directly. A symlink is accepted only when its realpath is a regular file
 * inside `realpath(projectRoot)` (so repos that symlink `CLAUDE.md` to a shared
 * in-repo doc keep working) — escapes such as `CLAUDE.md -> ~/.aws/credentials`
 * and anything that is not a regular file are ignored with a warning.
 * Returns null when the file is absent or rejected.
 */
export function readProjectFileIfExists(
  projectRoot: string,
  path: string,
): string | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) {
    try {
      const real = realpathSync(path);
      const root = realpathSync(projectRoot);
      if (!(isInsideDir(root, real) && statSync(real).isFile())) {
        console.warn(
          `Warning: ${path} is a symlink that resolves outside the project (or is not a regular file) — ignoring it.`,
        );
        return null;
      }
      return readFileSync(real, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      console.warn(
        code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR'
          ? `Warning: ${path} is a broken symlink — ignoring it.`
          : `Warning: could not read symlinked ${path} (${code ?? (error as Error)?.message}) — ignoring it.`,
      );
      return null;
    }
  }
  if (!stat.isFile()) {
    console.warn(`Warning: ${path} is not a regular file — ignoring it.`);
    return null;
  }
  return readFileSync(path, 'utf8');
}
