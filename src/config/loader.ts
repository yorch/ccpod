import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProfileConfig, ProjectConfig } from '../types/index.ts';
import { profileConfigSchema, projectConfigSchema } from './schema.ts';

export function loadProfileConfig(profileDir: string): ProfileConfig {
  const profilePath = join(profileDir, 'profile.yml');
  if (!existsSync(profilePath)) {
    throw new Error(`Profile not found: ${profilePath}`);
  }
  const raw = parseYaml(readFileSync(profilePath, 'utf8'));
  return profileConfigSchema.parse(raw) as ProfileConfig;
}

// Stop walking up at the user's home directory. A .ccpod.yml found above $HOME
// (e.g. at / on macOS) is almost certainly not intended as a project config,
// and walking to the filesystem root lets a stray file in a parent directory
// override profile settings for every child project. Both $HOME and the start
// dir are canonicalised via realpathSync so symlinked paths don't bypass the
// boundary check. Symlink/non-regular candidates are rejected here so all
// callers (loadProjectConfig, config validate) are protected — not just the
// loader.
export function findProjectConfig(startDir: string): string | null {
  let home: string;
  try {
    home = realpathSync(homedir());
  } catch {
    home = homedir();
  }
  let dir: string;
  try {
    dir = realpathSync(startDir);
  } catch {
    dir = startDir;
  }
  while (true) {
    const candidate = join(dir, '.ccpod.yml');
    if (existsSync(candidate)) {
      try {
        const stat = lstatSync(candidate);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          console.warn(
            'Warning: .ccpod.yml is a symlink or non-regular file; ignoring.',
          );
          return null;
        }
      } catch {
        return null;
      }
      return candidate;
    }
    if (dir === home) {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function loadProjectConfig(projectDir: string): ProjectConfig | null {
  const configPath = findProjectConfig(projectDir);
  if (!configPath) {
    return null;
  }
  const raw = parseYaml(readFileSync(configPath, 'utf8'));
  return projectConfigSchema.parse(raw) as ProjectConfig;
}
