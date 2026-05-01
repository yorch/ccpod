import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

// For external consumers (e.g. wizard.ts) — computed once at import time
export const CCPOD_DIR = join(homedir(), '.ccpod');
export const PROFILES_DIR = join(CCPOD_DIR, 'profiles');
export const CREDENTIALS_DIR = join(CCPOD_DIR, 'credentials');

// Internal: re-evaluated at each call so CCPOD_TEST_DIR env override works in tests
function baseDir(): string {
  return process.env.CCPOD_TEST_DIR ?? join(homedir(), '.ccpod');
}

function profilesDir(): string {
  return join(baseDir(), 'profiles');
}

function credentialsBase(): string {
  return join(baseDir(), 'credentials');
}

export function ensureCcpodDirs(): void {
  mkdirSync(profilesDir(), { recursive: true });
  mkdirSync(credentialsBase(), { mode: 0o700, recursive: true });
}

export function profileExists(name: string): boolean {
  return existsSync(join(profilesDir(), name, 'profile.yml'));
}

export function getProfileDir(name: string): string {
  return join(profilesDir(), name);
}

export function getCredentialsDir(profileName: string): string {
  const dir = join(credentialsBase(), profileName);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  return dir;
}

export function getStateDir(profileName: string): string {
  const dir = join(baseDir(), 'state', profileName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listProfiles(): string[] {
  const pd = profilesDir();
  if (!existsSync(pd)) return [];
  return readdirSync(pd).filter((entry) =>
    existsSync(join(pd, entry, 'profile.yml')),
  );
}

export function deleteProfile(name: string): void {
  const dir = join(profilesDir(), name);
  if (!existsSync(dir)) throw new Error(`Profile not found: ${name}`);
  rmSync(dir, { force: true, recursive: true });
}

export function updateProfileImage(profileName: string, tag: string): void {
  const profilePath = join(profilesDir(), profileName, 'profile.yml');
  if (!existsSync(profilePath))
    throw new Error(`Profile not found: ${profileName}`);
  const doc = parseDocument(readFileSync(profilePath, 'utf8'));
  doc.setIn(['image', 'use'], tag);
  writeFileSync(profilePath, doc.toString(), 'utf8');
}
