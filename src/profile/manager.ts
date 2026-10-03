import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseDocument } from 'yaml';

// Re-evaluated at each call so CCPOD_TEST_DIR env override works in tests.
// Other modules (auth/resolver.ts, global/config.ts, update/checker.ts) import
// this so the test override stays a single source of truth.
export function getCcpodHome(): string {
  return process.env.CCPOD_TEST_DIR ?? join(homedir(), '.ccpod');
}

function baseDir(): string {
  return getCcpodHome();
}

function profilesDir(): string {
  return join(baseDir(), 'profiles');
}

function credentialsBase(): string {
  return join(baseDir(), 'credentials');
}

export function ensureCcpodDirs(): void {
  mkdirSync(baseDir(), { mode: 0o700, recursive: true });
  // chmod ensures 0o700 even if the base dir pre-existed with looser perms
  // (e.g. created by saveGlobalConfig before the mode was added, or by a
  // prior version of ccpod that relied on umask).
  chmodSync(baseDir(), 0o700);
  mkdirSync(profilesDir(), { mode: 0o700, recursive: true });
  chmodSync(profilesDir(), 0o700);
  mkdirSync(credentialsBase(), { mode: 0o700, recursive: true });
  chmodSync(credentialsBase(), 0o700);
}

export function profileExists(name: string): boolean {
  return existsSync(join(profilesDir(), name, 'profile.yml'));
}

export function getProfileDir(name: string): string {
  return join(profilesDir(), name);
}

export function expandProfilePath(path: string, profileName: string): string {
  return path.replaceAll('{{profile_dir}}', getProfileDir(profileName));
}

/**
 * Absolute path of a profile's `image.dockerfile`. `{{profile_dir}}` is
 * expanded and relative paths are anchored at the profile directory — never
 * the project checkout, whose own Dockerfile would otherwise be built and run
 * with the profile's credentials.
 */
export function resolveProfileDockerfile(
  rawPath: string,
  profileName: string,
): string {
  const expanded = expandProfilePath(rawPath, profileName);
  return isAbsolute(expanded)
    ? expanded
    : join(getProfileDir(profileName), expanded);
}

export function getCredentialsDir(profileName: string): string {
  const dir = join(credentialsBase(), profileName);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  chmodSync(dir, 0o700);
  return dir;
}

const PROJECT_HASH_RE = /^[a-f0-9]{16}$/;

// Per-project state dirs record which project they belong to. The dir name is
// only a hash of the project path, so without this `ccpod prune` cannot tell a
// state dir whose project is gone from one whose container merely stopped.
export const PROJECT_MARKER_FILE = '.ccpod-project';

export function getStateDir(
  profileName: string,
  projectHash?: string,
  projectDir?: string,
): string {
  if (projectHash !== undefined && !PROJECT_HASH_RE.test(projectHash)) {
    throw new Error(
      `Invalid project hash: '${projectHash}'. Expected 16 hex characters.`,
    );
  }
  const dir =
    projectHash !== undefined
      ? join(baseDir(), 'state', profileName, projectHash)
      : join(baseDir(), 'state', profileName);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  chmodSync(dir, 0o700);
  if (projectHash !== undefined && projectDir !== undefined) {
    try {
      writeFileSync(join(dir, PROJECT_MARKER_FILE), projectDir, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (err) {
      // EEXIST: already recorded. Anything else is non-fatal — the marker is
      // only used to decide what `prune` may delete (no marker = keep).
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.warn(`Warning: could not record project path in ${dir}`);
      }
    }
  }
  return dir;
}

export function listProfiles(): string[] {
  const pd = profilesDir();
  if (!existsSync(pd)) {
    return [];
  }
  return readdirSync(pd).filter((entry) =>
    existsSync(join(pd, entry, 'profile.yml')),
  );
}

export function deleteProfile(name: string): void {
  const dir = join(profilesDir(), name);
  if (!existsSync(dir)) {
    throw new Error(`Profile not found: ${name}`);
  }
  rmSync(dir, { force: true, recursive: true });
  const credDir = join(credentialsBase(), name);
  if (existsSync(credDir)) {
    rmSync(credDir, { force: true, recursive: true });
  }
  const stateDir = join(baseDir(), 'state', name);
  if (existsSync(stateDir)) {
    rmSync(stateDir, { force: true, recursive: true });
  }
}

export function updateProfileImage(profileName: string, tag: string): void {
  const profilePath = join(profilesDir(), profileName, 'profile.yml');
  if (!existsSync(profilePath)) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const doc = parseDocument(readFileSync(profilePath, 'utf8'));
  doc.setIn(['image', 'use'], tag);
  writeFileSync(profilePath, doc.toString(), 'utf8');
}

export function updateProfileDockerfile(
  profileName: string,
  dockerfilePath: string,
): void {
  const profilePath = join(profilesDir(), profileName, 'profile.yml');
  if (!existsSync(profilePath)) {
    throw new Error(`Profile not found: ${profileName}`);
  }
  const doc = parseDocument(readFileSync(profilePath, 'utf8'));
  doc.setIn(['image', 'dockerfile'], dockerfilePath);
  writeFileSync(profilePath, doc.toString(), 'utf8');
}
