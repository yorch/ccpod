import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProfileConfig } from '../types/index.ts';
import { type ProfileOverlay, profileOverlaySchema } from './schema.ts';

export const OVERLAY_FILENAME = 'ccpod-overlay.yml';

export function loadOverlay(configSourceDir: string): ProfileOverlay | null {
  const path = join(configSourceDir, OVERLAY_FILENAME);
  if (!existsSync(path)) {
    return null;
  }
  const raw = parseYaml(readFileSync(path, 'utf8'));
  if (raw == null) {
    return null;
  }
  return profileOverlaySchema.parse(raw);
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function applyOverlay(
  profile: ProfileConfig,
  overlay: ProfileOverlay,
): ProfileConfig {
  return {
    ...profile,
    claudeArgs: [...profile.claudeArgs, ...(overlay.claudeArgs ?? [])],
    env: [...profile.env, ...(overlay.env ?? [])],
    image: overlay.image
      ? {
          dockerfile: overlay.image.dockerfile ?? profile.image.dockerfile,
          use: overlay.image.use ?? profile.image.use,
        }
      : profile.image,
    init: [...profile.init, ...(overlay.init ?? [])],
    network: overlay.network
      ? {
          allow: dedupe([
            ...profile.network.allow,
            ...(overlay.network.allow ?? []),
          ]),
          policy: overlay.network.policy ?? profile.network.policy,
        }
      : profile.network,
    permissions: overlay.permissions ?? profile.permissions,
    plugins: dedupe([...profile.plugins, ...(overlay.plugins ?? [])]),
    ports: {
      autoDetectMcp:
        overlay.ports?.autoDetectMcp ?? profile.ports.autoDetectMcp,
      list: [...(profile.ports.list ?? []), ...(overlay.ports?.list ?? [])],
    },
    services: { ...profile.services, ...(overlay.services ?? {}) },
    ssh: overlay.ssh
      ? {
          agentForward: overlay.ssh.agentForward ?? profile.ssh.agentForward,
          mountSshDir: overlay.ssh.mountSshDir ?? profile.ssh.mountSshDir,
        }
      : profile.ssh,
  };
}

export function countOverlayFields(overlay: ProfileOverlay): number {
  return Object.values(overlay).filter((v) => v !== undefined).length;
}
