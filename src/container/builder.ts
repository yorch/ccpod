import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { getCredentialsDir, getStateDir } from '../profile/manager.ts';
import { detectRuntime } from '../runtime/detector.ts';
import type { ResolvedConfig } from '../types/index.ts';
import { VERSION } from '../version.ts';

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
  portBindings: Record<string, Array<{ HostPort: string }>>;
  tmpfs?: Record<string, string>;
  tty: boolean;
  workingDir: string;
}

export function computeProjectHash(projectDir: string): string {
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
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

  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const { host, container } of config.ports) {
    portBindings[`${container}/tcp`] = [{ HostPort: String(host) }];
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
      'ccpod.profile': config.profileName,
      'ccpod.project': hash,
      'ccpod.type': 'main',
      'ccpod.version': VERSION,
      'ccpod.workdir': projectDir,
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
