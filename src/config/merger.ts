import deepmerge from 'deepmerge';
import type {
  ProfileConfig,
  ProjectConfig,
  ResolvedConfig,
  ServiceConfig,
} from '../types/index.ts';

// True when `ip` is any form of the IPv6 unspecified address: `::`,
// `0:0:0:0:0:0:0:0`, or any variant where `::` expansion produces all-zero
// groups (e.g. `0::`, `::0:0`, `0:0::0`).
function isIpv6Wildcard(ip: string): boolean {
  if (!ip.includes(':')) {
    return false;
  }
  const halves = ip.split('::');
  if (halves.length > 2) {
    return false;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) {
    return false;
  }
  return [...head, ...tail].every((g) => /^0+$/.test(g));
}

function isIpv6Loopback(ip: string): boolean {
  if (ip === '::1') {
    return true;
  }
  // Long forms `0:0:0:0:0:0:0:1`, `0::1`, etc.
  if (!ip.includes(':')) {
    return false;
  }
  const halves = ip.split('::');
  if (halves.length > 2) {
    return false;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) {
    return false;
  }
  const groups = [...head, ...tail];
  if (groups.length === 0) {
    return false;
  }
  const last = groups[groups.length - 1];
  return (
    groups.slice(0, -1).every((g) => /^0+$/.test(g)) && /^0*1$/.test(last ?? '')
  );
}

function sanitizeProjectServices(
  services: Record<string, ServiceConfig>,
): Record<string, ServiceConfig> {
  const out: Record<string, ServiceConfig> = {};
  for (const [name, svc] of Object.entries(services)) {
    const volumes = (svc.volumes ?? []).map((v) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*:/.test(v)) {
        throw new Error(
          `Project service '${name}' volume '${v}' is not a named volume. ` +
            'Host-path mounts from project config require profile-level ' +
            'allowProjectHostMounts: true.',
        );
      }
      return v;
    });
    const ports = (svc.ports ?? []).map((p) => sanitizePort(name, p));
    out[name] = { ...svc, ports, volumes };
  }
  return out;
}

function sanitizePort(serviceName: string, spec: string): string {
  // Bracketed IPv6 host: [ip]:host:container. Match this first because its
  // colons would otherwise fool a naive split-by-colon.
  const bracketed = spec.match(/^\[([^\]]+)\]:(.+)$/);
  if (bracketed) {
    const ip = bracketed[1] ?? '';
    if (isIpv6Loopback(ip)) {
      return spec;
    }
    if (isIpv6Wildcard(ip)) {
      throw new Error(
        `Project service '${serviceName}' port '${spec}' binds to all IPv6 interfaces; ` +
          'only ::1 / 127.0.0.1 is allowed without profile-level allowProjectHostMounts: true.',
      );
    }
    throw new Error(
      `Project service '${serviceName}' port '${spec}' binds to ${ip}; ` +
        'only ::1 / 127.0.0.1 is allowed without profile-level allowProjectHostMounts: true.',
    );
  }
  const parts = spec.split(':');
  if (parts.length === 1) {
    throw new Error(
      `Project service '${serviceName}' port '${spec}' would publish on all interfaces; ` +
        'use "127.0.0.1:<host>:<container>" or set profile-level allowProjectHostMounts: true.',
    );
  }
  if (parts.length >= 3) {
    const ip = parts[0];
    if (ip !== '127.0.0.1' && ip !== 'localhost') {
      throw new Error(
        `Project service '${serviceName}' port '${spec}' binds to ${ip || '0.0.0.0'}; ` +
          'only 127.0.0.1 / ::1 is allowed without profile-level allowProjectHostMounts: true.',
      );
    }
    return spec;
  }
  return `127.0.0.1:${spec}`;
}

export function mergeConfigs(
  profile: ProfileConfig,
  project: ProjectConfig | null,
  overrides: { state?: 'ephemeral' | 'persistent' } = {},
): Omit<ResolvedConfig, 'mergedConfigDir'> {
  if (profile.isolation) {
    return {
      auth: profile.auth,
      autoDetectMcp: profile.ports.autoDetectMcp,
      claudeArgs: profile.claudeArgs,
      dockerfile: profile.image.dockerfile,
      env: {},
      image: profile.image.dockerfile ? 'build' : profile.image.use,
      init: profile.init,
      network: profile.network,
      plugins: profile.plugins,
      ports: parsePorts(profile.ports.list ?? []),
      profileName: profile.name,
      services: profile.services,
      ssh: profile.ssh,
      state: overrides.state ?? profile.state,
    };
  }

  const strategy = project?.merge ?? 'deep';

  // override: project replaces the section using schema defaults for omitted keys,
  // NOT profile values — spreading from profile would leak profile's allow list.
  const NETWORK_DEFAULTS: ProfileConfig['network'] = {
    allow: [],
    policy: 'full',
  };
  const network =
    strategy === 'override' && project?.network
      ? { ...NETWORK_DEFAULTS, ...project.network }
      : deepmerge(profile.network, project?.network ?? {});

  const ports = {
    autoDetectMcp: project?.ports?.autoDetectMcp ?? profile.ports.autoDetectMcp,
    list: [...(profile.ports.list ?? []), ...(project?.ports?.list ?? [])],
  };

  const projectServices = profile.allowProjectHostMounts
    ? (project?.services ?? {})
    : sanitizeProjectServices(project?.services ?? {});
  const services =
    strategy === 'override' && project?.services
      ? projectServices
      : { ...profile.services, ...projectServices };

  const claudeArgs =
    strategy === 'override'
      ? (project?.claudeArgs ?? [])
      : [...profile.claudeArgs, ...(project?.claudeArgs ?? [])];

  const projectInit = profile.allowProjectInit ? (project?.init ?? []) : [];
  if (!profile.allowProjectInit && project?.init && project.init.length > 0) {
    console.warn(
      'Warning: project .ccpod.yml declares init commands, but the active ' +
        'profile does not set allowProjectInit: true — ignoring them.',
    );
  }
  const init =
    strategy === 'override' ? projectInit : [...profile.init, ...projectInit];

  return {
    auth: profile.auth,
    autoDetectMcp: ports.autoDetectMcp,
    claudeArgs,
    dockerfile: profile.image.dockerfile,
    env: {},
    image: profile.image.dockerfile ? 'build' : profile.image.use,
    init,
    network,
    plugins: profile.plugins,
    ports: parsePorts(ports.list),
    profileName: profile.name,
    services,
    ssh: profile.ssh,
    state: overrides.state ?? profile.state,
  };
}

function parsePorts(
  list: string[],
): Array<{ host: number; container: number }> {
  return list.map((entry) => {
    const [hostStr = entry, containerStr = entry] = entry.split(':');
    const host = Number(hostStr);
    const container = Number(containerStr);
    if (
      !Number.isInteger(host) ||
      host <= 0 ||
      !Number.isInteger(container) ||
      container <= 0
    ) {
      throw new Error(
        `Invalid port mapping "${entry}": expected "host:container" with positive integers`,
      );
    }
    return { container, host };
  });
}

export function mergeClaudes(
  profileContent: string,
  projectContent: string,
  mode: 'append' | 'override',
): string {
  if (mode === 'override') {
    return projectContent;
  }
  return `${profileContent}\n\n---\n\n${projectContent}`;
}
