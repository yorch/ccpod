import { existsSync, readFileSync } from 'node:fs';
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

export function findProjectConfig(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, '.ccpod.yml');
    if (existsSync(candidate)) {
      return candidate;
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
