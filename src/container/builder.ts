import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { getCredentialsDir, getStateDir } from '../profile/manager.ts';
import { detectRuntime } from '../runtime/detector.ts';
import type { ResolvedConfig } from '../types/index.ts';
import { VERSION } from '../version.ts';

export const LABEL_PROFILE = 'ccpod.profile';
export const LABEL_PROJECT = 'ccpod.project';
export const LABEL_TYPE = 'ccpod.type';
export const LABEL_VERSION = 'ccpod.version';
export const LABEL_WORKDIR = 'ccpod.workdir';

export interface ContainerSpec {
  binds: string[];
  capAdd?: string[];
  cmd?: string[];
  env: string[];
  image: string;
  labels: Record<string, string>;
  name: string;
  networkMode: string;
  openStdin: boolean;
  portBindings: Record<string, Array<{ HostPort: string; HostIp?: string }>>;
  tmpfs?: Record<string, string>;
  tty: boolean;
  workingDir: string;
}

export function computeProjectHash(projectDir: string): string {
  // Normalize before hashing so the same project always maps to the same
  // container name: resolve symlinks (realpath) and fold case on macOS, whose
  // default filesystem is case-insensitive. Without this, `/Users/me/Proj` and
  // `/users/me/proj`, or a path reached through a symlink, would hash
  // differently and spawn duplicate containers for one project.
  let normalized = projectDir;
  try {
    normalized = realpathSync(projectDir);
  } catch {
    // Path may not exist yet (or be inaccessible); fall back to the raw string.
  }
  if (process.platform === 'darwin') {
    normalized = normalized.toLowerCase();
  }
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function buildContainerSpec(
  config: ResolvedConfig,
  projectDir: string,
  tty: boolean,
  networkName?: string,
): ContainerSpec {
  const hash = computeProjectHash(projectDir);
  const credentialsDir = getCredentialsDir(config.profileName);

  const binds = [
    `${projectDir}:/workspace:rw`,
    `${config.mergedConfigDir}:/ccpod/config:ro`,
    `${credentialsDir}:/ccpod/credentials:rw`,
  ];

  if (config.ssh.mountSshDir) {
    binds.push(`${homedir()}/.ssh:/root/.ssh:ro`);
  }

  binds.push(`ccpod-plugins-${config.profileName}:/ccpod/plugins`);
  if (config.state === 'persistent') {
    binds.push(`${getStateDir(config.profileName)}:/ccpod/state:rw`);
  }

  const tmpfs: Record<string, string> = {};
  if (config.state === 'ephemeral') {
    tmpfs['/ccpod/state'] = 'rw,noexec,nosuid,size=256m';
  }

  const portBindings: Record<
    string,
    Array<{ HostPort: string; HostIp?: string }>
  > = {};
  for (const { host, container, hostIp } of config.ports) {
    portBindings[`${container}/tcp`] = [
      hostIp
        ? { HostIp: hostIp, HostPort: String(host) }
        : { HostPort: String(host) },
    ];
  }

  const env = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);
  env.push(`CCPOD_STATE=${config.state}`);

  if (config.plugins.length > 0) {
    env.push(`CCPOD_PLUGINS_TO_INSTALL=${config.plugins.join(',')}`);
  }

  const capAdd: string[] = [];
  if (config.network.policy === 'restricted') {
    capAdd.push('NET_ADMIN');
    env.push('CCPOD_NETWORK_POLICY=restricted');
    if (config.network.allow.length > 0) {
      env.push(`CCPOD_ALLOWED_HOSTS=${config.network.allow.join(',')}`);
    }
  }

  if (config.ssh.agentForward && process.env.SSH_AUTH_SOCK) {
    const sshSock = process.env.SSH_AUTH_SOCK;
    const runtime = detectRuntime();
    if (runtime.name === 'podman') {
      console.warn(
        'Warning: ssh.agentForward is not supported with Podman (host Unix sockets cannot be bind-mounted into the Podman VM). Skipping.',
      );
    } else if (!sshSock.includes(':')) {
      env.push('SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock');
      binds.push(`${sshSock}:/run/host-services/ssh-auth.sock:ro`);
    }
  }

  return {
    binds,
    env,
    image: config.image,
    labels: {
      [LABEL_PROFILE]: config.profileName,
      [LABEL_PROJECT]: hash,
      [LABEL_TYPE]: 'main',
      [LABEL_VERSION]: VERSION,
      [LABEL_WORKDIR]: projectDir,
    },
    ...(capAdd.length > 0 ? { capAdd } : {}),
    name: `ccpod-${config.profileName}-${hash}`,
    networkMode: networkName ?? 'bridge',
    openStdin: tty,
    portBindings,
    tty,
    workingDir: '/workspace',
    ...(Object.keys(tmpfs).length > 0 ? { tmpfs } : {}),
    ...(config.claudeArgs.length > 0
      ? { cmd: ['claude', ...config.claudeArgs] }
      : {}),
  };
}
