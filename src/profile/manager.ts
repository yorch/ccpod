import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CCPOD_DIR = join(homedir(), ".ccpod");
export const PROFILES_DIR = join(CCPOD_DIR, "profiles");
export const CREDENTIALS_DIR = join(CCPOD_DIR, "credentials");

export function ensureCcpodDirs(): void {
  mkdirSync(PROFILES_DIR, { recursive: true });
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
}

export function profileExists(name: string): boolean {
  return existsSync(join(PROFILES_DIR, name, "profile.yml"));
}

export function getProfileDir(name: string): string {
  return join(PROFILES_DIR, name);
}

export function getCredentialsDir(profileName: string): string {
  const dir = join(CREDENTIALS_DIR, profileName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listProfiles(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR).filter((entry) =>
    existsSync(join(PROFILES_DIR, entry, "profile.yml")),
  );
}

export function deleteProfile(name: string): void {
  const dir = join(PROFILES_DIR, name);
  if (!existsSync(dir)) throw new Error(`Profile not found: ${name}`);
  rmSync(dir, { recursive: true, force: true });
}
