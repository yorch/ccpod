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

export interface ProxyInjection {
  baseUrl: string;
  sentinelKey: string;
}

export type ContainerMode = 'claude' | 'shell';

export interface BuildSpecOptions {
  // Shell mode only: command to run instead of an interactive /bin/bash.
  cmd?: string[];
  mode?: ContainerMode;
  proxy?: ProxyInjection;
}

export interface ContainerSpec {
  binds: string[];
  capAdd?: string[];
  cmd?: string[];
  env: string[];
  // Shell mode only: name of the main (claude) container to `docker exec`
  // into when it is already running, instead of starting a separate one.
  execTarget?: string;
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
  opts: BuildSpecOptions = {},
): ContainerSpec {
  const mode = opts.mode ?? 'claude';
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
    binds.push(`${homedir()}/.ssh:/home/node/.ssh:ro`);
  }

  binds.push(`ccpod-plugins-${config.profileName}:/ccpod/plugins`);
  if (config.state === 'persistent') {
    const projectHash =
      config.stateIsolation === 'per-project' ? hash : undefined;
    binds.push(
      `${getStateDir(config.profileName, projectHash, projectHash ? projectDir : undefined)}:/ccpod/state:rw`,
    );
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
    // Several mappings can target one container port (profile + project +
    // .mcp.json); Docker accepts a list of bindings per port.
    const bindings = portBindings[`${container}/tcp`] ?? [];
    bindings.push(
      hostIp
        ? { HostIp: hostIp, HostPort: String(host) }
        : { HostPort: String(host) },
    );
    portBindings[`${container}/tcp`] = bindings;
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
  // Proxy injection happens here (after the CCPOD_*/DOCKER_* strip above) so
  // callers never have to mutate a built spec. The container runs claude in
  // API-key mode with the sentinel key; the proxy swaps in the real token.
  if (opts.proxy) {
    secretEnv.ANTHROPIC_BASE_URL = opts.proxy.baseUrl;
    secretEnv.ANTHROPIC_API_KEY = opts.proxy.sentinelKey;
  }
  const env: string[] = [];
  env.push(`CCPOD_STATE=${config.state}`);
  if (mode === 'shell') {
    env.push('CCPOD_SHELL_MODE=1');
  }
  // Native Linux bind mounts keep host ownership. Have the entrypoint run the
  // `node` user as the host uid/gid so the project, state and config files stay
  // yours (no chown of host dirs to a foreign uid). Docker Desktop / OrbStack on
  // macOS translate ownership themselves, so nothing is needed there.
  if (
    process.platform === 'linux' &&
    typeof process.getuid === 'function' &&
    typeof process.getgid === 'function' &&
    process.getuid() !== 0
  ) {
    env.push(`CCPOD_HOST_UID=${process.getuid()}`);
    env.push(`CCPOD_HOST_GID=${process.getgid()}`);
  }

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
    // Proxy mode also needs the host-side auth proxy, but only on its one
    // port — the entrypoint derives that from ANTHROPIC_BASE_URL (see
    // CCPOD_PROXY_AUTH) instead of whitelisting the whole host gateway here.
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
      [LABEL_TYPE]: mode === 'shell' ? 'shell' : 'main',
      [LABEL_VERSION]: VERSION,
      [LABEL_WORKDIR]: projectDir,
    },
    ...(capAdd.length > 0 ? { capAdd } : {}),
    name: `ccpod-${config.profileName}-${hash}${mode === 'shell' ? '-shell' : ''}`,
    networkMode: networkName ?? 'bridge',
    openStdin: tty,
    // A shell container must not publish the main container's ports, or it
    // would block a later `ccpod run` with "port is already allocated".
    portBindings: mode === 'shell' ? {} : portBindings,
    ...(isProxyAuth ? { proxyAuth: true } : {}),
    secretEnv,
    tty,
    workingDir: '/workspace',
    ...(Object.keys(tmpfs).length > 0 ? { tmpfs } : {}),
    ...(mode === 'shell'
      ? {
          cmd: opts.cmd ?? ['/bin/bash'],
          execTarget: `ccpod-${config.profileName}-${hash}`,
        }
      : config.claudeArgs.length > 0
        ? { cmd: ['claude', ...config.claudeArgs] }
        : {}),
  };
}
