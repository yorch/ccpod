import { existsSync } from 'node:fs';
import type { DetectedRuntime } from '../types/index.ts';

export function detectRuntime(): DetectedRuntime {
  const home = process.env.HOME ?? '';
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR ?? '';
  const dockerSock = process.env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock';

  // An explicit DOCKER_HOST is the user's choice (remote daemon, docker
  // context, rootless): honor it instead of guessing. A unix:// path that no
  // longer exists is a stale setting, so fall through to auto-detection.
  const envHost = process.env.DOCKER_HOST;
  if (envHost) {
    if (!envHost.startsWith('unix://')) {
      return { dockerHost: envHost, name: 'docker', socketPath: envHost };
    }
    const path = envHost.slice('unix://'.length);
    if (existsSync(path)) {
      return { dockerHost: envHost, name: 'docker', socketPath: path };
    }
  }

  const candidates = [
    {
      name: 'orbstack',
      sockets: [`${home}/.orbstack/run/docker.sock`],
    },
    {
      name: 'docker',
      sockets: [
        dockerSock,
        `${home}/.docker/run/docker.sock`,
        // Rootless Docker
        ...(xdgRuntimeDir ? [`${xdgRuntimeDir}/docker.sock`] : []),
      ],
    },
    {
      name: 'colima',
      sockets: [
        `${home}/.colima/default/docker.sock`,
        `${home}/.colima/docker.sock`,
      ],
    },
    {
      name: 'podman',
      sockets: [
        `${xdgRuntimeDir}/podman/podman.sock`,
        `${home}/.local/share/containers/podman/machine/podman.sock`,
      ],
    },
  ];

  for (const candidate of candidates) {
    for (const socket of candidate.sockets) {
      if (socket && existsSync(socket)) {
        return { name: candidate.name, socketPath: socket };
      }
    }
  }
  throw new Error(
    'No container runtime detected. Install Docker, OrbStack, Colima, or Podman.',
  );
}
