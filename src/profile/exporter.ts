import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProfileDir } from './manager.ts';

export function exportProfile(name: string): string {
  const profilePath = join(getProfileDir(name), 'profile.yml');
  if (!existsSync(profilePath)) {
    throw new Error(`Profile not found: ${name}`);
  }
  return readFileSync(profilePath).toString('base64');
}
