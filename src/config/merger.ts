import deepmerge from 'deepmerge';
import type {
  ProfileConfig,
  ProjectConfig,
  ResolvedConfig,
  ServiceConfig,
} from '../types/index.ts';

const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
const ZERO_GROUP_RE = /^0+$/;
const ALLOWED_IPV4_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ALLOWED_HOSTS_MSG = '127.0.0.1 / localhost / ::1';

// Parse an IPv6 string into its 8 hexadecimal groups, expanding any `::`
// shorthand. Returns null if the input is not a syntactically valid IPv6
// address (too many groups, multiple `::`, non-hex characters, etc.).
function parseIpv6Groups(ip: string): string[] | null {
  if (!ip.includes(':')) {
    return null;
  }
  const halves = ip.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1) {
    if (head.length !== 8) {
      return null;
    }
  } else if (head.length + tail.length > 7) {
    // `::` must collapse at least one zero group, so the explicit parts can
    // total at most 7.
    return null;
  }
  if (![...head, ...tail].every((g) => HEX_GROUP_RE.test(g))) {
    return null;
  }
  const fillCount = 8 - head.length - tail.length;
  const middle = halves.length === 2 ? new Array(fillCount).fill('0') : [];
  return [...head, ...middle, ...tail];
}

type Ipv6Kind = 'wildcard' | 'loopback' | 'other' | 'invalid';

function classifyIpv6(ip: string): Ipv6Kind {
  const groups = parseIpv6Groups(ip);
  if (groups === null) {
    return 'invalid';
  }
  if (groups.every((g) => ZERO_GROUP_RE.test(g))) {
    return 'wildcard';
  }
  if (
    groups.slice(0, -1).every((g) => ZERO_GROUP_RE.test(g)) &&
    /^0*1$/.test(groups[7] ?? '')
  ) {
    return 'loopback';
  }
  return 'other';
}

// Deep-merge per service: if a key exists in both layers, merge their fields
// (env keys union with project winning on conflict, ports/volumes concatenated)
// rather than letting project replace the whole service config wholesale.
function mergeServices(
  profileServices: Record<string, ServiceConfig>,
  projectServices: Record<string, ServiceConfig>,
): Record<string, ServiceConfig> {
  const out: Record<string, ServiceConfig> = { ...profileServices };
  for (const [name, svc] of Object.entries(projectServices)) {
    const existing = out[name];
    out[name] = existing ? (deepmerge(existing, svc) as ServiceConfig) : svc;
  }
  return out;
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

function portError(serviceName: string, spec: string, detail: string): Error {
  return new Error(
    `Project service '${serviceName}' port '${spec}' ${detail}; ` +
      `only ${ALLOWED_HOSTS_MSG} is allowed without profile-level allowProjectHostMounts: true.`,
  );
}

function sanitizePort(serviceName: string, spec: string): string {
  // Bracketed IPv6 host: [ip]:host:container. Match this first because its
  // colons would otherwise fool a naive split-by-colon.
  const bracketed = spec.match(/^\[([^\]]+)\]:(.+)$/);
  if (bracketed) {
    const ip = bracketed[1] ?? '';
    switch (classifyIpv6(ip)) {
      case 'loopback':
        return spec;
      case 'wildcard':
        throw portError(serviceName, spec, 'binds to all IPv6 interfaces');
      default:
        throw portError(serviceName, spec, `binds to ${ip}`);
    }
  }
  const parts = spec.split(':');
  if (parts.length === 1) {
    throw portError(serviceName, spec, 'would publish on all interfaces');
  }
  if (parts.length >= 3) {
    const ip = parts[0] ?? '';
    if (!ALLOWED_IPV4_HOSTS.has(ip)) {
      throw portError(serviceName, spec, `binds to ${ip || '0.0.0.0'}`);
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
  const networkRaw =
    strategy === 'override' && project?.network
      ? { ...NETWORK_DEFAULTS, ...project.network }
      : deepmerge(profile.network, project?.network ?? {});
  // deepmerge concatenates arrays — dedupe the allow list so the same host
  // declared in both layers doesn't yield duplicate iptables rules.
  const network: ProfileConfig['network'] = {
    ...networkRaw,
    allow: [...new Set(networkRaw.allow ?? [])],
  };

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
      : mergeServices(profile.services, projectServices);

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
