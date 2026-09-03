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
  // When true, the entrypoint skips copying .credentials.json (proxy mode
  // uses a sentinel API key + ANTHROPIC_BASE_URL, no credential file).
  proxyAuth?: boolean;
  // Secret env vars (resolved credential + user-forwarded values). Passed to
  // the container as bare `-e KEY` flags and supplied to docker via its own
  // environment, so the values never land in the run command line.
  secretEnv: Record<string, string>;
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
  const isProxyAuth = config.auth.type === 'proxy';

  const binds = [
    `${projectDir}:/workspace:rw`,
    `${config.mergedConfigDir}:/ccpod/config:ro`,
  ];

  // Proxy mode doesn't use a credential file — the sentinel API key and
  // ANTHROPIC_BASE_URL are injected as env vars. Skip the credentials mount
  // so no OAuth tokens enter the container.
  if (!isProxyAuth) {
    binds.push(`${credentialsDir}:/ccpod/credentials:rw`);
  }

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

  // Resolved credential + forwarded env are secrets — carried in secretEnv and
  // injected via docker's own environment (see ContainerSpec.secretEnv), never
  // as `-e KEY=VALUE` argv. ccpod's own control vars below are not secret and
  // stay as plain flags.
  // Defense-in-depth: strip CCPOD_* and DOCKER_* from secretEnv even though
  // the resolver already blocks them from project env. A CCPOD_* in secretEnv
  // could override the control vars we construct below (docker's last `-e`
  // wins), and a DOCKER_* (e.g. DOCKER_HOST) would redirect the docker CLI
  // itself when dockerSpawn merges extraEnv into its environment.
  const secretEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.env)) {
    const upper = k.toUpperCase();
    if (!upper.startsWith('CCPOD_') && !upper.startsWith('DOCKER_')) {
      secretEnv[k] = v;
    }
  }
  const env: string[] = [];
  env.push(`CCPOD_STATE=${config.state}`);

  if (isProxyAuth) {
    env.push('CCPOD_PROXY_AUTH=1');
  }

  if (config.plugins.length > 0) {
    env.push(`CCPOD_PLUGINS_TO_INSTALL=${config.plugins.join(',')}`);
  }

  const capAdd: string[] = [];
  if (config.network.policy === 'restricted') {
    capAdd.push('NET_ADMIN');
    env.push('CCPOD_NETWORK_POLICY=restricted');
    // Proxy mode requires the container to reach the host-side auth proxy
    // via host.docker.internal. Auto-add it to the allow-list so restricted
    // + proxy mode works without manual configuration.
    const allowList = [...config.network.allow];
    if (isProxyAuth && !allowList.includes('host.docker.internal')) {
      allowList.push('host.docker.internal');
    }
    if (allowList.length > 0) {
      env.push(`CCPOD_ALLOWED_HOSTS=${allowList.join(',')}`);
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
    ...(isProxyAuth ? { proxyAuth: true } : {}),
    secretEnv,
    tty,
    workingDir: '/workspace',
    ...(Object.keys(tmpfs).length > 0 ? { tmpfs } : {}),
    ...(config.claudeArgs.length > 0
      ? { cmd: ['claude', ...config.claudeArgs] }
      : {}),
  };
}
